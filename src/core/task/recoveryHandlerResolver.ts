// RecoveryHandlerResolver — the pure resolution that selects a
// Large_Context_Recovery_Handler (a window-sufficient handler, preferring a
// configured large-context condensing profile) or, when no candidate is
// window-sufficient, reports the Deterministic_Reduction path. Selection is a
// property of the required recovery-input size versus the candidate windows,
// NOT of the failing lane's Served_Context_Window — which is intentionally not
// part of this module's input (Req 1.2). This module performs no I/O and
// embeds no fixed context-window literal; every window is OmniRoute-owned and
// passed in by the caller.

/**
 * A candidate handler through which a recovery (summarization) call could run.
 *
 * The candidate set is seeded by the caller from `getCondensingApiHandler()`'s
 * resolved profile plus the task's own handler; this module never resolves a
 * handler, window, or reserve itself.
 */
export interface RecoveryHandlerCandidate {
	/** Opaque id for telemetry; never a model/GPU identity branch target. */
	id: string
	/**
	 * The candidate's context window (OmniRoute-owned), from its resolved
	 * route/model info. Combined with `outputReserve` to derive the candidate's
	 * Recovery_Input_Bound.
	 */
	contextWindow: number
	/**
	 * The candidate's Output_Reserve, so its
	 * Recovery_Input_Bound = `contextWindow − outputReserve` (Req 4.3).
	 */
	outputReserve: number
	/** True iff this candidate is the configured large-context condensing profile (Req 1.5). */
	configuredLargeContextProfile: boolean
}

/**
 * The resolution outcome: either a window-sufficient
 * Large_Context_Recovery_Handler, or the Deterministic_Reduction path.
 */
export interface RecoveryHandlerResolution {
	/** "large-context" when a window-sufficient handler was found; "deterministic" otherwise (Req 1.3). */
	path: "large-context" | "deterministic"
	/** The chosen handler id, present iff `path === "large-context"`. */
	handlerId?: string
	/**
	 * The chosen handler's Recovery_Input_Bound (`contextWindow − outputReserve`),
	 * present iff `path === "large-context"` (Req 4.1, 4.3). The summarizer input
	 * must be bounded to at or below this value.
	 */
	recoveryInputBound?: number
}

/**
 * Input to {@link resolveRecoveryHandler}.
 *
 * The failing lane's Served_Context_Window is intentionally NOT part of this
 * input (Req 1.2): recovery-handler selection is independent of the lane the
 * Failing_Task is trying to escape.
 */
export interface RecoveryHandlerResolverInput {
	/** Minimum input the recovery call must carry (the current transcript token count). */
	requiredRecoveryInput: number
	/** Candidate handlers; the failing lane's window is intentionally NOT part of this input (Req 1.2). */
	candidates: readonly RecoveryHandlerCandidate[]
}

/**
 * Chooses a Large_Context_Recovery_Handler whose Recovery_Input_Bound
 * (`contextWindow − outputReserve`) is at or above `requiredRecoveryInput`
 * (Req 1.1), preferring the configured large-context profile among the
 * qualifying candidates (Req 1.5) and otherwise the one with the largest bound.
 * When no candidate qualifies, returns the Deterministic_Reduction path
 * (Req 1.3). A handler whose bound is below the required input is never
 * returned (Req 1.4).
 *
 * Pure: performs no I/O and consults no failing-lane window (Req 1.2).
 */
export function resolveRecoveryHandler(input: RecoveryHandlerResolverInput): RecoveryHandlerResolution {
	const { requiredRecoveryInput, candidates } = input

	let chosen: RecoveryHandlerCandidate | undefined
	let chosenBound = 0

	for (const candidate of candidates) {
		const bound = candidate.contextWindow - candidate.outputReserve

		// A Large_Context_Recovery_Handler must be able to carry the required
		// recovery input; a handler whose bound is below it is never eligible (Req 1.4).
		if (bound < requiredRecoveryInput) {
			continue
		}

		if (chosen === undefined) {
			chosen = candidate
			chosenBound = bound
			continue
		}

		// Prefer a configured large-context profile over a non-configured one (Req 1.5).
		if (candidate.configuredLargeContextProfile && !chosen.configuredLargeContextProfile) {
			chosen = candidate
			chosenBound = bound
			continue
		}

		if (chosen.configuredLargeContextProfile && !candidate.configuredLargeContextProfile) {
			continue
		}

		// Within the same profile-preference tier, prefer the largest bound.
		if (bound > chosenBound) {
			chosen = candidate
			chosenBound = bound
		}
	}

	if (chosen === undefined) {
		return { path: "deterministic" }
	}

	return { path: "large-context", handlerId: chosen.id, recoveryInputBound: chosenBound }
}
