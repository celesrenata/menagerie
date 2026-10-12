// ReaderReadBudget — the pure arithmetic that makes a Reader_Worker's
// cumulative read-input budget coherent with the Served_Context_Window of its
// assigned Capability_Lane (Reader_Read_Budget_Coherence, Req 14).
//
// A reader worker already accumulates read-input bytes in
// `Task.readInputBytesConsumed` (the "Lever 2" per-worker budget signal owned by
// `elastic-parallel-execution`, incremented by `ReadFileTool`). The defect this
// module fixes is that that budget was NOT coherent with the reader lane's
// Served_Context_Window: a `reader.fast` worker on a 32768-token lane could
// ingest ~10× its window of read-input before a turn boundary forced
// condensation. This module makes the read-input bound a pure function of the
// lane's Served_Context_Window.
//
// SOURCE OF TRUTH for the window value: OmniRoute's `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`,
// resolved by `resolveOmniRouteContextWindow` in `src/api/providers/omniroute.ts`.
// This module embeds NO fixed context-window literal and NO per-lane byte/token
// size as the bound — the window is OmniRoute-owned and always passed in by the
// caller, kept in lockstep with that resolver exactly as `servableBudget.ts`
// does for the recovery target (Req 14.2, 14.4, 14.5). It never reads a GPU,
// VRAM, or model identity — only the lane role and the OmniRoute-owned window
// value. The module performs no I/O (Req 14.1).

/**
 * Inputs to the coherent read-input budget computation.
 *
 * Every quantity is supplied by the caller — this module never resolves a
 * window, a consumed-byte count, or a fallback itself, keeping it pure and
 * testable in isolation. The lane window is sourced by the caller from
 * `resolveOmniRouteContextWindow`.
 */
export interface ReaderReadBudgetInput {
	/**
	 * The Served_Context_Window for the reader's lane, in tokens, sourced by the
	 * caller from `resolveOmniRouteContextWindow`. An OmniRoute-owned property
	 * that is never hard-coded here. `undefined` ⇒ unknown/new route (Req 14.2,
	 * 14.6).
	 */
	servedContextWindow: number | undefined
	/**
	 * Cumulative read-input already consumed by this reader worker, in bytes —
	 * the `Task.readInputBytesConsumed` "Lever 2" signal owned by
	 * `elastic-parallel-execution`.
	 */
	readInputConsumed: number
	/**
	 * Fraction of the lane window a reader's cumulative read-input may occupy
	 * before the bound engages. A role-level coherence coefficient (≤ 1 by
	 * construction), NOT a fixed per-lane size (Req 14.2).
	 */
	windowFraction: number
	/**
	 * Approximate bytes-per-token used to express the token-denominated lane
	 * window as a read-input (byte) bound.
	 */
	bytesPerToken: number
	/**
	 * The default per-worker read-input budget, in bytes, to fall back to when
	 * the lane window is unknown — the `DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES`
	 * owned by `elastic-parallel-execution`, passed in by the caller (Req 14.6).
	 */
	fallbackBudget: number
}

/**
 * The outcome of a read-budget evaluation. `bound` is the coherent read-input
 * bound derived for the reader's lane; `reasons` carries coherence tags only
 * (lane role, window-known/unknown) — never a model, GPU, or VRAM identity.
 *
 * The action states the WHAT at the reader-ingestion boundary — keep reading,
 * bound further reads, or summarize-and-conclude — and leaves the HOW to the
 * Lever-2 read path in `ReadFileTool` and the reader lifecycle (Req 14.3).
 */
export type ReaderReadBudgetOutcome =
	| { action: "within-budget"; bound: number; reasons: string[] }
	| { action: "bound-reads"; bound: number; reasons: string[] } // Req 14.3
	| { action: "summarize-and-conclude"; bound: number; reasons: string[] } // Req 14.3

/**
 * The fraction of the window-derived bound at or beyond which the reader is
 * directed to summarize-and-conclude rather than merely bound further reads.
 * Expressed as a multiple of the coherent bound so it, too, tracks the lane
 * window and encodes no fixed size.
 */
const SUMMARIZE_AND_CONCLUDE_OVERRUN_FACTOR = 1.5

/**
 * Derives the coherent read-input bound from the lane window and reports whether
 * the reader's cumulative read-input is within it, must bound further reads, or
 * should summarize-and-conclude.
 *
 * The bound is `windowFraction * servedContextWindow * bytesPerToken` when the
 * window is a known number (a monotonically non-decreasing function of the lane
 * Served_Context_Window alone, holding `windowFraction`/`bytesPerToken` fixed),
 * and `fallbackBudget` when the window is `undefined` (Req 14.1, 14.2, 14.6).
 *
 * Pure and synchronous: every input is passed in, the window is OmniRoute-owned
 * and never hard-coded, and the function reads no GPU/VRAM/model identity and
 * performs no I/O. It states the WHAT at the boundary; it does not choose or
 * implement the stop/summarize mechanism (Req 14.3).
 */
export function evaluate(input: ReaderReadBudgetInput): ReaderReadBudgetOutcome {
	const { servedContextWindow, readInputConsumed, windowFraction, bytesPerToken, fallbackBudget } = input

	const windowKnown = typeof servedContextWindow === "number"

	// Window known ⇒ bound derived purely from the OmniRoute-owned lane window.
	// Window unknown ⇒ fall back to the per-worker Lever-2 default (Req 14.6).
	const bound = windowKnown ? windowFraction * servedContextWindow * bytesPerToken : fallbackBudget

	const reasons: string[] = ["reader-lane", windowKnown ? "window-known" : "window-unknown-fallback"]

	if (readInputConsumed <= bound) {
		return { action: "within-budget", bound, reasons }
	}

	// Over the coherent bound: a modest overrun bounds further reads; a larger
	// overrun directs the reader to summarize-and-conclude. Both thresholds
	// track the window-derived bound, so neither encodes a fixed size (Req 14.3).
	if (readInputConsumed >= bound * SUMMARIZE_AND_CONCLUDE_OVERRUN_FACTOR) {
		return { action: "summarize-and-conclude", bound, reasons: [...reasons, "read-input-exceeds-bound"] }
	}

	return { action: "bound-reads", bound, reasons: [...reasons, "read-input-exceeds-bound"] }
}
