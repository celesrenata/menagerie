import type { ObservedTask, ObservedTaskStatus, MastermindSummary } from "@roo-code/types"

const ALL_STATUSES: readonly ObservedTaskStatus[] = [
	"queued",
	"working",
	"streaming",
	"waiting",
	"completed",
	"failed",
	"cancelled",
]

/**
 * Computes a parent-level Mastermind summary from its workers' derived statuses.
 * Pure function — performs no task writes.
 */
export function computeMastermindSummary(
	parentTaskId: string,
	workers: readonly ObservedTask[],
): MastermindSummary {
	const workerCounts = {} as Record<ObservedTaskStatus, number>
	for (const status of ALL_STATUSES) {
		workerCounts[status] = 0
	}

	const laneStatus: { workerId: string; status: ObservedTaskStatus }[] = []
	let contextPercent: number | null = null
	let tierCeiling: string | null = null
	const artifactSet = new Set<string>()
	const blockers: string[] = []

	for (const worker of workers) {
		workerCounts[worker.status] += 1

		const workerId = worker.logicalWorkerId ?? worker.id
		laneStatus.push({ workerId, status: worker.status })

		const h = worker.header
		if (contextPercent === null && h.contextUsed !== null && h.contextLimit !== null && h.contextLimit > 0) {
			contextPercent = Math.round((h.contextUsed / h.contextLimit) * 100)
		}

		if (tierCeiling === null && h.route !== null) {
			tierCeiling = h.route
		}

		if (h.workspace !== null) {
			artifactSet.add(h.workspace)
		}

		if (worker.status === "waiting" || worker.status === "failed") {
			blockers.push(`${workerId}: ${worker.status}`)
		}
	}

	return {
		parentTaskId,
		workerCounts,
		laneStatus,
		contextPercent,
		tierCeiling,
		artifacts: Array.from(artifactSet),
		blockers,
	}
}

/**
 * Returns exactly the tasks whose status is "waiting" (waiting for user input).
 * Preserves input order. Pure function.
 */
export function computeAttentionQueue(tasks: readonly ObservedTask[]): ObservedTask[] {
	return tasks.filter((task) => task.status === "waiting")
}
