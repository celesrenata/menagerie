import { describe, expect, it, vi } from "vitest"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { backgroundTasksTool } from "../BackgroundTasksTool"

function setup(service: Record<string, unknown>) {
	const task = {
		taskId: "parent-1",
		providerRef: { deref: () => ({ backgroundBatches: service }) },
		lifetimeSignal: new AbortController().signal,
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
	} as unknown as Task
	const pushToolResult = vi.fn()
	const handleError = vi.fn().mockResolvedValue(undefined)
	const callbacks: ToolCallbacks = { askApproval: vi.fn(), handleError, pushToolResult }
	return { task, pushToolResult, handleError, callbacks }
}

describe("BackgroundTasksTool", () => {
	it("steers the named target with the message", async () => {
		const steer = vi.fn().mockReturnValue({ steered: ["a"], rejected: [] })
		const { task, callbacks, pushToolResult } = setup({ steer })
		await backgroundTasksTool.execute({ action: "steer", target: "a", message: "use v2" }, task, callbacks)
		expect(steer).toHaveBeenCalledWith("parent-1", "a", "use v2")
		expect(JSON.parse(pushToolResult.mock.calls[0]![0] as string)).toEqual({ steered: ["a"], rejected: [] })
	})

	it("reports a tool error when steer lacks a target or message", async () => {
		const steer = vi.fn()
		const { task, callbacks, pushToolResult } = setup({ steer })
		await backgroundTasksTool.execute({ action: "steer", target: null, message: "x" }, task, callbacks)
		await backgroundTasksTool.execute({ action: "steer", target: "a", message: "  " }, task, callbacks)
		expect(steer).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledTimes(2)
		expect(task.recordToolError).toHaveBeenCalledTimes(2)
	})

	it("cancels and lists status", async () => {
		const cancel = vi.fn().mockReturnValue({ cancelled: ["a"], rejected: [] })
		const status = vi.fn().mockReturnValue([{ batchId: "b", finished: false, workers: [] }])
		const { task, callbacks, pushToolResult } = setup({ cancel, status })
		await backgroundTasksTool.execute({ action: "cancel", target: "a" }, task, callbacks)
		await backgroundTasksTool.execute({ action: "status" }, task, callbacks)
		expect(cancel).toHaveBeenCalledWith("parent-1", "a")
		expect(JSON.parse(pushToolResult.mock.calls[1]![0] as string).batches[0].batchId).toBe("b")
	})

	it("waits with a clamped timeout and returns the rendered report", async () => {
		const wait = vi.fn().mockResolvedValue(undefined)
		const takeReport = vi
			.fn()
			.mockReturnValue({ batches: [], running: [{ batchId: "b", name: "a", pendingSteering: 0 }] })
		const { task, callbacks, pushToolResult } = setup({ wait, takeReport })
		await backgroundTasksTool.execute({ action: "wait", timeoutMs: 9_999_999 }, task, callbacks)
		expect(wait).toHaveBeenCalledWith("parent-1", 120_000, task.lifetimeSignal)
		expect(pushToolResult.mock.calls[0]![0]).toContain("# Background Tasks")
		expect(pushToolResult.mock.calls[0]![0]).toContain("- a (batch b)")
	})

	it("says so when there is nothing to report", async () => {
		const { task, callbacks, pushToolResult } = setup({
			wait: vi.fn().mockResolvedValue(undefined),
			takeReport: vi.fn().mockReturnValue(undefined),
		})
		await backgroundTasksTool.execute({ action: "wait" }, task, callbacks)
		expect(pushToolResult).toHaveBeenCalledWith("No background tasks.")
	})
})
