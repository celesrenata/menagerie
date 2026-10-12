// Consume WorkerResult read-only from the mastermind-execution-metadata types
// (exported from @roo-code/types, as the sibling module routingMetadata.ts
// does). This module never modifies, removes, or widens any base WorkerResult
// field — RecoveryTelemetry is purely additive (Req 6.5).
import type { WorkerResult } from "@roo-code/types"

import { CONTEXT_OVERFLOW_NON_RECOVERABLE } from "./contextRecoveryClassifier"

/**
 * The machine-readable record of a single recovery attempt (Req 6.1, 6.2, 6.3).
 *
 * `path` names which recovery path was taken: `large-context` runs the
 * summarization on a window-sufficient Large_Context_Recovery_Handler (and
 * names it via `handlerId`), while `deterministic` is the model-free,
 * lane-free Deterministic_Reduction fallback (which omits `handlerId`).
 * `preTokens`/`postTokens` are the measured transcript sizes around the
 * reduction, with `postTokens ≤ preTokens`. `terminal` is set only on the
 * attempt that declares a Terminal_Non_Recoverable_Error (Req 6.4).
 */
export interface RecoveryAttemptTelemetry {
	/** Which path recovery took for this attempt (Req 6.2). */
	path: "large-context" | "deterministic"
	/** Chosen recovery handler id when path === "large-context" (Req 6.2). */
	handlerId?: string
	/** Transcript token sizes around the reduction (Req 6.3); postTokens ≤ preTokens. */
	preTokens: number
	postTokens: number
	/** Set on the attempt that declares a Terminal_Non_Recoverable_Error (Req 6.4). */
	terminal?: { classification: typeof CONTEXT_OVERFLOW_NON_RECOVERABLE }
}

/**
 * The aggregated recovery telemetry for a worker (Req 6.1). One entry per
 * recovery attempt; an absent `recovery` block on the worker result reads as
 * "no recovery occurred" rather than an error.
 */
export interface RecoveryTelemetry {
	/** One entry per recovery attempt (Req 6.1). */
	attempts: RecoveryAttemptTelemetry[]
}

/**
 * The extended worker result carrying additive-optional recovery telemetry.
 * The base `WorkerResult` contract is unchanged; `recovery` is optional so an
 * absent `recovery` (or any absent attempt sub-field) reads as unset, never an
 * error (Req 6.5). The telemetry is attached to the worker result only and is
 * never injected verbatim into the parent model's conversation history
 * (Req 6.6).
 */
export interface WorkerResultWithRecovery extends WorkerResult {
	recovery?: RecoveryTelemetry
}

/**
 * Typed, total reader for the `recovery` telemetry block. Returns `undefined`
 * for an absent `recovery` field (or an absent result) without throwing,
 * mirroring the sibling `readRoutingField` discipline in `routingMetadata.ts`
 * so downstream consumers treat missing telemetry as "unset" rather than an
 * error (Req 6.5).
 */
export function readRecoveryTelemetry(result: WorkerResultWithRecovery | undefined): RecoveryTelemetry | undefined {
	return result?.recovery
}
