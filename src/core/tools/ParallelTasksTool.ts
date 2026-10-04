import * as vscode from "vscode"
import { z } from "zod"
import { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { getModeBySlug } from "../../shared/modes"
import { Package } from "../../shared/package"
import { runParallelTasks } from "../task/runParallelTasks"
import { addSharedDocumentReader } from "../task/ParallelTaskReader"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { formatResponse } from "../prompts/responses"

export const parallelTaskSpecSchema = z
	.object({
		name: z.string().min(1).max(80),
		mode: z.string().min(1),
		message: z.string().min(1).max(120_000),
		todos: z.string().nullable().optional(),
		// Optional per-worker OmniRoute model/route id (or custom-route name). Placement still
		// resolves in OmniRoute; menagerie only passes the selected id through (design §5.2).
		route: z.string().min(1).max(200).nullable().optional(),
	})
	// `.strip()` (not `.strict()`) for the transition release so a stray legacy
	// `routing_tier`/`routing_reason` on a worker spec is dropped rather than rejected (design §7).
	.strip()

export const parallelTasksSchema = z
	.object({
		tasks: z.array(parallelTaskSpecSchema).min(1).max(4),
	})
	.strict()
	.refine(({ tasks }) => new Set(tasks.map((task) => task.name)).size === tasks.length, "Task names must be unique")

export type ParallelTaskSpec = z.infer<typeof parallelTaskSpecSchema>

/** A bad parallel_tasks argument the model can fix and retry (as opposed to a runtime failure). */
class ParallelTasksArgumentError extends Error {}

/** Build the recoverable tool-error text for invalid parallel_tasks arguments. */
export function formatParallelTasksArgumentError(error: z.ZodError | Error): string {
	const problems =
		error instanceof z.ZodError
			? error.issues
					.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
					.join("; ")
			: error.message
	return (
		"Invalid parallel_tasks arguments: provide 1-4 tasks, each with a unique name, mode, message, " +
		`todos (string or null) and route (string or null). Problems: ${problems}`
	)
}

export class ParallelTasksTool extends BaseTool<"parallel_tasks"> {
	readonly name = "parallel_tasks" as const

	async execute(input: { tasks: ParallelTaskSpec[] }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const parsed = parallelTasksSchema.safeParse(input)
			if (!parsed.success) throw parsed.error
			const { tasks: requestedTasks } = parsed.data
			task.parallelTaskArgumentRecovery.onValidCall()
			const provider = task.providerRef.deref()
			if (!provider) throw new Error("Provider reference lost")
			const state = await provider.getState()
			if (!state.experiments?.parallelTasks)
				throw new Error("Enable Parallel tasks in Experimental settings first")
			if (task.parallelWorker)
				throw new Error("Parallel workers must finish their own task without spawning more workers")
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)
			const tasks = await addSharedDocumentReader(
				requestedTasks,
				task.cwd,
				Boolean(getModeBySlug("project-reader", state.customModes)),
				requireTodos,
			)
			for (const spec of tasks) {
				if (!getModeBySlug(spec.mode, state.customModes))
					throw new ParallelTasksArgumentError(`Invalid mode: ${spec.mode}`)
				if (requireTodos && spec.todos == null)
					throw new ParallelTasksArgumentError(`Task ${spec.name} requires todos`)
				if (spec.todos) {
					try {
						parseMarkdownChecklist(spec.todos)
					} catch (error) {
						throw new ParallelTasksArgumentError(
							`Task ${spec.name} has invalid todos: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}
			}
			const approved = await callbacks.askApproval(
				"tool",
				JSON.stringify({
					tool: "newTask",
					mode: "Parallel tasks",
					content: tasks
						.map(
							(spec) =>
								`${spec.name} (${spec.mode}${spec.route ? `, ${spec.route}` : ""})\n${spec.message}`,
						)
						.join("\n\n"),
				}),
			)
			if (!approved) return
			const result = await runParallelTasks(task, provider, tasks)
			callbacks.pushToolResult(JSON.stringify(result))
		} catch (error) {
			// Argument problems are recoverable: report them to the model as a tool error so it can
			// retry with 1-4 valid tasks, instead of surfacing a fatal user-facing error.
			if (error instanceof z.ZodError || error instanceof ParallelTasksArgumentError) {
				if (error instanceof z.ZodError) task.parallelTaskArgumentRecovery.onMalformedCall()
				task.consecutiveMistakeCount++
				task.recordToolError("parallel_tasks")
				task.didToolFailInCurrentTurn = true
				callbacks.pushToolResult(formatResponse.toolError(formatParallelTasksArgumentError(error)))
				return
			}
			task.didToolFailInCurrentTurn = true
			await callbacks.handleError(
				"running parallel tasks",
				error instanceof Error ? error : new Error(String(error)),
			)
		}
	}
}

export const parallelTasksTool = new ParallelTasksTool()
