import { z } from "zod"

import {
	DEFAULT_SCHEDULER_BOUNDS,
	ROUTE_CAPABILITIES,
	type RouteCapability,
	type RouteCapacity,
	type RouteCapacityProvider,
	type SchedulerBounds,
} from "./elasticTypes"

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
