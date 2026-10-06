import {
	mapNormalizedToExtended,
	type ReasoningEffortExtended,
	type VerificationPolicy,
	type WorkerReasoningPolicy,
} from "@roo-code/types"

import type { ParallelTaskSpec } from "../tools/ParallelTasksTool"

/** The latency/balanced/quality bias carried on a worker reasoning policy. */
type WorkerReasoningPriority = NonNullable<WorkerReasoningPolicy["priority"]>

/**
 * CognitionMetadataEnvelope
 *
 * The normalized cognition intent the mastermind hands to the OmniRoute boundary.
 * Per design §"Normalized reasoning enum maps to the extended enum at the OmniRoute
 * boundary" and Requirements 4.1/4.2/15.1/15.2 — "GLM schedules cognition; OmniRoute
 * schedules silicon" — this envelope carries ONLY normalized cognition fields:
 *
 *   - `reasoningEffort`: the requested effort mapped through `mapNormalizedToExtended`
 *     into the vocabulary OmniRoute already understands (`reasoningEffortsExtended`).
 *   - `maxReasoningEffort`: the escalation ceiling, likewise mapped, when supplied.
 *   - `priority`: the mastermind's latency/balanced/quality bias, when supplied.
 *   - `adaptive`: whether the worker may escalate reasoning within the ceiling.
 *   - `verification`: the verification policy (required/mode/criteria), when supplied.
 *   - `executionIntent`: the worker's role/mode — a cognition concern (what kind of
 *     work), never a placement concern (which GPU/node).
 *
 * It deliberately holds NO provider/model-capability keys (no `apiProvider`, no
 * `enableReasoningEffort`, no thinking-tokens, no service tier) and NO physical
 * placement (GPU/VRAM/CUDA device/node). OmniRoute performs that translation and
 * resolves placement, gated by `shouldUseReasoningEffort` per model. Menagerie only
 * maps normalized → extended so OmniRoute receives a value from its own vocabulary;
 * it does not pick the provider knob.
 */
export interface CognitionMetadataEnvelope {
	readonly reasoningEffort?: ReasoningEffortExtended
	readonly maxReasoningEffort?: ReasoningEffortExtended
	readonly priority?: WorkerReasoningPriority
	readonly adaptive?: boolean
	readonly verification?: VerificationPolicy
	readonly executionIntent: string
}

/**
 * Build the cognition-metadata envelope from a worker's reasoning policy.
 *
 * Pure: maps the normalized reasoning intent (and optional ceiling) through
 * `mapNormalizedToExtended`, and carries the priority/adaptive bias verbatim. Does
 * not translate to provider/model capabilities and does not resolve placement.
 */
function carryReasoningIntent(
	policy: WorkerReasoningPolicy | undefined,
): Pick<CognitionMetadataEnvelope, "reasoningEffort" | "maxReasoningEffort" | "priority" | "adaptive"> {
	if (!policy) return {}
	return {
		reasoningEffort: mapNormalizedToExtended(policy.effort),
		...(policy.maxEffort !== undefined ? { maxReasoningEffort: mapNormalizedToExtended(policy.maxEffort) } : {}),
		...(policy.priority !== undefined ? { priority: policy.priority } : {}),
		...(policy.adaptive !== undefined ? { adaptive: policy.adaptive } : {}),
	}
}

/**
 * Carry a parallel worker spec's normalized cognition intent to the OmniRoute
 * boundary as a cognition-metadata envelope (Requirements 4.1, 4.2, 15.1, 15.2).
 *
 * The mastermind expresses cognition (reasoning effort, priority, verification
 * policy, execution intent); it does NOT translate into provider/model capabilities
 * and does NOT resolve physical placement. A user-supplied `route` override, when
 * present, pins placement explicitly and is forwarded verbatim OUTSIDE this envelope
 * (placement is OmniRoute's concern, not cognition metadata) — this function never
 * reads `route`, so the envelope can never leak a placement decision.
 *
 * Pure and side-effect free.
 */
export function carryCognitionMetadata(spec: ParallelTaskSpec): CognitionMetadataEnvelope {
	return {
		...carryReasoningIntent(spec.reasoning),
		...(spec.verification !== undefined ? { verification: spec.verification } : {}),
		// `mode` is the worker's role/kind of work — a cognition concern, not placement.
		executionIntent: spec.mode,
	}
}
