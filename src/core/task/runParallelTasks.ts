import path from "node:path"
import crypto from "node:crypto"
import * as fs from "node:fs/promises"
import { RooCodeEventName } from "@roo-code/types"
import type { Task } from "./Task"
import type { ClineProvider } from "../webview/ClineProvider"
import type { ParallelTaskSpec, NodeCapabilityRequirement } from "../tools/ParallelTasksTool"
import { readNodeCapabilityRequirement } from "../tools/ParallelTasksTool"
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
	resolveLaneRouteId,
} from "./parallelWorkerRouting"
import { laneToRouteCapability } from "./capabilityLanes"
import { computeCapacityBounds, createStaticRouteCapacityProvider, mergeRouteCapacityMap } from "./routeCapacityMap"
import { normalizeWorkerResult } from "./normalizeWorkerResult"
import { pruneParallelTaskBatches } from "./parallelTaskRetention"
import { AUTO_READER_NAME } from "./ParallelTaskReader"
import { snapshotWorkingTree, createParallelWorkspace, exportParallelPatch } from "./ParallelTaskWorkspace"
import { BoundedElasticScheduler } from "./BoundedElasticScheduler"
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

/** Own results in the waiting tool call; children never mutate the parent's message buffers. */
export async function runParallelTasks(
	parent: Task,
	provider: ClineProvider,
	specs: ParallelTaskSpec[],
	policy: UserParallelismPolicy = {},
) {
	// Prune the cache BEFORE creating this batch's directory. Because the new
	// batchId dir does not exist on disk yet, the active batch can never be a
	// deletion target — age/count eviction only ever sees already-persisted
	// batches. Awaited (not fire-and-forget) so a bounded prune completes before
	// the new dir is written. Prune never throws; a failed sweep cannot break the run.
	await pruneParallelTaskBatches(provider.context.globalStorageUri.fsPath)
	const batchId = crypto.randomUUID()
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
	const { parallelCapacityMap } = await provider.getState()
	const routeCapacity = createStaticRouteCapacityProvider(mergeRouteCapacityMap(parallelCapacityMap))
	const scheduler = new BoundedElasticScheduler(computeCapacityBounds(routeCapacity), policy, routeCapacity)
	const plan: ExecutionPlan = { tasks: specs }
	// Admitting the plan compiles the DAG and registers one Logical_Worker per
	// spec. The tool already admitted an equivalent plan for recoverable
	// validation; this flat task list carries no dependencies, so admission here
	// cannot throw for a cycle/duplicate that validation did not already catch.
	scheduler.admitPlan(plan)
	const cancel = () => {
		controller.abort(new Error("Parent task stopped"))
		// Reject queued/runnable waiters without touching any sibling that already
		// holds a dispatch permit or inference lease — a cancelled batch never
		// abandons siblings mid-flight (PAR-021.5).
		scheduler.cancelQueued()
	}
	parent.lifetimeSignal.addEventListener("abort", cancel, { once: true })
	if (parent.lifetimeSignal.aborted) cancel()
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
		const assignments = assignLanes(specs)
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
				const codeCapableRouteIds = collectCodeCapableRouteIds(context.apiConfiguration, parentModelId)
				context.apiConfiguration.openAiModelId = resolveLaneRouteId({
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
				const result: ParallelTaskResult = {
					name: spec.name,
					mode: spec.mode,
					state: "failed",
				}
				try {
					// Dispatch the worker's agent loop through the elastic scheduler
					// instead of the fixed four-worker pool. `spec.name` is the
					// Logical_Worker id admitted above; dispatch gates on a dispatch
					// permit (over-capacity workers queue, never rejected — PAR-011.1)
					// and releases it via try/finally even if the loop throws, exactly
					// as the pool did. The run body — workspace creation, runtime
					// creation, waitForParallelTask, worker-N.json writes, result
					// ownership, and the finally that disposes the child — is unchanged.
					await scheduler.dispatch(spec.name, async (handle) => {
						signal.throwIfAborted()
						// Acquire a per-worker inference lease for the worker's whole active
						// lifetime (design §B). The worker already holds the dispatch permit
						// (acquired by scheduler.dispatch); acquiring the lease strictly INSIDE
						// that permit fixes the global order permit≺lease with no reverse edge,
						// so the wait-for graph is acyclic and the batch cannot deadlock. The
						// per-capability lease pools throttle generations inside Menagerie:
						// over-capacity workers for a hot capability queue in `waiting-for-
						// inference` here instead of all being handed to OmniRoute at once.
						//
						// Auto-reader workers are EXEMPT (design §B, finding #4): they are
						// read-only, individually bounded by their own 90s wall-clock deadline,
						// hit the 9B reader lane rather than the 27B bottleneck, and must keep
						// today's immediate-dispatch behavior so a reader-swarm wider than the
						// reader capacity never times out purely from lease-queue wait. An
						// exempt worker holds no lease, so it adds no edge to the wait graph.
						const isAutoReader = spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
						const releaseLease = isAutoReader
							? () => {}
							: await handle.acquireLease(capabilityByName.get(spec.name)!, signal)
						try {
							await createParallelWorkspace(snapshot.root, snapshot.commit, workspace)
							result.workspace = workspace
							signal.throwIfAborted()
							const runtime = await provider.createParallelTaskRuntime(
								parent,
								spec,
								path.join(workspace, relativeCwd),
								contexts[index]!,
							)
							const child = runtime.task
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
							try {
								result.taskId = child.taskId
								result.profile = await child.getTaskApiConfigName()
								await fs.writeFile(
									path.join(directory, `worker-${index + 1}.json`),
									JSON.stringify({ ...result, state: "running" }, null, 2),
									{ mode: 0o600 },
								)
								const workerSignal =
									spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
										? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
										: signal
								// The worker delivers its result via attempt_completion (captured as the
								// child's completion_result text in AttemptCompletionTool). Normalize that
								// raw output into a schema-valid WorkerResult (non-conforming output →
								// status "failed") and persist the full serialized result through the
								// existing `result` channel, so compactParallelTasksResultForParent clips
								// the parent-visible view while the worker record + manifest keep the full
								// structured result. No new parent-injection path (design §FEAT-007).
								const rawCompletion = await waitForParallelTask(child, runtime.provider, workerSignal)
								const workerResult = normalizeWorkerResult(rawCompletion, { workerName: spec.name })
								result.result = JSON.stringify(workerResult)
								result.state = "completed"
							} finally {
								// The worker's loop has settled: its `task-complete` boundary
								// is reached, so release every still-active lease at (or below)
								// that boundary. Released schemas drop from the next composition
								// (Req 1.3, 10.1); the core set remains resident. Release is
								// per-worker and never touches a sibling's lease set (Req 7.1).
								workerBroker.releaseAtBoundary("task-complete")
								// Stop the agent loop after completion as well as on cancellation. Keep the
								// panel/history and worktree available for inspection and explicit resume.
								child.cancelCurrentRequest()
								try {
									await child.abortTask()
								} finally {
									await child.dispose()
								}
							}
						} finally {
							// Release the per-worker inference lease AFTER the child-dispose
							// finally above, so the lease is held for the worker's whole active
							// lifetime and freed the instant it settles — success, failure, or
							// abort (design §B). The release is idempotent (makeHandle /
							// InferenceLeasePool.makeRelease), so this is a no-op for an exempt
							// auto-reader and safe even if invoked twice. Freeing it admits the
							// next queued waiter for this capability via the pool's pump().
							releaseLease()
						}
					})
				} catch (error) {
					result.state = signal.aborted ? "cancelled" : "failed"
					result.error = error instanceof Error ? error.message : String(error)
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
						result.error = `${result.error ?? ""} Patch export failed: ${String(error)}`.trim()
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
					result.error = `${result.error ?? ""} Result persistence failed: ${String(error)}`.trim()
					if (result.state === "completed") result.state = "failed"
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
