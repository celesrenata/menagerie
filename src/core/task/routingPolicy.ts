import type { CapabilityLane, LaneTaskType } from "./capabilityLanes"
import { laneToRouteCapability } from "./capabilityLanes"
import type { RoutingMetadata } from "./routingMetadata"
// Consume RouteCapability/RouteCapacity read-only from the elastic-parallel-execution
// types. This module never redefines, widens, or writes those shapes, and it never
// derives model/GPU identity from a capacity snapshot (Req 13.1, 13.2).
import type { RouteCapability, RouteCapacity } from "./elasticTypes"

/**
 * The input a {@link RoutingPolicy} reads to select a {@link CapabilityLane}. It
 * carries task characteristics, prior-result confidence, failure history,
 * context size, a read-only capacity snapshot, residency/latency/queue signals,
 * an optional explicit lane request, and the loop-detector signal.
 *
 * None of these fields names a model, size, quantization, or GPU — the policy
 * branches only on semantic role and task characteristics so OmniRoute can remap
 * a lane without changing routing logic (Req 1.2, 1.3, 2.5, 9.2, 13.1).
 */
export interface RoutingContext {
	/** The kind of cognitive work this unit of work needs. */
	taskType: LaneTaskType
	/** Caller-estimated complexity, 0..1. */
	estimatedComplexity: number
	/** Confidence/ambiguities/etc. from a prior worker's {@link RoutingMetadata}. */
	priorMetadata?: RoutingMetadata
	/** Count of prior `coder.primary` failures for this task. */
	previousFailures: number
	/** How much repository context the work spans. */
	contextRequirement: "small" | "large" | "system-wide"
	/** Read-only capacity snapshot from `RouteCapacityProvider` (no GPU identity). */
	capacity: readonly RouteCapacity[]
	/** Whether a model for the candidate capability is already resident. */
	modelResident: boolean
	/** Caller latency budget, if any. */
	latencyBudget?: "tight" | "normal" | "relaxed"
	/** Scheduler/route queue pressure, 0..1. */
	queuePressure: number
	/** A lane the parent explicitly asks for; honoured as a direct assignment. */
	explicitLaneRequest?: CapabilityLane
	/** The `ProgressAwareLoopDetector` signal, if available. */
	loopSignal?: "none" | "cyclic" | "hard-stop"
}

/**
 * The lane assignment the policy produces for one unit of work. `lane` is the
 * lane work is assigned to *now* (always the first lane in `pattern`); `pattern`
 * is the ordered lane sequence the policy intends for the task, for
 * observability and tests. `reasons` carries trigger/pattern tags only — never a
 * model, size, quantization, or GPU identity (Req 1.2, 13.1).
 */
export interface RoutingDecision {
	/** The lane this unit of work is assigned to now (first lane in `pattern`). */
	lane: CapabilityLane
	/** The resolved `RouteCapability` for the scheduler/OmniRoute. */
	capability: RouteCapability
	/** The ordered lane pattern the policy intends for this task. */
	pattern: CapabilityLane[]
	/** Rationale tags (trigger names, pattern name, "direct-assignment") only. */
	reasons: string[]
}

/**
 * A pure, synchronous lane-selection policy. It reads a {@link RoutingContext}
 * and returns a {@link RoutingDecision} without performing any I/O — capacity,
 * failure history, and loop signals are passed in — which keeps it unit- and
 * property-testable (design §RoutingPolicy).
 */
export interface RoutingPolicy {
	/** Pure, synchronous. Selects the lane without forcing a sequential ladder (Req 9). */
	decide(ctx: RoutingContext): RoutingDecision
}

/** Confidence at or below this reads as "low" and biases toward deeper investigation. */
const LOW_CONFIDENCE_THRESHOLD = 0.5
/** Complexity at or above this reads as an architectural/high-capability-planning task. */
const ARCHITECTURAL_COMPLEXITY_THRESHOLD = 0.8
/** Prior `coder.primary` failures at or above this read as "repeated failure". */
const REPEATED_FAILURE_THRESHOLD = 2

/**
 * The five example routing patterns the policy encodes (Req 9.3–9.7). Each names
 * the ordered lane sequence the policy intends for a task shape; the lane
 * assigned *now* is always the first entry. These are intents, not a mandatory
 * ladder — a lookup never touches the deeper lanes, and a direct assignment
 * begins at the indicated lane (Req 9.1, 9.8).
 */
const PATTERN_SIMPLE_LOOKUP: readonly CapabilityLane[] = ["reader.fast"]
const PATTERN_NORMAL_IMPLEMENTATION: readonly CapabilityLane[] = ["reader.fast", "coder.primary"]
const PATTERN_AMBIGUOUS_INVESTIGATION: readonly CapabilityLane[] = ["reader.fast", "reader.deep", "coder.primary"]
const PATTERN_ARCHITECTURAL_PROBLEM: readonly CapabilityLane[] = ["reasoning.escalation", "reader.fast", "coder.primary"]
const PATTERN_REPEATED_FAILURE: readonly CapabilityLane[] = [
	"reader.fast",
	"coder.primary",
	"coder.primary",
	"reasoning.escalation",
]

/**
 * The direct-assignment pattern for an explicit lane request: begin at the
 * requested lane and skip every intermediate lane (Req 9.8). A reader lane that
 * is directly requested still carries its natural downstream `coder.primary`
 * follow-up so the pattern remains a useful intent; a `coder.primary` or
 * `reasoning.escalation` request begins — and the pattern consists solely — at
 * that lane, because nothing intermediate precedes it.
 */
function directAssignmentPattern(lane: CapabilityLane): CapabilityLane[] {
	switch (lane) {
		case "reader.fast":
			return ["reader.fast", "coder.primary"]
		case "reader.deep":
			return ["reader.deep", "coder.primary"]
		case "coder.primary":
			return ["coder.primary"]
		case "reasoning.escalation":
			return ["reasoning.escalation"]
	}
}

/**
 * Select the ordered lane pattern for a context from task type, complexity,
 * prior confidence, failures, context requirement, and loop signal. This is the
 * core "not a mandatory ladder" selection: a lookup collapses to a single lane,
 * an architectural problem begins at `reasoning.escalation`, and repeated
 * failure routes toward adjudication (Req 9.1–9.7).
 */
function selectPattern(ctx: RoutingContext, reasons: string[]): CapabilityLane[] {
	// Repeated implementation failure routes toward adjudication (Req 9.7).
	if (ctx.previousFailures >= REPEATED_FAILURE_THRESHOLD) {
		reasons.push("repeated-failure")
		return [...PATTERN_REPEATED_FAILURE]
	}

	// A simple repository lookup never touches the deeper lanes (Req 9.3).
	if (ctx.taskType === "lookup") {
		reasons.push("simple-lookup")
		return [...PATTERN_SIMPLE_LOOKUP]
	}

	// An architectural problem needing high-capability planning begins at
	// reasoning.escalation, skipping the reader lanes as the first step (Req 9.6).
	if (ctx.taskType === "architecture" || ctx.estimatedComplexity >= ARCHITECTURAL_COMPLEXITY_THRESHOLD) {
		reasons.push("architectural-planning")
		return [...PATTERN_ARCHITECTURAL_PROBLEM]
	}

	// Ambiguous investigation inserts reader.deep between the fast readers and the
	// coder (Req 9.5). Ambiguity is read from prior-result quality signals —
	// low confidence, conflicting findings, or recorded ambiguities — never from
	// token count.
	if (isAmbiguousInvestigation(ctx, reasons)) {
		return [...PATTERN_AMBIGUOUS_INVESTIGATION]
	}

	// Everything else is a normal implementation: parallel fast reads then coder
	// (Req 9.4).
	reasons.push("normal-implementation")
	return [...PATTERN_NORMAL_IMPLEMENTATION]
}

/**
 * Decide whether a context reads as an ambiguous investigation that warrants a
 * `reader.deep` step. Ambiguity is derived from prior-result quality signals and
 * context breadth, never from token consumption (Req 5.10).
 */
function isAmbiguousInvestigation(ctx: RoutingContext, reasons: string[]): boolean {
	const prior = ctx.priorMetadata
	const lowConfidence = typeof prior?.confidence === "number" && prior.confidence <= LOW_CONFIDENCE_THRESHOLD
	const conflicting = typeof prior?.conflicting_findings === "number" && prior.conflicting_findings > 0
	const ambiguities = typeof prior?.ambiguities === "number" && prior.ambiguities > 0
	const multiSubsystem = ctx.contextRequirement === "system-wide"

	if (lowConfidence) {
		reasons.push("low-confidence")
	}
	if (conflicting) {
		reasons.push("contradictory-evidence")
	}
	if (ambiguities) {
		reasons.push("architectural-ambiguity")
	}
	if (multiSubsystem) {
		reasons.push("multi-subsystem")
	}

	return lowConfidence || conflicting || ambiguities || multiSubsystem
}

/**
 * Resolve the `RouteCapability` for the lane assigned now. Readers always map to
 * `"reader"`; `coder.primary` and `reasoning.escalation` disambiguate by task
 * type via {@link laneToRouteCapability}. The capacity snapshot is read-only
 * context for the caller and never alters the mapping (Req 13.1, 13.2).
 */
function resolveCapability(lane: CapabilityLane, taskType: LaneTaskType): RouteCapability {
	return laneToRouteCapability(lane, taskType)
}

/**
 * Build the lane-selection policy (Req 9). The returned object exposes a pure,
 * synchronous `decide` that performs no I/O: it reads only the passed-in
 * {@link RoutingContext} and returns a {@link RoutingDecision}. The policy is
 * explicitly not a mandatory ladder — simple tasks collapse to one lane, and an
 * explicit request or direct-assignment task shape begins at the indicated lane,
 * skipping intermediate lanes (Req 9.1, 9.8).
 */
export function createRoutingPolicy(): RoutingPolicy {
	return {
		decide(ctx: RoutingContext): RoutingDecision {
			const reasons: string[] = []

			// Honour an explicit lane request as a direct assignment: begin the
			// pattern at the requested lane and skip intermediate lanes (Req 9.8).
			let pattern: CapabilityLane[]
			if (ctx.explicitLaneRequest !== undefined) {
				reasons.push("direct-assignment")
				pattern = directAssignmentPattern(ctx.explicitLaneRequest)
			} else {
				pattern = selectPattern(ctx, reasons)
			}

			// The lane assigned now is always the first lane in the pattern.
			const lane = pattern[0]
			const capability = resolveCapability(lane, ctx.taskType)

			return { lane, capability, pattern, reasons }
		},
	}
}
