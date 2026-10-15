import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

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

import type { Revision } from "../../compile/compiler.js"
import type { CopiedAttempt } from "../../observe/copy.js"
import {
	BASELINE_SPEED_MODEL,
	INITIAL_BASELINE_LOCAL_DEMAND,
	estimateFreeLocalSlots,
	percentile,
	simulateSpeedModel,
	type EstimateInput,
	type SpeedSlot,
	type SpeedWorkItem,
} from "../estimate.js"

// ---------------------------------------------------------------------------
// Fixtures — a small single-device fleet with one two-slot code offering.
// ---------------------------------------------------------------------------

const REV: Revision = { commit: "rev1", uncommitted: false }

function device(overrides: Partial<Device> = {}): Device {
	return { id: "gpu0", slotCeiling: 2, hostPreemption: false, ...overrides }
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: "vllm",
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: "cluster", url: "http://gpu0:2701" }],
		noCredential: true,
		...overrides,
	}
}

function offering(overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id: "coder",
		endpointId: "vllm",
		deviceId: "gpu0",
		modelId: "qwen-coder",
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat", "code"],
		ranks: [1, 2],
		...overrides,
	}
}

function cloud(overrides: Partial<CloudTarget> = {}): CloudTarget {
	return {
		id: "codestral",
		provider: "mistral",
		modelId: "codestral",
		spend: "free",
		context: 256_000,
		tags: ["chat", "code"],
		...overrides,
	}
}

function lane(overrides: Partial<Lane> = {}): Lane {
	return {
		id: "code",
		names: ["hybrid/code"],
		capabilities: ["chat", "code"],
		minContext: 60_000,
		order: "fill-first",
		maxSpend: "free",
		spillTiers: ["free"],
		failClosed: false,
		maxQueueMs: 1_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

function instance(overrides: Partial<Instance> = {}): Instance {
	return { id: "cluster", role: "primary", address: "https://omniroute", backupRetention: 20, ...overrides }
}

function residency(overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id: "r0", swapLatencyMs: 0, ...overrides }
}

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device()],
		endpoints: [endpoint()],
		residencyGroups: [residency()],
		offerings: [offering()],
		clouds: [cloud()],
		lanes: [lane()],
		instances: [instance()],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

// A copied attempt: one row of the body-free durable copy. Only corr, ts,
// dur_ms, and requested_model are read by the replay; the rest are padded null.
function row(overrides: Partial<CopiedAttempt>): CopiedAttempt {
	return {
		ts: "2026-10-07T00:00:00.000Z",
		dur_ms: 1000,
		status: 200,
		provider: "vllm",
		model: "qwen-coder",
		requested_model: "hybrid/code",
		connection_id: null,
		tin: null,
		tout: null,
		key: "zoo-m5",
		combo: "hybrid/code",
		step: null,
		corr: "c1",
		exec: null,
		etype: null,
		ttft: null,
		wait: null,
		...overrides,
	}
}

/** An ISO timestamp `seconds` after a fixed base, so start/end math is easy to read. */
const BASE = Date.parse("2026-10-07T00:00:00.000Z")
function at(seconds: number): string {
	return new Date(BASE + seconds * 1000).toISOString()
}

function okEstimate(input: EstimateInput) {
	const outcome = estimateFreeLocalSlots(input)
	if (!outcome.ok) {
		throw new Error(`expected ok, got failures: ${JSON.stringify(outcome.failures)}`)
	}
	return outcome.estimate
}

const WINDOW = { startMs: BASE, endMs: BASE + 3600 * 1000 }

// ---------------------------------------------------------------------------
// First-free-slot assignment + free-local-slot fraction (Req 21.1)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — first-free-slot assignment (Req 21.1)", () => {
	it("assigns the first free local Slot and frees it after the request ends", () => {
		// Two 2-slot code requests that do not overlap each take the first slot and
		// both find a free slot. A third request overlapping both would need a 3rd
		// slot, but gpu0 only has 2.
		const records: CopiedAttempt[] = [
			// req A: start 0, end 10
			row({ corr: "a", ts: at(10), dur_ms: 10_000 }),
			// req B: start 20, end 30 (after A frees its slot)
			row({ corr: "b", ts: at(30), dur_ms: 10_000 }),
		]
		const est = okEstimate({ inventory: inventory(), revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const code = est.routes.find((r) => r.route === "hybrid/code")!
		expect(code.replayed).toBe(2)
		expect(code.freeLocal).toBe(2)
		expect(code.freeFraction).toBe(1)
		expect(code.capacity).toBe(2) // 2 slots on gpu0, ceiling 2
	})

	it("reports a request that finds no free local Slot (all Slots held)", () => {
		// Three requests all overlapping [0, 100]; gpu0 has only 2 slots, so the
		// third finds no free local Slot.
		const records: CopiedAttempt[] = [
			row({ corr: "a", ts: at(100), dur_ms: 100_000 }),
			row({ corr: "b", ts: at(100), dur_ms: 90_000 }),
			row({ corr: "c", ts: at(100), dur_ms: 80_000 }),
		]
		const est = okEstimate({ inventory: inventory(), revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const code = est.routes.find((r) => r.route === "hybrid/code")!
		expect(code.replayed).toBe(3)
		expect(code.freeLocal).toBe(2)
		expect(code.freeFraction).toBeCloseTo(2 / 3, 10)
	})

	it("frees a Slot exactly at the next request's start (half-open [start, end))", () => {
		// req A holds [0, 10). req B starts exactly at 10 on a 1-slot device — the
		// slot is free at 10, so B gets it.
		const inv = inventory({ devices: [device({ slotCeiling: 1 })], offerings: [offering({ slots: 1, ranks: [1] })] })
		const records: CopiedAttempt[] = [
			row({ corr: "a", ts: at(10), dur_ms: 10_000 }),
			row({ corr: "b", ts: at(20), dur_ms: 10_000 }), // start 10, end 20
		]
		const est = okEstimate({ inventory: inv, revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const code = est.routes.find((r) => r.route === "hybrid/code")!
		expect(code.replayed).toBe(2)
		expect(code.freeLocal).toBe(2)
	})

	it("groups attempts by correlation id: a request is one unit over its first-start→final-end span", () => {
		// corr "a" has two attempts (a retry); it is ONE request from the first
		// attempt's start to the final attempt's completion. On a 1-slot device a
		// separate overlapping request "b" then finds no free slot.
		const inv = inventory({ devices: [device({ slotCeiling: 1 })], offerings: [offering({ slots: 1, ranks: [1] })] })
		const records: CopiedAttempt[] = [
			row({ corr: "a", ts: at(5), dur_ms: 5_000 }), // attempt 1: [0, 5]
			row({ corr: "a", ts: at(30), dur_ms: 10_000 }), // attempt 2 (final): [20, 30] → request span [0, 30)
			row({ corr: "b", ts: at(20), dur_ms: 10_000 }), // [10, 20): overlaps request a's [0, 30)
		]
		const est = okEstimate({ inventory: inv, revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const code = est.routes.find((r) => r.route === "hybrid/code")!
		expect(code.replayed).toBe(2) // two distinct requests
		expect(code.freeLocal).toBe(1) // b overlaps a, 1-slot device
	})
})

// ---------------------------------------------------------------------------
// Route matching + exclusions (Req 21.1)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — route matching (Req 21.1)", () => {
	it("matches a Route_Alias by exact case-sensitive name and excludes unmatched requested models", () => {
		const inv = inventory({ lanes: [lane({ names: ["hybrid/code", "hybrid/code-old"] })] })
		const records: CopiedAttempt[] = [
			row({ corr: "a", ts: at(10), dur_ms: 5_000, requested_model: "hybrid/code" }),
			row({ corr: "b", ts: at(20), dur_ms: 5_000, requested_model: "hybrid/code-old" }), // alias
			row({ corr: "c", ts: at(30), dur_ms: 5_000, requested_model: "Hybrid/Code" }), // case mismatch → excluded
			row({ corr: "d", ts: at(40), dur_ms: 5_000, requested_model: "memory/embed" }), // no such route → excluded
		]
		const est = okEstimate({ inventory: inv, revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const code = est.routes.find((r) => r.route === "hybrid/code")!
		expect(code.replayed).toBe(2)
		expect(est.excluded).toEqual([
			{ requestedModel: "Hybrid/Code", count: 1 },
			{ requestedModel: "memory/embed", count: 1 },
		])
	})

	it("reports no data (null fraction) for a Public_Route with no replayed request", () => {
		const inv = inventory({
			lanes: [lane(), lane({ id: "fast", names: ["hybrid/fast"] })],
		})
		const records: CopiedAttempt[] = [row({ corr: "a", ts: at(10), dur_ms: 5_000, requested_model: "hybrid/code" })]
		const est = okEstimate({ inventory: inv, revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const fast = est.routes.find((r) => r.route === "hybrid/fast")!
		expect(fast.replayed).toBe(0)
		expect(fast.freeFraction).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Capacity + distinct-slot count + baseline demand (Req 21.2)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — RouteCapacity + Local_Demand_Distribution (Req 21.2)", () => {
	it("reports RouteCapacity next to the baseline distribution and the distinct-slot count", () => {
		const inv = inventory({
			devices: [device({ id: "gpu0", slotCeiling: 2 }), device({ id: "arc0", slotCeiling: 3 })],
			endpoints: [endpoint(), endpoint({ id: "ovms", provider: "ovms-arc", deviceIds: ["arc0"] })],
			offerings: [
				offering(),
				offering({
					id: "embed",
					endpointId: "ovms",
					deviceId: "arc0",
					modelId: "qwen-embed",
					context: 4096,
					slots: 3,
					residencyGroup: "r-embed",
					tags: ["embed"],
					ranks: [1, 1, 1],
				}),
			],
			lanes: [
				lane(),
				lane({ id: "embed", names: ["memory/embed"], capabilities: ["embed"], minContext: 4096, spillTiers: [], capabilityLanes: [] }),
			],
		})
		const est = okEstimate({ inventory: inv, revision: REV, records: [], window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		const byRoute = new Map(est.routes.map((r) => [r.route, r.capacity]))
		expect(byRoute.get("hybrid/code")).toBe(2)
		expect(byRoute.get("memory/embed")).toBe(3)
		// distinctLocalSlots excludes the embeddings route's 3 slots → only code's 2.
		expect(est.distinctLocalSlots).toBe(2)
		expect(est.localDemand).toEqual(INITIAL_BASELINE_LOCAL_DEMAND)
	})
})

// ---------------------------------------------------------------------------
// Determinism over a fixed window (Property 11, Req 21.1)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — determinism over a fixed window (Req 21.1)", () => {
	it("same window + same records → same output, regardless of record order", () => {
		const records: CopiedAttempt[] = [
			row({ corr: "a", ts: at(10), dur_ms: 10_000 }),
			row({ corr: "b", ts: at(15), dur_ms: 10_000 }),
			row({ corr: "c", ts: at(40), dur_ms: 10_000 }),
			row({ corr: "d", ts: at(5), dur_ms: 5_000 }),
		]
		const base: EstimateInput = { inventory: inventory(), revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND }
		const first = okEstimate(base)
		const second = okEstimate(base)
		const shuffled = okEstimate({ ...base, records: [...records].reverse() })
		expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
		expect(JSON.stringify(shuffled)).toEqual(JSON.stringify(first))
	})
})

// ---------------------------------------------------------------------------
// partial / no-data marks (Req 21.6)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — partial / no-data marks (Req 21.6)", () => {
	it("marks no-data when no record is readable", () => {
		const est = okEstimate({ inventory: inventory(), revision: REV, records: [], window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		expect(est.completeness).toBe("no-data")
		expect(est.coveredSpan).toBeNull()
		for (const route of est.routes) {
			expect(route.replayed).toBe(0)
			expect(route.freeFraction).toBeNull()
		}
	})

	it("marks partial when the window extends before the earliest readable record", () => {
		// Window starts well before any record; earliest record start is at(600).
		const windowBefore = { startMs: BASE - 3600 * 1000, endMs: BASE + 3600 * 1000 }
		const records: CopiedAttempt[] = [row({ corr: "a", ts: at(600), dur_ms: 10_000 })]
		const est = okEstimate({ inventory: inventory(), revision: REV, records, window: windowBefore, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		expect(est.completeness).toBe("partial")
		expect(est.coveredSpan).not.toBeNull()
		expect(est.coveredSpan![0]).toBe(BASE + 590 * 1000) // start = 600s − 10s dur
	})

	it("marks complete when records cover the window start", () => {
		const records: CopiedAttempt[] = [row({ corr: "a", ts: at(10), dur_ms: 10_000 })]
		const est = okEstimate({ inventory: inventory(), revision: REV, records, window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		expect(est.completeness).toBe("complete")
		expect(est.coveredSpan).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Compile failure surfaced (Req 21.5 feed)
// ---------------------------------------------------------------------------

describe("estimateFreeLocalSlots — compile failure (Req 21.5)", () => {
	it("returns the Route_Compiler failures when the candidate revision does not compile", () => {
		// A lane whose capability no offering or cloud carries → no eligible target.
		const inv = inventory({
			clouds: [],
			lanes: [lane({ capabilities: ["chat", "nonexistent-capability"] })],
		})
		const outcome = estimateFreeLocalSlots({ inventory: inv, revision: REV, records: [], window: WINDOW, localDemand: INITIAL_BASELINE_LOCAL_DEMAND })
		expect(outcome.ok).toBe(false)
		if (!outcome.ok) {
			expect(outcome.failures.length).toBeGreaterThan(0)
			expect(outcome.failures[0]!.code).toBe("lane-no-eligible-target")
		}
	})
})

// ---------------------------------------------------------------------------
// Speed-model extension (optional, not a Requirement) + oracle cross-check
// ---------------------------------------------------------------------------

describe("simulateSpeedModel — optional ranking/sizing extension", () => {
	it("lands uncontended requests on the first slot with scaled 5090 service time", () => {
		const slots: SpeedSlot[] = [{ device: "5090", card: "5090", contextWindow: 163_840 }]
		const items: SpeedWorkItem[] = [
			{ route: "hybrid/code", startSeconds: 0, work5090Seconds: 10, inputTokens: 1000 },
			{ route: "hybrid/code", startSeconds: 100, work5090Seconds: 10, inputTokens: 1000 },
		]
		const summaries = simulateSpeedModel(items, slots, BASELINE_SPEED_MODEL)
		const code = summaries.find((s) => s.route === "hybrid/code")!
		expect(code.count).toBe(2)
		expect(code.cloudPercent).toBe(0)
		// Uncontended: latency = work * scale = 10 * 0.90 = 9 s.
		expect(code.meanSeconds).toBeCloseTo(9, 6)
	})

	it("skips a slot whose context window is smaller than the request", () => {
		const slots: SpeedSlot[] = [
			{ device: "4070", card: "4070-27B", contextWindow: 10_000 },
			{ device: "5090", card: "5090", contextWindow: 163_840 },
		]
		const items: SpeedWorkItem[] = [{ route: "hybrid/code", startSeconds: 0, work5090Seconds: 10, inputTokens: 50_000 }]
		const summaries = simulateSpeedModel(items, slots, BASELINE_SPEED_MODEL)
		const code = summaries.find((s) => s.route === "hybrid/code")!
		// It skips the 4070 (10k window) and lands on the 5090 at 10 * 0.90 = 9 s.
		expect(code.meanSeconds).toBeCloseTo(9, 6)
	})

	it("is deterministic for a fixed input", () => {
		const slots: SpeedSlot[] = [{ device: "5090", card: "5090", contextWindow: 163_840 }]
		const items: SpeedWorkItem[] = [
			{ route: "hybrid/code", startSeconds: 0, work5090Seconds: 10, inputTokens: 1000 },
			{ route: "hybrid/code", startSeconds: 5, work5090Seconds: 20, inputTokens: 1000 },
		]
		const a = simulateSpeedModel(items, slots, BASELINE_SPEED_MODEL)
		const b = simulateSpeedModel([...items].reverse(), slots, BASELINE_SPEED_MODEL)
		expect(JSON.stringify(b)).toEqual(JSON.stringify(a))
	})

	it("cross-checks the fitted constants against arrangement-replay-results.md (if it loads)", () => {
		const resultsPath = fileURLToPath(
			new URL("../../../../../.agents/tasks/omniroute-fleet-topology/arrangement-replay-results.md", import.meta.url),
		)
		let text: string
		try {
			text = readFileSync(resultsPath, "utf8")
		} catch {
			// The design-time artifact is not available in this checkout; the oracle
			// cross-check needs it, so skip without failing (the deterministic
			// Requirement 21 replay above does not depend on the artifact).
			return
		}
		// The results file records f2 = 1.78 and the duration multipliers used by
		// the baseline speed model; confirm the ported constants match the oracle.
		expect(text).toContain("f2 = 1.78")
		expect(text).toContain("4070 27B IQ3 = 2.98x")
		expect(text).toContain("M5 Uzu = 8.78x")
		expect(text).toContain("0.90 (chosen)")
		expect(BASELINE_SPEED_MODEL.f2).toBeCloseTo(1.78, 6)
		expect(BASELINE_SPEED_MODEL.cardMultiplier["4070-27B"]).toBeCloseTo(2.98, 6)
		expect(BASELINE_SPEED_MODEL.cardMultiplier["M5-Uzu"]).toBeCloseTo(8.78, 6)
		expect(BASELINE_SPEED_MODEL.scale).toBeCloseTo(0.9, 6)
	})
})

describe("percentile — prototype nearest-rank convention", () => {
	it("matches the prototype's ceil(n*p/100), min index 1 convention", () => {
		const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		expect(percentile(xs, 50)).toBe(5) // ceil(10*50/100)=5 → index 5 → value 5
		expect(percentile(xs, 95)).toBe(10) // ceil(10*95/100)=10 → value 10
		expect(percentile([], 50)).toBeNaN()
	})
})
