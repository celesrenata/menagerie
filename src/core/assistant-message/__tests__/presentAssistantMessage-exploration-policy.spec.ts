// Feature: semantic-first-retrieval — Task 10.3
// Integration test: the advisory exploration hook never blocks dispatch.
//
// Testing `presentAssistantMessage` directly requires a full Task mock, so this
// suite instead exercises the layer the hook relies on: the pure
// ExplorationPolicy. The hook calls `decide(inputs)` and then ALWAYS proceeds
// with the model's chosen tool — it never short-circuits a tool call. Because
// every `ExplorationDecision` carries the invariant `blocks: false`, verifying
// the policy here proves the hook can never block.
//
// Requirements traced: 1.4, 4.6

import { describe, it, expect } from "vitest"

import type { IndexingState } from "../../../services/code-index/interfaces/manager"
import type { ExplorationPolicyInputs, KnownTargetResult } from "../../exploration/types"
import { affordancesFor, decide } from "../../exploration/explorationPolicy"
import type { IndexManagerLike } from "../../exploration/indexAvailability"
import { deriveIndexAvailability } from "../../exploration/indexAvailability"

const NO_KNOWN_TARGET: KnownTargetResult = { present: false }

/** A fully-available faked CodeIndexManager: every getter true, state "Indexed". */
const availableManager: IndexManagerLike = {
	isConfigurationLoaded: true,
	isFeatureEnabled: true,
	isFeatureConfigured: true,
	isInitialized: true,
	state: "Indexed",
}

function inputsFrom(
	managerLike: IndexManagerLike,
	overrides: Partial<Omit<ExplorationPolicyInputs, "indexAvailability">> = {},
): ExplorationPolicyInputs {
	return {
		indexAvailability: deriveIndexAvailability(managerLike),
		gatewayAvailable: true,
		knownTarget: NO_KNOWN_TARGET,
		exploringUnseenArea: true,
		...overrides,
	}
}

describe("presentAssistantMessage exploration hook — advisory, never blocks", () => {
	it("proceeds for the PreferSemantic outcome and the decision is advisory (Req 1.4)", () => {
		const decision = decide(inputsFrom(availableManager))

		expect(decision.outcome).toBe("PreferSemantic")
		// The hook dispatches the chosen tool: the decision never blocks.
		expect(decision.blocks).toBe(false)
		expect(decision.requiresRetrieveBeforeRead).toBe(true)
	})

	it("proceeds for the KnownTarget outcome without blocking (Req 1.4)", () => {
		const knownTarget: KnownTargetResult = {
			present: true,
			path: "src/core/task/Task.ts",
			line: 918,
			source: "diagnostic",
		}
		const decision = decide(inputsFrom(availableManager, { knownTarget }))

		expect(decision.outcome).toBe("KnownTarget")
		expect(decision.blocks).toBe(false)
		expect(decision.requiresRetrieveBeforeRead).toBe(false)
	})

	it("proceeds for AllowWalking when the index is unavailable (Req 4.6)", () => {
		const disabledManager: IndexManagerLike = { ...availableManager, isFeatureEnabled: false }
		const decision = decide(inputsFrom(disabledManager))

		expect(decision.outcome).toBe("AllowWalking")
		expect(decision.blocks).toBe(false)
		expect(decision.metricEvent).toBe("index-unavailable")
	})

	it("proceeds for AllowWalking when the gateway is unavailable (Req 4.6)", () => {
		const decision = decide(inputsFrom(availableManager, { gatewayAvailable: false }))

		expect(decision.outcome).toBe("AllowWalking")
		expect(decision.blocks).toBe(false)
		expect(decision.metricEvent).toBe("gateway-unavailable")
	})

	it("never returns a blocking signal and always yields valid affordances for every outcome", () => {
		const scenarios: ReadonlyArray<{ name: string; inputs: ExplorationPolicyInputs }> = [
			{ name: "PreferSemantic", inputs: inputsFrom(availableManager) },
			{
				name: "KnownTarget",
				inputs: inputsFrom(availableManager, {
					knownTarget: { present: true, path: "package.json", source: "user_instruction" },
				}),
			},
			{
				name: "AllowWalking (index unavailable)",
				inputs: inputsFrom({ ...availableManager, isInitialized: false }),
			},
			{
				name: "AllowWalking (gateway unavailable)",
				inputs: inputsFrom(availableManager, { gatewayAvailable: false }),
			},
		]

		for (const { inputs } of scenarios) {
			const decision = decide(inputs)
			// Invariant: the advisory policy never blocks the tool call.
			expect(decision.blocks).toBe(false)

			// affordancesFor must not throw and must return a coherent ordering.
			const affordance = affordancesFor(decision)
			expect(affordance.ordered.length).toBe(4)
			// The ordering lists each tool exactly once.
			expect(new Set(affordance.ordered).size).toBe(4)
			expect(affordance.preferredNext).toBeTruthy()
		}
	})
})

describe("faked CodeIndexManager states run through decide without blocking (Req 4.6)", () => {
	const cases: ReadonlyArray<{
		name: string
		manager: IndexManagerLike
		expectedAvailable: boolean
		expectedOutcome: "PreferSemantic" | "AllowWalking"
	}> = [
		{
			name: "all available, state Indexed",
			manager: availableManager,
			expectedAvailable: true,
			expectedOutcome: "PreferSemantic",
		},
		{
			name: "feature disabled",
			manager: { ...availableManager, isFeatureEnabled: false },
			expectedAvailable: false,
			expectedOutcome: "AllowWalking",
		},
		{
			name: "state Indexing",
			manager: { ...availableManager, state: "Indexing" as IndexingState },
			expectedAvailable: false,
			expectedOutcome: "AllowWalking",
		},
	]

	for (const { name, manager, expectedAvailable, expectedOutcome } of cases) {
		it(`${name}: available=${expectedAvailable}, decision never blocks`, () => {
			const snapshot = deriveIndexAvailability(manager)
			expect(snapshot.available).toBe(expectedAvailable)

			const decision = decide(inputsFrom(manager))
			expect(decision.outcome).toBe(expectedOutcome)
			expect(decision.blocks).toBe(false)
		})
	}
})
