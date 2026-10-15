import { z } from "zod"

import type { OmniRouteCatalogEntry } from "@roo-code/types"

import {
	DEFAULT_SCHEDULER_BOUNDS,
	ROUTE_CAPABILITIES,
	type RouteCapability,
	type RouteCapacity,
	type RouteCapacityProvider,
	type SchedulerBounds,
} from "./elasticTypes"
import { CAPABILITY_LANES, laneToRouteCapability, type CapabilityLane, type LaneTaskType } from "./capabilityLanes"

/**
 * Static per-capability real inference-slot counts for the parallel-task batch
 * scheduler (design §A "Capacity source — configured static capacity map").
 *
 * SOURCE OF TRUTH: the self-hosted OmniRoute `PROVIDER_POLICIES`
 * (vllm / ollama-local / llama-cpp). This map MUST be kept in lockstep with that
 * serving config, exactly like {@link import("../../api/providers/omniroute").OMNIROUTE_ROUTE_CONTEXT_WINDOWS}
 * mirrors the per-route context windows. Each value is the SUMMED real slot
 * count of the backends that serve the capability:
 *
 *   - `reader`       (9B / ollama-local reader lane)              → 4
 *   - `reasoner`     (27B code lane; vLLM `maxConcurrent 2`)      → 2
 *   - `long-context` (GLM planner/long via ollama)               → 4
 *   - `general`      (mechanical/general edits; llama-cpp)        → 1
 *   - `vision`       (none configured today)                     → fail-safe default
 *
 * IMPORTANT (code-spread lockstep, design §C / design-review finding #1): when the
 * operator configures code work to spread across more than one backend via
 * `collectCodeCapableRouteIds` (the per-route `capability` classifier), the
 * `reasoner` value here MUST equal the SUM of the real code slots of every route
 * returned by `collectCodeCapableRouteIds` — not just vLLM's 2 — because every
 * spread `coder.primary` worker leases against the single `reasoner` pool. The map
 * value is therefore the total code-capable concurrency the operator intends
 * Menagerie to admit, kept in lockstep with how many code backends they spread
 * across. When no spread is configured, `reasoner` stays at the single backend's
 * slots (2).
 *
 * These numbers are operator-tunable config, NOT magic literals the scheduler
 * branches on. The scheduler consumes only the capability/capacity abstraction
 * (PAR-013); nothing here models GPU/VRAM/CUDA/node identity.
 */
export const STATIC_ROUTE_CAPACITY: Readonly<Record<RouteCapability, number>> = {
	reader: 4,
	reasoner: 2,
	"long-context": 4,
	general: 1,
	// `vision` is intentionally omitted-as-configured; a vision worker falls
	// through to DEFAULT_UNKNOWN_CAPABILITY_SLOTS until a vision backend is wired.
	vision: 2,
}

/**
 * Bounded fail-safe for a capability absent from (or invalid in) the map
 * (design §A "Fail-safe"). It is deliberately far below the old always-12 stub
 * so an unknown capability is throttled rather than flooded, and strictly above
 * the forward-progress floor of 1 so a lease can always eventually be granted.
 */
export const DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2

/**
 * Dispatch-permit floor used when seeding `maxDispatched` from capacity
 * (design §D). Keeps enough permits to feed the lease pools and reach the
 * lease-wait state even when the summed real capacity is tiny.
 */
export const SMALL_FLOOR = 4

/**
 * Validate each configured slot count at module load: a mis-edit (0, negative,
 * non-integer) is caught by the test suite rather than silently wedging a pool.
 * `createStaticRouteCapacityProvider` additionally applies a runtime floor of 1
 * as defense in depth.
 */
const slotCountSchema = z.number().int().positive()

/**
 * Run the load-time validation over a capacity map, throwing on the first
 * invalid value. Exported so the test suite can assert it rejects a mis-edit
 * without having to trip the module-load path.
 */
export function validateRouteCapacityMap(map: Readonly<Record<RouteCapability, number>>): void {
	for (const capability of ROUTE_CAPABILITIES) {
		slotCountSchema.parse(map[capability])
	}
}

// Fail fast at module load for a static mis-edit (test-visible).
validateRouteCapacityMap(STATIC_ROUTE_CAPACITY)

/**
 * Merge a user-adjustable partial capacity map over {@link STATIC_ROUTE_CAPACITY}
 * to produce the full per-capability map fed to {@link createStaticRouteCapacityProvider}.
 *
 * For each capability in {@link ROUTE_CAPABILITIES}, the effective slot count is
 * `userMap[cap]` only when it is a positive integer, else `STATIC_ROUTE_CAPACITY[cap]`.
 * An omitted, `undefined`, or invalid (0 / negative / non-integer) user entry
 * therefore falls back to today's static value — so `undefined`/`{}` merges to
 * exactly `STATIC_ROUTE_CAPACITY` (a byte-for-byte no-op for users who never set it).
 *
 * The floor-of-1 fail-safe and the bounded unknown-capability default still live
 * entirely in {@link createStaticRouteCapacityProvider}: a user value can only
 * REPLACE a slot count here, never defeat the `>= 1` floor or the bounded default.
 */
export function mergeRouteCapacityMap(
	userMap: Partial<Record<RouteCapability, number>> | undefined,
): Record<RouteCapability, number> {
	const merged = {} as Record<RouteCapability, number>
	for (const capability of ROUTE_CAPABILITIES) {
		const override = userMap?.[capability]
		merged[capability] =
			override !== undefined && Number.isInteger(override) && override > 0
				? override
				: STATIC_ROUTE_CAPACITY[capability]
	}
	return merged
}

/**
 * Capabilities already warned about this process, so a persistently unmapped
 * capability is logged once — not once per batch (design §Error handling,
 * finding #7). `createStaticRouteCapacityProvider` is constructed per batch, so
 * the dedupe set lives at module scope.
 */
const warnedCapabilities = new Set<RouteCapability>()

/**
 * Build a {@link RouteCapacityProvider} backed by a static per-capability slot
 * map (design §"Capacity-map data model"). `capacitiesFor(capability)` returns a
 * single synthetic {@link RouteCapacity} whose `available === capacity === slots`,
 * where `slots = max(1, map[capability] ?? DEFAULT_UNKNOWN_CAPABILITY_SLOTS)`.
 *
 * The floor of 1 is the central safety property: it guarantees
 * `liveCapacity() >= 1` for every capability, so {@link import("./InferenceLeasePool").InferenceLeasePool}
 * can always eventually grant a queued lease — no 0-capacity deadlock. The
 * bounded default (2) for an absent/invalid capability keeps an unknown
 * capability throttled, never flooded (no regression to the old always-12 stub).
 *
 * `sustainedPressure()` returns 0: this pass introduces no live pressure signal,
 * so new-fan-out backpressure stays off (unchanged from the prior stub). That is
 * safe because the per-capability lease pools now throttle generations directly.
 */
export function createStaticRouteCapacityProvider(
	map: Readonly<Record<RouteCapability, number>> = STATIC_ROUTE_CAPACITY,
): RouteCapacityProvider {
	return {
		capacitiesFor(capability: RouteCapability): readonly RouteCapacity[] {
			const configured = map[capability]
			if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
				if (!warnedCapabilities.has(capability)) {
					warnedCapabilities.add(capability)
					console.warn(
						`[RouteCapacityMap] capability "${capability}" is unmapped or invalid; ` +
							`falling back to ${DEFAULT_UNKNOWN_CAPABILITY_SLOTS} slots. ` +
							`Add it to STATIC_ROUTE_CAPACITY (kept in lockstep with OmniRoute PROVIDER_POLICIES).`,
					)
				}
			}
			// Floor of 1 guarantees forward progress; the bounded default throttles an
			// unknown capability without flooding it.
			const resolved =
				configured !== undefined && Number.isInteger(configured) && configured > 0
					? configured
					: DEFAULT_UNKNOWN_CAPABILITY_SLOTS
			const slots = Math.max(1, resolved)
			return [{ route: `static:${capability}`, capability, capacity: slots, available: slots }]
		},
		// No live pressure signal in this pass; the lease pools throttle directly.
		sustainedPressure(): number {
			return 0
		},
	}
}

/**
 * Reset the once-per-process fall-through warn dedupe. Test-only seam so a spec
 * can assert the warn fires at most once per capability without leaking state
 * across tests.
 */
export function resetRouteCapacityWarnings(): void {
	warnedCapabilities.clear()
}

/**
 * Seed {@link SchedulerBounds} from real route capacity (design §D "Seeding
 * `maxDispatched` / `maxInferenceLeases` from capacity"). Pure and injectable so
 * the seeding math is unit-testable without constructing a full batch.
 *
 *   capacitySum       = Σ_cap provider.capacitiesFor(cap)[*].available   (observability aggregate)
 *   maxPerCapability  = max_cap provider.capacitiesFor(cap)[*].available (largest single pool)
 *   maxInferenceLeases= max(1, capacitySum)                              (real slots aggregate, never 0)
 *   maxDispatched     = max(capacitySum, maxPerCapability, SMALL_FLOOR)  (before policy clamp)
 *   maxLive           = DEFAULT_SCHEDULER_BOUNDS.maxLive (12, unchanged)
 *
 * The returned `maxLive`/`maxDispatched` are the UNCLAMPED starting bounds; the
 * scheduler's own `clampCeiling` lowers them (never raises) by the
 * `UserParallelismPolicy`. `maxInferenceLeases` is an observability aggregate,
 * not an admission gate — the per-capability lease pools are the operative gate
 * — and may exceed distinct physical slots when two capabilities share one
 * backend (finding #6). The `maxPerCapability` term is what enforces the correct
 * liveness invariant (`maxDispatched >= largest single-capability capacity`, so
 * no pool's slots sit unfillable for want of a permit; finding #5).
 */
export function computeCapacityBounds(provider: RouteCapacityProvider): SchedulerBounds {
	let capacitySum = 0
	let maxPerCapability = 0
	for (const capability of ROUTE_CAPABILITIES) {
		let perCapability = 0
		for (const snapshot of provider.capacitiesFor(capability)) {
			perCapability += Math.max(0, snapshot.available)
		}
		capacitySum += perCapability
		if (perCapability > maxPerCapability) maxPerCapability = perCapability
	}
	return {
		maxLive: DEFAULT_SCHEDULER_BOUNDS.maxLive,
		maxDispatched: Math.max(capacitySum, maxPerCapability, SMALL_FLOOR),
		maxInferenceLeases: Math.max(1, capacitySum),
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Published-metadata-backed RouteCapacityProvider (omniroute-fleet-topology,
// task 13.3; Requirements 14.4, 14.5, 14.7, 14.8).
//
// OmniRoute's Route_Compiler publishes, per Public_Route, a RouteCapacity record
// (distinct local Slot count) and a Capability_Lane→Public_Route map. This
// provider folds those published records through the SAME `laneToRouteCapability`
// mapping the scheduler already uses, so the per-`RouteCapability` capacity the
// lease pools admit against is derived from real compiled slots instead of the
// hand-maintained `STATIC_ROUTE_CAPACITY`.
//
// Everything here is PURE: it consumes an already-fetched published catalog
// snapshot (the caller is responsible for the 5 s retrieval window and the
// background refresh; see `refreshPublishedCatalogIfStale`). It performs no I/O
// and derives no GPU/VRAM/node identity — only the capability/capacity
// abstraction (PAR-013), consistent with the static provider above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full `LaneTaskType` space, enumerated so the capability→lanes reverse index
 * can be derived from the authoritative `laneToRouteCapability` function rather
 * than duplicating its branch table. Requirement 14.4 maps a RouteCapability to
 * the lanes that `laneToRouteCapability` sends to it "for at least one task
 * type", so every task type must be probed.
 */
const ALL_LANE_TASK_TYPES: readonly LaneTaskType[] = [
	"lookup",
	"implementation",
	"debugging",
	"refactor",
	"test",
	"architecture",
	"adjudication",
	"long-horizon",
]

/**
 * Reverse index: for each {@link RouteCapability}, the set of {@link CapabilityLane}s
 * that {@link laneToRouteCapability} maps to it for AT LEAST ONE task type
 * (Requirement 14.4). Derived once from the authoritative mapping so it can never
 * drift from `laneToRouteCapability`'s branch table. `vision` maps from no lane,
 * so its set is empty — its published capacity is always 0 and it therefore falls
 * back to the static map (Requirement 14.7).
 */
export const CAPABILITY_TO_LANES: Readonly<Record<RouteCapability, readonly CapabilityLane[]>> = (() => {
	const index = {} as Record<RouteCapability, CapabilityLane[]>
	for (const capability of ROUTE_CAPABILITIES) {
		index[capability] = []
	}
	for (const lane of CAPABILITY_LANES) {
		const capabilities = new Set<RouteCapability>()
		for (const type of ALL_LANE_TASK_TYPES) {
			capabilities.add(laneToRouteCapability(lane, type))
		}
		for (const capability of capabilities) {
			index[capability].push(lane)
		}
	}
	return index
})()

/**
 * The published metadata a parallel batch snapshots at start, flattened from the
 * last successful catalog for the batch's OmniRoute server URL. The two maps are
 * the client-side view of OmniRoute's Published_Route_Metadata (Requirement 14.1,
 * 14.2):
 *   - `capabilityLane`: Capability_Lane name → the lane's own Public_Route name
 *     (never a Route_Alias).
 *   - `routeCapacity`: Public_Route name → distinct local Slot count.
 *
 * Both are plain string-keyed records so an older OmniRoute build that publishes
 * neither simply yields empty maps and the provider falls back (Requirement 14.5).
 */
export interface PublishedRouteMetadata {
	/** Capability_Lane name → the lane's own Public_Route name. */
	readonly capabilityLane: Readonly<Record<string, string>>
	/** Public_Route name → distinct local Slot count (non-negative integer). */
	readonly routeCapacity: Readonly<Record<string, number>>
}

/** The two outcomes of folding a catalog snapshot into {@link PublishedRouteMetadata}. */
export interface PublishedMetadataExtraction {
	/** The flattened published metadata, or `undefined` when the catalog carried none. */
	readonly metadata: PublishedRouteMetadata | undefined
	/**
	 * True when EVERY {@link CapabilityLane} is mapped to a Public_Route that has a
	 * non-negative-integer RouteCapacity record. When false, the published provider
	 * must fall back to the static map for the whole batch (Requirement 14.5).
	 */
	readonly complete: boolean
}

/**
 * Flatten an OmniRoute catalog snapshot into {@link PublishedRouteMetadata}.
 *
 * Each catalog entry may carry its own `capabilityLane` map and a single
 * `routeCapacity` record keyed by its own route name; this merges them across
 * entries into the two batch-wide maps. The result is marked `complete` only when
 * every one of the four {@link CapabilityLane}s resolves to a Public_Route that
 * also has a non-negative-integer RouteCapacity record — the exact precondition
 * Requirement 14.5 requires before the published map may be used.
 */
export function extractPublishedRouteMetadata(
	entries: readonly OmniRouteCatalogEntry[],
): PublishedMetadataExtraction {
	const capabilityLane: Record<string, string> = {}
	const routeCapacity: Record<string, number> = {}
	let sawAny = false

	for (const entry of entries) {
		if (entry.capabilityLane) {
			for (const [lane, route] of Object.entries(entry.capabilityLane)) {
				capabilityLane[lane] = route
				sawAny = true
			}
		}
		if (entry.routeCapacity) {
			routeCapacity[entry.routeCapacity.route] = entry.routeCapacity.capacity
			sawAny = true
		}
	}

	if (!sawAny) {
		return { metadata: undefined, complete: false }
	}

	// Complete iff every lane maps to a route that carries a non-negative-integer
	// capacity record (Requirement 14.5).
	const complete = CAPABILITY_LANES.every((lane) => {
		const route = capabilityLane[lane]
		if (route === undefined) return false
		const capacity = routeCapacity[route]
		return typeof capacity === "number" && Number.isInteger(capacity) && capacity >= 0
	})

	return { metadata: { capabilityLane, routeCapacity }, complete }
}

/**
 * Compute the published distinct-local-Slot count for one {@link RouteCapability}
 * from the flattened {@link PublishedRouteMetadata} (Requirement 14.4).
 *
 * The capacity is the number of distinct local Slots across the Public_Routes the
 * published Capability_Lane map assigns to the lanes that {@link CAPABILITY_TO_LANES}
 * resolves to this capability. A Slot shared by two Public_Routes is counted once;
 * since the published RouteCapacity is already a per-route distinct-Slot count and
 * two lanes may share a route, routes are de-duplicated by name before summing so
 * a shared route is not double-counted. A capability no lane maps to (e.g.
 * `vision`) yields 0, which the provider replaces with the static value
 * (Requirement 14.7).
 */
export function publishedCapacityForCapability(
	capability: RouteCapability,
	metadata: PublishedRouteMetadata,
): number {
	const lanes = CAPABILITY_TO_LANES[capability]
	const countedRoutes = new Set<string>()
	let total = 0
	for (const lane of lanes) {
		const route = metadata.capabilityLane[lane]
		if (route === undefined || countedRoutes.has(route)) continue
		const capacity = metadata.routeCapacity[route]
		if (typeof capacity === "number" && Number.isInteger(capacity) && capacity >= 0) {
			countedRoutes.add(route)
			total += capacity
		}
	}
	return total
}

/**
 * Build the full per-{@link RouteCapability} slot map from published metadata,
 * applying the two static/override fallbacks (Requirements 14.4, 14.7, 14.8).
 *
 * For each capability:
 *   1. Compute the published distinct-local-Slot count (above).
 *   2. If that count is 0 — including `vision`, which no lane maps to — use the
 *      static map value instead, honoring any operator per-capability override
 *      (Requirement 14.7).
 *   3. Otherwise, when the operator set a per-capability override LOWER than the
 *      published count, use the override (Requirement 14.8). A higher or absent
 *      override leaves the published count untouched.
 *
 * The returned map is a full `Record<RouteCapability, number>` ready for
 * {@link createStaticRouteCapacityProvider}, which still floors every value to
 * `>= 1`, so no published 0 can ever reach the lease pools as a deadlock.
 *
 * `staticMap` is the merged static+override map (from {@link mergeRouteCapacityMap}),
 * so a value in it already reflects the operator override folded over
 * `STATIC_ROUTE_CAPACITY`. `override` is the raw per-capability override the
 * operator set, consulted only for the lower-than-published rule (14.8).
 */
export function buildPublishedCapacityMap(
	metadata: PublishedRouteMetadata,
	staticMap: Readonly<Record<RouteCapability, number>>,
	override: Partial<Record<RouteCapability, number>> | undefined,
): Record<RouteCapability, number> {
	const result = {} as Record<RouteCapability, number>
	for (const capability of ROUTE_CAPABILITIES) {
		const published = publishedCapacityForCapability(capability, metadata)
		if (published <= 0) {
			// No published slots for this capability (0, or a capability no lane
			// maps to): fall back to the static value, which already folds the
			// operator override (Requirement 14.7).
			result[capability] = staticMap[capability]
			continue
		}
		const operatorOverride = override?.[capability]
		if (
			operatorOverride !== undefined &&
			Number.isInteger(operatorOverride) &&
			operatorOverride > 0 &&
			operatorOverride < published
		) {
			// A lower operator override wins over the published count (Requirement 14.8).
			result[capability] = operatorOverride
		} else {
			result[capability] = published
		}
	}
	return result
}

/**
 * Build a {@link RouteCapacityProvider} from published OmniRoute metadata, with a
 * full fall-through to the static map (Requirements 14.4, 14.5, 14.7, 14.8).
 *
 * When `extraction.complete` is false — the catalog carried no published metadata,
 * did not map every Capability_Lane to a Public_Route, or a mapped route lacked a
 * valid RouteCapacity record — this logs one warning naming which condition fired
 * and returns the plain static provider over `staticMap` (Requirement 14.5). The
 * caller enforces the 5 s retrieval window and passes an empty/incomplete
 * extraction when the window elapses, so the same fall-through covers the timeout.
 *
 * Otherwise it builds the published per-capability map (with the 14.7/14.8
 * fallbacks folded in) and hands it to {@link createStaticRouteCapacityProvider},
 * so the floor-of-1 and bounded-unknown safety still apply unchanged.
 *
 * @param staticMap the merged static+override map (from {@link mergeRouteCapacityMap}).
 * @param override the raw per-capability operator override (for the 14.8 rule).
 */
export function createPublishedRouteCapacityProvider(
	extraction: PublishedMetadataExtraction,
	staticMap: Readonly<Record<RouteCapability, number>> = STATIC_ROUTE_CAPACITY,
	override?: Partial<Record<RouteCapability, number>>,
): RouteCapacityProvider {
	if (!extraction.complete || extraction.metadata === undefined) {
		const reason =
			extraction.metadata === undefined
				? "no published route metadata was retrieved within the batch window"
				: "the published metadata did not map every capability lane to a public route with a valid capacity record"
		console.warn(
			`[RouteCapacityMap] falling back to the static capacity map: ${reason} ` +
				`(omniroute-fleet-topology Requirement 14.5).`,
		)
		return createStaticRouteCapacityProvider(staticMap)
	}
	return createStaticRouteCapacityProvider(buildPublishedCapacityMap(extraction.metadata, staticMap, override))
}
