import type { ParallelismPolicy } from "@roo-code/types"
import type { UserParallelismPolicy } from "./elasticTypes"

/**
 * Converts the per-request FEAT-011 policy into the scheduler's additive
 * ceilings. `dynamic` and `saturate` deliberately remain unconstrained here:
 * the scheduler's live capacity and defaults decide their effective bound.
 * Speculation and work-stealing have no runtime scheduler implementation yet,
 * so they are intentionally not mapped.
 */
export function toUserParallelismPolicy(policy?: ParallelismPolicy): UserParallelismPolicy {
	if (!policy) return {}

	return {
		...(numericCeiling(policy.maxLive) !== undefined ? { maxLive: numericCeiling(policy.maxLive) } : {}),
		...(numericCeiling(policy.maxRunnable) !== undefined
			? { maxDispatched: numericCeiling(policy.maxRunnable) }
			: {}),
		...(numericCeiling(policy.readerSwarm) !== undefined
			? { maxReaderSwarm: numericCeiling(policy.readerSwarm) }
			: {}),
	}
}

function numericCeiling(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined
	return Math.floor(value)
}
