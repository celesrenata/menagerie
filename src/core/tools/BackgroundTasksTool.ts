import { formatResponse } from "../prompts/responses"
import type { Task } from "../task/Task"
import { renderBackgroundTasksSection } from "../task/background/renderBackgroundReport"
import { BaseTool, type ToolCallbacks } from "./BaseTool"

const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 120_000

interface BackgroundTasksParams {
	action: "status" | "steer" | "cancel" | "wait"
	target?: string | null
	message?: string | null
	timeoutMs?: number | null
}

/** status | steer | cancel | wait for batches detached with parallel_tasks background:true. */
export class BackgroundTasksTool extends BaseTool<"background_tasks"> {
	readonly name = "background_tasks" as const

	async execute(params: BackgroundTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		try {
			const service = task.providerRef.deref()?.backgroundBatches
			if (!service) throw new Error("Provider reference lost")
			const fail = (text: string) => {
				task.consecutiveMistakeCount++
				task.recordToolError("background_tasks")
				pushToolResult(formatResponse.toolError(text))
			}
			switch (params.action) {
				case "status":
					pushToolResult(JSON.stringify({ batches: service.status(task.taskId) }))
					return
				case "steer": {
					if (!params.target) return fail("steer needs target (worker name or batchId)")
					if (!params.message?.trim()) return fail("steer needs a non-empty message")
					pushToolResult(JSON.stringify(service.steer(task.taskId, params.target, params.message)))
					return
				}
				case "cancel": {
					if (!params.target) return fail("cancel needs target (worker name or batchId)")
					pushToolResult(JSON.stringify(service.cancel(task.taskId, params.target)))
					return
				}
				case "wait": {
					const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_WAIT_MS, 1), MAX_WAIT_MS)
					await service.wait(task.taskId, timeoutMs, task.lifetimeSignal)
					const report = service.takeReport(task.taskId)
					pushToolResult(report ? renderBackgroundTasksSection(report) : "No background tasks.")
					return
				}
				default:
					return fail(`Unknown action ${String((params as { action?: unknown }).action)}`)
			}
		} catch (error) {
			task.didToolFailInCurrentTurn = true
			await handleError("managing background tasks", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const backgroundTasksTool = new BackgroundTasksTool()
