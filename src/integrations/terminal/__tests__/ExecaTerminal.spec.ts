// npx vitest run src/integrations/terminal/__tests__/ExecaTerminal.spec.ts

import { RooTerminalCallbacks } from "../types"
import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess, SHELL_EXIT_DRAIN_GRACE_MS } from "../ExecaTerminalProcess"
import { execa } from "execa"

describe("ExecaTerminal", () => {
	it("rejects the command promise when process startup rejects", async () => {
		const startupError = new Error("execa startup failed")
		const runSpy = vi.spyOn(ExecaTerminalProcess.prototype, "run").mockRejectedValueOnce(startupError)
		const terminal = new ExecaTerminal(1, "/tmp")

		const commandPromise = terminal.runCommand("echo test", {
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		})

		await expect(commandPromise).rejects.toThrow("execa startup failed")
		expect(runSpy).toHaveBeenCalledWith("echo test")
		runSpy.mockRestore()
	})

	it("should run terminal commands and collect output", async () => {
		// TODO: Run the equivalent test for Windows.
		if (process.platform === "win32") {
			return
		}

		const terminal = new ExecaTerminal(1, "/tmp")
		let result

		const callbacks: RooTerminalCallbacks = {
			onLine: vi.fn(),
			onCompleted: (output) => {
				result = output
			},
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}

		const subprocess = terminal.runCommand("ls -al", callbacks)
		await subprocess

		expect(callbacks.onLine).toHaveBeenCalled()
		expect(callbacks.onShellExecutionStarted).toHaveBeenCalled()
		expect(callbacks.onShellExecutionComplete).toHaveBeenCalled()

		expect(result).toBeTypeOf("string")
		expect(result).toContain("total")
	})

	it("completes after the shell exits even when an orphaned descendant holds the output pipe open", async () => {
		if (process.platform === "win32") {
			return
		}

		// The marker makes the orphaned sleep identifiable so the test can clean it up.
		const marker = `sleep 29.${String(Date.now() % 1_000_000).padStart(6, "0")}`
		const terminal = new ExecaTerminal(1, "/tmp")
		let result: string | undefined
		const onShellExecutionComplete = vi.fn()

		try {
			const started = Date.now()
			await terminal.runCommand(`(${marker} &); echo before-exit; exit 3`, {
				onLine: vi.fn(),
				onCompleted: (output) => {
					result = output
				},
				onShellExecutionStarted: vi.fn(),
				onShellExecutionComplete,
			})

			expect(Date.now() - started).toBeLessThan(SHELL_EXIT_DRAIN_GRACE_MS + 5_000)
			expect(result).toContain("before-exit")
			expect(result).toContain("background process is still holding the output open")
			expect(onShellExecutionComplete).toHaveBeenCalledWith(
				expect.objectContaining({ exitCode: 3 }),
				expect.anything(),
			)
		} finally {
			await execa("pkill", ["-9", "-f", marker], { reject: false })
		}
	}, 15_000)
})
