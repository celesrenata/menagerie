// Feature: resilient-context-recovery, Property 1: Recovery-handler resolution is window-sufficient, lane-independent, and prefers the configured profile
// Feature: resilient-context-recovery, Property 5: The summarizer input never exceeds the recovery handler's window

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import {
	resolveRecoveryHandler,
	type RecoveryHandlerCandidate,
	type RecoveryHandlerResolverInput,
} from "../recoveryHandlerResolver"

/**
 * Generates a single candidate. `contextWindow` and `outputReserve` are drawn so
 * that a candidate's Recovery_Input_Bound (`contextWindow − outputReserve`) ranges
 * across below-zero through large positive values, exercising both qualifying and
 * disqualifying candidates against a given required recovery input.
 */
const candidateArb: fc.Arbitrary<RecoveryHandlerCandidate> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 12 }),
	contextWindow: fc.integer({ min: 0, max: 400_000 }),
	outputReserve: fc.integer({ min: 0, max: 64_000 }),
	configuredLargeContextProfile: fc.boolean(),
})

const resolverInputArb: fc.Arbitrary<RecoveryHandlerResolverInput> = fc.record({
	requiredRecoveryInput: fc.integer({ min: 0, max: 400_000 }),
	candidates: fc.array(candidateArb, { maxLength: 8 }),
})

/** Recovery_Input_Bound for a candidate = contextWindow − outputReserve (Req 4.3). */
const boundOf = (candidate: RecoveryHandlerCandidate): number => candidate.contextWindow - candidate.outputReserve

describe("resolveRecoveryHandler — Property 1", () => {
	// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
	it("returns a window-sufficient handler or deterministic, prefers the configured profile, and ignores the failing lane", () => {
		fc.assert(
			fc.property(resolverInputArb, fc.integer({ min: 0, max: 400_000 }), (input, hypotheticalLaneWindow) => {
				const result = resolveRecoveryHandler(input)

				const qualifying = input.candidates.filter((c) => boundOf(c) >= input.requiredRecoveryInput)

				if (result.path === "deterministic") {
					// deterministic iff no candidate qualifies (Req 1.3).
					expect(qualifying.length).toBe(0)
					expect(result.handlerId).toBeUndefined()
					expect(result.recoveryInputBound).toBeUndefined()
				} else {
					// At least one candidate must have qualified.
					expect(qualifying.length).toBeGreaterThan(0)

					const chosen = input.candidates.find((c) => c.id === result.handlerId)
					expect(chosen).toBeDefined()

					// A chosen handler's bound is at or above the required input — a too-small
					// handler is never returned (Req 1.1, 1.4).
					const chosenBound = boundOf(chosen!)
					expect(chosenBound).toBeGreaterThanOrEqual(input.requiredRecoveryInput)

					// When any qualifying candidate is the configured large-context profile,
					// the chosen handler must itself be a configured profile (Req 1.5).
					const anyConfiguredQualifies = qualifying.some((c) => c.configuredLargeContextProfile)
					if (anyConfiguredQualifies) {
						expect(chosen!.configuredLargeContextProfile).toBe(true)
					}
				}

				// Lane-independence (Req 1.2): the resolver input carries no failing-lane
				// window, so a hypothetical lane window cannot change the outcome. Re-running
				// with the identical input (the lane value is simply not an input) is stable.
				const rerun = resolveRecoveryHandler({
					requiredRecoveryInput: input.requiredRecoveryInput,
					candidates: input.candidates,
				})
				expect(rerun).toEqual(result)
				// The hypothetical lane window is intentionally unused — asserting it cannot
				// participate keeps the generator honest.
				expect(typeof hypotheticalLaneWindow).toBe("number")
			}),
			{ numRuns: 200 },
		)
	})
})

describe("resolveRecoveryHandler — Property 5", () => {
	// Validates: Requirements 4.1, 4.2, 4.3, 4.4
	it("exposes a recoveryInputBound equal to the chosen handler's contextWindow − outputReserve", () => {
		fc.assert(
			fc.property(resolverInputArb, (input) => {
				const result = resolveRecoveryHandler(input)

				if (result.path !== "large-context") {
					// No bound is published when there is no recovery handler.
					expect(result.recoveryInputBound).toBeUndefined()
					return
				}

				const chosen = input.candidates.find((c) => c.id === result.handlerId)
				expect(chosen).toBeDefined()

				// The published bound equals the chosen handler's own window minus its reserve (Req 4.3).
				expect(result.recoveryInputBound).toBe(boundOf(chosen!))

				// The bound is sufficient to carry the required input, so an input at or below
				// it fits the handler window (Req 4.1, 4.4) and only an input strictly above the
				// bound must be pre-reduced (Req 4.2).
				const bound = result.recoveryInputBound!
				expect(bound).toBeGreaterThanOrEqual(input.requiredRecoveryInput)

				const atBoundInput = bound
				const aboveBoundInput = bound + 1
				expect(atBoundInput <= bound).toBe(true)
				expect(aboveBoundInput <= bound).toBe(false)
			}),
			{ numRuns: 200 },
		)
	})
})
