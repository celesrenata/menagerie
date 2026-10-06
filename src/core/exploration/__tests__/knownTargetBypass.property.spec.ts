// Feature: semantic-first-retrieval, Property 3: A known target is read directly without a prior retrieve

import { describe, it, expect } from "vitest"
import fc from "fast-check"

import { decide, affordancesFor } from "../explorationPolicy"
import type { ExplorationPolicyInputs, KnownTargetResult } from "../types"
import { indexAvailabilitySnapshotArb } from "./arbitraries"

const knownTargetSources = ["user_instruction", "diagnostic", "worker_held"] as const

/**
 * Always produces a *present* Known_Target across all three sources, with a
 * path and an optional line. This focuses Property 3 on the known-target
 * precedence branch regardless of the other inputs.
 */
const presentKnownTargetArb: fc.Arbitrary<KnownTargetResult> = fc
	.record({
		source: fc.constantFrom(...knownTargetSources),
		path: fc.stringMatching(/^[a-zA-Z0-9_/.\\-]{1,120}$/),
		line: fc.option(fc.nat({ max: 50_000 }), { nil: undefined }),
	})
	.map(({ source, path, line }) => ({ present: true, path, line, source }))

/**
 * `ExplorationPolicyInputs` whose known-target detection always reports a
 * present path. The remaining inputs (`gatewayAvailable`, `exploringUnseenArea`,
 * index availability) vary freely to prove known-target presence dominates them.
 */
const presentKnownTargetInputsArb: fc.Arbitrary<ExplorationPolicyInputs> = fc.record({
	indexAvailability: indexAvailabilitySnapshotArb,
	gatewayAvailable: fc.boolean(),
	knownTarget: presentKnownTargetArb,
	exploringUnseenArea: fc.boolean(),
})

describe("ExplorationPolicy — Property 3: known target is read directly without a prior retrieve", () => {
	it("yields KnownTarget with requiresRetrieveBeforeRead === false for any present known target", () => {
		fc.assert(
			fc.property(presentKnownTargetInputsArb, (inputs) => {
				const decision = decide(inputs)

				// The outcome is KnownTarget regardless of index/gateway/unseen inputs.
				expect(decision.outcome).toBe("KnownTarget")

				// No prior retrieve is required: a direct read is permitted. Since
				// `decide` is pure and takes no gateway dependency, this flag is the
				// correct decision-layer representation of "no retrieve() invoked".
				expect(decision.requiresRetrieveBeforeRead).toBe(false)

				// The policy never blocks the tool call.
				expect(decision.blocks).toBe(false)

				// Advisory affordance prefers a direct read of the known target.
				expect(affordancesFor(decision).preferredNext).toBe("known_target_read")
			}),
			{ numRuns: 200 },
		)
	})
})
