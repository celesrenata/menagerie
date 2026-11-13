import path from "node:path"
import crypto from "node:crypto"
import * as fs from "node:fs/promises"
import { RooCodeEventName, type VerificationPolicy } from "@roo-code/types"
import type { Task } from "./Task"
import type { ClineProvider } from "../webview/ClineProvider"
import type { ParallelTaskSpec, NodeCapabilityRequirement } from "../tools/ParallelTasksTool"
import { buildExecutionPlan, readNodeCapabilityRequirement } from "../tools/ParallelTasksTool"
import type { CapabilityBroker, GrantOutcome } from "../capability/capabilityBroker"
import { createCapabilityBroker } from "../capability/capabilityBroker"
import type { ToolCapabilityId } from "../capability/toolCapability"
import type { ComposedToolSurface } from "../capability/schemaComposer"
import {
	createComposedSurfaceApplier,
	type AppliedComposedSurface,
	type ComposedSurfaceApplier,
} from "../capability/composedMcpView"
import type { AutonomousTaskStateWithCapabilities } from "../capability/capabilityStatePersistence"
import { getAutonomousTaskState } from "./autonomousTaskState"
import {
	assignLanes,
	collectCodeCapableRouteIds,
	defaultLaneTaskType,
	produceDeeperLaneFollowUp,
	resolveLaneRouteId,
	resolvePublishedLaneRoute,
} from "./parallelWorkerRouting"
import { laneToRouteCapability } from "./capabilityLanes"
import {
	computeCapacityBounds,
	createPublishedRouteCapacityProvider,
	createStaticRouteCapacityProvider,
	extractPublishedRouteMetadata,
	mergeRouteCapacityMap,
} from "./routeCapacityMap"
import { getPublishedCatalogEntries, isOmniRoute, refreshPublishedCatalogIfStale } from "../../api/providers/omniroute"
import { normalizeWorkerResult } from "./normalizeWorkerResult"
import type { WorkerResultWithRecovery } from "./recoveryTelemetry"
import { pruneParallelTaskBatches } from "./parallelTaskRetention"
import { AUTO_READER_NAME } from "./ParallelTaskReader"
import { snapshotWorkingTree, createParallelWorkspace, exportParallelPatch } from "./ParallelTaskWorkspace"
import { boundErrorText } from "./boundErrorText"
import {
	AUDIT_SKIPPED_WARNING,
	AUDIT_VERIFIER_MODE,
	auditTerminalState,
	buildVerifierMessage,
	isVerifierModeUsable,
	resolveAuditPolicy,
	runAuditLoop,
	type AuditRecord,
} from "./auditLoop"
import { getModeBySlug } from "../../shared/modes"
import { groupsCanEdit } from "../specs/workflowPolicyGuard"
import { BoundedElasticScheduler } from "./BoundedElasticScheduler"
import type { InferenceLeasePool } from "./InferenceLeasePool"
import type { LaneSelection } from "./parallelWorkerRouting"
import {
	type ExecutionPlan,
	type RouteCapability,
	type UserParallelismPolicy,
	type WorkerOutcome,
} from "./elasticTypes"

export interface ParallelTaskResult {
	name: string
	mode: string
	state: "completed" | "failed" | "cancelled"
	taskId?: string
	profile?: string
	workspace?: string
	patch?: string
	result?: string
	error?: string
	/** Present when the worker was audited (verify, send back, escalate). */
	audit?: AuditRecord
	/** Present when an audit was due but skipped because the verifier mode is unavailable. */
	auditWarning?: string
}

/**
 * The outcome of provisioning a DAG node's declared required capabilities
 * before its worker's first generation (FEAT-013, MCP-016). Provisioning
 * activates only the subset that passes policy; each withheld capability is
 * recorded with its denial `GrantOutcome` so the caller can surface a clear
 * reason rather than a silent omission. The passing capabilities are the ones
 * the broker moved into ACTIVE.
 */
export interface ProvisioningOutcome {
	readonly workerId: string
	/** Capabilities the broker moved to ACTIVE (the passing subset). */
	readonly activated: ToolCapabilityId[]
	/** Per-capability grant outcomes for every withheld required capability. */
	readonly withheld: ReadonlyArray<{ capability: ToolCapabilityId; outcome: GrantOutcome }>
}

/**
 * Provision a worker's DAG-declared required capabilities BEFORE its first
 * generation (FEAT-013, MCP-016). Each required capability is evaluated through
 * the broker's policy path (`requestCapability` with `requestedBy: "scheduler"`);
 * the passing ones transition to ACTIVE while each withheld capability is
 * recorded with its denial outcome. Only the passing subset is provisioned —
 * a denial for one capability never blocks the others.
 *
 * This is a pure, injectable helper that takes the broker and the required set
 * so it is unit-testable without a running runtime. It is the integration seam
 * for task 13.1: once the broker is instantiated inside the runtime, call this
 * for each worker before dispatching its agent loop. In-execution
 * `capability.request` for an UNDECLARED capability still runs through the exact
 * same policy path via the broker, so lazy acquisition is unaffected.
 *
 * Scope hints from the DAG node are forwarded verbatim to the matching required
 * capability request; the broker preserves a granted scope and never widens it.
 *
 * `role` (the worker's mode, e.g. `"project-reader"`) is forwarded into each
 * request so reader isolation applies at the runtime authorization layer: a
 * `project-reader` / `reader.*` worker is denied write/execute/mutate
 * capabilities regardless of relevance (Requirement 6.1/6.2). When omitted, the
 * request carries no role and the policy engine applies no reader forbidding.
 */
export async function provisionWorkerCapabilities(
	broker: CapabilityBroker,
	workerId: string,
	requirement: NodeCapabilityRequirement | undefined,
	taskId: string,
	role?: string,
): Promise<ProvisioningOutcome> {
	const activated: ToolCapabilityId[] = []
	const withheld: Array<{ capability: ToolCapabilityId; outcome: GrantOutcome }> = []
	const required = requirement?.required ?? []
	for (const capability of required) {
		const scope = requirement?.scopeHints?.[capability]
		const outcome = await broker.requestCapability({
			capability,
			taskId,
			workerId,
			requestedBy: "scheduler",
			reason: "provisioned required capability before first generation",
			...(role !== undefined ? { role } : {}),
			...(scope !== undefined ? { scope } : {}),
		})
		if (outcome.result === "activated") {
			activated.push(capability)
		} else {
			withheld.push({ capability, outcome })
		}
	}
	return { workerId, activated, withheld }
}

/**
 * The per-worker broker wiring handed back to the runtime after a worker's
 * broker is instantiated (task 13.1). `broker` owns this one worker's
 * broker-scoped lease set; `applier` threads each freshly composed surface into
 * the prompt layer (filtered `McpHub` view + `disabledTools`); `currentSurface`
 * reads the last composed {@link AppliedComposedSurface} the generation path
 * must enforce; and `releaseAtBoundary` transitions this worker's leases to
 * `released` at the declared boundary so released schemas drop from the next
 * composition.
 */
export interface WorkerBrokerWiring {
	readonly broker: CapabilityBroker
	/**
	 * Threads each freshly composed surface into the prompt layer (filtered
	 * `McpHub` view + `disabledTools`). Absent when no `McpHub` is reachable for
	 * the worker (nothing to filter), in which case `currentSurface()` is
	 * `undefined` and the child composes its unfiltered surface.
	 */
	readonly applier?: ComposedSurfaceApplier
	/** The last successfully applied composed surface, or `undefined` before the first compose. */
	currentSurface(): AppliedComposedSurface | undefined
	/**
	 * Release every lease whose declared lifetime matches `boundary` (and every
	 * shorter-lived lease), moving them out of ACTIVE so their schemas disappear
	 * from the next composed surface. `task-complete` is the batch-level boundary
	 * reached when the worker's loop settles; `tool-complete`/`phase-complete`
	 * are the finer boundaries a worker reaches mid-execution.
	 */
	releaseAtBoundary(boundary: "tool-complete" | "phase-complete" | "task-complete"): void
}

/**
 * Lease lifetimes ordered shortest-lived first. Releasing at a given boundary
 * also releases every strictly shorter-lived lease, since a `tool-complete`
 * lease is already stale by the time a `phase-complete` boundary is reached.
 */
const LEASE_LIFETIME_ORDER = ["tool-complete", "phase-complete", "task-complete"] as const

/**
 * Instantiate a worker's own {@link CapabilityBroker} with a broker-scoped lease
 * set, wire its composed surface into a {@link ComposedSurfaceApplier} over the
 * worker's live `McpHub`, and provision the worker's DAG-declared required
 * capabilities BEFORE its first generation (task 13.1, MCP-016).
 *
 * Each worker gets its OWN broker and its OWN capability-state holder, so a
 * grant/release for one worker never touches a sibling's ALLOWED/ACTIVE set
 * (Requirement 7.1, sibling isolation). The holder is seeded from the worker's
 * authoritative {@link AutonomousTaskState} base so the additive
 * `capabilities` extension coexists with the base state WITHOUT routing the
 * extension back through the schema-validating `setAutonomousTaskState`, which
 * strips unknown keys — the base state continues to flow through its own path
 * untouched (purely additive wiring).
 *
 * The broker's `role` is the worker's mode: a `project-reader` worker is
 * runtime-forbidden from write/execute/mutate capabilities and defaults to the
 * `{ semantic.retrieve, repo.read, core }` set (with `git.read` only when its
 * node requirement explicitly declares it), while the core set is always
 * resident (Requirement 6.2).
 *
 * The `onCompose` sink feeds each freshly composed {@link ComposedToolSurface}
 * into the applier, which produces the filtered `McpHub` view + `disabledTools`
 * the generation path threads into `SYSTEM_PROMPT`. Composition is additive and
 * fail-closed: an applier failure retains the last good surface and restarts no
 * MCP process.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-GENERATION SYSTEM_PROMPT application (seam now closed, MCP-018).
 *
 * The point at which the filtered view + `disabledTools` are actually serialized
 * into a worker's outbound request is `Task.getSystemPrompt`
 * (`src/core/task/Task.ts`), which runs once per generation deep in the child
 * runtime: it resolves its own `mcpHub` from `McpServerManager.getInstance(...)`
 * and threads `this.getDisabledTools(requestState?.disabledTools)`. The child
 * `Task` now exposes an injectable `composedSurfaceProvider` hook; the dispatch
 * site assigns it `() => workerBroker.currentSurface()`, so each generation
 * overrides the resolved `mcpHub` with the filtered view and unions
 * `disabledTools`, serializing only this worker's leased schemas. Before the
 * first successful composition the provider returns `undefined`, which the Task
 * side treats as the live-hub default (unchanged behavior).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function setUpWorkerBroker(
	child: Task,
	spec: ParallelTaskSpec,
	rawSpec: unknown,
	parentTaskId: string,
	mcpHub: Parameters<typeof createComposedSurfaceApplier>[0] | undefined,
): Promise<WorkerBrokerWiring> {
	// Each worker owns its capability-state holder. Seed it from the worker's
	// authoritative AutonomousTaskState base so lease state coexists with the
	// base. The additive `capabilities` extension is held here in memory and is
	// NOT written back through `setAutonomousTaskState` (which strips unknown
	// keys); the base state keeps flowing through its own path untouched.
	let brokerTaskState: AutonomousTaskStateWithCapabilities = getAutonomousTaskState(child)
	const applier = mcpHub !== undefined ? createComposedSurfaceApplier(mcpHub) : undefined

	const broker = createCapabilityBroker({
		taskState: {
			get: () => brokerTaskState,
			set: (next) => {
				brokerTaskState = next
			},
		},
		taskId: parentTaskId,
		// Capture each freshly composed surface and apply it (filtered McpHub view
		// + disabledTools) through the applier, ready for the generation path.
		onCompose: (_workerId: string, surface: ComposedToolSurface) => {
			applier?.recompose(surface)
		},
	})

	// The validated spec now carries `capabilities` through `parallelTaskSpecSchema`
	// (an optional schema member — legacy specs with no capabilities still validate),
	// so `readNodeCapabilityRequirement` finds the DAG-declared requirement on the
	// preserved field and provisioning fires. A reader spec appended by
	// `addSharedDocumentReader` has no `capabilities` → undefined → empty provisioning.
	const requirement = readNodeCapabilityRequirement(rawSpec)
	// Provision this worker's DAG-declared required capabilities BEFORE its first
	// generation (MCP-016). The worker's role/mode (`spec.mode`) drives reader
	// isolation and the reader default set; `provisionWorkerCapabilities`
	// forwards each required capability (and its scope hints) through the broker
	// policy path.
	await provisionWorkerCapabilities(broker, child.taskId, requirement, parentTaskId, spec.mode)

	return {
		broker,
		...(applier !== undefined ? { applier } : {}),
		currentSurface: () => applier?.current(),
		releaseAtBoundary: (boundary) => {
			const cutoff = LEASE_LIFETIME_ORDER.indexOf(boundary)
			const worker = broker.snapshot(child.taskId)
			for (const lease of worker.leases) {
				if (lease.state !== "active") {
					continue
				}
				const leaseOrder = LEASE_LIFETIME_ORDER.indexOf(lease.expiresWhen)
				// Release this lease when its declared boundary has been reached
				// (leaseOrder <= cutoff): a tool-complete lease is released at every
				// boundary, a task-complete lease only at task-complete.
				if (leaseOrder !== -1 && leaseOrder <= cutoff) {
					broker.releaseCapability(child.taskId, lease.capability)
				}
			}
		},
	}
}

/**
 * Optional hooks that let a caller (the background batch service) observe and
 * steer a batch without changing the default blocking behavior.
 */
export interface RunParallelTasksOptions {
	/** Pre-allocated batch id, so a detached batch can be addressed before it finishes. */
	batchId?: string
	/** Lease pools shared across concurrent batches so they cannot oversubscribe a capability. */
	sharedLeasePools?: Map<RouteCapability, InferenceLeasePool>
	/** Per-worker lane overrides forwarded to `assignLanes`. */
	laneSelections?: ReadonlyMap<string, LaneSelection>
	/** Extra batch-level cancellation (in addition to the parent's lifetime signal). */
	abortSignal?: AbortSignal
	/** Called when a worker's child task exists, before its first generation. */
	onWorkerStarted?: (name: string, child: Task) => void
	/** Called once per worker as soon as its result is final. */
	onWorkerSettled?: (result: ParallelTaskResult) => void
	/** Receives a function that cancels only this worker. */
	registerWorkerCancel?: (name: string, cancel: () => void) => void
}

/** Own results in the waiting tool call; children never mutate the parent's message buffers. */
export async function runParallelTasks(
	parent: Task,
	provider: ClineProvider,
	specs: ParallelTaskSpec[],
	policy: UserParallelismPolicy = {},
	options: RunParallelTasksOptions = {},
) {
	// Prune the cache BEFORE creating this batch's directory. Because the new
	// batchId dir does not exist on disk yet, the active batch can never be a
	// deletion target — age/count eviction only ever sees already-persisted
	// batches. Awaited (not fire-and-forget) so a bounded prune completes before
	// the new dir is written. Prune never throws; a failed sweep cannot break the run.
	await pruneParallelTaskBatches(provider.context.globalStorageUri.fsPath)
	const batchId = options.batchId ?? crypto.randomUUID()
	const directory = path.join(provider.context.globalStorageUri.fsPath, "parallel-tasks", batchId)
	const controller = new AbortController()
	// The batch's elastic scheduler owns admission + dispatch, replacing the fixed
	// four-worker pool (design §"ParallelTasksTool and runParallelTasks"). It is
	// scoped to this batch so a cancel here never touches another batch's permits.
	// Capacity is now real: the static route-capacity provider reports each
	// capability's summed backend slots (floored at 1), and the scheduler bounds
	// are seeded from it (design §A/§D). `maxInferenceLeases` reflects the aggregate
	// real slots instead of the dispatched ceiling, so Menagerie throttles each
	// capability inside itself (via the per-capability lease pools wired below)
	// instead of spilling the excess into OmniRoute's rate-limit queue. The
	// scheduler clamps both bounds down by the user policy (never up); capacity
	// never raises a bound above what policy allows (design §E).
	//
	// The per-capability slot counts come from the user-adjustable
	// `parallelCapacityMap` setting merged over `STATIC_ROUTE_CAPACITY`:
	// `mergeRouteCapacityMap` keeps today's static value for any capability the
	// user did not override (so unset/empty is a byte-for-byte no-op), and
	// `createStaticRouteCapacityProvider` still floors every value to `>= 1`, so a
	// user map can tune capacity but never reintroduce the 0-lease deadlock.
	const { parallelCapacityMap, openAiOmniRoutePublishedLaneRouting, workerAuditMode, customModes } =
		await provider.getState()
	const auditMode = workerAuditMode
	const canEditByMode = new Map(
		specs.map((spec) => [spec.mode, groupsCanEdit(getModeBySlug(spec.mode, customModes)?.groups)] as const),
	)
	const verifierAvailable = isVerifierModeUsable(
		getModeBySlug(AUDIT_VERIFIER_MODE, customModes),
		groupsCanEdit,
	)
	const staticCapacityMap = mergeRouteCapacityMap(parallelCapacityMap)
	// omniroute-fleet-topology 13.3: when this batch runs on an OmniRoute profile,
	// prefer the published RouteCapacity/Capability_Lane metadata the Route_Compiler
	// publishes over the hand-maintained static map (Requirements 14.4, 14.5, 14.7,
	// 14.8). The published catalog is kept warm by a background refresh keyed on the
	// profile's saved server URL; we read the already-cached snapshot (no blocking
	// fetch) and kick a refresh when it is stale, so the first batch is never delayed.
	// An empty/incomplete snapshot — including no cache yet within the batch window —
	// falls through to the static map inside createPublishedRouteCapacityProvider.
	const parentIsOmniRoute = isOmniRoute(parent.apiConfiguration)
	const omniRouteServerUrl = parentIsOmniRoute ? parent.apiConfiguration.openAiBaseUrl : undefined
	if (parentIsOmniRoute) {
		refreshPublishedCatalogIfStale(omniRouteServerUrl, parent.apiConfiguration.openAiApiKey)
	}
	const publishedExtraction = parentIsOmniRoute
		? extractPublishedRouteMetadata(getPublishedCatalogEntries(omniRouteServerUrl))
		: undefined
	const routeCapacity = publishedExtraction
		? createPublishedRouteCapacityProvider(publishedExtraction, staticCapacityMap, parallelCapacityMap)
		: createStaticRouteCapacityProvider(staticCapacityMap)
	// The published Capability_Lane → Public_Route map for the opt-in lane-routing
	// resolution below (Requirement 14.6/14.9). Only a COMPLETE snapshot is used; an
	// incomplete one leaves this undefined so every worker falls back to today's
	// lane→role-route resolution.
	const publishedLaneRoutes =
		openAiOmniRoutePublishedLaneRouting && publishedExtraction?.complete
			? publishedExtraction.metadata?.capabilityLane
			: undefined
	const scheduler = new BoundedElasticScheduler(
		computeCapacityBounds(routeCapacity),
		policy,
		routeCapacity,
		options.sharedLeasePools,
	)
	// Build the plan through the shared builder so per-spec `dependsOn` becomes real
	// DAG edges; dependents are admitted `waiting-on-dependency` and unlock the
	// instant their prerequisites settle (lift C4). A spec list with no `dependsOn`
	// yields a flat `{ tasks }` plan, so legacy behavior is unchanged. The tool
	// already admitted an equivalent plan for recoverable validation, so admission
	// here cannot throw a cycle/duplicate that validation did not already catch.
	const plan: ExecutionPlan = buildExecutionPlan(specs)
	scheduler.admitPlan(plan)
	const cancel = () => {
		controller.abort(new Error("Parent task stopped"))
		// Reject queued/runnable waiters without touching any sibling that already
		// holds a dispatch permit or inference lease — a cancelled batch never
		// abandons siblings mid-flight (PAR-021.5).
		scheduler.cancelQueued()
	}
	parent.lifetimeSignal.addEventListener("abort", cancel, { once: true })
	options.abortSignal?.addEventListener("abort", cancel, { once: true })
	if (parent.lifetimeSignal.aborted || options.abortSignal?.aborted) cancel()
	// Long-running workers remain attached to the parent until they complete or
	// the parent stops. An absolute batch deadline discarded active work after
	// 30 minutes, forcing the parent to redo it serially.
	const signal = controller.signal
	try {
		signal.throwIfAborted()
		// Assign a capability lane to every spec (pure, additive — leaves specs
		// byte-for-byte unchanged; design §C, capability-lanes-routing). The lane
		// drives BOTH the RouteCapability a worker leases against (below) and the
		// route id it dispatches with, so a worker's lease pool and its backend
		// class agree by construction.
		const assignments = assignLanes(specs, options.laneSelections)
		const laneByName = new Map(assignments.map((assignment) => [assignment.spec.name, assignment.lane]))
		// Per-worker RouteCapability for leasing, keyed by spec name. Derived from
		// the SAME lane used for route-id resolution (design decisions B and C).
		const capabilityByName = new Map<string, RouteCapability>(
			assignments.map((assignment) => [
				assignment.spec.name,
				laneToRouteCapability(assignment.lane, defaultLaneTaskType(assignment.spec.mode)),
			]),
		)
		// Coder-only ordinal: the 0-based index of each worker among `coder.primary`
		// assignments ONLY, in spec order (design §C / finding #3). Interleaved
		// readers/researchers never perturb the round-robin that spreads code work
		// across backends, so the distribution stays balanced.
		const coderOrdinalByName = new Map<string, number>()
		let nextCoderOrdinal = 0
		for (const assignment of assignments) {
			if (assignment.lane === "coder.primary") {
				coderOrdinalByName.set(assignment.spec.name, nextCoderOrdinal++)
			}
		}
		// The ordered, de-duplicated code-capable route ids the spread round-robins
		// over, built once from the parent profile (design §C). Spread engages only
		// when more than one code-capable route is configured; otherwise routing is
		// identical to today (no regression for an unconfigured user).
		const parentModelId = parent.apiConfiguration.openAiModelId
		// Resolve every profile before starting any child. No global profile projection.
		// Per-worker model id is a pure pass-through driven by the worker's lane: an
		// explicit `route`, else the lane route id (reader lane, code-route spread, or
		// escalation), else the parent's model id (OmniRoute owns placement — design §C).
		const contexts = await Promise.all(
			specs.map(async (spec) => {
				const context = await provider.getTaskHandoffContext(parent, spec.mode, true)
				const lane = laneByName.get(spec.name)!
				// Carry the assigned Capability_Lane on the worker's handoff context so
				// the worker's Task attaches it as request metadata on every request it
				// makes, and on nothing else (omniroute-fleet-topology Req 17.4). The
				// lane is a `CapabilityLane`, assignable to the context's `string` field.
				context.capabilityLane = lane
				const codeCapableRouteIds = collectCodeCapableRouteIds(context.apiConfiguration, parentModelId)
				// omniroute-fleet-topology 14.6: when published lane routing is enabled and
				// this routeless worker's lane maps to a published Public_Route, resolve the
				// model id to that route; otherwise fall through to today's lane→role-route
				// resolution (Requirement 14.9).
				const publishedRoute = resolvePublishedLaneRoute({
					enabled: openAiOmniRoutePublishedLaneRouting ?? false,
					lane,
					route: spec.route,
					profile: context.apiConfiguration,
					parentModelId,
					publishedLaneRoutes,
				})
				context.apiConfiguration.openAiModelId =
					publishedRoute ??
					resolveLaneRouteId({
						lane,
						taskType: defaultLaneTaskType(spec.mode),
						profile: context.apiConfiguration,
						route: spec.route,
						parentModelId,
						coderOrdinal: coderOrdinalByName.get(spec.name),
						codeCapableRouteIds,
					})
				return context
			}),
		)
		const snapshot = await snapshotWorkingTree(parent.cwd, directory)
		// Git resolves symlinks in its root; VS Code may retain aliases such as
		// macOS /var -> /private/var. Compare canonical paths before joining.
		const relativeCwd = path.relative(await fs.realpath(snapshot.root), await fs.realpath(parent.cwd))
		if (relativeCwd === ".." || relativeCwd.startsWith(".." + path.sep) || path.isAbsolute(relativeCwd))
			throw new Error("Task workspace is outside its Git repository")
		const manifest = {
			batchId,
			parentTaskId: parent.taskId,
			snapshot: snapshot.commit,
			tasks: [] as ParallelTaskResult[],
		}
		await fs.writeFile(
			path.join(directory, "manifest.json"),
			JSON.stringify(
				{ ...manifest, tasks: specs.map(({ name, mode }) => ({ name, mode, state: "queued" })) },
				null,
				2,
			),
			{ mode: 0o600 },
		)
		// Observe partial batch completion through the scheduler's completion event
		// bus (design §"Event-driven DAG", PAR-004.7). Each worker settles the
		// scheduler via onWorkerSettled the instant its loop resolves/rejects, which
		// publishes a WorkerCompletionEvent here as it arrives rather than at a
		// batch-wide barrier. Persisting the batch manifest incrementally on each
		// settle makes partial completion durable and inspectable while siblings are
		// still in flight — a subset completing is visible without waiting for every
		// child. The flat task list carries no inter-worker dependencies, so no
		// handler needs to unlock a dependent, but this seam is where a dependency-
		// bearing plan would react to each unlock.
		const settledByWorker = new Map<string, WorkerOutcome>()
		// Serialize every manifest write (partial + final) behind one chain so an
		// in-flight partial write can never land after — and clobber — the
		// authoritative final write. A rejected partial write is swallowed so one
		// failed incremental write never stalls the chain or abandons a sibling
		// (PAR-021.5); the final write is awaited for its result.
		let manifestWriteChain: Promise<void> = Promise.resolve()
		const queueManifestWrite = (write: () => Promise<void>): Promise<void> => {
			const next = manifestWriteChain.then(write)
			manifestWriteChain = next.catch(() => {})
			return next
		}
		const unsubscribe = scheduler.subscribeCompletion((event) => {
			settledByWorker.set(event.workerId, event.outcome)
			// Publishing is synchronous: a slow incremental manifest write must never
			// stall the publish loop, so enqueue it and let the chain drain.
			void queueManifestWrite(() => persistPartialManifest(directory, manifest, specs, settledByWorker))
		})
		const results = await Promise.all(
			specs.map(async (spec, index): Promise<ParallelTaskResult> => {
				const workspace = path.join(directory, `worker-${index + 1}`)
				// Cancels only this worker (queued or running) without touching siblings.
				const workerAbort = new AbortController()
				options.registerWorkerCancel?.(spec.name, () => workerAbort.abort(new Error("Worker cancelled")))
				const result: ParallelTaskResult = {
					name: spec.name,
					mode: spec.mode,
					state: "failed",
				}
				// One agent-loop run (implementer, rework, or verifier) in this worker's
				// workspace. `primary` runs own the worker's result record; verifier runs
				// only report their completion text and task id. Throws on failure, like
				// the original inline body.
				const runAttempt = async (
					spec: ParallelTaskSpec,
					attemptContext: Awaited<ReturnType<ClineProvider["getTaskHandoffContext"]>>,
					handle: Parameters<Parameters<typeof scheduler.dispatch>[1]>[0],
					attempt: { primary: boolean; reuseWorkspace: boolean; capability: RouteCapability },
				): Promise<{ raw: string; taskId: string }> => {
					// Dispatch permit covers the worker's whole run. Inference leases
					// are acquired per generation inside Task.attemptApiRequest (P5),
					// never for the worker's lifetime. Auto-readers stay exempt from
					// Menagerie lease queuing (design §B, finding #4).
					const isAutoReader = spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
					if (!attempt.reuseWorkspace) {
						await createParallelWorkspace(snapshot.root, snapshot.commit, workspace)
					}
					result.workspace = workspace
					signal.throwIfAborted()
					const runtime = await provider.createParallelTaskRuntime(
						parent,
						spec,
						path.join(workspace, relativeCwd),
						attemptContext,
					)
					const child = runtime.task
					options.onWorkerStarted?.(spec.name, child)
					// Give this worker its OWN broker-scoped lease set and provision
					// its DAG-declared required capabilities BEFORE its first
					// generation (task 13.1, MCP-016). `setUpWorkerBroker`:
					//  - instantiates a per-worker CapabilityBroker (sibling-isolated),
					//  - seeds a capability-state holder from the worker's authoritative
					//    AutonomousTaskState base (additive; never written back through
					//    the schema-stripping setter),
					//  - forwards the worker's role/mode so a `project-reader` is
					//    runtime-forbidden from write/execute/mutate and defaults to the
					//    { semantic.retrieve, repo.read, core } surface (Req 6.2),
					//  - captures each composed ComposedToolSurface via `onCompose` and
					//    applies it (filtered McpHub view + disabledTools) through a
					//    ComposedSurfaceApplier over the worker's live McpHub, and
					//  - exposes `releaseAtBoundary` to drop leases at their declared
					//    tool-/phase-/task-complete boundary so released schemas leave
					//    the next composition (Req 1.3, 10.1).
					// The per-generation application of `workerBroker.currentSurface()`
					// into SYSTEM_PROMPT is wired below via `composedSurfaceProvider`.
					// Lazy in-execution `capability.request` for undeclared
					// capabilities routes through the same broker policy path.
					const workerBroker = await setUpWorkerBroker(
						child,
						spec,
						spec,
						parent.taskId,
						runtime.provider.getMcpHub(),
					)
					// Close the per-generation SYSTEM_PROMPT seam (MCP-018): hand the
					// child Task its current composed surface so each generation
					// serializes only this worker's leased schemas (filtered McpHub
					// view + disabledTools). Returns undefined until the first
					// successful composition, which the Task side treats as the
					// live-hub default.
					child.composedSurfaceProvider = () => workerBroker.currentSurface()
					// Per-generation inference lease (P5): the child acquires just
					// before network dispatch and releases on stream end/error/abort
					// or as soon as it stops consuming model output (tool wait).
					// Auto-readers stay exempt from Menagerie lease queuing.
					if (!isAutoReader) {
						const capability = attempt.capability
						child.inferenceLeaseProvider = {
							acquire: (leaseSignal) =>
								handle.acquireLease(capability, AbortSignal.any([signal, leaseSignal])),
						}
					}
					try {
						if (attempt.primary) {
							result.taskId = child.taskId
							result.profile = await child.getTaskApiConfigName()
							await fs.writeFile(
								path.join(directory, `worker-${index + 1}.json`),
								JSON.stringify({ ...result, state: "running" }, null, 2),
								{ mode: 0o600 },
							)
						}
						const workerSignal =
							spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
								? AbortSignal.any([signal, workerAbort.signal, AbortSignal.timeout(90_000)])
								: AbortSignal.any([signal, workerAbort.signal])
						// The worker delivers its result via attempt_completion (captured as the
						// child's completion_result text in AttemptCompletionTool). Normalize that
						// raw output into a schema-valid WorkerResult (non-conforming output →
						// status "failed") and persist the full serialized result through the
						// existing `result` channel, so compactParallelTasksResultForParent clips
						// the parent-visible view while the worker record + manifest keep the full
						// structured result. No new parent-injection path (design §FEAT-007).
						const rawCompletion = await waitForParallelTask(child, runtime.provider, workerSignal)
						if (!attempt.primary) return { raw: rawCompletion, taskId: child.taskId }
						const workerResult = normalizeWorkerResult(rawCompletion, { workerName: spec.name })
						// Resilient Context Recovery (Req 6.1, 6.5, 6.6): merge this worker's
						// accumulated recovery telemetry onto the normalized WorkerResult as the
						// additive-optional `recovery` field BEFORE serialization — every base
						// WorkerResult field is preserved and the block is omitted when no recovery
						// occurred. It rides the `result` channel only; the parent still receives
						// just its compacted summary via compactParallelTasksResultForParent (Req 6.6).
						const recovery = child.getRecoveryTelemetry()
						const workerResultWithRecovery: WorkerResultWithRecovery = recovery
							? { ...workerResult, recovery }
							: workerResult
						result.result = JSON.stringify(workerResultWithRecovery)
						result.state = "completed"
						return { raw: rawCompletion, taskId: child.taskId }
					} finally {
						// The worker's loop has settled: its `task-complete` boundary
						// is reached, so release every still-active lease at (or below)
						// that boundary. Released schemas drop from the next composition
						// (Req 1.3, 10.1); the core set remains resident. Release is
						// per-worker and never touches a sibling's lease set (Req 7.1).
						workerBroker.releaseAtBoundary("task-complete")
						// Drop any in-flight generation lease before abort/dispose so a
						// cancelled or failed worker never starves the lane (P5).
						child.releaseGenerationLease()
						// Stop the agent loop after completion as well as on cancellation. Keep the
						// panel/history and worktree available for inspection and explicit resume.
						child.cancelCurrentRequest()
						try {
							await child.abortTask()
						} finally {
							await child.dispose()
						}
					}
				}
				// Audit a completed worker: independent read-only verifier, send back with
				// the verifier's findings (bounded), then one deeper-lane follow-up. The
				// outcome is never "pass" without a passing verifier result; Granite
				// analysis output is not an input here (see auditLoop.ts).
				const auditWorker = async (args: {
					spec: ParallelTaskSpec
					policy: VerificationPolicy
					handle: Parameters<Parameters<typeof scheduler.dispatch>[1]>[0]
					capability: RouteCapability
					first: { raw: string; taskId: string }
				}) => {
					const { spec, policy, handle, capability, first } = args
					const readerCapability = laneToRouteCapability("reader.deep", "lookup")
					const stopped = () => signal.aborted || workerAbort.signal.aborted
					const attempt = async (run: () => Promise<{ raw: string; taskId: string }>, name: string) => {
						try {
							const out = await run()
							return {
								state: "completed" as const,
								result: normalizeWorkerResult(out.raw, { workerName: name }),
								taskId: out.taskId,
							}
						} catch {
							return { state: stopped() ? ("cancelled" as const) : ("failed" as const) }
						}
					}
					const readerContext = async (lane: "reader.deep" | "reasoning.escalation") => {
						const context = await provider.getTaskHandoffContext(parent, "project-reader", true)
						context.capabilityLane = lane
						const routeId = resolveLaneRouteId({
							lane,
							taskType: lane === "reader.deep" ? "lookup" : "adjudication",
							profile: context.apiConfiguration,
							route: undefined,
							parentModelId,
							coderOrdinal: undefined,
							codeCapableRouteIds: collectCodeCapableRouteIds(context.apiConfiguration, parentModelId),
						})
						if (routeId) context.apiConfiguration.openAiModelId = routeId
						return context
					}
					let verifierCount = 0
					const audit = await runAuditLoop({
						policy,
						implementer: {
							state: "completed",
							result: normalizeWorkerResult(first.raw, { workerName: spec.name }),
							taskId: first.taskId,
						},
						isCancelled: stopped,
						runVerifier: ({ criteria }) => {
							const vSpec: ParallelTaskSpec = {
								name: `${spec.name}#verify-${++verifierCount}`,
								mode: AUDIT_VERIFIER_MODE,
								message: buildVerifierMessage(spec.message, criteria),
							}
							return attempt(
								async () =>
									runAttempt(vSpec, await readerContext("reader.deep"), handle, {
										primary: false,
										reuseWorkspace: true,
										capability: readerCapability,
									}),
								vSpec.name,
							)
						},
						rework: ({ feedback, round }) =>
							attempt(
								() =>
									runAttempt(
										{
											...spec,
											message: `${spec.message}\n\n# Audit feedback (round ${round})\n${feedback}`,
										},
										contexts[index]!,
										handle,
										{ primary: true, reuseWorkspace: true, capability },
									),
								spec.name,
							),
						escalate: async ({ feedback, rounds, implementer }) => {
							const followUp = produceDeeperLaneFollowUp({
								result:
									implementer.result ??
									normalizeWorkerResult(first.raw, { workerName: spec.name }),
								originatingSpec: spec,
								previousFailures: rounds,
								loopSignal: "none",
								complexity: 0.5,
								contextRequirement: "small",
								capacityProvider: routeCapacity,
							})
							if (!followUp) return undefined
							const lane = followUp.assignment.lane
							// Advisory and read-only whatever the originating mode was.
							const fSpec: ParallelTaskSpec = {
								...followUp.assignment.spec,
								mode: "project-reader",
								message: `${followUp.assignment.spec.message}\n\nVerification feedback:\n${feedback}`,
							}
							const out = await attempt(
								async () =>
									runAttempt(
										fSpec,
										await readerContext(lane === "reader.deep" ? lane : "reasoning.escalation"),
										handle,
										{
											primary: false,
											reuseWorkspace: true,
											capability: readerCapability,
										},
									),
								fSpec.name,
							)
							return { lane, summary: out.result?.summary }
						},
					})
					result.audit = audit.record
					const terminal = auditTerminalState(audit.outcome, stopped())
					if (terminal.state !== "completed") {
						result.state = terminal.state
						result.error = boundErrorText(terminal.error ?? audit.outcome.reason)
					}
				}
				try {
					// Dispatch the worker's agent loop through the elastic scheduler
					// instead of the fixed four-worker pool. `spec.name` is the
					// Logical_Worker id admitted above; dispatch gates on a dispatch
					// permit (over-capacity workers queue, never rejected — PAR-011.1)
					// and releases it via try/finally even if the loop throws. The
					// optional audit (verify, send back, escalate) runs inside the same
					// permit, before the worker settles, so DAG dependents unlock only
					// after the audit.
					await scheduler.dispatch(spec.name, async (handle) => {
						signal.throwIfAborted()
						workerAbort.signal.throwIfAborted()
						const capability = capabilityByName.get(spec.name)!
						const first = await runAttempt(spec, contexts[index]!, handle, {
							primary: true,
							reuseWorkspace: false,
							capability,
						})
						const canEdit = canEditByMode.get(spec.mode) ?? false
						const policy = resolveAuditPolicy(spec, auditMode, canEdit, verifierAvailable)
						if (!policy) {
							if (!verifierAvailable && resolveAuditPolicy(spec, auditMode, canEdit)) {
								result.auditWarning = AUDIT_SKIPPED_WARNING
							}
							return
						}
						await auditWorker({ spec, policy, handle, capability, first })
					})
				} catch (error) {
					result.state = signal.aborted || workerAbort.signal.aborted ? "cancelled" : "failed"
					result.error = boundErrorText(error instanceof Error ? error.message : String(error))
				}
				// Settle this worker on the scheduler the instant its loop resolves or
				// rejects, driving the completion event bus per worker (event-driven
				// settling, PAR-004.7) rather than at a batch barrier. The outcome maps
				// the worker's terminal state onto a WorkerOutcome; onWorkerSettled only
				// touches this worker and the dependents it unlocks, never a sibling's
				// lease or dispatch permit (PAR-021.5). It is a no-op if the scheduler
				// already settled this worker via cancelQueued on a parent abort.
				scheduler.onWorkerSettled(spec.name, workerOutcome(result))
				if (result.workspace) {
					try {
						const patch = path.join(directory, `worker-${index + 1}.patch`)
						await exportParallelPatch(workspace, snapshot.commit, patch)
						result.patch = patch
					} catch (error) {
						result.error =
							`${result.error ?? ""} Patch export failed: ${boundErrorText(String(error))}`.trim()
						if (result.state === "completed") result.state = "failed"
					}
				}
				try {
					await fs.writeFile(
						path.join(directory, `worker-${index + 1}.json`),
						JSON.stringify(result, null, 2),
						{
							mode: 0o600,
						},
					)
				} catch (error) {
					// Never let one failed record write abandon siblings still holding permits.
					result.error =
						`${result.error ?? ""} Result persistence failed: ${boundErrorText(String(error))}`.trim()
					if (result.state === "completed") result.state = "failed"
				}
				try {
					options.onWorkerSettled?.(result)
				} catch {
					// An observer failure must never abandon siblings still holding permits.
				}
				return result
			}),
		)
		// Every worker has settled; detach the completion observer so no further
		// partial write is enqueued.
		unsubscribe()
		manifest.tasks = results
		// Enqueue the authoritative final manifest behind any in-flight partial
		// writes so it always lands last and is never clobbered by a late partial.
		await queueManifestWrite(() =>
			fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 }),
		)
		return { ...manifest, manifestPath: path.join(directory, "manifest.json") }
	} finally {
		parent.lifetimeSignal.removeEventListener("abort", cancel)
	}
}

/**
 * Persist an interim batch manifest reflecting partial completion: each worker
 * whose settle event has arrived shows its terminal state; the rest show
 * `running`. Called from the completion-event subscriber so a subset of a batch
 * completing is durable and inspectable without waiting for every child
 * (PAR-004.7). The authoritative final manifest is still written once every
 * worker's full {@link ParallelTaskResult} is collected.
 */
async function persistPartialManifest(
	directory: string,
	manifest: { batchId: string; parentTaskId: string; snapshot: string },
	specs: ParallelTaskSpec[],
	settledByWorker: ReadonlyMap<string, WorkerOutcome>,
): Promise<void> {
	const tasks = specs.map(({ name, mode }) => ({
		name,
		mode,
		state: settledByWorker.get(name)?.kind ?? "running",
	}))
	await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, tasks }, null, 2), {
		mode: 0o600,
	})
}

/**
 * Map a worker's finalized {@link ParallelTaskResult} state onto the scheduler
 * {@link WorkerOutcome} it settles with. A completed worker references its
 * persisted result record (`resultRef`); a cancelled worker (parent stopped)
 * records the `parent-stopped` reason; everything else is a failure carrying the
 * recorded error. The outcome drives the completion event bus but never the
 * parent-visible result, which stays owned by {@link ParallelTaskResult}.
 */
function workerOutcome(result: ParallelTaskResult): WorkerOutcome {
	switch (result.state) {
		case "completed":
			return { kind: "completed", resultRef: result.taskId ?? result.name }
		case "cancelled":
			return { kind: "cancelled", reason: "parent-stopped" }
		default:
			return { kind: "failed", error: result.error ?? "Worker failed" }
	}
}

export function waitForParallelTask(
	child: Pick<Task, "taskId" | "clineMessages" | "lifetimeSignal" | "run" | "parallelWorkerFailure" | "on" | "off">,
	provider: Pick<ClineProvider, "on" | "off">,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// The first outcome wins; every path below goes through settle.
		let settled = false
		const settle = (fn: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			fn()
		}
		// Set by the child's own TaskCompleted, which fires before the provider's async re-emit.
		let completedText: string | undefined
		const completionText = () =>
			[...child.clineMessages].reverse().find((message) => message.say === "completion_result")?.text ??
			"Task completed"
		const cleanup = () => {
			child.off(RooCodeEventName.TaskCompleted, onChildCompleted)
			provider.off(RooCodeEventName.TaskCompleted, complete)
			provider.off(RooCodeEventName.TaskInteractive, needsInput)
			provider.off(RooCodeEventName.TaskIdle, needsInput)
			signal.removeEventListener("abort", cancel)
			child.lifetimeSignal.removeEventListener("abort", stopped)
		}
		// A worker that completed is reported as completed even if it then stops or its loop ends.
		const resolveIfCompleted = () => {
			const text = completedText
			if (text === undefined) return false
			settle(() => resolve(text))
			return true
		}
		const onChildCompleted = () => {
			const text = completionText()
			completedText = text
			settle(() => resolve(text))
		}
		const complete = (taskId: string) => {
			if (taskId !== child.taskId) return
			const text = completionText()
			settle(() => resolve(text))
		}
		const cancel = () => {
			// A cancelled batch reports cancelled regardless of the worker's outcome.
			settle(() => reject(signal.reason ?? new Error("Batch cancelled")))
		}
		// Read at settle time: failParallelWorker records the reason before it aborts the child.
		const workerError = (fallback: string) =>
			new Error(child.parallelWorkerFailure ? `Worker failed: ${child.parallelWorkerFailure}` : fallback)
		const stopped = () => {
			if (resolveIfCompleted()) return
			settle(() => reject(workerError("Worker stopped before completing")))
		}
		const needsInput = (taskId: string) => {
			if (taskId !== child.taskId) return
			if (resolveIfCompleted()) return
			const ask = [...child.clineMessages]
				.reverse()
				.find((message) => message.type === "ask" && !message.isAnswered)
			if (ask?.ask === "completion_result") return
			settle(() =>
				reject(
					new Error(`Worker needs input${ask?.ask ? ` (${ask.ask})` : ""}; inspect its saved chat and patch`),
				),
			)
		}
		// Covers a loop that returns without attempt_completion (for example its outer catch).
		const onLoopEnded = () => {
			if (resolveIfCompleted()) return
			settle(() =>
				reject(
					workerError("Worker task loop ended without attempt_completion; inspect its saved chat and patch"),
				),
			)
		}
		const onLoopError = (error: unknown) => settle(() => reject(error))
		child.on(RooCodeEventName.TaskCompleted, onChildCompleted)
		provider.on(RooCodeEventName.TaskCompleted, complete)
		provider.on(RooCodeEventName.TaskInteractive, needsInput)
		provider.on(RooCodeEventName.TaskIdle, needsInput)
		signal.addEventListener("abort", cancel, { once: true })
		child.lifetimeSignal.addEventListener("abort", stopped, { once: true })
		if (signal.aborted) return cancel()
		if (child.lifetimeSignal.aborted) return stopped()
		// Register completion and cancellation before admitting the paused child.
		void child.run().then(onLoopEnded, onLoopError)
	})
}
