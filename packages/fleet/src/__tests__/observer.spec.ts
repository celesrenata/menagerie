// Fleet_Observer — the capstone INTEGRATION test (task 8.4).
//
// The per-module unit tests (`observe/__tests__/{metrics,attribution,copy,
// sqlite-store,anomalies}.spec.ts`) prove each module in isolation. This file
// composes them end to end — copy → attribution → metrics, and copy →
// attribution → anomalies — over the SPECIFIC scenarios task 8.4 names, without
// re-running the per-module cases:
//
//   1. metric definitions driven through the real copy + attributor pipeline;
//   2. the baseline-extract oracle (findings §5-6) through that same pipeline;
//   3. the 4070 Capacity_Leak regression (Req 18.1);
//   4. a Dead_Target that ignores a ComfyUI preemption burst (Req 18.2);
//   5. attribution stability across a simulated route regeneration (Req 17.6),
//      composed through the Attributor + a RevisionResolver stub and read back
//      through the metrics landing distribution.
//
// Requirements: 16.9, 17.6, 18.1, 18.2.

import { createGunzip } from "node:zlib"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import path from "node:path"

import type {
	CloudTarget,
	Device,
	Endpoint,
	FleetInventory,
	Instance,
	Lane,
	ModelOffering,
	ResidencyGroup,
} from "@roo-code/types"
import { describe, expect, it } from "vitest"

import { slotTargetId } from "../compile/targets.js"
import {
	Attributor,
	type Attribution,
	type ReconcilerAuditEntry,
	type RevisionResolver,
} from "../observe/attribution.js"
import {
	InMemoryObserverStore,
	runCopy,
	type CopiedAttempt,
	type SourceAttempt,
	type StoredRow,
} from "../observe/copy.js"
import { attributorFn, metrics, type AttributeRow, type MetricsWindow } from "../observe/metrics.js"
import {
	detectAnomalies,
	type Anomaly,
	type AnomalyInput,
	type BusySlotSkip,
	type ConcurrencyBounds,
	type RouteMembershipLookup,
	type TargetRouteMemberships,
} from "../observe/anomalies.js"

// ---------------------------------------------------------------------------
// Shared inventory fixture — one device offering, one cloud target, one lane.
// ---------------------------------------------------------------------------

const CLUSTER = "cluster"

function device(id: string, overrides: Partial<Device> = {}): Device {
	return { id, slotCeiling: 2, hostPreemption: false, ...overrides }
}

function endpoint(id: string, overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id,
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: CLUSTER, url: "http://gpu0:2701" }],
		noCredential: true,
		...overrides,
	}
}

function offering(id: string, overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id,
		endpointId: "vllm",
		deviceId: "gpu0",
		modelId: "qwen-coder",
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat", "code"],
		ranks: [1, 3],
		...overrides,
	}
}

function cloud(id: string, overrides: Partial<CloudTarget> = {}): CloudTarget {
	return {
		id,
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet",
		spend: "paid",
		context: 200_000,
		tags: ["chat", "code"],
		...overrides,
	}
}

function residency(id: string, overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id, swapLatencyMs: 0, ...overrides }
}

function lane(id: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id,
		names: ["hybrid/code", "code"],
		capabilities: ["code"],
		minContext: 128_000,
		order: "fill-first",
		maxSpend: "paid",
		spillTiers: ["paid"],
		failClosed: false,
		maxQueueMs: 30_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

function instance(overrides: Partial<Instance> = {}): Instance {
	return { id: CLUSTER, role: "primary", address: "http://cluster:8080", backupRetention: 20, ...overrides }
}

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device("gpu0")],
		endpoints: [endpoint("vllm")],
		residencyGroups: [residency("r0")],
		offerings: [offering("coder")],
		clouds: [cloud("or-sonnet")],
		lanes: [lane("code")],
		instances: [instance()],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

/** The Target_Identifier of slot 0 of the default "coder" offering. */
const SLOT0_ID = slotTargetId({ offering: offering("coder"), slotIndex: 0, rank: 1 })

/** A single successful apply making `commit` live from `endedAt`. */
function applyEntry(commit: string, endedAt: string, startedAt = endedAt): ReconcilerAuditEntry {
	return {
		kind: "apply",
		instanceId: CLUSTER,
		outcome: "succeeded",
		revision: { commit, uncommitted: false },
		startedAt,
		endedAt,
	}
}

/** A resolver that serves one inventory per commit id. */
function resolverFor(byCommit: Record<string, FleetInventory>): RevisionResolver {
	return { resolve: (commit) => byCommit[commit] }
}

/** A source attempt (the input to `runCopy`) from partial body-free fields. */
function source(fields: Partial<CopiedAttempt>, extra: Partial<SourceAttempt> = {}): SourceAttempt {
	const full: CopiedAttempt = {
		ts: "2026-10-10T12:00:00.000Z",
		dur_ms: 10_000,
		status: 200,
		provider: "vllm",
		model: "qwen-coder",
		requested_model: "hybrid/code",
		connection_id: "vllm",
		tin: 20_000,
		tout: 200,
		key: "zoo-m5",
		combo: "hybrid/code",
		step: null,
		corr: "c1",
		exec: SLOT0_ID,
		etype: null,
		ttft: 2_000,
		wait: 0,
		...fields,
	}
	return { instanceId: CLUSTER, isHealthProbe: false, fields: full, ...extra }
}

const NOW = Date.parse("2026-10-10T12:30:00.000Z")

// ===========================================================================
// 1. Metric definitions driven through the REAL copy + attributor pipeline.
//    (A focused subset proving copy → attribution → metrics composes; the
//    exhaustive metric cases live in metrics.spec.ts.)
// ===========================================================================

describe("observer pipeline — copy → attribution → metrics (Req 16.9)", () => {
	const audit = [applyEntry("rev-a", "2026-10-01T00:00:00.000Z")]

	/** Copy sources into a fresh store, attribute via the real Attributor, run metrics. */
	function pipeline(sources: readonly SourceAttempt[], window: MetricsWindow = "1h") {
		const store = new InMemoryObserverStore()
		const result = runCopy(store, sources, NOW)
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const attribute: AttributeRow = attributorFn(attributor)
		const report = metrics(window, { rows: store.all(), attribute, inventory: inventory(), nowMs: NOW })
		return { report, copyResult: result }
	}

	it("counts 2xx as success and attributes each copied row to its Slot's Device/Offering", () => {
		const { report, copyResult } = pipeline([
			source({ corr: "a", status: 200 }),
			source({ corr: "b", status: 204 }),
			source({ corr: "c", status: 500, etype: "chat-template" }),
			source({ corr: "d", status: 429 }),
		])
		expect(copyResult.inserted).toBe(4)
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.attempts).toBe(4)
		expect(gpu.performance.successRate).toBeCloseTo(50, 5)
		// Attribution flowed through to the Model_Offering bucket.
		expect(report.modelOfferings.some((m) => m.modelOfferingId === "coder")).toBe(true)
	})

	it("dedups attempts of one request by correlation id for route metrics", () => {
		// One request, two attempts: a failed first attempt then a successful retry.
		const { report } = pipeline([
			source({ corr: "req1", status: 500, ts: "2026-10-10T12:00:00.000Z", dur_ms: 5_000 }),
			source({ corr: "req1", status: 200, ts: "2026-10-10T12:00:10.000Z", dur_ms: 8_000 }),
		])
		const route = report.publicRoutes.find((r) => r.publicRoute === "hybrid/code")!
		expect(route.requests).toBe(1)
		expect(route.finalSuccessRate).toBe(100)
		expect(route.multiAttemptRate).toBe(100)
		// Failed-attempt time = summed latency of the failed attempt = 5 s.
		expect(route.failedAttemptTimeP50.value).toBeCloseTo(5, 5)
	})

	it("reports completion-anchored in-flight and nearest-rank p50/p95 with sample counts", () => {
		const { report } = pipeline(
			[10, 20, 30, 40, 50].map((s, i) =>
				source({ corr: `r${i}`, dur_ms: s * 1000, tout: 100, ts: "2026-10-10T12:20:00.000Z" }),
			),
		)
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.latencyP50).toEqual({ value: 30, samples: 5 })
		expect(gpu.performance.latencyP95).toEqual({ value: 50, samples: 5 })
		// All five attempts complete at the same instant, each 10-50 s long and
		// overlapping, so the peak in-flight concurrency is 5.
		expect(gpu.performance.peakInFlight).toBe(5)
	})

	it("is idempotent across a re-run that overlaps the previous copy window", () => {
		const batch = [source({ corr: "x", status: 200 }), source({ corr: "y", status: 200 })]
		const store = new InMemoryObserverStore()
		const first = runCopy(store, batch, NOW)
		const second = runCopy(store, batch, NOW) // same records re-copied
		expect(first.inserted).toBe(2)
		expect(second.inserted).toBe(0)
		expect(second.skipped).toBe(2)
		expect(store.count()).toBe(2)
	})
})

// ===========================================================================
// 2. The baseline-extract oracle comparison (findings §5-6), driven through
//    the copy store. If the extract is unreadable, FAIL LOUDLY.
// ===========================================================================

const EXTRACT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../.agents/tasks/omniroute-fleet-topology/baseline-attempts-20261007-20261014.jsonl.gz",
)

async function loadExtract(): Promise<CopiedAttempt[]> {
	const rows: CopiedAttempt[] = []
	const rl = createInterface({ input: createReadStream(EXTRACT).pipe(createGunzip()), crlfDelay: Infinity })
	for await (const line of rl) {
		const trimmed = line.trim()
		if (trimmed.length > 0) {
			rows.push(JSON.parse(trimmed) as CopiedAttempt)
		}
	}
	return rows
}

/** Device of a baseline row from provider, mirroring arrangement-replay.py. */
function oracleDevice(f: CopiedAttempt): string | null {
	switch (f.provider) {
		case "vllm":
			return "5090"
		case "ollama-local":
			return "4070"
		case "llama-cpp":
			return "M5"
		default:
			return null
	}
}

function oracleOffering(f: CopiedAttempt): string | null {
	const m = (f.model ?? "").toLowerCase()
	switch (f.provider) {
		case "vllm":
			return m.includes("9b") ? "5090-9b" : "5090-27b"
		case "ollama-local":
			return m.includes("reader") ? "4070-9b" : "4070-27b"
		case "llama-cpp":
			if (m.includes("glm")) {
				return "m5-glm"
			}
			return m.includes("uzu") ? "m5-uzu" : "m5-other"
		default:
			return null
	}
}

function oracleCloud(f: CopiedAttempt): string | null {
	if (f.provider === "vllm" || f.provider === "ollama-local" || f.provider === "llama-cpp") {
		return null
	}
	return `${f.provider ?? ""}/${f.model ?? ""}`
}

function oracleRoute(f: CopiedAttempt): string | null {
	if (f.key !== "zoo-m5" || f.combo === null) {
		return null
	}
	return f.combo.startsWith("hybrid/") ? f.combo : null
}

const oracleAttribute: AttributeRow = (r): Attribution => {
	const f = r.fields
	const cloudId = oracleCloud(f)
	const deviceId = oracleDevice(f)
	return {
		instanceId: r.instanceId,
		activeRevision: "baseline",
		deviceId: cloudId !== null ? null : deviceId,
		modelOfferingId: cloudId !== null ? null : oracleOffering(f),
		servingEndpointId: deviceId,
		cloudTargetId: cloudId,
		publicRoute: oracleRoute(f),
		laneId: null,
		capabilityLane: null,
		isUnattributed: false,
		reasons: [],
	}
}

describe("observer pipeline — baseline-extract oracle (findings §5-6)", () => {
	it("reproduces the device shares and per-route cloud share through the copy store", async () => {
		let extract: CopiedAttempt[]
		try {
			extract = await loadExtract()
		} catch (cause) {
			// The artifact is referenced as present in the design (findings §5-6).
			// Fail loudly so an unreadable extract is a visible gap, not a skip.
			throw new Error(`baseline extract not readable at ${EXTRACT}: ${String(cause)}`)
		}
		expect(extract.length).toBeGreaterThan(10_000)

		// Drive the extract through the real copy store (idempotent upsert path).
		const store = new InMemoryObserverStore()
		const sources: SourceAttempt[] = extract.map((f, i) => ({
			instanceId: CLUSTER,
			isHealthProbe: false,
			fields: { ...f, corr: f.corr ?? `baseline-${i}`, exec: f.exec ?? `baseline-${i}` },
		}))
		runCopy(store, sources, Math.max(...extract.map((f) => Date.parse(f.ts))))
		expect(store.count()).toBe(extract.length)

		const latest = Math.max(...extract.map((f) => Date.parse(f.ts)))
		const report = metrics("7d", {
			rows: store.all(),
			attribute: oracleAttribute,
			inventory: inventory(),
			nowMs: latest + 1_000,
		})

		// Device shares + success (findings §5.1): the 5090 carries ~65% of all
		// attempts; the 4070 success rate sits in the mid-80s.
		const total = report.devices.reduce((n, d) => n + d.performance.attempts, 0)
		const dev = (id: string) => report.devices.find((d) => d.deviceId === id)!
		const share = (id: string) => (100 * dev(id).performance.attempts) / total
		expect(share("5090")).toBeGreaterThan(60)
		expect(share("5090")).toBeLessThan(70)
		expect(dev("5090").performance.successRate!).toBeGreaterThan(95) // findings 97.2%
		expect(dev("4070").performance.successRate!).toBeGreaterThan(80) // findings 85.3%
		expect(dev("4070").performance.successRate!).toBeLessThan(90)

		// Per-route cloud share (findings §6, within a few points).
		const routeOf = (name: string) => {
			const r = report.publicRoutes.find((p) => p.publicRoute === name)
			if (r === undefined) {
				throw new Error(`route ${name} not in report`)
			}
			return r
		}
		expect(routeOf("hybrid/code").cloudShare!).toBeLessThan(5) // findings 1.7%
		expect(routeOf("hybrid/planner").cloudShare!).toBeGreaterThan(44) // findings 49%
		expect(routeOf("hybrid/planner").cloudShare!).toBeLessThan(54)
		expect(routeOf("hybrid/reader").cloudShare!).toBeGreaterThan(12) // findings 17%
		expect(routeOf("hybrid/reader").cloudShare!).toBeLessThan(26)

		// 5090 27B latency p50/p95 close to findings §5.2 (33.1 / 322.2 s).
		const offering5090 = report.modelOfferings.find((m) => m.modelOfferingId === "5090-27b")!
		expect(offering5090.performance.latencyP50.value!).toBeGreaterThan(28)
		expect(offering5090.performance.latencyP50.value!).toBeLessThan(38)
		expect(offering5090.performance.latencyP95.value!).toBeGreaterThan(290)
		expect(offering5090.performance.latencyP95.value!).toBeLessThan(360)
	})
})

// ===========================================================================
// Anomaly fixtures (copy → attribution → detectAnomalies).
// ===========================================================================

/** A stored row from partial fields (the detectors read StoredRow directly). */
function row(fields: Partial<CopiedAttempt>, extra: Partial<StoredRow> = {}): StoredRow {
	const full = source(fields).fields
	return {
		rowId: `${full.corr ?? ""}:${full.ts}:${Math.random()}`,
		instanceId: CLUSTER,
		isHealthProbe: false,
		fields: full,
		...extra,
	}
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

/** Attribute every row/skip to the single "coder" slot on gpu0 via the real Attributor. */
function slotAttribute(): (r: StoredRow) => Attribution {
	const attributor = new Attributor([applyEntry("rev-a", "2026-10-01T00:00:00.000Z")], resolverFor({ "rev-a": inventory() }))
	return (r: StoredRow): Attribution =>
		attributor.attribute({
			instanceId: r.instanceId,
			completedAt: r.fields.ts,
			endToEndMs: r.fields.dur_ms ?? 0,
			targetId: r.fields.exec ?? undefined,
			connectionId: r.fields.connection_id ?? undefined,
			upstreamModelId: r.fields.model ?? undefined,
			requestedModelId: r.fields.requested_model ?? undefined,
			isHealthProbe: r.isHealthProbe,
		})
}

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

function boundsFromInventory(inv: FleetInventory): ConcurrencyBounds {
	const slots = new Map(inv.offerings.map((o) => [o.id, o.slots]))
	const ceilings = new Map(inv.devices.map((d) => [d.id, d.slotCeiling]))
	return {
		offeringSlots: (id) => slots.get(id) ?? null,
		deviceCeiling: (id) => ceilings.get(id) ?? null,
		instanceDeviceAllocation: () => null,
	}
}

function anomalyInput(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
	const inv = overrides.inventory ?? inventory()
	const attribute = overrides.attribute ?? slotAttribute()
	return {
		rows: [],
		busySlotSkips: [],
		attribute,
		attributeSkip: (skip: BusySlotSkip) =>
			attribute({
				rowId: skip.ts,
				instanceId: skip.instanceId,
				isHealthProbe: false,
				fields: source({ ts: skip.ts, exec: skip.targetId ?? SLOT0_ID }).fields,
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

// ===========================================================================
// 3. The 4070 Capacity_Leak regression (Req 18.1).
// ===========================================================================

describe("observer pipeline — 4070 Capacity_Leak regression (Req 18.1)", () => {
	const t0 = Date.parse("2026-10-13T22:28:00.000Z")

	function skip(tsMs: number): BusySlotSkip {
		return { instanceId: CLUSTER, ts: iso(tsMs), targetId: SLOT0_ID }
	}

	it("fires when the 4070 slot is skipped twice >5 min apart with nothing in flight", () => {
		// The live 4070 fault: the card is advanced-past as "busy" while nothing
		// is actually running on it.
		const anomalies = detectAnomalies(
			anomalyInput({
				busySlotSkips: [skip(t0), skip(t0 + 6 * 60_000)],
				rows: [], // no attempt in flight on the device during the span
				routeMemberships: membershipsFor({ coder: { publicRoutes: ["hybrid/code"] } }),
				nowMs: t0 + 10 * 60_000,
			}),
		)
		const leaks = ofKind(anomalies, "capacity-leak")
		expect(leaks).toHaveLength(1)
		const leak = leaks[0]!
		expect(leak.names.managedInstance).toBe(CLUSTER)
		expect(leak.names.device).toBe("gpu0")
		expect(leak.names.modelOffering).toBe("coder")
		expect(leak.names.publicRoutes).toEqual(["hybrid/code"])
		expect(leak.values.busySlotSkipCount).toBe(2)
		expect(leak.values.lastDeviceAttemptNoneReadable).toBe("none")
		expect(leak.evidence.measured.inFlightDuringSpan).toBe(0)
	})

	it("does NOT fire when an attempt was in flight on the device during the span", () => {
		const midComplete = t0 + 3 * 60_000
		const anomalies = detectAnomalies(
			anomalyInput({
				busySlotSkips: [skip(t0), skip(t0 + 6 * 60_000)],
				// An attempt completing mid-span with a 2-min upstream duration.
				rows: [row({ ts: iso(midComplete), dur_ms: 120_000, wait: 0, corr: "x1" })],
				nowMs: t0 + 10 * 60_000,
			}),
		)
		expect(ofKind(anomalies, "capacity-leak")).toHaveLength(0)
	})
})

// ===========================================================================
// 4. A Dead_Target that IGNORES a ComfyUI preemption burst (Req 18.2).
// ===========================================================================

describe("observer pipeline — Dead_Target ignores a ComfyUI preemption burst (Req 18.2)", () => {
	const t0 = Date.parse("2026-10-13T00:00:00.000Z")

	function attempt(i: number, status: number): StoredRow {
		return row({ ts: iso(t0 + i * 60_000), status, corr: `c${i}` })
	}

	it("does NOT raise a dead-target alert for a capacity-rejection / HTTP 499 burst", () => {
		// A ComfyUI preemption burst: capacity rejections (429/503/409) and HTTP
		// 499 client disconnects, which are IGNORED when forming a run/span. No
		// genuine failures survive, so there is no Dead_Target.
		const rows: StoredRow[] = [
			attempt(0, 429),
			attempt(1, 503),
			attempt(2, 409),
			attempt(3, 499),
			attempt(4, 429),
			attempt(5, 503),
			attempt(6, 499),
			attempt(7, 409),
			attempt(8, 429),
			attempt(9, 503),
			attempt(10, 409),
			attempt(11, 499),
		]
		const anomalies = detectAnomalies(anomalyInput({ rows, nowMs: t0 + 60 * 60_000 }))
		expect(ofKind(anomalies, "dead-target")).toHaveLength(0)
	})

	it("DOES raise a dead-target alert on 10 consecutive genuine failures", () => {
		// The contrast case: 10 genuine 500s to the same slot → one Dead_Target.
		const rows = Array.from({ length: 10 }, (_, i) => attempt(i, 500))
		const dead = ofKind(detectAnomalies(anomalyInput({ rows, nowMs: t0 + 60 * 60_000 })), "dead-target")
		expect(dead).toHaveLength(1)
		expect(dead[0]!.values.reason).toBe("ten-consecutive")
		expect(dead[0]!.names.modelOffering).toBe("coder")
	})

	it("ignores a preemption burst but still fires once a genuine run follows it", () => {
		const rows: StoredRow[] = [
			...[429, 503, 409, 499, 429].map((s, i) => attempt(i, s)), // ignored burst
			...Array.from({ length: 10 }, (_, i) => attempt(5 + i, 500)), // genuine run
		]
		const dead = ofKind(detectAnomalies(anomalyInput({ rows, nowMs: t0 + 60 * 60_000 })), "dead-target")
		expect(dead).toHaveLength(1)
		expect(dead[0]!.values.failedAttempts).toBe(10)
	})
})

// ===========================================================================
// 5. Attribution stability across a SIMULATED route regeneration (Req 17.6),
//    composed through the Attributor + RevisionResolver and read back through
//    the metrics landing distribution.
// ===========================================================================

describe("observer pipeline — attribution is stable across a route regeneration (Req 17.6)", () => {
	// Two revisions of the same inventory: the regenerated one reorders the
	// offering's ranks and tags, but the Slot identity (device/endpoint/model/
	// index) is unchanged, so the Target_Identifier is identical.
	const revA = inventory()
	const revRegen = inventory({ offerings: [offering("coder", { ranks: [3, 1], tags: ["read", "code", "chat"] })] })
	const audit: ReconcilerAuditEntry[] = [
		applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
		applyEntry("rev-regen", "2026-10-20T00:00:00.000Z"),
	]
	const attributor = new Attributor(audit, resolverFor({ "rev-a": revA, "rev-regen": revRegen }))

	it("maps the same Target_Identifier to the same Device/Model_Offering under both revisions", () => {
		const before = attributor.attribute({
			instanceId: CLUSTER,
			completedAt: "2026-10-10T00:00:05.000Z", // rev-a live
			endToEndMs: 5_000,
			targetId: SLOT0_ID,
			requestedModelId: "hybrid/code",
		})
		const after = attributor.attribute({
			instanceId: CLUSTER,
			completedAt: "2026-10-25T00:00:05.000Z", // rev-regen live
			endToEndMs: 5_000,
			targetId: SLOT0_ID,
			requestedModelId: "hybrid/code",
		})
		expect(before.activeRevision).toBe("rev-a")
		expect(after.activeRevision).toBe("rev-regen")
		// Same identity despite the different active revision.
		expect(after.deviceId).toBe(before.deviceId)
		expect(after.modelOfferingId).toBe(before.modelOfferingId)
		expect(after.deviceId).toBe("gpu0")
		expect(after.modelOfferingId).toBe("coder")
	})

	it("keeps the metrics landing distribution stable across the regeneration boundary", () => {
		// Copy attempts that straddle the regeneration: half under rev-a, half
		// under rev-regen, all to the same Slot. The per-device landing share
		// must attribute every one to the same Device, so the landing is 100% gpu0.
		const sources: SourceAttempt[] = [
			...Array.from({ length: 5 }, (_, i) =>
				source({ corr: `pre-${i}`, ts: `2026-10-10T0${i}:00:00.000Z`, exec: SLOT0_ID }),
			),
			...Array.from({ length: 5 }, (_, i) =>
				source({ corr: `post-${i}`, ts: `2026-10-25T0${i}:00:00.000Z`, exec: SLOT0_ID }),
			),
		]
		const store = new InMemoryObserverStore()
		const windowEnd = Date.parse("2026-10-25T06:00:00.000Z")
		runCopy(store, sources, windowEnd)
		const report = metrics("7d", {
			rows: store.all(),
			attribute: attributorFn(attributor),
			inventory: revRegen,
			nowMs: windowEnd,
		})
		const route = report.publicRoutes.find((r) => r.publicRoute === "hybrid/code")!
		const gpuLanding = route.landingByDevice.find((l) => l.key === "gpu0")!
		// All attempts (both revisions) land on the single gpu0 Device.
		expect(gpuLanding.percentage).toBeCloseTo(100, 5)
		expect(route.landingByDevice.every((l) => l.key === "gpu0")).toBe(true)
	})
})
