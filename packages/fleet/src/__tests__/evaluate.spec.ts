// Arrangement_Evaluator capstone — composes the pre-deployment estimate replay
// (`evaluate/estimate.ts`) and the post-deployment evaluation (`evaluate/evaluate.ts`)
// into the FORMAL Property 11 and the specific floor / ranking / window-boundary
// tests task 9.3 names. The per-module suites `evaluate/__tests__/estimate.spec.ts`
// and `evaluate/__tests__/evaluate.spec.ts` already cover the mechanics by example;
// this file adds the universal property (fast-check, ≥100 runs) and the capstone
// scenarios that exercise estimate + evaluate together without duplicating them.
//
// _Requirements: 20.1, 20.2, 20.3, 20.5, 20.7, 21.1_
// _Properties: 11_

import fc from "fast-check"
import type {
	CloudTarget,
	Device,
	Endpoint,
	FleetInventory,
	ImprovementObjectiveId,
	Instance,
	Lane,
	ModelOffering,
	ResidencyGroup,
} from "@roo-code/types"
import { describe, expect, it } from "vitest"

import type { Revision } from "../compile/compiler.js"
import type { Attribution, ReconcilerAuditEntry } from "../observe/attribution.js"
import type { CopiedAttempt, StoredRow } from "../observe/copy.js"
import type { AttributeRow } from "../observe/metrics.js"
import {
	INITIAL_BASELINE_LOCAL_DEMAND,
	estimateFreeLocalSlots,
	type EstimateInput,
} from "../evaluate/estimate.js"
import {
	INITIAL_BASELINE,
	evaluate,
	evaluationWindow,
	rankCandidates,
	type EvaluationReport,
} from "../evaluate/evaluate.js"

// ---------------------------------------------------------------------------
// Fixtures — the small single-primary fleet the per-module suites use: one GPU
// device with a two-slot code offering, a code lane, and a cloud spill target.
// Reused here so the capstone composes the same shapes those suites validate.
// ---------------------------------------------------------------------------

const REV: Revision = { commit: "cand1", uncommitted: false }
const PRIMARY = "cluster"
const BASE = Date.parse("2026-11-01T00:00:00.000Z")
const HOUR = 60 * 60 * 1000

function device(id = "gpu0", overrides: Partial<Device> = {}): Device {
	return { id, slotCeiling: 2, hostPreemption: false, ...overrides }
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: "vllm",
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: PRIMARY, url: "http://gpu0:2701" }],
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
	return { id: PRIMARY, role: "primary", address: "https://omniroute", backupRetention: 20, ...overrides }
}

function residency(overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id: "r0", swapLatencyMs: 0, ...overrides }
}

const OBJECTIVE_ORDER: readonly ImprovementObjectiveId[] = [
	"planner-cloud-share",
	"planner-multi-attempt",
	"code-p50",
	"reader-cloud-share",
	"reader-multi-attempt",
	"cloud-input-tokens",
	"capacity-rejections",
	"embeddings-success",
	"model-switches",
]

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
		improvementObjectiveOrder: OBJECTIVE_ORDER as ImprovementObjectiveId[],
		...overrides,
	}
}

/** A body-free copied attempt for the Requirement 21 replay (padded fields). */
function copied(overrides: Partial<CopiedAttempt>): CopiedAttempt {
	return {
		ts: "2026-11-01T01:00:00.000Z",
		dur_ms: 10_000,
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

/** One stored row (observer store) with all body-free fields defaulted. */
function row(fields: Partial<CopiedAttempt>, extra: Partial<StoredRow> = {}): StoredRow {
	const full: CopiedAttempt = {
		ts: "2026-11-01T01:00:00.000Z",
		dur_ms: 10_000,
		status: 200,
		provider: "vllm",
		model: "qwen-coder",
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
		instanceId: extra.instanceId ?? PRIMARY,
		isHealthProbe: extra.isHealthProbe ?? false,
		fields: full,
		...extra,
	}
}

/** The direct attribution the per-module evaluate suite uses. */
function attribute(): AttributeRow {
	return (r: StoredRow): Attribution => {
		const f = r.fields
		const isCloud = f.provider === "mistral" || f.model === "codestral"
		const offeringId = f.model === "embed" ? "embed" : f.model === "rerank" ? "rerank" : "coder"
		const deviceId = f.model === "embed" || f.model === "rerank" ? "arc0" : "gpu0"
		return {
			instanceId: r.instanceId,
			activeRevision: "rev",
			deviceId: isCloud ? null : deviceId,
			modelOfferingId: isCloud ? null : offeringId,
			servingEndpointId: isCloud ? null : "vllm",
			cloudTargetId: isCloud ? "codestral" : null,
			publicRoute: f.combo,
			laneId: null,
			capabilityLane: null,
			isUnattributed: false,
			reasons: [],
		}
	}
}

/** An apply that makes REV live on the primary at `hoursAfterBase`. */
function applyEntry(hoursAfterBase: number, overrides: Partial<ReconcilerAuditEntry> = {}): ReconcilerAuditEntry {
	const t = new Date(BASE + hoursAfterBase * HOUR).toISOString()
	return {
		kind: "apply",
		instanceId: PRIMARY,
		outcome: "succeeded",
		revision: REV,
		startedAt: t,
		endedAt: t,
		...overrides,
	}
}

/**
 * `n` code requests at distinct correlation ids. The first completion is
 * anchored at the window start so the observer's coverage begins there and the
 * evaluation is not marked partial; the rest are spaced 1 s apart. `cloud` of
 * them land on cloud; `durMs` sets the end-to-end duration (feeds the p95).
 */
function codeRequests(
	n: number,
	opts: { status?: number; durMs?: number; cloud?: number; startHour?: number } = {},
): StoredRow[] {
	const rows: StoredRow[] = []
	const durMs = opts.durMs ?? 10_000
	const base = BASE + (opts.startHour ?? 0) * HOUR
	for (let i = 0; i < n; i++) {
		const onCloud = opts.cloud !== undefined && i < opts.cloud
		rows.push(
			row({
				corr: `code-${opts.startHour ?? 0}-${i}`,
				ts: new Date(base + i * 1000).toISOString(),
				dur_ms: durMs,
				status: opts.status ?? 200,
				requested_model: "hybrid/code",
				combo: "hybrid/code",
				provider: onCloud ? "mistral" : "vllm",
				model: onCloud ? "codestral" : "qwen-coder",
			}),
		)
	}
	return rows
}

const WINDOW = { startMs: BASE, endMs: BASE + 3600 * 1000 }
const FULL_WINDOW = { startMs: BASE, endMs: BASE + 168 * HOUR }

function okEstimate(input: EstimateInput) {
	const outcome = estimateFreeLocalSlots(input)
	if (!outcome.ok) {
		throw new Error(`expected ok estimate, got failures: ${JSON.stringify(outcome.failures)}`)
	}
	return outcome.estimate
}

// ===========================================================================
// Property 11 — Estimate determinism (Req 21.1)
// ===========================================================================
//
// Feature: omniroute-fleet-topology, Property 11: the replay over a fixed
// recorded window is deterministic — the same window + the same records produce
// byte-identical output, independent of the order the records arrive in.

describe("Property 11 — estimate determinism (Req 21.1)", () => {
	// A generated recorded window + a set of records whose final attempts complete
	// inside it. Each record is one copied attempt; multiple attempts may share a
	// correlation id (a retry). The window is fixed per sample; we assert the
	// replay is a pure function of (records, window) regardless of record order.
	const recordArb: fc.Arbitrary<CopiedAttempt> = fc.record({
		corrSeed: fc.integer({ min: 0, max: 40 }),
		offsetSeconds: fc.integer({ min: 0, max: 3_400 }),
		durMs: fc.integer({ min: 1, max: 120_000 }),
		// A requested model that mostly matches the single code route, with some
		// unmatched ids so the `excluded` tally also participates in determinism.
		requested: fc.constantFrom("hybrid/code", "hybrid/code", "memory/embed", "Hybrid/Code"),
	}).map(({ corrSeed, offsetSeconds, durMs, requested }) =>
		copied({
			corr: `c${corrSeed}`,
			ts: new Date(BASE + offsetSeconds * 1000).toISOString(),
			dur_ms: durMs,
			requested_model: requested,
		}),
	)

	it("same window + same records → byte-identical output, independent of record order (≥100 runs)", () => {
		fc.assert(
			fc.property(fc.array(recordArb, { minLength: 0, maxLength: 40 }), (records) => {
				const input: EstimateInput = {
					inventory: inventory(),
					revision: REV,
					records,
					window: WINDOW,
					localDemand: INITIAL_BASELINE_LOCAL_DEMAND,
				}
				const first = okEstimate(input)
				// Re-run with the identical input: deterministic (no clock / env / I/O).
				const again = okEstimate(input)
				// Re-run with the records reversed: order-independent.
				const reversed = okEstimate({ ...input, records: [...records].reverse() })
				// And with a different stable permutation (sorted by correlation id).
				const permuted = okEstimate({
					...input,
					records: [...records].sort((a, b) => (a.corr ?? "").localeCompare(b.corr ?? "")),
				})
				const canonical = JSON.stringify(first)
				expect(JSON.stringify(again)).toBe(canonical)
				expect(JSON.stringify(reversed)).toBe(canonical)
				expect(JSON.stringify(permuted)).toBe(canonical)
			}),
			{ numRuns: 150 },
		)
	})
})

// ===========================================================================
// Preservation_Floor rejections over `evaluate` (Req 20.2, 20.3, 20.5)
// ===========================================================================

describe("evaluate — Preservation_Floor rejections (Req 20.2, 20.3, 20.5)", () => {
	it("rejects on local-share when code+research cloud share exceeds the 1.9% baseline (Req 20.3)", () => {
		// The baseline pooled local share is 98.1%, i.e. a 1.9% cloud share. 200
		// code requests with 10 on cloud → 5% cloud share, over the 1.9% baseline,
		// so pooled local share 95% < 98.1% → the local-share floor fails.
		const rows = codeRequests(200, { cloud: 10 })
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		expect(report.completeness).toBe("complete")
		expect(report.rejected).toBe(true)
		const localShare = report.floors.find((f) => f.floor === "code-research.local-share")!
		expect(localShare.outcome).toBe("failed")
		expect(localShare.candidate!).toBeLessThan(0.981)
		// Rejection suppresses the improvement objectives (Req 20.6) and attaches a
		// rollback recommendation naming the Route_Backup (Req 21.4).
		expect(report.objectives).toHaveLength(0)
		expect(report.rollbackRecommendation).not.toBeNull()
	})

	it("rejects when code end-to-end p95 exceeds the 110% ceiling (402.6 s) (Req 20.2)", () => {
		// 200 code requests at 500 s each → p95 = 500 s > the 402.6 s ceiling
		// (110% of the 366 s baseline). All land locally so only the p95 fails.
		const rows = codeRequests(200, { durMs: 500_000 })
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		expect(report.rejected).toBe(true)
		const p95 = report.floors.find((f) => f.floor === "hybrid/code.p95")!
		expect(p95.outcome).toBe("failed")
		expect(p95.candidate).toBeCloseTo(500, 5)
		expect(p95.candidate!).toBeGreaterThan(402.6)
	})

	it("rejects on a Dead_Target attempt (a local offering fails every attempt ≥10 times) (Req 20.5)", () => {
		// A second lane/offering on its own device fails all 12 attempts (0 success)
		// → a Dead_Target run; the floor is zero Dead_Target attempts.
		const inv = inventory({
			devices: [device("gpu0"), device("gpu1")],
			endpoints: [endpoint(), endpoint({ id: "vllm2", deviceIds: ["gpu1"] })],
			offerings: [
				offering(),
				offering({ id: "reader", endpointId: "vllm2", deviceId: "gpu1", modelId: "reader-9b", tags: ["chat", "read"] }),
			],
			lanes: [
				lane(),
				lane({ id: "reader", names: ["hybrid/reader"], capabilities: ["chat", "read"], capabilityLanes: ["reader.fast"] }),
			],
		})
		const attr: AttributeRow = (r: StoredRow): Attribution => {
			const f = r.fields
			const isReader = f.model === "reader-9b"
			return {
				instanceId: r.instanceId,
				activeRevision: "rev",
				deviceId: isReader ? "gpu1" : "gpu0",
				modelOfferingId: isReader ? "reader" : "coder",
				servingEndpointId: isReader ? "vllm2" : "vllm",
				cloudTargetId: null,
				publicRoute: f.combo,
				laneId: null,
				capabilityLane: null,
				isUnattributed: false,
				reasons: [],
			}
		}
		const dead: StoredRow[] = []
		for (let i = 0; i < 12; i++) {
			dead.push(
				row({
					corr: `dead-${i}`,
					ts: new Date(BASE + HOUR + i * 1000).toISOString(),
					status: 500,
					etype: "upstream-error",
					requested_model: "hybrid/reader",
					combo: "hybrid/reader",
					model: "reader-9b",
				}),
			)
		}
		const rows = [...codeRequests(200), ...dead]
		const report = evaluate({ inventory: inv, revision: REV, window: FULL_WINDOW, audit: [applyEntry(0)], rows, attribute: attr })
		expect(report.rejected).toBe(true)
		const deadFloor = report.floors.find((f) => f.floor === "dead-target-attempts")!
		expect(deadFloor.outcome).toBe("failed")
		expect(deadFloor.candidate).toBe(12)
	})

	it("never rejects on a non-Gated_Route (<100 requests), even when it fails badly (Req 19.6, 20.10)", () => {
		// 200 healthy code requests (gated, passing) + 20 all-failed research
		// requests. The research route is NOT a Gated_Route (20 < 100), so its
		// metrics are excluded from every floor and cannot cause a rejection.
		const research: StoredRow[] = []
		for (let i = 0; i < 20; i++) {
			research.push(
				row({
					corr: `res-${i}`,
					ts: new Date(BASE + HOUR + i * 1000).toISOString(),
					status: 500,
					etype: "upstream-error",
					requested_model: "hybrid/research",
					combo: "hybrid/research",
				}),
			)
		}
		const inv = inventory({
			lanes: [lane(), lane({ id: "research", names: ["hybrid/research"], capabilityLanes: ["reasoning.escalation"] })],
		})
		const rows = [...codeRequests(200), ...research]
		const report = evaluate({ inventory: inv, revision: REV, window: FULL_WINDOW, audit: [applyEntry(0)], rows, attribute: attribute() })
		expect(report.rejected).toBe(false)
		const researchFloor = report.floors.find((f) => f.floor === "hybrid/research.final-success")!
		expect(researchFloor.outcome).toBe("not-checked")
	})
})

// ===========================================================================
// Objective-order ranking over the eight candidate arrangements (Req 20.7)
// ===========================================================================

describe("rankCandidates — objective-order ranking over eight arrangements (Req 20.7)", () => {
	/**
	 * Build a complete, non-rejected report whose objectives all improve by a
	 * uniform amount `step` (a decrease for every decrease-is-good objective; an
	 * increase for `embeddings-success`). A larger `step` is a strictly larger
	 * improvement on the FIRST declared objective, so eight arrangements with
	 * distinct steps have a total order the ranking must reproduce.
	 */
	function reportWithUniformImprovement(id: string, step: number): EvaluationReport {
		return {
			revision: { commit: id, uncommitted: false },
			window: FULL_WINDOW,
			baselineId: "initial",
			baselineWindowLabel: INITIAL_BASELINE.windowLabel,
			requestCounts: [],
			comparisons: [],
			completeness: "complete",
			floors: [],
			rejected: false,
			objectives: OBJECTIVE_ORDER.map((objective) => {
				const increaseIsGood = objective === "embeddings-success"
				const absoluteChange = increaseIsGood ? step : -step
				return {
					objective,
					candidate: increaseIsGood ? 0.5 + step : 0.5 - step,
					baseline: 0.5,
					absoluteChange,
					relativeChange: absoluteChange / 0.5,
					improvement: step > 0,
					unit: "fraction" as const,
				}
			}),
			rollbackRecommendation: null,
			human: "",
		}
	}

	it("orders the eight arrangements by the improvement on the first declared objective", () => {
		// Eight arrangements, each a distinct uniform improvement step. The one with
		// the largest step improves planner-cloud-share (the first declared
		// objective) the most → ranks first; the smallest → ranks last.
		const steps = [0.01, 0.08, 0.03, 0.1, 0.05, 0.02, 0.07, 0.04]
		const arrangements = steps.map((step, i) => reportWithUniformImprovement(`arr-${i}`, step))

		// Feed them in input order; rankCandidates must sort by the objective order.
		const ranked = rankCandidates(arrangements, OBJECTIVE_ORDER)
		expect(ranked).toHaveLength(8)

		// The expected order is the arrangements sorted by DESCENDING step, since a
		// larger improvement ranks higher on the first objective (ties never occur
		// here because the steps are distinct).
		const expectedCommits = steps
			.map((step, i) => ({ step, commit: `arr-${i}` }))
			.sort((a, b) => b.step - a.step)
			.map((x) => x.commit)
		expect(ranked.map((r) => r.report.revision.commit)).toEqual(expectedCommits)
		// Ranks are the dense 1..8 assignment in that order.
		expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
	})

	it("breaks a first-objective tie on the next declared objective", () => {
		// Two arrangements tie on planner-cloud-share (same rounded improvement) but
		// one improves planner-multi-attempt (the SECOND objective) more; it ranks
		// higher. A third arrangement is clearly worse on the first objective.
		const tieA = reportWithUniformImprovement("tie-a", 0.05)
		const tieB = reportWithUniformImprovement("tie-b", 0.05)
		// Make tie-b worse on the second objective so tie-a wins the tie-break.
		const tieBWorseSecond: EvaluationReport = {
			...tieB,
			objectives: tieB.objectives.map((o) =>
				o.objective === "planner-multi-attempt" ? { ...o, absoluteChange: -0.01 } : o,
			),
		}
		const worst = reportWithUniformImprovement("worst", 0.001)

		const ranked = rankCandidates([worst, tieBWorseSecond, tieA], OBJECTIVE_ORDER)
		expect(ranked.map((r) => r.report.revision.commit)).toEqual(["tie-a", "tie-b", "worst"])
	})

	it("ranks a candidate whose change is not computed below those with a computed change (Req 20.7)", () => {
		const computed = reportWithUniformImprovement("computed", 0.05)
		const notComputed: EvaluationReport = {
			...reportWithUniformImprovement("not-computed", 0.09),
			objectives: reportWithUniformImprovement("not-computed", 0.09).objectives.map((o) =>
				o.objective === "planner-cloud-share"
					? { ...o, candidate: null, absoluteChange: null, relativeChange: null, improvement: null }
					: o,
			),
		}
		const ranked = rankCandidates([notComputed, computed], OBJECTIVE_ORDER)
		// Even though not-computed has a larger step on every OTHER objective, its
		// uncomputed first objective ranks it below the computed candidate.
		expect(ranked[0]!.report.revision.commit).toBe("computed")
		expect(ranked[1]!.report.revision.commit).toBe("not-computed")
	})
})

// ===========================================================================
// Evaluation_Window boundary (Req 19.1)
// ===========================================================================

describe("evaluationWindow — the 7-28 day / ≥100 / ≥500-request boundary (Req 19.1)", () => {
	it("holds the window to the 168 h floor when no route reaches the ≥100-request gate", () => {
		// A single request never trips the ≥100/≥500 gate, so the window ends at the
		// earliest allowed offset: 168 h (7 days). The start is the apply end + the
		// longest declared request timeout.
		const rows = codeRequests(1, { startHour: 2 })
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [applyEntry(0)],
			longestRequestTimeoutMs: 600_000,
			rows,
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(true)
		if (outcome.ok) {
			expect(outcome.window.startMs).toBe(BASE + 600_000)
			expect(outcome.endOffsetHours).toBe(168)
			expect(outcome.cappedAt672h).toBe(false)
			expect(outcome.window.endMs).toBe(BASE + 600_000 + 168 * HOUR)
		}
	})

	it("ends exactly at 168 h once the gated route clears the ≥500-request threshold", () => {
		// 600 code requests all inside the first hour → by 168 h the route has ≥100
		// and ≥500 requests, so the window ends at the earliest qualifying offset.
		const rows = codeRequests(600, { startHour: 1 })
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [applyEntry(0)],
			longestRequestTimeoutMs: 0,
			rows,
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(true)
		if (outcome.ok) {
			expect(outcome.endOffsetHours).toBe(168)
			expect(outcome.cappedAt672h).toBe(false)
		}
	})

	it("caps the window at 672 h when a route stays gated-but-undersampled (≥100 but <500) across the whole range", () => {
		// 200 requests: a Gated_Route (≥100) that never reaches ≥500 → the ≥100/≥500
		// gate never clears, so the window runs to the 672 h (28 day) cap.
		const rows = codeRequests(200, { startHour: 1 })
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [applyEntry(0)],
			longestRequestTimeoutMs: 0,
			rows,
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(true)
		if (outcome.ok) {
			expect(outcome.endOffsetHours).toBe(672)
			expect(outcome.cappedAt672h).toBe(true)
			expect(outcome.window.endMs).toBe(BASE + 672 * HOUR)
		}
	})

	it("returns not-applied when a declared Managed_Instance has no applying apply", () => {
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [],
			longestRequestTimeoutMs: 0,
			rows: [],
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(false)
		if (!outcome.ok) {
			expect(outcome.reason).toBe("not-applied")
		}
	})
})
