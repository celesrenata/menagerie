import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "background_tasks",
		description:
			'Manage batches you detached with parallel_tasks background:true. Actions: "status" lists each batch and worker with its state and pending steering; "steer" queues a message for a running worker (target = worker name) or every running worker in a batch (target = batchId), and the worker reads it at its next request, so use it to relay what the user just told you; "cancel" stops one worker or a whole batch; "wait" blocks up to timeoutMs (default 30000, max 120000) until a result is ready, then returns it. Results of finished workers also appear on their own under "# Background Tasks" in your environment details. Steering only reaches workers that are still running. You cannot complete the task while background workers are running or have undelivered results: steer, cancel, or wait first. REQUIRED INPUT example: {"action":"steer","target":"api-worker","message":"Use the v2 endpoint instead.","timeoutMs":null}.',
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "steer", "cancel", "wait"],
					description: "What to do",
				},
				target: {
					type: ["string", "null"],
					description: "Worker name or batchId for steer and cancel; null for status and wait",
				},
				message: {
					type: ["string", "null"],
					description: "Steering text for action steer; null otherwise",
				},
				timeoutMs: {
					type: ["integer", "null"],
					description: "Maximum wait in milliseconds for action wait; null uses the default",
				},
			},
			required: ["action", "target", "message", "timeoutMs"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
