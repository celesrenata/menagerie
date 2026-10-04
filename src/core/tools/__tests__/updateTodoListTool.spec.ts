import { describe, it, expect, beforeEach, vi } from "vitest"
import { coerceTodosArg, parseMarkdownChecklist, setPendingTodoList, updateTodoListTool } from "../UpdateTodoListTool"
import { TodoItem } from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

describe("UpdateTodoListTool", () => {
	it("persists a JSON todo list emitted by a native-tool model", async () => {
		const task = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			todoList: [],
		} as unknown as Task
		const callbacks = {
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			askApproval: vi.fn().mockResolvedValue(true),
		} as unknown as ToolCallbacks
		await updateTodoListTool.execute(
			{
				todos: '[{"status":"completed","text":"Review contract"},{"status":"in_progress","text":"Fix persistence"}]',
			},
			task,
			callbacks,
		)
		expect(task.todoList).toEqual([
			expect.objectContaining({ content: "Review contract", status: "completed" }),
			expect.objectContaining({ content: "Fix persistence", status: "in_progress" }),
		])
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Todo list updated successfully"))
	})

	it("persists the edited todo list even if the say notification fails", async () => {
		const editedTodos: TodoItem[] = [{ id: "edited", content: "Edited task", status: "in_progress" }]
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const task = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			todoList: [],
			say: vi.fn().mockRejectedValue(new Error("say failed")),
		} as unknown as Task
		const callbacks = {
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			askApproval: vi.fn().mockImplementation(async () => {
				setPendingTodoList(editedTodos)
				return true
			}),
		} as unknown as ToolCallbacks

		await updateTodoListTool.execute({ todos: "[ ] Original task" }, task, callbacks)
		await new Promise<void>((resolve) => setImmediate(resolve))

		// Notification is fire-and-forget: persistence happens regardless, and the
		// rejection is logged rather than routed to handleError (which would abort).
		expect(task.todoList).toEqual(editedTodos)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[UpdateTodoListTool] Failed to post user_edit_todos:",
			expect.any(Error),
		)
		consoleErrorSpy.mockRestore()
	})

	describe("non-string todos (A2 coercion)", () => {
		function makeTask() {
			return {
				consecutiveMistakeCount: 0,
				recordToolError: vi.fn(),
				didToolFailInCurrentTurn: false,
				todoList: [],
			} as unknown as Task
		}
		function makeCallbacks() {
			return {
				pushToolResult: vi.fn(),
				handleError: vi.fn(),
				askApproval: vi.fn().mockResolvedValue(true),
			} as unknown as ToolCallbacks
		}

		it("parses and persists the incident array-of-objects todos", async () => {
			const incidentTodos: unknown = [
				{ content: "Scaffold web app", status: "completed" },
				{ content: "Wire API client", status: "in_progress" },
				{ content: "Add tests", status: "pending" },
			]
			const task = makeTask()
			const callbacks = makeCallbacks()

			await updateTodoListTool.execute({ todos: incidentTodos as string }, task, callbacks)

			expect(task.todoList).toEqual([
				expect.objectContaining({ content: "Scaffold web app", status: "completed" }),
				expect.objectContaining({ content: "Wire API client", status: "in_progress" }),
				expect.objectContaining({ content: "Add tests", status: "pending" }),
			])
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Todo list updated successfully"),
			)
			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("joins a string array into checklist lines", async () => {
			const stringTodos: unknown = ["[ ] a", "[x] b"]
			const task = makeTask()
			const callbacks = makeCallbacks()

			await updateTodoListTool.execute({ todos: stringTodos as string }, task, callbacks)

			expect(task.todoList).toEqual([
				expect.objectContaining({ content: "a", status: "pending" }),
				expect.objectContaining({ content: "b", status: "completed" }),
			])
		})

		it("reports a non-coercible value as an invalid checklist", async () => {
			const numberTodos: unknown = 42
			const task = makeTask()
			const callbacks = makeCallbacks()

			await updateTodoListTool.execute({ todos: numberTodos as string }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("The todos parameter is not valid markdown checklist or JSON"),
			)
			expect(task.consecutiveMistakeCount).toBe(1)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.todoList).toEqual([])
		})
	})

	describe("no-op table (B2)", () => {
		const currentTodos: TodoItem[] = [
			{ id: "a", content: "Scaffold web app", status: "completed" },
			{ id: "b", content: "Wire API client", status: "in_progress" },
		]

		function makeTask(todoList: TodoItem[]) {
			const recordToolError = vi.fn()
			// Double cast: plain object satisfies only the members execute() touches.
			const task = {
				consecutiveMistakeCount: 0,
				recordToolError,
				didToolFailInCurrentTurn: false,
				todoList,
			} as unknown as Task
			return { task, recordToolError }
		}
		function makeCallbacks() {
			const pushToolResult = vi.fn()
			const askApproval = vi.fn().mockResolvedValue(true)
			// Double cast: only the callbacks execute() calls are provided.
			const callbacks = { pushToolResult, handleError: vi.fn(), askApproval } as unknown as ToolCallbacks
			return { callbacks, pushToolResult, askApproval }
		}

		it("answers an unchanged list without asking or replacing the stored list", async () => {
			const { task } = makeTask(currentTodos)
			const { callbacks, pushToolResult, askApproval } = makeCallbacks()

			await updateTodoListTool.execute({ todos: "[x] Scaffold web app\n[-] Wire API client" }, task, callbacks)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Todo list unchanged (2 items, 1 completed)"),
			)
			expect(askApproval).not.toHaveBeenCalled()
			expect(task.todoList).toBe(currentTodos)
			expect(task.todoList).toEqual([
				{ id: "a", content: "Scaffold web app", status: "completed" },
				{ id: "b", content: "Wire API client", status: "in_progress" },
			])
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.didToolFailInCurrentTurn).toBe(false)
		})

		const emptyInputs: Array<[string, unknown]> = [
			["an empty string", ""],
			['"[]"', "[]"],
			["'{\"todos\":[]}'", '{"todos":[]}'],
			["an empty array param", []],
			['"[1,2]" (JSON-shaped, parsed as Markdown)', "[1,2]"],
		]

		it.each(emptyInputs)("treats %s as unchanged when the current list is empty", async (_label, todos) => {
			const current: TodoItem[] = []
			const { task, recordToolError } = makeTask(current)
			const { callbacks, pushToolResult, askApproval } = makeCallbacks()

			await updateTodoListTool.execute({ todos: todos as string }, task, callbacks)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Todo list unchanged (0 items, 0 completed)"),
			)
			expect(askApproval).not.toHaveBeenCalled()
			expect(task.todoList).toBe(current)
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(recordToolError).not.toHaveBeenCalled()
		})

		it.each(emptyInputs)("ignores %s when the current list is non-empty", async (_label, todos) => {
			const { task, recordToolError } = makeTask(currentTodos)
			const { callbacks, pushToolResult, askApproval } = makeCallbacks()

			await updateTodoListTool.execute({ todos: todos as string }, task, callbacks)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining(
					"Todo list unchanged: an empty list was ignored. Current list has 2 items (1 completed).",
				),
			)
			expect(askApproval).not.toHaveBeenCalled()
			expect(task.todoList).toBe(currentTodos)
			expect(task.todoList).toHaveLength(2)
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(recordToolError).not.toHaveBeenCalled()
		})

		it("rejects prose with no checklist items as a tool failure", async () => {
			const { task, recordToolError } = makeTask(currentTodos)
			const { callbacks, pushToolResult, askApproval } = makeCallbacks()

			await updateTodoListTool.execute({ todos: "just prose" }, task, callbacks)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No checklist items found."))
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"error"'))
			expect(task.consecutiveMistakeCount).toBe(1)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(recordToolError).toHaveBeenCalledWith("update_todo_list")
			expect(askApproval).not.toHaveBeenCalled()
			expect(task.todoList).toBe(currentTodos)
		})

		it("runs the approval flow for a changed list", async () => {
			const { task } = makeTask(currentTodos)
			const { callbacks, pushToolResult, askApproval } = makeCallbacks()

			await updateTodoListTool.execute({ todos: "[x] Scaffold web app\n[x] Wire API client" }, task, callbacks)

			expect(askApproval).toHaveBeenCalledTimes(1)
			expect(task.todoList).toEqual([
				expect.objectContaining({ content: "Scaffold web app", status: "completed" }),
				expect.objectContaining({ content: "Wire API client", status: "completed" }),
			])
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Todo list updated successfully"))
		})
	})
})

describe("coerceTodosArg", () => {
	it("returns strings unchanged", () => {
		expect(coerceTodosArg("[ ] a")).toBe("[ ] a")
		expect(coerceTodosArg("")).toBe("")
	})

	it("joins a non-empty string array with newlines", () => {
		expect(coerceTodosArg(["[ ] a", "[x] b"])).toBe("[ ] a\n[x] b")
	})

	it("stringifies an empty array as []", () => {
		expect(coerceTodosArg([])).toBe("[]")
	})

	it("stringifies a mixed array as JSON", () => {
		const mixed = ["[ ] a", { content: "b", status: "pending" }]
		expect(coerceTodosArg(mixed)).toBe(JSON.stringify(mixed))
	})

	it("stringifies an object as JSON", () => {
		const wrapped = { todos: [{ content: "a", status: "pending" }] }
		expect(coerceTodosArg(wrapped)).toBe(JSON.stringify(wrapped))
	})

	it("returns other primitives unchanged", () => {
		expect(coerceTodosArg(42)).toBe(42)
		expect(coerceTodosArg(true)).toBe(true)
		expect(coerceTodosArg(null)).toBe(null)
		expect(coerceTodosArg(undefined)).toBe(undefined)
	})
})

describe("parseMarkdownChecklist", () => {
	it("parses JSON arrays and rejects malformed structured todos", () => {
		const result = parseMarkdownChecklist('{"todos":[{"content":"Audit API","status":"pending"}]}')
		expect(result[0]).toEqual(expect.objectContaining({ content: "Audit API", status: "pending" }))
		expect(() => parseMarkdownChecklist('[{"text":"Review","status":"invalid"}]')).toThrow()
	})

	describe("standard checkbox format (without dash prefix)", () => {
		it("should parse pending tasks", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with lowercase x", () => {
			const md = `[x] Completed task 1
[x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with uppercase X", () => {
			const md = `[X] Completed task 1
[X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash", () => {
			const md = `[-] In progress task 1
[-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with tilde", () => {
			const md = `[~] In progress task 1
[~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("dash-prefixed checkbox format", () => {
		it("should parse pending tasks with dash prefix", () => {
			const md = `- [ ] Task 1
- [ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with dash prefix and lowercase x", () => {
			const md = `- [x] Completed task 1
- [x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with dash prefix and uppercase X", () => {
			const md = `- [X] Completed task 1
- [X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash prefix and dash marker", () => {
			const md = `- [-] In progress task 1
- [-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with dash prefix and tilde marker", () => {
			const md = `- [~] In progress task 1
- [~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("mixed formats", () => {
		it("should parse mixed formats correctly", () => {
			const md = `[ ] Task without dash
- [ ] Task with dash
[x] Completed without dash
- [X] Completed with dash
[-] In progress without dash
- [~] In progress with dash`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(6)

			expect(result[0].content).toBe("Task without dash")
			expect(result[0].status).toBe("pending")

			expect(result[1].content).toBe("Task with dash")
			expect(result[1].status).toBe("pending")

			expect(result[2].content).toBe("Completed without dash")
			expect(result[2].status).toBe("completed")

			expect(result[3].content).toBe("Completed with dash")
			expect(result[3].status).toBe("completed")

			expect(result[4].content).toBe("In progress without dash")
			expect(result[4].status).toBe("in_progress")

			expect(result[5].content).toBe("In progress with dash")
			expect(result[5].status).toBe("in_progress")
		})
	})

	describe("edge cases", () => {
		it("should handle empty strings", () => {
			const result = parseMarkdownChecklist("")
			expect(result).toEqual([])
		})

		it("should handle non-string input", () => {
			const result = parseMarkdownChecklist(null as any)
			expect(result).toEqual([])
		})

		it("should handle undefined input", () => {
			const result = parseMarkdownChecklist(undefined as any)
			expect(result).toEqual([])
		})

		it("should ignore non-checklist lines", () => {
			const md = `This is not a checklist
[ ] Valid task
Just some text
- Not a checklist item
- [x] Valid completed task
[not valid] Invalid format`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Valid task")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Valid completed task")
			expect(result[1].status).toBe("completed")
		})

		it("should handle extra spaces", () => {
			const md = `  [ ]   Task with spaces  
-  [ ]  Task with dash and spaces
  [x]  Completed with spaces
-   [X]   Completed with dash and spaces`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(4)
			expect(result[0].content).toBe("Task with spaces")
			expect(result[1].content).toBe("Task with dash and spaces")
			expect(result[2].content).toBe("Completed with spaces")
			expect(result[3].content).toBe("Completed with dash and spaces")
		})

		it("should handle Windows line endings", () => {
			const md = "[ ] Task 1\r\n- [x] Task 2\r\n[-] Task 3"
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(3)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("completed")
			expect(result[2].content).toBe("Task 3")
			expect(result[2].status).toBe("in_progress")
		})
	})

	describe("ID generation", () => {
		it("should generate consistent IDs for the same content and status", () => {
			const md1 = `[ ] Task 1
[x] Task 2`
			const md2 = `[ ] Task 1
[x] Task 2`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)

			expect(result1[0].id).toBe(result2[0].id)
			expect(result1[1].id).toBe(result2[1].id)
		})

		it("should generate different IDs for different content", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate different IDs for same content but different status", () => {
			const md = `[ ] Task 1
[x] Task 1`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate same IDs regardless of dash prefix", () => {
			const md1 = `[ ] Task 1`
			const md2 = `- [ ] Task 1`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)
			expect(result1[0].id).toBe(result2[0].id)
		})
	})
})
