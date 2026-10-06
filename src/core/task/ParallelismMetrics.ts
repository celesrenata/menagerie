import type { LogicalWorkerState, RouteCapacity } from "./elasticTypes"

/**
 * Per-worker timing breakdown (design §`ParallelismMetrics`, Req 15.3). Every
 * field is a duration in milliseconds accumulated across the worker's whole
 * life:
 *  - `queueWaitMs` — total time spent `runnable`/`waiting-for-inference` waiting
 *    to acquire an inference lease (the "runnable but no capacity" wait).
 *  - `generationMs` — total time the worker held a lease in `generating`.
 *  - `toolWaitMs` — total time in `running-tool`/`waiting-on-tool`.
 *  - `taskDurationMs` — wall-clock from the worker being created to its settle.
 */
export interface WorkerTimings {
	workerId: string
	queueWaitMs: number
	generationMs: number
	toolWaitMs: number
	taskDurationMs: number
}

/**
 * The value record for one speculative branch (design §`ParallelismMetrics`,
 * Req 18). `hypothesis`, `durationMs`, and `tokenCount` are recorded while the
 * branch runs (Req 18.1); `affectedFinalDecision` and `cancelledEarly` are
 * recorded when it settles (Req 18.2). `cancelledEarly` is true iff the branch
 * was cancelled before it settled on its own (hypothesis eliminated).
 */
export interface SpeculationRecord {
	workerId: string
	hypothesis: string
	durationMs: number
	tokenCount: number
	affectedFinalDecision: boolean
	cancelledEarly: boolean
}

/**
 * The accumulated, orchestration-only metrics for one elastic execution
 * (design §`ParallelismMetrics`, FEAT-012). This is the immutable snapshot a
 * consumer reads; the live mutable state lives in {@link ParallelismMetricsCollector}.
 *
 * Every field describes *logical orchestration* — worker counts, state
 * timings, admission pressure as a capability/capacity sample — and never
 * physical placement. There is deliberately no GPU, VRAM, CUDA, or node field
 * anywhere; `routeCapacitySamples` carries only `route`/`capacity`/`available`/
 * optional `pressure` (PAR-019.2, PAR-019.3). Any learning that consumes these
 * metrics therefore tunes orchestration policy only and can never reach
 * physical GPU placement.
 */
export interface ParallelismMetrics {
	// Req 15.1
	logicalWorkersCreated: number
	peakLiveWorkers: number
	peakRunnableWorkers: number
	peakSimultaneousGenerations: number
	// Req 15.2
	readerSwarmSizes: number[]
	// Req 15.3
	perWorker: WorkerTimings[]
	// Req 15.4
	speculativeCancellations: number
	workStealingOperations: number
	criticalPathIdleMs: number // Req 17
	// Req 15.5 — capability/capacity only, never physical identity (PAR-019.3).
	routeCapacitySamples: Array<{ route: string; capacity: number; available: number; pressure?: number }>
	// Req 15.6
	timeToFirstUsefulResultMs?: number
	timeToFinalResultMs?: number
	// Req 16 — contributing workers / created workers, in [0, 1].
	usefulParallelismRatio: number
	// Req 18
	speculation: SpeculationRecord[]
}

/** A monotonic clock injectable for deterministic tests (defaults to `Date.now`). */
export type NowFn = () => number

/** The live/terminal classification a worker's current {@link LogicalWorkerState} falls into. */
const TERMINAL_STATES: ReadonlySet<LogicalWorkerState> = new Set<LogicalWorkerState>([
	"completed",
	"failed",
	"cancelled",
])

/** States that count toward "live" for the peak-live gauge (queued..verifying, Req 15.1). */
function isLive(state: LogicalWorkerState): boolean {
	return !TERMINAL_STATES.has(state)
}

/**
 * The mutable, orchestration-only metrics collector the
 * {@link import("./BoundedElasticScheduler").BoundedElasticScheduler} feeds as
 * workers are created, change state, acquire/release leases, settle, steal
 * work, and cancel speculative branches (design §`ParallelismMetrics`,
 * FEAT-012, Req 15–19).
 *
 * The collector is intentionally free of any scheduling authority: it only
 * *observes*. The scheduler calls its hooks at the moments it already performs
 * a transition, so the metrics never change a scheduling decision and never
 * read or record physical identity (PAR-019.2, PAR-019.3). Reading
 * {@link snapshot} (or {@link finalize}) materializes the immutable
 * {@link ParallelismMetrics} the design exposes on the scheduler.
 *
 * **Timing model.** Each tracked worker records when it entered its current
 * state; a transition closes the prior interval into the matching bucket
 * (`queueWaitMs` for runnable/waiting-for-inference, `generationMs` for
 * generating, `toolWaitMs` for the tool states) and opens a new one. The gauges
 * (peak live/runnable/generations) are recomputed on every transition from the
 * live population the collector tracks, so a peak is captured the instant it is
 * reached rather than only at settle.
 *
 * **Critical-path idle (Req 17).** While a worker flagged critical-path is
 * `runnable`/`waiting-for-inference` AND the scheduler reports suitable
 * inference capacity unavailable, the collector accumulates `criticalPathIdleMs`.
 * The scheduler drives this with {@link setCriticalPathCapacityAvailable},
 * calling it as lease capacity for the critical capability changes; the
 * collector folds elapsed idle time whenever the condition's truth value or a
 * tracked critical-path worker's state changes.
 */
export class ParallelismMetricsCollector {
	private readonly now: NowFn

	private _logicalWorkersCreated = 0
	private _peakLiveWorkers = 0
	private _peakRunnableWorkers = 0
	private _peakSimultaneousGenerations = 0
	private readonly _readerSwarmSizes: number[] = []
	private _speculativeCancellations = 0
	private _workStealingOperations = 0
	private _criticalPathIdleMs = 0
	private readonly _routeCapacitySamples: Array<{
		route: string
		capacity: number
		available: number
		pressure?: number
	}> = []
	private _timeToFirstUsefulResultMs?: number
	private _timeToFinalResultMs?: number

	/** The execution start instant, set on the first worker created. */
	private executionStart?: number

	/** Per-worker tracking state, keyed by workerId. */
	private readonly tracked = new Map<string, TrackedWorker>()

	/** Speculation records keyed by workerId so a settle can finalize the open record. */
	private readonly speculation = new Map<string, MutableSpeculationRecord>()

	/**
	 * Whether suitable inference capacity for critical-path work is currently
	 * unavailable, per the scheduler. Combined with any tracked critical-path
	 * worker sitting `runnable`/`waiting-for-inference`, this gates
	 * `criticalPathIdleMs` accumulation (Req 17.1).
	 */
	private criticalCapacityUnavailable = false
	/** When the current critical-path-idle window opened, or undefined if closed. */
	private criticalIdleSince?: number

	constructor(now: NowFn = Date.now) {
		this.now = now
	}

	/** Logical workers created so far (Req 15.1). */
	get logicalWorkersCreated(): number {
		return this._logicalWorkersCreated
	}

	/**
	 * Record a newly created `Logical_Worker` (Req 15.1). Called from `admitPlan`,
	 * `stealWork`, and `admitSpeculativeBranch` for each worker the scheduler
	 * admits. `createdAt` defaults to now so timing starts the instant the worker
	 * exists. A worker already tracked (duplicate id) is ignored so a re-admit
	 * never double-counts.
	 */
	onWorkerCreated(workerId: string, initialState: LogicalWorkerState, options?: { createdAt?: number }): void {
		if (this.tracked.has(workerId)) return
		const at = options?.createdAt ?? this.now()
		if (this.executionStart === undefined) this.executionStart = at
		this._logicalWorkersCreated++
		this.tracked.set(workerId, {
			workerId,
			state: initialState,
			criticalPath: false,
			createdAt: at,
			stateSince: at,
			queueWaitMs: 0,
			generationMs: 0,
			toolWaitMs: 0,
			settledAt: undefined,
			contributed: false,
		})
		this.refreshGauges()
		this.refreshCriticalIdle(at)
	}

	/**
	 * Flag (or clear) a tracked worker's critical-path membership so critical-path
	 * idle accounting (Req 17) considers it. Safe to call before or after the
	 * worker's state changes; it folds any open idle window first.
	 */
	setCriticalPath(workerId: string, criticalPath: boolean): void {
		const worker = this.tracked.get(workerId)
		if (worker === undefined || worker.criticalPath === criticalPath) return
		const at = this.now()
		this.foldCriticalIdle(at)
		worker.criticalPath = criticalPath
		this.refreshCriticalIdle(at)
	}

	/**
	 * Record a worker transitioning to `nextState` (Req 15.1, 15.3). Closes the
	 * current state's timing interval into the matching bucket, opens the next,
	 * recomputes the peak gauges, and folds any critical-path-idle window whose
	 * truth value this transition changes. A transition on an unknown or already
	 * terminal worker is ignored.
	 */
	onStateChanged(workerId: string, nextState: LogicalWorkerState): void {
		const worker = this.tracked.get(workerId)
		if (worker === undefined || TERMINAL_STATES.has(worker.state)) return
		const at = this.now()
		this.foldCriticalIdle(at)
		this.closeInterval(worker, at)
		worker.state = nextState
		worker.stateSince = at
		if (TERMINAL_STATES.has(nextState)) {
			worker.settledAt = at
		}
		this.refreshGauges()
		this.refreshCriticalIdle(at)
	}

	/**
	 * Record that suitable inference capacity for critical-path work became
	 * available (`true`) or unavailable (`false`) (Req 17.1). The scheduler calls
	 * this as the critical capability's lease pool fills or frees. The collector
	 * folds any open idle window at the transition so accumulation is exact.
	 */
	setCriticalPathCapacityAvailable(available: boolean): void {
		const unavailable = !available
		if (this.criticalCapacityUnavailable === unavailable) return
		const at = this.now()
		this.foldCriticalIdle(at)
		this.criticalCapacityUnavailable = unavailable
		this.refreshCriticalIdle(at)
	}

	/** Record a reader-swarm fan-out of `size` readers (Req 15.2). */
	onReaderSwarm(size: number): void {
		if (!Number.isFinite(size) || size <= 0) return
		this._readerSwarmSizes.push(size)
	}

	/** Record a work-stealing operation that admitted `childrenAdmitted` children (Req 15.4). */
	onWorkStealing(childrenAdmitted: number): void {
		if (childrenAdmitted <= 0) return
		this._workStealingOperations++
	}

	/** Record a speculative-branch cancellation (Req 15.4). */
	onSpeculativeCancellation(): void {
		this._speculativeCancellations++
	}

	/**
	 * Open a speculation record for a speculative branch as it starts running
	 * (Req 18.1). `hypothesis` is the hypothesis under test; `durationMs`/
	 * `tokenCount` accrue through {@link addSpeculationUsage} and the settle hook.
	 */
	onSpeculationStarted(workerId: string, hypothesis: string): void {
		if (this.speculation.has(workerId)) return
		this.speculation.set(workerId, {
			workerId,
			hypothesis,
			startedAt: this.now(),
			durationMs: 0,
			tokenCount: 0,
			affectedFinalDecision: false,
			cancelledEarly: false,
			settled: false,
		})
	}

	/** Accumulate generated tokens for a speculative branch (Req 18.1). */
	addSpeculationTokens(workerId: string, tokens: number): void {
		const record = this.speculation.get(workerId)
		if (record === undefined || record.settled || tokens <= 0) return
		record.tokenCount += tokens
	}

	/**
	 * Finalize a speculative branch's record on settle (Req 18.2): freeze its
	 * duration, and record whether it affected the final decision and whether it
	 * was cancelled early (before settling on its own). A record already settled
	 * or absent is ignored.
	 */
	onSpeculationSettled(
		workerId: string,
		outcome: { affectedFinalDecision: boolean; cancelledEarly: boolean },
	): void {
		const record = this.speculation.get(workerId)
		if (record === undefined || record.settled) return
		record.durationMs = this.now() - record.startedAt
		record.affectedFinalDecision = outcome.affectedFinalDecision
		record.cancelledEarly = outcome.cancelledEarly
		record.settled = true
	}

	/**
	 * Sample route capacity/pressure as the scheduler reads route information
	 * (Req 15.5). The sample is capability/capacity only — `route`, `capacity`,
	 * `available`, optional `pressure`. The route's `capability` and any other
	 * physical identity are deliberately dropped so no GPU/VRAM/CUDA/node value is
	 * ever recorded (PAR-019.3).
	 */
	onRouteSample(capacity: Pick<RouteCapacity, "route" | "capacity" | "available" | "pressure">): void {
		const sample: { route: string; capacity: number; available: number; pressure?: number } = {
			route: capacity.route,
			capacity: capacity.capacity,
			available: capacity.available,
		}
		if (capacity.pressure !== undefined) sample.pressure = capacity.pressure
		this._routeCapacitySamples.push(sample)
	}

	/**
	 * Mark a worker as having contributed to the final outcome (Req 16.1). The
	 * useful-parallelism ratio counts distinct contributing workers over created
	 * workers, so marking the same worker twice is idempotent. The first useful
	 * contribution also records `timeToFirstUsefulResultMs` relative to the
	 * execution start (Req 15.6).
	 */
	markContributed(workerId: string): void {
		const worker = this.tracked.get(workerId)
		if (worker === undefined || worker.contributed) return
		worker.contributed = true
		if (this._timeToFirstUsefulResultMs === undefined && this.executionStart !== undefined) {
			this._timeToFirstUsefulResultMs = Math.max(0, this.now() - this.executionStart)
		}
	}

	/**
	 * Build the immutable {@link ParallelismMetrics} snapshot. `usefulParallelismRatio`
	 * is contributing/created in `[0, 1]` — 0 only when none contributed, 1 only
	 * when all created workers contributed (Req 16.1); it is 0 when no worker was
	 * ever created. Per-worker timings close any still-open interval at `now` so an
	 * in-flight worker is represented. Reading the snapshot does not stop collection.
	 *
	 * The returned arrays are fresh copies so a caller can hold the snapshot while
	 * the collector keeps mutating.
	 */
	snapshot(): ParallelismMetrics {
		const at = this.now()
		const created = this._logicalWorkersCreated
		let contributing = 0
		const perWorker: WorkerTimings[] = []
		for (const worker of this.tracked.values()) {
			if (worker.contributed) contributing++
			perWorker.push(this.timingsFor(worker, at))
		}
		const usefulParallelismRatio = created === 0 ? 0 : contributing / created

		return {
			logicalWorkersCreated: created,
			peakLiveWorkers: this._peakLiveWorkers,
			peakRunnableWorkers: this._peakRunnableWorkers,
			peakSimultaneousGenerations: this._peakSimultaneousGenerations,
			readerSwarmSizes: [...this._readerSwarmSizes],
			perWorker,
			speculativeCancellations: this._speculativeCancellations,
			workStealingOperations: this._workStealingOperations,
			criticalPathIdleMs: this.criticalPathIdleWith(at),
			routeCapacitySamples: this._routeCapacitySamples.map((sample) => ({ ...sample })),
			timeToFirstUsefulResultMs: this._timeToFirstUsefulResultMs,
			timeToFinalResultMs: this._timeToFinalResultMs,
			usefulParallelismRatio,
			speculation: [...this.speculation.values()].map((record) => ({
				workerId: record.workerId,
				hypothesis: record.hypothesis,
				durationMs: record.durationMs,
				tokenCount: record.tokenCount,
				affectedFinalDecision: record.affectedFinalDecision,
				cancelledEarly: record.cancelledEarly,
			})),
		}
	}

	/**
	 * Close the execution: fold any open critical-idle window, record
	 * `timeToFinalResultMs` relative to the execution start (Req 15.6), close any
	 * open per-worker interval, and return the final immutable {@link ParallelismMetrics}.
	 * Idempotent — a second finalize returns the same snapshot without
	 * re-stamping the final time.
	 */
	finalize(): ParallelismMetrics {
		const at = this.now()
		this.foldCriticalIdle(at)
		if (this._timeToFinalResultMs === undefined && this.executionStart !== undefined) {
			this._timeToFinalResultMs = Math.max(0, at - this.executionStart)
		}
		return this.snapshot()
	}

	/** Close a worker's current state interval into the matching timing bucket. */
	private closeInterval(worker: TrackedWorker, at: number): void {
		const elapsed = Math.max(0, at - worker.stateSince)
		switch (worker.state) {
			case "runnable":
			case "waiting-for-inference":
				worker.queueWaitMs += elapsed
				break
			case "generating":
				worker.generationMs += elapsed
				break
			case "running-tool":
			case "waiting-on-tool":
				worker.toolWaitMs += elapsed
				break
			default:
				break
		}
	}

	/** Build the {@link WorkerTimings} for a worker, closing the open interval at `at`. */
	private timingsFor(worker: TrackedWorker, at: number): WorkerTimings {
		const end = worker.settledAt ?? at
		const openElapsed = Math.max(0, end - worker.stateSince)
		let queueWaitMs = worker.queueWaitMs
		let generationMs = worker.generationMs
		let toolWaitMs = worker.toolWaitMs
		switch (worker.state) {
			case "runnable":
			case "waiting-for-inference":
				queueWaitMs += openElapsed
				break
			case "generating":
				generationMs += openElapsed
				break
			case "running-tool":
			case "waiting-on-tool":
				toolWaitMs += openElapsed
				break
			default:
				break
		}
		return {
			workerId: worker.workerId,
			queueWaitMs,
			generationMs,
			toolWaitMs,
			taskDurationMs: Math.max(0, end - worker.createdAt),
		}
	}

	/** Recompute the peak live/runnable/generation gauges from the live population. */
	private refreshGauges(): void {
		let live = 0
		let runnable = 0
		let generating = 0
		for (const worker of this.tracked.values()) {
			if (!isLive(worker.state)) continue
			live++
			if (worker.state === "runnable") runnable++
			if (worker.state === "generating") generating++
		}
		if (live > this._peakLiveWorkers) this._peakLiveWorkers = live
		if (runnable > this._peakRunnableWorkers) this._peakRunnableWorkers = runnable
		if (generating > this._peakSimultaneousGenerations) this._peakSimultaneousGenerations = generating
	}

	/** True iff some tracked critical-path worker is runnable/waiting-for-inference. */
	private hasIdleCriticalWorker(): boolean {
		for (const worker of this.tracked.values()) {
			if (!worker.criticalPath) continue
			if (worker.state === "runnable" || worker.state === "waiting-for-inference") return true
		}
		return false
	}

	/**
	 * Open or keep the critical-idle window open iff a critical-path worker is
	 * idle AND capacity is unavailable (Req 17.1); otherwise ensure it is closed.
	 */
	private refreshCriticalIdle(at: number): void {
		const shouldAccumulate = this.criticalCapacityUnavailable && this.hasIdleCriticalWorker()
		if (shouldAccumulate && this.criticalIdleSince === undefined) {
			this.criticalIdleSince = at
		} else if (!shouldAccumulate && this.criticalIdleSince !== undefined) {
			this._criticalPathIdleMs += Math.max(0, at - this.criticalIdleSince)
			this.criticalIdleSince = undefined
		}
	}

	/** Fold the currently open critical-idle window (if any) into the accumulator up to `at`. */
	private foldCriticalIdle(at: number): void {
		if (this.criticalIdleSince === undefined) return
		this._criticalPathIdleMs += Math.max(0, at - this.criticalIdleSince)
		this.criticalIdleSince = at
	}

	/** Critical-path idle including any window still open at `at`, without mutating state. */
	private criticalPathIdleWith(at: number): number {
		if (this.criticalIdleSince === undefined) return this._criticalPathIdleMs
		return this._criticalPathIdleMs + Math.max(0, at - this.criticalIdleSince)
	}
}

/** Mutable per-worker tracking state held by the collector. */
interface TrackedWorker {
	readonly workerId: string
	state: LogicalWorkerState
	criticalPath: boolean
	readonly createdAt: number
	/** When the worker entered its current {@link state}. */
	stateSince: number
	queueWaitMs: number
	generationMs: number
	toolWaitMs: number
	/** When the worker settled, or undefined while still live. */
	settledAt?: number
	contributed: boolean
}

/** Mutable speculation record held by the collector until the branch settles. */
interface MutableSpeculationRecord {
	readonly workerId: string
	readonly hypothesis: string
	readonly startedAt: number
	durationMs: number
	tokenCount: number
	affectedFinalDecision: boolean
	cancelledEarly: boolean
	settled: boolean
}
