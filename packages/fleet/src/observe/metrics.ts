// Fleet_Observer — per-device and per-route metrics (design §4 "Metrics",
// Requirement 16.1-16.11).
//
// This is a PURE module. Given the observer's stored body-free rows
// (`copy.ts`), a way to attribute each row to a Device/Model_Offering/
// Cloud_Target/Public_Route (`attribution.ts`), the Fleet_Inventory (for Device
// slot ceilings and Residency_Groups), a selected window ("1h" | "24h" | "7d"),
// and the request time, it computes every metric Requirement 16 criteria 1-7
// name under the fixed conventions of criterion 9, with the partial / no-data /
// unreliable marks of criteria 10, 11, and 7. It performs no I/O and holds no
// clock: the caller supplies `nowMs` and the rows, so the output is
// deterministic and reproducible — the design-time oracle (`arrangement-
// replay.py` over `baseline-attempts-*.jsonl.gz`) reproduces the findings §5-6
// numbers from these same definitions.
//
// The fixed conventions (Requirement 16.9):
//   - success = HTTP 2xx; failed otherwise;
//   - a request = the attempts sharing one correlation id, its final attempt the
//     one with the latest completion time; a request belongs to a window when
//     its final attempt does;
//   - an attempt belongs to a window when its completion time is in [start,end);
//   - end-to-end latency = `dur_ms` (admission wait + upstream);
//   - an attempt is in flight over the completion-anchored interval
//     [end − latency, end); concurrency / busy-fraction count only the part of
//     each interval inside the window;
//   - end-to-end output tok/s = output tokens / latency-in-seconds;
//   - buckets 10,000-49,999 / 50,000-99,999 / ≥100,000 input tokens, nothing
//     below 10,000 or with no recorded input count;
//   - p50/p95 by the nearest-rank method, reported with sample counts;
//   - Health_Probes count only toward criterion 6;
//   - every metric appears in a machine-readable report and a human-readable
//     summary, each stating the window start and end.

import type { FleetInventory } from "@roo-code/types"

import type { Attribution, AttributionInput, Attributor, Unattributed } from "./attribution.js"
import { UNATTRIBUTED } from "./attribution.js"
import type { StoredRow } from "./copy.js"

// ---------------------------------------------------------------------------
// Window selection (Requirement 16.1, 16.9)
// ---------------------------------------------------------------------------

/** The three selectable windows: trailing 1 hour, 24 hours, or 7 days. */
export type MetricsWindow = "1h" | "24h" | "7d"

/** The duration of each selectable window, in milliseconds. */
const WINDOW_MS: Record<MetricsWindow, number> = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
}

// ---------------------------------------------------------------------------
// Attribution adapter (Requirement 16.9 "attributed as Requirement 17")
// ---------------------------------------------------------------------------

/**
 * How `metrics` learns a row's Device/Model_Offering/Cloud_Target/Public_Route.
 * The production attributor is the class `Attributor` from `attribution.ts`;
 * `attributorFn` adapts it. A test (or the design-time oracle) can supply any
 * function with this shape, so the metric arithmetic is verified independently
 * of the full revision-resolution machinery.
 */
export type AttributeRow = (row: StoredRow) => Attribution

/**
 * Adapt an `Attributor` instance to an `AttributeRow` by projecting each stored
 * row onto the body-free `AttributionInput` the attributor consumes. `exec`
 * carries the Target_Identifier; `connection_id` + `model` are the dispatch
 * fallback; `requested_model` names the Public_Route; `key`-independent
 * `session_tag` is not in the copy, so no Capability_Lane name is passed here
 * (the copy carries it separately when present).
 */
export function attributorFn(attributor: Attributor): AttributeRow {
	return (row: StoredRow): Attribution => attributor.attribute(toAttributionInput(row))
}

/** Project one stored row onto the attribution input (completion-anchored start). */
function toAttributionInput(row: StoredRow): AttributionInput {
	const f = row.fields
	return {
		instanceId: row.instanceId,
		completedAt: f.ts,
		endToEndMs: f.dur_ms ?? 0,
		targetId: f.exec ?? undefined,
		connectionId: f.connection_id ?? undefined,
		upstreamModelId: f.model ?? undefined,
		requestedModelId: f.requested_model ?? undefined,
		isHealthProbe: row.isHealthProbe,
	}
}

// ---------------------------------------------------------------------------
// Percentiles (Requirement 16.9 "nearest-rank, with sample counts")
// ---------------------------------------------------------------------------

/** A percentile value together with the sample count it was computed over. */
export interface Percentile {
	/** The value, or null when there are no qualifying samples (Requirement 16.11). */
	readonly value: number | null
	/** The number of samples (Requirement 16.9 "reported with their sample counts"). */
	readonly samples: number
}

/** No-data percentile with a stated sample count (Requirement 16.11). */
function noData(samples = 0): Percentile {
	return { value: null, samples }
}

/**
 * The nearest-rank percentile of `xs` for p in (0,100] (Requirement 16.9). The
 * rank is ⌈p/100 · n⌉ (at least 1), 1-indexed into the sorted values. An empty
 * sample yields no-data (Requirement 16.11).
 */
export function nearestRank(xs: readonly number[], p: number): Percentile {
	if (xs.length === 0) {
		return noData(0)
	}
	const sorted = [...xs].sort((a, b) => a - b)
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
	return { value: sorted[rank - 1]!, samples: sorted.length }
}

// ---------------------------------------------------------------------------
// A window-scoped, attributed attempt (the internal working row)
// ---------------------------------------------------------------------------

/**
 * One attempt projected into the metric domain: its timing (completion-anchored
 * interval), success, token counts, bucket, ttft, and its attribution. Only
 * attempts whose completion time is in the window appear (Requirement 16.9).
 */
interface Attempt {
	readonly corr: string | null
	readonly startMs: number
	readonly endMs: number
	readonly latencyMs: number
	readonly ok: boolean
	readonly status: number | null
	readonly etype: string | null
	readonly tin: number | null
	readonly tout: number | null
	readonly ttft: number | null
	readonly bucket: InputBucket | null
	readonly attr: Attribution
	readonly isHealthProbe: boolean
}

/** The three input-size buckets (Requirement 16.2); null for < 10,000 or unrecorded. */
export type InputBucket = "10-50k" | "50-100k" | "100k+"

const BUCKETS: readonly InputBucket[] = ["10-50k", "50-100k", "100k+"]

/** The bucket a recorded input token count falls in, or null (Requirement 16.2). */
export function bucketOf(tin: number | null): InputBucket | null {
	if (tin === null || tin < 10_000) {
		return null
	}
	if (tin < 50_000) {
		return "10-50k"
	}
	if (tin < 100_000) {
		return "50-100k"
	}
	return "100k+"
}

// ---------------------------------------------------------------------------
// Report shapes (Requirement 16.1-16.7, machine-readable half of 16.11)
// ---------------------------------------------------------------------------

/** Failed-attempt counts, grouped by HTTP status then error type (Requirement 16.1). */
export interface FailureBreakdown {
	readonly status: number
	readonly byErrorType: ReadonlyArray<{ readonly errorType: string | null; readonly count: number }>
	readonly count: number
}

/** The common performance block shared by Device and Model_Offering (Requirement 16.1). */
export interface PerformanceMetrics {
	readonly attempts: number
	readonly successRate: number | null
	readonly failures: readonly FailureBreakdown[]
	readonly latencyP50: Percentile
	readonly latencyP95: Percentile
	readonly outputTokPerSecP50: Percentile
	readonly inputTokenTotal: number
	readonly outputTokenTotal: number
	readonly peakInFlight: number
	readonly timeWeightedInFlight: number
}

/** Per-input-bucket metrics for a Model_Offering (Requirement 16.2). */
export interface BucketMetrics {
	readonly bucket: InputBucket
	readonly samples: number
	readonly latencyP50: Percentile
	readonly latencyP95: Percentile
	readonly outputTokPerSecP50: Percentile
}

/** Per-Device metrics (Requirement 16.1 + the Device-only block of 16.4). */
export interface DeviceMetrics {
	readonly deviceId: string | Unattributed
	readonly performance: PerformanceMetrics
	/** Busy fraction for each level N (Requirement 16.4). */
	readonly busyFraction: ReadonlyArray<{ readonly level: number; readonly fraction: number }>
	readonly capacityClassRejections: {
		readonly total: number
		readonly byStatus: ReadonlyArray<{ readonly status: number; readonly count: number }>
	}
	/** Model-switch metrics per Residency_Group with more than one offering (Requirement 16.4). */
	readonly residencySwitches: readonly ResidencySwitchMetrics[]
}

/** Model-switch metrics for one Residency_Group (Requirement 16.4). */
export interface ResidencySwitchMetrics {
	readonly residencyGroup: string
	readonly switchCount: number
	/** Post-switch minus non-switch TTFT p50, per Model_Offering (Requirement 16.4). */
	readonly perOffering: ReadonlyArray<{
		readonly modelOfferingId: string
		readonly switchTtftP50: Percentile
		readonly nonSwitchTtftP50: Percentile
		/** The difference, or null when either side has no samples (Requirement 16.11). */
		readonly ttftDeltaMs: number | null
		/** True when the Serving_Endpoint's TTFT is unreliable (Requirement 16.7). */
		readonly unreliable: boolean
	}>
}

/** Per-Model_Offering metrics (Requirement 16.1, 16.2). */
export interface ModelOfferingMetrics {
	readonly modelOfferingId: string | Unattributed
	readonly performance: PerformanceMetrics
	readonly buckets: readonly BucketMetrics[]
	/** True when this offering's Serving_Endpoint has unreliable TTFT (Requirement 16.7). */
	readonly ttftUnreliable: boolean
}

/** Landing distribution entry: a Device/Model_Offering/Cloud_Target share (Requirement 16.3). */
export interface LandingEntry {
	readonly key: string | Unattributed
	readonly percentage: number
}

/** Per-Public_Route metrics for one OmniRoute_Instance (Requirement 16.3). */
export interface PublicRouteMetrics {
	readonly instanceId: string
	readonly publicRoute: string
	readonly requests: number
	readonly finalSuccessRate: number | null
	readonly latencyP50: Percentile
	readonly latencyP95: Percentile
	readonly multiAttemptRate: number
	readonly failedAttemptTimeP50: Percentile
	readonly failedAttemptTimeP95: Percentile
	readonly landingByDevice: readonly LandingEntry[]
	readonly landingByModelOffering: readonly LandingEntry[]
	readonly cloudShare: number | null
	readonly cloudInputTokens: number
	readonly cloudOutputTokens: number
}

/** The five-percentage Local_Demand_Distribution (Requirement 16.5). */
export interface LocalDemandMetrics {
	/** Percentages for 0, 1, 2, 3, and 4-or-more; sum to 100 before rounding. */
	readonly percentages: readonly [number, number, number, number, number]
	readonly starts: number
}

/** Per-(instance, Serving_Endpoint) Health_Probe metrics (Requirement 16.6). */
export interface HealthProbeMetrics {
	readonly instanceId: string
	readonly servingEndpointId: string | Unattributed
	readonly probeCount: number
	readonly probesPerHour: number
	readonly failureRate: number | null
}

/** How much of the selected window one instance's readable records cover (Requirement 16.10). */
export interface InstanceCoverage {
	readonly instanceId: string
	/** The covered span inside the window, or null when the instance has no records. */
	readonly coveredFromMs: number | null
	readonly coveredToMs: number | null
}

/** The complete machine-readable metrics report (Requirement 16.11). */
export interface FleetMetricsReport {
	readonly window: MetricsWindow
	readonly windowStartMs: number
	readonly windowEndMs: number
	/** True when the window extends before the earliest copied record (Requirement 16.10). */
	readonly partial: boolean
	/** True when the window contains no records at all (Requirement 16.11). */
	readonly noData: boolean
	readonly coverage: readonly InstanceCoverage[]
	readonly devices: readonly DeviceMetrics[]
	readonly modelOfferings: readonly ModelOfferingMetrics[]
	readonly publicRoutes: readonly PublicRouteMetrics[]
	readonly localDemand: LocalDemandMetrics
	readonly healthProbes: readonly HealthProbeMetrics[]
	/** The human-readable summary (Requirement 16.11). */
	readonly human: string
}

/** The inputs `metrics` needs: the stored rows, an attributor, the inventory, and the clock. */
export interface MetricsOptions {
	readonly rows: readonly StoredRow[]
	readonly attribute: AttributeRow
	readonly inventory: FleetInventory
	readonly nowMs: number
}

// ---------------------------------------------------------------------------
// Capacity-class rejection statuses (Requirement 16.4; findings §5.4)
// ---------------------------------------------------------------------------

/** HTTP statuses that are capacity-class rejections (429/503/409) (findings §5.4). */
const CAPACITY_REJECTION_STATUSES = new Set<number>([429, 503, 409])

// ---------------------------------------------------------------------------
// metrics() — the entry point (Requirement 16.1-16.11)
// ---------------------------------------------------------------------------

/**
 * Compute the Fleet_Observer metrics for a selected window ending at `nowMs`
 * (Requirement 16.1-16.11). Pure: the result is a function of the inputs alone.
 */
export function metrics(window: MetricsWindow, opts: MetricsOptions): FleetMetricsReport {
	const windowEndMs = opts.nowMs
	const windowStartMs = windowEndMs - WINDOW_MS[window]
	return computeMetrics(window, windowStartMs, windowEndMs, opts)
}

/**
 * Compute the Fleet_Observer metrics over an EXPLICIT half-open window
 * [startMs, endMs), reusing every Requirement 16 convention (success = 2xx,
 * correlation-id request grouping, completion-anchored in-flight intervals,
 * nearest-rank p50/p95 with sample counts, cloud share, landing distribution,
 * Local_Demand_Distribution, partial/no-data marks). This is the entry point the
 * Arrangement_Evaluator uses: Requirement 19 criterion 2 requires the evaluator
 * to compute every metric over its measured window — which is NOT one of the
 * three trailing windows `metrics()` selects — "using the metric definitions,
 * sample populations, and conventions of Requirement 16", so it must reuse this
 * exact arithmetic over an arbitrary window. The reported `window` label is
 * cosmetic here (the evaluator states the real start/end); callers that want a
 * trailing window should use `metrics()`.
 *
 * Pure: the result is a function of the inputs alone.
 */
export function metricsOverWindow(startMs: number, endMs: number, opts: MetricsOptions): FleetMetricsReport {
	// The window label is informational for the arbitrary-window case; pick the
	// nearest standard label by duration so the human summary reads sensibly.
	const label: MetricsWindow = nearestWindowLabel(endMs - startMs)
	return computeMetrics(label, startMs, endMs, opts)
}

/** The standard window label whose duration is closest to `durationMs`. */
function nearestWindowLabel(durationMs: number): MetricsWindow {
	let best: MetricsWindow = "7d"
	let bestDelta = Number.POSITIVE_INFINITY
	for (const label of ["1h", "24h", "7d"] as const) {
		const delta = Math.abs(WINDOW_MS[label] - durationMs)
		if (delta < bestDelta) {
			bestDelta = delta
			best = label
		}
	}
	return best
}

/** The shared implementation of `metrics` and `metricsOverWindow`. */
function computeMetrics(
	window: MetricsWindow,
	windowStartMs: number,
	windowEndMs: number,
	opts: MetricsOptions,
): FleetMetricsReport {
	// Project every stored row to an attributed attempt, keeping only those whose
	// completion time lands in [start, end) (Requirement 16.9).
	const all: Attempt[] = []
	let earliestRecordMs = Number.POSITIVE_INFINITY
	const coverageByInstance = new Map<string, { from: number; to: number }>()
	for (const row of opts.rows) {
		const endMs = Date.parse(row.fields.ts)
		if (Number.isNaN(endMs)) {
			continue
		}
		earliestRecordMs = Math.min(earliestRecordMs, endMs)
		trackCoverage(coverageByInstance, row.instanceId, endMs, windowStartMs, windowEndMs)
		if (endMs < windowStartMs || endMs >= windowEndMs) {
			continue
		}
		all.push(toAttempt(row, endMs, opts.attribute(row)))
	}

	// Client attempts (criteria 1-5) vs Health_Probes (criterion 6 only).
	const client = all.filter((a) => !a.isHealthProbe)
	const probes = all.filter((a) => a.isHealthProbe)

	const noDataFlag = all.length === 0
	const partial =
		Number.isFinite(earliestRecordMs) && earliestRecordMs > windowStartMs ? true : opts.rows.length === 0

	// Unreliable-TTFT set, computed once per Serving_Endpoint (Requirement 16.7).
	const unreliableEndpoints = computeUnreliableEndpoints(client)

	const devices = computeDevices(client, opts.inventory, windowStartMs, windowEndMs, unreliableEndpoints)
	const modelOfferings = computeModelOfferings(client, windowStartMs, windowEndMs, unreliableEndpoints)
	const publicRoutes = computePublicRoutes(client)
	const localDemand = computeLocalDemand(client)
	const healthProbes = computeHealthProbes(probes, windowStartMs, windowEndMs)
	const coverage = buildCoverage(coverageByInstance)

	const report: Omit<FleetMetricsReport, "human"> = {
		window,
		windowStartMs,
		windowEndMs,
		partial,
		noData: noDataFlag,
		coverage,
		devices,
		modelOfferings,
		publicRoutes,
		localDemand,
		healthProbes,
	}
	return { ...report, human: renderHuman(report) }
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

function toAttempt(row: StoredRow, endMs: number, attr: Attribution): Attempt {
	const f = row.fields
	const latencyMs = f.dur_ms ?? 0
	const status = f.status
	return {
		corr: f.corr,
		startMs: endMs - latencyMs,
		endMs,
		latencyMs,
		ok: isSuccess(status),
		status,
		etype: f.etype,
		tin: f.tin,
		tout: f.tout,
		ttft: f.ttft,
		bucket: bucketOf(f.tin),
		attr,
		isHealthProbe: row.isHealthProbe,
	}
}

/** An attempt succeeded when its HTTP status is 2xx (Requirement 16.9). */
function isSuccess(status: number | null): boolean {
	return status !== null && status >= 200 && status < 300
}

// ---------------------------------------------------------------------------
// Coverage / partial (Requirement 16.10)
// ---------------------------------------------------------------------------

function trackCoverage(
	map: Map<string, { from: number; to: number }>,
	instanceId: string,
	endMs: number,
	windowStartMs: number,
	windowEndMs: number,
): void {
	if (endMs < windowStartMs || endMs >= windowEndMs) {
		return
	}
	const existing = map.get(instanceId)
	if (existing === undefined) {
		map.set(instanceId, { from: endMs, to: endMs })
		return
	}
	existing.from = Math.min(existing.from, endMs)
	existing.to = Math.max(existing.to, endMs)
}

function buildCoverage(map: Map<string, { from: number; to: number }>): InstanceCoverage[] {
	return [...map.entries()]
		.map(([instanceId, span]) => ({
			instanceId,
			coveredFromMs: span.from,
			coveredToMs: span.to,
		}))
		.sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}

// ---------------------------------------------------------------------------
// In-flight concurrency / busy fraction (Requirement 16.1, 16.4, 16.9)
// ---------------------------------------------------------------------------

/**
 * The peak in-flight concurrency and time-weighted average over the window for a
 * set of attempts, counting only the part of each completion-anchored interval
 * inside the window (Requirement 16.1, 16.9). Returns the busy fraction for each
 * level 1..maxLevel as well (Requirement 16.4).
 */
function concurrency(
	attempts: readonly Attempt[],
	windowStartMs: number,
	windowEndMs: number,
	maxLevel: number,
): {
	peak: number
	timeWeighted: number
	busyByLevel: Map<number, number>
} {
	const windowMs = windowEndMs - windowStartMs
	// Build clipped intervals and a sweep over start/end events.
	type Event = { t: number; delta: number }
	const events: Event[] = []
	for (const a of attempts) {
		const s = Math.max(a.startMs, windowStartMs)
		const e = Math.min(a.endMs, windowEndMs)
		if (e <= s) {
			continue
		}
		events.push({ t: s, delta: 1 }, { t: e, delta: -1 })
	}
	// Ends before starts at equal times so an interval that closes exactly as
	// another opens does not inflate the count (half-open [s, e)).
	events.sort((x, y) => (x.t === y.t ? x.delta - y.delta : x.t - y.t))

	let k = 0
	let peak = 0
	let area = 0 // ∫ k dt over the window
	const timeAtLeast = new Map<number, number>() // level -> ms with k >= level
	let prevT = events.length > 0 ? events[0]!.t : windowStartMs
	for (const ev of events) {
		const dt = ev.t - prevT
		if (dt > 0 && k > 0) {
			area += k * dt
			for (let level = 1; level <= k; level++) {
				timeAtLeast.set(level, (timeAtLeast.get(level) ?? 0) + dt)
			}
		}
		k += ev.delta
		peak = Math.max(peak, k)
		prevT = ev.t
	}

	const busyByLevel = new Map<number, number>()
	const topLevel = Math.max(maxLevel, peak)
	for (let level = 1; level <= topLevel; level++) {
		const ms = timeAtLeast.get(level) ?? 0
		busyByLevel.set(level, windowMs > 0 ? (100 * ms) / windowMs : 0)
	}
	return { peak, timeWeighted: windowMs > 0 ? area / windowMs : 0, busyByLevel }
}

// ---------------------------------------------------------------------------
// Shared performance block (Requirement 16.1)
// ---------------------------------------------------------------------------

function performanceOf(
	attempts: readonly Attempt[],
	windowStartMs: number,
	windowEndMs: number,
	maxLevel: number,
): PerformanceMetrics {
	const n = attempts.length
	const successes = attempts.filter((a) => a.ok)
	const latencies = successes.map((a) => a.latencyMs / 1000)
	const tokPerSec = successes
		.filter((a) => a.tout !== null && a.latencyMs > 0)
		.map((a) => a.tout! / (a.latencyMs / 1000))
	const conc = concurrency(attempts, windowStartMs, windowEndMs, maxLevel)
	return {
		attempts: n,
		successRate: n > 0 ? (100 * successes.length) / n : null,
		failures: failureBreakdown(attempts.filter((a) => !a.ok)),
		latencyP50: nearestRank(latencies, 50),
		latencyP95: nearestRank(latencies, 95),
		outputTokPerSecP50: nearestRank(tokPerSec, 50),
		inputTokenTotal: sum(attempts.map((a) => a.tin ?? 0)),
		outputTokenTotal: sum(attempts.map((a) => a.tout ?? 0)),
		peakInFlight: conc.peak,
		timeWeightedInFlight: conc.timeWeighted,
	}
}

/** Failed-attempt counts by HTTP status, then by error type (Requirement 16.1). */
function failureBreakdown(failed: readonly Attempt[]): FailureBreakdown[] {
	const byStatus = new Map<number, Attempt[]>()
	for (const a of failed) {
		const status = a.status ?? 0
		pushTo(byStatus, status, a)
	}
	return [...byStatus.entries()]
		.map(([status, group]) => {
			const byType = new Map<string | null, number>()
			for (const a of group) {
				byType.set(a.etype, (byType.get(a.etype) ?? 0) + 1)
			}
			return {
				status,
				count: group.length,
				byErrorType: [...byType.entries()]
					.map(([errorType, count]) => ({ errorType, count }))
					.sort((x, y) => y.count - x.count),
			}
		})
		.sort((x, y) => y.count - x.count)
}

// ---------------------------------------------------------------------------
// Per-Device metrics (Requirement 16.1, 16.4)
// ---------------------------------------------------------------------------

function computeDevices(
	client: readonly Attempt[],
	inventory: FleetInventory,
	windowStartMs: number,
	windowEndMs: number,
	unreliableEndpoints: ReadonlySet<string>,
): DeviceMetrics[] {
	const byDevice = groupBy(client, (a) => deviceKey(a.attr.deviceId))
	const ceilingById = new Map(inventory.devices.map((d) => [d.id, d.slotCeiling]))
	const residencyByOffering = new Map(inventory.offerings.map((o) => [o.id, o.residencyGroup]))
	const offeringsByDevice = groupArray(inventory.offerings, (o) => o.deviceId)

	const out: DeviceMetrics[] = []
	for (const [deviceKeyValue, attempts] of byDevice) {
		const deviceId = unkey(deviceKeyValue)
		const ceiling = typeof deviceId === "string" ? (ceilingById.get(deviceId) ?? 1) : 1
		const conc = concurrency(attempts, windowStartMs, windowEndMs, ceiling)
		const topLevel = Math.max(ceiling, conc.peak)
		const busyFraction: Array<{ level: number; fraction: number }> = []
		for (let level = 1; level <= topLevel; level++) {
			busyFraction.push({ level, fraction: conc.busyByLevel.get(level) ?? 0 })
		}
		out.push({
			deviceId,
			performance: performanceOf(attempts, windowStartMs, windowEndMs, ceiling),
			busyFraction,
			capacityClassRejections: capacityRejections(attempts),
			residencySwitches:
				typeof deviceId === "string"
					? residencySwitches(
							attempts,
							offeringsByDevice.get(deviceId) ?? [],
							residencyByOffering,
							unreliableEndpoints,
						)
					: [],
		})
	}
	return out.sort((a, b) => deviceKey(a.deviceId).localeCompare(deviceKey(b.deviceId)))
}

function capacityRejections(attempts: readonly Attempt[]): DeviceMetrics["capacityClassRejections"] {
	const byStatus = new Map<number, number>()
	let total = 0
	for (const a of attempts) {
		if (a.status !== null && CAPACITY_REJECTION_STATUSES.has(a.status)) {
			byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1)
			total++
		}
	}
	return {
		total,
		byStatus: [...byStatus.entries()]
			.map(([status, count]) => ({ status, count }))
			.sort((x, y) => y.count - x.count),
	}
}

/**
 * Model-switch metrics for each Residency_Group on the Device that contains more
 * than one Model_Offering (Requirement 16.4). A model switch is an attempt whose
 * immediately preceding attempt on the same Residency_Group (ordered by start
 * time) targeted a different Model_Offering.
 */
function residencySwitches(
	attempts: readonly Attempt[],
	deviceOfferings: ReadonlyArray<{ id: string; residencyGroup: string }>,
	residencyByOffering: ReadonlyMap<string, string>,
	unreliableEndpoints: ReadonlySet<string>,
): ResidencySwitchMetrics[] {
	// Residency groups on this device with more than one offering.
	const groupOfferings = groupArray(deviceOfferings, (o) => o.residencyGroup)
	const out: ResidencySwitchMetrics[] = []
	for (const [group, offerings] of groupOfferings) {
		if (offerings.length <= 1) {
			continue
		}
		const groupAttempts = attempts
			.filter((a) => {
				const offeringId = a.attr.modelOfferingId
				return typeof offeringId === "string" && residencyByOffering.get(offeringId) === group
			})
			.slice()
			.sort((a, b) => a.startMs - b.startMs)

		const isSwitch = new Array<boolean>(groupAttempts.length).fill(false)
		let switchCount = 0
		for (let i = 1; i < groupAttempts.length; i++) {
			if (groupAttempts[i]!.attr.modelOfferingId !== groupAttempts[i - 1]!.attr.modelOfferingId) {
				isSwitch[i] = true
				switchCount++
			}
		}

		const perOffering = offerings
			.map((o) => {
				const mine = groupAttempts
					.map((a, i) => ({ a, i }))
					.filter(({ a }) => a.attr.modelOfferingId === o.id)
				const switchTtft = mine
					.filter(({ a, i }) => isSwitch[i] && a.ok && a.ttft !== null)
					.map(({ a }) => a.ttft!)
				const nonSwitchTtft = mine
					.filter(({ a, i }) => !isSwitch[i] && a.ok && a.ttft !== null)
					.map(({ a }) => a.ttft!)
				const switchP50 = nearestRank(switchTtft, 50)
				const nonSwitchP50 = nearestRank(nonSwitchTtft, 50)
				const delta =
					switchP50.value !== null && nonSwitchP50.value !== null
						? switchP50.value - nonSwitchP50.value
						: null
				return {
					modelOfferingId: o.id,
					switchTtftP50: switchP50,
					nonSwitchTtftP50: nonSwitchP50,
					ttftDeltaMs: delta,
					unreliable: endpointUnreliableForOffering(o.id, mine, unreliableEndpoints),
				}
			})
			.sort((a, b) => a.modelOfferingId.localeCompare(b.modelOfferingId))

		out.push({ residencyGroup: group, switchCount, perOffering })
	}
	return out.sort((a, b) => a.residencyGroup.localeCompare(b.residencyGroup))
}

function endpointUnreliableForOffering(
	_offeringId: string,
	attempts: ReadonlyArray<{ a: Attempt }>,
	unreliableEndpoints: ReadonlySet<string>,
): boolean {
	return attempts.some(({ a }) => {
		const ep = a.attr.servingEndpointId
		return ep !== null && unreliableEndpoints.has(ep)
	})
}

// ---------------------------------------------------------------------------
// Per-Model_Offering metrics (Requirement 16.1, 16.2)
// ---------------------------------------------------------------------------

function computeModelOfferings(
	client: readonly Attempt[],
	windowStartMs: number,
	windowEndMs: number,
	unreliableEndpoints: ReadonlySet<string>,
): ModelOfferingMetrics[] {
	// Only attempts attributed to a Model_Offering (local). Cloud attempts have a
	// null offering; unattributed offerings become the visible UNATTRIBUTED bucket.
	const withOffering = client.filter((a) => a.attr.modelOfferingId !== null)
	const byOffering = groupBy(withOffering, (a) => offeringKey(a.attr.modelOfferingId))
	const out: ModelOfferingMetrics[] = []
	for (const [key, attempts] of byOffering) {
		const offeringId = unkeyOffering(key)
		out.push({
			modelOfferingId: offeringId,
			performance: performanceOf(attempts, windowStartMs, windowEndMs, 1),
			buckets: bucketMetrics(attempts),
			ttftUnreliable: attempts.some(
				(a) => a.attr.servingEndpointId !== null && unreliableEndpoints.has(a.attr.servingEndpointId),
			),
		})
	}
	return out.sort((a, b) => offeringKey(a.modelOfferingId).localeCompare(offeringKey(b.modelOfferingId)))
}

/** Per-bucket p50/p95 latency and output rate of successful attempts (Requirement 16.2). */
function bucketMetrics(attempts: readonly Attempt[]): BucketMetrics[] {
	const out: BucketMetrics[] = []
	for (const bucket of BUCKETS) {
		const inBucket = attempts.filter((a) => a.ok && a.bucket === bucket)
		const latencies = inBucket.map((a) => a.latencyMs / 1000)
		const tokPerSec = inBucket
			.filter((a) => a.tout !== null && a.latencyMs > 0)
			.map((a) => a.tout! / (a.latencyMs / 1000))
		out.push({
			bucket,
			samples: inBucket.length,
			latencyP50: nearestRank(latencies, 50),
			latencyP95: nearestRank(latencies, 95),
			outputTokPerSecP50: nearestRank(tokPerSec, 50),
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Per-Public_Route metrics (Requirement 16.3)
// ---------------------------------------------------------------------------

function computePublicRoutes(client: readonly Attempt[]): PublicRouteMetrics[] {
	// A request = attempts sharing one correlation id; its route is the route its
	// final attempt names (Requirement 16.9, 16.3). Group attempts into requests
	// keyed by (instanceId, correlation id), then group requests by their route.
	type Request = { attempts: Attempt[]; final: Attempt }
	const byCorr = new Map<string, Attempt[]>()
	for (const a of client) {
		if (a.corr === null || a.attr.publicRoute === null) {
			continue
		}
		pushTo(byCorr, `${a.attr.instanceId}\u0000${a.corr}`, a)
	}

	const requestsByRoute = new Map<string, Request[]>()
	for (const [, attempts] of byCorr) {
		const sorted = attempts.slice().sort((x, y) => x.endMs - y.endMs)
		const final = sorted[sorted.length - 1]!
		if (final.attr.publicRoute === null) {
			continue
		}
		const key = `${final.attr.instanceId}\u0000${final.attr.publicRoute}`
		pushTo(requestsByRoute, key, { attempts: sorted, final })
	}

	const out: PublicRouteMetrics[] = []
	for (const [key, requests] of requestsByRoute) {
		const [instanceId, publicRoute] = key.split("\u0000") as [string, string]
		out.push(publicRouteMetrics(instanceId, publicRoute, requests))
	}
	return out.sort((a, b) =>
		a.instanceId === b.instanceId
			? a.publicRoute.localeCompare(b.publicRoute)
			: a.instanceId.localeCompare(b.instanceId),
	)
}

function publicRouteMetrics(
	instanceId: string,
	publicRoute: string,
	requests: ReadonlyArray<{ attempts: Attempt[]; final: Attempt }>,
): PublicRouteMetrics {
	const total = requests.length
	const finallySuccessful = requests.filter((r) => r.final.ok)
	const multiAttempt = requests.filter((r) => r.attempts.length > 1).length

	// Request latency = first attempt start → final attempt completion (Requirement 16.3).
	const reqLatencies = finallySuccessful.map(
		(r) => (r.final.endMs - Math.min(...r.attempts.map((a) => a.startMs))) / 1000,
	)
	// Failed-attempt time: summed latency of a finally-successful request's failed
	// attempts, for requests with at least one failed attempt (Requirement 16.3).
	const failedTimes = finallySuccessful
		.map((r) => r.attempts.filter((a) => !a.ok))
		.filter((failed) => failed.length > 0)
		.map((failed) => sum(failed.map((a) => a.latencyMs)) / 1000)

	// Landing distribution over finally-successful requests (Requirement 16.3).
	const landingByDevice = landingDistribution(finallySuccessful, (r) => landingDeviceKey(r.final))
	const landingByModelOffering = landingDistribution(finallySuccessful, (r) => landingOfferingKey(r.final))
	const cloudRequests = finallySuccessful.filter((r) => r.final.attr.cloudTargetId !== null)

	// Cloud token totals over EVERY attempt of those requests served by a cloud
	// target, success or not (Requirement 16.3).
	let cloudIn = 0
	let cloudOut = 0
	for (const r of cloudRequests) {
		for (const a of r.attempts) {
			cloudIn += a.tin ?? 0
			cloudOut += a.tout ?? 0
		}
	}

	return {
		instanceId,
		publicRoute,
		requests: total,
		finalSuccessRate: total > 0 ? (100 * finallySuccessful.length) / total : null,
		latencyP50: nearestRank(reqLatencies, 50),
		latencyP95: nearestRank(reqLatencies, 95),
		multiAttemptRate: total > 0 ? (100 * multiAttempt) / total : 0,
		failedAttemptTimeP50: nearestRank(failedTimes, 50),
		failedAttemptTimeP95: nearestRank(failedTimes, 95),
		landingByDevice,
		landingByModelOffering,
		cloudShare: finallySuccessful.length > 0 ? (100 * cloudRequests.length) / finallySuccessful.length : null,
		cloudInputTokens: cloudIn,
		cloudOutputTokens: cloudOut,
	}
}

function landingDistribution(
	requests: ReadonlyArray<{ final: Attempt }>,
	keyOf: (r: { final: Attempt }) => string | Unattributed,
): LandingEntry[] {
	const n = requests.length
	if (n === 0) {
		return []
	}
	const counts = new Map<string, number>()
	for (const r of requests) {
		const k = keyOf(r)
		const sk = typeof k === "string" ? k : UNATTRIBUTED
		counts.set(sk, (counts.get(sk) ?? 0) + 1)
	}
	return [...counts.entries()]
		.map(([key, count]) => ({ key, percentage: (100 * count) / n }))
		.sort((a, b) => b.percentage - a.percentage)
}

/** The landing key of a request's final attempt by Device or Cloud_Target (Requirement 16.3). */
function landingDeviceKey(final: Attempt): string | Unattributed {
	if (final.attr.cloudTargetId !== null) {
		return typeof final.attr.cloudTargetId === "string" ? final.attr.cloudTargetId : UNATTRIBUTED
	}
	return deviceKey(final.attr.deviceId)
}

/** The landing key by Model_Offering or Cloud_Target (Requirement 16.3). */
function landingOfferingKey(final: Attempt): string | Unattributed {
	if (final.attr.cloudTargetId !== null) {
		return typeof final.attr.cloudTargetId === "string" ? final.attr.cloudTargetId : UNATTRIBUTED
	}
	return offeringKey(final.attr.modelOfferingId)
}

// ---------------------------------------------------------------------------
// Local_Demand_Distribution (Requirement 16.5)
// ---------------------------------------------------------------------------

/**
 * The five percentages (0, 1, 2, 3, 4+) describing how many other generation
 * attempts were already in flight on ANY Device when each local request started
 * (Requirement 16.5). Generation attempts exclude embeddings and rerank; here a
 * generation attempt is one attributed to a Device (local), since cloud attempts
 * and embeddings/rerank are not device-attributed.
 */
function computeLocalDemand(client: readonly Attempt[]): LocalDemandMetrics {
	const local = client.filter((a) => typeof a.attr.deviceId === "string")
	const intervals = local.map((a) => ({ start: a.startMs, end: a.endMs }))
	const counts = [0, 0, 0, 0, 0]
	for (const a of local) {
		const s = a.startMs
		let inFlight = 0
		for (const iv of intervals) {
			if (iv.start <= s && s < iv.end) {
				inFlight++
			}
		}
		// Subtract the starting attempt itself (its own interval contains its start).
		const others = Math.max(0, inFlight - 1)
		const slot = Math.min(others, 4)
		counts[slot] = (counts[slot] ?? 0) + 1
	}
	const starts = local.length
	const pct = (c: number): number => (starts > 0 ? (100 * c) / starts : 0)
	const percentages: readonly [number, number, number, number, number] = [
		pct(counts[0] ?? 0),
		pct(counts[1] ?? 0),
		pct(counts[2] ?? 0),
		pct(counts[3] ?? 0),
		pct(counts[4] ?? 0),
	]
	return { percentages, starts }
}

// ---------------------------------------------------------------------------
// Health probes (Requirement 16.6)
// ---------------------------------------------------------------------------

function computeHealthProbes(
	probes: readonly Attempt[],
	windowStartMs: number,
	windowEndMs: number,
): HealthProbeMetrics[] {
	const windowHours = (windowEndMs - windowStartMs) / (60 * 60 * 1000)
	const byPair = groupBy(probes, (a) => `${a.attr.instanceId}\u0000${endpointKey(a.attr.servingEndpointId)}`)
	const out: HealthProbeMetrics[] = []
	for (const [key, group] of byPair) {
		const [instanceId, endpointPart] = key.split("\u0000") as [string, string]
		const failed = group.filter((a) => !a.ok).length
		out.push({
			instanceId,
			servingEndpointId: endpointPart === UNATTRIBUTED ? UNATTRIBUTED : endpointPart,
			probeCount: group.length,
			probesPerHour: windowHours > 0 ? group.length / windowHours : 0,
			failureRate: group.length > 0 ? (100 * failed) / group.length : null,
		})
	}
	return out.sort((a, b) =>
		a.instanceId === b.instanceId
			? endpointKey(a.servingEndpointId).localeCompare(endpointKey(b.servingEndpointId))
			: a.instanceId.localeCompare(b.instanceId),
	)
}

// ---------------------------------------------------------------------------
// Unreliable TTFT (Requirement 16.7)
// ---------------------------------------------------------------------------

/**
 * The set of Serving_Endpoint ids whose TTFT is unreliable (Requirement 16.7):
 * an endpoint with at least one attempt that has a recorded TTFT and more than
 * 10,000 input tokens, where more than 10% of those attempts report a TTFT below
 * 50 ms.
 */
function computeUnreliableEndpoints(client: readonly Attempt[]): Set<string> {
	const byEndpoint = new Map<string, { total: number; below: number }>()
	for (const a of client) {
		const ep = a.attr.servingEndpointId
		if (typeof ep !== "string") {
			continue
		}
		if (a.ttft === null || (a.tin ?? 0) <= 10_000) {
			continue
		}
		const stat = byEndpoint.get(ep) ?? { total: 0, below: 0 }
		stat.total++
		if (a.ttft < 50) {
			stat.below++
		}
		byEndpoint.set(ep, stat)
	}
	const unreliable = new Set<string>()
	for (const [ep, stat] of byEndpoint) {
		if (stat.total > 0 && stat.below / stat.total > 0.1) {
			unreliable.add(ep)
		}
	}
	return unreliable
}

// ---------------------------------------------------------------------------
// Human-readable summary (Requirement 16.11)
// ---------------------------------------------------------------------------

function renderHuman(r: Omit<FleetMetricsReport, "human">): string {
	const lines: string[] = []
	const start = new Date(r.windowStartMs).toISOString()
	const end = new Date(r.windowEndMs).toISOString()
	lines.push(`Fleet metrics — window ${r.window} (${start} → ${end})`)
	if (r.noData) {
		lines.push("  no data: the selected window contains no records")
		return lines.join("\n")
	}
	if (r.partial) {
		lines.push("  partial: the window extends before the earliest copied record")
	}
	lines.push("")
	lines.push("Devices:")
	for (const d of r.devices) {
		const p = d.performance
		lines.push(
			`  ${deviceKey(d.deviceId)}: ${p.attempts} attempts, ` +
				`${fmtPct(p.successRate)} success, p50 ${fmtPctl(p.latencyP50)}s / p95 ${fmtPctl(p.latencyP95)}s, ` +
				`peak ${p.peakInFlight} in flight`,
		)
	}
	lines.push("")
	lines.push("Model offerings:")
	for (const m of r.modelOfferings) {
		const p = m.performance
		const mark = m.ttftUnreliable ? " [ttft unreliable]" : ""
		lines.push(
			`  ${offeringKey(m.modelOfferingId)}: ${p.attempts} attempts, ` +
				`${fmtPct(p.successRate)} success, p50 ${fmtPctl(p.latencyP50)}s / p95 ${fmtPctl(p.latencyP95)}s${mark}`,
		)
	}
	lines.push("")
	lines.push("Public routes:")
	for (const pr of r.publicRoutes) {
		const landing = pr.landingByDevice
			.map((l) => `${keyLabel(l.key)} ${l.percentage.toFixed(1)}%`)
			.join(", ")
		lines.push(
			`  ${pr.instanceId}/${pr.publicRoute}: ${pr.requests} requests, ` +
				`${fmtPct(pr.finalSuccessRate)} final success, cloud ${fmtPct(pr.cloudShare)}, ` +
				`multi-attempt ${pr.multiAttemptRate.toFixed(1)}% — landing: ${landing}`,
		)
	}
	lines.push("")
	const ld = r.localDemand
	lines.push(
		`Local demand (${ld.starts} starts): ` +
			ld.percentages.map((p, i) => `${i === 4 ? "4+" : i}=${p.toFixed(1)}%`).join(", "),
	)
	if (r.healthProbes.length > 0) {
		lines.push("")
		lines.push("Health probes:")
		for (const hp of r.healthProbes) {
			lines.push(
				`  ${hp.instanceId}/${endpointKey(hp.servingEndpointId)}: ${hp.probeCount} probes, ` +
					`${hp.probesPerHour.toFixed(1)}/h, ${fmtPct(hp.failureRate)} failed`,
			)
		}
	}
	return lines.join("\n")
}

function fmtPct(v: number | null): string {
	return v === null ? "no-data" : `${v.toFixed(1)}%`
}

function fmtPctl(p: Percentile): string {
	return p.value === null ? "no-data" : p.value.toFixed(1)
}

function keyLabel(key: string | Unattributed): string {
	return key
}

// ---------------------------------------------------------------------------
// Small helpers (keys, grouping, arithmetic)
// ---------------------------------------------------------------------------

/** A string key for a Device id that may be null (cloud) or UNATTRIBUTED. */
function deviceKey(id: string | Unattributed | null): string {
	return id === null ? "cloud" : id
}

function unkey(key: string): string | Unattributed {
	return key === UNATTRIBUTED ? UNATTRIBUTED : key
}

function offeringKey(id: string | Unattributed | null): string {
	return id === null ? "cloud" : id
}

function unkeyOffering(key: string): string | Unattributed {
	return key === UNATTRIBUTED ? UNATTRIBUTED : key
}

function endpointKey(id: string | Unattributed | null): string {
	return id === null ? "none" : id
}

function groupBy<T>(items: readonly T[], keyOf: (t: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>()
	for (const item of items) {
		pushTo(map, keyOf(item), item)
	}
	return map
}

function groupArray<T>(items: readonly T[], keyOf: (t: T) => string): Map<string, T[]> {
	return groupBy(items, keyOf)
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key)
	if (list) {
		list.push(value)
	} else {
		map.set(key, [value])
	}
}

function sum(xs: readonly number[]): number {
	let total = 0
	for (const x of xs) {
		total += x
	}
	return total
}
