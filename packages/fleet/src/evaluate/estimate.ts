// Arrangement_Evaluator — pre-deployment estimate replay (design §5,
// Requirements 21.1, 21.2, 21.5, 21.6).
//
// This is the production TypeScript port of the design-time prototype
// `.agents/tasks/omniroute-fleet-topology/arrangement-replay.py`. Its results
// are recorded in `arrangement-replay-results.md` in that same folder; the
// speed-model cross-check at the bottom of the test suite is anchored on those
// numbers.
//
// The file has two clearly-separated parts.
//
//   1. The REQUIREMENT 21 REPLAY (`estimateFreeLocalSlots`): the body-free,
//      deterministic estimate the requirement specifies. It groups the recorded
//      requests of the primary OmniRoute_Instance by correlation id over a FIXED
//      recorded window, assigns each request the FIRST FREE local Slot in its
//      Public_Route's Expanded_Target_Sequence (the compiled, fill-first order
//      of its lane's local Slots), holds that Slot from the request's start
//      (inclusive) to its end (exclusive), and reports the free-local-slot
//      fraction per Public_Route alongside the published RouteCapacity and the
//      baseline Local_Demand_Distribution. It reads only the body-free fields of
//      the durable copy (`CopiedAttempt`): `corr`, `ts`, `dur_ms`,
//      `requested_model`. It is deterministic over a fixed window (same window +
//      same records → same output) and marks `partial` (the window extends
//      before the earliest readable record) and `no-data` (no readable record)
//      per Requirement 21.6.
//
//   2. The SPEED MODEL (`simulateSpeedModel`): a CLEARLY-SEPARATED, OPTIONAL
//      extension used only for ranking and sizing, NOT a requirement. A plain
//      interval replay answers "would a free slot exist" but not "how fast".
//      The speed model converts each request to 5090-equivalent service seconds
//      and runs an open-loop processor-sharing simulation so moving a request to
//      a different card changes its service time. Its limits are stated in the
//      header comment on `simulateSpeedModel` below. Its A0 output is
//      cross-checked against `arrangement-replay-results.md` in the test suite.
//
// Purity / determinism (Property 11, Requirement 21.1): the Requirement 21
// replay is a pure function of (records, inventory, revision, window, baseline
// distribution). It has no clock, no env, no I/O; it takes the window bounds and
// the records as arguments. The one external call is the Route_Compiler, itself
// pure (compiler.ts documents this). So the same window + same records always
// produce the same output.

import type { FleetInventory, Lane } from "@roo-code/types"

import { compile, type CompileFailure, type Revision } from "../compile/compiler.js"
import { resolveDeviceAllocation } from "../compile/capacity.js"
import { orderLaneTargets } from "../compile/order.js"
import { slotTargetId } from "../compile/targets.js"
import type { CopiedAttempt } from "../observe/copy.js"

// ---------------------------------------------------------------------------
// Public types — Requirement 21 replay
// ---------------------------------------------------------------------------

/**
 * The baseline Local_Demand_Distribution (Requirement 21.2): the five
 * percentages for 0, 1, 2, 3, and 4-or-more local attempts already in flight at
 * a local request start, plus the derived P(≥2), P(≥3), P(≥4). The percentages
 * sum to 100 before rounding. For the initial baseline these are the
 * findings.md section 6 values (24.3, 51.7, 20.1, 2.9, 1.0; 24.0, 3.9, 1.0).
 */
export interface LocalDemandDistribution {
	/** [p0, p1, p2, p3, p4plus] — percentages that sum to ~100. */
	readonly inFlight: readonly [number, number, number, number, number]
	/** P(≥2 already active): p2 + p3 + p4plus. */
	readonly pGte2: number
	/** P(≥3 already active): p3 + p4plus. */
	readonly pGte3: number
	/** P(≥4 already active): p4plus. */
	readonly pGte4: number
}

/** The initial-baseline Local_Demand_Distribution recorded in findings.md §6 (Req 21.2). */
export const INITIAL_BASELINE_LOCAL_DEMAND: LocalDemandDistribution = {
	inFlight: [24.3, 51.7, 20.1, 2.9, 1.0],
	pGte2: 24.0,
	pGte3: 3.9,
	pGte4: 1.0,
}

/** How complete the replayed data is over the requested window (Requirement 21.6). */
export type DataCompleteness = "complete" | "partial" | "no-data"

/**
 * The free-local-slot result for one Public_Route (Requirement 21.1).
 * `noData` is true when the Public_Route has no replayed request, in which case
 * `freeFraction` is reported as `null`.
 */
export interface RouteFreeSlotResult {
	/** The Public_Route name (lane `names[0]`). */
	readonly route: string
	/** The number of replayed requests of this Public_Route. */
	readonly replayed: number
	/** The number of those requests that found a free local Slot. */
	readonly freeLocal: number
	/**
	 * freeLocal / replayed as a fraction in [0, 1], or `null` when the route has
	 * no replayed request (Requirement 21.1 "no data when the Public_Route has no
	 * replayed request").
	 */
	readonly freeFraction: number | null
	/** The published RouteCapacity for this Public_Route (Requirement 21.2). */
	readonly capacity: number
}

/**
 * One requested model id that was excluded from the replay because it did not
 * equal, by exact case-sensitive comparison, the name or a Route_Alias of any of
 * the primary's Public_Routes (Requirement 21.1).
 */
export interface ExcludedRequestedModel {
	readonly requestedModel: string
	readonly count: number
}

/** The full pre-deployment estimate result (Requirements 21.1, 21.2, 21.6). */
export interface EstimateResult {
	/** Per-Public_Route free-local-slot fractions and RouteCapacity. */
	readonly routes: readonly RouteFreeSlotResult[]
	/** Requested model ids with no matching Public_Route, with their counts. */
	readonly excluded: readonly ExcludedRequestedModel[]
	/** The baseline Local_Demand_Distribution reported next to the capacities (Req 21.2). */
	readonly localDemand: LocalDemandDistribution
	/**
	 * The number of distinct local Slots of all those Public_Routes OTHER than
	 * the embeddings and rerank Public_Routes, counted as Requirement 14.4 counts
	 * Slots (Requirement 21.2).
	 */
	readonly distinctLocalSlots: number
	/** complete / partial / no-data over the requested window (Requirement 21.6). */
	readonly completeness: DataCompleteness
	/**
	 * When `completeness` is `partial`, the span the readable records actually
	 * cover, as [earliestRecordMs, latestRecordMs]; `null` otherwise
	 * (Requirement 21.6).
	 */
	readonly coveredSpan: readonly [number, number] | null
	/** The requested fixed window, as [startMs, endMs). */
	readonly window: readonly [number, number]
}

/** The fixed recorded window the replay runs over, as epoch ms [start, end). */
export interface EstimateWindow {
	readonly startMs: number
	/** Exclusive end. A request belongs to the window when its final attempt completes in [start, end). */
	readonly endMs: number
}

/**
 * The input to the Requirement 21 replay. `records` are the body-free copied
 * attempts the primary OmniRoute_Instance recorded (Health_Probes already
 * excluded by the caller — the durable copy marks them, Requirement 16.12). The
 * `window` is fixed; `localDemand` is the baseline distribution to report.
 */
export interface EstimateInput {
	readonly inventory: FleetInventory
	readonly revision: Revision
	readonly records: readonly CopiedAttempt[]
	readonly window: EstimateWindow
	readonly localDemand: LocalDemandDistribution
}

/** The embeddings/rerank route capability tags excluded from the distinct-slot count (Req 21.2). */
const EMBED_RERANK_TAGS = ["embed", "rerank"] as const

// ---------------------------------------------------------------------------
// Internal: a grouped request over the fixed window
// ---------------------------------------------------------------------------

/** One request (correlation id) reduced to the fields the replay needs. */
interface ReplayRequest {
	readonly corr: string
	/** Start of the first attempt, in ms: min over attempts of (completion − dur). */
	readonly startMs: number
	/** Completion of the final attempt, in ms: max over attempts of completion. */
	readonly endMs: number
	/** The requested model id of the final attempt (exact, case-sensitive). */
	readonly requestedModel: string | null
}

/** A compiled local Slot of a Public_Route's Expanded_Target_Sequence. */
interface CompiledSlot {
	/** The stable Target_Identifier of the Slot. */
	readonly id: string
	/** The Device the Slot resides on (for the per-Device allocation cap). */
	readonly deviceId: string
}

/** The compiled local target sequence of one Public_Route plus its aliases. */
interface CompiledRoute {
	readonly lane: Lane
	readonly route: string
	/** Public_Route name + every Route_Alias — the names a request may request. */
	readonly names: readonly string[]
	/** The ordered local Slots (fill-first), i.e. the local part of the Expanded_Target_Sequence. */
	readonly orderedSlots: readonly CompiledSlot[]
	/** The published RouteCapacity (Requirement 14.1). */
	readonly capacity: number
}

// ---------------------------------------------------------------------------
// Requirement 21 replay
// ---------------------------------------------------------------------------

/**
 * Run the Requirement 21 pre-deployment estimate replay over a FIXED recorded
 * window (Requirements 21.1, 21.2, 21.6).
 *
 * Returns the Route_Compiler failure(s) when the candidate revision does not
 * compile (Requirement 21.5 is handled by the caller surfacing the same failure
 * list; here a failed compile yields a `{ ok: false }` result so the caller can
 * report the errors and produce no estimate).
 */
export type EstimateOutcome =
	| { readonly ok: true; readonly estimate: EstimateResult }
	| { readonly ok: false; readonly failures: readonly CompileFailure[] }

export function estimateFreeLocalSlots(input: EstimateInput): EstimateOutcome {
	const compiled = compile(input.inventory, input.revision)
	if (!compiled.ok) {
		return { ok: false, failures: compiled.failures }
	}

	const primary = input.inventory.instances.find((inst) => inst.role === "primary")
	// The capacities are measured against the primary (compiler.ts). Build the
	// per-Public_Route compiled local Slot sequence and capacity map.
	const capacityByRoute = new Map<string, number>()
	if (primary) {
		const state = compiled.states.get(primary.id)
		if (state) {
			for (const cap of state.publishedMetadata.capacities) {
				capacityByRoute.set(cap.route, cap.capacity)
			}
		}
	}

	const routes = buildCompiledRoutes(input.inventory, capacityByRoute)

	// --- Group the records into requests over the fixed window ---------------
	const grouped = groupRequests(input.records, input.window)
	const completeness = classifyCompleteness(input.records, input.window, grouped.coveredSpan)

	// Map every requestable name (Public_Route + aliases) to its CompiledRoute.
	const routeByName = new Map<string, CompiledRoute>()
	for (const route of routes) {
		for (const name of route.names) {
			routeByName.set(name, route)
		}
	}

	// Partition the window's requests into those that match a Public_Route name
	// or alias (replayed) and those that do not (excluded), by exact,
	// case-sensitive comparison on the requested model id (Requirement 21.1).
	const replayed: { request: ReplayRequest; route: CompiledRoute }[] = []
	const excludedCounts = new Map<string, number>()
	for (const request of grouped.requests) {
		const name = request.requestedModel
		const route = name === null ? undefined : routeByName.get(name)
		if (route) {
			replayed.push({ request, route })
		} else {
			const key = name ?? ""
			excludedCounts.set(key, (excludedCounts.get(key) ?? 0) + 1)
		}
	}

	// --- One pass: ascending start time, then correlation id -----------------
	// (Requirement 21.1 "processes the replayed requests of all those
	// Public_Routes in one pass, in ascending order of start time and then of
	// correlation id".)
	replayed.sort((a, b) => {
		if (a.request.startMs !== b.request.startMs) {
			return a.request.startMs - b.request.startMs
		}
		return compareIds(a.request.corr, b.request.corr)
	})

	// Per-Public_Route tallies of replayed/free.
	const tally = new Map<string, { replayed: number; free: number }>()
	for (const route of routes) {
		tally.set(route.route, { replayed: 0, free: 0 })
	}

	// The slot-holder model: a request holds a specific Slot id over [start,end).
	// A Slot is free at a request's start when no replayed request currently
	// holds it AND its Device has fewer held Slots than the Device_Allocation on
	// the primary (Requirement 21.1). We model held intervals with an
	// event-ordered sweep: before placing each request, release every Slot whose
	// holder has ended at or before this request's start (half-open: a Slot freed
	// exactly at `start` is available).
	const held = new SlotHoldState(input.inventory, primary?.id)
	for (const { request, route } of replayed) {
		held.releaseEndedAt(request.startMs)
		const slot = held.firstFreeSlot(route.orderedSlots)
		const t = tally.get(route.route)!
		t.replayed += 1
		if (slot) {
			t.free += 1
			held.hold(slot, request.endMs)
		}
	}

	const routeResults: RouteFreeSlotResult[] = routes.map((route) => {
		const t = tally.get(route.route)!
		return {
			route: route.route,
			replayed: t.replayed,
			freeLocal: t.free,
			freeFraction: t.replayed === 0 ? null : t.free / t.replayed,
			capacity: route.capacity,
		}
	})

	const excluded: ExcludedRequestedModel[] = [...excludedCounts.entries()]
		.map(([requestedModel, count]) => ({ requestedModel, count }))
		.sort((a, b) => compareIds(a.requestedModel, b.requestedModel))

	return {
		ok: true,
		estimate: {
			routes: routeResults,
			excluded,
			localDemand: input.localDemand,
			distinctLocalSlots: countDistinctLocalSlots(routes),
			completeness,
			coveredSpan: completeness === "partial" ? grouped.coveredSpan : null,
			window: [input.window.startMs, input.window.endMs],
		},
	}
}

// ---------------------------------------------------------------------------
// Request grouping (Requirement 16.9, 21.1)
// ---------------------------------------------------------------------------

/**
 * Group copied attempts by correlation id and assign each request to the window
 * as Requirement 16 criterion 9 specifies: a request belongs to the window when
 * its FINAL attempt completes in [start, end). A request starts at the start of
 * its first attempt (completion − dur_ms) and ends at the completion of its
 * final attempt (Requirement 16 criteria 3 and 9). The requested model id is the
 * final attempt's `requested_model`.
 */
function groupRequests(
	records: readonly CopiedAttempt[],
	window: EstimateWindow,
): { requests: ReplayRequest[]; coveredSpan: [number, number] | null } {
	// Collect attempts per correlation id, tracking the min start, the final
	// (latest completion) attempt, and that attempt's requested model id.
	interface Agg {
		startMs: number
		finalEndMs: number
		finalRequestedModel: string | null
	}
	const byCorr = new Map<string, Agg>()
	let earliest = Number.POSITIVE_INFINITY
	let latest = Number.NEGATIVE_INFINITY

	for (const record of records) {
		if (record.corr === null) {
			continue // a request without a correlation id cannot be grouped.
		}
		const endMs = Date.parse(record.ts)
		if (Number.isNaN(endMs)) {
			continue
		}
		const durMs = record.dur_ms ?? 0
		const startMs = endMs - durMs
		earliest = Math.min(earliest, startMs)
		latest = Math.max(latest, endMs)

		const prev = byCorr.get(record.corr)
		if (!prev) {
			byCorr.set(record.corr, { startMs, finalEndMs: endMs, finalRequestedModel: record.requested_model })
			continue
		}
		prev.startMs = Math.min(prev.startMs, startMs)
		// The final attempt is the one with the latest completion; ties keep the
		// first seen so the choice is deterministic over a fixed record set.
		if (endMs > prev.finalEndMs) {
			prev.finalEndMs = endMs
			prev.finalRequestedModel = record.requested_model
		}
	}

	const requests: ReplayRequest[] = []
	for (const [corr, agg] of byCorr) {
		// Requirement 16.9: a request belongs to the window when its final attempt
		// completes in [start, end).
		if (agg.finalEndMs >= window.startMs && agg.finalEndMs < window.endMs) {
			requests.push({
				corr,
				startMs: agg.startMs,
				endMs: agg.finalEndMs,
				requestedModel: agg.finalRequestedModel,
			})
		}
	}

	const coveredSpan: [number, number] | null =
		earliest === Number.POSITIVE_INFINITY ? null : [earliest, latest]
	return { requests, coveredSpan }
}

/**
 * Classify how complete the data is over the requested window (Requirement
 * 21.6): `no-data` when no record is readable at all, `partial` when the window
 * extends before the earliest readable record (the readable records cover only
 * part of the window), and `complete` otherwise.
 */
function classifyCompleteness(
	records: readonly CopiedAttempt[],
	window: EstimateWindow,
	coveredSpan: readonly [number, number] | null,
): DataCompleteness {
	if (records.length === 0 || coveredSpan === null) {
		return "no-data"
	}
	// The window extends before the earliest readable record → partial.
	return coveredSpan[0] > window.startMs ? "partial" : "complete"
}

// ---------------------------------------------------------------------------
// Compiled routes + the Slot-hold sweep
// ---------------------------------------------------------------------------

/**
 * Build the per-Public_Route compiled local Slot sequence (the local part of the
 * Expanded_Target_Sequence) and attach each route's published RouteCapacity. The
 * local Slots are ordered exactly as the compiler orders them (fill-first,
 * `orderLaneTargets` → `orderLocalSlots`), so the first-free-Slot assignment uses
 * the same order the live OmniRoute dispatch would.
 */
function buildCompiledRoutes(inventory: FleetInventory, capacityByRoute: Map<string, number>): CompiledRoute[] {
	const routes: CompiledRoute[] = []
	for (const lane of inventory.lanes) {
		const ordered = orderLaneTargets(inventory.offerings, inventory.clouds, lane)
		const orderedSlots: CompiledSlot[] = ordered.localSlots.map((slot) => ({
			id: slotTargetId(slot),
			deviceId: slot.offering.deviceId,
		}))
		const route = lane.names[0]!
		routes.push({
			lane,
			route,
			names: lane.names,
			orderedSlots,
			capacity: capacityByRoute.get(route) ?? 0,
		})
	}
	return routes
}

/**
 * The number of distinct local Slots of all those Public_Routes OTHER than the
 * embeddings and rerank Public_Routes, counted as Requirement 14.4 counts Slots:
 * distinct by Target_Identifier (Requirement 21.2). A lane is an embeddings or
 * rerank route when it requires the `embed` or `rerank` capability tag.
 */
function countDistinctLocalSlots(routes: readonly CompiledRoute[]): number {
	const ids = new Set<string>()
	for (const route of routes) {
		const isEmbedRerank = route.lane.capabilities.some((cap) =>
			(EMBED_RERANK_TAGS as readonly string[]).includes(cap),
		)
		if (isEmbedRerank) {
			continue
		}
		for (const slot of route.orderedSlots) {
			ids.add(slot.id)
		}
	}
	return ids.size
}

/**
 * The slot-hold sweep (Requirement 21.1). A replayed request holds a specific
 * local Slot over [start, end). A Slot is free at a request's start when:
 *   - no replayed request currently holds it, AND
 *   - its Device has fewer held Slots than the Slots the candidate revision
 *     allocates to the primary OmniRoute_Instance on that Device (the
 *     Device_Slot_Ceiling where no allocation is recorded).
 * The sweep releases every Slot whose holder ended at or before the current
 * request's start before each placement (half-open intervals: a Slot freed
 * exactly at `start` is available).
 */
class SlotHoldState {
	/** Slot id → the end time (ms) of the request currently holding it. */
	private readonly heldUntil = new Map<string, number>()
	/** Device id → the number of its Slots currently held. */
	private readonly deviceHeld = new Map<string, number>()
	/** Device id → the end times of currently-held Slots on it (to decrement on release). */
	private readonly deviceEndTimes = new Map<string, number[]>()
	/** Device id → the per-Device allocation cap on the primary. */
	private readonly allocationCache = new Map<string, number>()

	constructor(
		private readonly inventory: FleetInventory,
		private readonly primaryId: string | undefined,
	) {}

	/** Release every Slot whose holder ended at or before `nowMs` (half-open). */
	releaseEndedAt(nowMs: number): void {
		for (const [slotId, until] of this.heldUntil) {
			if (until <= nowMs) {
				this.heldUntil.delete(slotId)
			}
		}
		// Rebuild per-Device held counts from the surviving holders' devices is
		// avoided; instead each Device tracks its held end times and we prune them.
		for (const [deviceId, times] of this.deviceEndTimes) {
			const survivors = times.filter((until) => until > nowMs)
			if (survivors.length === 0) {
				this.deviceEndTimes.delete(deviceId)
				this.deviceHeld.delete(deviceId)
			} else {
				this.deviceEndTimes.set(deviceId, survivors)
				this.deviceHeld.set(deviceId, survivors.length)
			}
		}
	}

	/**
	 * The first free Slot in `orderedSlots`, or `undefined` when none is free.
	 * "Free" is the Requirement 21.1 definition: not currently held and its Device
	 * under its primary allocation cap.
	 */
	firstFreeSlot(orderedSlots: readonly CompiledSlot[]): CompiledSlot | undefined {
		for (const slot of orderedSlots) {
			if (this.heldUntil.has(slot.id)) {
				continue
			}
			const cap = this.allocationFor(slot.deviceId)
			const used = this.deviceHeld.get(slot.deviceId) ?? 0
			if (used >= cap) {
				continue
			}
			return slot
		}
		return undefined
	}

	/** Hold `slot` until `endMs`. */
	hold(slot: CompiledSlot, endMs: number): void {
		this.heldUntil.set(slot.id, endMs)
		this.deviceHeld.set(slot.deviceId, (this.deviceHeld.get(slot.deviceId) ?? 0) + 1)
		const times = this.deviceEndTimes.get(slot.deviceId) ?? []
		times.push(endMs)
		this.deviceEndTimes.set(slot.deviceId, times)
	}

	private allocationFor(deviceId: string): number {
		const cached = this.allocationCache.get(deviceId)
		if (cached !== undefined) {
			return cached
		}
		const alloc =
			this.primaryId === undefined ? 0 : resolveDeviceAllocation(this.inventory, deviceId, this.primaryId)
		this.allocationCache.set(deviceId, alloc)
		return alloc
	}
}

/** Ascending lexicographic compare over code units, stable and locale-free. */
function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

// ===========================================================================
// SPEED MODEL — optional ranking/sizing extension (NOT a Requirement)
// ===========================================================================
//
// A plain Requirement-21 interval replay answers "would a free Slot exist" but
// not "how fast". The speed model, ported from `arrangement-replay.py`, adds a
// per-card service-time model so moving a request to a different card changes
// its latency. It is used ONLY to rank candidate Arrangements and to size a new
// card; nothing in Requirement 21 depends on it, and the deterministic replay
// above never calls into it.
//
// LIMITS / ASSUMPTIONS (carried verbatim-in-spirit from the prototype's header
// and design §5 "The speed model"):
//   - Open loop: faster routes do not pull more demand in (real agents wait for
//     their last answer, so a single service-time scale is fitted so simulated
//     A0 matches the observed mean; comparisons are reported at that scale).
//   - No prefix-cache affinity.
//   - Failed-attempt waste other than the 600 s target timeout is not modelled.
//   - Speed ratios are medians fitted from the baseline extract.
//   - Memory feasibility of an Arrangement is NOT checked.
//   - Treat the output as a ranking and sizing aid; the Requirement 21
//     post-deployment check decides after deployment.
//
// The fitted constants below are the ones `arrangement-replay-results.md`
// records for the 2026-10-07→14 baseline window. They are exported so the test
// suite can cross-check the port's A0 behaviour against that artifact. A
// production caller that re-fits from a different window supplies its own
// `SpeedModelParams`.

/** Fitted speed-model constants (from `arrangement-replay-results.md`, section "Fitted speed model"). */
export interface SpeedModelParams {
	/** 5090 two-stream slowdown f2 (duration multiplier when two streams run). */
	readonly f2: number
	/** Per-card duration multiplier vs the 5090 (uncontended), keyed by card. */
	readonly cardMultiplier: Readonly<Record<string, number>>
	/** Measured Ollama model-switch TTFT cost in seconds (findings 5.3). */
	readonly swapSeconds: number
	/** Target timeout in seconds (targetTimeoutMs on the tier-1 pools). */
	readonly targetTimeoutSeconds: number
	/** Service-time scale (open-loop calibration; A0 chosen scale is 0.90). */
	readonly scale: number
}

/** The fitted constants `arrangement-replay-results.md` records for the baseline window. */
export const BASELINE_SPEED_MODEL: SpeedModelParams = {
	f2: 1.78,
	cardMultiplier: { "5090": 1.0, "4070-27B": 2.98, "M5-Uzu": 8.78 },
	swapSeconds: 8.5,
	targetTimeoutSeconds: 600,
	scale: 0.9,
}

/** One replayed unit of work, in 5090-equivalent uncontended seconds. */
export interface SpeedWorkItem {
	/** The Public_Route this request belongs to. */
	readonly route: string
	/** Arrival time (request start) in seconds. */
	readonly startSeconds: number
	/** 5090-equivalent uncontended service seconds. */
	readonly work5090Seconds: number
	/** Input token count (for context-window Slot skips). */
	readonly inputTokens: number
}

/** One slot in a speed-model arrangement: a device, the card serving it, and its context window. */
export interface SpeedSlot {
	/** The physical device key (streams on one device share its slowdown). */
	readonly device: string
	/** The card id, keying into `SpeedModelParams.cardMultiplier`. */
	readonly card: string
	/** The Served_Context_Window; a request larger than this skips the slot. */
	readonly contextWindow: number
}

/** The per-route landing + latency summary of a speed-model run. */
export interface SpeedRouteSummary {
	readonly route: string
	readonly count: number
	readonly meanSeconds: number
	readonly p50Seconds: number
	readonly p95Seconds: number
	/** Percentage of requests that landed on cloud (no local slot free in time). */
	readonly cloudPercent: number
}

/**
 * The two-stream slowdown of the 5090 as a function of the in-flight count on
 * its device: 1 while one stream runs, rising toward f2 as a second starts,
 * clamped at four concurrent streams (ported from `g5090`).
 */
export function g5090(inFlight: number, f2: number): number {
	return 1.0 + (f2 - 1.0) * Math.max(0.0, Math.min(inFlight - 1.0, 4.0))
}

/**
 * Open-loop processor-sharing simulation (ported from the prototype's
 * `simulate`, trimmed to the pool lane without the reader queue, which the
 * design-time cross-check does not need). Each request takes the first free
 * eligible slot in `orderedSlots`; a request larger than a slot's context window
 * skips it; the 5090 slows every active stream on its device by `g5090` when two
 * run; a request not answered within the target timeout falls through to the
 * next slot, and a request that finds no free slot in time lands on cloud.
 *
 * This is OPTIONAL ranking/sizing machinery — see the LIMITS header above. It is
 * a pure function of its arguments (no clock, no I/O).
 */
export function simulateSpeedModel(
	items: readonly SpeedWorkItem[],
	orderedSlots: readonly SpeedSlot[],
	params: SpeedModelParams,
): SpeedRouteSummary[] {
	interface Job {
		readonly slotIndex: number
		readonly device: string
		remaining: number
		readonly route: string
		readonly startSeconds: number
		readonly deadline: number
		readonly fromIndex: number
		readonly item: SpeedWorkItem
	}
	interface Done {
		readonly route: string
		readonly latency: number
		readonly cloud: boolean
	}

	const arrivals = [...items].sort((a, b) =>
		a.startSeconds !== b.startSeconds ? a.startSeconds - b.startSeconds : compareIds(a.route, b.route),
	)
	const occupied = new Set<number>()
	const deviceInFlight = new Map<string, number>()
	const jobs: Job[] = []
	const done: Done[] = []
	let now = 0
	let ai = 0

	const slowdown = (device: string): number =>
		device === "5090" ? g5090(deviceInFlight.get(device) ?? 0, params.f2) : 1.0

	const workFor = (item: SpeedWorkItem, card: string): number =>
		item.work5090Seconds * (params.cardMultiplier[card] ?? 1.0) * params.scale

	const place = (item: SpeedWorkItem, route: string, start: number, fromIndex: number): boolean => {
		for (let i = fromIndex; i < orderedSlots.length; i++) {
			const slot = orderedSlots[i]!
			if (item.inputTokens > slot.contextWindow) {
				continue
			}
			if (occupied.has(i)) {
				continue
			}
			occupied.add(i)
			deviceInFlight.set(slot.device, (deviceInFlight.get(slot.device) ?? 0) + 1)
			jobs.push({
				slotIndex: i,
				device: slot.device,
				remaining: workFor(item, slot.card),
				route,
				startSeconds: start,
				deadline: now + params.targetTimeoutSeconds,
				fromIndex: i,
				item,
			})
			return true
		}
		return false
	}

	while (ai < arrivals.length || jobs.length > 0) {
		const tArrival = ai < arrivals.length ? arrivals[ai]!.startSeconds : Number.POSITIVE_INFINITY
		let tJob = Number.POSITIVE_INFINITY
		for (const job of jobs) {
			const finish = now + job.remaining * slowdown(job.device)
			tJob = Math.min(tJob, Math.min(finish, job.deadline))
		}
		const T = Math.min(tArrival, tJob)
		if (!Number.isFinite(T)) {
			break
		}
		const step = Math.max(T - now, 0)
		for (const job of jobs) {
			job.remaining -= step / slowdown(job.device)
		}
		now = T

		if (T === tJob && jobs.length > 0) {
			// Pick the job whose event time is now (finished or timed out).
			let idx = -1
			for (let j = 0; j < jobs.length; j++) {
				const job = jobs[j]!
				if (job.remaining <= 1e-7 || job.deadline <= now + 1e-7) {
					idx = j
					break
				}
			}
			if (idx >= 0) {
				const job = jobs[idx]!
				jobs.splice(idx, 1)
				occupied.delete(job.slotIndex)
				deviceInFlight.set(job.device, (deviceInFlight.get(job.device) ?? 1) - 1)
				if (job.remaining <= 1e-7) {
					done.push({ route: job.route, latency: now - job.startSeconds, cloud: false })
				} else if (!place(job.item, job.route, job.startSeconds, job.fromIndex + 1)) {
					done.push({ route: job.route, latency: now - job.startSeconds, cloud: true })
				}
				continue
			}
		}
		if (T === tArrival && ai < arrivals.length) {
			const item = arrivals[ai]!
			ai += 1
			if (!place(item, item.route, item.startSeconds, 0)) {
				done.push({ route: item.route, latency: 0, cloud: true })
			}
		}
	}

	return summarizeByRoute(done)
}

/** Summarize completed speed-model jobs per route. */
function summarizeByRoute(done: readonly { route: string; latency: number; cloud: boolean }[]): SpeedRouteSummary[] {
	const byRoute = new Map<string, { latencies: number[]; cloud: number }>()
	for (const d of done) {
		const bucket = byRoute.get(d.route) ?? { latencies: [], cloud: 0 }
		bucket.latencies.push(d.latency)
		if (d.cloud) {
			bucket.cloud += 1
		}
		byRoute.set(d.route, bucket)
	}
	const out: SpeedRouteSummary[] = []
	for (const [route, bucket] of byRoute) {
		const n = bucket.latencies.length
		out.push({
			route,
			count: n,
			meanSeconds: n === 0 ? 0 : bucket.latencies.reduce((s, x) => s + x, 0) / n,
			p50Seconds: percentile(bucket.latencies, 50),
			p95Seconds: percentile(bucket.latencies, 95),
			cloudPercent: n === 0 ? 0 : (100 * bucket.cloud) / n,
		})
	}
	return out.sort((a, b) => compareIds(a.route, b.route))
}

/** The prototype's percentile convention (`pct`): nearest-rank, ceil(n*p/100), min index 1. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) {
		return Number.NaN
	}
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.max(1, Math.ceil((sorted.length * p) / 100))
	return sorted[rank - 1]!
}
