import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "parallel_tasks",
		description:
			'Run 1–4 independent full Zoo tasks, each in its own tab and Git worktree copied from the current working tree (including uncommitted, non-ignored files). REQUIRED INPUT: {"tasks":[{"name":"first","mode":"code","message":"...","todos":null},{"name":"second","mode":"architect","message":"...","todos":null}]}. Never call with {} or an empty tasks array. Use 2–4 tasks to run independent scopes concurrently; a single task runs as one isolated worker. Each mode selects its saved provider/model profile. Choose a mode for each worker by its actual scope, not by the parent\'s mode: use project-reader on the configured fast reader route for bounded file gathering or a specific spec/contract audit, a research/long-context mode only for work that genuinely needs long-context synthesis, and Code/reasoner modes for bounded implementation or hard reasoning. Do not route ordinary reader work through the long-context coordinator by default. If three independent Code scopes exist alongside relevant specs, contracts, docs, or existing tests, add a fourth bounded project-reader audit so the reader lane works concurrently; do not create filler work. Keep project-reader tasks bounded and read-only, and require their final attempt_completion report to stay under 400 words with findings, evidence paths/line ranges, uncertainty, and no raw file dumps. Ask other workers to keep final parent reports concise as well; details belong in their files, tests and patches. When independent subtasks have different scopes, use their different suitable modes so they run on their configured profiles; do not send every worker through the same long-task profile by default. Supply complete context, a narrow scope and completion criteria. Workers can read, edit and test in their own worktrees; they cannot spawn further tasks. This call waits for every worker and returns bounded completion summaries, task IDs, workspace and patch paths, including failures; full worker completion text remains in the saved batch manifest. The parent must review and integrate the returned patches; no changes are automatically applied to the original checkout. Requires a Git repository with HEAD. Use new_task for dependent work that must happen sequentially. If the arguments are missing or invalid, the call returns a tool error; retry parallel_tasks with a full array of 1–4 tasks. Cancelling the parent cancels its queued/running workers. Do not mix this call with other tools in the same turn.',
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: 4,
					items: {
						type: "object",
						properties: {
							name: { type: "string", description: "Unique short task name" },
							mode: { type: "string", description: "Existing mode slug; its model mapping is preserved" },
							message: {
								type: "string",
								description: "Independent task with all required context and completion criteria",
							},
							todos: {
								type: ["string", "null"],
								description: "Initial markdown checklist, or null if not required",
							},
							route: {
								type: ["string", "null"],
								description:
									"Optional OmniRoute model/route id (or custom-route name) to run this worker on; null inherits the mode's default. Placement still resolves in OmniRoute.",
							},
						},
						required: ["name", "mode", "message", "todos", "route"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
