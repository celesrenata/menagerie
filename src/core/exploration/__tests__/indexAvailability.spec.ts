import { describe, it, expect } from "vitest"
import type { IndexManagerLike } from "../indexAvailability"
import { deriveIndexAvailability } from "../indexAvailability"

/**
 * Example-based tests for the pure `deriveIndexAvailability` mapping.
 *
 * `available` is true iff every getter is true AND state !== "Indexing".
 *
 * Requirements traced: 4.1, 4.2, 4.3, 4.4, 4.5
 */
describe("deriveIndexAvailability", () => {
	const allTrue: IndexManagerLike = {
		isConfigurationLoaded: true,
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		isInitialized: true,
		state: "Indexed",
	}

	it("marks available: false when isConfigurationLoaded is false (Req 4.1)", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, isConfigurationLoaded: false })
		expect(snapshot.available).toBe(false)
		expect(snapshot.isConfigurationLoaded).toBe(false)
	})

	it("marks available: false when isFeatureEnabled is false (Req 4.2)", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, isFeatureEnabled: false })
		expect(snapshot.available).toBe(false)
		expect(snapshot.isFeatureEnabled).toBe(false)
	})

	it("marks available: false when isFeatureConfigured is false (Req 4.3)", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, isFeatureConfigured: false })
		expect(snapshot.available).toBe(false)
		expect(snapshot.isFeatureConfigured).toBe(false)
	})

	it("marks available: false when isInitialized is false (Req 4.4)", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, isInitialized: false })
		expect(snapshot.available).toBe(false)
		expect(snapshot.isInitialized).toBe(false)
	})

	it("marks available: false when state is Indexing with all getters true (Req 4.5)", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, state: "Indexing" })
		expect(snapshot.available).toBe(false)
		expect(snapshot.state).toBe("Indexing")
	})

	it("marks available: true when all getters are true and state is Indexed", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, state: "Indexed" })
		expect(snapshot.available).toBe(true)
	})

	it("marks available: true when all getters are true and state is Standby", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, state: "Standby" })
		expect(snapshot.available).toBe(true)
	})

	it("marks available: true when all getters are true and state is Error", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, state: "Error" })
		expect(snapshot.available).toBe(true)
	})

	it("marks available: true when all getters are true and state is Stopping", () => {
		const snapshot = deriveIndexAvailability({ ...allTrue, state: "Stopping" })
		expect(snapshot.available).toBe(true)
	})

	it("passes through every getter and the state onto the snapshot", () => {
		const snapshot = deriveIndexAvailability(allTrue)
		expect(snapshot).toEqual({
			isConfigurationLoaded: true,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
			state: "Indexed",
			available: true,
		})
	})
})
