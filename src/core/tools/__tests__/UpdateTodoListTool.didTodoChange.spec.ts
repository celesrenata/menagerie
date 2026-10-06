// npx vitest run core/tools/__tests__/UpdateTodoListTool.didTodoChange.spec.ts

import { describe, it, expect, vi } from "vitest"

import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { UpdateTodoListTool } from "../UpdateTodoListTool"

/**
 * The tool only touches a small slice of Task. This mock exposes exactly that slice;
 * didTodoChange is the field the progress-aware loop detector reads via
 * presentAssistantMessage to tell a real checklist update apart from a no-op call.
 */
function makeTask(todoList: Array<{ id: string; content: string; status: string }>): Task {
	const task = {
		todoList,
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didTodoChange: false,
		recordToolError: vi.fn(),
		say: vi.fn().mockResolvedValue(undefined),
	}
	// The tool reads/writes only the members above on the paths under test.
	return task as unknown as Task
}

function makeCallbacks(approve: boolean): { callbacks: ToolCallbacks; results: string[] } {
	const results: string[] = []
	const callbacks = {
		pushToolResult: (r: unknown) => results.push(typeof r === "string" ? r : JSON.stringify(r)),
		handleError: vi.fn().mockResolvedValue(undefined),
		askApproval: vi.fn().mockResolvedValue(approve),
	} as unknown as ToolCallbacks
	return { callbacks, results }
}

describe("UpdateTodoListTool - didTodoChange plumbing", () => {
	const tool = new UpdateTodoListTool()

	it("sets didTodoChange when a checklist item's status actually changes", async () => {
		const task = makeTask([{ id: "a", content: "task a", status: "pending" }])
		const { callbacks } = makeCallbacks(true)

		await tool.execute({ todos: "[x] task a" }, task, callbacks)

		expect(task.didTodoChange).toBe(true)
	})

	it("leaves didTodoChange false for an unchanged (no-op) list", async () => {
		const task = makeTask([{ id: "a", content: "task a", status: "pending" }])
		const { callbacks, results } = makeCallbacks(true)

		// Identical content + status: the tool returns the "unchanged" message early.
		await tool.execute({ todos: "[ ] task a" }, task, callbacks)

		expect(task.didTodoChange).toBe(false)
		expect(results.join("\n")).toContain("unchanged")
	})

	it("leaves didTodoChange false when an empty list is ignored", async () => {
		const task = makeTask([{ id: "a", content: "task a", status: "pending" }])
		const { callbacks } = makeCallbacks(true)

		await tool.execute({ todos: "" }, task, callbacks)

		expect(task.didTodoChange).toBe(false)
	})
})
