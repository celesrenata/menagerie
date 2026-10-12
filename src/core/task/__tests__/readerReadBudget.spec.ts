// Feature: capability-lanes-routing, Property 11: a reader's read-input bound is derived from the lane window and is never a hard-coded size

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { evaluate, type ReaderReadBudgetInput } from "../readerReadBudget"

// A reference implementation of the window-derived bound, independent of the
// module under test, used to pin down the exact arithmetic without re-deriving
// it from the production function. Deliberately spelled out so a regression in
// `evaluate` cannot be masked by a shared helper.
const referenceBound = (servedContextWindow: number, windowFraction: number, bytesPerToken: number): number =>
	windowFraction * servedContextWindow * bytesPerToken

describe("evaluate — Property 11 (window-derived, no hard-coded size)", () => {
	// Feature: capability-lanes-routing, Property 11: with a known window the bound is windowFraction * servedContextWindow * bytesPerToken exactly
	// Validates: Requirements 14.1, 14.2
	it("derives the bound from the lane window alone when the window is known", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2_000_000 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.1), max: 8, noNaN: true }),
				fc.integer({ min: 0, max: 2_000_000 }),
				fc.integer({ min: 1, max: 2_000_000 }),
				(servedContextWindow, windowFraction, bytesPerToken, readInputConsumed, fallbackBudget) => {
					const outcome = evaluate({
						servedContextWindow,
						readInputConsumed,
						windowFraction,
						bytesPerToken,
						fallbackBudget,
					})

					// Bound is exactly the window-derived product — never the fallback.
					expect(outcome.bound).toBe(referenceBound(servedContextWindow, windowFraction, bytesPerToken))
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: capability-lanes-routing, Property 11: no fixed context-window literal participates — scaling the window scales the bound linearly
	// Validates: Requirements 14.1, 14.2
	it("embeds no hard-coded window: scaling the window scales the bound with it", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100_000 }),
				fc.integer({ min: 1, max: 20 }),
				fc.double({ min: Math.fround(0.01), max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.1), max: 8, noNaN: true }),
				(baseWindow, factor, windowFraction, bytesPerToken) => {
					const scaled = baseWindow * factor

					const outcomeBase = evaluate({
						servedContextWindow: baseWindow,
						readInputConsumed: 0,
						windowFraction,
						bytesPerToken,
						fallbackBudget: 1,
					})
					const outcomeScaled = evaluate({
						servedContextWindow: scaled,
						readInputConsumed: 0,
						windowFraction,
						bytesPerToken,
						fallbackBudget: 1,
					})

					// Bound scales one-for-one with the window, confirming no literal
					// substitutes for the OmniRoute-owned window value.
					expect(outcomeScaled.bound).toBeCloseTo(outcomeBase.bound * factor, 6)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: capability-lanes-routing, Property 11: the bound is monotonically non-decreasing in the lane window
	// Validates: Requirements 14.1, 14.2
	it("is monotonic in the window: a larger servedContextWindow never yields a smaller bound", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2_000_000 }),
				fc.integer({ min: 1, max: 2_000_000 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.1), max: 8, noNaN: true }),
				(windowA, windowB, windowFraction, bytesPerToken) => {
					const boundA = evaluate({
						servedContextWindow: windowA,
						readInputConsumed: 0,
						windowFraction,
						bytesPerToken,
						fallbackBudget: 1,
					}).bound
					const boundB = evaluate({
						servedContextWindow: windowB,
						readInputConsumed: 0,
						windowFraction,
						bytesPerToken,
						fallbackBudget: 1,
					}).bound

					// Holding windowFraction/bytesPerToken fixed, the bound orders with the window.
					if (windowB > windowA) {
						expect(boundB).toBeGreaterThanOrEqual(boundA)
					} else if (windowB < windowA) {
						expect(boundB).toBeLessThanOrEqual(boundA)
					} else {
						expect(boundB).toBe(boundA)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: capability-lanes-routing, Property 11: an undefined window yields exactly the fallback budget, never an error
	// Validates: Requirements 14.6
	it("falls back to fallbackBudget when the lane window is undefined", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.1), max: 8, noNaN: true }),
				fc.integer({ min: 0, max: 2_000_000 }),
				fc.integer({ min: 0, max: 2_000_000 }),
				(windowFraction, bytesPerToken, readInputConsumed, fallbackBudget) => {
					const outcome = evaluate({
						servedContextWindow: undefined,
						readInputConsumed,
						windowFraction,
						bytesPerToken,
						fallbackBudget,
					})

					// Unknown window ⇒ bound is exactly the per-worker fallback.
					expect(outcome.bound).toBe(fallbackBudget)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: capability-lanes-routing, Property 11: read-input over the bound is never "within-budget"
	// Validates: Requirements 14.3, 14.5
	it("never reports within-budget once read-input strictly exceeds the bound", () => {
		fc.assert(
			fc.property(
				// A positive window so the bound is a positive, well-defined number.
				fc.integer({ min: 1, max: 2_000_000 }),
				fc.double({ min: Math.fround(0.01), max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.5), max: 8, noNaN: true }),
				// A strictly positive overrun added on top of the bound.
				fc.double({ min: Math.fround(0.1), max: 1_000_000, noNaN: true }),
				fc.integer({ min: 1, max: 2_000_000 }),
				(servedContextWindow, windowFraction, bytesPerToken, overrun, fallbackBudget) => {
					const bound = referenceBound(servedContextWindow, windowFraction, bytesPerToken)

					const outcome = evaluate({
						servedContextWindow,
						readInputConsumed: bound + overrun,
						windowFraction,
						bytesPerToken,
						fallbackBudget,
					})

					// Strictly over the bound ⇒ a bounding action, never within-budget.
					expect(outcome.action).not.toBe("within-budget")
					expect(["bound-reads", "summarize-and-conclude"]).toContain(outcome.action)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: capability-lanes-routing, Property 11: read-input at or under the bound is within-budget
	// Validates: Requirements 14.3, 14.5
	it("reports within-budget whenever read-input is at or under the bound", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2_000_000 }),
				fc.double({ min: Math.fround(0.01), max: 1, noNaN: true }),
				fc.double({ min: Math.fround(0.5), max: 8, noNaN: true }),
				// A fraction of the bound (0..1) so the consumed value never exceeds it.
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.integer({ min: 1, max: 2_000_000 }),
				(servedContextWindow, windowFraction, bytesPerToken, fractionOfBound, fallbackBudget) => {
					const bound = referenceBound(servedContextWindow, windowFraction, bytesPerToken)

					const outcome = evaluate({
						servedContextWindow,
						readInputConsumed: bound * fractionOfBound,
						windowFraction,
						bytesPerToken,
						fallbackBudget,
					})

					expect(outcome.action).toBe("within-budget")
				},
			),
			{ numRuns: 200 },
		)
	})
})
