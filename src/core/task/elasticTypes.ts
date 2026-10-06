import { z } from "zod"

import type { HistoryItemStatus } from "../task-persistence/taskLifecycle"
import type { ParallelTaskSpec } from "../tools/ParallelTasksTool"

/**
 * Data models for the elastic logical execution fabric (FEAT-010 + FEAT-012).
 *
 * These types describe the scheduler-internal shapes consumed by
 * `BoundedElasticScheduler`, `TaskDag`, and `InferenceLeasePool`. Every
 * scheduling decision reads only route capability/capacity abstractions
 * (`RouteCapacity`); nothing here models GPU, VRAM, CUDA, or node identity
 * (design §"No GPU-aware logic", PAR-013).
 */

/**
 * The twelve states a `Logical_Worker` can occupy; it is always in exactly one
 * (PAR-001.6). `generating` is the only state that holds an `Inference_Lease`
 * (PAR-001.4, PAR-008.2, PAR-008.4).
 */
export type LogicalWorkerState =
	| "queued"
	| "runnable"
	| "waiting-for-inference"
	| "generating"
	| "running-tool"
	| "waiting-on-tool"
	| "waiting-on-dependency"
	| "waiting-for-user"
	| "verifying"
	| "completed"
	| "failed"
	| "cancelled"

/**
 * Relative admission priority used when inference capacity is constrained;
 * `background`/`speculative` may never delay the architect or a required
 * verifier (PAR-010.5).
 */
export type SchedulingPriority = "critical" | "high" | "normal" | "background" | "speculative"

/**
 * Route capability class exposed by OmniRoute. The scheduler branches only on
 * this abstraction, never on physical identity (PAR-013).
 */
export type RouteCapability = "reader" | "reasoner" | "long-context" | "vision" | "general"

/**
 * A read-only capacity snapshot for one route, as exposed by OmniRoute. The
 * lease pool consumes `available`/`capacity` to decide whether a lease may be
 * granted (PAR-002.3) and never derives placement from it (PAR-002.4,
 * PAR-002.5).
 */
export interface RouteCapacity {
	route: string
	capacity: number
	available: number
	capability: RouteCapability
	pressure?: number
}

/**
 * Read-only adapter over the OmniRoute-exposed `RouteCapacity`. Menagerie reads
 * it; it never writes it and never derives GPU placement from it.
 */
export interface RouteCapacityProvider {
	/** Current capacity snapshot per capability. */
	capacitiesFor(capability: RouteCapability): readonly RouteCapacity[]
	/** Aggregate backpressure signal; sustained high pressure throttles new fan-out only. */
	sustainedPressure(): number
}

/** Reader provenance preserved across work-stealing splits (PAR-006.3). */
export interface WorkerProvenance {
	parentWorkerId?: string
	batchId: string
	/** Evidence ownership: which worker owns results, preserved across splits. */
	evidenceOwnerId: string
}

/**
 * The bounded-output contract a reader `Logical_Worker` is held to, carried
 * forward onto every work-stealing child so a split never relaxes a reader's
 * output bounds (PAR-006.3). The field semantics mirror the reader fan-out's
 * `MAX_READER_DOCUMENT_BYTES` / `MAX_READER_EXCERPT_CHARS` in
 * {@link import("./ParallelTaskReader")}: `maxDocumentBytes` caps the size of a
 * source document a reader will ingest; `maxExcerptChars` caps the excerpt the
 * reader is allowed to emit. Children inherit the parent's bounds exactly.
 */
export interface ReaderOutputBounds {
	/** Max bytes of a source document a bounded reader will ingest. */
	readonly maxDocumentBytes: number
	/** Max characters of excerpt a bounded reader may emit. */
	readonly maxExcerptChars: number
}

/**
 * The shared reader output-bounds contract. These are the authoritative values
 * the reader fan-out (`ParallelTaskReader`) and the scheduler's work-stealing
 * split both hold readers to, so a stolen child is bounded identically to its
 * parent (PAR-006.3). 48 KiB per source document; 10 000 characters of excerpt.
 */
export const READER_OUTPUT_BOUNDS: ReaderOutputBounds = {
	maxDocumentBytes: 48 * 1024,
	maxExcerptChars: 10_000,
}

/**
 * One child scope carved out of a parent reader's remaining bounded work by a
 * {@link WorkSplit}. Each child becomes a new bounded reader `Logical_Worker`
 * that runs concurrently with the parent (PAR-006.1, PAR-006.2). A child names
 * only the slice of remaining investigation it owns; it never widens the
 * parent's scope.
 */
export interface WorkSplitChild {
	/**
	 * Unique id for the child worker. Must not collide with an existing worker;
	 * conventionally derived from the parent id (e.g. `${parentId}#steal-1`).
	 */
	readonly id: string
	/**
	 * Optional per-child output bounds. Absent means "inherit the parent's reader
	 * bounds"; present bounds may only tighten, never relax, the parent's — the
	 * scheduler clamps each field to the parent's value so a split can never
	 * raise a reader's output ceiling (PAR-006.3).
	 */
	readonly bounds?: Partial<ReaderOutputBounds>
}

/**
 * The description the scheduler consumes to split a reader's outstanding bounded
 * investigation into new bounded child tasks (design §Components, `WorkSplit`;
 * PAR-006). The parent keeps running; `children` names the slices to peel off
 * into concurrent bounded readers. The scheduler preserves the parent's
 * {@link WorkerProvenance} (same `batchId`, same `evidenceOwnerId`, with each
 * child's `parentWorkerId` set to the parent) and the reader output bounds on
 * every child (PAR-006.3).
 */
export interface WorkSplit {
	/** The child scopes to admit, each a bounded concurrent reader. */
	readonly children: readonly WorkSplitChild[]
}

/** Terminal outcome of a settled `Logical_Worker`. */
export type WorkerOutcome =
	| { kind: "completed"; resultRef: string }
	| { kind: "failed"; error: string }
	| { kind: "cancelled"; reason: "parent-stopped" | "hypothesis-eliminated" | "superseded" }

/**
 * The event the completion bus publishes when a `Logical_Worker` settles
 * (design §"Event-driven DAG", PAR-004.6). Subscribers act on each event as it
 * arrives — there is no barrier that waits for every child in the batch to
 * complete (PAR-004.7, partial batch completion).
 *
 * The scheduler has already applied the DAG unlock before publishing, so
 * `unlockedDependents` names exactly the nodes whose *last* dependency was this
 * worker and that the scheduler has transitioned to `runnable`. Handlers may use
 * the event to satisfy accumulated evidence, trigger a verifier, trigger a new
 * reader fan-out, cancel speculative siblings, or update task state.
 */
export interface WorkerCompletionEvent {
	/** The worker that just settled. */
	readonly workerId: string
	/** Its terminal outcome. */
	readonly outcome: WorkerOutcome
	/**
	 * Dependents the scheduler just transitioned from `waiting-on-dependency` to
	 * `runnable` because this worker's completion satisfied their last
	 * dependency. Empty when the worker had no dependents, when its completion
	 * left dependents still blocked by another dependency, or when the worker did
	 * not complete successfully.
	 */
	readonly unlockedDependents: readonly string[]
}

/**
 * A completion-event subscriber. Returning a value is ignored; a subscriber that
 * needs to perform async work (trigger a verifier, fan out readers) should fire
 * it without blocking the publish loop so one slow handler cannot stall the
 * delivery of an event to other subscribers.
 */
export type WorkerCompletionHandler = (event: WorkerCompletionEvent) => void

/**
 * Scheduler-held metadata for one logical worker. One `Logical_Worker` maps to
 * one underlying `Task` runtime (the child created by
 * `provider.createParallelTaskRuntime`); the scheduler holds the logical
 * metadata, the `Task` holds the agent loop.
 */
export interface LogicalWorker {
	id: string
	/** The underlying Task runtime id (child.taskId) once instantiated. */
	taskId?: string
	state: LogicalWorkerState
	priority: SchedulingPriority
	/**
	 * True when this worker sits on the DAG's critical path (the longest
	 * dependency chain). At equal nominal {@link priority}, a critical-path
	 * worker is admitted to inference ahead of a non-critical-path peer
	 * (PAR-010.3, PAR-010.4). It never reorders across priorities, so it can
	 * never let `background`/`speculative` work jump the architect or a required
	 * verifier (PAR-010.5).
	 */
	criticalPath?: boolean
	/** Ids of workers that must complete before this one is runnable. */
	deps: readonly string[]
	/** Held iff state === "generating". A release fn, absent otherwise. */
	lease?: () => void
	/** True for speculative branches; drives isolated cancellation + outcome labeling. */
	speculative: boolean
	/** For a speculative worker, the hypothesis under test (recorded in metrics). */
	hypothesis?: string
	/**
	 * Per-branch cancellation controller for a speculative worker, mirroring the
	 * per-batch controller in `runParallelTasks`. Aborting it cancels only this
	 * branch's agent loop in isolation; a non-speculative worker carries none, and
	 * the scheduler never aborts a sibling's, the parent's, or another branch's
	 * controller when eliminating one hypothesis (PAR-007.4).
	 */
	abort?: AbortController
	/** Reader provenance preserved across work-stealing splits. */
	provenance?: WorkerProvenance
	/**
	 * The bounded-output contract this worker is held to, present for reader
	 * workers. Work-stealing children inherit (and may only tighten) the
	 * parent's bounds (PAR-006.3).
	 */
	readerBounds?: ReaderOutputBounds
	outcome?: WorkerOutcome
}

/**
 * The decomposition the mastermind hands the scheduler. `dependencies` compiles
 * into the `Task_DAG`; `parallelGroups` names task sets that may run
 * concurrently.
 */
export interface ExecutionPlan {
	tasks: ParallelTaskSpec[]
	/** Optional groups of task names that may run concurrently. */
	parallelGroups?: string[][]
	/** Edges: each entry names a dependent and the dependencies it waits on. */
	dependencies?: Array<{ dependent: string; dependsOn: string[] }>
}

/**
 * Admission bounds. `maxLive` and `maxDispatched` are configurable (PAR-003.4)
 * and each clamped to the `User_Parallelism_Policy` ceiling for the exact
 * submitted request (PAR-014.1). `maxInferenceLeases` is supplied by OmniRoute
 * capacity, not a fixed local number.
 */
export interface SchedulerBounds {
	/** Max live Logical_Workers (queued..verifying). Default 12, bounded by policy. */
	maxLive: number
	/** Max concurrently dispatched (progressing) Logical_Workers. Default 8, bounded by policy. */
	maxDispatched: number
	/** Max concurrent Inference_Leases (generations). Supplied by OmniRoute capacity. */
	maxInferenceLeases: number
}

/**
 * The per-request ceiling supplied by FEAT-011 (`user-controlled-parallelism`).
 *
 * The owning spec defines the full policy; the scheduler consumes it read-only
 * as an upper bound, so this is a minimal structural consumption shape, not the
 * authoritative definition. Each field is optional because a policy may leave a
 * dimension unconstrained; readers treat an absent field as "no additional
 * ceiling beyond the scheduler defaults".
 */
export interface UserParallelismPolicy {
	/** Ceiling on live Logical_Workers (clamps `SchedulerBounds.maxLive`). */
	readonly maxLive?: number
	/** Ceiling on concurrently dispatched Logical_Workers (clamps `maxDispatched`). */
	readonly maxDispatched?: number
	/** Ceiling on the reader-swarm fan-out size. */
	readonly maxReaderSwarm?: number
	/** Ceiling on concurrent speculative branches. */
	readonly maxSpeculativeBranches?: number
	/** Ceiling on concurrent work-stealing splits. */
	readonly maxWorkStealing?: number
}

/** The scheduler's effective configuration: bounds plus the policy ceiling. */
export interface SchedulerConfig {
	/** maxLive=12, maxDispatched=8 defaults, each bounded by policy. */
	bounds: SchedulerBounds
	/** From FEAT-011; an upper bound, not defined here. */
	policy: UserParallelismPolicy
}

/**
 * Shared default admission bounds: 12 live logical workers, 8 dispatched. These
 * replace the fixed four-worker pool. `maxInferenceLeases` is intentionally
 * omitted because it is supplied by OmniRoute capacity at construction, not a
 * fixed local number (design §SchedulerBounds).
 */
export const DEFAULT_SCHEDULER_BOUNDS: Pick<SchedulerBounds, "maxLive" | "maxDispatched"> = {
	maxLive: 12,
	maxDispatched: 8,
}

/** The five route capability values, as a runtime tuple for the zod enum. */
export const ROUTE_CAPABILITIES = ["reader", "reasoner", "long-context", "vision", "general"] as const

/**
 * Runtime validator for a `RouteCapacity` snapshot read from OmniRoute. Requires
 * `route`, `capacity`, `available`, and `capability`; `pressure` is optional and
 * `capability` is restricted to the five {@link ROUTE_CAPABILITIES} values.
 */
export const routeCapacitySchema = z
	.object({
		route: z.string().min(1),
		capacity: z.number(),
		available: z.number(),
		capability: z.enum(ROUTE_CAPABILITIES),
		pressure: z.number().optional(),
	})
	.strict()

/**
 * Map a scheduler-internal {@link LogicalWorkerState} onto the persisted task
 * lifecycle status its underlying `Task` carries, at the only boundaries the
 * lifecycle model must prove (design §"Lifecycle integration"; Req 21.4).
 *
 * The twelve logical-worker states are scheduler-internal and are **not**
 * persisted individually. A worker's underlying `Task` is persisted as `active`
 * while the worker occupies any non-terminal running state, and `completed` on
 * success. The persisted `delegated`/`interrupted` statuses belong to the
 * parent↔child delegation handshake and are produced solely by the existing
 * reducers in {@link import("../task-persistence/taskLifecycle")}
 * (`delegateTaskToChild`/`interruptDelegatedChild`/`completeDelegatedChild`/
 * `abandonDelegatedChild`); this mapping never manufactures them from a worker
 * state.
 *
 * `failed` and `cancelled` deliberately return `undefined`: they introduce **no**
 * new persisted status. A failed or cancelled worker's `Task` settles through the
 * existing abort/cancel and failure paths (and, for a delegated child, through the
 * existing reducers), never through a scheduler-synthesized `completed`. Returning
 * `undefined` makes that boundary explicit and keeps callers from persisting a
 * terminal status the lifecycle model does not own. This adds no entry to
 * `VALID_TASK_STATUS_TRANSITIONS` and no new reducer.
 *
 * @returns the persisted {@link HistoryItemStatus} for a mapped state, or
 *   `undefined` for `failed`/`cancelled`, which flow through existing paths.
 */
export function logicalWorkerStateToLifecycleStatus(state: LogicalWorkerState): HistoryItemStatus | undefined {
	switch (state) {
		// Every non-terminal running state maps onto the persisted `active` status;
		// the worker's underlying Task is alive and progressing.
		case "queued":
		case "runnable":
		case "waiting-for-inference":
		case "generating":
		case "running-tool":
		case "waiting-on-tool":
		case "waiting-on-dependency":
		case "waiting-for-user":
		case "verifying":
			return "active"
		// Terminal success persists as `completed`.
		case "completed":
			return "completed"
		// Terminal failure/cancellation introduce no new persisted status; they
		// settle through the existing cancel/fail and reducer paths.
		case "failed":
		case "cancelled":
			return undefined
	}
}
