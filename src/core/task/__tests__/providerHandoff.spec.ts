import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { getEffectiveTaskApiConfiguration, selectHandoffExecutionContext } from "../providerHandoff"

const parentConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	consecutiveMistakeLimit: 3,
}
const savedConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.openrouter,
	consecutiveMistakeLimit: 7,
}
const parent = { mode: "code", apiConfigName: undefined, apiConfiguration: parentConfiguration }

describe("provider handoff decisions", () => {
	it.each([
		{ name: "unsaved", locked: false, saved: undefined, expected: parentConfiguration },
		{
			name: "saved",
			locked: false,
			saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
			expected: savedConfiguration,
		},
		{
			name: "locked",
			locked: true,
			saved: { name: "ask-profile", apiConfiguration: savedConfiguration },
			expected: parentConfiguration,
		},
		{ name: "stale", locked: false, saved: undefined, expected: parentConfiguration },
	])("selects the $name profile path without mutating the parent", ({ locked, saved, expected }) => {
		const selected = selectHandoffExecutionContext(parent, "ask", "code", locked, saved)

		expect(selected.apiConfiguration).toEqual(expected)
		expect(selected.apiConfiguration).not.toBe(expected)
		expect(parent.apiConfiguration).toBe(parentConfiguration)
	})

	it("derives task limits from the effective handoff configuration", () => {
		const handoff = selectHandoffExecutionContext(parent, "ask", "code", false, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(getEffectiveTaskApiConfiguration(parentConfiguration, handoff).consecutiveMistakeLimit).toBe(7)
		expect(getEffectiveTaskApiConfiguration(parentConfiguration).consecutiveMistakeLimit).toBe(3)
	})

	it("keeps the parent configuration when a configured saved profile is locked", () => {
		const selected = selectHandoffExecutionContext(parent, "ask", "code", true, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(selected.apiConfigName).toBeUndefined()
		expect(selected.apiConfiguration).toEqual(parentConfiguration)
	})

	it("keeps the parent configuration when the requested mode is unchanged", () => {
		const selected = selectHandoffExecutionContext(parent, "code", "code", false, {
			name: "ask-profile",
			apiConfiguration: savedConfiguration,
		})

		expect(selected.apiConfigName).toBeUndefined()
		expect(selected.apiConfiguration).toEqual(parentConfiguration)
	})

	it("uses the saved Code profile for a parallel worker even when its parent is in Code mode", () => {
		const selected = selectHandoffExecutionContext(
			parent,
			"code",
			"code",
			false,
			{ name: "code-profile", apiConfiguration: savedConfiguration },
			true,
		)
		expect(selected.apiConfigName).toBe("code-profile")
		expect(selected.apiConfiguration).toEqual(savedConfiguration)
	})

	// omniroute-fleet-topology Requirement 17.4: the handoff context carries the
	// worker's assigned Capability_Lane additively, exactly as `runParallelTasks`
	// sets it (`context.capabilityLane = lane`) and `Task` reads it. The field is a
	// plain assignable `string` so the handoff type stays free of a capabilityLanes
	// dependency, and a context with no lane simply leaves it undefined.
	it("carries an assigned Capability_Lane on the selected handoff context (Req 17.4)", () => {
		const selected = selectHandoffExecutionContext(parent, "code", "code", false, {
			name: "code-profile",
			apiConfiguration: savedConfiguration,
		})
		// A fresh selection has no lane until the caller assigns one (readers/coders
		// get a lane from assignLanes; a non-laned handoff never gets one).
		expect(selected.capabilityLane).toBeUndefined()
		// Assigning the lane additively leaves the resolved configuration untouched.
		selected.capabilityLane = "reader.fast"
		expect(selected.capabilityLane).toBe("reader.fast")
		expect(selected.apiConfiguration).toEqual(parentConfiguration)
	})
})
