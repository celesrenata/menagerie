// ServableBudget — the pure arithmetic that derives the Servable_Input_Budget
// from the OmniRoute-exposed Served_Context_Window and the request's
// Output_Reserve. This module embeds NO fixed context-window literal: the
// window is OmniRoute-owned and always passed in by the caller (Req 2.4). It
// performs no I/O and reads no other quantity (Req 2.1).

/**
 * Inputs to the Servable_Input_Budget computation.
 *
 * Both quantities are supplied by the caller — this module never resolves a
 * window or reserve itself, keeping it pure and testable in isolation.
 */
export interface ServableBudgetInput {
	/**
	 * The Served_Context_Window for the lane, in tokens, sourced by the caller
	 * from `resolveOmniRouteContextWindow` / `modelInfo.contextWindow`. This is
	 * an OmniRoute-owned property and is never hard-coded here (Req 2.4).
	 */
	servedContextWindow: number
	/**
	 * The Output_Reserve for the request, in tokens, sourced by the caller from
	 * `getModelMaxOutputTokens`. Subtracted from the Served_Context_Window so a
	 * subsequent request still fits.
	 */
	outputReserve: number
}

/**
 * Computes the Servable_Input_Budget as
 * `max(0, servedContextWindow − outputReserve)` (Req 2.1) — the maximum input
 * the recovery target may occupy so a subsequent request fits.
 *
 * Pure: the window is OmniRoute-owned and passed in, never hard-coded (Req 2.4);
 * the function performs no I/O and reads no other quantity.
 */
export function computeServableInputBudget(input: ServableBudgetInput): number {
	return Math.max(0, input.servedContextWindow - input.outputReserve)
}
