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

import type { Revision } from "../../compile/compiler.js"
import type { Attribution, ReconcilerAuditEntry } from "../../observe/attribution.js"
import type { CopiedAttempt, StoredRow } from "../../observe/copy.js"
import type { AttributeRow } from "../../observe/metrics.js"
import {
	INITIAL_BASELINE,
	earlyCheck,
	evaluate,
	evaluationWindow,
	rankCandidates,
	remeasureBaseline,
	type EvaluationReport,
} from "../evaluate.js"

// ---------------------------------------------------------------------------
// Fixtures — a small fleet: a primary cluster instance, a code + research +
// rerank + fast lane, one local GPU, one cloud spill target.
// ---------------------------------------------------------------------------

const REV: Revision = { commit: "cand1", uncommitted: false }
const PRIMARY = "cluster"
const BASE = Date.parse("2026-11-01T00:00:00.000Z")
const HOUR = 60 * 60 * 1000

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

/** One stored row with all body-free fields defaulted. */
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
		rowId: `${full.corr ?? ""}:${full.ts}:${Math.random()}`,
		instanceId: extra.instanceId ?? PRIMARY,
		isHealthProbe: extra.isHealthProbe ?? false,
		fields: full,
		...extra,
	}
}

/**
 * A direct attribution reading Device/Model_Offering/Cloud_Target/Public_Route
 * from the row fields: `combo` names the Public_Route; `provider === "cloud"`
 * (or model === "codestral") marks a cloud attempt; otherwise it is local on
 * gpu0/coder (or the embed/rerank offering named by `model`).
 */
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

/**
 * `n` successful code requests at distinct correlation ids landing locally. The
 * FIRST request is anchored at the window start (`startHour`, default 0) so the
 * observer's coverage begins at the window start and the evaluation is not
 * marked partial; the rest are spaced 1 s apart. `durMs` is subtracted from the
 * completion time, so a request completing at the window start still starts
 * inside the window.
 */
function codeRequests(
	n: number,
	opts: { status?: number; durMs?: number; cloud?: number; startHour?: number } = {},
): StoredRow[] {
	const rows: StoredRow[] = []
	const durMs = opts.durMs ?? 10_000
	// Anchor the first COMPLETION at the window start so the observer's coverage
	// begins there and the evaluation is not marked partial (metrics tracks
	// coverage by completion time). The rest complete 1 s apart afterward.
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

// ---------------------------------------------------------------------------
// Evaluation window (Requirement 19.1)
// ---------------------------------------------------------------------------

describe("evaluationWindow (Req 19.1)", () => {
	it("returns not-applied when a declared Managed_Instance has no applying apply", () => {
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [], // no apply recorded
			longestRequestTimeoutMs: 0,
			rows: [],
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(false)
		if (!outcome.ok) {
			expect(outcome.reason).toBe("not-applied")
		}
	})

	it("starts at the apply end + longest request timeout and ends at 168 h when the 7-day span has <100 requests on every route", () => {
		// A sparse log (one request total) never trips the ≥100/≥500 gate, so the
		// window runs to the 7-day floor.
		const rows = codeRequests(1, { startHour: 2 })
		const outcome = evaluationWindow({
			inventory: inventory(),
			revision: REV,
			audit: [applyEntry(0)],
			longestRequestTimeoutMs: 600_000, // 10 min
			rows,
			attribute: attribute(),
		})
		expect(outcome.ok).toBe(true)
		if (outcome.ok) {
			expect(outcome.window.startMs).toBe(BASE + 600_000)
			expect(outcome.endOffsetHours).toBe(168)
			expect(outcome.cappedAt672h).toBe(false)
		}
	})

	it("ends at the earliest whole-hour offset where every ≥100-request route has ≥500 requests", () => {
		// 600 code requests all land inside the first hour → by 168 h the route has
		// ≥100 and ≥500, so the window ends at exactly 168 h.
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
		}
	})
})

// ---------------------------------------------------------------------------
// A floor pass (Requirement 20.1-20.5)
// ---------------------------------------------------------------------------

const FULL_WINDOW = { startMs: BASE, endMs: BASE + 168 * HOUR }

describe("evaluate — a floor pass (Req 20.1-20.5)", () => {
	it("accepts a candidate whose Gated_Route meets every floor", () => {
		// 200 code requests, all local successes → final success 100% ≥ 99.4%,
		// local share 100% ≥ 98.1%, no dead targets.
		const rows = codeRequests(200)
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		expect(report.completeness).toBe("complete")
		expect(report.rejected).toBe(false)
		const codeFloor = report.floors.find((f) => f.floor === "hybrid/code.final-success")!
		expect(codeFloor.outcome).toBe("passed")
		const localShare = report.floors.find((f) => f.floor === "code-research.local-share")!
		expect(localShare.outcome).toBe("passed")
		expect(report.rollbackRecommendation).toBeNull()
		// Nine objectives reported when not rejected.
		expect(report.objectives).toHaveLength(9)
	})
})

// ---------------------------------------------------------------------------
// Local-share floor failure (Req 20.3)
// ---------------------------------------------------------------------------

describe("evaluate — local-share floor failure (Req 20.3)", () => {
	it("rejects when the code+research cloud share pushes local share below 98.1%", () => {
		// 200 code requests, 10 on cloud (5% cloud → 95% local < 98.1%).
		const rows = codeRequests(200, { cloud: 10 })
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		expect(report.rejected).toBe(true)
		const localShare = report.floors.find((f) => f.floor === "code-research.local-share")!
		expect(localShare.outcome).toBe("failed")
		expect(localShare.candidate! < 0.981).toBe(true)
		// A rollback RECOMMENDATION is attached and names the backup location.
		expect(report.rollbackRecommendation).not.toBeNull()
		const inst = report.rollbackRecommendation!.instances.find((i) => i.instanceId === PRIMARY)!
		expect(inst.kind).toBe("backup")
		expect(inst.backupLocation).toBeTruthy()
	})
})

// ---------------------------------------------------------------------------
// p95 ceiling failure (Req 20.2)
// ---------------------------------------------------------------------------

describe("evaluate — p95 ceiling failure (Req 20.2)", () => {
	it("rejects when code e2e p95 exceeds 402.6 s", () => {
		// 200 code requests at 500 s each → p95 = 500 s > 402.6 s.
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
	})
})

// ---------------------------------------------------------------------------
// Dead_Target attempt failure (Req 20.5)
// ---------------------------------------------------------------------------

describe("evaluate — Dead_Target attempt rejection (Req 20.5)", () => {
	it("rejects when a local offering fails every attempt ≥10 times (a dead-target run)", () => {
		// A second lane/offering on a dead device: 12 failed attempts, 0 success.
		const inv = inventory({
			devices: [device("gpu0"), device("gpu1")],
			endpoints: [endpoint(), endpoint({ id: "vllm2", deviceIds: ["gpu1"] })],
			offerings: [
				offering(),
				offering({ id: "reader", endpointId: "vllm2", deviceId: "gpu1", modelId: "reader-9b", tags: ["chat", "read"] }),
			],
			lanes: [lane(), lane({ id: "reader", names: ["hybrid/reader"], capabilities: ["chat", "read"], capabilityLanes: ["reader.fast"] })],
		})
		// Attribute the dead offering by model id.
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
})

// ---------------------------------------------------------------------------
// A non-Gated_Route never causes rejection (Req 19.6, 20.10)
// ---------------------------------------------------------------------------

describe("evaluate — a non-Gated_Route never causes rejection (Req 19.6, 20.10)", () => {
	it("does not reject on a route with <100 requests even when its success is terrible", () => {
		// 200 healthy code requests (gated, passing) + 20 all-failed research
		// requests (NOT gated — only 20 < 100). The research route would fail the
		// success floor if gated, but it is excluded from floors.
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

// ---------------------------------------------------------------------------
// Objective-order ranking (Req 20.7)
// ---------------------------------------------------------------------------

describe("rankCandidates — objective-order ranking (Req 20.7)", () => {
	it("ranks the candidate with the larger improvement on the first declared objective higher", () => {
		// Build two complete, non-rejected reports with hand-set objectives: the
		// first objective in the order is planner-cloud-share (improvement = a
		// decrease). Candidate A decreases it more → ranks higher.
		const base = (): EvaluationReport => ({
			revision: REV,
			window: FULL_WINDOW,
			baselineId: "initial",
			baselineWindowLabel: INITIAL_BASELINE.windowLabel,
			requestCounts: [],
			comparisons: [],
			completeness: "complete",
			floors: [],
			rejected: false,
			objectives: OBJECTIVE_ORDER.map((objective) => ({
				objective,
				candidate: 0,
				baseline: 0.5,
				absoluteChange: 0,
				relativeChange: 0,
				improvement: false,
				unit: "fraction" as const,
			})),
			rollbackRecommendation: null,
			human: "",
		})
		// A improves planner-cloud-share by 10 pp (absoluteChange −0.10); B by 2 pp.
		const withPlanner = (report: EvaluationReport, absoluteChange: number): EvaluationReport => ({
			...report,
			objectives: report.objectives.map((o) =>
				o.objective === "planner-cloud-share" ? { ...o, absoluteChange, improvement: true } : o,
			),
		})
		const a = withPlanner(base(), -0.1)
		const b = withPlanner(base(), -0.02)
		const ranked = rankCandidates([b, a], OBJECTIVE_ORDER)
		expect(ranked[0]!.report).toBe(a)
		expect(ranked[0]!.rank).toBe(1)
		expect(ranked[1]!.report).toBe(b)
	})

	it("ranks a candidate whose change is not computed below one whose change is computed", () => {
		const mk = (plannerChange: number | null): EvaluationReport => ({
			revision: REV,
			window: FULL_WINDOW,
			baselineId: "initial",
			baselineWindowLabel: INITIAL_BASELINE.windowLabel,
			requestCounts: [],
			comparisons: [],
			completeness: "complete",
			floors: [],
			rejected: false,
			objectives: OBJECTIVE_ORDER.map((objective) => ({
				objective,
				candidate: plannerChange === null && objective === "planner-cloud-share" ? null : 0,
				baseline: 0.5,
				absoluteChange: objective === "planner-cloud-share" ? plannerChange : 0,
				relativeChange: 0,
				improvement: objective === "planner-cloud-share" && plannerChange !== null ? plannerChange < 0 : false,
				unit: "fraction" as const,
			})),
			rollbackRecommendation: null,
			human: "",
		})
		const computed = mk(-0.05)
		const notComputed = mk(null)
		const ranked = rankCandidates([notComputed, computed], OBJECTIVE_ORDER)
		expect(ranked[0]!.report).toBe(computed)
		expect(ranked[1]!.report).toBe(notComputed)
	})
})

// ---------------------------------------------------------------------------
// Re-measured baseline retention (Req 19.5)
// ---------------------------------------------------------------------------

describe("remeasureBaseline — retains earlier baselines (Req 19.5)", () => {
	it("records a new baseline over a ≥168 h window and keeps the initial baseline unchanged", () => {
		const rows = codeRequests(300)
		const result = remeasureBaseline({
			inventory: inventory(),
			window: { startMs: BASE, endMs: BASE + 200 * HOUR }, // ≥168 h
			rows,
			attribute: attribute(),
			existing: [INITIAL_BASELINE],
		})
		expect(result.ok).toBe(true)
		if (result.ok) {
			// The initial baseline is retained unchanged.
			const retainedInitial = result.baselines.find((b) => b.id === INITIAL_BASELINE.id)!
			expect(retainedInitial.values["code.final-success"]!.value).toBe(0.994)
			// The new baseline is distinct and keyed by its window.
			expect(result.baseline.id).not.toBe(INITIAL_BASELINE.id)
			expect(result.baselines).toContain(result.baseline)
			expect(result.baselines.length).toBeGreaterThanOrEqual(2)
		}
	})

	it("rejects a window shorter than 168 h", () => {
		const result = remeasureBaseline({
			inventory: inventory(),
			window: { startMs: BASE, endMs: BASE + 100 * HOUR },
			rows: [],
			attribute: attribute(),
			existing: [INITIAL_BASELINE],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.reason).toBe("window-too-short")
		}
	})
})

// ---------------------------------------------------------------------------
// Incomplete on an intervening apply/rollback (Req 19.8)
// ---------------------------------------------------------------------------

describe("evaluate — incomplete on an intervening apply/rollback (Req 19.8)", () => {
	it("marks the evaluation incomplete and computes no floor outcome when another revision applies mid-window", () => {
		const otherRev: Revision = { commit: "other", uncommitted: false }
		const intervening: ReconcilerAuditEntry = {
			kind: "apply",
			instanceId: PRIMARY,
			outcome: "succeeded",
			revision: otherRev,
			// Starts 50 h into the window.
			startedAt: new Date(BASE + 50 * HOUR).toISOString(),
			endedAt: new Date(BASE + 50 * HOUR).toISOString(),
		}
		const rows = codeRequests(200)
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0), intervening],
			rows,
			attribute: attribute(),
		})
		expect(report.completeness).toBe("incomplete")
		expect(report.incompleteCause).toBe("intervening-apply")
		expect(report.floors).toHaveLength(0)
		expect(report.rejected).toBe(false)
		expect(report.measuredSpan).toEqual({ startMs: BASE, endMs: BASE + 50 * HOUR })
	})

	it("marks incomplete on an intervening rollback", () => {
		const rollback: ReconcilerAuditEntry = {
			kind: "rollback",
			instanceId: PRIMARY,
			outcome: "succeeded",
			revision: REV,
			startedAt: new Date(BASE + 30 * HOUR).toISOString(),
			endedAt: new Date(BASE + 30 * HOUR).toISOString(),
			rolledBackApplyStartedAt: new Date(BASE).toISOString(),
		}
		const rows = codeRequests(200)
		const report = evaluate({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0), rollback],
			rows,
			attribute: attribute(),
		})
		expect(report.completeness).toBe("incomplete")
		expect(report.incompleteCause).toBe("intervening-rollback")
	})
})

// ---------------------------------------------------------------------------
// 24 h early-check rollback recommendation (Req 21.3, 21.4)
// ---------------------------------------------------------------------------

describe("earlyCheck — 24 h early check + rollback recommendation (Req 21.3, 21.4)", () => {
	it("reports a failed floor over the first 24 h and recommends a rollback naming the backup", () => {
		// 200 code requests in the first hour, 10 on cloud → local share 95% <
		// 98.1% within the 24 h check span.
		const rows = codeRequests(200, { cloud: 10, startHour: 1 })
		const check = earlyCheck({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		// The check span is the first 24 h of the Evaluation_Window.
		expect(check.checkSpan).toEqual({ startMs: BASE, endMs: BASE + 24 * HOUR })
		const localShare = check.floors.find((f) => f.floor === "code-research.local-share")!
		expect(localShare.outcome).toBe("failed")
		// The early check never carries the 20.5 Dead_Target floor.
		expect(check.floors.some((f) => f.floor === "dead-target-attempts")).toBe(false)
		// A rollback recommendation names the primary's Route_Backup.
		expect(check.rollbackRecommendation).not.toBeNull()
		const inst = check.rollbackRecommendation!.instances.find((i) => i.instanceId === PRIMARY)!
		expect(inst.kind).toBe("backup")
		expect(inst.backupLocation).toBeTruthy()
		expect(check.rollbackRecommendation!.failedFloors.some((f) => f.floor === "code-research.local-share")).toBe(true)
	})

	it("does not recommend a rollback when every floor passes", () => {
		const rows = codeRequests(200, { startHour: 1 })
		const check = earlyCheck({
			inventory: inventory(),
			revision: REV,
			window: FULL_WINDOW,
			audit: [applyEntry(0)],
			rows,
			attribute: attribute(),
		})
		expect(check.rollbackRecommendation).toBeNull()
	})
})
