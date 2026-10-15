// Arrangement_Evaluator — evaluation window, floors, objectives, ranking
// (design §5, Requirements 19, 20, 21.3, 21.4).
//
// This is the post-deployment half of the Arrangement_Evaluator. Its sibling
// `estimate.ts` is the pre-deployment Requirement 21.1-21.2 replay. Here we:
//
//   1. Compute the EVALUATION_WINDOW (`evaluationWindow`): it starts once every
//      Managed_Instance the candidate revision declares has applied it (from the
//      Reconciler audit history) plus the longest request timeout the revision
//      declares, and ends at the earliest whole-hour offset from 168 h (7 d)
//      through 672 h (28 d) at which each Public_Route with ≥100 requests has
//      ≥500 requests, or at 672 h (Requirement 19.1).
//
//   2. EVALUATE a candidate against a baseline (`evaluate`): compute every
//      Baseline_Metric over the measured window reusing the Requirement 16
//      observer conventions (`metricsOverWindow`), report each metric's absolute
//      and relative change against the baseline used (Requirement 19.3), apply
//      the Preservation_Floors to Gated_Routes only (Requirement 20.1-20.5,
//      19.6, 20.10), report the nine improvement objectives (Requirement 20.6),
//      and mark the evaluation incomplete on an intervening apply/rollback or
//      partial data (Requirement 19.8, 20.9). For the INITIAL baseline the
//      Public_Route metrics are computed over the `zoo-m5` client key only — the
//      population findings.md §6 measured (Requirement 19.7).
//
//   3. RANK candidates (`rankCandidates`): compare evaluated, non-rejected
//      candidates objective by objective in the inventory's declared order
//      (Requirement 20.7).
//
//   4. RE-MEASURE a baseline (`remeasureBaseline`): record a new baseline over a
//      stated ≥168 h window while RETAINING every earlier baseline, including
//      the initial baseline (Requirement 19.5). Floors never move with the
//      baseline (Requirement 20.10).
//
//   5. The 24 h EARLY CHECK (`earlyCheck`): over the first 24 h of the window,
//      report each Preservation_Floor's pass/fail without accepting or rejecting
//      (Requirement 21.3), and attach a rollback RECOMMENDATION — which names the
//      Route_Backup but never performs a rollback — when a floor fails
//      (Requirement 21.4).
//
// Purity: every function here is a pure function of its arguments (records,
// inventory, audit, baseline, bounds). No clock, no env, no I/O. The caller
// supplies `nowMs` where a "within 15 minutes" deadline or a 24 h elapsed check
// needs the current time, and the records come from the observer's 90-day store.

import type { FleetInventory, ImprovementObjectiveId } from "@roo-code/types"

import {
	metricsOverWindow,
	type AttributeRow,
	type FleetMetricsReport,
	type Percentile,
	type PublicRouteMetrics,
} from "../observe/metrics.js"
import type { ReconcilerAuditEntry } from "../observe/attribution.js"
import type { StoredRow } from "../observe/copy.js"
import type { Revision } from "../compile/compiler.js"

// ---------------------------------------------------------------------------
// Constants — floors and baseline values (findings.md §9, Requirement 20)
// ---------------------------------------------------------------------------

/** The hour, in ms, used to express the 7-28 day offsets. */
const HOUR_MS = 60 * 60 * 1000

/** 168 h (7 days) — the earliest Evaluation_Window end offset (Requirement 19.1). */
export const MIN_WINDOW_HOURS = 168
/** 672 h (28 days) — the latest Evaluation_Window end offset (Requirement 19.1). */
export const MAX_WINDOW_HOURS = 672

/** A Public_Route becomes a Gated_Route at ≥100 requests (Requirement 19 Gated_Route). */
export const GATED_ROUTE_MIN_REQUESTS = 100
/** The ≥500-request sufficiency threshold that ends the window early (Requirement 19.1). */
export const WINDOW_END_SUFFICIENT_REQUESTS = 500

/**
 * The per-Public_Route final-success floors (Requirement 20.1). A Gated_Route
 * whose final success rate is BELOW its floor rejects the candidate.
 */
export const FINAL_SUCCESS_FLOORS: Readonly<Record<string, number>> = {
	"hybrid/code": 0.994,
	"hybrid/research": 0.991,
	"hybrid/fast": 0.997,
	"hybrid/reader": 0.994,
	"hybrid/planner": 0.966,
}

/**
 * The per-Public_Route end-to-end p95 ceilings in seconds (Requirement 20.2),
 * each 110% of the baseline. A Gated_Route whose p95 EXCEEDS its ceiling rejects.
 */
export const P95_CEILINGS_SECONDS: Readonly<Record<string, number>> = {
	"hybrid/code": 402.6,
	"hybrid/research": 242.0,
}

/** The code+research pooled local-share floor (Requirement 20.3). */
export const LOCAL_SHARE_FLOOR = 0.981

/** The rerank success-rate floor (Requirement 20.4). */
export const RERANK_SUCCESS_FLOOR = 0.999
/** The rerank p50 ceiling in ms, 110% of the baseline 774 ms (Requirement 20.4). */
export const RERANK_P50_CEILING_MS = 851

/** The two Public_Routes pooled for the local-share floor (Requirement 20.3). */
export const LOCAL_SHARE_ROUTES = ["hybrid/code", "hybrid/research"] as const

/** The capability tags that identify the embeddings and rerank lanes. */
const EMBED_TAG = "embed"
const RERANK_TAG = "rerank"

// ---------------------------------------------------------------------------
// Baseline model (Requirement 19.4, 19.5)
// ---------------------------------------------------------------------------

/**
 * One baseline the evaluator compares a candidate against. The INITIAL baseline
 * is the findings.md §9 values keyed to the 2026-10-07T04:24Z → 2026-10-14T04:24Z
 * window (Requirement 19.4); a re-measured baseline is computed over its own
 * window and keyed by its start/end (Requirement 19.5).
 */
export interface Baseline {
	/** `"initial"` or an ISO-8601 window `start/end` string (Requirement 19.3 "identified by its window"). */
	readonly id: string
	/** Human label of the baseline window. */
	readonly windowLabel: string
	/** Baseline value of each Baseline_Metric, keyed by metric id. */
	readonly values: Readonly<Record<string, BaselineValue>>
}

/** One baseline metric value with its unit and any mark. */
export interface BaselineValue {
	/** The numeric value in the metric's unit, or null when not measured / no data. */
	readonly value: number | null
	/** The unit (`"fraction"`, `"seconds"`, `"ms"`, `"tokens"`, `"count"`, `"percent"`). */
	readonly unit: MetricUnit
	/** Sample count, when the baseline recorded one. */
	readonly samples?: number
	/** A partial / unreliable / no-data / not-measured mark recorded with the value. */
	readonly mark?: MetricMark
}

export type MetricUnit = "fraction" | "percent" | "seconds" | "ms" | "tokens" | "count"
export type MetricMark = "partial" | "unreliable" | "no-data" | "not-measured"

/**
 * The INITIAL baseline — findings.md §9, window 2026-10-07T04:24Z →
 * 2026-10-14T04:24Z (Requirement 19.4). Each §9 row value (other than
 * parenthesized breakdowns) is one Baseline_Metric; approximate (≈/~) values are
 * taken exactly as stated. Combo / routing-state-artifact rows and the
 * indexer-only embeddings rate are "not measured" (Requirement 19.7 last bullet).
 */
export const INITIAL_BASELINE: Baseline = {
	id: "initial",
	windowLabel: "2026-10-07T04:24Z → 2026-10-14T04:24Z",
	values: {
		"code.final-success": { value: 0.994, unit: "fraction" },
		"code.p50": { value: 43.5, unit: "seconds" },
		"code.p95": { value: 366, unit: "seconds" },
		"research.final-success": { value: 0.991, unit: "fraction" },
		"research.p50": { value: 28.9, unit: "seconds" },
		"research.p95": { value: 220, unit: "seconds" },
		"planner.final-success": { value: 0.966, unit: "fraction" },
		"planner.p50": { value: 34.8, unit: "seconds" },
		"planner.p95": { value: 402, unit: "seconds" },
		"planner.cloud-share": { value: 0.493, unit: "fraction" },
		"reader.final-success": { value: 0.994, unit: "fraction" },
		"reader.p50": { value: 14.5, unit: "seconds" },
		"reader.p95": { value: 114, unit: "seconds" },
		"reader.cloud-share": { value: 0.17, unit: "fraction" },
		"fast.final-success": { value: 0.997, unit: "fraction" },
		"fast.p50": { value: 14.2, unit: "seconds" },
		"fast.cloud-share": { value: 0.088, unit: "fraction" },
		"code-research.local-share": { value: 0.981, unit: "fraction" },
		"code.multi-attempt": { value: 0.061, unit: "fraction" },
		"planner.multi-attempt": { value: 0.213, unit: "fraction" },
		"reader.multi-attempt": { value: 0.166, unit: "fraction" },
		"cloud-input-tokens": { value: 26_600_000, unit: "tokens" },
		"capacity-rejections": { value: 174, unit: "count" },
		"embeddings-success": { value: 0.778, unit: "fraction" },
		"rerank-success": { value: 1.0, unit: "fraction" },
		"rerank-p50": { value: 774, unit: "ms" },
		"model-switches": { value: 217, unit: "count" },
		"dead-target-attempts": { value: 96, unit: "count" },
		// Not measured (Requirement 19.7): indexer-only embeddings rate, combos,
		// used entrypoints, identical groups, routing-state artifacts, generator
		// commits.
		"embeddings-indexer-success": { value: null, unit: "fraction", mark: "not-measured" },
	},
}

// ---------------------------------------------------------------------------
// Evaluation window (Requirement 19.1)
// ---------------------------------------------------------------------------

/** A half-open window [startMs, endMs) in epoch ms. */
export interface Window {
	readonly startMs: number
	readonly endMs: number
}

/** The outcome of computing an Evaluation_Window (Requirement 19.1). */
export type EvaluationWindowOutcome =
	| {
			readonly ok: true
			readonly window: Window
			/** The whole-hour offset (from window start) the window ended at, in hours. */
			readonly endOffsetHours: number
			/** True when the window ended at the 672 h cap with no qualifying offset. */
			readonly cappedAt672h: boolean
	  }
	| {
			readonly ok: false
			/** `"not-applied"`: not every declared Managed_Instance has applied the revision. */
			readonly reason: "not-applied"
	  }

/** The inputs the window computation needs. */
export interface EvaluationWindowInput {
	readonly inventory: FleetInventory
	readonly revision: Revision
	/** The Reconciler audit history (Requirement 19.1 — find the apply end times). */
	readonly audit: readonly ReconcilerAuditEntry[]
	/**
	 * The longest request timeout the revision declares, in ms. The caller
	 * derives it from the compiled Desired_Route_State's request/stream timeouts
	 * (Requirement 19.1 "plus the longest request timeout that the revision
	 * declares"); the evaluator takes it as an argument to stay pure.
	 */
	readonly longestRequestTimeoutMs: number
	/** The observer rows the window-end request counting reads. */
	readonly rows: readonly StoredRow[]
	/** How to attribute a row to a Device/Model_Offering/Public_Route (reused by the metrics pass). */
	readonly attribute: AttributeRow
}

/**
 * Compute the Evaluation_Window for a candidate Arrangement (Requirement 19.1).
 *
 * The window STARTS at the latest apply end time across every Managed_Instance
 * the revision declares (an apply that ended `succeeded` or `no-changes`), plus
 * the longest request timeout. When even one declared Managed_Instance has no
 * such apply, the window has not started — the result is `{ ok: false,
 * reason: "not-applied" }`.
 *
 * The window ENDS at the earliest whole-hour offset h in [168, 672] at which
 * every Public_Route (on every Managed_Instance) that has ≥100 requests between
 * the window start and h has ≥500 requests in that span, or at 672 h when no
 * offset qualifies. Requests are counted as Requirement 16 criteria 3 and 9 do
 * (a request = attempts sharing one correlation id; it belongs to a span when
 * its final attempt completes in it), via the shared `metricsOverWindow` pass.
 */
export function evaluationWindow(input: EvaluationWindowInput): EvaluationWindowOutcome {
	const declared = managedInstanceIds(input.inventory)
	const startMs = windowStart(input.audit, input.revision, declared, input.longestRequestTimeoutMs)
	if (startMs === null) {
		return { ok: false, reason: "not-applied" }
	}

	// Walk whole-hour offsets 168..672; the first that satisfies the ≥100/≥500
	// gate ends the window. If none does, the window ends at 672 h.
	for (let h = MIN_WINDOW_HOURS; h <= MAX_WINDOW_HOURS; h++) {
		const endMs = startMs + h * HOUR_MS
		if (spanSatisfiesGate(input, startMs, endMs)) {
			return { ok: true, window: { startMs, endMs }, endOffsetHours: h, cappedAt672h: false }
		}
	}
	const endMs = startMs + MAX_WINDOW_HOURS * HOUR_MS
	return { ok: true, window: { startMs, endMs }, endOffsetHours: MAX_WINDOW_HOURS, cappedAt672h: true }
}

/** The Managed_Instance ids a revision declares (role `primary` or `secondary`). */
function managedInstanceIds(inventory: FleetInventory): readonly string[] {
	return inventory.instances.filter((i) => i.role === "primary" || i.role === "secondary").map((i) => i.id)
}

/**
 * The window start: the latest, across every declared Managed_Instance, of the
 * end time of that instance's FIRST apply of the candidate revision that ended
 * `succeeded`/`no-changes`, plus the longest request timeout; or `null` when any
 * declared Managed_Instance has no such apply (Requirement 19.1).
 */
function windowStart(
	audit: readonly ReconcilerAuditEntry[],
	revision: Revision,
	declared: readonly string[],
	longestRequestTimeoutMs: number,
): number | null {
	let latest = Number.NEGATIVE_INFINITY
	for (const instanceId of declared) {
		const firstApply = audit
			.filter(
				(e) =>
					e.kind === "apply" &&
					e.instanceId === instanceId &&
					e.revision.commit === revision.commit &&
					(e.outcome === "succeeded" || e.outcome === "no-changes"),
			)
			.map((e) => Date.parse(e.endedAt))
			.filter((ms) => !Number.isNaN(ms))
			.sort((a, b) => a - b)[0]
		if (firstApply === undefined) {
			return null
		}
		latest = Math.max(latest, firstApply)
	}
	if (!Number.isFinite(latest)) {
		return null
	}
	return latest + longestRequestTimeoutMs
}

/**
 * Whether the span [startMs, endMs) satisfies the window-end gate: every
 * Public_Route (any Managed_Instance) with ≥100 requests in the span has ≥500
 * (Requirement 19.1).
 */
function spanSatisfiesGate(input: EvaluationWindowInput, startMs: number, endMs: number): boolean {
	const report = metricsOverWindow(startMs, endMs, {
		rows: input.rows,
		attribute: input.attribute,
		inventory: input.inventory,
		nowMs: endMs,
	})
	for (const route of report.publicRoutes) {
		if (route.requests >= GATED_ROUTE_MIN_REQUESTS && route.requests < WINDOW_END_SUFFICIENT_REQUESTS) {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Candidate evaluation (Requirements 19.2-19.8, 20.1-20.7, 20.9, 20.10)
// ---------------------------------------------------------------------------

/** One Baseline_Metric comparison line in a report (Requirement 19.3). */
export interface MetricComparison {
	/** The Baseline_Metric id. */
	readonly metric: string
	/** The candidate value in the metric's unit, or null (no data / not measured). */
	readonly candidate: number | null
	/** The candidate sample count, when one applies. */
	readonly candidateSamples: number | null
	/** A partial / unreliable / no-data mark on the candidate value. */
	readonly candidateMark: MetricMark | null
	/** The baseline value used, with its mark. */
	readonly baseline: number | null
	readonly baselineMark: MetricMark | null
	/** Unrounded candidate − baseline, in the metric's unit (null when not computed). */
	readonly absoluteChange: number | null
	/** absoluteChange / baseline as a fraction, "undefined" when baseline is 0, null when not computed. */
	readonly relativeChange: number | "undefined" | null
	/** The unit of the metric. */
	readonly unit: MetricUnit
}

/** A Public_Route's request count and gating state in a report (Requirement 19.3). */
export interface RouteRequestCount {
	readonly instanceId: string
	readonly publicRoute: string
	readonly requests: number
	/** True at ≥100 requests (Requirement 19 Gated_Route). */
	readonly gated: boolean
	/** True for a Gated_Route with <500 requests (Requirement 19.3 "under-sampled"). */
	readonly underSampled: boolean
}

/** One Preservation_Floor outcome (Requirement 20.1-20.5). */
export interface FloorOutcome {
	/** The floor id, e.g. `code.final-success`, `code-research.local-share`. */
	readonly floor: string
	readonly outcome: "passed" | "failed" | "not-checked"
	/** The candidate value compared, or null. */
	readonly candidate: number | null
	/** The sample / request count. */
	readonly samples: number | null
	/** The floor or ceiling value (Requirement 20). */
	readonly floorValue: number
	/** Extra context some floors report (e.g. the cloud request count). */
	readonly detail?: Readonly<Record<string, number>>
}

/** One improvement-objective line (Requirement 20.6). */
export interface ObjectiveReport {
	readonly objective: ImprovementObjectiveId
	readonly candidate: number | null
	readonly baseline: number | null
	readonly absoluteChange: number | null
	readonly relativeChange: number | "undefined" | null
	/** True when the change is an improvement (decrease, or increase for `embeddings-success`). */
	readonly improvement: boolean | null
	readonly unit: MetricUnit
}

/** The result of evaluating one candidate Arrangement (Requirements 19, 20). */
export interface EvaluationReport {
	readonly revision: Revision
	readonly window: Window
	/** The baseline the candidate was compared against (Requirement 19.3). */
	readonly baselineId: string
	readonly baselineWindowLabel: string
	readonly requestCounts: readonly RouteRequestCount[]
	readonly comparisons: readonly MetricComparison[]
	/**
	 * `complete` → floors + objectives apply; `incomplete` → neither accept nor
	 * reject (Requirement 19.8, 20.9).
	 */
	readonly completeness: "complete" | "incomplete"
	/** The incomplete cause, when `completeness` is `incomplete`. */
	readonly incompleteCause?: "intervening-apply" | "intervening-rollback" | "partial-data"
	/** The measured span of an incomplete evaluation (empty when the write preceded the window start). */
	readonly measuredSpan?: Window | null
	/** The Preservation_Floor outcomes (empty on an incomplete evaluation). */
	readonly floors: readonly FloorOutcome[]
	/** Whether any floor failed → the candidate is rejected (Requirement 20.1-20.5). */
	readonly rejected: boolean
	/** The improvement objectives (reported only when not rejected and complete, Requirement 20.6). */
	readonly objectives: readonly ObjectiveReport[]
	/** The rollback recommendation when a floor failed (Requirement 21.4). */
	readonly rollbackRecommendation: RollbackRecommendation | null
	readonly human: string
}

/** The inputs `evaluate` needs. */
export interface EvaluateInput {
	readonly inventory: FleetInventory
	readonly revision: Revision
	readonly window: Window
	readonly audit: readonly ReconcilerAuditEntry[]
	readonly rows: readonly StoredRow[]
	readonly attribute: AttributeRow
	/** The baseline to compare against (defaults to the initial baseline). */
	readonly baseline?: Baseline
	/**
	 * The client API-key name whose requests form the initial-baseline route
	 * population (Requirement 19.7). Defaults to `zoo-m5`. Only applied when the
	 * baseline is the initial baseline.
	 */
	readonly initialBaselineKey?: string
}

const DEFAULT_INITIAL_BASELINE_KEY = "zoo-m5"

/**
 * Evaluate a candidate Arrangement over its measured window (Requirements 19,
 * 20). Returns a full `EvaluationReport`: the per-metric comparisons, the
 * Preservation_Floor outcomes on Gated_Routes only, the improvement objectives,
 * the incomplete mark on an intervening apply/rollback or partial data, and the
 * rollback recommendation when a floor fails.
 */
export function evaluate(input: EvaluateInput): EvaluationReport {
	const baseline = input.baseline ?? INITIAL_BASELINE
	const isInitial = baseline.id === INITIAL_BASELINE.id

	// Requirement 19.7: for the INITIAL baseline, the Public_Route metrics are
	// computed over the `zoo-m5` client key only. We filter the rows for the
	// metrics pass accordingly; a re-measured baseline uses every request.
	const key = input.initialBaselineKey ?? DEFAULT_INITIAL_BASELINE_KEY
	const metricRows = isInitial ? input.rows.filter((r) => r.fields.key === key) : input.rows

	const report = metricsOverWindow(input.window.startMs, input.window.endMs, {
		rows: metricRows,
		attribute: input.attribute,
		inventory: input.inventory,
		nowMs: input.window.endMs,
	})

	const requestCounts = buildRequestCounts(report)
	const comparisons = buildComparisons(report, baseline, input.inventory)

	// Requirement 19.8 / 20.9: incomplete on an intervening apply/rollback inside
	// the window, or on partial data.
	const incomplete = detectIncomplete(input.audit, input.revision, input.window, report)
	if (incomplete !== null) {
		const span = incomplete.measuredSpan
		const spanReport =
			span === null
				? report
				: metricsOverWindow(span.startMs, span.endMs, {
						rows: metricRows,
						attribute: input.attribute,
						inventory: input.inventory,
						nowMs: span.endMs,
				  })
		const spanComparisons = buildComparisons(spanReport, baseline, input.inventory)
		return {
			revision: input.revision,
			window: input.window,
			baselineId: baseline.id,
			baselineWindowLabel: baseline.windowLabel,
			requestCounts: buildRequestCounts(spanReport),
			comparisons: spanComparisons,
			completeness: "incomplete",
			incompleteCause: incomplete.cause,
			measuredSpan: span,
			floors: [],
			rejected: false,
			objectives: [],
			rollbackRecommendation: null,
			human: renderIncompleteHuman(input.revision, baseline, incomplete, span),
		}
	}

	// Requirement 20.1-20.5: Preservation_Floors on Gated_Routes only.
	const gated = new Set(requestCounts.filter((r) => r.gated).map((r) => routeKey(r.instanceId, r.publicRoute)))
	const primaryId = input.inventory.instances.find((i) => i.role === "primary")?.id ?? null
	const floors = computeFloors(report, input.inventory, gated, primaryId)
	const rejected = floors.some((f) => f.outcome === "failed")

	// Requirement 20.6: the nine improvement objectives (only when not rejected).
	const objectives = rejected ? [] : computeObjectives(report, baseline, input.inventory, primaryId)

	// Requirement 21.4: on rejection, a rollback RECOMMENDATION (names the backup,
	// does not perform the rollback).
	const rollbackRecommendation = rejected
		? buildRollbackRecommendation(floors, input.audit, input.revision, input.inventory)
		: null

	return {
		revision: input.revision,
		window: input.window,
		baselineId: baseline.id,
		baselineWindowLabel: baseline.windowLabel,
		requestCounts,
		comparisons,
		completeness: "complete",
		floors,
		rejected,
		objectives,
		rollbackRecommendation,
		human: renderEvaluationHuman(input.revision, baseline, input.window, requestCounts, floors, objectives, rejected),
	}
}

// ---------------------------------------------------------------------------
// Request counts + gating (Requirement 19.3, 19.6)
// ---------------------------------------------------------------------------

function buildRequestCounts(report: FleetMetricsReport): RouteRequestCount[] {
	return report.publicRoutes
		.map((r) => ({
			instanceId: r.instanceId,
			publicRoute: r.publicRoute,
			requests: r.requests,
			gated: r.requests >= GATED_ROUTE_MIN_REQUESTS,
			underSampled: r.requests >= GATED_ROUTE_MIN_REQUESTS && r.requests < WINDOW_END_SUFFICIENT_REQUESTS,
		}))
		.sort((a, b) =>
			a.instanceId === b.instanceId
				? a.publicRoute.localeCompare(b.publicRoute)
				: a.instanceId.localeCompare(b.instanceId),
		)
}

function routeKey(instanceId: string, publicRoute: string): string {
	return `${instanceId}\u0000${publicRoute}`
}

/** The primary's metrics for a Public_Route, or undefined (Requirement 19.7). */
function primaryRoute(
	report: FleetMetricsReport,
	primaryId: string | null,
	route: string,
): PublicRouteMetrics | undefined {
	return report.publicRoutes.find((r) => r.instanceId === primaryId && r.publicRoute === route)
}

// ---------------------------------------------------------------------------
// Candidate metric extraction (Requirement 19.7)
// ---------------------------------------------------------------------------

/**
 * The candidate value of each Baseline_Metric, computed from the Requirement 16
 * metrics of the same kind and scope under the Requirement 19.7 conventions
 * (primary OmniRoute_Instance for Public_Route metrics, pooled local share of
 * code+research, weekly scaling for per-week counts, etc.). Returns a map from
 * metric id to its candidate value + sample count + mark.
 */
function candidateMetrics(
	report: FleetMetricsReport,
	inventory: FleetInventory,
): Map<string, { value: number | null; samples: number | null; mark: MetricMark | null }> {
	const primaryId = inventory.instances.find((i) => i.role === "primary")?.id ?? null
	const windowHours = (report.windowEndMs - report.windowStartMs) / HOUR_MS
	const perWeekScale = windowHours > 0 ? 168 / windowHours : 0
	const out = new Map<string, { value: number | null; samples: number | null; mark: MetricMark | null }>()

	const set = (id: string, value: number | null, samples: number | null, mark: MetricMark | null = null): void => {
		out.set(id, { value, samples, mark })
	}
	const pctl = (p: Percentile, scale = 1): { value: number | null; samples: number } => ({
		value: p.value === null ? null : p.value * scale,
		samples: p.samples,
	})

	// Per-Public_Route metrics on the primary (Requirement 19.7).
	const routes: Array<[string, string]> = [
		["code", "hybrid/code"],
		["research", "hybrid/research"],
		["planner", "hybrid/planner"],
		["reader", "hybrid/reader"],
		["fast", "hybrid/fast"],
	]
	for (const [prefix, route] of routes) {
		const m = primaryRoute(report, primaryId, route)
		set(`${prefix}.final-success`, m?.finalSuccessRate ?? null, m?.requests ?? 0, m ? null : "no-data")
		// PublicRouteMetrics latency percentiles are already in SECONDS (metrics.ts).
		const p50 = m ? pctl(m.latencyP50) : { value: null, samples: 0 }
		set(`${prefix}.p50`, p50.value, p50.samples)
		const p95 = m ? pctl(m.latencyP95) : { value: null, samples: 0 }
		set(`${prefix}.p95`, p95.value, p95.samples)
		set(`${prefix}.cloud-share`, m?.cloudShare ?? null, m?.requests ?? 0)
		set(`${prefix}.multi-attempt`, m?.multiAttemptRate ?? null, m?.requests ?? 0)
	}

	// Pooled code+research local share (Requirement 19.7): 100% − pooled cloud share.
	const localShare = pooledLocalShare(report, primaryId)
	set("code-research.local-share", localShare.share, localShare.requests)

	// Cloud input tokens from local-first lanes (Requirement 19.7): the summed
	// cloud input tokens of code, planner, research, reader — scaled per week.
	let cloudInput = 0
	for (const route of ["hybrid/code", "hybrid/planner", "hybrid/research", "hybrid/reader"]) {
		cloudInput += primaryRoute(report, primaryId, route)?.cloudInputTokens ?? 0
	}
	set("cloud-input-tokens", cloudInput * perWeekScale, null)

	// Weekly Capacity_Class_Rejections across all Devices (Requirement 20.6).
	let rejections = 0
	for (const d of report.devices) {
		rejections += d.capacityClassRejections.total
	}
	set("capacity-rejections", rejections * perWeekScale, null)

	// Weekly model switches on Residency_Groups (Requirement 20.6).
	let switches = 0
	for (const d of report.devices) {
		for (const rg of d.residencySwitches) {
			switches += rg.switchCount
		}
	}
	set("model-switches", switches * perWeekScale, null)

	// Embeddings + rerank pooled over the Model_Offerings of their lanes
	// (Requirement 19.7). We pool via the per-offering metrics of offerings whose
	// lane carries the embed/rerank tag.
	const embed = pooledLaneSuccess(report, inventory, EMBED_TAG)
	set("embeddings-success", embed.successRate, embed.attempts)
	const rerank = pooledLaneSuccess(report, inventory, RERANK_TAG)
	set("rerank-success", rerank.successRate, rerank.attempts)
	set("rerank-p50", rerank.p50Ms, rerank.successCount)

	return out
}

/** The pooled local share of successful code+research requests (Requirement 19.7, 20.3). */
function pooledLocalShare(
	report: FleetMetricsReport,
	primaryId: string | null,
): { share: number | null; requests: number; cloudRequests: number } {
	let pooled = 0
	let cloud = 0
	let any = false
	for (const route of LOCAL_SHARE_ROUTES) {
		const m = primaryRoute(report, primaryId, route)
		if (!m) {
			continue
		}
		any = true
		pooled += m.requests
		// cloudShare is over finally successful requests; the cloud request count
		// is cloudShare × requests (null share → 0 cloud for this route).
		cloud += m.cloudShare === null ? 0 : Math.round(m.cloudShare * m.requests)
	}
	if (!any || pooled === 0) {
		return { share: null, requests: pooled, cloudRequests: cloud }
	}
	return { share: 1 - cloud / pooled, requests: pooled, cloudRequests: cloud }
}

/**
 * Pool success rate / p50 over the Model_Offerings whose lane carries `tag`
 * (Requirement 19.7). Reads the per-offering performance of offerings that serve
 * the embeddings or rerank lane.
 */
function pooledLaneSuccess(
	report: FleetMetricsReport,
	inventory: FleetInventory,
	tag: string,
): { successRate: number | null; attempts: number; successCount: number; p50Ms: number | null } {
	const laneOfferingIds = new Set<string>()
	for (const lane of inventory.lanes) {
		if (!lane.capabilities.includes(tag)) {
			continue
		}
		for (const off of inventory.offerings) {
			if (lane.capabilities.every((c) => off.tags.includes(c))) {
				laneOfferingIds.add(off.id)
			}
		}
	}
	let attempts = 0
	let successRateWeighted = 0
	for (const m of report.modelOfferings) {
		if (typeof m.modelOfferingId !== "string" || !laneOfferingIds.has(m.modelOfferingId)) {
			continue
		}
		const p = m.performance
		attempts += p.attempts
		if (p.successRate !== null) {
			successRateWeighted += p.successRate * p.attempts
		}
	}
	if (attempts === 0) {
		return { successRate: null, attempts: 0, successCount: 0, p50Ms: null }
	}
	const successRate = successRateWeighted / attempts
	// p50 of the pooled successful attempts: approximate via the first matching
	// offering's successful-latency p50 (findings pools a single rerank offering).
	let p50Ms: number | null = null
	let successCount = 0
	for (const m of report.modelOfferings) {
		if (typeof m.modelOfferingId !== "string" || !laneOfferingIds.has(m.modelOfferingId)) {
			continue
		}
		if (m.performance.latencyP50.value !== null) {
			// performanceOf latency percentiles are in SECONDS; rerank p50 is reported in ms.
			p50Ms = m.performance.latencyP50.value * 1000
			successCount = m.performance.latencyP50.samples
			break
		}
	}
	return { successRate, attempts, successCount, p50Ms }
}

// ---------------------------------------------------------------------------
// Baseline comparisons (Requirement 19.3)
// ---------------------------------------------------------------------------

function buildComparisons(
	report: FleetMetricsReport,
	baseline: Baseline,
	inventory: FleetInventory,
): MetricComparison[] {
	const candidate = candidateMetrics(report, inventory)
	const out: MetricComparison[] = []
	for (const [metric, b] of Object.entries(baseline.values)) {
		const c = candidate.get(metric)
		const candidateValue = c?.value ?? null
		const candidateMark = c?.mark ?? (c === undefined ? "not-measured" : null)
		const { absoluteChange, relativeChange } = change(candidateValue, b.value, b.mark, candidateMark)
		out.push({
			metric,
			candidate: candidateValue,
			candidateSamples: c?.samples ?? null,
			candidateMark,
			baseline: b.value,
			baselineMark: b.mark ?? null,
			absoluteChange,
			relativeChange,
			unit: b.unit,
		})
	}
	return out.sort((a, b) => a.metric.localeCompare(b.metric))
}

/**
 * The absolute and relative change (Requirement 19.3): absolute = candidate −
 * baseline in the metric's unit; relative = absolute / baseline, "undefined"
 * when the baseline is 0; both null when either value has no data / is not
 * measured.
 */
function change(
	candidate: number | null,
	baseline: number | null,
	baselineMark: MetricMark | undefined,
	candidateMark: MetricMark | null,
): { absoluteChange: number | null; relativeChange: number | "undefined" | null } {
	const notMeasured = baselineMark === "no-data" || baselineMark === "not-measured" || candidateMark === "no-data" || candidateMark === "not-measured"
	if (candidate === null || baseline === null || notMeasured) {
		return { absoluteChange: null, relativeChange: null }
	}
	const absoluteChange = candidate - baseline
	const relativeChange: number | "undefined" = baseline === 0 ? "undefined" : absoluteChange / baseline
	return { absoluteChange, relativeChange }
}

// ---------------------------------------------------------------------------
// Incomplete detection (Requirement 19.8, 20.9)
// ---------------------------------------------------------------------------

interface IncompleteResult {
	readonly cause: "intervening-apply" | "intervening-rollback" | "partial-data"
	/** The measured span: window start to the first intervening write, or null (write before window start). */
	readonly measuredSpan: Window | null
}

/**
 * Detect whether the evaluation is incomplete (Requirement 19.8): an apply of a
 * revision OTHER than the candidate's, or any rollback, that wrote to a
 * Managed_Instance before the window ends; or partial candidate data (the window
 * extends before the earliest readable record, Requirement 16.10). Returns the
 * cause and the measured span, or `null` when the evaluation is complete.
 */
function detectIncomplete(
	audit: readonly ReconcilerAuditEntry[],
	revision: Revision,
	window: Window,
	report: FleetMetricsReport,
): IncompleteResult | null {
	// An intervening apply/rollback: a write that STARTED before the window end.
	// (The relevant write is the one that changes state; we take the earliest
	// such write that starts strictly before the window end.)
	let earliest: { startMs: number; kind: "apply" | "rollback" } | null = null
	for (const e of audit) {
		const startMs = Date.parse(e.startedAt)
		if (Number.isNaN(startMs) || startMs >= window.endMs) {
			continue
		}
		if (e.kind === "apply" && e.revision.commit === revision.commit) {
			continue // the candidate's own apply is expected.
		}
		if (earliest === null || startMs < earliest.startMs) {
			earliest = { startMs, kind: e.kind }
		}
	}

	if (earliest !== null) {
		// The measured span runs from the window start to the first such write, or
		// is empty (null) when that write started before the window start.
		const measuredSpan: Window | null =
			earliest.startMs <= window.startMs ? null : { startMs: window.startMs, endMs: earliest.startMs }
		return {
			cause: earliest.kind === "apply" ? "intervening-apply" : "intervening-rollback",
			measuredSpan,
		}
	}

	// Partial candidate data (Requirement 16.10 / 19.8): the window extends before
	// the earliest readable record. The measured span is the full window.
	if (report.partial) {
		return { cause: "partial-data", measuredSpan: { startMs: window.startMs, endMs: window.endMs } }
	}

	return null
}

// ---------------------------------------------------------------------------
// Preservation_Floors (Requirement 20.1-20.5, applied to Gated_Routes only)
// ---------------------------------------------------------------------------

/**
 * Compute the Preservation_Floor outcomes (Requirement 20.1-20.5). Floors apply
 * to Gated_Routes ONLY (Requirement 19.6, 20.10): a non-Gated_Route is reported
 * `not-checked` and never causes a rejection. The floor VALUES are the baseline-
 * derived constants regardless of which baseline a report compares against
 * (Requirement 20.10).
 */
function computeFloors(
	report: FleetMetricsReport,
	inventory: FleetInventory,
	gated: ReadonlySet<string>,
	primaryId: string | null,
): FloorOutcome[] {
	const out: FloorOutcome[] = []
	const isGated = (route: string): boolean => (primaryId === null ? false : gated.has(routeKey(primaryId, route)))

	// 20.1: per-route final success ≥ floor.
	for (const [route, floor] of Object.entries(FINAL_SUCCESS_FLOORS)) {
		const m = primaryRoute(report, primaryId, route)
		if (!isGated(route) || !m) {
			out.push({ floor: `${route}.final-success`, outcome: "not-checked", candidate: m?.finalSuccessRate ?? null, samples: m?.requests ?? 0, floorValue: floor })
			continue
		}
		const value = m.finalSuccessRate
		const outcome: FloorOutcome["outcome"] = value === null ? "not-checked" : value < floor ? "failed" : "passed"
		out.push({ floor: `${route}.final-success`, outcome, candidate: value, samples: m.requests, floorValue: floor })
	}

	// 20.2: code/research p95 ≤ ceiling (seconds). PublicRouteMetrics percentiles
	// are already in SECONDS.
	for (const [route, ceilingSeconds] of Object.entries(P95_CEILINGS_SECONDS)) {
		const m = primaryRoute(report, primaryId, route)
		const p95Seconds = m && m.latencyP95.value !== null ? m.latencyP95.value : null
		if (!isGated(route) || p95Seconds === null) {
			out.push({ floor: `${route}.p95`, outcome: "not-checked", candidate: p95Seconds, samples: m?.latencyP95.samples ?? 0, floorValue: ceilingSeconds })
			continue
		}
		const outcome: FloorOutcome["outcome"] = p95Seconds > ceilingSeconds ? "failed" : "passed"
		out.push({ floor: `${route}.p95`, outcome, candidate: p95Seconds, samples: m!.latencyP95.samples, floorValue: ceilingSeconds })
	}

	// 20.3: pooled code+research local share ≥ 98.1% over the Gated_Routes of the pair.
	const pooled = pooledGatedLocalShare(report, primaryId, gated)
	if (pooled.requests === 0) {
		out.push({ floor: "code-research.local-share", outcome: "not-checked", candidate: null, samples: 0, floorValue: LOCAL_SHARE_FLOOR })
	} else {
		const outcome: FloorOutcome["outcome"] =
			pooled.share === null ? "not-checked" : pooled.share < LOCAL_SHARE_FLOOR ? "failed" : "passed"
		out.push({
			floor: "code-research.local-share",
			outcome,
			candidate: pooled.share,
			samples: pooled.requests,
			floorValue: LOCAL_SHARE_FLOOR,
			detail: { cloudRequests: pooled.cloudRequests },
		})
	}

	// 20.4: rerank — success ≥ 99.9% and p50 ≤ 851 ms, when rerank is a Gated_Route.
	const rerankRoute = laneRouteForTag(inventory, RERANK_TAG)
	const rerankGated = rerankRoute !== null && isGated(rerankRoute)
	const rerank = pooledLaneSuccess(report, inventory, RERANK_TAG)
	if (!rerankGated || rerank.attempts === 0) {
		out.push({ floor: "rerank.success", outcome: "not-checked", candidate: rerank.successRate, samples: rerank.attempts, floorValue: RERANK_SUCCESS_FLOOR })
		out.push({ floor: "rerank.p50", outcome: "not-checked", candidate: rerank.p50Ms, samples: rerank.successCount, floorValue: RERANK_P50_CEILING_MS })
	} else {
		const successOutcome: FloorOutcome["outcome"] =
			rerank.successRate === null ? "not-checked" : rerank.successRate < RERANK_SUCCESS_FLOOR ? "failed" : "passed"
		out.push({ floor: "rerank.success", outcome: successOutcome, candidate: rerank.successRate, samples: rerank.attempts, floorValue: RERANK_SUCCESS_FLOOR })
		const p50Outcome: FloorOutcome["outcome"] =
			rerank.p50Ms === null ? "not-checked" : rerank.p50Ms > RERANK_P50_CEILING_MS ? "failed" : "passed"
		out.push({ floor: "rerank.p50", outcome: p50Outcome, candidate: rerank.p50Ms, samples: rerank.successCount, floorValue: RERANK_P50_CEILING_MS })
	}

	// 20.5: zero Dead_Target attempts in the measured window (not scaled to a week).
	const dead = deadTargetAttempts(report)
	out.push({
		floor: "dead-target-attempts",
		outcome: dead > 0 ? "failed" : "passed",
		candidate: dead,
		samples: dead,
		floorValue: 0,
	})

	return out
}

/** The pooled local share over the code/research routes that are Gated_Routes (Requirement 20.3). */
function pooledGatedLocalShare(
	report: FleetMetricsReport,
	primaryId: string | null,
	gated: ReadonlySet<string>,
): { share: number | null; requests: number; cloudRequests: number } {
	let pooled = 0
	let cloud = 0
	let any = false
	for (const route of LOCAL_SHARE_ROUTES) {
		if (primaryId === null || !gated.has(routeKey(primaryId, route))) {
			continue
		}
		const m = primaryRoute(report, primaryId, route)
		if (!m) {
			continue
		}
		any = true
		pooled += m.requests
		cloud += m.cloudShare === null ? 0 : Math.round(m.cloudShare * m.requests)
	}
	if (!any || pooled === 0) {
		return { share: null, requests: pooled, cloudRequests: cloud }
	}
	return { share: 1 - cloud / pooled, requests: pooled, cloudRequests: cloud }
}

/** The Public_Route name of the lane carrying `tag` (embed/rerank), or null. */
function laneRouteForTag(inventory: FleetInventory, tag: string): string | null {
	const lane = inventory.lanes.find((l) => l.capabilities.includes(tag))
	return lane?.names[0] ?? null
}

/**
 * The Dead_Target attempt count in the measured window (Requirement 19.7 / 20.5).
 * A Dead_Target run is ≥10 consecutive failed attempts on one compiled target,
 * or a 24 h span in which a target had ≥1 attempt and every attempt failed,
 * ignoring Capacity_Class_Rejections (429/503/409) and client disconnects (499).
 * The observer's per-Device failure breakdowns do not retain per-target attempt
 * ordering, so the evaluator reads the count the caller surfaces through the
 * report's failure breakdowns conservatively: here we treat the metrics report's
 * precomputed dead-target signal. Since `FleetMetricsReport` does not currently
 * carry a Dead_Target field, we derive 0 when no device reports an all-failed
 * target; a non-zero count is supplied by the caller via the report convention
 * below.
 */
function deadTargetAttempts(report: FleetMetricsReport): number {
	// A target that answered at least one non-capacity, non-disconnect attempt and
	// failed every one of them, with ≥10 such attempts, is a Dead_Target run.
	// `FleetMetricsReport` exposes per-Device/-Offering failure breakdowns but not
	// per-target runs; the window-level Dead_Target count is computed by the
	// Fleet_Observer's anomaly detector and attached to a device's capacity block.
	// For this evaluator we count a Model_Offering whose attempts were ALL failures
	// (excluding capacity-class rejections) and number ≥10 as a Dead_Target run,
	// summing those failed attempts. This matches the ≥10-consecutive-failure run
	// definition for an offering that never succeeded in the window.
	let dead = 0
	for (const m of report.modelOfferings) {
		const p = m.performance
		if (p.attempts === 0 || p.successRate === null) {
			continue
		}
		// Count non-capacity failures.
		let nonCapacityFailures = 0
		for (const f of p.failures) {
			if (f.status === 429 || f.status === 503 || f.status === 409 || f.status === 499) {
				continue
			}
			nonCapacityFailures += f.count
		}
		// All attempts failed (success rate 0) and ≥10 non-capacity failures → run.
		if (p.successRate === 0 && nonCapacityFailures >= 10) {
			dead += nonCapacityFailures
		}
	}
	return dead
}

// ---------------------------------------------------------------------------
// Improvement objectives (Requirement 20.6) + ranking (Requirement 20.7)
// ---------------------------------------------------------------------------

/** The Baseline_Metric id each improvement objective reads. */
const OBJECTIVE_METRIC: Readonly<Record<ImprovementObjectiveId, string>> = {
	"planner-cloud-share": "planner.cloud-share",
	"planner-multi-attempt": "planner.multi-attempt",
	"code-p50": "code.p50",
	"reader-cloud-share": "reader.cloud-share",
	"reader-multi-attempt": "reader.multi-attempt",
	"cloud-input-tokens": "cloud-input-tokens",
	"capacity-rejections": "capacity-rejections",
	"embeddings-success": "embeddings-success",
	"model-switches": "model-switches",
}

/** The objectives for which an improvement is an INCREASE (all others: a decrease). */
const INCREASE_IS_IMPROVEMENT = new Set<ImprovementObjectiveId>(["embeddings-success"])

/** The nine objectives in the fixed Requirement 20.6 listing order (the reporting order). */
const ALL_OBJECTIVES: readonly ImprovementObjectiveId[] = [
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

function computeObjectives(
	report: FleetMetricsReport,
	baseline: Baseline,
	inventory: FleetInventory,
	_primaryId: string | null,
): ObjectiveReport[] {
	const candidate = candidateMetrics(report, inventory)
	return ALL_OBJECTIVES.map((objective) => {
		const metricId = OBJECTIVE_METRIC[objective]
		const c = candidate.get(metricId)
		const b = baseline.values[metricId]
		const candidateValue = c?.value ?? null
		const baselineValue = b?.value ?? null
		const { absoluteChange, relativeChange } = change(candidateValue, baselineValue, b?.mark, c?.mark ?? null)
		let improvement: boolean | null = null
		if (absoluteChange !== null) {
			improvement = INCREASE_IS_IMPROVEMENT.has(objective) ? absoluteChange > 0 : absoluteChange < 0
		}
		return {
			objective,
			candidate: candidateValue,
			baseline: baselineValue,
			absoluteChange,
			relativeChange,
			improvement,
			unit: b?.unit ?? "fraction",
		}
	})
}

/** One ranked candidate (Requirement 20.7). */
export interface RankedCandidate {
	readonly report: EvaluationReport
	readonly rank: number
}

/**
 * Rank evaluated, non-rejected candidates (Requirement 20.7). Candidates are
 * compared objective by objective in the inventory's declared order. For each
 * objective the candidate with the larger improvement (in the metric's own unit,
 * rounded to one decimal for percentages/seconds and to a whole number for token
 * counts and counts) ranks higher; a candidate whose change is not computed
 * ranks below every candidate whose change is computed; equal rounded
 * improvements move to the next objective; candidates equal on every objective
 * keep their input (evaluation) order.
 *
 * Only `complete`, non-rejected reports are ranked; others are returned after
 * the ranked ones in input order with no rank comparison applied.
 */
export function rankCandidates(
	candidates: readonly EvaluationReport[],
	objectiveOrder: readonly ImprovementObjectiveId[],
): RankedCandidate[] {
	const rankable = candidates.filter((c) => c.completeness === "complete" && !c.rejected)
	// Stable sort by the objective-by-objective comparison; ties keep input order.
	const indexed = rankable.map((report, index) => ({ report, index }))
	indexed.sort((a, b) => {
		for (const objective of objectiveOrder) {
			const cmp = compareObjective(a.report, b.report, objective)
			if (cmp !== 0) {
				return cmp
			}
		}
		return a.index - b.index // equal on every objective → input order
	})
	return indexed.map((entry, i) => ({ report: entry.report, rank: i + 1 }))
}

/**
 * Compare two candidates on one objective (Requirement 20.7). Returns a negative
 * number when `a` ranks higher (larger improvement), positive when `b` does.
 */
function compareObjective(a: EvaluationReport, b: EvaluationReport, objective: ImprovementObjectiveId): number {
	const ia = improvementAmount(a, objective)
	const ib = improvementAmount(b, objective)
	// A not-computed change ranks below every computed change.
	if (ia === null && ib === null) {
		return 0
	}
	if (ia === null) {
		return 1 // a ranks lower
	}
	if (ib === null) {
		return -1 // b ranks lower
	}
	// Larger rounded improvement ranks higher (sorts first → negative).
	if (ia > ib) {
		return -1
	}
	if (ia < ib) {
		return 1
	}
	return 0
}

/**
 * The rounded improvement amount of a candidate on an objective, in the metric's
 * own unit, as a POSITIVE "better" quantity (so a larger value is a bigger
 * improvement). Returns null when the change is not computed (Requirement 20.7).
 */
function improvementAmount(report: EvaluationReport, objective: ImprovementObjectiveId): number | null {
	const o = report.objectives.find((x) => x.objective === objective)
	if (!o || o.absoluteChange === null) {
		return null
	}
	// An improvement is a decrease for every objective except embeddings-success.
	// Express improvement as positive: for a decrease-is-good objective that is
	// −absoluteChange; for the increase-is-good one it is +absoluteChange.
	const signed = INCREASE_IS_IMPROVEMENT.has(objective) ? o.absoluteChange : -o.absoluteChange
	return roundForUnit(signed, o.unit)
}

/** Round to one decimal for percentages/fractions/seconds/ms, to a whole number for tokens/counts. */
function roundForUnit(value: number, unit: MetricUnit): number {
	if (unit === "tokens" || unit === "count") {
		return Math.round(value)
	}
	// Percentages, fractions, seconds, ms: one decimal place. Fractions are
	// expressed as percentages for rounding so 0.1 pp granularity holds.
	if (unit === "fraction" || unit === "percent") {
		return Math.round(value * 100 * 10) / 10
	}
	return Math.round(value * 10) / 10
}

// ---------------------------------------------------------------------------
// Re-measured baseline (Requirement 19.5)
// ---------------------------------------------------------------------------

/** The inputs `remeasureBaseline` needs. */
export interface RemeasureInput {
	readonly inventory: FleetInventory
	/** The stated re-measure window (must be ≥168 h and end before the request). */
	readonly window: Window
	readonly rows: readonly StoredRow[]
	readonly attribute: AttributeRow
	/** Every baseline recorded so far, including the initial baseline (Requirement 19.5). */
	readonly existing: readonly Baseline[]
}

/** The result of a re-measure: the new baseline plus every retained earlier baseline. */
export interface RemeasureOutcome {
	readonly ok: true
	readonly baseline: Baseline
	/** Every baseline, with the earlier ones unchanged and the new one appended (Requirement 19.5). */
	readonly baselines: readonly Baseline[]
}

export type RemeasureResult = RemeasureOutcome | { readonly ok: false; readonly reason: "window-too-short" }

/**
 * Record a re-measured baseline over a stated window of ≥168 h, RETAINING every
 * earlier baseline (including the initial baseline) with its window and values
 * unchanged (Requirement 19.5). The new baseline's values are computed over its
 * window under the Requirement 19.2 / 19.7 conventions. Over a re-measured
 * baseline the route population is every request (not `zoo-m5`-only, which is an
 * initial-baseline convention of Requirement 19.7).
 */
export function remeasureBaseline(input: RemeasureInput): RemeasureResult {
	const durationHours = (input.window.endMs - input.window.startMs) / HOUR_MS
	if (durationHours < MIN_WINDOW_HOURS) {
		return { ok: false, reason: "window-too-short" }
	}
	const report = metricsOverWindow(input.window.startMs, input.window.endMs, {
		rows: input.rows,
		attribute: input.attribute,
		inventory: input.inventory,
		nowMs: input.window.endMs,
	})
	const candidate = candidateMetrics(report, input.inventory)
	const windowLabel = `${new Date(input.window.startMs).toISOString()} → ${new Date(input.window.endMs).toISOString()}`

	// Build the new baseline from the same metric ids the initial baseline uses,
	// so a report compares like-for-like. Metrics that were "not measured" in the
	// initial baseline stay not measured (they are not observer-derived).
	const values: Record<string, BaselineValue> = {}
	for (const [metric, initial] of Object.entries(INITIAL_BASELINE.values)) {
		if (initial.mark === "not-measured") {
			values[metric] = { ...initial }
			continue
		}
		const c = candidate.get(metric)
		values[metric] = {
			value: c?.value ?? null,
			unit: initial.unit,
			samples: c?.samples ?? undefined,
			mark: c?.mark ?? (c?.value === null ? "no-data" : undefined),
		}
	}

	const baseline: Baseline = { id: windowLabel, windowLabel, values }
	// Retain every earlier baseline unchanged; append the new one.
	const baselines = [...input.existing]
	if (!baselines.some((b) => b.id === INITIAL_BASELINE.id)) {
		baselines.unshift(INITIAL_BASELINE)
	}
	baselines.push(baseline)
	return { ok: true, baseline, baselines }
}

// ---------------------------------------------------------------------------
// 24 h early check (Requirement 21.3) + rollback recommendation (Requirement 21.4)
// ---------------------------------------------------------------------------

/** The 24 h early-check report (Requirement 21.3). */
export interface EarlyCheckReport {
	readonly revision: Revision
	readonly baselineId: string
	readonly baselineWindowLabel: string
	/** The check span: the first 24 h of the Evaluation_Window. */
	readonly checkSpan: Window
	readonly requestCounts: readonly RouteRequestCount[]
	/** The Preservation_Floor outcomes of Requirement 20.1-20.4 over the check span. */
	readonly floors: readonly FloorOutcome[]
	/** The rollback recommendation when at least one floor failed (Requirement 21.4), else null. */
	readonly rollbackRecommendation: RollbackRecommendation | null
	readonly human: string
}

/** The inputs the early check needs. */
export interface EarlyCheckInput {
	readonly inventory: FleetInventory
	readonly revision: Revision
	/** The Evaluation_Window; the check span is its first 24 h. */
	readonly window: Window
	readonly audit: readonly ReconcilerAuditEntry[]
	readonly rows: readonly StoredRow[]
	readonly attribute: AttributeRow
	readonly baseline?: Baseline
	readonly initialBaselineKey?: string
}

/** The check span duration: 24 hours. */
const CHECK_SPAN_HOURS = 24

/**
 * The 24 h early check (Requirement 21.3): over the first 24 h of the
 * Evaluation_Window (the check span), report each Preservation_Floor of
 * Requirement 20.1-20.4 as passed / failed / not-checked, treating each
 * Public_Route with ≥100 requests on the primary in the check span as a
 * Gated_Route, WITHOUT accepting or rejecting the candidate or changing its
 * Evaluation_Window. The Dead_Target floor (20.5) is not part of the 20.1-20.4
 * early-check scope. When at least one floor fails, attach a rollback
 * RECOMMENDATION that names the Route_Backup (Requirement 21.4) — it never
 * performs a rollback.
 */
export function earlyCheck(input: EarlyCheckInput): EarlyCheckReport {
	const baseline = input.baseline ?? INITIAL_BASELINE
	const isInitial = baseline.id === INITIAL_BASELINE.id
	const key = input.initialBaselineKey ?? DEFAULT_INITIAL_BASELINE_KEY
	const metricRows = isInitial ? input.rows.filter((r) => r.fields.key === key) : input.rows

	const checkSpan: Window = { startMs: input.window.startMs, endMs: input.window.startMs + CHECK_SPAN_HOURS * HOUR_MS }
	const report = metricsOverWindow(checkSpan.startMs, checkSpan.endMs, {
		rows: metricRows,
		attribute: input.attribute,
		inventory: input.inventory,
		nowMs: checkSpan.endMs,
	})

	const requestCounts = buildRequestCounts(report)
	const primaryId = input.inventory.instances.find((i) => i.role === "primary")?.id ?? null
	const gated = new Set(
		requestCounts
			.filter((r) => r.instanceId === primaryId && r.requests >= GATED_ROUTE_MIN_REQUESTS)
			.map((r) => routeKey(r.instanceId, r.publicRoute)),
	)

	// Only the 20.1-20.4 floors (not 20.5 Dead_Target) are in the early-check scope.
	const allFloors = computeFloors(report, input.inventory, gated, primaryId)
	const floors = allFloors.filter((f) => f.floor !== "dead-target-attempts")

	const anyFailed = floors.some((f) => f.outcome === "failed")
	const rollbackRecommendation = anyFailed
		? buildRollbackRecommendation(floors, input.audit, input.revision, input.inventory)
		: null

	return {
		revision: input.revision,
		baselineId: baseline.id,
		baselineWindowLabel: baseline.windowLabel,
		checkSpan,
		requestCounts,
		floors,
		rollbackRecommendation,
		human: renderEarlyCheckHuman(input.revision, baseline, checkSpan, floors, rollbackRecommendation),
	}
}

// ---------------------------------------------------------------------------
// Rollback recommendation (Requirement 21.4)
// ---------------------------------------------------------------------------

/** A rollback recommendation — names the backup, never performs a rollback (Requirement 21.4). */
export interface RollbackRecommendation {
	/** Each failed Preservation_Floor with its candidate value, sample count, and floor value. */
	readonly failedFloors: ReadonlyArray<{
		readonly floor: string
		readonly candidate: number | null
		readonly samples: number | null
		readonly floorValue: number
	}>
	/** Per-Managed_Instance backup / no-change information. */
	readonly instances: readonly RollbackInstanceInfo[]
}

/** Per-Managed_Instance rollback info (Requirement 21.4). */
export interface RollbackInstanceInfo {
	readonly instanceId: string
	/**
	 * `"backup"`: the candidate apply captured a Route_Backup here;
	 * `"no-changes"`: the apply made no changes and captured no backup;
	 * `"unavailable"`: a backup was captured but is no longer retained.
	 */
	readonly kind: "backup" | "no-changes" | "unavailable"
	/** The Route_Backup capture time (ISO-8601), when `kind` is `backup`. */
	readonly backupCaptureTime?: string
	/** The Route_Backup location, when `kind` is `backup`. */
	readonly backupLocation?: string
	/** The Fleet_Inventory_Revision live when the candidate apply started, when known. */
	readonly previousRevision?: string
}

/** Backup metadata the Reconciler captured for the candidate apply, keyed by Managed_Instance. */
export interface BackupRecord {
	readonly instanceId: string
	readonly captureTime: string
	readonly location: string
	/** False when the Reconciler no longer retains the backup (Requirement 21.4). */
	readonly retained: boolean
	/** The revision live on the instance when the apply started. */
	readonly previousRevision?: string
}

/**
 * Build the rollback recommendation (Requirement 21.4). It lists each failed
 * floor and, for each Managed_Instance the candidate revision declares, either
 * the Route_Backup the candidate apply captured (its capture time + location +
 * the previously-live revision), `no-changes` when the apply made no changes and
 * captured no backup, or `unavailable` when the backup is no longer retained.
 *
 * Backup metadata is read from the audit entries' recorded backups when present;
 * the caller may pass an explicit `backups` map through the audit's apply
 * entries. Since `ReconcilerAuditEntry` does not carry backup location/retention
 * directly, the recommendation reports a Managed_Instance as `no-changes` for a
 * `no-changes` apply outcome and `backup` for a `succeeded` apply outcome, with
 * the previous revision resolved from the audit history.
 */
export function buildRollbackRecommendation(
	floors: readonly FloorOutcome[],
	audit: readonly ReconcilerAuditEntry[],
	revision: Revision,
	inventory: FleetInventory,
	backups?: readonly BackupRecord[],
): RollbackRecommendation {
	const failedFloors = floors
		.filter((f) => f.outcome === "failed")
		.map((f) => ({ floor: f.floor, candidate: f.candidate, samples: f.samples, floorValue: f.floorValue }))

	const backupByInstance = new Map<string, BackupRecord>()
	for (const b of backups ?? []) {
		backupByInstance.set(b.instanceId, b)
	}

	const instances: RollbackInstanceInfo[] = []
	for (const instanceId of managedInstanceIds(inventory)) {
		// The candidate apply on this instance (the first succeeded/no-changes one).
		const apply = audit
			.filter(
				(e) =>
					e.kind === "apply" &&
					e.instanceId === instanceId &&
					e.revision.commit === revision.commit &&
					(e.outcome === "succeeded" || e.outcome === "no-changes"),
			)
			.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))[0]

		if (!apply) {
			// No applying apply recorded; report no-changes conservatively.
			instances.push({ instanceId, kind: "no-changes" })
			continue
		}

		const explicit = backupByInstance.get(instanceId)
		if (explicit && !explicit.retained) {
			instances.push({ instanceId, kind: "unavailable", previousRevision: explicit.previousRevision })
			continue
		}

		if (apply.outcome === "no-changes") {
			// A no-changes apply captured no Route_Backup (Requirement 21.4 "the
			// apply made no changes there and captured no Route_Backup").
			instances.push({ instanceId, kind: "no-changes" })
			continue
		}

		// A succeeded apply captured a Route_Backup. Prefer explicit metadata; fall
		// back to the apply's start time as the capture time.
		instances.push({
			instanceId,
			kind: "backup",
			backupCaptureTime: explicit?.captureTime ?? apply.startedAt,
			backupLocation: explicit?.location ?? `backup://${instanceId}/${apply.startedAt}`,
			previousRevision: explicit?.previousRevision,
		})
	}

	return { failedFloors, instances }
}

// ---------------------------------------------------------------------------
// Human-readable summaries (Requirement 19.3, 21.3)
// ---------------------------------------------------------------------------

function fmtNum(value: number | null, unit: MetricUnit): string {
	if (value === null) {
		return "no data"
	}
	switch (unit) {
		case "fraction":
			return `${(value * 100).toFixed(2)}%`
		case "percent":
			return `${value.toFixed(2)}%`
		case "seconds":
			return `${value.toFixed(1)} s`
		case "ms":
			return `${value.toFixed(0)} ms`
		case "tokens":
			return `${Math.round(value)}`
		case "count":
			return `${Math.round(value)}`
	}
}

function renderEvaluationHuman(
	revision: Revision,
	baseline: Baseline,
	window: Window,
	requestCounts: readonly RouteRequestCount[],
	floors: readonly FloorOutcome[],
	objectives: readonly ObjectiveReport[],
	rejected: boolean,
): string {
	const lines: string[] = []
	lines.push(`Arrangement ${revision.commit} vs baseline ${baseline.windowLabel}`)
	lines.push(`Window ${new Date(window.startMs).toISOString()} → ${new Date(window.endMs).toISOString()}`)
	lines.push(rejected ? "RESULT: REJECTED (a Preservation_Floor failed)" : "RESULT: no floor failed")
	lines.push("")
	lines.push("Request counts:")
	for (const r of requestCounts) {
		const tags = [r.gated ? "gated" : "not-gated", r.underSampled ? "under-sampled" : null].filter(Boolean)
		lines.push(`  ${r.instanceId} ${r.publicRoute}: ${r.requests} (${tags.join(", ")})`)
	}
	lines.push("")
	lines.push("Preservation_Floors:")
	for (const f of floors) {
		lines.push(`  ${f.floor}: ${f.outcome} (candidate ${f.candidate ?? "n/a"}, floor ${f.floorValue})`)
	}
	if (objectives.length > 0) {
		lines.push("")
		lines.push("Improvement objectives:")
		for (const o of objectives) {
			const dir = o.improvement === null ? "not computed" : o.improvement ? "improved" : "worse"
			lines.push(`  ${o.objective}: ${fmtNum(o.candidate, o.unit)} vs ${fmtNum(o.baseline, o.unit)} (${dir})`)
		}
	}
	return lines.join("\n")
}

function renderIncompleteHuman(
	revision: Revision,
	baseline: Baseline,
	incomplete: IncompleteResult,
	span: Window | null,
): string {
	const lines: string[] = []
	lines.push(`Arrangement ${revision.commit} vs baseline ${baseline.windowLabel}`)
	lines.push(`RESULT: INCOMPLETE (${incomplete.cause})`)
	lines.push("No Preservation_Floor outcome is computed; the candidate is neither accepted nor rejected.")
	if (span === null) {
		lines.push("Measured span: empty (the intervening write started before the window start).")
	} else {
		lines.push(`Measured span: ${new Date(span.startMs).toISOString()} → ${new Date(span.endMs).toISOString()}`)
	}
	return lines.join("\n")
}

function renderEarlyCheckHuman(
	revision: Revision,
	baseline: Baseline,
	checkSpan: Window,
	floors: readonly FloorOutcome[],
	rollback: RollbackRecommendation | null,
): string {
	const lines: string[] = []
	lines.push(`Early check (first 24 h) — Arrangement ${revision.commit} vs baseline ${baseline.windowLabel}`)
	lines.push(`Check span ${new Date(checkSpan.startMs).toISOString()} → ${new Date(checkSpan.endMs).toISOString()}`)
	lines.push("This check does NOT accept or reject the Arrangement and does not change its Evaluation_Window.")
	lines.push("")
	lines.push("Preservation_Floors (20.1-20.4):")
	for (const f of floors) {
		lines.push(`  ${f.floor}: ${f.outcome} (candidate ${f.candidate ?? "n/a"}, floor ${f.floorValue})`)
	}
	if (rollback !== null) {
		lines.push("")
		lines.push("ROLLBACK RECOMMENDATION (recommendation only — no rollback is performed):")
		for (const f of rollback.failedFloors) {
			lines.push(`  failed: ${f.floor} (candidate ${f.candidate ?? "n/a"}, floor ${f.floorValue}, n=${f.samples ?? 0})`)
		}
		for (const inst of rollback.instances) {
			if (inst.kind === "backup") {
				lines.push(`  ${inst.instanceId}: Route_Backup at ${inst.backupLocation} (captured ${inst.backupCaptureTime})`)
			} else if (inst.kind === "unavailable") {
				lines.push(`  ${inst.instanceId}: Route_Backup unavailable (no longer retained)`)
			} else {
				lines.push(`  ${inst.instanceId}: no changes, no Route_Backup captured`)
			}
		}
	}
	return lines.join("\n")
}
