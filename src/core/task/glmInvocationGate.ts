// The GLM dual-role invocation gate decides whether the scarce
// `reasoning.escalation` lane (GLM-5.3) should be invoked for a given unit of
// work, and if so in which role. It is a pure, synchronous function: capacity,
// failure history, and the loop-detector signal are all passed in, so the gate
// performs no I/O (Req 7.1–7.3, 8.1–8.10, 13.3).
import type { RoutingMetadata } from "./routingMetadata"

/**
 * Planning / orchestration triggers (Req 7.1, 7.2). When present, GLM-5.3 is
 * invoked to decompose work, assign reader scopes, define constraints, or
 * synthesize findings.
 */
export type GlmPlanningTrigger = "complex-decomposition" | "scope-assignment" | "constraint-definition" | "synthesis"

/**
 * Escalation / adjudication triggers (Req 8.1–8.8). When present, GLM-5.3 is
 * invoked to recover from failures, resolve reader disagreement, or adjudicate
 * architectural uncertainty.
 */
export type GlmAdjudicationTrigger =
	| "repeated-coder-failure" // Req 8.1
	| "reader-disagreement" // Req 8.2
	| "bug-vs-architecture-conflict" // Req 8.3
	| "system-wide-reasoning" // Req 8.4
	| "cross-subsystem-design" // Req 8.5
	| "coder-low-confidence" // Req 8.6
	| "architectural-uncertainty-despite-passing-tests" // Req 8.7
	| "loop-detector-cyclic" // Req 8.8

/**
 * Inputs to the gate. All signals are passed in so the gate stays pure:
 * `metadata` carries the latest worker telemetry, `previousFailures` the count
 * of consecutive `coder.primary` failures, `loopSignal` the loop-detector
 * verdict, and `complexity`/`contextRequirement` the planning signals.
 */
export interface GlmInvocationInput {
	metadata?: RoutingMetadata
	previousFailures: number
	loopSignal: "none" | "cyclic" | "hard-stop"
	complexity: number // 0..1
	contextRequirement: "small" | "large" | "system-wide"
}

/**
 * The gate's decision. `invoke: false` carries human-readable `reasons`
 * explaining why GLM was withheld, preserving the GLM scarcity invariant
 * (Req 7.3, 8.9, 8.10). An `invoke: true` decision names the role and the
 * triggers that fired, and the triggers list is always non-empty.
 */
export type GlmInvocationDecision =
	| { invoke: false; reasons: string[] }
	| { invoke: true; role: "planning"; triggers: GlmPlanningTrigger[] }
	| { invoke: true; role: "adjudication"; triggers: GlmAdjudicationTrigger[] }

/** The pure gate interface (design `GlmInvocationGate`). */
export interface GlmInvocationGate {
	/** Invokes reasoning.escalation only when a planning or adjudication trigger is present. */
	evaluate(input: GlmInvocationInput): GlmInvocationDecision
}

/**
 * `coder.primary` is considered to be in repeated failure once at least two
 * attempts have failed (Req 8.1). A single failure is handled by a normal
 * `coder.primary` retry and does not warrant the scarce reasoning lane.
 */
const REPEATED_FAILURE_THRESHOLD = 2

/**
 * Confidence at or below this value is treated as `coder.primary` reporting low
 * confidence in its result (Req 8.6). Confidence is a 0..1 quality signal from
 * `RoutingMetadata`, never a token count.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.4

/**
 * Complexity at or above this value is sufficiently complex to benefit from
 * high-capability decomposition (Req 7.1). Below it, lower-capability lanes
 * handle planning and GLM is not required (Req 7.3).
 */
const COMPLEX_DECOMPOSITION_THRESHOLD = 0.7

/**
 * Derive the adjudication triggers from the machine-readable signals. Each
 * trigger is read from a distinct source — worker telemetry
 * (`RoutingMetadata`), failure history (`previousFailures`), or the
 * loop-detector signal — and a missing signal reads as "trigger not present"
 * rather than an error (Req 12.5).
 */
function deriveAdjudicationTriggers(input: GlmInvocationInput): GlmAdjudicationTrigger[] {
	const triggers: GlmAdjudicationTrigger[] = []
	const metadata = input.metadata

	// Req 8.1 — repeated coder failure from failure history.
	if (input.previousFailures >= REPEATED_FAILURE_THRESHOLD) {
		triggers.push("repeated-coder-failure")
	}

	// Req 8.2 — material reader disagreement surfaces as conflicting findings.
	if ((metadata?.conflicting_findings ?? 0) > 0) {
		triggers.push("reader-disagreement")
	}

	// Req 8.3 — a reader-flagged bug-vs-architecture conflict is carried in
	// `failure_class`; absent class reads as "no conflict".
	if (metadata?.failure_class === "bug-vs-architecture-conflict") {
		triggers.push("bug-vs-architecture-conflict")
	}

	// Req 8.4 — system-wide reasoning spanning many subsystems.
	if (input.contextRequirement === "system-wide") {
		triggers.push("system-wide-reasoning")
	}

	// Req 8.5 — a design decision spanning many subsystems. Surfaced as
	// unresolved ambiguities over a large/system-wide context.
	if ((metadata?.ambiguities ?? 0) > 0 && input.contextRequirement !== "small") {
		triggers.push("cross-subsystem-design")
	}

	// Req 8.6 — coder.primary reports low confidence in its result.
	if (metadata?.confidence !== undefined && metadata.confidence <= LOW_CONFIDENCE_THRESHOLD) {
		triggers.push("coder-low-confidence")
	}

	// Req 8.7 — tests pass but architectural correctness remains uncertain.
	if (
		metadata?.tests_run !== undefined &&
		metadata.tests_run > 0 &&
		metadata.tests_passed === metadata.tests_run &&
		(metadata.ambiguities ?? 0) > 0
	) {
		triggers.push("architectural-uncertainty-despite-passing-tests")
	}

	// Req 8.8 — the loop detector flags repeated cyclic behavior.
	if (input.loopSignal === "cyclic" || input.loopSignal === "hard-stop") {
		triggers.push("loop-detector-cyclic")
	}

	// A reader explicitly recommending the escalation lane is itself an
	// adjudication signal (reader-disagreement escalation path, Req 8.2).
	if (metadata?.recommended_escalation === "reasoning.escalation" && !triggers.includes("reader-disagreement")) {
		triggers.push("reader-disagreement")
	}

	return triggers
}

/**
 * Derive the planning triggers from complexity and context requirement
 * (Req 7.1, 7.2). GLM is offered as a planner only when work is sufficiently
 * complex or wide; otherwise lower-capability lanes handle planning (Req 7.3).
 */
function derivePlanningTriggers(input: GlmInvocationInput): GlmPlanningTrigger[] {
	const triggers: GlmPlanningTrigger[] = []

	if (input.complexity >= COMPLEX_DECOMPOSITION_THRESHOLD) {
		triggers.push("complex-decomposition")
		triggers.push("scope-assignment")
		triggers.push("constraint-definition")
	}

	// Large/system-wide work benefits from GLM synthesizing findings across the
	// context, even when raw complexity is moderate (Req 7.2).
	if (input.contextRequirement !== "small" && !triggers.includes("synthesis")) {
		triggers.push("synthesis")
	}

	return triggers
}

/**
 * Evaluate the gate. Returns `invoke: true` if and only if at least one
 * planning or adjudication trigger is present; otherwise `invoke: false` with
 * reasons, so `reasoning.escalation` is never required per task and the
 * GLM scarcity invariant is preserved (Req 7.3, 8.9, 8.10, 13.3).
 *
 * When both planning and adjudication triggers are present, the gate prefers
 * the adjudication role: failure, disagreement, and loop recovery take
 * precedence over fresh planning, because the system is already stuck and
 * recovery is the higher-value use of the scarce reasoning lane.
 */
function evaluate(input: GlmInvocationInput): GlmInvocationDecision {
	const adjudicationTriggers = deriveAdjudicationTriggers(input)
	if (adjudicationTriggers.length > 0) {
		return { invoke: true, role: "adjudication", triggers: adjudicationTriggers }
	}

	const planningTriggers = derivePlanningTriggers(input)
	if (planningTriggers.length > 0) {
		return { invoke: true, role: "planning", triggers: planningTriggers }
	}

	return {
		invoke: false,
		reasons: ["no-planning-trigger", "no-adjudication-trigger", "scarcity-preserved"],
	}
}

/**
 * Factory returning the pure `GlmInvocationGate`. The gate holds no state, so
 * every returned instance shares the same stateless `evaluate` implementation.
 */
export function createGlmInvocationGate(): GlmInvocationGate {
	return { evaluate }
}
