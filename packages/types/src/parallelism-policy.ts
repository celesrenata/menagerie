import { DEFAULT_PARALLELISM_MODE, PARALLELISM_MODES, type ParallelismMode } from "./global-settings.js"

/**
 * A resolved concurrency ceiling (FEAT-011). A ceiling may be a fixed number, or one of
 * two enumerated non-numeric values:
 *   - `"dynamic"`: the mastermind controls the bound (e.g. Auto's runnable/swarm sizes).
 *   - `"saturate"`: sized to saturate useful capacity (MAXIMUM CHAOS reader swarm).
 * These let the `DEFAULT_PARALLELISM_POLICY_TABLE` encode the design table exactly while
 * `resolveParallelismPolicy` remains a total function over the `ParallelismMode` enum.
 */
export type Ceiling = number | "dynamic" | "saturate"

/**
 * The resolved per-mode parallelism ceilings handed to the `BoundedElasticScheduler`
 * (`elastic-parallel-execution`). These are upper bounds, never targets: useful
 * decomposition smaller than a ceiling runs below it, and no filler work is manufactured.
 * This spec resolves the ceilings; enforcement is owned by the scheduler.
 */
export interface ParallelismPolicy {
	/** Maximum number of live workers. */
	maxLive: number
	/** Maximum number of workers runnable at once. */
	maxRunnable: Ceiling
	/** Reader swarm size. */
	readerSwarm: Ceiling
	/** Speculative execution appetite. */
	speculation: "disabled" | "limited" | "enabled" | "mastermind-controlled"
	/** Whether idle workers may steal queued work from busy ones. */
	workStealing: boolean
	/** Whether the mastermind may fan out dynamically beyond the initial decomposition. */
	dynamicFanOut: boolean
}

/**
 * Recommended ceilings for each `ParallelismMode` (FEAT-011 Default_Policy_Table). Each
 * mode maps to exactly one entry; values MAY be tuned later but every mode always resolves
 * to a single defined policy.
 */
export const DEFAULT_PARALLELISM_POLICY_TABLE: Record<ParallelismMode, ParallelismPolicy> = {
	conservative: {
		maxLive: 3,
		maxRunnable: 2,
		readerSwarm: 2,
		speculation: "disabled",
		workStealing: false,
		dynamicFanOut: false,
	},
	balanced: {
		maxLive: 6,
		maxRunnable: 4,
		readerSwarm: 4,
		speculation: "limited",
		workStealing: true,
		dynamicFanOut: false,
	},
	auto: {
		maxLive: 12,
		maxRunnable: "dynamic",
		readerSwarm: "dynamic",
		speculation: "mastermind-controlled",
		workStealing: true,
		dynamicFanOut: true,
	},
	aggressive: {
		maxLive: 10,
		maxRunnable: 8,
		readerSwarm: 4,
		speculation: "enabled",
		workStealing: true,
		dynamicFanOut: true,
	},
	max: {
		maxLive: 12,
		maxRunnable: 12,
		readerSwarm: "saturate",
		speculation: "enabled",
		workStealing: true,
		dynamicFanOut: true,
	},
}

/**
 * Resolve a `ParallelismMode` to its `ParallelismPolicy` ceilings. Total over the enum:
 * every mode maps to its exact `DEFAULT_PARALLELISM_POLICY_TABLE` entry.
 */
export function resolveParallelismPolicy(mode: ParallelismMode): ParallelismPolicy {
	return DEFAULT_PARALLELISM_POLICY_TABLE[mode]
}

/**
 * Coerce an arbitrary value to a `ParallelismMode`, falling back to the
 * `DEFAULT_PARALLELISM_MODE` (`"auto"`) for anything that is not one of the five
 * enum members. Total and non-throwing: `undefined`, numbers, and arbitrary
 * strings all resolve to the default rather than raising.
 */
export function normalizeParallelismMode(value: unknown): ParallelismMode {
	return PARALLELISM_MODES.includes(value as ParallelismMode) ? (value as ParallelismMode) : DEFAULT_PARALLELISM_MODE
}

/**
 * Resolve the effective per-request `ParallelismMode` with precedence
 * envelope → saved default → `"auto"`. The per-request envelope value wins when
 * it is a valid non-`"auto"` member; otherwise the saved default is used when it
 * is a valid member; otherwise the `DEFAULT_PARALLELISM_MODE` (`"auto"`).
 *
 * Normalizing an unset input yields `"auto"`, which would otherwise mask a saved
 * non-`"auto"` default, so a normalized envelope only wins when it is non-`"auto"`;
 * an explicit envelope `"auto"` and an unset envelope are indistinguishable here
 * and both fall through to the saved default (which resolves to `"auto"` when unset).
 */
export function resolveEffectiveParallelismMode(
	envelope: ParallelismMode | undefined,
	savedDefault: ParallelismMode | undefined,
): ParallelismMode {
	const normalizedEnvelope = normalizeParallelismMode(envelope)
	if (normalizedEnvelope !== DEFAULT_PARALLELISM_MODE) {
		return normalizedEnvelope
	}
	return normalizeParallelismMode(savedDefault)
}
