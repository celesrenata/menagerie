// ContextRecoveryClassifier — the pure decision that maps a recovery outcome
// to either "resume" (retry the request once, now under budget) or a classified
// Terminal_Non_Recoverable_Error that stops auto-retry. It drives whether the
// context-window retry branch in `attemptApiRequest` recurses or halts.
//
// This module performs no I/O and consults no model, lane, or handler: it is a
// total function over the `RecoveryOutcome` union, so it is unit- and
// property-testable in isolation (Req 5.1, 5.2, 5.4).

/**
 * The outcome of a recovery pass, as observed by the caller after running
 * `convergentReduction` (and optionally a summarization) against the servable
 * budget.
 *
 * - `converged`: the transcript is now at or below the budget and the request
 *   can be resumed once.
 * - `non-recoverable`: even the minimal irreducible transcript (the first task
 *   message plus the two newest visible messages, which truncation never
 *   removes) still exceeds the budget — the Req 5.1 terminal condition.
 */
export type RecoveryOutcome =
	| { kind: "converged"; postTokens: number }
	| { kind: "non-recoverable"; irreducibleTokens: number; budget: number }

/**
 * Classification tag for a non-recoverable context-window overflow. Kept
 * distinct from any transient API-failure classification so callers can branch
 * on it and stop retrying rather than treating the overflow as retryable
 * (Req 5.4).
 */
export const CONTEXT_OVERFLOW_NON_RECOVERABLE = "context-window-overflow-non-recoverable" as const

/**
 * The classified terminal error emitted when recovery cannot bring the
 * transcript to or below the servable budget. Carries the measured irreducible
 * size and the budget it exceeded for telemetry and operator diagnosis.
 */
export interface TerminalContextError {
	classification: typeof CONTEXT_OVERFLOW_NON_RECOVERABLE
	irreducibleTokens: number
	budget: number
	message: string
}

/**
 * The decision handed back to the context-window retry branch.
 *
 * `retry: false` means the branch MUST NOT recurse (Req 5.2, 5.5); the
 * accompanying `terminalError` is thrown by a non-worker task and routed to the
 * parallel-worker self-fail path by a worker.
 */
export interface RetryDecision {
	retry: boolean
	terminalError?: TerminalContextError
}

/**
 * Maps a `RecoveryOutcome` to a `RetryDecision`.
 *
 * - A `converged` outcome returns `{ retry: true }` — resume the request once,
 *   now under budget.
 * - A `non-recoverable` outcome returns `{ retry: false, terminalError }` where
 *   `terminalError.classification === CONTEXT_OVERFLOW_NON_RECOVERABLE`,
 *   distinct from a transient API-failure classification (Req 5.4).
 *
 * Pure: performs no I/O.
 */
export function classifyRecoveryOutcome(outcome: RecoveryOutcome): RetryDecision {
	if (outcome.kind === "converged") {
		return { retry: true }
	}

	const terminalError: TerminalContextError = {
		classification: CONTEXT_OVERFLOW_NON_RECOVERABLE,
		irreducibleTokens: outcome.irreducibleTokens,
		budget: outcome.budget,
		message:
			`Context-window overflow is non-recoverable: the minimal irreducible transcript ` +
			`(${outcome.irreducibleTokens} tokens) exceeds the servable input budget (${outcome.budget} tokens).`,
	}

	return { retry: false, terminalError }
}
