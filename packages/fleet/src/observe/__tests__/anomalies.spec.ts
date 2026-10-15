import type { Device, FleetInventory, Instance, Lane, ModelOffering } from "@roo-code/types"
import { describe, expect, it, vi } from "vitest"

import type { Attribution } from "../attribution.js"
import type { CopiedAttempt, StoredRow } from "../copy.js"
import {
	ALERT_GIVE_UP_MS,
	ALERT_RETRY_INTERVAL_MS,
	PRESERVATION_FLOORS,
	bucketOf,
	detectAnomalies,
	nearestRank,
	writeAlerts,
	type Anomaly,
	type AnomalyInput,
	type BusySlotSkip,
	type ConcurrencyBounds,
	type RouteMembershipLookup,
	type TargetRouteMemberships,
	type UnreadableSpan,
} from "../anomalies.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLUSTER = "cluster"
const NOW = Date.parse("2026-10-14T00:00:00.000Z")

function device(id: string, overrides: Partial<Device> = {}): Device {
	return { id, slotCeiling: 2, hostPreemption: false, ...overrides }
}

function offering(id: string, overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id,
		endpointId: "ep",
		deviceId: "gpu0",
		modelId: id,
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat"],
		ranks: [1, 3],
		...overrides,
	}
}

function lane(id: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id,
		names: [id],
		capabilities: ["chat"],
		minContext: 1,
		order: "fill-first",
		maxSpend: "paid",
		spillTiers: [],
		failClosed: false,
		maxQueueMs: 30_000,
		capabilityLanes: [],
		...overrides,
	}
}

function primaryInstance(overrides: Partial<Instance> = {}): Instance {
	return { id: CLUSTER, role: "primary", address: "http://omni", backupRetention: 20, ...overrides }
}

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device("gpu0")],
		endpoints: [],
		residencyGroups: [{ id: "r0", swapLatencyMs: 8_500 }],
		offerings: [offering("coder")],
		clouds: [],
		lanes: [],
		instances: [primaryInstance()],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

/** A stored row from a partial `CopiedAttempt`, defaulting the body-free fields. */
function row(fields: Partial<CopiedAttempt>, extra: Partial<StoredRow> = {}): StoredRow {
	const full: CopiedAttempt = {
		ts: "2026-10-13T12:00:00.000Z",
		dur_ms: 10_000,
		status: 200,
		provider: "vllm",
		model: "coder-model",
		requested_model: "hybrid/code",
		connection_id: "conn-0",
		tin: 20_000,
		tout: 200,
		key: "zoo-m5",
		combo: "hybrid/code",
		step: null,
		corr: "c1",
		exec: null,
		etype: null,
		ttft: 2_000,
		wait: 0,
		...fields,
	}
	return {
		rowId: `${full.corr ?? ""}:${full.ts}:${Math.random()}`,
		instanceId: CLUSTER,
		isHealthProbe: false,
		fields: full,
		...extra,
	}
}

/**
 * A direct attribution driven by optional per-row projections, so the detectors
 * are exercised without the full revision machinery. Defaults: a local attempt
 * on gpu0/coder, requested route = the row's `requested_model`.
 */
function attributeBy(opts: {
	deviceOf?: (f: CopiedAttempt) => string | null
	offeringOf?: (f: CopiedAttempt) => string | null
	cloudOf?: (f: CopiedAttempt) => string | null
	routeOf?: (f: CopiedAttempt) => string | null
} = {}): (r: StoredRow) => Attribution {
	return (r: StoredRow): Attribution => {
		const f = r.fields
		const cloudTargetId = opts.cloudOf ? opts.cloudOf(f) : null
		const deviceId = cloudTargetId !== null ? null : opts.deviceOf ? opts.deviceOf(f) : "gpu0"
		return {
			instanceId: r.instanceId,
			activeRevision: "rev",
			deviceId,
			modelOfferingId: cloudTargetId !== null ? null : opts.offeringOf ? opts.offeringOf(f) : "coder",
			servingEndpointId: deviceId === null ? null : "ep",
			cloudTargetId,
			publicRoute: opts.routeOf ? opts.routeOf(f) : (f.requested_model ?? null),
			laneId: null,
			capabilityLane: null,
			isUnattributed: false,
			reasons: [],
		}
	}
}

/** A no-op route membership lookup (one Public_Route per offering by convention). */
function membershipsFor(map: Record<string, Partial<TargetRouteMemberships>> = {}): RouteMembershipLookup {
	return (key) => {
		const id = key.modelOfferingId ?? key.cloudTargetId ?? key.deviceId ?? ""
		const m = map[id] ?? {}
		return {
			publicRoutes: m.publicRoutes ?? [],
			routeAliases: m.routeAliases ?? [],
			internalPools: m.internalPools ?? [],
			diagnosticRoutes: m.diagnosticRoutes ?? [],
		}
	}
}

/** Concurrency bounds from a declared inventory (offering slots / device ceiling). */
function boundsFromInventory(
	inv: FleetInventory,
	allocation: (instanceId: string, deviceId: string) => number | null = () => null,
): ConcurrencyBounds {
	const slots = new Map(inv.offerings.map((o) => [o.id, o.slots]))
	const ceilings = new Map(inv.devices.map((d) => [d.id, d.slotCeiling]))
	return {
		offeringSlots: (id) => slots.get(id) ?? null,
		deviceCeiling: (id) => ceilings.get(id) ?? null,
		instanceDeviceAllocation: allocation,
	}
}

function baseInput(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
	const inv = overrides.inventory ?? inventory()
	return {
		rows: [],
		busySlotSkips: [],
		attribute: attributeBy(),
		attributeSkip: () => ({
			instanceId: CLUSTER,
			activeRevision: "rev",
			deviceId: "gpu0",
			modelOfferingId: "coder",
			servingEndpointId: "ep",
			cloudTargetId: null,
			publicRoute: null,
			laneId: null,
			capabilityLane: null,
			isUnattributed: false,
			reasons: [],
		}),
		inventory: inv,
		routeMemberships: membershipsFor(),
		concurrencyBounds: boundsFromInventory(inv),
		nowMs: NOW,
		...overrides,
	}
}

function ofKind(anomalies: readonly Anomaly[], kind: Anomaly["kind"]): Anomaly[] {
	return anomalies.filter((a) => a.kind === kind)
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("nearestRank / bucketOf", () => {
	it("computes nearest-rank p50 and buckets", () => {
		expect(nearestRank([10, 20, 30, 40, 50], 50)).toBe(30)
		expect(nearestRank([], 50)).toBeNull()
		expect(bucketOf(9_999)).toBeNull()
		expect(bucketOf(20_000)).toBe("10-50k")
		expect(bucketOf(100_000)).toBe("100k+")
	})
})

// ---------------------------------------------------------------------------
// 18.1 — Capacity_Leak (the live 4070 regression fixture)
// ---------------------------------------------------------------------------

describe("Capacity_Leak (Requirement 18.1)", () => {
	// The live 4070 fault window: busy-slot skips of the 4070 target more than 5
	// minutes apart with NO attempt in flight on the device between them.
	const t0 = Date.parse("2026-10-13T22:28:00.000Z")

	function skip(tsMs: number): BusySlotSkip {
		return { instanceId: CLUSTER, ts: iso(tsMs), targetId: "coder-slot-0" }
	}

	it("fires on two skips >5 min apart with nothing in flight on the device (4070 regression)", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 6 * 60_000)]
		const anomalies = detectAnomalies(
			baseInput({
				busySlotSkips: skips,
				// No attempts at all on the device during the span → leak.
				rows: [],
				nowMs: t0 + 10 * 60_000,
			}),
		)
		const leaks = ofKind(anomalies, "capacity-leak")
		expect(leaks).toHaveLength(1)
		const leak = leaks[0]!
		expect(leak.names.managedInstance).toBe(CLUSTER)
		expect(leak.names.device).toBe("gpu0")
		expect(leak.names.modelOffering).toBe("coder")
		expect(leak.values.busySlotSkipCount).toBe(2)
		expect(leak.values.lastDeviceAttemptNoneReadable).toBe("none")
		expect(leak.evidence.measured.inFlightDuringSpan).toBe(0)
	})

	it("names every Public_Route whose Expanded_Target_Sequence contains the target", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 6 * 60_000)]
		const anomalies = detectAnomalies(
			baseInput({
				busySlotSkips: skips,
				routeMemberships: membershipsFor({ coder: { publicRoutes: ["hybrid/code", "hybrid/research"] } }),
				nowMs: t0 + 10 * 60_000,
			}),
		)
		expect(ofKind(anomalies, "capacity-leak")[0]!.names.publicRoutes).toEqual([
			"hybrid/code",
			"hybrid/research",
		])
	})

	it("does NOT fire when an attempt was in flight on the device during the span", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 6 * 60_000)]
		// An attempt completing mid-span with a 2-min upstream duration is in flight.
		const midComplete = t0 + 3 * 60_000
		const anomalies = detectAnomalies(
			baseInput({
				busySlotSkips: skips,
				rows: [row({ ts: iso(midComplete), dur_ms: 120_000, wait: 0, corr: "x1" })],
				nowMs: t0 + 10 * 60_000,
			}),
		)
		expect(ofKind(anomalies, "capacity-leak")).toHaveLength(0)
	})

	it("does NOT fire when the two skips are ≤5 minutes apart", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 4 * 60_000)]
		const anomalies = detectAnomalies(
			baseInput({ busySlotSkips: skips, nowMs: t0 + 10 * 60_000 }),
		)
		expect(ofKind(anomalies, "capacity-leak")).toHaveLength(0)
	})

	it("waits until the span's records are settled (request timeout)", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 6 * 60_000)]
		const laterSkip = t0 + 6 * 60_000
		// now is only 1 min past the later skip, but the timeout is 5 min → not settled.
		const notSettled = detectAnomalies(
			baseInput({
				busySlotSkips: skips,
				requestTimeoutsMs: { [CLUSTER]: 5 * 60_000 },
				nowMs: laterSkip + 1 * 60_000,
			}),
		)
		expect(ofKind(notSettled, "capacity-leak")).toHaveLength(0)

		const settled = detectAnomalies(
			baseInput({
				busySlotSkips: skips,
				requestTimeoutsMs: { [CLUSTER]: 5 * 60_000 },
				nowMs: laterSkip + 6 * 60_000,
			}),
		)
		expect(ofKind(settled, "capacity-leak")).toHaveLength(1)
	})

	it("raises one alert per occurrence for the device", () => {
		const skips: BusySlotSkip[] = [skip(t0), skip(t0 + 6 * 60_000), skip(t0 + 12 * 60_000)]
		const anomalies = detectAnomalies(baseInput({ busySlotSkips: skips, nowMs: t0 + 20 * 60_000 }))
		expect(ofKind(anomalies, "capacity-leak")).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// 18.2 — Dead_Target
// ---------------------------------------------------------------------------

describe("Dead_Target (Requirement 18.2)", () => {
	const t0 = Date.parse("2026-10-13T00:00:00.000Z")

	function failRow(i: number, status: number, extra: Partial<CopiedAttempt> = {}): StoredRow {
		return row({ ts: iso(t0 + i * 60_000), status, corr: `c${i}`, ...extra })
	}

	it("fires on 10 consecutive genuine failures", () => {
		const rows = Array.from({ length: 10 }, (_, i) => failRow(i, 500))
		const anomalies = detectAnomalies(baseInput({ rows }))
		const dead = ofKind(anomalies, "dead-target")
		expect(dead).toHaveLength(1)
		expect(dead[0]!.values.reason).toBe("ten-consecutive")
		expect(dead[0]!.values.failedAttempts).toBe(10)
		expect(dead[0]!.names.modelOffering).toBe("coder")
	})

	it("does NOT fire when a capacity-rejection / 499 burst is ignored (ComfyUI preemption)", () => {
		// 8 capacity rejections + 2 client disconnects, interleaved with a success.
		const rows: StoredRow[] = [
			failRow(0, 429),
			failRow(1, 503),
			failRow(2, 409),
			failRow(3, 499),
			failRow(4, 429),
			failRow(5, 503),
			failRow(6, 499),
			failRow(7, 429),
			failRow(8, 200), // a success among the ignored rejections
			failRow(9, 503),
		]
		const anomalies = detectAnomalies(baseInput({ rows }))
		expect(ofKind(anomalies, "dead-target")).toHaveLength(0)
	})

	it("resets the consecutive run on a genuine success", () => {
		const rows: StoredRow[] = [
			...Array.from({ length: 5 }, (_, i) => failRow(i, 500)),
			failRow(5, 200), // success resets
			...Array.from({ length: 5 }, (_, i) => failRow(6 + i, 500)),
		]
		expect(ofKind(detectAnomalies(baseInput({ rows })), "dead-target")).toHaveLength(0)
	})

	it("fires on a 24-hour all-failed span with ≥1 attempt (fewer than 10)", () => {
		const rows: StoredRow[] = [
			row({ ts: iso(t0), status: 500, corr: "a" }),
			row({ ts: iso(t0 + 25 * 60 * 60_000), status: 502, corr: "b" }),
		]
		const dead = ofKind(detectAnomalies(baseInput({ rows, nowMs: t0 + 26 * 60 * 60_000 })), "dead-target")
		expect(dead).toHaveLength(1)
		expect(dead[0]!.values.reason).toBe("twenty-four-hour-span")
	})
})

// ---------------------------------------------------------------------------
// 18.3 — cap overrun
// ---------------------------------------------------------------------------

describe("cap overrun (Requirement 18.3)", () => {
	const t0 = Date.parse("2026-10-13T12:00:00.000Z")

	// Three overlapping attempts in flight for >60 s on an offering with 2 slots.
	function inFlight(corr: string, startMs: number, durMs: number): StoredRow {
		return row({ ts: iso(startMs + durMs), dur_ms: durMs, wait: 0, corr, status: 200 })
	}

	it("fires when in-flight exceeds the Model_Offering slot count for >60 s", () => {
		const rows = [
			inFlight("a", t0, 120_000),
			inFlight("b", t0 + 1_000, 120_000),
			inFlight("c", t0 + 2_000, 120_000),
		]
		const anomalies = detectAnomalies(baseInput({ rows, nowMs: t0 + 200_000 }))
		const overruns = ofKind(anomalies, "cap-overrun").filter((a) => a.names.bound === "model-offering")
		expect(overruns).toHaveLength(1)
		expect(overruns[0]!.values.boundValue).toBe(2)
		expect(overruns[0]!.values.peakInFlight).toBe(3)
	})

	it("does NOT fire when the excess lasts 60 s or less", () => {
		const rows = [
			inFlight("a", t0, 120_000),
			inFlight("b", t0, 120_000),
			inFlight("c", t0, 30_000), // only 30 s of 3-concurrency
		]
		const overruns = ofKind(detectAnomalies(baseInput({ rows, nowMs: t0 + 200_000 })), "cap-overrun")
		expect(overruns.filter((a) => a.names.bound === "model-offering")).toHaveLength(0)
	})

	it("reports the per-instance peak in flight during the overrun", () => {
		const rows = [
			inFlight("a", t0, 120_000),
			inFlight("b", t0 + 1_000, 120_000),
			inFlight("c", t0 + 2_000, 120_000),
		]
		const overrun = ofKind(detectAnomalies(baseInput({ rows, nowMs: t0 + 200_000 })), "cap-overrun").find(
			(a) => a.names.bound === "model-offering",
		)!
		expect(String(overrun.values.peakInFlightByInstance)).toContain(`${CLUSTER}=3`)
	})
})

// ---------------------------------------------------------------------------
// 18.4 — rank inversion by bucket
// ---------------------------------------------------------------------------

describe("rank inversion (Requirement 18.4)", () => {
	const t0 = NOW - 2 * 24 * 60 * 60_000 // inside the trailing 7 days

	// Two offerings eligible for a common lane; the better-rank one is slower.
	const inv = inventory({
		offerings: [
			offering("fast-rank", { ranks: [1, 1], tags: ["chat"] }), // best rank 1 (better)
			offering("slow-rank", { ranks: [5, 5], tags: ["chat"] }), // best rank 5 (worse)
		],
		lanes: [lane("hybrid/code", { capabilities: ["chat"] })],
	})

	function sample(offeringId: string, latencyMs: number, i: number): StoredRow {
		return row({
			ts: iso(t0 + i * 1_000),
			dur_ms: latencyMs,
			wait: 0,
			status: 200,
			tin: 20_000,
			corr: `${offeringId}-${i}`,
		})
	}

	it("reports a worse-rank slot showing better latency than a better-rank slot in a bucket", () => {
		const rows: StoredRow[] = []
		for (let i = 0; i < 120; i++) {
			rows.push(sample("fast-rank", 90_000, i)) // better rank, SLOW (90 s)
			rows.push(sample("slow-rank", 30_000, 1_000 + i)) // worse rank, FAST (30 s)
		}
		const anomalies = detectAnomalies(
			baseInput({
				inventory: inv,
				rows,
				attribute: attributeBy({
					offeringOf: (f) => (f.corr?.startsWith("fast") ? "fast-rank" : "slow-rank"),
				}),
				concurrencyBounds: boundsFromInventory(inv),
			}),
		)
		const inversions = ofKind(anomalies, "rank-inversion")
		expect(inversions).toHaveLength(1)
		expect(inversions[0]!.names.inputBucket).toBe("10-50k")
		expect(inversions[0]!.names.betterRankOffering).toBe("fast-rank")
		expect(inversions[0]!.names.worseRankOffering).toBe("slow-rank")
		expect(inversions[0]!.names.lanes).toEqual(["hybrid/code"])
	})

	it("does NOT report when a side has fewer than 100 samples in the bucket", () => {
		const rows: StoredRow[] = []
		for (let i = 0; i < 120; i++) {
			rows.push(sample("fast-rank", 90_000, i))
		}
		for (let i = 0; i < 50; i++) {
			rows.push(sample("slow-rank", 30_000, 1_000 + i))
		}
		const anomalies = detectAnomalies(
			baseInput({
				inventory: inv,
				rows,
				attribute: attributeBy({
					offeringOf: (f) => (f.corr?.startsWith("fast") ? "fast-rank" : "slow-rank"),
				}),
				concurrencyBounds: boundsFromInventory(inv),
			}),
		)
		expect(ofKind(anomalies, "rank-inversion")).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 18.5 — Host_Preemption interval
// ---------------------------------------------------------------------------

describe("Host_Preemption interval (Requirement 18.5)", () => {
	const t0 = Date.parse("2026-10-13T12:00:00.000Z")
	const inv = inventory({ devices: [device("gpu0", { hostPreemption: true })] })

	function rejection(i: number): StoredRow {
		return row({ ts: iso(t0 + i * 60_000), status: 503, corr: `r${i}`, requested_model: "hybrid/code" })
	}

	it("reports a closed preemption interval on a preemptible device", () => {
		// Four rejections within 10 min of each other, then a success closes it.
		const rows: StoredRow[] = [
			rejection(0),
			rejection(1),
			rejection(2),
			rejection(3),
			row({ ts: iso(t0 + 5 * 60_000), status: 200, corr: "ok" }),
		]
		const anomalies = detectAnomalies(baseInput({ inventory: inv, rows, nowMs: t0 + 30 * 60_000 }))
		const intervals = ofKind(anomalies, "host-preemption")
		expect(intervals).toHaveLength(1)
		expect(intervals[0]!.names.device).toBe("gpu0")
		expect(intervals[0]!.values.rejectedAttempts).toBe(4)
		expect(String(intervals[0]!.names.rejectionsByPublicRoute)).toContain("hybrid/code=4")
	})

	it("does NOT report on a non-preemptible device", () => {
		const rows: StoredRow[] = [rejection(0), rejection(1), rejection(2)]
		const anomalies = detectAnomalies(
			baseInput({ inventory: inventory(), rows, nowMs: t0 + 30 * 60_000 }),
		)
		expect(ofKind(anomalies, "host-preemption")).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 18.6 — route degradation vs the Preservation_Floor
// ---------------------------------------------------------------------------

describe("route degradation (Requirement 18.6)", () => {
	const t0 = Date.parse("2026-10-13T12:00:00.000Z")

	// hybrid/code floor is 99.4%; 20 requests with 2 failures = 90% < floor.
	function request(i: number, ok: boolean): StoredRow {
		return row({
			ts: iso(t0 + i * 60_000),
			status: ok ? 200 : 500,
			corr: `req-${i}`,
			requested_model: "hybrid/code",
		})
	}

	it("fires when final success rate is below the route's Preservation_Floor", () => {
		const rows: StoredRow[] = []
		for (let i = 0; i < 20; i++) {
			rows.push(request(i, i >= 2)) // first 2 fail
		}
		const anomalies = detectAnomalies(baseInput({ rows, nowMs: t0 + 90 * 60_000 }))
		const degraded = ofKind(anomalies, "route-degradation")
		expect(degraded).toHaveLength(1)
		expect(degraded[0]!.names.gatedRoute).toBe("hybrid/code")
		expect(degraded[0]!.values.floor).toBe(PRESERVATION_FLOORS["hybrid/code"])
		expect(degraded[0]!.values.requestCount).toBe(20)
		expect(Number(degraded[0]!.values.finalSuccessRate)).toBeCloseTo(90, 5)
	})

	it("does NOT fire with fewer than 20 requests in the span", () => {
		const rows: StoredRow[] = []
		for (let i = 0; i < 15; i++) {
			rows.push(request(i, i >= 5)) // many failures but < 20 requests
		}
		expect(ofKind(detectAnomalies(baseInput({ rows, nowMs: t0 + 90 * 60_000 })), "route-degradation")).toHaveLength(
			0,
		)
	})

	it("does NOT fire when the success rate meets the floor", () => {
		const rows: StoredRow[] = []
		for (let i = 0; i < 20; i++) {
			rows.push(request(i, true)) // all succeed
		}
		expect(
			ofKind(detectAnomalies(baseInput({ rows, nowMs: t0 + 90 * 60_000 })), "route-degradation"),
		).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 18.8 — one alert per occurrence (across detectors)
// ---------------------------------------------------------------------------

describe("one alert per occurrence (Requirement 18.8)", () => {
	it("emits exactly one Dead_Target alert even with far more than 10 failures", () => {
		const t0 = Date.parse("2026-10-13T00:00:00.000Z")
		const rows = Array.from({ length: 40 }, (_, i) => row({ ts: iso(t0 + i * 1_000), status: 500, corr: `c${i}` }))
		expect(ofKind(detectAnomalies(baseInput({ rows })), "dead-target")).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// 18.10 — detection-gap alert for unreadable records
// ---------------------------------------------------------------------------

describe("detection gap (Requirement 18.10)", () => {
	const t0 = Date.parse("2026-10-13T12:00:00.000Z")

	it("raises a detection-gap alert once an unreadable span exceeds 15 minutes", () => {
		const spans: UnreadableSpan[] = [{ instanceId: CLUSTER, fromMs: t0, toMs: t0 + 20 * 60_000 }]
		const anomalies = detectAnomalies(baseInput({ unreadableSpans: spans, nowMs: t0 + 30 * 60_000 }))
		const gaps = ofKind(anomalies, "detection-gap")
		expect(gaps).toHaveLength(1)
		expect(gaps[0]!.names.managedInstance).toBe(CLUSTER)
		expect(gaps[0]!.values.spanStartMs).toBe(t0)
		expect(gaps[0]!.partial).toBe(true)
	})

	it("does NOT raise a detection gap for a span of 15 minutes or less", () => {
		const spans: UnreadableSpan[] = [{ instanceId: CLUSTER, fromMs: t0, toMs: t0 + 15 * 60_000 }]
		expect(
			ofKind(detectAnomalies(baseInput({ unreadableSpans: spans, nowMs: t0 + 30 * 60_000 })), "detection-gap"),
		).toHaveLength(0)
	})

	it("suppresses record-dependent detectors for a blocked instance's span", () => {
		const t = Date.parse("2026-10-13T00:00:00.000Z")
		const rows = Array.from({ length: 12 }, (_, i) => row({ ts: iso(t + i * 1_000), status: 500, corr: `c${i}` }))
		const anomalies = detectAnomalies(
			baseInput({
				rows,
				unreadableSpans: [{ instanceId: CLUSTER, fromMs: t, toMs: t + 60_000 }],
				nowMs: t + 60 * 60_000,
			}),
		)
		// Dead_Target depends on the blocked instance's records → suppressed.
		expect(ofKind(anomalies, "dead-target")).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 18.9 — alert write with retry
// ---------------------------------------------------------------------------

describe("writeAlerts retry (Requirement 18.9)", () => {
	function anomaly(detectedAtMs: number): Anomaly {
		return {
			kind: "capacity-leak",
			occurrenceKey: "k",
			detectedAtMs,
			names: {},
			values: {},
			evidence: { measured: {}, thresholds: {}, counts: {}, spanStartMs: null, spanEndMs: null },
			partial: false,
			summary: "test alert",
		}
	}

	it("writes once on first success", async () => {
		const writer = { write: vi.fn().mockResolvedValue(undefined) }
		const outcomes = await writeAlerts([anomaly(0)], {
			writer,
			now: () => 0,
			sleep: async () => {},
		})
		expect(writer.write).toHaveBeenCalledTimes(1)
		expect(outcomes[0]!.written).toBe(true)
		expect(outcomes[0]!.attempts).toBe(1)
	})

	it("retries on failure then succeeds, sleeping the retry interval between tries", async () => {
		const writer = {
			write: vi
				.fn()
				.mockRejectedValueOnce(new Error("boom"))
				.mockResolvedValueOnce(undefined),
		}
		const sleep = vi.fn().mockResolvedValue(undefined)
		const outcomes = await writeAlerts([anomaly(0)], { writer, now: () => 0, sleep })
		expect(writer.write).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledWith(ALERT_RETRY_INTERVAL_MS)
		expect(outcomes[0]!.written).toBe(true)
		expect(outcomes[0]!.attempts).toBe(2)
	})

	it("gives up after 24 h and logs the still-unwritten entry with its failure reason", async () => {
		const writer = { write: vi.fn().mockRejectedValue(new Error("persistent failure")) }
		// Clock advances past the 24 h horizon on the second check.
		let clock = 0
		const now = () => {
			const t = clock
			clock += ALERT_GIVE_UP_MS // next read is past the horizon
			return t
		}
		const logUnwritten = vi.fn()
		const outcomes = await writeAlerts([anomaly(0)], {
			writer,
			now,
			sleep: async () => {},
			logUnwritten,
		})
		expect(outcomes[0]!.written).toBe(false)
		expect(outcomes[0]!.gaveUpReason).toBe("persistent failure")
		expect(logUnwritten).toHaveBeenCalledTimes(1)
	})
})
