import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	DEFAULT_UNKNOWN_CAPABILITY_SLOTS,
	SMALL_FLOOR,
	STATIC_ROUTE_CAPACITY,
	computeCapacityBounds,
	createStaticRouteCapacityProvider,
	mergeRouteCapacityMap,
	resetRouteCapacityWarnings,
	validateRouteCapacityMap,
} from "../routeCapacityMap"
import { DEFAULT_SCHEDULER_BOUNDS, type RouteCapability, type RouteCapacityProvider } from "../elasticTypes"

describe("validateRouteCapacityMap", () => {
	it("accepts the shipped STATIC_ROUTE_CAPACITY", () => {
		expect(() => validateRouteCapacityMap(STATIC_ROUTE_CAPACITY)).not.toThrow()
	})

	it.each([0, -1, 2.5])("rejects a non-positive-integer slot count (%s)", (bad) => {
		const map = { ...STATIC_ROUTE_CAPACITY, reasoner: bad } as Record<RouteCapability, number>
		expect(() => validateRouteCapacityMap(map)).toThrow()
	})
})

describe("createStaticRouteCapacityProvider", () => {
	beforeEach(() => resetRouteCapacityWarnings())
	afterEach(() => vi.restoreAllMocks())

	it("returns the configured slot count for a known capability", () => {
		const provider = createStaticRouteCapacityProvider()
		const [snapshot] = provider.capacitiesFor("reader")
		expect(snapshot).toMatchObject({ capability: "reader", capacity: 4, available: 4 })
		expect(snapshot?.route).toBe("static:reader")
	})

	it("falls back to the bounded default for an absent capability (never 0, never 12)", () => {
		// A map that omits `vision` entirely.
		const partial = { reader: 4, reasoner: 2, "long-context": 4, general: 1 } as unknown as Record<
			RouteCapability,
			number
		>
		const provider = createStaticRouteCapacityProvider(partial)
		const [snapshot] = provider.capacitiesFor("vision")
		expect(snapshot?.available).toBe(DEFAULT_UNKNOWN_CAPABILITY_SLOTS)
		expect(snapshot?.available).toBeGreaterThan(0)
		expect(snapshot?.available).toBeLessThan(DEFAULT_SCHEDULER_BOUNDS.maxLive)
	})

	it("floors a hypothetical 0/negative override at 1 (forward-progress guarantee)", () => {
		const zeroed = { ...STATIC_ROUTE_CAPACITY, general: 0 } as Record<RouteCapability, number>
		const provider = createStaticRouteCapacityProvider(zeroed)
		const [snapshot] = provider.capacitiesFor("general")
		// 0 is invalid → falls through to the bounded default (which is ≥ 1).
		expect(snapshot?.available).toBe(DEFAULT_UNKNOWN_CAPABILITY_SLOTS)
		expect(snapshot?.available).toBeGreaterThanOrEqual(1)
	})

	it("reports zero sustained pressure", () => {
		expect(createStaticRouteCapacityProvider().sustainedPressure()).toBe(0)
	})

	it("warns at most once per process for the same unmapped capability", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const partial = { reader: 4, reasoner: 2, "long-context": 4, general: 1 } as unknown as Record<
			RouteCapability,
			number
		>
		const provider = createStaticRouteCapacityProvider(partial)
		provider.capacitiesFor("vision")
		provider.capacitiesFor("vision")
		provider.capacitiesFor("vision")
		expect(warn).toHaveBeenCalledTimes(1)
	})
})

describe("mergeRouteCapacityMap", () => {
	beforeEach(() => resetRouteCapacityWarnings())

	it("merges undefined to exactly STATIC_ROUTE_CAPACITY (unset = today's behavior)", () => {
		expect(mergeRouteCapacityMap(undefined)).toEqual(STATIC_ROUTE_CAPACITY)
	})

	it("merges the empty map to exactly STATIC_ROUTE_CAPACITY (empty = no-op)", () => {
		expect(mergeRouteCapacityMap({})).toEqual(STATIC_ROUTE_CAPACITY)
	})

	it("replaces only the overridden capability, keeping static defaults for the rest", () => {
		expect(mergeRouteCapacityMap({ reasoner: 5 })).toEqual({ ...STATIC_ROUTE_CAPACITY, reasoner: 5 })
	})

	it.each([0, -1, 2.5, Number.NaN])(
		"ignores an invalid user override (%s) and falls back to the static value",
		(bad) => {
			const merged = mergeRouteCapacityMap({ reasoner: bad })
			expect(merged.reasoner).toBe(STATIC_ROUTE_CAPACITY.reasoner)
		},
	)

	it("feeds the provider a map that still floors every value >= 1", () => {
		// Even a merged map built from a hostile override keeps the >= 1 floor at the provider.
		const provider = createStaticRouteCapacityProvider(mergeRouteCapacityMap({ reasoner: 0 }))
		const [snapshot] = provider.capacitiesFor("reasoner")
		// 0 override is ignored → merged value is the static 2 → provider reports >= 1.
		expect(snapshot?.available).toBe(STATIC_ROUTE_CAPACITY.reasoner)
		expect(snapshot?.available).toBeGreaterThanOrEqual(1)
	})

	it("preserves no-deadlock bounds under a tiny user capacity map (floor + SMALL_FLOOR hold)", () => {
		const provider = createStaticRouteCapacityProvider(mergeRouteCapacityMap({ reasoner: 1 }))
		const bounds = computeCapacityBounds(provider)
		expect(bounds.maxInferenceLeases).toBeGreaterThanOrEqual(1)
		expect(bounds.maxDispatched).toBeGreaterThanOrEqual(1)
		// A hostile { reasoner: 0 } user map still yields a positive provider slot (no 0-lease deadlock).
		const zeroProvider = createStaticRouteCapacityProvider(mergeRouteCapacityMap({ reasoner: 0 }))
		expect(zeroProvider.capacitiesFor("reasoner")[0]?.available).toBeGreaterThanOrEqual(1)
		expect(computeCapacityBounds(zeroProvider).maxInferenceLeases).toBeGreaterThanOrEqual(1)
	})
})

describe("computeCapacityBounds", () => {
	const fakeProvider = (perCapability: Partial<Record<RouteCapability, number>>): RouteCapacityProvider => ({
		capacitiesFor: (capability) => {
			const available = perCapability[capability] ?? 0
			return available > 0
				? [{ route: `fake:${capability}`, capability, capacity: available, available }]
				: []
		},
		sustainedPressure: () => 0,
	})

	it("seeds maxInferenceLeases from the capacity sum (never 0)", () => {
		const bounds = computeCapacityBounds(fakeProvider({ reader: 4, reasoner: 2, general: 1 }))
		expect(bounds.maxInferenceLeases).toBe(4 + 2 + 1)
	})

	it("floors maxInferenceLeases at 1 for an empty provider", () => {
		const bounds = computeCapacityBounds(fakeProvider({}))
		expect(bounds.maxInferenceLeases).toBe(1)
	})

	it("seeds maxDispatched to max(capacitySum, maxPerCapability, SMALL_FLOOR)", () => {
		// Large single pool so maxPerCapability dominates the sum of the rest.
		const bounds = computeCapacityBounds(fakeProvider({ reader: 10, general: 1 }))
		expect(bounds.maxDispatched).toBe(Math.max(11, 10, SMALL_FLOOR))
	})

	it("respects the SMALL_FLOOR when real capacity is tiny", () => {
		const bounds = computeCapacityBounds(fakeProvider({ general: 1 }))
		expect(bounds.maxDispatched).toBe(SMALL_FLOOR)
	})

	it("guarantees maxDispatched >= the largest single-capability pool (finding #5)", () => {
		const bounds = computeCapacityBounds(fakeProvider({ reader: 6, reasoner: 2 }))
		expect(bounds.maxDispatched).toBeGreaterThanOrEqual(6)
	})

	it("leaves maxLive at the default (12, unchanged)", () => {
		const bounds = computeCapacityBounds(fakeProvider({ reasoner: 2 }))
		expect(bounds.maxLive).toBe(DEFAULT_SCHEDULER_BOUNDS.maxLive)
	})
})
