// Feature: semantic-first-retrieval, Property 1: Preference holds exactly when all conditions and the gateway align

import fc from "fast-check"
import { describe, it } from "vitest"

import { decide } from "../explorationPolicy"
import { explorationPolicyInputsArb } from "./arbitraries"

describe("ExplorationPolicy.decide — Property 1", () => {
	// Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.3, 4.6
	it("chooses PreferSemantic iff all conditions and the gateway align, and never blocks", () => {
		fc.assert(
			fc.property(explorationPolicyInputsArb, (inputs) => {
				const decision = decide(inputs)

				const expected =
					inputs.indexAvailability.available &&
					inputs.gatewayAvailable &&
					inputs.exploringUnseenArea &&
					!inputs.knownTarget.present

				// Biconditional: PreferSemantic exactly when every condition holds.
				if ((decision.outcome === "PreferSemantic") !== expected) {
					return false
				}

				// Invariant: the advisory policy never blocks the tool call.
				return decision.blocks === false
			}),
			{ numRuns: 200 },
		)
	})
})
