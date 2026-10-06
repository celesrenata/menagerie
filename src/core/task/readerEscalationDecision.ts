// Consume RouteCapacity read-only from the elastic-parallel-execution types.
// This module reads cost solely from RouteCapacity fields and never branches on
// GPU, VRAM, CUDA, or any physical device identity (Req 10.8, 13.4).
import type { RouteCapacity } from "./elasticTypes"

import type { CapabilityLane, LaneTaskType } from "./capabilityLanes"
import type { RoutingMetadata } from "./routingMetadata"

/**
 * The eight investigation-quality triggers that can escalate a `reader.fast`
 * task to `reader.deep` (Req 5.2–5.9). Every trigger is a *quality* signal read
 * from `RoutingMetadata`, an explicit parent request, or a caller-derived flag —
 * NEVER token consumption (Req 5.10).
 */
export type ReaderQualityTrigger =
	| "low-confidence"
	| "contradictory-evidence"
	| "multi-subsystem"
	| "unsuccessful-search"
	| "hard-analysis"
	| "architectural-ambiguity"
	| "reader-disagreement"
	| "explicit-request"

/**
 * The default confidence threshold below which a `reader.fast` result is treated
 * as low-confidence (Req 5.2). A `RoutingMetadata.confidence` strictly below this
 * value raises the `low-confidence` quality trigger.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

/**
 * Caller-derived investigation-quality flags that are not representable from
 * `RoutingMetadata` numeric fields alone. The orchestrator sets these when it
 * observes the corresponding condition during the `reader.fast` pass; an absent
 * (or `false`) flag means "not present" (Req 5.4, 5.5, 5.6).
 */
export interface ReaderCallerFlags {
	/** The investigation spans relationships across multiple subsystems (Req 5.4). */
	multiSubsystem?: boolean
	/** Bounded searches completed without finding the target (Req 5.5). */
	unsuccessfulSearch?: boolean
	/** Difficult type, control-flow, or data-flow analysis is required (Req 5.6). */
	hardAnalysis?: boolean
}

/**
 * Resource-cost inputs for a `reader.fast → reader.deep` escalation, expressed
 * purely in `RouteCapacity` terms — no GPU/VRAM identity ever participates
 * (Req 10.8). Because fast and deep readers may share hardware, escalation is a
 * resource-affecting operation and the scheduler weighs these costs (Req 10.1).
 */
export interface EscalationCost {
	/** Time cost of swapping/loading the deep model on shared hardware (Req 10.2). */
	modelSwapLoadLatencyMs: number
	/** True when loading the deep model would interrupt parallel fast capacity (Req 10.3). */
	interruptsParallelFastCapacity: boolean
	/** Count of queued `reader.fast` work the escalation would delay (Req 10.4). */
	queuedFastReaderWork: number
	/** Expected duration of the `reader.deep` task (Req 10.5). */
	expectedDeepTaskMs: number
	/** True when another resident model on different hardware can answer (Req 10.6). */
	alternateHardwareCanAnswer: boolean
	/** The only capacity source consulted — read-only `RouteCapacity` snapshot. */
	capacity: readonly RouteCapacity[]
}

/**
 * Input to {@link ReaderEscalationDecision.decide}. Quality triggers are derived
 * ONLY from `metadata`, `explicitRequest`, and `callerFlags` — never from token
 * count (Req 5.10). `taskType` lets the decision refuse `reader.deep` for
 * implementation work, which belongs to `coder.primary` (Req 5.11).
 */
export interface ReaderEscalationInput {
	/** Prior `reader.fast` routing telemetry; absent fields read as unset (Req 12.5). */
	metadata?: RoutingMetadata
	/** The parent explicitly requested deeper analysis (Req 5.9). */
	explicitRequest: boolean
	/** Caller-observed quality flags not representable from numeric metadata. */
	callerFlags?: ReaderCallerFlags
	/** Resource cost of the escalation, read solely from `RouteCapacity` fields. */
	cost: EscalationCost
	/**
	 * The kind of work under investigation. `reader.deep` is an investigation
	 * lane only; implementation task types never resolve to it (Req 5.11).
	 */
	taskType?: LaneTaskType
}

/**
 * The three outcomes of a reader-escalation decision. `escalate-deep` carries the
 * quality triggers that fired so callers (and tests) can observe why.
 */
export type ReaderEscalationOutcome =
	| { action: "stay-fast"; reasons: string[] }
	| { action: "spawn-another-fast"; reasons: string[] }
	| { action: "escalate-deep"; triggers: ReaderQualityTrigger[]; reasons: string[] }

/**
 * The pure decision surface for `reader.fast → reader.deep` escalation (Req 5,
 * 10). `decide` performs no I/O: capacity and cost are passed in.
 */
export interface ReaderEscalationDecision {
	decide(input: ReaderEscalationInput): ReaderEscalationOutcome
}

/**
 * Task types that are implementation work and therefore never escalate to the
 * investigation-only `reader.deep` lane (Req 5.11). Implementation belongs to
 * `coder.primary`.
 */
const IMPLEMENTATION_TASK_TYPES: ReadonlySet<LaneTaskType> = new Set<LaneTaskType>([
	"implementation",
	"debugging",
	"refactor",
	"test",
])

/**
 * The affordability band required to spawn an additional `reader.fast` worker.
 * Expressed as a lower bound on an affordability score in `[0, 1]`, where higher
 * means cheaper. Spawning another fast reader is cheap, so its bar is low.
 */
const SPAWN_AFFORDABILITY_THRESHOLD = 0.25

/**
 * The affordability band required to escalate `reader.fast → reader.deep`. It is
 * STRICTLY higher than {@link SPAWN_AFFORDABILITY_THRESHOLD} because escalation
 * evicts the fast model on shared hardware, so it demands more headroom
 * (Req 10.7). Together with the monotone-in-cost affordability score this yields
 * a signal band that spawns another fast reader while declining deep escalation.
 */
const DEEP_AFFORDABILITY_THRESHOLD = 0.6

/**
 * Derive the active investigation-quality triggers from quality signals ONLY —
 * `RoutingMetadata`, an explicit parent request, and caller flags. Token count is
 * never consulted (Req 5.10). `explicitRequest` always contributes the
 * `explicit-request` trigger (Req 5.9).
 */
function deriveQualityTriggers(input: ReaderEscalationInput): ReaderQualityTrigger[] {
	const triggers = new Set<ReaderQualityTrigger>()
	const metadata = input.metadata
	const flags = input.callerFlags

	// Low confidence (Req 5.2): a reported confidence strictly below the threshold.
	if (typeof metadata?.confidence === "number" && metadata.confidence < LOW_CONFIDENCE_THRESHOLD) {
		triggers.add("low-confidence")
	}

	// Contradictory evidence / reader disagreement (Req 5.3, 5.8): any conflict.
	if (typeof metadata?.conflicting_findings === "number" && metadata.conflicting_findings > 0) {
		triggers.add("contradictory-evidence")
		triggers.add("reader-disagreement")
	}

	// Architectural ambiguity (Req 5.7): any reported ambiguity.
	if (typeof metadata?.ambiguities === "number" && metadata.ambiguities > 0) {
		triggers.add("architectural-ambiguity")
	}

	// Explicit request (Req 5.9), including a recommended escalation to the deep
	// reader lane carried on the metadata.
	if (input.explicitRequest || metadata?.recommended_escalation === "reader.deep") {
		triggers.add("explicit-request")
	}

	// Caller-derived flags not representable from numeric metadata (Req 5.4–5.6).
	if (flags?.multiSubsystem) {
		triggers.add("multi-subsystem")
	}
	if (flags?.unsuccessfulSearch) {
		triggers.add("unsuccessful-search")
	}
	if (flags?.hardAnalysis) {
		triggers.add("hard-analysis")
	}

	return Array.from(triggers)
}

/** Clamp a numeric value into the inclusive `[0, 1]` range. */
function clamp01(value: number): number {
	if (Number.isNaN(value)) {
		return 0
	}
	return Math.max(0, Math.min(1, value))
}

/**
 * Compute an affordability score in `[0, 1]` from the resource cost — higher
 * means cheaper (more headroom to escalate). The score is non-increasing in
 * every cost dimension, so raising any cost can only lower affordability and thus
 * never makes `escalate-deep` more likely (the monotonicity requirement of
 * Property 7, Req 10.1–10.6). Cost is read solely from the `EscalationCost`
 * fields and the `RouteCapacity` snapshot — never a device identity (Req 10.8).
 */
function affordability(cost: EscalationCost): number {
	// Latency and duration costs are normalized against fixed reference scales so
	// a larger latency/duration lowers affordability monotonically.
	const SWAP_LATENCY_REFERENCE_MS = 60_000
	const DEEP_TASK_REFERENCE_MS = 300_000
	const QUEUE_REFERENCE = 8

	const latencyPenalty = clamp01(Math.max(0, cost.modelSwapLoadLatencyMs) / SWAP_LATENCY_REFERENCE_MS)
	const durationPenalty = clamp01(Math.max(0, cost.expectedDeepTaskMs) / DEEP_TASK_REFERENCE_MS)
	const queuePenalty = clamp01(Math.max(0, cost.queuedFastReaderWork) / QUEUE_REFERENCE)
	const interruptPenalty = cost.interruptsParallelFastCapacity ? 1 : 0

	// Reader-route headroom from the capacity snapshot: more available capacity
	// relative to total raises affordability; higher sustained pressure lowers it.
	// Only `RouteCapacity` fields participate (Req 10.8).
	const readerRoutes = cost.capacity.filter((entry) => entry.capability === "reader")
	let headroom = 0
	let pressurePenalty = 0
	if (readerRoutes.length > 0) {
		const totalCapacity = readerRoutes.reduce((sum, entry) => sum + Math.max(0, entry.capacity), 0)
		const totalAvailable = readerRoutes.reduce((sum, entry) => sum + Math.max(0, entry.available), 0)
		headroom = totalCapacity > 0 ? clamp01(totalAvailable / totalCapacity) : 0
		const pressures = readerRoutes
			.map((entry) => entry.pressure)
			.filter((pressure): pressure is number => typeof pressure === "number")
		if (pressures.length > 0) {
			pressurePenalty = clamp01(Math.max(...pressures))
		}
	}

	// Weighted penalties subtracted from a base derived from headroom. Each weight
	// is non-negative, so every penalty term is monotonically non-increasing in
	// its cost input. A cheaper swap, shorter task, shorter queue, no interruption,
	// an available alternate on other hardware, more headroom, and less pressure
	// all raise the score.
	const alternateBonus = cost.alternateHardwareCanAnswer ? 0 : 0.1
	const raw =
		0.45 +
		0.35 * headroom -
		0.2 * latencyPenalty -
		0.2 * durationPenalty -
		0.15 * queuePenalty -
		0.2 * interruptPenalty -
		0.2 * pressurePenalty -
		alternateBonus

	return clamp01(raw)
}

/**
 * The default confidence-driven, resource-aware reader escalation decision.
 *
 * `decide` returns `escalate-deep` only when a quality trigger is present AND the
 * resource cost clears the deep affordability threshold, which is strictly higher
 * than the spawn-another-fast threshold (Req 10.7). An explicit parent request
 * mandates `escalate-deep` regardless of the cost band (Req 5.9). The decision is
 * monotonic in cost — holding quality fixed, raising any cost never makes
 * `escalate-deep` more likely (Property 7). Implementation task types never
 * resolve to `reader.deep` (Req 5.11). The function is pure: no I/O.
 */
export function createReaderEscalationDecision(): ReaderEscalationDecision {
	return { decide }
}

/**
 * Standalone pure decision matching {@link ReaderEscalationDecision.decide}, so
 * callers may use the factory object or the bare function.
 */
export function decide(input: ReaderEscalationInput): ReaderEscalationOutcome {
	const triggers = deriveQualityTriggers(input)
	const isImplementation = input.taskType !== undefined && IMPLEMENTATION_TASK_TYPES.has(input.taskType)

	// `reader.deep` is an investigation lane only; implementation work belongs to
	// `coder.primary` and is never escalated to deep, even on explicit request
	// (Req 5.11). The deepest available reader response is another fast reader.
	if (isImplementation) {
		if (triggers.length > 0) {
			return {
				action: "spawn-another-fast",
				reasons: ["implementation-task-never-deep", ...triggers],
			}
		}
		return { action: "stay-fast", reasons: ["implementation-task-never-deep"] }
	}

	// No quality trigger: never escalate on cost alone (Req 5.10). High resource
	// cost without a quality signal stays fast.
	if (triggers.length === 0) {
		return { action: "stay-fast", reasons: ["no-quality-trigger"] }
	}

	// Explicit parent request mandates escalation regardless of the cost band
	// (Req 5.9).
	if (triggers.includes("explicit-request")) {
		return { action: "escalate-deep", triggers, reasons: ["explicit-request-mandates-escalation"] }
	}

	// Quality trigger present: escalate only when the resource cost clears the deep
	// threshold, which strictly exceeds the spawn-another-fast threshold (Req 10.7).
	const score = affordability(input.cost)
	if (score >= DEEP_AFFORDABILITY_THRESHOLD) {
		return { action: "escalate-deep", triggers, reasons: ["quality-trigger", "cost-clears-deep-threshold"] }
	}
	if (score >= SPAWN_AFFORDABILITY_THRESHOLD) {
		return {
			action: "spawn-another-fast",
			reasons: ["quality-trigger", "cost-below-deep-threshold", ...triggers],
		}
	}
	return { action: "stay-fast", reasons: ["quality-trigger", "cost-below-spawn-threshold", ...triggers] }
}
