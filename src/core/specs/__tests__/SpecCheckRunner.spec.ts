import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defaultExec, runSpecCheck, scrubbedEnv, SpecCheckError, type ExecFn } from "../SpecCheckRunner"
import { SpecRevisionStore } from "../SpecRevisionStore"
import { verifySpecRevision } from "../SpecVerifier"
import { baseRevision } from "./specFixtures"

const rev = baseRevision()
const approval = { revisionId: rev.revisionId, approvedBy: "user" as const, approvedAt: 1 }
const exit = (exitCode: number, output = "out"): ExecFn => vi.fn(async () => ({ exitCode, output }))
const base = { revision: rev, acceptanceId: "A1", workspaceRoot: "/tmp", approval, sourceRevision: "git:aaa", now: () => 5 }

describe("runSpecCheck", () => {
	it("refuses to run anything for an unapproved or differently approved revision", async () => {
		const exec = exit(0)
		await expect(runSpecCheck({ ...base, approval: undefined, exec })).rejects.toThrow(SpecCheckError)
		await expect(runSpecCheck({ ...base, approval: { ...approval, revisionId: `sha256:${"0".repeat(64)}` }, exec })).rejects.toThrow(/not approved/)
		expect(exec).not.toHaveBeenCalled()
	})

	it("passes only on exit code 0 and fails otherwise, whatever the output says", async () => {
		const ok = await runSpecCheck({ ...base, exec: exit(0, "ALL TESTS PASSED") })
		expect(ok).toMatchObject({ status: "pass", exitCode: 0, source: "runner" })
		const bad = await runSpecCheck({ ...base, exec: exit(1, "ALL TESTS PASSED") })
		expect(bad).toMatchObject({ status: "fail", exitCode: 1 })
	})

	it("never uses a shell and refuses shell binaries", async () => {
		const shellRev = baseRevision({ checks: [{ id: "C1", kind: "test", command: ["bash", "-c", "true"] }, { id: "C2", kind: "test", command: ["true"] }, { id: "C3", kind: "test", command: ["true"] }] })
		await expect(
			runSpecCheck({ ...base, revision: shellRev, approval: { ...approval, revisionId: shellRev.revisionId }, exec: exit(0) }),
		).rejects.toThrow(/shell/)
	})

	it("passes argv through unchanged and runs in the workspace with a scrubbed environment", async () => {
		const exec = exit(0)
		await runSpecCheck({ ...base, exec, env: { PATH: "/bin", OMNIROUTE_API_KEY: "s", GITHUB_TOKEN: "t", HOME: "/h" } })
		const [argv, options] = vi.mocked(exec).mock.calls[0]
		expect(argv).toEqual(["pnpm", "test", "session"])
		expect(options.cwd).toBe("/tmp")
		expect(options.env).toEqual({ PATH: "/bin", HOME: "/h" })
	})

	it("scrubs secret-looking variables", () => {
		expect(scrubbedEnv({ A: "1", MY_SECRET: "x", api_key: "y", Password: "z" })).toEqual({ A: "1" })
	})

	it("defaultExec reports a real exit status and treats spawn failure as failure", async () => {
		const opts = { cwd: os.tmpdir(), timeoutMs: 10_000, maxOutputBytes: 10_000, env: process.env }
		expect((await defaultExec([process.execPath, "-e", "process.exit(0)"], opts)).exitCode).toBe(0)
		expect((await defaultExec([process.execPath, "-e", "process.exit(3)"], opts)).exitCode).toBe(3)
		expect((await defaultExec(["definitely-not-a-command-xyz"], opts)).exitCode).not.toBe(0)
	})
})

describe("verifySpecRevision (end to end, real store)", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "spec-verify-"))
		await fs.mkdir(path.join(root, "src"))
		for (const f of ["session", "password", "ratelimit"]) await fs.writeFile(path.join(root, `src/${f}.ts`), `// ${f}\n`)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const pass = [{ kind: "pass" as const, reason: "ok" }]

	const setup = async () => {
		const store = new SpecRevisionStore(path.join(root, ".kiro/specs"))
		await store.saveRevision(rev)
		await store.recordApproval(rev.specId, approval)
		return store
	}

	it("passes when every check exits 0, and persists evidence", async () => {
		const store = await setup()
		const gate = await verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: pass, exec: exit(0) })
		expect(gate.verdict).toBe("pass")
		expect((await store.readEvidence(rev.specId)).records).toHaveLength(3)
	})

	it("fails when a check exits non-zero even though the verifier gate passed", async () => {
		const store = await setup()
		let n = 0
		const exec: ExecFn = async () => ({ exitCode: n++ === 1 ? 2 : 0, output: "x" })
		const gate = await verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: pass, exec })
		expect(gate.verdict).toBe("failed")
		expect(gate.acceptance.find((a) => a.acceptanceId === "A2")?.state).toBe("failed")
	})

	it("fails without a passing verifier outcome, and a later source edit makes old evidence stale", async () => {
		const store = await setup()
		const first = await verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: [], exec: exit(0) })
		expect(first.verdict).toBe("failed")
		await verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: pass, exec: exit(0) })
		await fs.writeFile(path.join(root, "src/session.ts"), "// edited\n")
		const { records } = await store.readEvidence(rev.specId)
		const { evaluateSpecGate } = await import("../SpecGate")
		const { digestInputs } = await import("../SpecCheckRunner")
		const stale = evaluateSpecGate({
			revision: rev,
			approval,
			evidence: records,
			currentSourceRevision: "git:aaa",
			currentInputDigests: await digestInputs(root, ["src/session.ts", "src/password.ts", "src/ratelimit.ts"]),
			verifierGatePassed: true,
		})
		expect(stale.acceptance.find((a) => a.acceptanceId === "A1")?.state).toBe("stale")
		expect(stale.verdict).toBe("not-verified")
	})

	it("derives the same verdict after a restart from persisted state alone, with no re-run", async () => {
		const store = await setup()
		const before = await verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: pass, exec: exit(0) })
		expect(before.verdict).toBe("pass")

		// A brand-new store over the same directory: nothing in memory survives.
		const reopened = new SpecRevisionStore(path.join(root, ".kiro/specs"))
		const loaded = await reopened.loadRevision(rev.specId, rev.revisionId)
		const { evaluateSpecGate } = await import("../SpecGate")
		const { digestInputs } = await import("../SpecCheckRunner")
		const after = evaluateSpecGate({
			revision: loaded,
			approval: await reopened.findApproval(rev.specId, rev.revisionId),
			evidence: (await reopened.readEvidence(rev.specId)).records,
			currentSourceRevision: "git:aaa",
			currentInputDigests: await digestInputs(root, ["src/session.ts", "src/password.ts", "src/ratelimit.ts"]),
			verifierGatePassed: true,
		})
		expect(after.verdict).toBe("pass")
		expect(after.coverage).toEqual(before.coverage)
	})

	it("refuses to run anything when the revision was never approved", async () => {
		const store = new SpecRevisionStore(path.join(root, ".kiro/specs"))
		await store.saveRevision(rev)
		const exec = exit(0)
		await expect(verifySpecRevision({ store, revision: rev, workspaceRoot: root, sourceRevision: "git:aaa", verifierOutcomes: pass, exec })).rejects.toThrow(/not approved/)
		expect(exec).not.toHaveBeenCalled()
	})
})
