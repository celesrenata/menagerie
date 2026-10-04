import { EventEmitter } from "events"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import { DCG_MAX_OUTPUT_BYTES } from "../constants"
import { normalizeNixFlakeRefsForDcg, runDcg } from "../runner"

vi.mock("child_process", () => ({ spawn: vi.fn() }))

type MockChild = EventEmitter & {
	stdout: PassThrough
	stderr: PassThrough
	kill: ReturnType<typeof vi.fn>
}

const mockSpawn = vi.mocked(spawn)

const useChild = (child: MockChild): void => {
	// runDcg uses only the event, stream, and kill subset supplied by this test double.
	mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
}

function createChild(): MockChild {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
}

function emitResult(child: MockChild, payload: unknown, code: number): void {
	child.stdout.write(JSON.stringify(payload))
	child.emit("close", code, null)
}

describe("runDcg", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.useRealTimers()
		mockSpawn.mockReset()
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.useRealTimers()
		warnSpy.mockRestore()
	})

	it.each([
		["nix build .#packages.x86_64-linux.hyte-touch-interface", "nix build '.#packages.x86_64-linux.hyte-touch-interface'"],
		["nix eval --raw .#packages.aarch64-darwin.default", "nix eval --raw '.#packages.aarch64-darwin.default'"],
		["nix flake show .#devShells.default", "nix flake show '.#devShells.default'"],
		["nix build .#foo && rm -rf /", undefined],
		["rm -rf .#foo", undefined],
		["nix build .#foo; rm -rf /", undefined],
		["nix build .#foo$(whoami)", undefined],
		["nix build .#foo`whoami`", undefined],
		["nix build .#foo # comment", undefined],
		["nix build .#foo/bar", undefined],
		["nix build '.#foo'", undefined],
	])("normalizes only a plain Nix flake command %#", (command, expected) => {
		expect(normalizeNixFlakeRefsForDcg(command)).toBe(expected)
	})

	it("rechecks a Nix flake reference only after DCG's specific parser false positive", async () => {
		const first = createChild()
		const second = createChild()
		mockSpawn.mockReturnValueOnce(first as unknown as ReturnType<typeof spawn>)
		mockSpawn.mockReturnValueOnce(second as unknown as ReturnType<typeof spawn>)
		const command = "nix build .#packages.x86_64-linux.hyte-touch-interface"
		const result = runDcg("/dcg", command, "/workspace")
		emitResult(
			first,
			{
				schema_version: 2,
				decision: "deny",
				reason: "PowerShell substitution contains comment syntax that dcg cannot statically disambiguate",
			},
			1,
		)
		await Promise.resolve()
		expect(mockSpawn).toHaveBeenCalledTimes(2)
		expect(mockSpawn.mock.calls[0][1].at(-1)).toBe(command)
		expect(mockSpawn.mock.calls[1][1].at(-1)).toBe("nix build '.#packages.x86_64-linux.hyte-touch-interface'")
		emitResult(second, { schema_version: 2, decision: "allow" }, 0)
		await expect(result).resolves.toEqual({ decision: "allow" })
		expect(warnSpy).not.toHaveBeenCalledWith("[DCG] Command denied", expect.anything())
	})

	it("keeps a second DCG denial authoritative", async () => {
		const first = createChild()
		const second = createChild()
		mockSpawn.mockReturnValueOnce(first as unknown as ReturnType<typeof spawn>)
		mockSpawn.mockReturnValueOnce(second as unknown as ReturnType<typeof spawn>)
		const result = runDcg("/dcg", "nix build .#foo", "/workspace")
		emitResult(first, { schema_version: 2, decision: "deny", reason: "PowerShell substitution contains comment syntax" }, 1)
		await Promise.resolve()
		emitResult(second, { schema_version: 2, decision: "deny", reason: "dangerous", rule_id: "danger" }, 1)
		await expect(result).resolves.toEqual({ decision: "deny", reason: "dangerous", ruleId: "danger" })
		expect(warnSpy).toHaveBeenCalledWith("[DCG] Command denied", "dangerous")
	})

	it("does not retry an ordinary DCG denial or a shell command chain", async () => {
		const child = createChild()
		useChild(child)
		const result = runDcg("/dcg", "nix build .#foo && rm -rf /", "/workspace")
		emitResult(child, { schema_version: 2, decision: "deny", reason: "PowerShell substitution contains comment syntax" }, 1)
		await expect(result).resolves.toEqual({ decision: "deny", reason: "PowerShell substitution contains comment syntax", ruleId: undefined })
		expect(mockSpawn).toHaveBeenCalledTimes(1)
	})

	it.each([
		[{ schema_version: 1, decision: "allow" }, 0, { decision: "allow" }],
		[{ schema_version: 2, decision: "warn", rule_id: "generated-file" }, 0, { decision: "allow" }],
		[{ schema_version: 2, decision: "log", rule_id: "generated-file" }, 0, { decision: "allow" }],
		[
			{ schema_version: 2, decision: "deny", reason: "unsafe", rule_id: "delete" },
			1,
			{ decision: "deny", reason: "unsafe", ruleId: "delete" },
		],
		[
			{ schema_version: 2, decision: "deny", pack_id: "core", pattern_name: "delete" },
			1,
			{ decision: "deny", ruleId: "core:delete" },
		],
	])("accepts valid DCG result %#", async (payload, code, expected) => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		emitResult(child, payload, code)

		await expect(result).resolves.toEqual(expected)
		expect(mockSpawn).toHaveBeenCalledWith(
			"/dcg",
			expect.any(Array),
			expect.objectContaining({ cwd: "/workspace" }),
		)
		if (expected.decision === "deny") {
			const reason = "reason" in expected ? expected.reason : undefined
			expect(warnSpy).toHaveBeenCalledWith("[DCG] Command denied", reason ?? "No reason provided")
		}
	})

	it("passes only the environment variables DCG requires", async () => {
		const child = createChild()
		useChild(child)
		const originalToken = process.env.GITHUB_TOKEN
		const originalTmpdir = process.env.TMPDIR
		process.env.GITHUB_TOKEN = "secret"
		process.env.TMPDIR = "/sandbox/tmp"

		try {
			const result = runDcg("/dcg", "echo test", "/workspace")
			emitResult(child, { schema_version: 1, decision: "allow" }, 0)
			await result

			const options = mockSpawn.mock.calls[0][2]
			expect(options?.env).toMatchObject({ NO_COLOR: "1", TMPDIR: "/sandbox/tmp" })
			expect(options?.env).not.toHaveProperty("GITHUB_TOKEN")
		} finally {
			if (originalToken === undefined) delete process.env.GITHUB_TOKEN
			else process.env.GITHUB_TOKEN = originalToken
			if (originalTmpdir === undefined) delete process.env.TMPDIR
			else process.env.TMPDIR = originalTmpdir
		}
	})

	it.each([
		["not json", 0, "DCG returned invalid JSON"],
		[JSON.stringify({ schema_version: 3, decision: "allow" }), 0, "DCG returned an unsupported response schema"],
		[JSON.stringify({ schema_version: 1, decision: "deny" }), 0, "DCG decision did not match its exit status"],
		[JSON.stringify({ schema_version: 2, decision: "warn" }), 1, "DCG decision did not match its exit status"],
	])("rejects invalid output %#", async (output, code, message) => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stdout.write(output)
		child.emit("close", code, null)

		await expect(result).rejects.toThrow(message)
		expect(warnSpy).toHaveBeenCalledWith("[DCG]", message)
	})

	it("rejects non-DCG exit statuses with stderr", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stderr.write("failure details")
		child.emit("close", 2, null)

		await expect(result).rejects.toThrow("DCG evaluation failed: failure details")
		expect(warnSpy).toHaveBeenCalledWith("[DCG]", "DCG evaluation failed: failure details")
	})

	it("rejects process startup errors", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.emit("error", new Error("ENOENT"))

		await expect(result).rejects.toThrow("Unable to start DCG: ENOENT")
		expect(warnSpy).toHaveBeenCalledWith("[DCG]", "Unable to start DCG: ENOENT")
	})

	it("rejects excessive output and kills the process", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stdout.write(Buffer.alloc(DCG_MAX_OUTPUT_BYTES + 1))

		await expect(result).rejects.toThrow("DCG produced too much output")
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
	})

	it("times out and kills the process", async () => {
		vi.useFakeTimers()
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		const rejection = expect(result).rejects.toThrow("DCG evaluation timed out")
		await vi.runAllTimersAsync()

		await rejection
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
	})
})
