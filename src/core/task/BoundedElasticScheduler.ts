import { TaskSemaphore } from "../../utils/TaskSemaphore"
import { InferenceLeasePool } from "./InferenceLeasePool"
import { ParallelismMetricsCollector, type ParallelismMetrics } from "./ParallelismMetrics"
import { TaskDag } from "./TaskDag"
import {
	READER_OUTPUT_BOUNDS,
	type ExecutionPlan,
	type LogicalWorker,
	type LogicalWorkerState,
	type ReaderOutputBounds,
	type RouteCapability,
	type RouteCapacityProvider,
	type SchedulerBounds,
	type SchedulingPriority,
	type UserParallelismPolicy,
	type WorkerCompletionEvent,
	type WorkerCompletionHandler,
	type WorkerOutcome,
	type WorkerProvenance,
	type WorkSplit,
} from "./elasticTypes"

/**
 * The per-generation handle the scheduler hands a dispatched worker's agent
 * loop (design §Components, `DispatchHandle`). The worker holds a dispatch
 * permit for its whole run and uses this handle to acquire a short-lived
 * {@link InferenceLeasePool} lease for each individual generation, releasing it
 * the instant it runs a tool or waits on I/O (PAR-008.3, PAR-009).
 */
export interface DispatchHandle {
	readonly workerId: string
	/**
	 * Acquire an `Inference_Lease` for one generation. The worker transitions to
	 * `generating` while the lease is held; the returned release fn transitions
	 * it back to `runnable` and frees the lease. The release fn is idempotent, so
	 * callers wire it into a `try/finally` to guarantee release-on-throw.
	 */
	acquireLease(capability: RouteCapability, signal: AbortSignal): Promise<() => void>
	/** The worker's current observable state. */
	readonly state: LogicalWorkerState
}

/** Terminal states a `Logical_Worker` can settle into; it never leaves these. */
const TERMINAL_STATES: ReadonlySet<LogicalWorkerState> = new Set<LogicalWorkerState>([
	"completed",
	"failed",
	"cancelled",
])

/**
 * The sustained-pressure level at or above which the scheduler stops admitting
 * **new** logical fan-out (PAR-012.3). {@link RouteCapacityProvider.sustainedPressure}
 * is a normalized aggregate in `[0, 1]` that OmniRoute raises as route
 * saturation, first-token latency, memory pressure, model swap, queue length,
 * context pressure, error rate, and thermal/resource constraints build
 * (PAR-012.2); `0.8` keeps fan-out flowing under normal load and throttles only
 * when pressure is sustained-high. The threshold throttles new admission only
 * and models no physical capacity itself (PAR-012.4).
 */
const SUSTAINED_PRESSURE_THRESHOLD = 0.8

/**
 * The replacement for the fixed `parallelTaskPool` (design §Components,
 * `BoundedElasticScheduler`). It owns the dispatch {@link TaskSemaphore}, a
 * per-capability {@link InferenceLeasePool}, the {@link TaskDag} compiled from
 * the admitted {@link ExecutionPlan}, and the `Logical_Worker` state map.
 *
 * Two independent gates separate logical liveness from physical generation:
 *  - **Dispatch** — how many workers are actively progressing, bounded by
 *    `maxDispatched` (default 8) via the dispatch semaphore.
 *  - **Inference** — how many generations run at once, bounded by OmniRoute
 *    capacity via the lease pool. A lease is held **only** while `generating`
 *    (PAR-001.4, PAR-008.2, PAR-008.4), so tool/wait states never reduce the
 *    generations available to other workers (PAR-009).
 *
 * Both are clamped to the {@link UserParallelismPolicy} ceiling for the exact
 * submitted request (PAR-014.1).
 *
 * **Priority & critical path (PAR-010).** When inference capacity is
 * constrained, the lease pool admits strictly by {@link SchedulingPriority} rank
 * (`critical` &gt; `high` &gt; `normal` &gt; `background` &gt; `speculative`). The
 * mastermind marks the architect and any required verifier `critical`/`high` via
 * {@link setPriority}; because admission is priority-ordered, that alone
 * guarantees `background`/`speculative` work can never delay their inference
 * admission (PAR-010.5). {@link admitPlan} additionally flags each worker on the
 * DAG's {@link TaskDag.criticalPath}, and {@link makeHandle} passes that flag
 * into {@link InferenceLeasePool.acquire} as a within-priority tiebreaker so a
 * critical-path worker is admitted ahead of a non-critical-path peer at the same
 * nominal priority (PAR-010.4) — never reordering across priorities.
 *
 * **Backpressure (PAR-012).** {@link shouldAdmitNewFanOut} gates NEW logical
 * fan-out ({@link stealWork}, {@link admitSpeculativeBranch}) on OmniRoute's
 * aggregate {@link RouteCapacityProvider.sustainedPressure} signal. Under
 * sustained pressure the scheduler admits no new work, but never reads or
 * mutates an in-flight worker, so throttling never pauses or cancels live work
 * (PAR-012.3) and models no physical capacity itself (PAR-012.4).
 *
 * When a worker settles, {@link onWorkerSettled} drives the **completion event
 * bus** (design §"Event-driven DAG", PAR-004.6): it unlocks dependents through
 * {@link TaskDag.unlockedBy}, transitions each newly-runnable dependent from
 * `waiting-on-dependency` to `runnable`, and publishes a
 * {@link WorkerCompletionEvent} to every subscriber so handlers may satisfy
 * evidence, trigger a verifier, trigger a reader fan-out, cancel speculative
 * siblings, or update task state. Subscribers act on each event as it arrives —
 * completing a subset of a batch unlocks the dependents of the completed nodes
 * without waiting for every child (PAR-004.7, partial batch completion); there
 * is no `Promise.all` barrier.
 */
export class BoundedElasticScheduler {
	/** Effective live/dispatched/lease bounds after clamping by the policy ceiling. */
	private readonly bounds: SchedulerBounds
	private readonly policy: UserParallelismPolicy
	private readonly routes: RouteCapacityProvider

	/** Gates how many workers may progress at once (PAR-003.1). */
	private readonly dispatchSemaphore: TaskSemaphore
	/** One lease pool per capability, created lazily on first `acquireLease`. */
	private readonly leasePools = new Map<RouteCapability, InferenceLeasePool>()

	/** The DAG compiled from the admitted plan; undefined until `admitPlan`. */
	private dag?: TaskDag
	/** workerId → logical metadata (the single source of truth for state). */
	private readonly workers = new Map<string, LogicalWorker>()
	/**
	 * Completion-event subscribers (the completion event bus). A settle publishes
	 * to every subscriber so independent concerns — dependent unlock observers,
	 * evidence accumulation, verifier/reader-fan-out triggers, speculative-sibling
	 * cancellation, task-state updates — can each react without coupling to one
	 * another (PAR-004.6).
	 */
	private readonly completionSubscribers = new Set<WorkerCompletionHandler>()

	/**
	 * The orchestration-only metrics collector (design §`ParallelismMetrics`,
	 * FEAT-012). The scheduler feeds it as workers are created, change state,
	 * acquire/release leases, settle, steal work, and cancel speculative
	 * branches; it only observes and never influences a scheduling decision or
	 * records physical identity (PAR-019.2, PAR-019.3).
	 */
	private readonly metricsCollector: ParallelismMetricsCollector

	constructor(bounds: SchedulerBounds, policy: UserParallelismPolicy, routes: RouteCapacityProvider) {
		this.policy = policy
		this.routes = routes
		this.bounds = {
			maxLive: clampCeiling(bounds.maxLive, policy.maxLive),
			maxDispatched: clampCeiling(bounds.maxDispatched, policy.maxDispatched),
			maxInferenceLeases: bounds.maxInferenceLeases,
		}
		this.dispatchSemaphore = new TaskSemaphore(this.bounds.maxDispatched)
		this.metricsCollector = new ParallelismMetricsCollector()
	}

	/** The effective bounds after clamping by the policy ceiling (read-only). */
	get effectiveBounds(): Readonly<SchedulerBounds> {
		return this.bounds
	}

	/**
	 * The accumulated orchestration-only metrics for this execution
	 * (design §Components, `readonly metrics: ParallelismMetrics`). Reading it
	 * materializes an immutable snapshot of the live collector; collection
	 * continues afterward, so a later read reflects more progress. Call
	 * {@link finalizeMetrics} to stamp time-to-final and close any open window.
	 */
	get metrics(): ParallelismMetrics {
		return this.metricsCollector.snapshot()
	}

	/**
	 * Close the metrics execution window and return the final immutable
	 * {@link ParallelismMetrics} (stamps `timeToFinalResultMs`). Idempotent.
	 */
	finalizeMetrics(): ParallelismMetrics {
		return this.metricsCollector.finalize()
	}

	/**
	 * Mark a worker's results as having contributed to the final outcome, feeding
	 * the Useful_Parallelism_Ratio (Req 16.1). The ratio is contributing/created,
	 * so the mastermind marks each worker whose output reached the final answer.
	 */
	markContributed(workerId: string): void {
		this.metricsCollector.markContributed(workerId)
	}

	/**
	 * Sample the current route capacity/pressure for a capability into the metrics
	 * (Req 15.5). Records capability/capacity only — never physical identity
	 * (PAR-019.3). Called by consumers that read route information for a decision.
	 */
	sampleRouteCapacity(capability: RouteCapability): void {
		for (const snapshot of this.routes.capacitiesFor(capability)) {
			this.metricsCollector.onRouteSample(snapshot)
		}
	}

	/**
	 * Compile an {@link ExecutionPlan} into the {@link TaskDag} and admit its
	 * nodes as `Logical_Worker`s, up to `maxLive`. A node with no incomplete
	 * dependencies is admitted `runnable`; a node still blocked by a dependency
	 * is admitted `waiting-on-dependency`, distinguished for the observatory
	 * (PAR-004, Req 20). Cyclic or non-unique plans throw a recoverable
	 * `ParallelTasksArgumentError` from the DAG constructor.
	 *
	 * Only the first `maxLive` useful nodes are admitted so the policy ceiling is
	 * never exceeded; no filler worker is manufactured (PAR-014.1, PAR-014.2).
	 */
	admitPlan(plan: ExecutionPlan): void {
		// Compiling the plan validates it (cycles, duplicate names) and gives us
		// dependency/runnability answers for the admitted nodes.
		this.dag = new TaskDag(plan)

		// Map each task name to the dependencies that must settle before it runs,
		// so a worker can be admitted directly in `waiting-on-dependency`.
		const depsByTask = new Map<string, string[]>()
		for (const task of plan.tasks) {
			depsByTask.set(task.name, [])
		}
		for (const edge of plan.dependencies ?? []) {
			const deps = depsByTask.get(edge.dependent)
			if (deps === undefined) continue
			for (const dependency of edge.dependsOn) {
				if (!deps.includes(dependency)) deps.push(dependency)
			}
		}

		// Critical-path nodes receive scheduling preference at equal nominal
		// priority (PAR-010.3, PAR-010.4). Precompute the longest dependency chain
		// once so each admitted worker is flagged as it is created.
		const criticalPath = new Set(this.dag.criticalPath())

		for (const task of plan.tasks) {
			// Admit only up to the live ceiling; never manufacture filler beyond the
			// useful decomposition (PAR-014.1, PAR-014.2).
			if (this.workers.size >= this.bounds.maxLive) break

			const deps = depsByTask.get(task.name) ?? []
			const runnable = this.dag.isRunnable(task.name)
			const onCriticalPath = criticalPath.has(task.name)
			const initialState: LogicalWorkerState = runnable ? "runnable" : "waiting-on-dependency"
			this.workers.set(task.name, {
				id: task.name,
				state: initialState,
				priority: "normal",
				criticalPath: onCriticalPath,
				deps,
				speculative: false,
			})
			// Record the created worker and its critical-path membership for metrics
			// (Req 15.1, Req 17); the collector only observes (PAR-019.2).
			this.metricsCollector.onWorkerCreated(task.name, initialState)
			if (onCriticalPath) this.metricsCollector.setCriticalPath(task.name, true)
		}
	}

	/**
	 * Assign a {@link SchedulingPriority} to an admitted worker so the mastermind
	 * can mark the architect and any required verifier as `critical`/`high`
	 * (PAR-010.1). Because {@link InferenceLeasePool} admits strictly by priority
	 * rank (critical &gt; high &gt; normal &gt; background &gt; speculative), raising a
	 * worker to `critical`/`high` guarantees `background`/`speculative` work can
	 * never delay its inference admission (PAR-010.5): a lower-priority waiter is
	 * always queued behind it, never ahead of it.
	 *
	 * A no-op for an unknown or already-terminal worker (its priority can no
	 * longer influence admission). Returns `true` when the priority was applied.
	 */
	setPriority(workerId: string, priority: SchedulingPriority): boolean {
		const worker = this.workers.get(workerId)
		if (worker === undefined || TERMINAL_STATES.has(worker.state)) return false
		worker.priority = priority
		return true
	}

	/**
	 * Backpressure gate for **new logical fan-out** (PAR-012). Returns `false`
	 * when OmniRoute reports sustained pressure at or above
	 * {@link SUSTAINED_PRESSURE_THRESHOLD}, signalling that admitting more work
	 * would degrade quality (PAR-012.1, PAR-012.3); otherwise `true`.
	 *
	 * This consults only the single aggregate {@link RouteCapacityProvider.sustainedPressure}
	 * signal — through which OmniRoute already folds route saturation, first-token
	 * latency, memory pressure, model swap, queue length, context pressure, error
	 * rate, and thermal/resource constraints (PAR-012.2). The scheduler never
	 * re-derives those signals and models no physical capacity of its own;
	 * physical backpressure is deferred entirely to OmniRoute (PAR-012.4).
	 *
	 * It gates only *new* admission ({@link stealWork},
	 * {@link admitSpeculativeBranch}). In-flight workers are never read or
	 * mutated here, so throttling new fan-out never pauses, cancels, or starves a
	 * worker that is already alive (PAR-012.3).
	 */
	shouldAdmitNewFanOut(): boolean {
		return this.routes.sustainedPressure() < SUSTAINED_PRESSURE_THRESHOLD
	}

	/**
	 * Dispatch one `Logical_Worker`'s agent loop under a dispatch permit, mirroring
	 * {@link import("./TaskScheduler").TaskScheduler.schedule}:
	 *  - acquire a dispatch permit (over-capacity workers queue, never rejected —
	 *    PAR-011.1);
	 *  - after admission, skip `run` and release the permit if the worker was
	 *    cancelled/abandoned while it waited (no-op dispatch);
	 *  - release the permit via `try/finally` even if `run` throws.
	 *
	 * A worker that is already terminal before dispatch is a no-op. The handle
	 * passed to `run` owns the per-generation lease state machine.
	 */
	async dispatch(workerId: string, run: (handle: DispatchHandle) => Promise<void>): Promise<void> {
		const worker = this.workers.get(workerId)
		if (worker === undefined) {
			throw new Error(`BoundedElasticScheduler.dispatch: unknown worker ${workerId}`)
		}

		const release = await this.dispatchSemaphore.acquire()

		// If the worker was cancelled/abandoned while it waited for a permit, skip
		// its loop and release the permit — exactly as TaskScheduler.schedule does.
		if (TERMINAL_STATES.has(worker.state)) {
			release()
			return
		}

		try {
			await run(this.makeHandle(worker))
		} finally {
			release()
		}
	}

	/**
	 * Subscribe to the completion event bus. The handler is invoked once per
	 * worker settle with a {@link WorkerCompletionEvent} that already reflects the
	 * applied DAG unlock. Multiple subscribers may coexist, so independent
	 * concerns (dependent unlock, evidence satisfaction, verifier / reader
	 * fan-out triggers, speculative-sibling cancellation, task-state updates) each
	 * register their own handler (PAR-004.6).
	 *
	 * Returns an idempotent unsubscribe fn so a transient observer (e.g. a batch
	 * run awaiting partial completion) can detach without disturbing the others.
	 */
	subscribeCompletion(handler: WorkerCompletionHandler): () => void {
		this.completionSubscribers.add(handler)
		let subscribed = true
		return () => {
			if (!subscribed) return
			subscribed = false
			this.completionSubscribers.delete(handler)
		}
	}

	/**
	 * Backward-compatible single-subscriber seam. Registering replaces any prior
	 * handler installed through this method and leaves {@link subscribeCompletion}
	 * subscribers untouched; passing `undefined` clears it. Prefer
	 * {@link subscribeCompletion} for new code.
	 */
	onSettled(handler: ((workerId: string, outcome: WorkerOutcome) => void) | undefined): void {
		if (this.legacyUnsubscribe !== undefined) {
			this.legacyUnsubscribe()
			this.legacyUnsubscribe = undefined
		}
		if (handler !== undefined) {
			this.legacyUnsubscribe = this.subscribeCompletion((event) => handler(event.workerId, event.outcome))
		}
	}

	/** Unsubscribe fn for the handler installed by {@link onSettled}, if any. */
	private legacyUnsubscribe?: () => void

	/**
	 * Record a worker's terminal outcome, unlock its dependents in the DAG, and
	 * publish a {@link WorkerCompletionEvent} to the completion event bus.
	 *
	 * On a successful completion the scheduler asks {@link TaskDag.unlockedBy} for
	 * the dependents whose *last* dependency this worker satisfied and transitions
	 * each from `waiting-on-dependency` to `runnable`, so a subset of a batch
	 * completing makes the dependents of the completed nodes runnable without
	 * waiting for every child (PAR-004.7). A `failed`/`cancelled` outcome does not
	 * satisfy a dependency, so no dependent is unlocked; the completion event
	 * still fires so handlers can react (e.g. mark a dependent unreachable).
	 *
	 * Settling updates only this worker's own state and the dependents it unlocks;
	 * it never touches a sibling's lease or dispatch permit (PAR-021.5). An
	 * already-terminal worker is a no-op so a double settle publishes nothing.
	 */
	onWorkerSettled(workerId: string, outcome: WorkerOutcome): void {
		const worker = this.workers.get(workerId)
		if (worker === undefined) return
		// Guard against a double settle (e.g. a late cancel after completion): a
		// worker never leaves a terminal state, and we must not unlock twice.
		if (TERMINAL_STATES.has(worker.state)) return

		worker.state = outcomeToState(outcome)
		worker.outcome = outcome
		// A settled worker holds no lease; defensively drop any dangling release.
		worker.lease = undefined
		// Record the terminal transition for timing/gauge metrics (Req 15).
		this.metricsCollector.onStateChanged(workerId, worker.state)

		// Only a successful completion satisfies a dependency and can unlock
		// dependents. unlockedBy is idempotent and returns the dependents whose
		// last dependency just completed; transition each to runnable.
		const unlockedDependents =
			outcome.kind === "completed" && this.dag !== undefined ? this.dag.unlockedBy(workerId) : []
		for (const dependentId of unlockedDependents) {
			const dependent = this.workers.get(dependentId)
			if (dependent !== undefined && dependent.state === "waiting-on-dependency") {
				dependent.state = "runnable"
				this.metricsCollector.onStateChanged(dependentId, "runnable")
			}
		}

		const event: WorkerCompletionEvent = { workerId, outcome, unlockedDependents }
		this.publishCompletion(event)
	}

	/**
	 * Split a reader's remaining bounded work into new bounded child tasks that run
	 * concurrently with the original (design §"Reader swarms, work stealing,
	 * speculation", PAR-006). When idle reader capacity appears while a reader has
	 * outstanding bounded investigation, the mastermind peels the remaining work
	 * into one or more {@link WorkSplit.children}; each becomes a new `runnable`
	 * reader `Logical_Worker` admitted exactly like a plan node — subject to
	 * `maxLive`, never rejected (over-ceiling children simply are not admitted,
	 * PAR-014.1).
	 *
	 * Every child **preserves the parent's provenance** (PAR-006.3): it carries the
	 * same `batchId` and the same `evidenceOwnerId` as the parent (so evidence
	 * ownership is unchanged), and its `parentWorkerId` is set to the parent,
	 * recording the parent/child relationship. When the parent has no provenance
	 * yet (e.g. a reader admitted before any split), a provenance is synthesized
	 * that owns its own evidence, and children inherit that.
	 *
	 * Every child also **carries forward the reader output bounds** (PAR-006.3):
	 * it inherits the parent's {@link ReaderOutputBounds} (defaulting to the shared
	 * {@link READER_OUTPUT_BOUNDS} if the parent carried none), and a child may
	 * only *tighten* a bound, never relax it — each requested bound is clamped to
	 * the parent's so a split can never raise a reader's output ceiling.
	 *
	 * The parent is left untouched: it keeps its state, lease, and dispatch permit
	 * and keeps progressing, so the children run **concurrently** with the parent's
	 * remaining work (PAR-006.2). Splitting a terminal (completed/failed/cancelled)
	 * parent is a no-op that admits nothing, since a settled reader has no
	 * outstanding work to steal.
	 *
	 * @returns the newly admitted child {@link LogicalWorker}s, in request order
	 *   (empty when the parent is terminal, unknown, or the live ceiling is full).
	 */
	stealWork(parentWorkerId: string, split: WorkSplit): LogicalWorker[] {
		const parent = this.workers.get(parentWorkerId)
		if (parent === undefined) {
			throw new Error(`BoundedElasticScheduler.stealWork: unknown worker ${parentWorkerId}`)
		}
		// A settled reader has no outstanding work to steal; never resurrect it or
		// disturb its recorded outcome.
		if (TERMINAL_STATES.has(parent.state)) return []

		// Backpressure: a work-stealing split is NEW logical fan-out, so under
		// sustained OmniRoute pressure admit no children (PAR-012.1, PAR-012.3).
		// The parent is read above but never paused or mutated here — throttling
		// new fan-out never disturbs the in-flight worker (PAR-012.3).
		if (!this.shouldAdmitNewFanOut()) return []

		// Preserve the parent's provenance across the split (PAR-006.3). Synthesize
		// one owning its own evidence if the parent carried none, so children still
		// share a single evidence owner and batch.
		const parentProvenance = parent.provenance ?? {
			batchId: parent.id,
			evidenceOwnerId: parent.id,
		}
		parent.provenance = parentProvenance

		// Children inherit (and may only tighten) the parent's reader bounds.
		const parentBounds = parent.readerBounds ?? READER_OUTPUT_BOUNDS
		parent.readerBounds = parentBounds

		const admitted: LogicalWorker[] = []
		for (const child of split.children) {
			// Respect the live ceiling exactly like admitPlan: never admit beyond
			// maxLive, never manufacture filler (PAR-014.1).
			if (this.workers.size >= this.bounds.maxLive) break
			if (this.workers.has(child.id)) {
				throw new Error(
					`BoundedElasticScheduler.stealWork: child id ${child.id} collides with an existing worker`,
				)
			}

			const childWorker: LogicalWorker = {
				id: child.id,
				// Bounded reader child, runnable immediately so it runs concurrently
				// with the parent's remaining work (PAR-006.1, PAR-006.2).
				state: "runnable",
				priority: parent.priority,
				deps: [parentWorkerId],
				speculative: parent.speculative,
				provenance: {
					// Same batch + evidence owner as the parent; parentWorkerId records
					// the parent/child relationship (PAR-006.3).
					batchId: parentProvenance.batchId,
					evidenceOwnerId: parentProvenance.evidenceOwnerId,
					parentWorkerId,
				},
				readerBounds: tightenReaderBounds(parentBounds, child.bounds),
			}
			this.workers.set(child.id, childWorker)
			admitted.push(childWorker)
			// A stolen child is a newly created reader worker (Req 15.1).
			this.metricsCollector.onWorkerCreated(child.id, "runnable")
		}
		// Record the work-stealing operation and the reader-swarm size it produced
		// (Req 15.2, Req 15.4). Only count when children were actually admitted so a
		// no-op split (terminal/ceiling-full) adds nothing.
		if (admitted.length > 0) {
			this.metricsCollector.onWorkStealing(admitted.length)
			this.metricsCollector.onReaderSwarm(admitted.length)
		}
		return admitted
	}

	/**
	 * Admit a speculative branch that investigates one hypothesis concurrently with
	 * other work (design §"Reader swarms, work stealing, speculation", PAR-007). The
	 * branch is admitted at `speculative` priority — strictly below critical-path
	 * work (PAR-007.3) — and owns a dedicated {@link AbortController} so it can be
	 * cancelled in isolation, mirroring the per-batch controller in
	 * `runParallelTasks`. Its signal is returned so the dispatched agent loop can
	 * wire it into generation/tool calls; aborting it later via
	 * {@link cancelSpeculativeBranch} tears down only this branch.
	 *
	 * The branch is admitted exactly like a plan node — subject to `maxLive`, never
	 * rejected (an over-ceiling branch simply is not admitted, PAR-014.1) — and
	 * `runnable` immediately so it runs concurrently. When `provenance` is omitted,
	 * one owning the branch's own evidence is synthesized so partial evidence has a
	 * stable owner that survives cancellation (PAR-007.5).
	 *
	 * @returns the admitted {@link LogicalWorker} and its branch {@link AbortSignal},
	 *   or `undefined` when the id collides or the live ceiling is full.
	 */
	admitSpeculativeBranch(spec: {
		readonly id: string
		readonly hypothesis: string
		readonly deps?: readonly string[]
		readonly provenance?: WorkerProvenance
	}): { readonly worker: LogicalWorker; readonly signal: AbortSignal } | undefined {
		if (this.workers.has(spec.id)) {
			throw new Error(
				`BoundedElasticScheduler.admitSpeculativeBranch: id ${spec.id} collides with an existing worker`,
			)
		}
		// Respect the live ceiling exactly like admitPlan: never admit beyond
		// maxLive, never manufacture filler (PAR-014.1).
		if (this.workers.size >= this.bounds.maxLive) return undefined

		// Backpressure: a speculative branch is NEW logical fan-out, so admit none
		// under sustained OmniRoute pressure (PAR-012.1, PAR-012.3). No in-flight
		// worker is read or mutated here, so throttling never disturbs live work.
		if (!this.shouldAdmitNewFanOut()) return undefined

		const abort = new AbortController()
		const worker: LogicalWorker = {
			id: spec.id,
			// Below critical-path work; speculation never delays the architect or a
			// required verifier (PAR-007.3, PAR-010.5).
			state: "runnable",
			priority: "speculative",
			deps: spec.deps ?? [],
			speculative: true,
			hypothesis: spec.hypothesis,
			// A stable evidence owner so partial evidence survives cancellation.
			provenance: spec.provenance ?? { batchId: spec.id, evidenceOwnerId: spec.id },
			abort,
		}
		this.workers.set(spec.id, worker)
		// Record the created speculative worker and open its speculation record so
		// the branch's hypothesis/duration/tokens are tracked (Req 15.1, Req 18.1).
		this.metricsCollector.onWorkerCreated(spec.id, "runnable")
		this.metricsCollector.onSpeculationStarted(spec.id, spec.hypothesis)
		return { worker, signal: abort.signal }
	}

	/**
	 * Accumulate generated tokens against a speculative branch's value record
	 * (Req 18.1). The dispatched agent loop calls this as it generates so the
	 * speculation's `tokenCount` reflects how much work the hypothesis cost.
	 */
	recordSpeculativeTokens(workerId: string, tokens: number): void {
		this.metricsCollector.addSpeculationTokens(workerId, tokens)
	}

	/**
	 * Record whether a speculative branch's result affected the final decision
	 * (Req 18.2). Called when the final outcome is known so the speculation record
	 * reflects whether the hypothesis was worthwhile.
	 */
	markSpeculationAffectedFinalDecision(workerId: string, affected: boolean): void {
		this.metricsCollector.onSpeculationSettled(workerId, {
			affectedFinalDecision: affected,
			cancelledEarly: false,
		})
	}

	/**
	 * Cancel one speculative branch in isolation because its hypothesis was
	 * eliminated (design §"Reader swarms, work stealing, speculation", PAR-007).
	 *
	 * This aborts **only** this branch's own {@link AbortController} (tearing down
	 * its in-flight generation/tool work) and settles it through
	 * {@link onWorkerSettled} as `{ kind: "cancelled", reason:
	 * "hypothesis-eliminated" }` — never `failed` (PAR-007.6). It touches no
	 * sibling, no parent, no other branch, and no persisted evidence: the branch's
	 * accumulated `provenance`/`outcome` evidence is left in place and no other
	 * worker's lease, dispatch permit, or state is read or mutated (PAR-007.4,
	 * PAR-007.5). An unknown, non-speculative, or already-terminal worker is a
	 * no-op so a late or duplicate elimination cancels nothing extra.
	 *
	 * @returns `true` when a live speculative branch was cancelled, `false` otherwise.
	 */
	cancelSpeculativeBranch(workerId: string): boolean {
		const worker = this.workers.get(workerId)
		// Only a live speculative branch may be cancelled here; a non-speculative or
		// already-settled worker is left untouched (its outcome/evidence is durable).
		if (worker === undefined || !worker.speculative || TERMINAL_STATES.has(worker.state)) {
			return false
		}

		// Abort only this branch's controller — isolated cancellation that never
		// reaches a sibling, the parent, or another branch (PAR-007.4). Guard the
		// optional controller so a branch admitted without one still settles.
		worker.abort?.abort(new Error("Speculative branch cancelled: hypothesis eliminated"))

		// Record the speculative cancellation and finalize the branch's speculation
		// record as cancelled early (Req 15.4, Req 18.2). A branch cancelled before
		// it settled on its own never affected the final decision.
		this.metricsCollector.onSpeculativeCancellation()
		this.metricsCollector.onSpeculationSettled(workerId, {
			affectedFinalDecision: false,
			cancelledEarly: true,
		})

		// Settle as cancelled/hypothesis-eliminated — never failed (PAR-007.6).
		// onWorkerSettled updates only this worker and the dependents it unlocks (a
		// cancellation unlocks none), preserving its partial evidence (PAR-007.5).
		this.onWorkerSettled(workerId, { kind: "cancelled", reason: "hypothesis-eliminated" })
		return true
	}

	/**
	 * Deliver a completion event to every subscriber. Each subscriber is isolated:
	 * a throwing handler neither blocks nor is observed by the others, and the
	 * worker has already settled, so a handler error never corrupts scheduler
	 * state. We iterate a snapshot so a handler may (un)subscribe during delivery.
	 */
	private publishCompletion(event: WorkerCompletionEvent): void {
		for (const subscriber of [...this.completionSubscribers]) {
			try {
				subscriber(event)
			} catch {
				// A faulty subscriber must not stall the bus or abort a settle. The
				// settle itself is already durable; swallow and continue.
			}
		}
	}

	/** Read-only observable states for the observatory (Req 20). */
	snapshotStates(): ReadonlyMap<string, LogicalWorkerState> {
		const snapshot = new Map<string, LogicalWorkerState>()
		for (const [id, worker] of this.workers) {
			snapshot.set(id, worker.state)
		}
		return snapshot
	}

	/**
	 * Cancel all queued/runnable waiters. Rejects dispatch-semaphore and
	 * lease-pool waiters without touching any held dispatch permit or lease, so a
	 * running sibling keeps progressing (PAR-021.5). Non-terminal workers that
	 * are not actively progressing (queued/runnable/waiting-*) are marked
	 * `cancelled`; a `generating`/`running-tool`/`waiting-on-tool` worker holding
	 * resources is left to settle on its own.
	 */
	cancelQueued(): void {
		this.dispatchSemaphore.cancel()
		for (const pool of this.leasePools.values()) {
			pool.cancelWaiters()
		}
		for (const worker of this.workers.values()) {
			if (isCancellableWhileQueued(worker.state)) {
				worker.state = "cancelled"
				worker.outcome = { kind: "cancelled", reason: "parent-stopped" }
				this.metricsCollector.onStateChanged(worker.id, "cancelled")
			}
		}
	}

	/** Lazily create (and cache) the lease pool for a capability. */
	private leasePoolFor(capability: RouteCapability): InferenceLeasePool {
		let pool = this.leasePools.get(capability)
		if (pool === undefined) {
			pool = new InferenceLeasePool(capability, this.routes)
			this.leasePools.set(capability, pool)
		}
		return pool
	}

	/**
	 * Build the {@link DispatchHandle} for one worker. `acquireLease` runs the
	 * lease state machine: the worker moves to `waiting-for-inference` while it
	 * blocks for a lease (surfaced as "Runnable — waiting for inference
	 * capacity", PAR-011.3), to `generating` once the lease is held (PAR-008.2),
	 * and back to `runnable` when the generation ends (PAR-008.3). The lease is
	 * never held outside `generating` (PAR-001.4, PAR-008.4).
	 */
	private makeHandle(worker: LogicalWorker): DispatchHandle {
		return {
			workerId: worker.id,
			get state() {
				return worker.state
			},
			acquireLease: async (capability: RouteCapability, signal: AbortSignal): Promise<() => void> => {
				const pool = this.leasePoolFor(capability)
				// Sample route capacity read for this acquisition (Req 15.5) and tell
				// the metrics whether critical-path capacity is currently unavailable
				// so Critical_Path_Idle can accumulate while a critical worker waits
				// (Req 17.1). Both record capability/capacity only (PAR-019.3).
				this.sampleRouteCapacity(capability)
				this.metricsCollector.setCriticalPathCapacityAvailable(pool.available > 0)

				// Blocking for a lease keeps the worker runnable, never rejected: it is
				// observably "waiting for inference capacity" until the lease frees.
				if (worker.state === "runnable") {
					worker.state = "waiting-for-inference"
					this.metricsCollector.onStateChanged(worker.id, "waiting-for-inference")
				}

				let release: () => void
				try {
					// Pass critical-path membership as a within-priority tiebreaker so a
					// critical-path worker is admitted ahead of a non-critical-path peer
					// at the same nominal priority (PAR-010.4), without ever reordering
					// across priorities (PAR-010.5).
					release = await pool.acquire(worker.priority, signal, worker.criticalPath === true)
				} catch (error) {
					// A delay/abort while waiting is not a worker failure: it stays
					// runnable so a later generation can retry (Property 10, PAR-003.6).
					if (worker.state === "waiting-for-inference") {
						worker.state = "runnable"
						this.metricsCollector.onStateChanged(worker.id, "runnable")
					}
					throw error
				}

				// Lease held ⇒ generating (the only lease-holding state). The lease was
				// granted, so critical-path capacity is momentarily available again.
				worker.state = "generating"
				worker.lease = release
				this.metricsCollector.onStateChanged(worker.id, "generating")
				this.metricsCollector.setCriticalPathCapacityAvailable(pool.available > 0)

				let released = false
				return () => {
					if (released) return
					released = true
					release()
					worker.lease = undefined
					// Generation ended; return to runnable unless the worker already
					// settled (e.g. attempt_completion recorded a terminal state).
					if (!TERMINAL_STATES.has(worker.state)) {
						worker.state = "runnable"
						this.metricsCollector.onStateChanged(worker.id, "runnable")
					}
					// A freed lease may make critical-path capacity available again.
					this.metricsCollector.setCriticalPathCapacityAvailable(pool.available > 0)
				}
			},
		}
	}
}

/**
 * Clamp a scheduler bound by an optional policy ceiling. An absent ceiling means
 * "no additional limit beyond the scheduler default"; a present ceiling never
 * raises the bound above the default, only lowers it (PAR-014.1). Both are
 * floored at 1 so a degenerate policy can never admit zero workers.
 */
function clampCeiling(bound: number, ceiling: number | undefined): number {
	const limited = ceiling === undefined ? bound : Math.min(bound, ceiling)
	return Math.max(1, limited)
}

/**
 * Carry a reader's output bounds forward onto a work-stealing child. A child may
 * only *tighten* a bound, never relax it, so each requested field is clamped to
 * the parent's value and an absent/invalid request inherits the parent's bound
 * unchanged. This guarantees a split can never raise a reader's output ceiling
 * (PAR-006.3).
 */
function tightenReaderBounds(parent: ReaderOutputBounds, requested?: Partial<ReaderOutputBounds>): ReaderOutputBounds {
	return {
		maxDocumentBytes: tightenBound(parent.maxDocumentBytes, requested?.maxDocumentBytes),
		maxExcerptChars: tightenBound(parent.maxExcerptChars, requested?.maxExcerptChars),
	}
}

/** Clamp one requested bound to the parent's; inherit the parent's when absent/invalid. */
function tightenBound(parentBound: number, requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) return parentBound
	return Math.min(parentBound, requested)
}

/** Map a terminal {@link WorkerOutcome} onto its settled {@link LogicalWorkerState}. */
function outcomeToState(outcome: WorkerOutcome): LogicalWorkerState {
	switch (outcome.kind) {
		case "completed":
			return "completed"
		case "failed":
			return "failed"
		case "cancelled":
			return "cancelled"
	}
}

/**
 * A worker not actively holding a lease or dispatch slot — queued, runnable, or
 * waiting — may be cancelled when the batch is cancelled. A worker that is
 * `generating`/`running-tool`/`waiting-on-tool`/`verifying` holds resources and
 * is left to settle on its own so cancellation never abandons siblings.
 */
function isCancellableWhileQueued(state: LogicalWorkerState): boolean {
	return (
		state === "queued" ||
		state === "runnable" ||
		state === "waiting-for-inference" ||
		state === "waiting-on-dependency" ||
		state === "waiting-for-user"
	)
}
