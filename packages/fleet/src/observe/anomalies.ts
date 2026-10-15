// Fleet_Observer — runtime anomaly detection (design §4 "Runtime anomaly
// detection", Requirement 18.1-18.10).
//
// This is a PURE module. Given the observer's stored body-free rows (`copy.ts`),
// the busy-slot-skip records copied from each OmniRoute_Instance (see below),
// a way to attribute each row to a Device/Model_Offering/Cloud_Target/
// Public_Route (`attribution.ts`), the Fleet_Inventory (Device slot ceilings,
// hostPreemption, Residency_Groups), the compiled Desired_Route_State's
// Expanded_Target_Sequences so a target can be named with its Public_Routes,
// the Preservation_Floors of the Gated_Routes, instance request timeouts (so a
// span's records can be "settled"), and the request time, it detects the six
// anomaly classes of Requirement 18 and raises ONE alert per occurrence
// (Requirement 18.8), each naming the required identifiers/values plus an
// evidence summary (Requirement 18.7). It performs no I/O and holds no clock:
// the caller supplies `nowMs` and the rows, so the output is deterministic.
//
// The alert WRITE (Requirement 18.7, 18.9) is a separate concern: `writeAlerts`
// drives the injected `AlertWriter` from `reconcile/schedule.ts` with the ≤5 min
// retry / 24 h give-up policy. Detection and writing are split so the detectors
// stay pure and the retrying writer is tested on its own.
//
// Conventions follow Requirement 16 criteria 2 and 9 and Requirement 18
// criterion 8: success = HTTP 2xx; an attempt is in flight over the completion-
// anchored interval [end − upstream_duration, end) where upstream_duration =
// dur_ms − wait, so admission waits add nothing to the in-flight count
// (Requirement 18.8 third bullet); Health_Probes count toward no criterion.
//
// ---------------------------------------------------------------------------
// Dependency on OmniRoute's busy-slot-skip signal (task 12.3)
// ---------------------------------------------------------------------------
// The Capacity_Leak detector (Requirement 18.1) consumes a structured busy-slot-
// skip signal that OmniRoute emits (design §"OmniRoute changes" item 4, task
// 12.3) and the observer copies into its own store. A busy-slot skip is a
// Managed_Instance's record that it advanced a request PAST a local target
// because no unreserved Slot remained for that target (Requirement 18.8 fourth
// bullet). OmniRoute emits one per `(connection, model)` skip in the dispatch
// path (`connectionConcurrencyGate` → `saturated` → skip-to-next). The shape the
// detector reads is `BusySlotSkip` below; task 12.3 MUST emit a signal that the
// copy projects onto this shape (instanceId, the skipped target's identity, and
// the skip's completion time). This file DEFINES that consumed shape; the
// emission + copy are task 12.3's responsibility.

import type { FleetInventory } from "@roo-code/types"

import type { Attribution } from "./attribution.js"
import type { StoredRow } from "./copy.js"

// ---------------------------------------------------------------------------
// Thresholds and constants (Requirement 18)
// ---------------------------------------------------------------------------

/** Capacity_Leak: two busy-slot skips more than 5 minutes apart (Requirement 18.1). */
export const CAPACITY_LEAK_SKIP_GAP_MS = 5 * 60 * 1000

/** Dead_Target: ten consecutive failed attempts (Requirement 18.2). */
export const DEAD_TARGET_CONSECUTIVE = 10

/** Dead_Target: a 24-hour all-failed span (Requirement 18.2). */
export const DEAD_TARGET_SPAN_MS = 24 * 60 * 60 * 1000

/** Cap overrun: in-flight above a bound continuously for more than 60 seconds (Requirement 18.3). */
export const CAP_OVERRUN_MIN_MS = 60 * 1000

/** Rank inversion: the trailing-7-day evaluation window (Requirement 18.4). */
export const RANK_INVERSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Rank inversion: at least 100 successful attempts in one input-size bucket (Requirement 18.4). */
export const RANK_INVERSION_MIN_SAMPLES = 100

/** Host_Preemption: at most 10 minutes between consecutive rejections in one interval (Requirement 18.5). */
export const PREEMPTION_MAX_GAP_MS = 10 * 60 * 1000

/** Route degradation: a 60-minute span (Requirement 18.6). */
export const ROUTE_DEGRADATION_SPAN_MS = 60 * 60 * 1000

/** Route degradation: at least 20 requests in the span (Requirement 18.6). */
export const ROUTE_DEGRADATION_MIN_REQUESTS = 20

/** Detection gap: raise once the unreadable span exceeds 15 minutes (Requirement 18.10). */
export const DETECTION_GAP_MIN_MS = 15 * 60 * 1000

/** HTTP statuses that are Capacity_Class_Rejections (429/503/409) (Requirement 16.4, findings §5.4). */
export const CAPACITY_REJECTION_STATUSES: ReadonlySet<number> = new Set([429, 503, 409])

/** HTTP 499 client disconnect, ignored when forming a Dead_Target run/span (Requirement 18.2). */
export const CLIENT_DISCONNECT_STATUS = 499

/**
 * The Preservation_Floors of the Gated_Routes, as final-success-rate percentages
 * (Requirement 20.1). Used as the default route-degradation floors before an
 * Arrangement evaluation has selected Gated_Routes (Requirement 18.6, which
 * defers to the Requirement 20 criterion 1 list "before such an evaluation
 * exists"). A caller may override per-route via `AnomalyInput.preservationFloors`.
 */
export const PRESERVATION_FLOORS: Readonly<Record<string, number>> = {
	"hybrid/code": 99.4,
	"hybrid/research": 99.1,
	"hybrid/fast": 99.7,
	"hybrid/reader": 99.4,
	"hybrid/planner": 96.6,
}

// ---------------------------------------------------------------------------
// The busy-slot-skip signal consumed by the Capacity_Leak detector (task 12.3)
// ---------------------------------------------------------------------------

/**
 * One structured busy-slot skip the observer copied from a Managed_Instance
 * (Requirement 18.1, 18.8 fourth bullet). It records that the instance advanced
 * a request past a LOCAL target because no unreserved Slot remained for that
 * target. The detector keys a Capacity_Leak on the skipped target's identity
 * (its Device and Model_Offering) and the connection the target reaches.
 *
 * Task 12.3 (OmniRoute busy-slot-skip emission) MUST emit a signal the copy can
 * project onto this shape: at minimum the instance, the skip's completion time,
 * and the identity of the skipped local target (its Target_Identifier, from
 * which the Device/Model_Offering are attributed, OR the `(connection, model)`
 * pair the saturated gate skipped). `targetId` is preferred because it resolves
 * through the same attribution path as attempts (Requirement 17.6); the
 * connection/model pair is the fallback the saturated gate already has.
 */
export interface BusySlotSkip {
	/** The Managed_Instance that recorded the skip. */
	readonly instanceId: string
	/** The skip's completion time, ISO-8601 UTC. */
	readonly ts: string
	/** The skipped local target's Target_Identifier, when the signal carries one. */
	readonly targetId?: string
	/** The OmniRoute connection of the skipped target (saturated-gate fallback). */
	readonly connectionId?: string
	/** The upstream model id of the skipped target (saturated-gate fallback). */
	readonly upstreamModelId?: string
}

// ---------------------------------------------------------------------------
// Expanded_Target_Sequence lookup (Requirement 10 criterion 3)
// ---------------------------------------------------------------------------

/**
 * The route memberships of one compiled target: the names of every Public_Route,
 * Route_Alias, Internal_Pool, and Diagnostic_Route whose Expanded_Target_Sequence
 * contains the target (Requirement 18.1, 18.2). The caller derives this from the
 * compiled Desired_Route_State (`compile/compiler.ts`); it is passed in so the
 * detector stays pure and independent of the compiler.
 */
export interface TargetRouteMemberships {
	/** Public_Routes whose Expanded_Target_Sequence contains the target. */
	readonly publicRoutes: readonly string[]
	/** Route_Aliases whose Expanded_Target_Sequence contains the target. */
	readonly routeAliases: readonly string[]
	/** Internal_Pools whose Expanded_Target_Sequence contains the target. */
	readonly internalPools: readonly string[]
	/** Diagnostic_Routes whose Expanded_Target_Sequence contains the target. */
	readonly diagnosticRoutes: readonly string[]
}

/**
 * Looks up the route memberships of a compiled target by its Model_Offering id
 * (local) or Cloud_Target id. Returns empty memberships when the target is in no
 * route. Supplied by the caller from the compiled Desired_Route_State.
 */
export type RouteMembershipLookup = (targetKey: TargetKey) => TargetRouteMemberships

/** A compiled target's stable key: a local Model_Offering id or a Cloud_Target id. */
export interface TargetKey {
	readonly instanceId: string
	readonly modelOfferingId: string | null
	readonly cloudTargetId: string | null
	readonly deviceId: string | null
}

// ---------------------------------------------------------------------------
// Anomaly alert shapes (Requirement 18.7 — the one entry per occurrence)
// ---------------------------------------------------------------------------

/** The six anomaly kinds plus the detection-gap kind (Requirement 18). */
export type AnomalyKind =
	| "capacity-leak"
	| "dead-target"
	| "cap-overrun"
	| "rank-inversion"
	| "host-preemption"
	| "route-degradation"
	| "detection-gap"

/**
 * The evidence summary carried by every alert (Requirement 18.7): the measured
 * values, the thresholds they were compared with, the attempt/request counts,
 * and the start and end of the span that met the condition.
 */
export interface AnomalyEvidence {
	readonly measured: Readonly<Record<string, number | string | null>>
	readonly thresholds: Readonly<Record<string, number | string>>
	readonly counts: Readonly<Record<string, number>>
	readonly spanStartMs: number | null
	readonly spanEndMs: number | null
}

/**
 * One anomaly occurrence (Requirement 18.8 "one alert or report per occurrence").
 * `names` and `values` carry every identifier and value the criterion requires;
 * `occurrenceKey` identifies the subject so the caller can suppress duplicates
 * for the life of the occurrence (Requirement 18.8 last bullet). `partial` marks
 * a report derived from data that includes an unreadable span (Requirement 18.10
 * second bullet).
 */
export interface Anomaly {
	readonly kind: AnomalyKind
	/** The subject identity that makes this occurrence unique (Requirement 18.8). */
	readonly occurrenceKey: string
	/** The detection time in epoch ms (Requirement 18.7). */
	readonly detectedAtMs: number
	/** Every identifier the criterion requires (Managed_Instance, target, routes, ...). */
	readonly names: Readonly<Record<string, string | readonly string[] | null>>
	/** Every value the criterion requires (counts, rates, times, bounds, ...). */
	readonly values: Readonly<Record<string, number | string | null>>
	readonly evidence: AnomalyEvidence
	/** True when the report was derived from data including an unreadable span (Requirement 18.10). */
	readonly partial: boolean
	/** The one-line human summary written to the Alert_Destination. */
	readonly summary: string
}

// ---------------------------------------------------------------------------
// Detector input (Requirement 18.8 — combine every declared instance)
// ---------------------------------------------------------------------------

/**
 * An unreadable span for one Managed_Instance (Requirement 18.10): the observer
 * could not read the attempt or busy-slot-skip records that the instance wrote
 * during `[fromMs, toMs)`. Supplied by the caller (the copy run knows which
 * reads failed).
 */
export interface UnreadableSpan {
	readonly instanceId: string
	readonly fromMs: number
	readonly toMs: number
}

/** The inputs the detectors need. */
export interface AnomalyInput {
	/** The observer's stored body-free rows, from every declared instance. */
	readonly rows: readonly StoredRow[]
	/** The busy-slot-skip records copied from every declared instance (task 12.3). */
	readonly busySlotSkips: readonly BusySlotSkip[]
	/** Attributes one stored row to its Device/Model_Offering/Cloud_Target/Public_Route. */
	readonly attribute: (row: StoredRow) => Attribution
	/** Attributes one busy-slot skip to its Device/Model_Offering (its target identity). */
	readonly attributeSkip: (skip: BusySlotSkip) => Attribution
	/** The Fleet_Inventory (Device slot ceilings, hostPreemption, Residency_Groups). */
	readonly inventory: FleetInventory
	/** The Expanded_Target_Sequence memberships of each compiled target. */
	readonly routeMemberships: RouteMembershipLookup
	/**
	 * The compiled concurrency bounds per subject (Requirement 18.3): a
	 * Model_Offering's slot count, a Device's Device_Slot_Ceiling, and an
	 * OmniRoute_Instance's Device_Allocation on a Device. Derived by the caller
	 * from the compiled Desired_Route_State / inventory.
	 */
	readonly concurrencyBounds: ConcurrencyBounds
	/**
	 * The final-success-rate Preservation_Floors by Public_Route, as percentages
	 * (Requirement 18.6, 20.1). Defaults to {@link PRESERVATION_FLOORS}.
	 */
	readonly preservationFloors?: Readonly<Record<string, number>>
	/**
	 * The longest request timeout each OmniRoute_Instance declares, in ms, used
	 * to decide when a span's records are "settled" (Requirement 18.8 fifth
	 * bullet). A span ending at T is settled at `nowMs` once `nowMs ≥ T +
	 * timeout`. Defaults to 0 (immediately settled) for an unlisted instance.
	 */
	readonly requestTimeoutsMs?: Readonly<Record<string, number>>
	/** The spans the observer could not read (Requirement 18.10). */
	readonly unreadableSpans?: readonly UnreadableSpan[]
	/** The request time in epoch ms. The detectors hold no clock. */
	readonly nowMs: number
}

/**
 * The compiled concurrency bounds for the cap-overrun detector (Requirement
 * 18.3). Each lookup returns the bound value, or `null` when no bound is
 * compiled for the subject.
 */
export interface ConcurrencyBounds {
	/** A Model_Offering's slot count (first bound). */
	readonly offeringSlots: (modelOfferingId: string) => number | null
	/** A Device's Device_Slot_Ceiling (second bound). */
	readonly deviceCeiling: (deviceId: string) => number | null
	/** One OmniRoute_Instance's Device_Allocation on a Device (third bound). */
	readonly instanceDeviceAllocation: (instanceId: string, deviceId: string) => number | null
}

// ---------------------------------------------------------------------------
// Internal working rows
// ---------------------------------------------------------------------------

/** One attributed attempt projected into the anomaly domain. */
interface Attempt {
	readonly instanceId: string
	readonly corr: string | null
	readonly completedAtMs: number
	/** In-flight start = completion − upstream_duration (Requirement 18.8 third bullet). */
	readonly inFlightStartMs: number
	readonly status: number | null
	readonly etype: string | null
	readonly ok: boolean
	readonly tin: number | null
	readonly latencyMs: number
	readonly attr: Attribution
	readonly isHealthProbe: boolean
}

/** Project one stored row to an attempt, dropping unparseable timestamps. */
function toAttempt(row: StoredRow, attr: Attribution): Attempt | null {
	const completedAtMs = Date.parse(row.fields.ts)
	if (Number.isNaN(completedAtMs)) {
		return null
	}
	const latencyMs = row.fields.dur_ms ?? 0
	const wait = row.fields.wait ?? 0
	// upstream_duration = dur_ms − wait; in flight over [end − upstream, end).
	const upstreamMs = Math.max(0, latencyMs - wait)
	const status = row.fields.status
	return {
		instanceId: row.instanceId,
		corr: row.fields.corr,
		completedAtMs,
		inFlightStartMs: completedAtMs - upstreamMs,
		status,
		etype: row.fields.etype,
		ok: isSuccess(status),
		tin: row.fields.tin,
		latencyMs,
		attr,
		isHealthProbe: row.isHealthProbe,
	}
}

/** An attempt succeeded when its HTTP status is 2xx (Requirement 16.9). */
function isSuccess(status: number | null): boolean {
	return status !== null && status >= 200 && status < 300
}

// ---------------------------------------------------------------------------
// detectAnomalies() — the entry point (Requirement 18.1-18.10)
// ---------------------------------------------------------------------------

/**
 * Run every Requirement 18 detector over the inputs and return one `Anomaly`
 * per occurrence (Requirement 18.8). Pure: the result is a function of the
 * inputs alone. The returned anomalies are not yet written; `writeAlerts` drives
 * the retrying write to the Alert_Destination (Requirement 18.7, 18.9).
 */
export function detectAnomalies(input: AnomalyInput): Anomaly[] {
	const attempts: Attempt[] = []
	for (const row of input.rows) {
		const a = toAttempt(row, input.attribute(row))
		if (a !== null && !a.isHealthProbe) {
			attempts.push(a)
		}
	}
	attempts.sort((x, y) => x.completedAtMs - y.completedAtMs)

	const floors = input.preservationFloors ?? PRESERVATION_FLOORS
	const timeouts = input.requestTimeoutsMs ?? {}
	const unreadable = input.unreadableSpans ?? []

	// An instance whose records in a span are unreadable blocks the record-
	// dependent detectors for that span (Requirement 18.10 first bullet).
	const blockedInstances = new Set(unreadable.map((s) => s.instanceId))
	const anyUnreadable = unreadable.length > 0

	const out: Anomaly[] = []
	out.push(...detectCapacityLeaks(input, attempts, blockedInstances, timeouts))
	out.push(...detectDeadTargets(input, attempts, blockedInstances))
	out.push(...detectCapOverruns(input, attempts, anyUnreadable))
	out.push(...detectRankInversions(input, attempts, anyUnreadable))
	out.push(...detectHostPreemptions(input, attempts, anyUnreadable))
	out.push(...detectRouteDegradations(input, attempts, floors, blockedInstances, timeouts))
	out.push(...detectDetectionGaps(input, unreadable))
	return out
}

// ---------------------------------------------------------------------------
// 18.1 — Capacity_Leak
// ---------------------------------------------------------------------------

/**
 * Two busy-slot skips of one local target more than 5 minutes apart, with NO
 * attempt the instance dispatched to the target's Device or connection in flight
 * at any instant from the earlier skip through the later skip (Requirement 18.1).
 * That is exactly the live 4070 fault: the card is skipped as "busy" while
 * nothing is actually running on it.
 */
function detectCapacityLeaks(
	input: AnomalyInput,
	attempts: readonly Attempt[],
	blockedInstances: ReadonlySet<string>,
	timeouts: Readonly<Record<string, number>>,
): Anomaly[] {
	// Group skips by (instance, device) — the target's Device is the subject.
	const skipsByDevice = new Map<string, Array<{ ts: number; deviceId: string; offeringId: string | null }>>()
	for (const skip of input.busySlotSkips) {
		if (blockedInstances.has(skip.instanceId)) {
			continue // Requirement 18.10: skip records in that span are unreadable.
		}
		const tsMs = Date.parse(skip.ts)
		if (Number.isNaN(tsMs)) {
			continue
		}
		const attr = input.attributeSkip(skip)
		const deviceId = typeof attr.deviceId === "string" ? attr.deviceId : null
		if (deviceId === null) {
			continue // Only a local target (a Slot) can be busy-slot-skipped.
		}
		const offeringId = typeof attr.modelOfferingId === "string" ? attr.modelOfferingId : null
		const key = `${skip.instanceId}\u0000${deviceId}`
		pushTo(skipsByDevice, key, { ts: tsMs, deviceId, offeringId })
	}

	const out: Anomaly[] = []
	for (const [key, skips] of skipsByDevice) {
		const [instanceId, deviceId] = key.split("\u0000") as [string, string]
		skips.sort((a, b) => a.ts - b.ts)
		// Device attempts for the in-flight check, by this instance on this Device.
		const deviceAttempts = attempts.filter(
			(a) => a.instanceId === instanceId && a.attr.deviceId === deviceId,
		)
		// Find the FIRST qualifying pair (earlier, later) >5 min apart with no
		// in-flight attempt between/at them. The occurrence lasts until the
		// instance next dispatches to the target, so one alert per such run.
		const found = firstCapacityLeakPair(skips, deviceAttempts)
		if (found === null) {
			continue
		}
		const { earlierIdx, laterIdx } = found
		const earlier = skips[earlierIdx]!
		const later = skips[laterIdx]!
		// Settled check (Requirement 18.8 fifth bullet): the span's records are
		// settled once the instance's longest request timeout has elapsed past
		// the later skip; the alert fires within 5 min after that.
		const timeout = timeouts[instanceId] ?? 0
		if (input.nowMs < later.ts + timeout) {
			continue
		}

		const offeringId = earlier.offeringId ?? later.offeringId
		const memberships = input.routeMemberships({
			instanceId,
			modelOfferingId: offeringId,
			cloudTargetId: null,
			deviceId,
		})
		// The completion time of the last attempt on the Device before the earlier
		// skip, or the fact that there is none (Requirement 18.1 third bullet).
		const lastBefore = lastDeviceCompletionBefore(deviceAttempts, earlier.ts)
		// Count skips from the earlier skip until the alert is raised.
		const skipCount = skips.filter((s) => s.ts >= earlier.ts).length

		const names: Record<string, string | readonly string[] | null> = {
			managedInstance: instanceId,
			target: offeringId ?? deviceId,
			modelOffering: offeringId,
			device: deviceId,
			publicRoutes: memberships.publicRoutes,
		}
		const values: Record<string, number | string | null> = {
			lastDeviceAttemptCompletedAtMs: lastBefore,
			lastDeviceAttemptNoneReadable: lastBefore === null ? "none" : null,
			busySlotSkipCount: skipCount,
			earlierSkipMs: earlier.ts,
			laterSkipMs: later.ts,
		}
		out.push({
			kind: "capacity-leak",
			occurrenceKey: `capacity-leak\u0000${instanceId}\u0000${offeringId ?? deviceId}`,
			detectedAtMs: input.nowMs,
			names,
			values,
			evidence: {
				measured: { skipGapMs: later.ts - earlier.ts, inFlightDuringSpan: 0 },
				thresholds: { skipGapMs: CAPACITY_LEAK_SKIP_GAP_MS },
				counts: { busySlotSkips: skipCount },
				spanStartMs: earlier.ts,
				spanEndMs: later.ts,
			},
			partial: false,
			summary:
				`Capacity_Leak: ${instanceId} skipped ${offeringId ?? deviceId} on ${deviceId} ` +
				`${skipCount} times with nothing in flight (${Math.round((later.ts - earlier.ts) / 60000)} min span)`,
		})
	}
	return out
}

/**
 * The first pair of skips >5 min apart such that no device attempt was in flight
 * at any instant from the earlier skip through the later skip. In flight is the
 * completion-anchored interval [inFlightStart, completed) (Requirement 18.8).
 * "Through" is inclusive of both endpoints, so an attempt whose interval touches
 * either skip time disqualifies the pair.
 */
function firstCapacityLeakPair(
	skips: ReadonlyArray<{ ts: number }>,
	deviceAttempts: readonly Attempt[],
): { earlierIdx: number; laterIdx: number } | null {
	for (let i = 0; i < skips.length; i++) {
		for (let j = i + 1; j < skips.length; j++) {
			const earlier = skips[i]!.ts
			const later = skips[j]!.ts
			if (later - earlier <= CAPACITY_LEAK_SKIP_GAP_MS) {
				continue
			}
			if (!anyInFlightInClosedSpan(deviceAttempts, earlier, later)) {
				return { earlierIdx: i, laterIdx: j }
			}
		}
	}
	return null
}

/**
 * True when some attempt was in flight at any instant in the CLOSED span
 * [spanStart, spanEnd]. An attempt's in-flight interval is [inFlightStart,
 * completed); it overlaps the closed span when inFlightStart ≤ spanEnd and
 * completed > spanStart (so an interval that ends exactly at spanStart does not
 * count, matching the half-open in-flight convention, while one that touches
 * the interior does).
 */
function anyInFlightInClosedSpan(attempts: readonly Attempt[], spanStart: number, spanEnd: number): boolean {
	return attempts.some((a) => a.inFlightStartMs <= spanEnd && a.completedAtMs > spanStart)
}

/** The completion time of the last device attempt strictly before `beforeMs`, or null. */
function lastDeviceCompletionBefore(attempts: readonly Attempt[], beforeMs: number): number | null {
	let last: number | null = null
	for (const a of attempts) {
		if (a.completedAtMs < beforeMs && (last === null || a.completedAtMs > last)) {
			last = a.completedAtMs
		}
	}
	return last
}

// ---------------------------------------------------------------------------
// 18.2 — Dead_Target
// ---------------------------------------------------------------------------

/**
 * A compiled target whose attempts, ordered by completion time, meet the
 * Dead_Target condition: either 10 consecutive FAILED attempts, or a 24-hour span
 * in which it had ≥1 attempt and every attempt failed (Requirement 18.2).
 * Capacity_Class_Rejections (429/503/409) and HTTP 499 client disconnects are
 * IGNORED when forming a run or span, so a ComfyUI preemption burst is not
 * misread as a dead target (Requirement 18.2, 19.7).
 */
function detectDeadTargets(
	input: AnomalyInput,
	attempts: readonly Attempt[],
	blockedInstances: ReadonlySet<string>,
): Anomaly[] {
	const byTarget = new Map<string, Attempt[]>()
	for (const a of attempts) {
		if (blockedInstances.has(a.instanceId)) {
			continue // Requirement 18.10 first bullet.
		}
		const targetKey = deadTargetKey(a)
		if (targetKey === null) {
			continue
		}
		pushTo(byTarget, targetKey, a)
	}

	const out: Anomaly[] = []
	for (const [key, group] of byTarget) {
		group.sort((x, y) => x.completedAtMs - y.completedAtMs)
		// Ignore capacity rejections and 499 when forming a run or span.
		const considered = group.filter((a) => !isIgnoredForDeadTarget(a))
		if (considered.length === 0) {
			continue
		}

		const run = firstConsecutiveFailRun(considered)
		const span = allFailed24hSpan(considered)
		const hit = run ?? span
		if (hit === null) {
			continue
		}

		const failed = hit.attempts
		const first = failed[0]!
		const names: Record<string, string | readonly string[] | null> = {
			managedInstance: first.instanceId,
			target: deadTargetLabel(first),
			modelOffering: typeof first.attr.modelOfferingId === "string" ? first.attr.modelOfferingId : null,
			device: typeof first.attr.deviceId === "string" ? first.attr.deviceId : null,
			cloudTarget: typeof first.attr.cloudTargetId === "string" ? first.attr.cloudTargetId : null,
			...routeNameFields(input, first),
		}
		const byStatus = countByStatus(failed)
		const byType = countByErrorType(failed)
		out.push({
			kind: "dead-target",
			occurrenceKey: `dead-target\u0000${key}`,
			detectedAtMs: input.nowMs,
			names,
			values: {
				reason: hit.kind,
				failedAttempts: failed.length,
				failuresByStatus: formatCounts(byStatus),
				failuresByErrorType: formatCounts(byType),
			},
			evidence: {
				measured: { reason: hit.kind },
				thresholds: {
					consecutive: DEAD_TARGET_CONSECUTIVE,
					spanMs: DEAD_TARGET_SPAN_MS,
				},
				counts: { failedAttempts: failed.length },
				spanStartMs: failed[0]!.completedAtMs,
				spanEndMs: failed[failed.length - 1]!.completedAtMs,
			},
			partial: false,
			summary:
				`Dead_Target: ${first.instanceId} ${deadTargetLabel(first)} ${failed.length} failed ` +
				`attempts (${hit.kind}), by status ${formatCounts(byStatus)}`,
		})
	}
	return out
}

/** A target's stable key for Dead_Target grouping: offering or cloud target, per instance. */
function deadTargetKey(a: Attempt): string | null {
	const offering = typeof a.attr.modelOfferingId === "string" ? a.attr.modelOfferingId : null
	const cloud = typeof a.attr.cloudTargetId === "string" ? a.attr.cloudTargetId : null
	if (offering === null && cloud === null) {
		return null
	}
	return `${a.instanceId}\u0000${offering ?? ""}\u0000${cloud ?? ""}`
}

function deadTargetLabel(a: Attempt): string {
	if (typeof a.attr.modelOfferingId === "string") {
		return a.attr.modelOfferingId
	}
	if (typeof a.attr.cloudTargetId === "string") {
		return a.attr.cloudTargetId
	}
	return "unknown"
}

/** An attempt ignored when forming a Dead_Target run/span (Requirement 18.2). */
function isIgnoredForDeadTarget(a: Attempt): boolean {
	if (a.status === CLIENT_DISCONNECT_STATUS) {
		return true
	}
	return a.status !== null && CAPACITY_REJECTION_STATUSES.has(a.status)
}

interface DeadTargetHit {
	readonly kind: "ten-consecutive" | "twenty-four-hour-span"
	readonly attempts: readonly Attempt[]
}

/**
 * The first run of ≥10 consecutive failed attempts in the considered sequence
 * (ordered by completion time). A single success resets the run (Requirement
 * 18.2 "10 consecutive failed attempts").
 */
function firstConsecutiveFailRun(considered: readonly Attempt[]): DeadTargetHit | null {
	let run: Attempt[] = []
	for (const a of considered) {
		if (a.ok) {
			run = []
			continue
		}
		run.push(a)
		if (run.length >= DEAD_TARGET_CONSECUTIVE) {
			return { kind: "ten-consecutive", attempts: run.slice() }
		}
	}
	return null
}

/**
 * A 24-hour span across which the target stayed compiled, had ≥1 considered
 * attempt, and every considered attempt failed (Requirement 18.2). Modeled as:
 * every considered attempt failed AND the first-to-last span is at least 24 h.
 * (The target staying compiled across the span is the caller's invariant — only
 * attempts to a compiled target are attributed to it.)
 */
function allFailed24hSpan(considered: readonly Attempt[]): DeadTargetHit | null {
	if (considered.some((a) => a.ok)) {
		return null
	}
	const first = considered[0]!
	const last = considered[considered.length - 1]!
	if (last.completedAtMs - first.completedAtMs < DEAD_TARGET_SPAN_MS) {
		return null
	}
	return { kind: "twenty-four-hour-span", attempts: considered }
}

// ---------------------------------------------------------------------------
// 18.3 — cap overrun
// ---------------------------------------------------------------------------

/**
 * In-flight attempts exceeding a compiled concurrency bound continuously for more
 * than 60 seconds (Requirement 18.3), for three bounds: every instance's
 * attempts on one Model_Offering vs the Model_Offering's slot count; every
 * instance's attempts on one Device vs the Device_Slot_Ceiling; and one
 * instance's attempts on one Device vs that instance's Device_Allocation.
 */
function detectCapOverruns(input: AnomalyInput, attempts: readonly Attempt[], anyUnreadable: boolean): Anomaly[] {
	const out: Anomaly[] = []

	// First bound: per Model_Offering, pooled across every instance.
	const byOffering = groupBy(attempts, (a) =>
		typeof a.attr.modelOfferingId === "string" ? a.attr.modelOfferingId : "",
	)
	for (const [offeringId, group] of byOffering) {
		if (offeringId === "") {
			continue
		}
		const bound = input.concurrencyBounds.offeringSlots(offeringId)
		if (bound === null) {
			continue
		}
		const overrun = findOverrun(group, bound)
		if (overrun !== null) {
			out.push(
				capOverrunAnomaly(input, "model-offering", offeringId, bound, overrun, group, anyUnreadable),
			)
		}
	}

	// Second bound: per Device, pooled across every instance.
	const byDevice = groupBy(attempts, (a) => (typeof a.attr.deviceId === "string" ? a.attr.deviceId : ""))
	for (const [deviceId, group] of byDevice) {
		if (deviceId === "") {
			continue
		}
		const bound = input.concurrencyBounds.deviceCeiling(deviceId)
		if (bound === null) {
			continue
		}
		const overrun = findOverrun(group, bound)
		if (overrun !== null) {
			out.push(capOverrunAnomaly(input, "device", deviceId, bound, overrun, group, anyUnreadable))
		}
	}

	// Third bound: per (instance, Device).
	const byInstanceDevice = groupBy(attempts, (a) =>
		typeof a.attr.deviceId === "string" ? `${a.instanceId}\u0000${a.attr.deviceId}` : "",
	)
	for (const [key, group] of byInstanceDevice) {
		if (key === "") {
			continue
		}
		const [instanceId, deviceId] = key.split("\u0000") as [string, string]
		const bound = input.concurrencyBounds.instanceDeviceAllocation(instanceId, deviceId)
		if (bound === null) {
			continue
		}
		const overrun = findOverrun(group, bound)
		if (overrun !== null) {
			out.push(
				capOverrunAnomaly(
					input,
					"instance-device",
					`${instanceId}/${deviceId}`,
					bound,
					overrun,
					group,
					anyUnreadable,
					instanceId,
				),
			)
		}
	}

	return out
}

interface OverrunSpan {
	readonly startMs: number
	readonly endMs: number
	readonly peak: number
}

/**
 * The first span in which in-flight count stays strictly above `bound`
 * continuously for more than 60 seconds (Requirement 18.3). In-flight uses the
 * completion-anchored interval [inFlightStart, completed). Returns the span's
 * start, end, and peak in-flight count, or null.
 */
function findOverrun(attempts: readonly Attempt[], bound: number): OverrunSpan | null {
	type Event = { t: number; delta: number }
	const events: Event[] = []
	for (const a of attempts) {
		if (a.completedAtMs <= a.inFlightStartMs) {
			continue
		}
		events.push({ t: a.inFlightStartMs, delta: 1 }, { t: a.completedAtMs, delta: -1 })
	}
	// Ends before starts at equal times (half-open [start, end)).
	events.sort((x, y) => (x.t === y.t ? x.delta - y.delta : x.t - y.t))

	let k = 0
	let overStart: number | null = null
	let peak = 0
	let prevT = events.length > 0 ? events[0]!.t : 0
	for (const ev of events) {
		// Before applying the event, the level `k` has held over [prevT, ev.t).
		if (overStart !== null && ev.t - overStart > CAP_OVERRUN_MIN_MS && k > bound) {
			// Still above the bound and the above-bound span already exceeds 60 s.
			return { startMs: overStart, endMs: ev.t, peak }
		}
		k += ev.delta
		if (k > bound) {
			if (overStart === null) {
				overStart = ev.t
			}
			peak = Math.max(peak, k)
		} else {
			// Dropped to/below the bound: close any open above-bound span.
			if (overStart !== null && prevT - overStart > CAP_OVERRUN_MIN_MS) {
				return { startMs: overStart, endMs: prevT, peak }
			}
			overStart = null
			peak = 0
		}
		prevT = ev.t
	}
	return null
}

function capOverrunAnomaly(
	input: AnomalyInput,
	boundKind: "model-offering" | "device" | "instance-device",
	subjectId: string,
	bound: number,
	overrun: OverrunSpan,
	group: readonly Attempt[],
	anyUnreadable: boolean,
	instanceId?: string,
): Anomaly {
	const peakByInstance = peakInFlightByInstance(group, overrun.startMs, overrun.endMs)
	return {
		kind: "cap-overrun",
		occurrenceKey: `cap-overrun\u0000${boundKind}\u0000${subjectId}`,
		detectedAtMs: input.nowMs,
		names: {
			bound: boundKind,
			subject: subjectId,
			omniRouteInstance: instanceId ?? null,
		},
		values: {
			boundValue: bound,
			overrunStartMs: overrun.startMs,
			peakInFlight: overrun.peak,
			timeAboveBoundMs: overrun.endMs - overrun.startMs,
			peakInFlightByInstance: formatCounts(peakByInstance),
		},
		evidence: {
			measured: { peakInFlight: overrun.peak, timeAboveBoundMs: overrun.endMs - overrun.startMs },
			thresholds: { bound, minMsAboveBound: CAP_OVERRUN_MIN_MS },
			counts: { attempts: group.length },
			spanStartMs: overrun.startMs,
			spanEndMs: overrun.endMs,
		},
		partial: anyUnreadable,
		summary:
			`cap-overrun: ${boundKind} ${subjectId} peaked at ${overrun.peak} in flight vs bound ${bound} ` +
			`for ${Math.round((overrun.endMs - overrun.startMs) / 1000)} s`,
	}
}

/** The peak in-flight count per instance during the overrun span. */
function peakInFlightByInstance(
	attempts: readonly Attempt[],
	spanStart: number,
	spanEnd: number,
): Map<string, number> {
	const byInstance = groupBy(attempts, (a) => a.instanceId)
	const out = new Map<string, number>()
	for (const [instanceId, group] of byInstance) {
		let peak = 0
		type Event = { t: number; delta: number }
		const events: Event[] = []
		for (const a of group) {
			const s = Math.max(a.inFlightStartMs, spanStart)
			const e = Math.min(a.completedAtMs, spanEnd)
			if (e <= s) {
				continue
			}
			events.push({ t: s, delta: 1 }, { t: e, delta: -1 })
		}
		events.sort((x, y) => (x.t === y.t ? x.delta - y.delta : x.t - y.t))
		let k = 0
		for (const ev of events) {
			k += ev.delta
			peak = Math.max(peak, k)
		}
		out.set(instanceId, peak)
	}
	return out
}

// ---------------------------------------------------------------------------
// 18.4 — rank inversion
// ---------------------------------------------------------------------------

/**
 * Within one input-size bucket over the trailing 7 days, a Model_Offering with a
 * strictly LOWER (better) best-Slot Performance_Rank that nonetheless shows a
 * strictly HIGHER end-to-end latency p50 than another Model_Offering, where each
 * has ≥100 successful attempts in that bucket and both are eligible for a common
 * Lane (Requirement 18.4). The best-Slot Performance_Rank is the lowest rank
 * value among an offering's Slots.
 */
function detectRankInversions(input: AnomalyInput, attempts: readonly Attempt[], anyUnreadable: boolean): Anomaly[] {
	const windowStart = input.nowMs - RANK_INVERSION_WINDOW_MS
	const windowed = attempts.filter((a) => a.completedAtMs >= windowStart && a.completedAtMs < input.nowMs)

	// Best-Slot Performance_Rank of each offering (lowest rank value).
	const bestRank = new Map<string, number>()
	const offeringTags = new Map<string, ReadonlySet<string>>()
	for (const o of input.inventory.offerings) {
		bestRank.set(o.id, Math.min(...o.ranks))
		offeringTags.set(o.id, new Set(o.tags))
	}

	// Lane eligibility: an offering is eligible for a lane when it carries every
	// required capability tag of the lane (Requirement 6 criterion 9, capability
	// match). We only need "share at least one common lane", so compute the set
	// of lane ids each offering is eligible for.
	const lanesOf = (offeringId: string): Set<string> => {
		const tags = offeringTags.get(offeringId) ?? new Set<string>()
		const result = new Set<string>()
		for (const lane of input.inventory.lanes) {
			if (lane.capabilities.every((c) => tags.has(c))) {
				result.add(lane.id)
			}
		}
		return result
	}

	// p50 latency (seconds) per (offering, bucket) over successful attempts.
	interface BucketStat {
		readonly offeringId: string
		readonly p50Sec: number
		readonly samples: number
	}
	const byBucket = new Map<string, BucketStat[]>()
	const successByOfferingBucket = new Map<string, number[]>()
	for (const a of windowed) {
		if (!a.ok || typeof a.attr.modelOfferingId !== "string") {
			continue
		}
		const bucket = bucketOf(a.tin)
		if (bucket === null) {
			continue
		}
		pushTo(successByOfferingBucket, `${a.attr.modelOfferingId}\u0000${bucket}`, a.latencyMs / 1000)
	}
	for (const [key, latencies] of successByOfferingBucket) {
		if (latencies.length < RANK_INVERSION_MIN_SAMPLES) {
			continue
		}
		const [offeringId, bucket] = key.split("\u0000") as [string, string]
		const p50 = nearestRank(latencies, 50)
		if (p50 === null) {
			continue
		}
		pushTo(byBucket, bucket, { offeringId, p50Sec: p50, samples: latencies.length })
	}

	const out: Anomaly[] = []
	for (const [bucket, stats] of byBucket) {
		for (let i = 0; i < stats.length; i++) {
			for (let j = 0; j < stats.length; j++) {
				if (i === j) {
					continue
				}
				const better = stats[i]!
				const worse = stats[j]!
				const betterRank = bestRank.get(better.offeringId)
				const worseRank = bestRank.get(worse.offeringId)
				if (betterRank === undefined || worseRank === undefined) {
					continue
				}
				// `better` has the strictly LOWER rank value but the strictly HIGHER p50.
				if (betterRank >= worseRank || better.p50Sec <= worse.p50Sec) {
					continue
				}
				// Must share at least one common eligible lane.
				const commonLanes = [...lanesOf(better.offeringId)].filter((l) =>
					lanesOf(worse.offeringId).has(l),
				)
				if (commonLanes.length === 0) {
					continue
				}
				out.push({
					kind: "rank-inversion",
					occurrenceKey: `rank-inversion\u0000${bucket}\u0000${better.offeringId}\u0000${worse.offeringId}`,
					detectedAtMs: input.nowMs,
					names: {
						inputBucket: bucket,
						lanes: commonLanes,
						betterRankOffering: better.offeringId,
						worseRankOffering: worse.offeringId,
					},
					values: {
						betterRankValue: betterRank,
						betterRankP50Sec: better.p50Sec,
						betterRankSamples: better.samples,
						worseRankValue: worseRank,
						worseRankP50Sec: worse.p50Sec,
						worseRankSamples: worse.samples,
					},
					evidence: {
						measured: { betterRankP50Sec: better.p50Sec, worseRankP50Sec: worse.p50Sec },
						thresholds: { minSamples: RANK_INVERSION_MIN_SAMPLES },
						counts: {
							betterRankSamples: better.samples,
							worseRankSamples: worse.samples,
						},
						spanStartMs: windowStart,
						spanEndMs: input.nowMs,
					},
					partial: anyUnreadable,
					summary:
						`rank-inversion [${bucket}]: ${better.offeringId} (rank ${betterRank}, p50 ` +
						`${better.p50Sec.toFixed(1)}s) slower than ${worse.offeringId} (rank ${worseRank}, p50 ${worse.p50Sec.toFixed(1)}s)`,
				})
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 18.5 — Host_Preemption interval
// ---------------------------------------------------------------------------

/**
 * On a Device the inventory marks hostPreemption=true, a preemption interval:
 * a maximal series of attempts the Device answered with a Capacity_Class_
 * Rejection, ordered by completion time, ≤10 min between consecutive
 * completions, with no successful attempt on the Device completing between them
 * (Requirement 18.5). The interval closes when a successful attempt on the Device
 * completes after its last rejection, or 10 minutes after its last rejection.
 */
function detectHostPreemptions(input: AnomalyInput, attempts: readonly Attempt[], anyUnreadable: boolean): Anomaly[] {
	const preemptible = new Set(input.inventory.devices.filter((d) => d.hostPreemption).map((d) => d.id))
	if (preemptible.size === 0) {
		return []
	}

	const out: Anomaly[] = []
	const byDevice = groupBy(
		attempts.filter((a) => typeof a.attr.deviceId === "string" && preemptible.has(a.attr.deviceId)),
		(a) => a.attr.deviceId as string,
	)

	for (const [deviceId, group] of byDevice) {
		const sorted = group.slice().sort((x, y) => x.completedAtMs - y.completedAtMs)
		const intervals = preemptionIntervals(sorted)
		for (const interval of intervals) {
			// Only closed intervals are reported (Requirement 18.5 "when ... closes").
			if (!interval.closed) {
				continue
			}
			// Report within 5 min after it closes; it has closed only if nowMs is
			// past the close time.
			if (input.nowMs < interval.closedAtMs) {
				continue
			}
			out.push({
				kind: "host-preemption",
				occurrenceKey: `host-preemption\u0000${deviceId}\u0000${interval.startMs}`,
				detectedAtMs: input.nowMs,
				names: {
					device: deviceId,
					rejectionsByInstance: formatCounts(interval.byInstance),
					rejectionsByPublicRoute: formatCounts(interval.byRoute),
				},
				values: {
					intervalStartMs: interval.startMs,
					intervalEndMs: interval.endMs,
					rejectedAttempts: interval.rejections,
					rejectedWithoutRoute: interval.noRoute,
				},
				evidence: {
					measured: { rejectedAttempts: interval.rejections },
					thresholds: { maxGapMs: PREEMPTION_MAX_GAP_MS },
					counts: { rejections: interval.rejections },
					spanStartMs: interval.startMs,
					spanEndMs: interval.endMs,
				},
				partial: anyUnreadable,
				summary:
					`Host_Preemption: ${deviceId} ${interval.rejections} capacity rejections over ` +
					`${Math.round((interval.endMs - interval.startMs) / 60000)} min`,
			})
		}
	}
	return out
}

interface PreemptionInterval {
	readonly startMs: number
	readonly endMs: number
	readonly rejections: number
	readonly noRoute: number
	readonly byInstance: Map<string, number>
	readonly byRoute: Map<string, number>
	readonly closed: boolean
	readonly closedAtMs: number
}

/**
 * The preemption intervals in a device's attempts, ordered by completion time
 * (Requirement 18.5). A rejection is a Capacity_Class_Rejection; a success
 * closes an open interval; a gap > 10 min between rejections also closes it.
 */
function preemptionIntervals(sorted: readonly Attempt[]): PreemptionInterval[] {
	const out: PreemptionInterval[] = []
	let cur:
		| {
				startMs: number
				lastRejectionMs: number
				rejections: number
				noRoute: number
				byInstance: Map<string, number>
				byRoute: Map<string, number>
		  }
		| null = null

	const close = (closedAtMs: number, closed: boolean): void => {
		if (cur === null) {
			return
		}
		out.push({
			startMs: cur.startMs,
			endMs: cur.lastRejectionMs,
			rejections: cur.rejections,
			noRoute: cur.noRoute,
			byInstance: cur.byInstance,
			byRoute: cur.byRoute,
			closed,
			closedAtMs,
		})
		cur = null
	}

	for (const a of sorted) {
		const isRejection = a.status !== null && CAPACITY_REJECTION_STATUSES.has(a.status)
		if (isRejection) {
			if (cur !== null && a.completedAtMs - cur.lastRejectionMs > PREEMPTION_MAX_GAP_MS) {
				// The gap closed the previous interval 10 min after its last rejection.
				close(cur.lastRejectionMs + PREEMPTION_MAX_GAP_MS, true)
			}
			if (cur === null) {
				cur = {
					startMs: a.completedAtMs,
					lastRejectionMs: a.completedAtMs,
					rejections: 0,
					noRoute: 0,
					byInstance: new Map(),
					byRoute: new Map(),
				}
			}
			cur.lastRejectionMs = a.completedAtMs
			cur.rejections++
			cur.byInstance.set(a.instanceId, (cur.byInstance.get(a.instanceId) ?? 0) + 1)
			const route = a.attr.publicRoute
			if (route === null) {
				cur.noRoute++
			} else {
				cur.byRoute.set(route, (cur.byRoute.get(route) ?? 0) + 1)
			}
			continue
		}
		if (a.ok && cur !== null) {
			// A successful attempt on the Device closes the interval at its completion.
			close(a.completedAtMs, true)
		}
	}
	// A trailing open interval closes 10 min after its last rejection.
	if (cur !== null) {
		const lastRejectionMs = cur.lastRejectionMs
		close(lastRejectionMs + PREEMPTION_MAX_GAP_MS, true)
	}
	return out
}

// ---------------------------------------------------------------------------
// 18.6 — route degradation vs the Preservation_Floor
// ---------------------------------------------------------------------------

/**
 * On the primary OmniRoute_Instance, a 60-minute span of ≥20 requests naming a
 * Gated_Route whose final success rate is below the route's Preservation_Floor
 * (Requirement 18.6). A request = attempts sharing one correlation id; its final
 * attempt is the latest completion; the route is the route its final attempt
 * names; success is a 2xx final attempt (Requirement 16.3, 16.9).
 */
function detectRouteDegradations(
	input: AnomalyInput,
	attempts: readonly Attempt[],
	floors: Readonly<Record<string, number>>,
	blockedInstances: ReadonlySet<string>,
	timeouts: Readonly<Record<string, number>>,
): Anomaly[] {
	const primary = input.inventory.instances.find((i) => i.role === "primary")
	if (primary === undefined || blockedInstances.has(primary.id)) {
		return []
	}
	const primaryId = primary.id

	// Build requests on the primary instance, keyed by correlation id.
	interface Request {
		readonly route: string
		readonly finalMs: number
		readonly ok: boolean
		readonly finalStatus: number | null
	}
	const byCorr = new Map<string, Attempt[]>()
	for (const a of attempts) {
		if (a.instanceId !== primaryId || a.corr === null || a.attr.publicRoute === null) {
			continue
		}
		pushTo(byCorr, a.corr, a)
	}
	const requestsByRoute = new Map<string, Request[]>()
	for (const [, group] of byCorr) {
		const sorted = group.slice().sort((x, y) => x.completedAtMs - y.completedAtMs)
		const final = sorted[sorted.length - 1]!
		if (final.attr.publicRoute === null) {
			continue
		}
		pushTo(requestsByRoute, final.attr.publicRoute, {
			route: final.attr.publicRoute,
			finalMs: final.completedAtMs,
			ok: final.ok,
			finalStatus: final.status,
		})
	}

	const timeout = timeouts[primaryId] ?? 0
	const out: Anomaly[] = []
	for (const [route, requests] of requestsByRoute) {
		const floor = floors[route]
		if (floor === undefined) {
			continue // Not a Gated_Route with a floor.
		}
		requests.sort((a, b) => a.finalMs - b.finalMs)
		// Find the first 60-min span (anchored at a request's final time) with
		// ≥20 requests and final success rate below the floor.
		const span = firstDegradedSpan(requests, floor)
		if (span === null) {
			continue
		}
		// Settled check (Requirement 18.8 fifth bullet).
		if (input.nowMs < span.endMs + timeout) {
			continue
		}
		out.push({
			kind: "route-degradation",
			occurrenceKey: `route-degradation\u0000${primaryId}\u0000${route}`,
			detectedAtMs: input.nowMs,
			names: {
				gatedRoute: route,
				failuresByFinalStatus: formatCounts(span.failuresByStatus),
			},
			values: {
				floor,
				spanStartMs: span.startMs,
				spanEndMs: span.endMs,
				requestCount: span.total,
				finalSuccessRate: span.successRate,
			},
			evidence: {
				measured: { finalSuccessRate: span.successRate },
				thresholds: { floor, minRequests: ROUTE_DEGRADATION_MIN_REQUESTS },
				counts: { requests: span.total, failed: span.failed },
				spanStartMs: span.startMs,
				spanEndMs: span.endMs,
			},
			partial: false,
			summary:
				`route-degradation: ${route} final success ${span.successRate.toFixed(1)}% below floor ` +
				`${floor}% over ${span.total} requests`,
		})
	}
	return out
}

interface DegradedSpan {
	readonly startMs: number
	readonly endMs: number
	readonly total: number
	readonly failed: number
	readonly successRate: number
	readonly failuresByStatus: Map<string, number>
}

/**
 * The first 60-minute span, anchored at each request's final completion time,
 * that holds ≥20 requests whose final success rate is below the floor
 * (Requirement 18.6). Requests are ordered by final completion time.
 */
function firstDegradedSpan(
	requests: ReadonlyArray<{ finalMs: number; ok: boolean; finalStatus: number | null }>,
	floor: number,
): DegradedSpan | null {
	for (let i = 0; i < requests.length; i++) {
		const start = requests[i]!.finalMs
		const end = start + ROUTE_DEGRADATION_SPAN_MS
		const inSpan = requests.filter((r) => r.finalMs >= start && r.finalMs < end)
		if (inSpan.length < ROUTE_DEGRADATION_MIN_REQUESTS) {
			continue
		}
		const successes = inSpan.filter((r) => r.ok).length
		const successRate = (100 * successes) / inSpan.length
		if (successRate >= floor) {
			continue
		}
		const failuresByStatus = new Map<string, number>()
		for (const r of inSpan) {
			if (!r.ok) {
				const key = r.finalStatus === null ? "null" : String(r.finalStatus)
				failuresByStatus.set(key, (failuresByStatus.get(key) ?? 0) + 1)
			}
		}
		return {
			startMs: start,
			endMs: inSpan[inSpan.length - 1]!.finalMs,
			total: inSpan.length,
			failed: inSpan.length - successes,
			successRate,
			failuresByStatus,
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// 18.10 — detection-gap alert
// ---------------------------------------------------------------------------

/**
 * Raise a detection-gap alert once an unreadable span exceeds 15 minutes
 * (Requirement 18.10 third bullet), naming the Managed_Instance, the span's
 * start, and the criteria whose evaluation it affects.
 */
function detectDetectionGaps(input: AnomalyInput, unreadable: readonly UnreadableSpan[]): Anomaly[] {
	const out: Anomaly[] = []
	for (const span of unreadable) {
		if (span.toMs - span.fromMs <= DETECTION_GAP_MIN_MS) {
			continue
		}
		out.push({
			kind: "detection-gap",
			occurrenceKey: `detection-gap\u0000${span.instanceId}\u0000${span.fromMs}`,
			detectedAtMs: input.nowMs,
			names: {
				managedInstance: span.instanceId,
				affectedCriteria: ["18.1 Capacity_Leak", "18.2 Dead_Target", "18.6 route-degradation"],
			},
			values: {
				spanStartMs: span.fromMs,
				spanEndMs: span.toMs,
			},
			evidence: {
				measured: { unreadableSpanMs: span.toMs - span.fromMs },
				thresholds: { minMs: DETECTION_GAP_MIN_MS },
				counts: {},
				spanStartMs: span.fromMs,
				spanEndMs: span.toMs,
			},
			partial: true,
			summary:
				`detection-gap: ${span.instanceId} records unreadable for ` +
				`${Math.round((span.toMs - span.fromMs) / 60000)} min`,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Alert write with retry (Requirement 18.7, 18.9)
// ---------------------------------------------------------------------------

/** The write interface the retrying driver uses (shape of `reconcile/schedule.ts` AlertWriter). */
export interface AnomalyAlertWriter {
	write(summary: string): Promise<void>
}

/** The ≤5 min retry interval (Requirement 18.9). */
export const ALERT_RETRY_INTERVAL_MS = 5 * 60 * 1000

/** The 24 h give-up horizon (Requirement 18.9). */
export const ALERT_GIVE_UP_MS = 24 * 60 * 60 * 1000

/** One per-alert write deadline: 10 s (Requirement 18.9). */
export const ALERT_WRITE_TIMEOUT_MS = 10 * 1000

/** The outcome of writing one anomaly's alert entry. */
export interface AlertWriteOutcome {
	readonly anomaly: Anomaly
	readonly written: boolean
	/** The number of write attempts made. */
	readonly attempts: number
	/** The failure reason recorded when the entry was still unwritten after 24 h (Requirement 18.9). */
	readonly gaveUpReason: string | null
}

/** A sleep function so the retry loop has no hidden timer (injectable for tests). */
export type SleepFn = (ms: number) => Promise<void>

/** A clock so the 24 h horizon has no hidden `Date.now()` (injectable for tests). */
export type NowFn = () => number

/** Options for {@link writeAlerts}. */
export interface WriteAlertsOptions {
	readonly writer: AnomalyAlertWriter
	readonly now: NowFn
	readonly sleep: SleepFn
	/** The retry interval; defaults to {@link ALERT_RETRY_INTERVAL_MS}. */
	readonly retryIntervalMs?: number
	/** The give-up horizon; defaults to {@link ALERT_GIVE_UP_MS}. */
	readonly giveUpMs?: number
	/** A log sink for entries still unwritten after 24 h (Requirement 18.9). */
	readonly logUnwritten?: (outcome: AlertWriteOutcome) => void
}

/**
 * Write one entry per anomaly to the Alert_Destination, retrying a failed or
 * timed-out write at least once every 5 minutes until it succeeds or 24 hours
 * have passed since detection, then recording the still-unwritten entry with its
 * failure reason (Requirement 18.7, 18.9). Detection continues meanwhile — that
 * is the caller's loop; this function drives only the writes it is given.
 */
export async function writeAlerts(
	anomalies: readonly Anomaly[],
	options: WriteAlertsOptions,
): Promise<AlertWriteOutcome[]> {
	const retryInterval = options.retryIntervalMs ?? ALERT_RETRY_INTERVAL_MS
	const giveUp = options.giveUpMs ?? ALERT_GIVE_UP_MS
	const outcomes: AlertWriteOutcome[] = []

	for (const anomaly of anomalies) {
		let attempts = 0
		let lastError = "unknown"
		let written = false
		for (;;) {
			attempts++
			try {
				await withTimeout(options.writer.write(anomaly.summary), ALERT_WRITE_TIMEOUT_MS, options.sleep)
				written = true
				break
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error)
			}
			// Give up once 24 h have passed since the detection time.
			if (options.now() - anomaly.detectedAtMs >= giveUp) {
				break
			}
			await options.sleep(retryInterval)
			if (options.now() - anomaly.detectedAtMs >= giveUp) {
				break
			}
		}
		const outcome: AlertWriteOutcome = {
			anomaly,
			written,
			attempts,
			gaveUpReason: written ? null : lastError,
		}
		if (!written) {
			options.logUnwritten?.(outcome)
		}
		outcomes.push(outcome)
	}
	return outcomes
}

/** Reject if `promise` does not settle within `ms`, using the injected sleep as the timer. */
async function withTimeout<T>(promise: Promise<T>, ms: number, sleep: SleepFn): Promise<T> {
	const timeout: Promise<never> = sleep(ms).then(() => {
		throw new Error(`alert write did not complete within ${ms} ms`)
	})
	return Promise.race([promise, timeout])
}

// ---------------------------------------------------------------------------
// Shared small helpers (kept module-private to avoid cross-module coupling)
// ---------------------------------------------------------------------------

/** The nearest-rank percentile of `xs` for p in (0,100], or null when empty (Requirement 16.9). */
export function nearestRank(xs: readonly number[], p: number): number | null {
	if (xs.length === 0) {
		return null
	}
	const sorted = [...xs].sort((a, b) => a - b)
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
	return sorted[rank - 1]!
}

/** The input-size bucket a recorded token count falls in, or null (Requirement 16.2). */
export function bucketOf(tin: number | null): "10-50k" | "50-100k" | "100k+" | null {
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

function routeNameFields(input: AnomalyInput, a: Attempt): Record<string, readonly string[]> {
	const memberships = input.routeMemberships({
		instanceId: a.instanceId,
		modelOfferingId: typeof a.attr.modelOfferingId === "string" ? a.attr.modelOfferingId : null,
		cloudTargetId: typeof a.attr.cloudTargetId === "string" ? a.attr.cloudTargetId : null,
		deviceId: typeof a.attr.deviceId === "string" ? a.attr.deviceId : null,
	})
	return {
		publicRoutes: memberships.publicRoutes,
		routeAliases: memberships.routeAliases,
		internalPools: memberships.internalPools,
		diagnosticRoutes: memberships.diagnosticRoutes,
	}
}

function countByStatus(attempts: readonly Attempt[]): Map<string, number> {
	const out = new Map<string, number>()
	for (const a of attempts) {
		const key = a.status === null ? "null" : String(a.status)
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	return out
}

function countByErrorType(attempts: readonly Attempt[]): Map<string, number> {
	const out = new Map<string, number>()
	for (const a of attempts) {
		const key = a.etype ?? "null"
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	return out
}

/** A stable, human-readable rendering of a count map (sorted by key). */
function formatCounts(counts: ReadonlyMap<string, number>): string {
	return [...counts.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([k, v]) => `${k}=${v}`)
		.join(",")
}

function groupBy<T>(items: readonly T[], keyOf: (t: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>()
	for (const item of items) {
		pushTo(map, keyOf(item), item)
	}
	return map
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key)
	if (list) {
		list.push(value)
	} else {
		map.set(key, [value])
	}
}
