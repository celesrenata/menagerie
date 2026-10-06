/**
 * A bad `parallel_tasks` argument the model can fix and retry (as opposed to a
 * runtime failure).
 *
 * Extracted into its own module so producers of recoverable argument errors —
 * `ParallelTasksTool` validation, and `TaskDag` construction (cyclic or
 * non-unique execution plans) — can throw the same type without a circular
 * import, and `ParallelTasksTool.execute` can route every instance through the
 * recoverable `formatParallelTasksArgumentError` tool-error path.
 */
export class ParallelTasksArgumentError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ParallelTasksArgumentError"
	}
}
