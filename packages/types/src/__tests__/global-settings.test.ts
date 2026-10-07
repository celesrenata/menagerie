import {
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
	parallelCapacityMapSchema,
} from "../global-settings.js"

describe("destructive command guard global setting", () => {
	it("is opt-in by default", () => {
		expect(DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED).toBe(false)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ destructiveCommandGuardEnabled: true })).toEqual({
			destructiveCommandGuardEnabled: true,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("destructiveCommandGuardEnabled")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ destructiveCommandGuardEnabled: "true" })).toThrow()
	})
})

describe("parallelCapacityMap global setting", () => {
	it("exposes the setting key on GLOBAL_SETTINGS_KEYS", () => {
		expect(GLOBAL_SETTINGS_KEYS).toContain("parallelCapacityMap")
	})

	it("accepts a valid partial map and the empty map", () => {
		expect(parallelCapacityMapSchema.parse({})).toEqual({})
		expect(parallelCapacityMapSchema.parse({ reader: 4 })).toEqual({ reader: 4 })
		expect(parallelCapacityMapSchema.parse({ reader: 4, reasoner: 2, "long-context": 4, general: 1, vision: 2 })).toEqual(
			{ reader: 4, reasoner: 2, "long-context": 4, general: 1, vision: 2 },
		)
	})

	it("rejects zero, negative, and non-integer slot counts (floor-of-1 fail-safe at the boundary)", () => {
		expect(parallelCapacityMapSchema.safeParse({ reader: 0 }).success).toBe(false)
		expect(parallelCapacityMapSchema.safeParse({ reader: -1 }).success).toBe(false)
		expect(parallelCapacityMapSchema.safeParse({ reader: 1.5 }).success).toBe(false)
	})

	it("rejects unknown-capability keys", () => {
		expect(parallelCapacityMapSchema.safeParse({ nope: 4 }).success).toBe(false)
	})

	it("round-trips through globalSettingsSchema (set, empty, and unset cases)", () => {
		// Set case: a valid partial map survives the schema parse unchanged.
		expect(globalSettingsSchema.parse({ parallelCapacityMap: { reasoner: 3 } })).toEqual({
			parallelCapacityMap: { reasoner: 3 },
		})
		// Empty-object case: a no-op map round-trips.
		expect(globalSettingsSchema.parse({ parallelCapacityMap: {} })).toEqual({ parallelCapacityMap: {} })
		// Unset case: optionality means an absent key parses to an empty object (no default injected).
		expect(globalSettingsSchema.parse({})).toEqual({})
	})

	it("rejects an invalid map through globalSettingsSchema", () => {
		expect(globalSettingsSchema.safeParse({ parallelCapacityMap: { reader: 0 } }).success).toBe(false)
		expect(globalSettingsSchema.safeParse({ parallelCapacityMap: { nope: 2 } }).success).toBe(false)
	})
})
