import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

const completeOnAnalysisRoute = vi.fn()
const runParallelTasks = vi.fn()
vi.mock("../../../services/analysis/AnalysisService", () => ({ completeOnAnalysisRoute: (...a: unknown[]) => completeOnAnalysisRoute(...a) }))
vi.mock("../../task/runParallelTasks", () => ({ runParallelTasks: (...a: unknown[]) => runParallelTasks(...a) }))

import { AskFollowupQuestionTool } from "../AskFollowupQuestionTool"

describe("ask_followup_question reader assist", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-reader-"))
		completeOnAnalysisRoute.mockReset()
		runParallelTasks.mockReset()
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const makeTask = (state: Record<string, unknown> = {}) => {
		const ask = vi.fn().mockResolvedValue({ text: "Stripe", images: [] })
		const say = vi.fn().mockResolvedValue(undefined)
		const messages = [{ type: "say", say: "task", text: "Money handling: all invoices are settled through Stripe, never PayPal. Everything else is out of scope here." }]
		const task = {
			taskId: "task-12345678",
			cwd: root,
			clineMessages: messages,
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			providerRef: { deref: () => ({ getState: async () => state }) },
			ask,
			say,
		} as unknown as Task
		const pushToolResult = vi.fn()
		const callbacks: ToolCallbacks = { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult }
		return { task, ask, say, pushToolResult, callbacks }
	}
	const run = (task: Task, callbacks: ToolCallbacks) =>
		new AskFollowupQuestionTool().execute({ question: "Which processor handles card charges for invoices?", follow_up: [] }, task, callbacks)

	it("answers from the low lane without interrupting the user, then asks on the repeat", async () => {
		completeOnAnalysisRoute.mockResolvedValue({
			kind: "ok",
			modelId: "granite",
			content: JSON.stringify({ answer: "Stripe", confidence: 0.9, citations: [{ id: "E1", quote: "invoices are settled through Stripe, never PayPal" }] }),
		})
		const { task, ask, pushToolResult, callbacks } = makeTask()
		await run(task, callbacks)
		expect(ask).not.toHaveBeenCalled()
		expect(JSON.stringify(pushToolResult.mock.calls[0][0])).toContain("reader_answer")
		expect(runParallelTasks).not.toHaveBeenCalled()
		await run(task, callbacks)
		expect(ask).toHaveBeenCalledOnce()
		expect(completeOnAnalysisRoute).toHaveBeenCalledOnce()
	})

	it("escalates to a project-reader forced onto reader.deep when the low lane is unavailable", async () => {
		await fs.writeFile(path.join(root, "billing.ts"), "// stripe\n")
		completeOnAnalysisRoute.mockResolvedValue({ kind: "unavailable", reason: "down" })
		runParallelTasks.mockResolvedValue({ tasks: [{ name: "question-reader", state: "completed", result: "Stripe (billing.ts:1)" }] })
		const { task, ask, callbacks } = makeTask()
		await run(task, callbacks)
		expect(ask).not.toHaveBeenCalled()
		const [, , specs, , options] = runParallelTasks.mock.calls[0]
		expect(specs[0]).toMatchObject({ mode: "project-reader" })
		expect(options.laneSelections.get("question-reader")).toEqual({ lane: "reader.deep", taskType: "lookup" })
	})

	it("asks the user when both lanes fail", async () => {
		completeOnAnalysisRoute.mockResolvedValue({ kind: "unavailable", reason: "down" })
		runParallelTasks.mockResolvedValue({ tasks: [{ name: "question-reader", state: "failed", error: "x" }] })
		const { task, ask, callbacks } = makeTask()
		await run(task, callbacks)
		expect(ask).toHaveBeenCalledOnce()
	})

	it("does not run any reader when readerAssistedQuestions is off", async () => {
		const { task, ask, callbacks } = makeTask({ readerAssistedQuestions: false })
		await run(task, callbacks)
		expect(ask).toHaveBeenCalledOnce()
		expect(completeOnAnalysisRoute).not.toHaveBeenCalled()
		expect(runParallelTasks).not.toHaveBeenCalled()
	})
})
