import type { AnalysisOutcome } from "@roo-code/types"

import type { CapabilityLane } from "./capabilityLanes"
import type { ReaderCallerFlags } from "./readerEscalationDecision"
import type { RoutingMetadata } from "./routingMetadata"

/**
 * Work-kind routing for the pure-analysis executor (MEN-GRANITE-SDD-001 R7).
 *
 * This is ADDITIVE and does not alter lane assignment: `reader.fast` keeps its meaning, and no
 * request is remapped. The decision is by work KIND (tool-less transform vs tool-using
 * discovery), so the tool-capable `project-reader` is never replaced by the analysis executor.
 * Physical placement and capacity stay with OmniRoute; this module only consumes a boolean
 * "is the published analysis route usable" supplied by the caller.
 */

export interface AnalysisRouteStatus {
	/** An analysis route/model was published and resolved. */
	published: boolean
	/** Last health probe succeeded. */
	healthy: boolean
}

export interface AnalysisRoutingInput {
	/** Feature flag. Off means exactly the legacy behaviour. */
	enabled: boolean
	/** The work needs file/search/command tools, or writes anything. */
	requiresTools: boolean
	/** The caller cannot proceed without this analysis (strict policy gate). */
	required: boolean
	route: AnalysisRouteStatus
}

export type AnalysisRoutingDecision =
	/** Run the tool-less executor on already-selected evidence. */
	| { executor: "analysis" }
	/** Existing tool-capable project-reader path, lane unchanged. Also the legacy path when disabled. */
	| { executor: "tool-reader"; lane: CapabilityLane; reason: "disabled" | "requires-tools" }
	/** Optional analysis omitted. Always carries a visible cause. */
	| { executor: "skipped"; reason: string }
	/** Required analysis cannot run here: promote to a deeper capable reader. Never fails open. */
	| { executor: "escalate"; lane: CapabilityLane; reason: string }

export function selectAnalysisExecutor(input: AnalysisRoutingInput): AnalysisRoutingDecision {
	if (!input.enabled) return { executor: "tool-reader", lane: "reader.fast", reason: "disabled" }
	if (input.requiresTools) return { executor: "tool-reader", lane: "reader.fast", reason: "requires-tools" }

	if (input.route.published && input.route.healthy) return { executor: "analysis" }

	const cause = !input.route.published ? "no analysis route published" : "analysis route unhealthy"
	return input.required ? { executor: "escalate", lane: "reader.deep", reason: cause } : { executor: "skipped", reason: cause }
}

/**
 * Map an analysis outcome to the quality signals the EXISTING `readerEscalationDecision.decide`
 * already understands (low confidence, conflicts, ambiguity, hard analysis). Infrastructure
 * failures (down, timeout, 429, queue full, cancelled) are not quality signals and produce
 * none: the caller handles them as skip/escalate via {@link selectAnalysisExecutor}.
 */
export function analysisOutcomeToEscalationSignals(outcome: AnalysisOutcome): {
	metadata: RoutingMetadata
	callerFlags: ReaderCallerFlags
} {
	const metadata: RoutingMetadata = {}
	const callerFlags: ReaderCallerFlags = {}

	if (outcome.kind === "valid") {
		const confidences = outcome.findings.flatMap((f) => (typeof f.confidence === "number" ? [f.confidence] : []))
		if (confidences.length > 0) metadata.confidence = Math.min(...confidences)
		if (outcome.operation === "find-contradictions" && outcome.findings.length > 0) {
			metadata.conflicting_findings = outcome.findings.length
		}
		// Suppressed/ungrounded claims and explicit unknowns mean the evidence did not settle the question.
		if (outcome.unknowns.length > 0) metadata.ambiguities = outcome.unknowns.length
		if (outcome.risk === "high") callerFlags.hardAnalysis = true
	} else if (outcome.kind === "oversize" || outcome.kind === "invalid-schema" || outcome.kind === "non-json") {
		// The bounded executor could not produce a usable answer for this material.
		callerFlags.hardAnalysis = true
	} else if (outcome.kind === "stale-evidence") {
		callerFlags.unsuccessfulSearch = true
	}
	return { metadata, callerFlags }
}
