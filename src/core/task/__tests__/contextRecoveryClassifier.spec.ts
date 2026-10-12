// Feature: resilient-context-recovery, Property 7: A non-recoverable outcome stops retry and is classified distinctly from a transient failure
// Feature: resilient-context-recovery, Property 6: Context-window recovery always halts — converge or terminate, never unbounded retry

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import type { ApiMessage } from "../task-persistence/apiMessages"
import { convergentReduction } from "../convergentReduction"
import {
	classifyRecoveryOutcome,
	CONTEXT_OVERFLOW_NON_RECOVERABLE,
	type RecoveryOutcome,
} from "../contextRecoveryClassifier"

// A transient API-failure classification used only to assert the terminal classification is distinct
// from the transient path (Req 5.4). It intentionally does NOT equal CONTEXT_OVERFLOW_NON_RECOVERABLE.
const TRANSIENT_API_FAILURE = "transient-api-failure" as const

/**
 * Arbitrary RecoveryOutcome: either a converged outcome (postTokens ≤ budget) or a non-recoverable
 * outcome whose irreducible core strictly exceeds the budget. The two shapes are the full union the
 * classifier maps over.
 */
const recoveryOutcomeArb: fc.Arbitrary<RecoveryOutcome> = fc.oneof(
	fc.record({
		kind: fc.constant("converged" as const),
		postTokens: fc.nat({ max: 500_000 }),
	}),
	fc
		.record({
			budget: fc.nat({ max: 500_000 }),
			over: fc.integer({ min: 1, max: 500_000 }),
		})
		.map(({ budget, over }) => ({
			kind: "non-recoverable" as const,
			irreducibleTokens: budget + over,
			budget,
		})),
)

describe("classifyRecoveryOutcome — Property 7", () => {
	// Validates: Requirements 5.1, 5.2, 5.4
	it("returns retry:false with a distinctly-classified TerminalContextError iff the outcome is non-recoverable", () => {
		fc.assert(
			fc.property(recoveryOutcomeArb, (outcome) => {
				const decision = classifyRecoveryOutcome(outcome)

				if (outcome.kind === "converged") {
					// A converged outcome resumes the request once; no terminal error (Req 5.2).
					expect(decision.retry).toBe(true)
					expect(decision.terminalError).toBeUndefined()
					return
				}

				// A non-recoverable outcome stops auto-retry with a classified terminal error (Req 5.1, 5.2).
				expect(decision.retry).toBe(false)
				expect(decision.terminalError).toBeDefined()
				const terminal = decision.terminalError!

				// The classification is the non-recoverable context-overflow tag, distinct from a
				// transient API-failure classification (Req 5.4).
				expect(terminal.classification).toBe(CONTEXT_OVERFLOW_NON_RECOVERABLE)
				expect(terminal.classification).not.toBe(TRANSIENT_API_FAILURE)

				// The terminal error carries the measured sizes for telemetry/diagnosis.
				expect(terminal.irreducibleTokens).toBe(outcome.irreducibleTokens)
				expect(terminal.budget).toBe(outcome.budget)
				expect(terminal.irreducibleTokens).toBeGreaterThan(terminal.budget)
			}),
			{ numRuns: 300 },
		)
	})

	// Validates: Requirements 5.1, 5.2 — the biconditional in the other direction.
	it("emits a terminal error only for non-recoverable outcomes and never for converged ones", () => {
		fc.assert(
			fc.property(recoveryOutcomeArb, (outcome) => {
				const decision = classifyRecoveryOutcome(outcome)
				const emittedTerminal = decision.terminalError !== undefined
				const stoppedRetry = decision.retry === false
				const isNonRecoverable = outcome.kind === "non-recoverable"

				// retry:false ⟺ a terminal error ⟺ the outcome is non-recoverable.
				expect(emittedTerminal).toBe(isNonRecoverable)
				expect(stoppedRetry).toBe(isNonRecoverable)
			}),
			{ numRuns: 150 },
		)
	})
})

// ── Property 6: bounded-halt over the composed recovery-and-retry loop ─────────────────────────────

/**
 * Deterministic per-message token weights keyed by message identity, so a faked countTokens over any
 * surviving subset is an exact, model-free sum. Never an LLM call (matches convergentReduction's
 * contract that countTokens is its only external dependency).
 */
function makeDeterministicCountTokens(weights: WeakMap<ApiMessage, number>) {
	return async (messages: ApiMessage[]): Promise<number> =>
		messages.reduce((sum, msg) => sum + (weights.get(msg) ?? 0), 0)
}

/**
 * A fully-visible transcript (no truncation markers / hidden messages) of at least three messages,
 * paired with a parallel per-message token-weight map. Keeping every message visible makes the
 * irreducible core exactly {first message, two newest messages}, which the reduction never removes.
 */
const weightedTranscriptArb = fc
	.array(fc.integer({ min: 1, max: 20_000 }), { minLength: 3, maxLength: 40 })
	.map((tokenWeights) => {
		const weights = new WeakMap<ApiMessage, number>()
		const messages: ApiMessage[] = tokenWeights.map((weight, index) => {
			const message: ApiMessage = {
				role: index % 2 === 0 ? "user" : "assistant",
				content: `m${index}`,
			}
			weights.set(message, weight)
			return message
		})
		return { messages, weights, tokenWeights }
	})

/**
 * One full recovery-and-retry iteration: run the deterministic reduction toward the budget, map the
 * result to a RecoveryOutcome, and classify it. Mirrors the loop in handleContextWindowExceededError
 * / attemptApiRequest where convergentReduction feeds classifyRecoveryOutcome.
 */
async function runRecoveryStep(
	messages: ApiMessage[],
	currentTokens: number,
	budget: number,
	countTokens: (messages: ApiMessage[]) => Promise<number>,
) {
	const reduction = await convergentReduction({ messages, currentTokens, targetTokens: budget, countTokens })
	const outcome: RecoveryOutcome = reduction.converged
		? { kind: "converged", postTokens: reduction.resultTokens }
		: { kind: "non-recoverable", irreducibleTokens: reduction.resultTokens, budget }
	const decision = classifyRecoveryOutcome(outcome)
	return { reduction, outcome, decision }
}

const MAX_RECOVERY_STEPS = 4

describe("recovery-and-retry loop (convergentReduction ∘ classifyRecoveryOutcome) — Property 6", () => {
	// Validates: Requirements 3.2, 5.5
	it("halts in a bounded number of steps at resume (≤ budget) or a terminal error, never idling above budget", async () => {
		await fc.assert(
			fc.asyncProperty(
				weightedTranscriptArb,
				// A budget strictly below the full transcript so recovery is actually triggered.
				fc.integer({ min: 0, max: 1_000_000 }),
				async ({ messages, weights, tokenWeights }, budgetSeed) => {
					const countTokens = makeDeterministicCountTokens(weights)
					const totalTokens = tokenWeights.reduce((sum, weight) => sum + weight, 0)
					// Force an over-budget start: budget is a fraction strictly below the total.
					const budget = budgetSeed % totalTokens

					// The irreducible floor the single bounded pass can reach. convergentReduction
					// preserves the first message and the two newest, and only removes history in
					// complete pairs — so with `removable = n - 3` candidates it drops the oldest
					// `removable − (removable % 2)` of them. The floor is the full total minus the
					// weights of exactly those dropped messages (indices 1 … maxEvenRemovable).
					const n = tokenWeights.length
					const removable = Math.max(0, n - 3)
					const maxEvenRemovable = removable - (removable % 2)
					let droppedWeight = 0
					for (let index = 1; index <= maxEvenRemovable; index += 1) {
						droppedWeight += tokenWeights[index]
					}
					const irreducibleCore = totalTokens - droppedWeight

					let currentTokens = totalTokens
					let steps = 0
					let resumed = false
					let terminated = false

					// Drive the loop as the real retry branch would: reduce, classify, resume or terminate.
					// convergentReduction is single-pass convergent, so this must settle well within the cap.
					while (steps < MAX_RECOVERY_STEPS && !resumed && !terminated) {
						const { reduction, decision } = await runRecoveryStep(
							messages,
							currentTokens,
							budget,
							countTokens,
						)
						steps += 1

						if (decision.retry) {
							// Resume path: the transcript is genuinely at or below the budget (Req 2.3, 5.5).
							expect(reduction.resultTokens).toBeLessThanOrEqual(budget)
							resumed = true
						} else {
							// Terminal path: only reached because the irreducible core exceeds the budget,
							// so no further reduction is possible — not idling while reduction remains (Req 3.2).
							expect(decision.terminalError).toBeDefined()
							expect(reduction.resultTokens).toBeGreaterThan(budget)
							expect(reduction.resultTokens).toBe(irreducibleCore)
							terminated = true
						}
						currentTokens = reduction.resultTokens
					}

					// The loop always halts: exactly one of resume / terminate, within the bounded step cap,
					// so a context-window overflow can never produce an unbounded retry sequence (Req 5.5).
					expect(resumed || terminated).toBe(true)
					expect(resumed && terminated).toBe(false)
					expect(steps).toBeLessThanOrEqual(MAX_RECOVERY_STEPS)
					expect(steps).toBe(1)

					// Terminate exactly when the irreducible core cannot fit; otherwise resume (Req 3.2).
					if (irreducibleCore > budget) {
						expect(terminated).toBe(true)
					} else {
						expect(resumed).toBe(true)
					}
				},
			),
			{ numRuns: 150 },
		)
	})
})
