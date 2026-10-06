// Consume RouteCapability read-only from the elastic-parallel-execution types.
// This module never redefines or widens the enum (Req 2.4); if the sibling type
// is ever removed from the tree, replace this import with a single local
// structural alias here and consume it only — never introduce model/GPU identity.
import type { RouteCapability } from "./elasticTypes"

/**
 * The four Menagerie capability lanes as semantic role identifiers (Req 1.1).
 *
 * A `CapabilityLane` names the *kind of cognitive work* a model performs, not a
 * model, size, quantization, or GPU. OmniRoute owns the lane→model/hardware
 * resolution, so Menagerie's lane logic never branches on physical identity
 * (Req 1.2, 1.3, 1.4, 2.5).
 */
export type CapabilityLane = "reader.fast" | "reader.deep" | "coder.primary" | "reasoning.escalation"

/** The four lanes as an exhaustive, ordered role list (Req 1.1). */
export const CAPABILITY_LANES = ["reader.fast", "reader.deep", "coder.primary", "reasoning.escalation"] as const

/**
 * Task-type hint used only to disambiguate coder/reasoning capability. It never
 * encodes model identity, size, quantization, or hardware (Req 1.2).
 */
export type LaneTaskType =
	| "lookup"
	| "implementation"
	| "debugging"
	| "refactor"
	| "test"
	| "architecture"
	| "adjudication"
	| "long-horizon"

/**
 * Total, range-safe mapping from a semantic lane role onto the existing
 * `RouteCapability` vocabulary (elastic-parallel-execution). Readers always map
 * to `"reader"`; `coder.primary` maps to `"reasoner"` or `"general"` by task
 * type; `reasoning.escalation` maps to `"long-context"` or `"reasoner"` by task
 * type. The function switches ONLY on lane role and task type — no model name,
 * size, quantization, or GPU identity ever participates (Req 2.1–2.4).
 */
export function laneToRouteCapability(lane: CapabilityLane, type: LaneTaskType): RouteCapability {
	switch (lane) {
		case "reader.fast":
		case "reader.deep":
			return "reader"
		case "coder.primary":
			// Code reasoning → "reasoner"; mechanical/general edits → "general".
			return type === "implementation" || type === "debugging" || type === "refactor" ? "reasoner" : "general"
		case "reasoning.escalation":
			// System-wide / long-horizon → "long-context"; adjudication/decision → "reasoner".
			return type === "long-horizon" || type === "architecture" ? "long-context" : "reasoner"
	}
}
