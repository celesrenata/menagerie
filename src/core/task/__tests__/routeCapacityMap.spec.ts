import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { OmniRouteCatalogEntry } from "@roo-code/types"

import {
	CAPABILITY_TO_LANES,
	DEFAULT_UNKNOWN_CAPABILITY_SLOTS,
	SMALL_FLOOR,
	STATIC_ROUTE_CAPACITY,
	buildPublishedCapacityMap,
	computeCapacityBounds,
	createPublishedRouteCapacityProvider,
	createStaticRouteCapacityProvider,
	extractPublishedRouteMetadata,
	mergeRouteCapacityMap,
	publishedCapacityForCapability,
	resetRouteCapacityWarnings,
	validateRouteCapacityMap,
	type PublishedRouteMetadata,
} from "../routeCapacityMap"
import { getPublishedCatalogEntries, __resetPublishedCatalogCache, __setPublishedCatalogDeps } from "../../../api/providers/omniroute"
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

// ─────────────────────────────────────────────────────────────────────────────
// Published-metadata-backed capacity provider (omniroute-fleet-topology task
// 13.3; Requirement 14.5 fallback, 14.7 zero-capability→static, 14.8 lower
// operator override wins). These derive the per-RouteCapability slot map from a
// published catalog snapshot and fall back to the static map when the snapshot
// is incomplete. The floor-of-1 safety still comes from the static provider.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fully-mapped published catalog that assigns every one of the four
 * {@link CAPABILITY_LANES} to a Public_Route with a RouteCapacity record. One
 * catalog entry carries the lane map; separate entries carry each route's
 * capacity, mirroring how OmniRoute publishes per-entry metadata.
 */
const completeCatalog = (
	laneRoutes: Record<string, string>,
	capacities: Record<string, number>,
): OmniRouteCatalogEntry[] => [
	{ id: "map", capabilityLane: laneRoutes },
	...Object.entries(capacities).map(([route, capacity]) => ({
		id: route,
		routeCapacity: { route, capacity },
	})),
]

/** The canonical complete fixture: four lanes → four distinct routes with capacities. */
const fullLaneRoutes = {
	"reader.fast": "hybrid/reader",
	"reader.deep": "hybrid/reader",
	"coder.primary": "hybrid/code",
	"reasoning.escalation": "hybrid/planner",
}

describe("CAPABILITY_TO_LANES (Requirement 14.4 reverse index)", () => {
	it("is derived from laneToRouteCapability for at least one task type", () => {
		expect(CAPABILITY_TO_LANES.reader).toEqual(["reader.fast", "reader.deep"])
		// coder.primary → reasoner (impl) and reasoning.escalation → reasoner (adjudication).
		expect([...CAPABILITY_TO_LANES.reasoner].sort()).toEqual(["coder.primary", "reasoning.escalation"])
		// reasoning.escalation → long-context (long-horizon/architecture).
		expect(CAPABILITY_TO_LANES["long-context"]).toEqual(["reasoning.escalation"])
		// coder.primary → general (non-reasoning task types).
		expect(CAPABILITY_TO_LANES.general).toEqual(["coder.primary"])
		// No lane maps to vision, so its published capacity is always 0 (→ static, 14.7).
		expect(CAPABILITY_TO_LANES.vision).toEqual([])
	})
})

describe("extractPublishedRouteMetadata (Requirement 14.5 completeness)", () => {
	it("returns metadata: undefined, complete: false for an empty catalog", () => {
		expect(extractPublishedRouteMetadata([])).toEqual({ metadata: undefined, complete: false })
	})

	it("returns metadata: undefined, complete: false when no entry carries published fields", () => {
		const result = extractPublishedRouteMetadata([{ id: "hybrid/code" }, { id: "local/long" }])
		expect(result.metadata).toBeUndefined()
		expect(result.complete).toBe(false)
	})

	it("merges per-entry lane maps and capacity records across entries", () => {
		const result = extractPublishedRouteMetadata(completeCatalog(fullLaneRoutes, {
			"hybrid/reader": 4,
			"hybrid/code": 2,
			"hybrid/planner": 1,
		}))
		expect(result.complete).toBe(true)
		expect(result.metadata?.capabilityLane).toEqual(fullLaneRoutes)
		expect(result.metadata?.routeCapacity).toEqual({
			"hybrid/reader": 4,
			"hybrid/code": 2,
			"hybrid/planner": 1,
		})
	})

	it("is incomplete when a capability lane is not mapped to a route", () => {
		const partialLanes = { ...fullLaneRoutes }
		delete (partialLanes as Record<string, string>)["coder.primary"]
		const result = extractPublishedRouteMetadata(completeCatalog(partialLanes, {
			"hybrid/reader": 4,
			"hybrid/planner": 1,
		}))
		expect(result.complete).toBe(false)
		// The metadata is still returned (non-undefined) so callers can inspect it,
		// but `complete: false` forces the static fallback.
		expect(result.metadata).toBeDefined()
	})

	it("is incomplete when a mapped route lacks a valid capacity record", () => {
		const result = extractPublishedRouteMetadata(completeCatalog(fullLaneRoutes, {
			"hybrid/reader": 4,
			"hybrid/code": 2,
			// hybrid/planner is referenced by reasoning.escalation but has no capacity.
		}))
		expect(result.complete).toBe(false)
	})

	it("accepts a zero capacity as a valid (non-negative integer) record for completeness", () => {
		const result = extractPublishedRouteMetadata(completeCatalog(fullLaneRoutes, {
			"hybrid/reader": 4,
			"hybrid/code": 0,
			"hybrid/planner": 1,
		}))
		expect(result.complete).toBe(true)
	})
})

describe("publishedCapacityForCapability (Requirement 14.4)", () => {
	const metadata: PublishedRouteMetadata = {
		capabilityLane: fullLaneRoutes,
		routeCapacity: { "hybrid/reader": 4, "hybrid/code": 2, "hybrid/planner": 1 },
	}

	it("sums distinct local slots across the routes a capability's lanes map to", () => {
		// reader lanes both point at hybrid/reader → counted once (de-dup by route).
		expect(publishedCapacityForCapability("reader", metadata)).toBe(4)
	})

	it("de-duplicates a route shared by two lanes of the same capability", () => {
		// reasoner = coder.primary (hybrid/code=2) + reasoning.escalation (hybrid/planner=1).
		expect(publishedCapacityForCapability("reasoner", metadata)).toBe(3)
	})

	it("returns 0 for a capability no lane maps to (vision)", () => {
		expect(publishedCapacityForCapability("vision", metadata)).toBe(0)
	})
})

describe("buildPublishedCapacityMap (Requirements 14.4, 14.7, 14.8)", () => {
	const metadata: PublishedRouteMetadata = {
		capabilityLane: fullLaneRoutes,
		routeCapacity: { "hybrid/reader": 4, "hybrid/code": 2, "hybrid/planner": 1 },
	}

	it("uses the published count for a capability a lane maps to", () => {
		const map = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, undefined)
		expect(map.reader).toBe(4)
		expect(map.reasoner).toBe(3) // hybrid/code (2) + hybrid/planner (1)
		expect(map["long-context"]).toBe(1)
		expect(map.general).toBe(2)
	})

	it("falls back to the static value for a 0-published capability (14.7, vision)", () => {
		const map = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, undefined)
		expect(map.vision).toBe(STATIC_ROUTE_CAPACITY.vision)
	})

	it("falls back to the static value when a published route reports 0 capacity (14.7)", () => {
		const zeroed: PublishedRouteMetadata = {
			capabilityLane: fullLaneRoutes,
			routeCapacity: { "hybrid/reader": 0, "hybrid/code": 2, "hybrid/planner": 1 },
		}
		const map = buildPublishedCapacityMap(zeroed, STATIC_ROUTE_CAPACITY, undefined)
		// reader published 0 → static reader value.
		expect(map.reader).toBe(STATIC_ROUTE_CAPACITY.reader)
	})

	it("lets a lower operator override win over the published count (14.8)", () => {
		const map = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, { reader: 2 })
		// Published reader is 4; a lower override of 2 wins.
		expect(map.reader).toBe(2)
	})

	it("ignores a higher or equal operator override, keeping the published count (14.8)", () => {
		const higher = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, { reader: 10 })
		expect(higher.reader).toBe(4)
		const equal = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, { reader: 4 })
		expect(equal.reader).toBe(4)
	})

	it("ignores an invalid (0/negative/non-integer) operator override", () => {
		for (const bad of [0, -1, 2.5]) {
			const map = buildPublishedCapacityMap(metadata, STATIC_ROUTE_CAPACITY, { reader: bad })
			expect(map.reader).toBe(4)
		}
	})
})

describe("createPublishedRouteCapacityProvider (Requirement 14.5 fallback)", () => {
	beforeEach(() => resetRouteCapacityWarnings())
	afterEach(() => vi.restoreAllMocks())

	it("builds a provider from a complete extraction", () => {
		const extraction = extractPublishedRouteMetadata(completeCatalog(fullLaneRoutes, {
			"hybrid/reader": 4,
			"hybrid/code": 2,
			"hybrid/planner": 1,
		}))
		const provider = createPublishedRouteCapacityProvider(extraction)
		expect(provider.capacitiesFor("reader")[0]?.available).toBe(4)
		expect(provider.capacitiesFor("reasoner")[0]?.available).toBe(3)
	})

	it("falls back to the static map when the extraction carried no metadata", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider = createPublishedRouteCapacityProvider({ metadata: undefined, complete: false })
		expect(provider.capacitiesFor("reader")[0]?.available).toBe(STATIC_ROUTE_CAPACITY.reader)
		expect(provider.capacitiesFor("reasoner")[0]?.available).toBe(STATIC_ROUTE_CAPACITY.reasoner)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("falls back to the static map when the extraction is incomplete", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const partialLanes = { ...fullLaneRoutes }
		delete (partialLanes as Record<string, string>)["coder.primary"]
		const extraction = extractPublishedRouteMetadata(completeCatalog(partialLanes, {
			"hybrid/reader": 4,
			"hybrid/planner": 1,
		}))
		expect(extraction.complete).toBe(false)
		const provider = createPublishedRouteCapacityProvider(extraction)
		expect(provider.capacitiesFor("reader")[0]?.available).toBe(STATIC_ROUTE_CAPACITY.reader)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("still floors a published-0 capability at 1 via the static provider (no deadlock)", () => {
		// A capability a lane maps to but with a published 0 → falls back to static,
		// then the static provider floors it to >= 1. Prove the floor holds end-to-end.
		const metadata: PublishedRouteMetadata = {
			capabilityLane: fullLaneRoutes,
			routeCapacity: { "hybrid/reader": 4, "hybrid/code": 0, "hybrid/planner": 1 },
		}
		const provider = createPublishedRouteCapacityProvider(
			{ metadata, complete: true },
			{ ...STATIC_ROUTE_CAPACITY, general: 0 },
		)
		// general = coder.primary (hybrid/code=0) → static general (0) → floored to >= 1.
		expect(provider.capacitiesFor("general")[0]?.available).toBeGreaterThanOrEqual(1)
	})

	it("applies the lower operator override through the provider (14.8)", () => {
		const extraction = extractPublishedRouteMetadata(completeCatalog(fullLaneRoutes, {
			"hybrid/reader": 4,
			"hybrid/code": 2,
			"hybrid/planner": 1,
		}))
		const provider = createPublishedRouteCapacityProvider(extraction, STATIC_ROUTE_CAPACITY, { reader: 1 })
		expect(provider.capacitiesFor("reader")[0]?.available).toBe(1)
	})
})

describe("getPublishedCatalogEntries (Requirement 14.5 / 13.7 cache read)", () => {
	afterEach(() => {
		__resetPublishedCatalogCache()
		__setPublishedCatalogDeps()
	})

	it("returns [] for a profile with no server URL (uncached)", () => {
		expect(getPublishedCatalogEntries(undefined)).toEqual([])
		expect(getPublishedCatalogEntries("   ")).toEqual([])
	})

	it("returns [] for a server URL with no cached catalog", () => {
		expect(getPublishedCatalogEntries("https://omniroute.example")).toEqual([])
	})

	it("drives the static fallback: [] entries extract to an incomplete extraction", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const entries = getPublishedCatalogEntries("https://omniroute.example")
		const extraction = extractPublishedRouteMetadata(entries)
		expect(extraction.complete).toBe(false)
		const provider = createPublishedRouteCapacityProvider(extraction)
		expect(provider.capacitiesFor("reader")[0]?.available).toBe(STATIC_ROUTE_CAPACITY.reader)
		warn.mockRestore()
	})
})
