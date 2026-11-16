import { DEFAULT_TENACITY_MAX_TRIES } from "@roo-code/types"

import { resolveTenacityPolicy, tenacityExtraRetries } from "../tenacity"

describe("resolveTenacityPolicy", () => {
	const base = { enabled: true, maxTries: undefined, unlimited: false, lockedToTier1: false }

	it("is off when disabled, even if unlimited on tier1", () => {
		expect(resolveTenacityPolicy({ ...base, enabled: false, unlimited: true, lockedToTier1: true })).toEqual({
			mode: "off",
		})
	})

	it("is unlimited only when requested and locked to tier1", () => {
		expect(resolveTenacityPolicy({ ...base, unlimited: true, lockedToTier1: true })).toEqual({ mode: "unlimited" })
	})

	it("falls back to the finite cap when unlimited is requested off tier1", () => {
		expect(resolveTenacityPolicy({ ...base, unlimited: true, maxTries: 25 })).toEqual({
			mode: "finite",
			limit: 25,
		})
	})

	it("keeps a finite cap on tier1 when unlimited is off", () => {
		expect(resolveTenacityPolicy({ ...base, lockedToTier1: true, maxTries: 4 })).toEqual({
			mode: "finite",
			limit: 4,
		})
	})

	it("defaults the cap and ignores invalid values", () => {
		const expected = { mode: "finite", limit: DEFAULT_TENACITY_MAX_TRIES }
		expect(resolveTenacityPolicy(base)).toEqual(expected)
		expect(resolveTenacityPolicy({ ...base, maxTries: 0 })).toEqual(expected)
		expect(resolveTenacityPolicy({ ...base, maxTries: Number.NaN })).toEqual(expected)
	})
})

describe("tenacityExtraRetries", () => {
	it("never lowers a legacy limit", () => {
		expect(tenacityExtraRetries({ mode: "finite", limit: 10 }, 8)).toBe(2)
		expect(tenacityExtraRetries({ mode: "finite", limit: 3 }, 8)).toBe(0)
		expect(tenacityExtraRetries({ mode: "finite", limit: 10 }, 0)).toBe(10)
	})

	it("grants nothing when off and everything when unlimited", () => {
		expect(tenacityExtraRetries({ mode: "off" }, 3)).toBe(0)
		expect(tenacityExtraRetries({ mode: "unlimited" }, 3)).toBeUndefined()
	})
})
