// Feature: resilient-context-recovery, Property 2 & 3: the Servable_Input_Budget is window − reserve, derived from the OmniRoute window with no hard-coded size

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { computeServableInputBudget, type ServableBudgetInput } from "../servableBudget"

// A reference implementation that is independent of the module under test, used
// to pin down the exact arithmetic without re-deriving it from the production
// function. Deliberately spelled out so a regression in `computeServableInputBudget`
// cannot be masked by a shared helper.
const referenceBudget = (window: number, reserve: number): number => (window - reserve > 0 ? window - reserve : 0)

describe("computeServableInputBudget — Property 2", () => {
	// Feature: resilient-context-recovery, Property 2: The servable budget is exactly the window minus the reserve
	// Validates: Requirements 2.1
	it("equals max(0, servedContextWindow − outputReserve) over arbitrary window/reserve pairs", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2_000_000 }),
				fc.integer({ min: 0, max: 2_000_000 }),
				(servedContextWindow, outputReserve) => {
					const budget = computeServableInputBudget({ servedContextWindow, outputReserve })

					// Exactly the window minus the reserve, clamped non-negative.
					expect(budget).toBe(referenceBudget(servedContextWindow, outputReserve))
					// Clamp invariant: never negative.
					expect(budget).toBeGreaterThanOrEqual(0)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 2: reserve ≥ window clamps the budget to zero
	// Validates: Requirements 2.1
	it("clamps to 0 when the output reserve meets or exceeds the window", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2_000_000 }),
				// outputReserve is at least the window, so window − reserve ≤ 0.
				fc.integer({ min: 0, max: 2_000_000 }),
				(servedContextWindow, extraReserve) => {
					const outputReserve = servedContextWindow + extraReserve
					const budget = computeServableInputBudget({ servedContextWindow, outputReserve })

					expect(budget).toBe(0)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 2: the budget depends on no quantity other than its two inputs
	// Validates: Requirements 2.1
	it("depends on no quantity other than servedContextWindow and outputReserve", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2_000_000 }),
				fc.integer({ min: 0, max: 2_000_000 }),
				// An arbitrary, unrelated extra field that the function must ignore.
				fc.anything(),
				(servedContextWindow, outputReserve, noise) => {
					const base: ServableBudgetInput = { servedContextWindow, outputReserve }
					// Attaching extra, unrelated data must not change the result: the
					// function reads only its two declared inputs. The cast models a
					// caller passing a wider object; the function must ignore the extra.
					const widened = { ...base, unrelated: noise } as ServableBudgetInput

					expect(computeServableInputBudget(widened)).toBe(computeServableInputBudget(base))
					// Pure/deterministic: same inputs, same output on repeat calls.
					expect(computeServableInputBudget(base)).toBe(computeServableInputBudget(base))
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("computeServableInputBudget — Property 3 (budget portion)", () => {
	// Feature: resilient-context-recovery, Property 3: The reduction target is derived from the OmniRoute window with no hard-coded size
	// Validates: Requirements 2.4, 4.3
	it("tracks the window: two inputs differing only in the window yield window-proportional targets", () => {
		fc.assert(
			fc.property(
				// A shared reserve both inputs hold fixed.
				fc.integer({ min: 0, max: 500_000 }),
				// Two distinct windows, both comfortably above the reserve so neither clamps.
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(outputReserve, deltaA, deltaB) => {
					// Build two windows that each exceed the reserve, so the budget is the
					// unclamped window − reserve and the difference reflects only the window.
					const windowA = outputReserve + deltaA
					const windowB = outputReserve + deltaB

					const budgetA = computeServableInputBudget({ servedContextWindow: windowA, outputReserve })
					const budgetB = computeServableInputBudget({ servedContextWindow: windowB, outputReserve })

					// The target moves one-for-one with the resolved window, the only differing input.
					expect(budgetB - budgetA).toBe(windowB - windowA)
					// A larger window never yields a smaller target (monotonic in the window).
					if (windowB > windowA) {
						expect(budgetB).toBeGreaterThan(budgetA)
					} else if (windowB < windowA) {
						expect(budgetB).toBeLessThan(budgetA)
					} else {
						expect(budgetB).toBe(budgetA)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 3: no fixed context-window literal participates in the computation
	// Validates: Requirements 2.4, 4.3
	it("embeds no hard-coded window: scaling the window scales the unclamped target with it", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100_000 }),
				fc.integer({ min: 1, max: 20 }),
				(baseWindow, factor) => {
					// Reserve is zero so the budget is exactly the window; if any fixed
					// window literal were baked in, scaling would not track linearly.
					const outputReserve = 0
					const scaled = baseWindow * factor

					const budgetBase = computeServableInputBudget({ servedContextWindow: baseWindow, outputReserve })
					const budgetScaled = computeServableInputBudget({ servedContextWindow: scaled, outputReserve })

					expect(budgetBase).toBe(baseWindow)
					expect(budgetScaled).toBe(scaled)
					// Target scales with the window, confirming no literal substitutes for it.
					expect(budgetScaled).toBe(budgetBase * factor)
				},
			),
			{ numRuns: 200 },
		)
	})
})
