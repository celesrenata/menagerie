import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { QuestionMemory } from "../../questions/QuestionMemory"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { AskFollowupQuestionTool } from "../AskFollowupQuestionTool"

describe("ask_followup_question with question memory", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-mem-"))
		await fs.mkdir(path.join(root, ".kiro/steering"), { recursive: true })
		await fs.writeFile(path.join(root, ".kiro/steering/stack.md"), "# Stack\n\nWe use Postgres as the session database and Vitest as the test framework.\n")
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	const makeTask = (state: Record<string, unknown> = {}, answer = "Vitest", messages: unknown[] = []) => {
		const ask = vi.fn().mockResolvedValue({ text: answer, images: [] })
		const say = vi.fn().mockResolvedValue(undefined)
		const task = {
			taskId: "task-12345678",
			cwd: root,
			clineMessages: messages,
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn(),
			providerRef: { deref: () => ({ getState: async () => state }) },
			ask,
			say,
		} as unknown as Task
		const pushToolResult = vi.fn()
		const callbacks: ToolCallbacks = { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult }
		return { task, ask, say, pushToolResult, callbacks }
	}
	const run = (task: Task, callbacks: ToolCallbacks, question: string, follow_up: Array<{ text: string }> = []) =>
		new AskFollowupQuestionTool().execute({ question, follow_up }, task, callbacks)
	const resultText = (push: ReturnType<typeof vi.fn>) => String(JSON.stringify(push.mock.calls[0][0]))

	it("asks the user the first time, remembers the answer, and does not ask again in a later task", async () => {
		const first = makeTask({}, "Jest")
		await run(first.task, first.callbacks, "Which unit testing library should this project adopt?")
		expect(first.ask).toHaveBeenCalledOnce()

		const later = makeTask() // a brand-new task with no shared state
		await run(later.task, later.callbacks, "What unit testing library should this project adopt")
		expect(later.ask).not.toHaveBeenCalled()
		expect(resultText(later.pushToolResult)).toContain("Jest")
		expect(resultText(later.pushToolResult)).toContain("already answered")
		expect(later.say).toHaveBeenCalledWith("text", expect.stringContaining("Reused your earlier answer"))
	})

	it("hands back project doc passages once instead of interrupting, then asks on a repeat", async () => {
		const { task, ask, pushToolResult, callbacks } = makeTask()
		await run(task, callbacks, "Which database and test framework do the sessions use?")
		expect(ask).not.toHaveBeenCalled()
		expect(resultText(pushToolResult)).toContain(".kiro/steering/stack.md")
		expect(resultText(pushToolResult)).toContain("NOT asked")

		await run(task, callbacks, "Which database and test framework do the sessions use?")
		expect(ask).toHaveBeenCalledOnce() // the model insisted, so the user is asked
	})

	it("uses the original request and the user's earlier replies from this conversation", async () => {
		const messages = [
			{ type: "say", say: "task", text: "Build the billing page using Stripe, not PayPal" },
			{ type: "say", say: "user_feedback", text: "Use the sandbox account" },
		]
		const { task, ask, pushToolResult, callbacks } = makeTask({}, "x", messages)
		await run(task, callbacks, "Which payment provider should the billing page use, Stripe or PayPal?", [{ text: "Stripe" }, { text: "PayPal" }])
		expect(ask).not.toHaveBeenCalled()
		expect(resultText(pushToolResult)).toContain("your original request")
	})

	it("asks normally when nothing relevant exists", async () => {
		const { task, ask, callbacks } = makeTask()
		await run(task, callbacks, "What should the onboarding tooltip say?")
		expect(ask).toHaveBeenCalledOnce()
	})

	it("does nothing when the setting is off", async () => {
		await new QuestionMemory(root).record("Which unit testing library should this project adopt?", "Jest")
		const { task, ask, callbacks } = makeTask({ questionMemoryEnabled: false })
		await run(task, callbacks, "Which unit testing library should this project adopt?")
		expect(ask).toHaveBeenCalledOnce()
		expect(await new QuestionMemory(root).list()).toHaveLength(1) // and it stored nothing new
	})

	it("does not store an answer when follow-up auto-approval may have picked it", async () => {
		const { task, callbacks } = makeTask({ alwaysAllowFollowupQuestions: true }, "Option A")
		await run(task, callbacks, "Which deployment strategy should we pick for production?")
		expect(await new QuestionMemory(root).list()).toEqual([])
	})

	it("does not store a secret the user typed", async () => {
		const { task, callbacks } = makeTask({}, "the key is sk-abcdefghijklmnop1234567")
		await run(task, callbacks, "What API key should the integration use?")
		expect(await new QuestionMemory(root).list()).toEqual([])
	})

	it("ignores a stored answer that no longer fits the options now offered", async () => {
		await new QuestionMemory(root).record("Which database should we use for sessions?", "MySQL")
		const { task, ask, callbacks } = makeTask({}, "Postgres")
		await run(task, callbacks, "Which database should we use for sessions?", [{ text: "Postgres" }, { text: "SQLite" }])
		expect(ask).toHaveBeenCalledOnce()
	})

	it("stays functional when memory I/O fails", async () => {
		const { task, ask, callbacks } = makeTask()
		;(task as unknown as { cwd: string }).cwd = path.join(root, "missing", "dir")
		await run(task, callbacks, "What should the onboarding tooltip say?")
		expect(ask).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})
})
