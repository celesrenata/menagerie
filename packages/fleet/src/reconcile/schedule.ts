// Reconciler — scheduled drift run and alert write (design §3 "Drift detection",
// Requirement 8.4, 8.11, 8.12, 8.13).
//
// READ-ONLY. This module performs ONE drift run via `detectDrift` (task 5.1),
// which sends only read requests to OmniRoute (Requirement 8.4), then decides
// whether the outcome is alert-worthy and, if so, writes the run's
// human-readable summary to the Alert_Destination declared in the inventory
// (Requirement 8.13).
//
// A run is alert-worthy when its outcome is NOT `complete`, or any difference
// exists on any instance (Requirement 8.13). A clean fleet — `complete` with
// zero differences — writes NOTHING. A parse/validate/compile failure ends the
// run as `failed` (Requirement 8.12) and is therefore always alert-worthy.
//
// Scheduling is modelled with injected timers so tests never sleep: the module
// exposes `runScheduledDrift(...)` performing one run, and `scheduleDrift(...)`
// that invokes it on a fixed interval (clamped to ≤24 h per Requirement 8.11)
// via an injectable timer, returning a handle to stop the schedule.
//
// Credential safety (Requirement 22.4-22.6): the summary written to the alert
// destination is the `DriftReport.summary`, which is already credential-free
// (combo/field values come from the compiled Desired_Route_State and live combo
// metadata, and any tokenized segment is redacted before it enters the report).
// This module adds no secret, body, or tokenized segment to what it writes.

import type { AlertDestination, FleetInventory } from "@roo-code/types"

import type { Revision } from "../compile/compiler.js"
import type { OmniRouteClient, SecretResolver } from "../omniroute/client.js"
import { detectDrift, type DriftOptions, type DriftReport } from "./drift.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The upper bound on the gap between consecutive scheduled runs (Req 8.11). */
export const MAX_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000

/**
 * Writes a drift summary to the Alert_Destination. Injected so tests assert what
 * was written without a live HTTP endpoint. The real writer
 * (`HttpAlertWriter`) resolves the alert secret via the SecretResolver and posts
 * the summary to `alertDestination.url`.
 */
export interface AlertWriter {
	write(summary: string): Promise<void>
}

/** The outcome of one scheduled drift run. */
export interface ScheduledDriftResult {
	/** The full drift report produced by the run. */
	readonly report: DriftReport
	/** Whether this run was alert-worthy (outcome not `complete` or any difference). */
	readonly alertWorthy: boolean
	/** Whether the summary was written to the Alert_Destination. */
	readonly alerted: boolean
}

/** The dependencies one scheduled drift run needs. */
export interface RunScheduledDriftArgs {
	/** The inventory model to compare (the latest committed revision's model). */
	readonly model: FleetInventory
	/** The revision the model was committed at (Requirement 8.11). */
	readonly revision: Revision
	/** A read-only OmniRoute client per declared instance id. */
	readonly clients: ReadonlyMap<string, OmniRouteClient>
	/** The alert destination to write to; falls back to `model.alertDestination`. */
	readonly alertWriter: AlertWriter
	/** Drift-detector tuning (retry/timeout/sleep); passed straight through. */
	readonly driftOptions?: DriftOptions
}

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------

/**
 * Perform ONE scheduled drift run (Requirement 8.11) against the supplied
 * model + committed revision, then write the human summary to the
 * Alert_Destination when the run is alert-worthy (Requirement 8.13).
 *
 * Alert-worthy = outcome is not `complete`, OR at least one difference exists on
 * any instance. A `failed` outcome (compile/parse/validate failure, Requirement
 * 8.12) is never `complete`, so it is always written. A clean, difference-free
 * `complete` run writes nothing.
 */
export async function runScheduledDrift(args: RunScheduledDriftArgs): Promise<ScheduledDriftResult> {
	const report = await detectDrift(args.model, args.revision, args.clients, args.driftOptions)

	const alertWorthy = isAlertWorthy(report)
	if (!alertWorthy) {
		return { report, alertWorthy, alerted: false }
	}

	await args.alertWriter.write(report.summary)
	return { report, alertWorthy, alerted: true }
}

/**
 * A run is alert-worthy when its outcome is not `complete`, or any instance has
 * at least one difference (Requirement 8.13). Model-id findings and unverified
 * reads also count as "not clean": an `incomplete` outcome (any unverified read)
 * is already not `complete`, and a model-id finding is a difference the summary
 * reports, so a `complete` run with only model-id findings is still alert-worthy.
 */
function isAlertWorthy(report: DriftReport): boolean {
	if (report.outcome !== "complete") {
		return true
	}
	return report.instances.some(
		(inst) => inst.differences.length > 0 || inst.modelIdFindings.length > 0,
	)
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** A started schedule; call `stop()` to cancel future runs. */
export interface ScheduleHandle {
	stop(): void
}

/** Injectable timers so tests drive the schedule without real time passing. */
export interface ScheduleTimers {
	setInterval(handler: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}

/** The arguments to start a recurring drift schedule. */
export interface ScheduleDriftArgs extends RunScheduledDriftArgs {
	/**
	 * The desired gap between consecutive run start times, in ms. Clamped to the
	 * range (0, MAX_SCHEDULE_INTERVAL_MS]; a non-positive or oversized value is
	 * clamped so the ≤24 h bound of Requirement 8.11 always holds.
	 */
	readonly intervalMs: number
	/** Injected timers (default: the global timers). */
	readonly timers?: ScheduleTimers
	/**
	 * Invoked after each run completes (or rejects), so a scheduler host can log
	 * or surface the result. Optional; errors from it are swallowed so one bad
	 * observer never breaks the schedule.
	 */
	readonly onRun?: (result: ScheduledDriftResult) => void
	/** Invoked when a run throws (e.g. an alert-write failure). Optional. */
	readonly onError?: (error: unknown) => void
}

/**
 * Start a recurring drift schedule that runs `runScheduledDrift` every
 * `intervalMs` (clamped to ≤24 h, Requirement 8.11) using the injected timers.
 * Does NOT run immediately; the first run fires after one interval. Returns a
 * handle whose `stop()` cancels the schedule. Runs never overlap: a run still in
 * flight when the next tick fires is skipped for that tick.
 */
export function scheduleDrift(args: ScheduleDriftArgs): ScheduleHandle {
	const interval = clampInterval(args.intervalMs)
	const timers = args.timers ?? defaultTimers
	let running = false

	const tick = (): void => {
		if (running) {
			return // the previous run has not finished; skip this tick.
		}
		running = true
		runScheduledDrift(args)
			.then((result) => {
				running = false
				args.onRun?.(result)
			})
			.catch((error: unknown) => {
				running = false
				args.onError?.(error)
			})
	}

	const handle = timers.setInterval(tick, interval)
	return {
		stop(): void {
			timers.clearInterval(handle)
		},
	}
}

/** Clamp a requested interval into (0, MAX_SCHEDULE_INTERVAL_MS] (Req 8.11). */
function clampInterval(ms: number): number {
	if (!Number.isFinite(ms) || ms <= 0) {
		return MAX_SCHEDULE_INTERVAL_MS
	}
	return Math.min(ms, MAX_SCHEDULE_INTERVAL_MS)
}

const defaultTimers: ScheduleTimers = {
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

// ---------------------------------------------------------------------------
// HTTP alert writer
// ---------------------------------------------------------------------------

/** Minimal view of `fetch` so the writer takes a stub without DOM/Node lib types. */
export type AlertFetchLike = (
	input: string,
	init?: {
		method?: string
		headers?: Record<string, string>
		body?: string
	},
) => Promise<{ readonly ok: boolean; readonly status: number }>

export interface HttpAlertWriterOptions {
	/** The Alert_Destination declared in the inventory (url + optional secretRef). */
	readonly destination: AlertDestination
	/** Resolves the alert secret reference at write time (never cached, Req 22.3). */
	readonly secretResolver: SecretResolver
	/** Injected for tests; defaults to the global fetch. */
	readonly fetch?: AlertFetchLike
}

/**
 * Raised when the alert POST does not succeed. Carries the HTTP status and the
 * destination URL. It NEVER carries the resolved secret or the summary body
 * beyond the already-credential-free summary (Requirement 22.4).
 */
export class AlertWriteError extends Error {
	readonly status: number
	readonly url: string

	constructor(url: string, status: number) {
		super(`alert write failed: POST ${url} -> ${status}`)
		this.name = "AlertWriteError"
		this.url = url
		this.status = status
	}
}

/**
 * The real HTTP alert writer. Resolves the alert secret via the SecretResolver
 * (when the destination declares a `secretRef`) and POSTs the credential-free
 * summary to `destination.url` as the request body. The bearer, when present, is
 * placed only in the Authorization header and is never logged or echoed.
 */
export class HttpAlertWriter implements AlertWriter {
	private readonly destination: AlertDestination
	private readonly secretResolver: SecretResolver
	private readonly fetchImpl: AlertFetchLike

	constructor(options: HttpAlertWriterOptions) {
		this.destination = options.destination
		this.secretResolver = options.secretResolver
		const injected = options.fetch
		if (injected) {
			this.fetchImpl = injected
		} else {
			const globalFetch = (globalThis as { fetch?: AlertFetchLike }).fetch
			if (!globalFetch) {
				throw new Error("global fetch is unavailable; inject a fetch implementation")
			}
			this.fetchImpl = globalFetch
		}
	}

	async write(summary: string): Promise<void> {
		const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" }
		if (this.destination.secretRef) {
			const bearer = await this.secretResolver.resolve(this.destination.secretRef)
			if (typeof bearer === "string" && bearer.trim().length > 0) {
				headers.Authorization = `Bearer ${bearer}`
			}
		}
		const response = await this.fetchImpl(this.destination.url, {
			method: "POST",
			headers,
			body: summary,
		})
		if (!response.ok) {
			throw new AlertWriteError(this.destination.url, response.status)
		}
	}
}
