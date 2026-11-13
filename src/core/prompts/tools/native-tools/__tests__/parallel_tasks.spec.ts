import type OpenAI from "openai"
import parallelTasks from "../parallel_tasks"

type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

describe("parallel_tasks", () => {
	it("routes independent subtasks by scope to their configured mode profiles", () => {
		const description = (parallelTasks as FunctionTool).function.description

		expect(description).toContain("project-reader on the configured fast reader route for bounded file gathering")
		expect(description).toContain("a research/long-context mode only for work that genuinely needs long-context synthesis")
		expect(description).toContain("do not send every worker through the same long-task profile by default")
		expect(description).toContain("fourth bounded project-reader audit")
		// No hardware names in policy text: the reader lane is described, not a specific machine.
		expect(description).toContain("so the reader lane works concurrently")
		expect(description).not.toContain("M5")
		expect((parallelTasks as FunctionTool).function.parameters).toMatchObject({
			properties: { tasks: { maxItems: 4 } },
		})
	})

	it("accepts 1–4 tasks in both the schema and the description", () => {
		const { description, parameters } = (parallelTasks as FunctionTool).function

		expect(parameters).toMatchObject({ properties: { tasks: { minItems: 1, maxItems: 4 } } })
		expect(description).toContain("Run 1–4 independent full Menagerie tasks")
		expect(description).toContain("a single task runs as one isolated worker")
		expect(description).toContain("retry parallel_tasks with a full array of 1–4 tasks")
		expect(description).not.toContain("Run 2–4")
		expect(description).toContain("Never call with {} or an empty tasks array")
	})
})
