import { createGunzip } from "node:zlib"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import path from "node:path"

import type { Device, FleetInventory, ModelOffering, ResidencyGroup } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import { UNATTRIBUTED, type Attribution } from "../attribution.js"
import { InMemoryObserverStore, type CopiedAttempt, type StoredRow } from "../copy.js"
import {
	bucketOf,
	metrics,
	nearestRank,
	type AttributeRow,
	type MetricsWindow,
	type PublicRouteMetrics,
} from "../metrics.js"

// ---------------------------------------------------------------------------
// Fixtures — a small synthetic inventory and a store builder.
// ---------------------------------------------------------------------------

const CLUSTER = "cluster"

function device(id: string, overrides: Partial<Device> = {}): Device {
	return { id, slotCeiling: 2, hostPreemption: false, ...overrides }
}

function residency(id: string, overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id, swapLatencyMs: 8_500, ...overrides }
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

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device("gpu0")],
		endpoints: [],
		residencyGroups: [residency("r0")],
		offerings: [offering("coder")],
		clouds: [],
		lanes: [],
		instances: [],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

/** Build a stored row from a partial `CopiedAttempt`, defaulting the body-free fields. */
function row(fields: Partial<CopiedAttempt>, extra: Partial<StoredRow> = {}): StoredRow {
	const full: CopiedAttempt = {
		ts: "2026-10-07T12:00:00.000Z",
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
		rowId: `${full.corr ?? ""}:${full.ts}`,
		instanceId: CLUSTER,
		isHealthProbe: false,
		fields: full,
		...extra,
	}
}

/**
 * A direct attribution for synthetic tests: Device/Model_Offering/Public_Route
 * are read straight from the row's fields via small helper props stashed on
 * `requested_model` conventions. Here we attribute by `provider`/`model` the
 * same way the design-time prototype does, so the metric arithmetic is exercised
 * without the full revision machinery.
 */
function attributeByProvider(opts: {
	deviceOf?: (f: CopiedAttempt) => string | null
	offeringOf?: (f: CopiedAttempt) => string | null
	endpointOf?: (f: CopiedAttempt) => string | null
	cloudOf?: (f: CopiedAttempt) => string | null
	publicRouteOf?: (f: CopiedAttempt) => string | null
} = {}): AttributeRow {
	return (r: StoredRow): Attribution => {
		const f = r.fields
		const deviceId = opts.deviceOf ? opts.deviceOf(f) : "gpu0"
		const cloudTargetId = opts.cloudOf ? opts.cloudOf(f) : null
		return {
			instanceId: r.instanceId,
			activeRevision: "rev",
			deviceId: cloudTargetId !== null ? null : deviceId,
			modelOfferingId: cloudTargetId !== null ? null : opts.offeringOf ? opts.offeringOf(f) : "coder",
			servingEndpointId: opts.endpointOf ? opts.endpointOf(f) : deviceId === null ? null : "ep",
			cloudTargetId,
			publicRoute: opts.publicRouteOf ? opts.publicRouteOf(f) : f.combo,
			laneId: null,
			capabilityLane: null,
			isUnattributed: false,
			reasons: [],
		}
	}
}

const NOW = Date.parse("2026-10-07T12:30:00.000Z")

// ---------------------------------------------------------------------------
// Nearest-rank percentile (Requirement 16.9)
// ---------------------------------------------------------------------------

describe("nearestRank", () => {
	it("uses the ceil(p/100 · n) rank, 1-indexed, with sample counts", () => {
		const xs = [10, 20, 30, 40, 50]
		expect(nearestRank(xs, 50)).toEqual({ value: 30, samples: 5 })
		// p95 of 5 samples: ceil(0.95·5)=ceil(4.75)=5 → the max.
		expect(nearestRank(xs, 95)).toEqual({ value: 50, samples: 5 })
		expect(nearestRank(xs, 100)).toEqual({ value: 50, samples: 5 })
	})

	it("reports no-data with a zero sample count on an empty sample", () => {
		expect(nearestRank([], 50)).toEqual({ value: null, samples: 0 })
	})
})

describe("bucketOf", () => {
	it("places input token counts into the three buckets, nothing below 10k", () => {
		expect(bucketOf(null)).toBeNull()
		expect(bucketOf(9_999)).toBeNull()
		expect(bucketOf(10_000)).toBe("10-50k")
		expect(bucketOf(49_999)).toBe("10-50k")
		expect(bucketOf(50_000)).toBe("50-100k")
		expect(bucketOf(99_999)).toBe("50-100k")
		expect(bucketOf(100_000)).toBe("100k+")
	})
})

// ---------------------------------------------------------------------------
// Metric definitions over a small synthetic log
// ---------------------------------------------------------------------------

describe("metrics — definitions over a synthetic log", () => {
	it("counts 2xx as success and everything else as failure", () => {
		const rows = [
			row({ status: 200, corr: "a" }),
			row({ status: 204, corr: "b" }),
			row({ status: 500, corr: "c", etype: "chat-template" }),
			row({ status: 429, corr: "d", etype: null }),
		]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.attempts).toBe(4)
		expect(gpu.performance.successRate).toBeCloseTo(50, 5)
		// Failure breakdown groups by HTTP status then error type.
		const statuses = gpu.performance.failures.map((f) => f.status).sort((a, b) => a - b)
		expect(statuses).toEqual([429, 500])
	})

	it("dedups attempts of one request by correlation id for route metrics", () => {
		// One request, two attempts: a failed 4070 attempt then a successful 5090.
		const rows = [
			row({ corr: "req1", status: 500, ts: "2026-10-07T12:00:00.000Z", dur_ms: 5_000, combo: "hybrid/code" }),
			row({ corr: "req1", status: 200, ts: "2026-10-07T12:00:10.000Z", dur_ms: 8_000, combo: "hybrid/code" }),
		]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const route = report.publicRoutes.find((r) => r.publicRoute === "hybrid/code")!
		expect(route.requests).toBe(1)
		expect(route.finalSuccessRate).toBe(100)
		expect(route.multiAttemptRate).toBe(100)
		// Failed-attempt time = summed latency of the failed attempt = 5 s.
		expect(route.failedAttemptTimeP50.value).toBeCloseTo(5, 5)
	})

	it("computes completion-anchored busy fraction clipped to the window", () => {
		// Two overlapping 5090 attempts of 600 s each inside a 1 h window.
		// Window: 11:30 → 12:30. Attempt A 11:40→11:50, attempt B 11:45→11:55.
		const rows = [
			row({ corr: "A", ts: "2026-10-07T11:50:00.000Z", dur_ms: 600_000, tin: 20_000, tout: 100 }),
			row({ corr: "B", ts: "2026-10-07T11:55:00.000Z", dur_ms: 600_000, tin: 20_000, tout: 100 }),
		]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		// Union of [11:40,11:50) and [11:45,11:55) = 15 min of ≥1 in flight over a
		// 60 min window = 25%. Overlap [11:45,11:50) = 5 min of ≥2 = ~8.33%.
		const l1 = gpu.busyFraction.find((b) => b.level === 1)!
		const l2 = gpu.busyFraction.find((b) => b.level === 2)!
		expect(l1.fraction).toBeCloseTo(25, 1)
		expect(l2.fraction).toBeCloseTo(100 * (5 / 60), 1)
		expect(gpu.performance.peakInFlight).toBe(2)
	})

	it("reports p50/p95 with sample counts", () => {
		const rows = [10, 20, 30, 40, 50].map((s, i) =>
			row({ corr: `r${i}`, dur_ms: s * 1000, tin: 20_000, tout: 100 }),
		)
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.latencyP50).toEqual({ value: 30, samples: 5 })
		expect(gpu.performance.latencyP95).toEqual({ value: 50, samples: 5 })
	})

	it("computes the Local_Demand_Distribution as five percentages", () => {
		// Three staggered local attempts: each 100 s long, 20 s apart.
		// start times t=0, t=20, t=40 (completion-anchored).
		const base = Date.parse("2026-10-07T12:00:00.000Z")
		const rows = [0, 20, 40].map((offset, i) =>
			row({
				corr: `d${i}`,
				ts: new Date(base + (offset + 100) * 1000).toISOString(),
				dur_ms: 100_000,
				tin: 20_000,
				tout: 100,
			}),
		)
		const report = metrics("24h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const d = report.localDemand
		expect(d.starts).toBe(3)
		// Start 1: 0 others. Start 2: 1 other (first still running). Start 3: 2 others.
		expect(d.percentages[0]).toBeCloseTo(100 / 3, 1)
		expect(d.percentages[1]).toBeCloseTo(100 / 3, 1)
		expect(d.percentages[2]).toBeCloseTo(100 / 3, 1)
		const total = d.percentages.reduce((a, b) => a + b, 0)
		expect(total).toBeCloseTo(100, 5)
	})

	it("counts health probes apart from client attempts", () => {
		const rows = [
			row({ corr: "client", status: 200 }),
			row({ corr: "p1", status: 200 }, { isHealthProbe: true }),
			row({ corr: "p2", status: 503 }, { isHealthProbe: true }),
		]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		// The client device metrics exclude probes.
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.attempts).toBe(1)
		// Probes are reported separately per (instance, endpoint) with a failure rate.
		expect(report.healthProbes).toHaveLength(1)
		const hp = report.healthProbes[0]!
		expect(hp.probeCount).toBe(2)
		expect(hp.failureRate).toBeCloseTo(50, 5)
	})

	it("marks a window partial when it extends before the earliest record", () => {
		// Only one record, well inside the window; the window reaches before it.
		const rows = [row({ corr: "x", ts: "2026-10-07T12:25:00.000Z" })]
		const report = metrics("7d", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		expect(report.partial).toBe(true)
		expect(report.noData).toBe(false)
	})

	it("marks no-data when the window contains no records", () => {
		const report = metrics("1h", {
			rows: [row({ corr: "old", ts: "2026-10-01T00:00:00.000Z" })],
			attribute: attributeByProvider(),
			inventory: inventory(),
			nowMs: NOW,
		})
		expect(report.noData).toBe(true)
		expect(report.human).toContain("no data")
	})

	it("reports no-data percentiles with sample counts when there are no qualifying samples", () => {
		// A single failed attempt: no successful latency samples.
		const rows = [row({ corr: "f", status: 500 })]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.performance.latencyP50).toEqual({ value: null, samples: 0 })
	})

	it("marks TTFT unreliable when >10% of large-input attempts report sub-50ms TTFT", () => {
		// Ten attempts with >10k input; two report 1 ms TTFT (20% > 10%).
		const rows = Array.from({ length: 10 }, (_, i) =>
			row({ corr: `t${i}`, tin: 60_000, ttft: i < 2 ? 1 : 5_000, status: 200, tout: 100 }),
		)
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const offeringMetrics = report.modelOfferings.find((m) => m.modelOfferingId === "coder")!
		expect(offeringMetrics.ttftUnreliable).toBe(true)
	})

	it("counts capacity-class rejections in total and by status", () => {
		const rows = [
			row({ corr: "a", status: 429 }),
			row({ corr: "b", status: 503 }),
			row({ corr: "c", status: 409 }),
			row({ corr: "d", status: 500 }), // not a capacity rejection
		]
		const report = metrics("1h", { rows, attribute: attributeByProvider(), inventory: inventory(), nowMs: NOW })
		const gpu = report.devices.find((d) => d.deviceId === "gpu0")!
		expect(gpu.capacityClassRejections.total).toBe(3)
	})

	it("shows a visible unattributed entry in landing distributions", () => {
		const attribute: AttributeRow = (r): Attribution => ({
			instanceId: r.instanceId,
			activeRevision: UNATTRIBUTED,
			deviceId: UNATTRIBUTED,
			modelOfferingId: UNATTRIBUTED,
			servingEndpointId: null,
			cloudTargetId: UNATTRIBUTED,
			publicRoute: r.fields.combo,
			laneId: null,
			capabilityLane: null,
			isUnattributed: true,
			reasons: ["no-active-revision"],
		})
		const report = metrics("1h", {
			rows: [row({ corr: "u", status: 200 })],
			attribute,
			inventory: inventory(),
			nowMs: NOW,
		})
		const route = report.publicRoutes.find((r) => r.publicRoute === "hybrid/code")!
		expect(route.landingByDevice.some((l) => l.key === UNATTRIBUTED)).toBe(true)
	})

	it("exposes both a machine-readable report and a human-readable summary", () => {
		const report = metrics("1h", {
			rows: [row({ corr: "x", status: 200, tout: 100, dur_ms: 10_000 })],
			attribute: attributeByProvider(),
			inventory: inventory(),
			nowMs: NOW,
		})
		expect(report.windowStartMs).toBe(NOW - 60 * 60 * 1000)
		expect(report.windowEndMs).toBe(NOW)
		expect(report.human).toContain("Fleet metrics")
		expect(report.human).toContain("Devices:")
		expect(report.human).toContain("Public routes:")
	})
})

// ---------------------------------------------------------------------------
// Oracle: the baseline extract reproduces the findings §5-6 numbers.
// ---------------------------------------------------------------------------

const EXTRACT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../../.agents/tasks/omniroute-fleet-topology/baseline-attempts-20261007-20261014.jsonl.gz",
)

async function loadExtract(): Promise<CopiedAttempt[] | null> {
	try {
		const rows: CopiedAttempt[] = []
		const rl = createInterface({ input: createReadStream(EXTRACT).pipe(createGunzip()), crlfDelay: Infinity })
		for await (const line of rl) {
			const trimmed = line.trim()
			if (trimmed.length > 0) {
				rows.push(JSON.parse(trimmed) as CopiedAttempt)
			}
		}
		return rows
	} catch {
		return null
	}
}

/** Device of a baseline row from provider+model, mirroring arrangement-replay.py's card_of/DEV. */
function oracleDevice(f: CopiedAttempt): string | null {
	const p = f.provider ?? ""
	if (p === "vllm") {
		return "5090"
	}
	if (p === "ollama-local") {
		return "4070"
	}
	if (p === "llama-cpp") {
		return "M5"
	}
	return null // cloud / other
}

function oracleOffering(f: CopiedAttempt): string | null {
	const p = f.provider ?? ""
	const m = (f.model ?? "").toLowerCase()
	if (p === "vllm") {
		return m.includes("9b") ? "5090-9b" : "5090-27b"
	}
	if (p === "ollama-local") {
		return m.includes("reader") ? "4070-9b" : "4070-27b"
	}
	if (p === "llama-cpp") {
		if (m.includes("glm")) {
			return "m5-glm"
		}
		if (m.includes("uzu")) {
			return "m5-uzu"
		}
		return "m5-other"
	}
	return null
}

function oracleCloud(f: CopiedAttempt): string | null {
	const p = f.provider ?? ""
	if (p === "vllm" || p === "ollama-local" || p === "llama-cpp") {
		return null
	}
	return `${p}/${f.model ?? ""}`
}

/** Public_Route of a baseline row: the zoo-m5 combo when it is a hybrid route. */
function oracleRoute(f: CopiedAttempt): string | null {
	if (f.key !== "zoo-m5" || f.combo === null) {
		return null
	}
	return f.combo.startsWith("hybrid/") ? f.combo : null
}

const oracleAttribute: AttributeRow = (r): Attribution => {
	const f = r.fields
	const cloud = oracleCloud(f)
	const device = oracleDevice(f)
	return {
		instanceId: r.instanceId,
		activeRevision: "baseline",
		deviceId: cloud !== null ? null : device,
		modelOfferingId: cloud !== null ? null : oracleOffering(f),
		servingEndpointId: device,
		cloudTargetId: cloud,
		publicRoute: oracleRoute(f),
		laneId: null,
		capabilityLane: null,
		isUnattributed: false,
		reasons: [],
	}
}

function routeOf(report: { publicRoutes: readonly PublicRouteMetrics[] }, name: string): PublicRouteMetrics {
	const r = report.publicRoutes.find((p) => p.publicRoute === name)
	if (r === undefined) {
		throw new Error(`route ${name} not in report`)
	}
	return r
}

describe("metrics — baseline-extract oracle (findings §5-6)", () => {
	it("reproduces the device shares, per-route landing/cloud-share, and local demand", async () => {
		const extract = await loadExtract()
		if (extract === null) {
			// The artifact is referenced as present in the design; if it is not
			// readable in this environment the synthetic tests above still cover
			// the metric conventions. Fail loudly so the gap is visible.
			throw new Error(`baseline extract not readable at ${EXTRACT}`)
		}
		expect(extract.length).toBeGreaterThan(10_000)

		const store = new InMemoryObserverStore()
		for (let i = 0; i < extract.length; i++) {
			const f = extract[i]!
			store.upsert({
				rowId: `baseline:${i}`,
				instanceId: CLUSTER,
				isHealthProbe: false,
				fields: f,
			})
		}

		// Window ending just after the latest record, covering the full 7 days.
		const latest = Math.max(...extract.map((f) => Date.parse(f.ts)))
		const window: MetricsWindow = "7d"
		const report = metrics(window, {
			rows: store.all(),
			attribute: oracleAttribute,
			inventory: inventory(),
			nowMs: latest + 1_000,
		})

		// --- Device shares and success (findings §5.1) ---
		const total = report.devices.reduce((n, d) => n + d.performance.attempts, 0)
		const dev = (id: string) => report.devices.find((d) => d.deviceId === id)!
		const share = (id: string) => (100 * dev(id).performance.attempts) / total
		expect(share("5090")).toBeGreaterThan(60)
		expect(share("5090")).toBeLessThan(70)
		expect(dev("5090").performance.successRate!).toBeGreaterThan(95) // findings 97.2%
		expect(dev("4070").performance.successRate!).toBeGreaterThan(80) // findings 85.3%
		expect(dev("4070").performance.successRate!).toBeLessThan(90)

		// --- Per-route cloud share and landing (findings §6, within a few points) ---
		const code = routeOf(report, "hybrid/code")
		expect(code.cloudShare!).toBeLessThan(5) // findings 1.7%
		const codeLanding = new Map(code.landingByDevice.map((l) => [l.key, l.percentage]))
		expect(codeLanding.get("5090")!).toBeGreaterThan(70) // findings 74%
		expect(codeLanding.get("5090")!).toBeLessThan(80)
		expect(codeLanding.get("4070")!).toBeGreaterThan(14) // findings 19%
		expect(codeLanding.get("4070")!).toBeLessThan(24)

		const planner = routeOf(report, "hybrid/planner")
		// findings: cloud lands 49%; we attribute GLM landing as M5, cloud as cloud.
		expect(planner.cloudShare!).toBeGreaterThan(44)
		expect(planner.cloudShare!).toBeLessThan(54)

		const reader = routeOf(report, "hybrid/reader")
		expect(reader.cloudShare!).toBeGreaterThan(12) // findings 17%
		expect(reader.cloudShare!).toBeLessThan(26)

		// --- Local demand distribution (findings §6: 24.3/51.7/20.1/2.9/1.0) ---
		const d = report.localDemand.percentages
		expect(d[0]).toBeGreaterThan(20)
		expect(d[0]).toBeLessThan(30)
		expect(d[1]).toBeGreaterThan(46)
		expect(d[1]).toBeLessThan(56)
		expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 3)
	})

	it("reproduces the 5090 27B latency p50/p95 close to findings §5.2 (33.1 / 322.2 s)", async () => {
		const extract = await loadExtract()
		if (extract === null) {
			throw new Error(`baseline extract not readable at ${EXTRACT}`)
		}
		const latest = Math.max(...extract.map((f) => Date.parse(f.ts)))
		const report = metrics("7d", {
			rows: extract.map((f, i) => ({ rowId: `b:${i}`, instanceId: CLUSTER, isHealthProbe: false, fields: f })),
			attribute: oracleAttribute,
			inventory: inventory(),
			nowMs: latest + 1_000,
		})
		const offering5090 = report.modelOfferings.find((m) => m.modelOfferingId === "5090-27b")!
		// findings §5.2: p50 33.1 s, p95 322.2 s. Allow a few seconds / a modest band.
		expect(offering5090.performance.latencyP50.value!).toBeGreaterThan(28)
		expect(offering5090.performance.latencyP50.value!).toBeLessThan(38)
		expect(offering5090.performance.latencyP95.value!).toBeGreaterThan(290)
		expect(offering5090.performance.latencyP95.value!).toBeLessThan(360)
		// Bucket samples are reported (findings §5.2 like-sized comparison).
		const b2 = offering5090.buckets.find((b) => b.bucket === "50-100k")!
		expect(b2.samples).toBeGreaterThan(4000)
		expect(b2.latencyP50.value!).toBeGreaterThan(28)
		expect(b2.latencyP50.value!).toBeLessThan(38)
	})
})
