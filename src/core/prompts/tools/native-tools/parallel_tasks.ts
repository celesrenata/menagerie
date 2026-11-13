import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "parallel_tasks",
		description:
			'Run 1–12 independent full Menagerie tasks, each in its own tab and Git worktree copied from the current working tree (including uncommitted, non-ignored files). REQUIRED INPUT: {"background":null,"tasks":[{"name":"first","mode":"code","message":"...","todos":null},{"name":"second","mode":"architect","message":"...","todos":null}]}. Never call with {} or an empty tasks array. Use as many tasks as there are independent scopes (up to 12) to run them concurrently; the scheduler queues extra workers against real backend capacity, so do not hold back; a single task runs as one isolated worker. Each mode selects its saved provider/model profile. Choose a mode for each worker by its actual scope, not by the parent\'s mode: use project-reader on the configured fast reader route for bounded file gathering or a specific spec/contract audit, a research/long-context mode only for work that genuinely needs long-context synthesis, and Code/reasoner modes for bounded implementation or hard reasoning. Do not route ordinary reader work through the long-context coordinator by default. If independent Code scopes exist alongside relevant specs, contracts, docs, or existing tests, add a bounded project-reader audit so the reader lane works concurrently; do not create filler work. Keep project-reader tasks bounded and read-only, and require their final attempt_completion report to stay under 400 words with findings, evidence paths/line ranges, uncertainty, and no raw file dumps. Ask other workers to keep final parent reports concise as well; details belong in their files, tests and patches. When independent subtasks have different scopes, use their different suitable modes so they run on their configured profiles; do not send every worker through the same long-task profile by default. Supply complete context, a narrow scope and completion criteria. Workers can read, edit and test in their own worktrees; they cannot spawn further tasks. By default this call waits for every worker and returns bounded completion summaries, task IDs, workspace and patch paths, including failures; full worker completion text remains in the saved batch manifest. The parent must review and integrate the returned patches; no changes are automatically applied to the original checkout. Set background to true to detach the batch: the call returns at once with the batchId and worker names, you keep working, each worker result appears under \"# Background Tasks\" in a later turn, and you can use the background_tasks tool to check status, send steering to a running worker, cancel, or wait. Use background for long independent work when you have other useful work to do meanwhile; leave it null to block until the batch finishes. Requires a Git repository with HEAD. Use new_task for dependent work that must happen sequentially. If the arguments are missing or invalid, the call returns a tool error; retry parallel_tasks with a full array of 1–12 tasks. Cancelling the parent cancels its queued/running workers. Do not mix this call with other tools in the same turn.',
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: 12,
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
							verification: {
								type: ["object", "null"],
								description:
									"Optional. Set to audit this worker's output with an independent read-only verifier that sends failed work back for rework (bounded). Edit-capable workers are audited by default, so use null unless you need specific criteria.",
								properties: {
									required: {
										type: "boolean",
										description: "true to require independent verification",
									},
									criteria: {
										type: "array",
										items: { type: "string" },
										description: "Pass/fail checks the verifier must evaluate",
									},
								},
								required: ["required", "criteria"],
								additionalProperties: false,
							},
						},
						required: ["name", "mode", "message", "todos", "route", "verification"],
						additionalProperties: false,
					},
				},
				background: {
					type: ["boolean", "null"],
					description:
						"true detaches the batch and returns immediately; false or null waits for every worker",
				},
			},
			required: ["tasks", "background"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
