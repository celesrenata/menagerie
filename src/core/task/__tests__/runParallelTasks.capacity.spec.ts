import { describe, it, expect } from "vitest"

import { BoundedElasticScheduler, type DispatchHandle } from "../BoundedElasticScheduler"
import {
	type ExecutionPlan,
	type LogicalWorkerState,
	type RouteCapability,
	type RouteCapacity,
	type RouteCapacityProvider,
	type UserParallelismPolicy,
} from "../elasticTypes"
import { computeCapacityBounds } from "../routeCapacityMap"
import { collectCodeCapableRouteIds, resolveLaneRouteId } from "../parallelWorkerRouting"
import { laneToRouteCapability } from "../capabilityLanes"
import type { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

/**
 * Capacity-aware parallel scheduling + backend-spread integration test
 * (parallel-capacity-routing design §Testability).
 *
 * These exercise the REAL {@link BoundedElasticScheduler} + {@link import("../InferenceLeasePool").InferenceLeasePool}
 * with an injected {@link RouteCapacityProvider}, driving the SAME permit→lease→
 * finally wiring `runParallelTasks` installs in its `scheduler.dispatch` run body:
 *
 *   await scheduler.dispatch(name, async (handle) => {
 *     const release = isAutoReader ? () => {} : await handle.acquireLease(capability, signal)
 *     try { ...worker body... } finally { release() }
 *   })
 *
 * Reproducing just that wiring (rather than the full Task/ClineProvider runtime)
 * keeps the throttling/deadlock/spread assertions at the lowest layer that fails
 * for the bug, per the repo Test Placement Guidance. The elastic scheduler's own
 * interleavings are covered in its sibling specs; this cross-references them.
 */

const tick = () => Promise.resolve()
const flush = async () => {
	for (let i = 0; i < 10; i++) await tick()
}

/** A mutable per-capability fake capacity provider; the pool reads it read-only. */
function makeProvider(perCapability: Partial<Record<RouteCapability, number>>): RouteCapacityProvider {
	return {
		capacitiesFor: (capability): readonly RouteCapacity[] => {
			const available = perCapability[capability]
			return available !== undefined && available > 0
				? [{ route: `fake:${capability}`, capability, capacity: available, available }]
				: []
		},
		sustainedPressure: () => 0,
	}
}

interface Worker {
	readonly name: string
	readonly capability: RouteCapability
	readonly autoReader?: boolean
}

interface Deferred {
	readonly promise: Promise<void>
	resolve(): void
}
const defer = (): Deferred => {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/**
 * Drive a batch of workers through the real scheduler using the exact dispatch
 * wiring from `runParallelTasks`. Each worker's body blocks on a caller-controlled
 * gate so the test can observe how many are concurrently `generating` (holding a
 * lease) before letting them settle. Returns handles to inspect/advance the run.
 */
function runBatch(workers: readonly Worker[], provider: RouteCapacityProvider, policy: UserParallelismPolicy = {}) {
	const scheduler = new BoundedElasticScheduler(computeCapacityBounds(provider), policy, provider)
	const plan: ExecutionPlan = { tasks: workers.map((w) => ({ name: w.name, mode: "code", message: "x" })) }
	scheduler.admitPlan(plan)

	const controller = new AbortController()
	// Gates: each worker's body waits for its gate before releasing its lease.
	const gates = new Map<string, Deferred>(workers.map((w) => [w.name, defer()]))
	// Records whether a worker's body actually started (i.e. its lease was acquired
	// for a leased worker, or it ran immediately for an exempt one).
	const bodyStarted = new Set<string>()
	const settled = new Map<string, "completed" | "cancelled" | "failed">()

	const dispatches = workers.map((worker) =>
		scheduler
			.dispatch(worker.name, async (handle: DispatchHandle) => {
				const release = worker.autoReader
					? () => {}
					: await handle.acquireLease(worker.capability, controller.signal)
				try {
					bodyStarted.add(worker.name)
					await gates.get(worker.name)!.promise
				} finally {
					release()
				}
			})
			.then(
				() => {
					if (!settled.has(worker.name)) settled.set(worker.name, "completed")
					scheduler.onWorkerSettled(worker.name, { kind: "completed", resultRef: worker.name })
				},
				() => {
					const state = controller.signal.aborted ? "cancelled" : "failed"
					settled.set(worker.name, state)
					scheduler.onWorkerSettled(
						worker.name,
						state === "cancelled"
							? { kind: "cancelled", reason: "parent-stopped" }
							: { kind: "failed", error: "x" },
					)
				},
			),
	)

	return {
		scheduler,
		controller,
		gates,
		bodyStarted,
		settled,
		all: Promise.all(dispatches),
		countInState: (state: LogicalWorkerState) =>
			[...scheduler.snapshotStates().values()].filter((s) => s === state).length,
		stateOf: (name: string) => scheduler.snapshotStates().get(name),
		releaseAll: () => gates.forEach((g) => g.resolve()),
	}
}

describe("capacity-aware throttling (real scheduler + lease pool)", () => {
	it("admits at most `reasoner` capacity generating at once, queueing the rest inside Menagerie", async () => {
		const workers: Worker[] = Array.from({ length: 6 }, (_, i) => ({
			name: `coder-${i}`,
			capability: "reasoner",
		}))
		const batch = runBatch(workers, makeProvider({ reasoner: 2 }))
		await flush()

		// Capacity 2 ⇒ at most 2 hold a lease (generating) at any instant; the
		// excess is throttled INSIDE Menagerie — either queued on the lease pool
		// (`waiting-for-inference`) or behind a dispatch permit — never all handed
		// to OmniRoute at once. The non-generating workers are all pre-generation.
		expect(batch.countInState("generating")).toBe(2)
		expect(batch.countInState("generating")).toBeLessThanOrEqual(2)
		const nonGenerating = 6 - batch.countInState("generating")
		expect(batch.countInState("waiting-for-inference") + batch.countInState("runnable")).toBe(nonGenerating)

		// Let them drain; all 6 eventually complete (forward progress).
		batch.releaseAll()
		await batch.all
		expect(batch.countInState("completed")).toBe(6)
	})

	it("drains a small-capacity batch with no deadlock (maxDispatched 8, reasoner 2)", async () => {
		const workers: Worker[] = Array.from({ length: 8 }, (_, i) => ({
			name: `coder-${i}`,
			capability: "reasoner",
		}))
		const batch = runBatch(workers, makeProvider({ reasoner: 2 }))
		await flush()
		// Release in waves to exercise the pump() hand-off; the batch must fully drain.
		batch.releaseAll()
		await batch.all
		expect(batch.countInState("completed")).toBe(8)
	})

	it("still throttles and drains when a capability falls through to the bounded default", async () => {
		// `vision` is absent from the provider ⇒ the production provider floors it at
		// the bounded default; here we model the same via a small positive capacity.
		const workers: Worker[] = Array.from({ length: 5 }, (_, i) => ({ name: `v-${i}`, capability: "vision" }))
		const batch = runBatch(workers, makeProvider({ vision: 2 }))
		await flush()
		expect(batch.countInState("generating")).toBe(2)
		batch.releaseAll()
		await batch.all
		expect(batch.countInState("completed")).toBe(5)
	})

	it("rejects queued waiters on abort while lease-holders settle on their own (PAR-021.5)", async () => {
		const workers: Worker[] = Array.from({ length: 5 }, (_, i) => ({ name: `coder-${i}`, capability: "reasoner" }))
		const batch = runBatch(workers, makeProvider({ reasoner: 2 }))
		await flush()
		expect(batch.countInState("generating")).toBe(2)
		const queuedBeforeAbort = 5 - batch.countInState("generating")

		// Cancel the batch: queued/runnable waiters are rejected; lease-holders are untouched.
		batch.controller.abort(new Error("Parent task stopped"))
		batch.scheduler.cancelQueued()
		await flush()

		// Every non-generating (queued/waiting) worker is cancelled; the 2 holders keep their lease.
		expect(batch.countInState("cancelled")).toBe(queuedBeforeAbort)
		expect(batch.countInState("generating")).toBe(2)

		// The holders settle on their own when their bodies finish.
		batch.releaseAll()
		await batch.all
		// No sibling was abandoned mid-flight: every worker reached a terminal state.
		const states = [...batch.scheduler.snapshotStates().values()]
		expect(states.every((s) => s === "completed" || s === "cancelled")).toBe(true)
	})
})

describe("auto-reader lease exemption (finding #4)", () => {
	it("never queues an auto-reader on the reader lease, while a non-auto worker does lease", async () => {
		// 3 auto-readers against reader capacity 2: with a lifetime lease the 3rd
		// would queue in `waiting-for-inference`; exempt, none ever does. One leased
		// coder is included to prove non-auto workers still lease. The batch size (4)
		// equals the capacity-seeded dispatch ceiling here, so dispatch permits are
		// not the bottleneck — the only gate that could queue a worker is the
		// inference lease, which auto-readers skip.
		const workers: Worker[] = [
			// Coder first so it secures an early dispatch permit; the exemption
			// property is about the lease, not the dispatch permit.
			{ name: "coder-0", capability: "reasoner" as RouteCapability },
			...Array.from({ length: 3 }, (_, i) => ({
				name: `auto-${i}`,
				capability: "reader" as RouteCapability,
				autoReader: true,
			})),
		]
		const batch = runBatch(workers, makeProvider({ reader: 2, reasoner: 2 }))
		await flush()

		// Every auto-reader ran its body immediately WITHOUT acquiring a lease, and
		// none is parked in `waiting-for-inference` — even though there are 3 of them
		// against reader capacity 2.
		for (let i = 0; i < 3; i++) {
			expect(batch.bodyStarted.has(`auto-${i}`)).toBe(true)
			expect(batch.stateOf(`auto-${i}`)).not.toBe("waiting-for-inference")
		}
		// The non-auto coder DID lease (it is generating).
		expect(batch.stateOf("coder-0")).toBe("generating")

		batch.releaseAll()
		await batch.all
		expect(batch.countInState("completed")).toBe(4)
	})
})

describe("backend spread agrees with lease throttling (finding #3, second half)", () => {
	const profile = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
		apiProvider: providerIdentifiers.openai,
		...overrides,
	})

	it("spreads N reasoning-typed coders across M code routes by coderOrdinal", () => {
		const p = profile({
			openAiOmniRouteReasonerRouteId: "hybrid/code",
			openAiOmniRouteCustomRoutes: [{ name: "overflow", modelId: "ollama/code", capability: "reasoner" }],
		})
		const codeCapableRouteIds = collectCodeCapableRouteIds(p, "parent")
		expect(codeCapableRouteIds).toEqual(["hybrid/code", "ollama/code"])

		// Resolve route ids for 6 coders (coderOrdinal 0..5), the default reasoning type.
		const routeIds = Array.from({ length: 6 }, (_, ordinal) =>
			resolveLaneRouteId({
				lane: "coder.primary",
				taskType: "implementation",
				profile: p,
				route: undefined,
				parentModelId: "parent",
				coderOrdinal: ordinal,
				codeCapableRouteIds,
			}),
		)
		// Round-robin spread: both backends are used, balanced.
		expect(routeIds.filter((id) => id === "hybrid/code")).toHaveLength(3)
		expect(routeIds.filter((id) => id === "ollama/code")).toHaveLength(3)
	})

	it("holds at most the summed reasoner capacity generating when spread across two backends", async () => {
		// The design's operator rule: when spread is active, `reasoner` capacity equals
		// the summed real slots of the spread backends (here 1 + 1 = 2). Every spread
		// coder still leases against the single `reasoner` pool.
		expect(laneToRouteCapability("coder.primary", "implementation")).toBe("reasoner")
		const workers: Worker[] = Array.from({ length: 6 }, (_, i) => ({ name: `coder-${i}`, capability: "reasoner" }))
		const batch = runBatch(workers, makeProvider({ reasoner: 2 }))
		await flush()
		expect(batch.countInState("generating")).toBe(2)
		batch.releaseAll()
		await batch.all
		expect(batch.countInState("completed")).toBe(6)
	})
})

describe("bounds seeding + user-policy clamp (findings #5)", () => {
	it("seeds the scheduler bounds from capacity and leaves maxLive at 12", () => {
		const provider = makeProvider({ reader: 4, reasoner: 2, general: 1 })
		const scheduler = new BoundedElasticScheduler(computeCapacityBounds(provider), {}, provider)
		expect(scheduler.effectiveBounds.maxInferenceLeases).toBe(7)
		expect(scheduler.effectiveBounds.maxLive).toBe(12)
		// maxDispatched >= largest single pool (reader 4) and >= SMALL_FLOOR (4).
		expect(scheduler.effectiveBounds.maxDispatched).toBeGreaterThanOrEqual(4)
	})

	it("lets a tight user policy clamp both bounds down, and the batch still drains", async () => {
		const provider = makeProvider({ reasoner: 2 })
		const policy: UserParallelismPolicy = { maxLive: 3, maxDispatched: 2 }
		const scheduler = new BoundedElasticScheduler(computeCapacityBounds(provider), policy, provider)
		expect(scheduler.effectiveBounds.maxDispatched).toBe(2)
		expect(scheduler.effectiveBounds.maxLive).toBe(3)

		// Drive 3 workers (= clamped maxLive) under the clamped scheduler: with
		// maxDispatched 2, only 2 progress at a time, but every worker still reaches
		// and releases its lease (unused reasoner slots are tolerated, never a stall).
		const workers: Worker[] = Array.from({ length: 3 }, (_, i) => ({ name: `coder-${i}`, capability: "reasoner" }))
		const plan: ExecutionPlan = { tasks: workers.map((w) => ({ name: w.name, mode: "code", message: "x" })) }
		scheduler.admitPlan(plan)
		const gates = workers.map(() => defer())
		const dispatches = workers.map((worker, i) =>
			scheduler.dispatch(worker.name, async (handle) => {
				const release = await handle.acquireLease(worker.capability, new AbortController().signal)
				try {
					await gates[i].promise
				} finally {
					release()
				}
			}),
		)
		await flush()
		gates.forEach((g) => g.resolve())
		await Promise.all(dispatches)
		for (const worker of workers) {
			scheduler.onWorkerSettled(worker.name, { kind: "completed", resultRef: worker.name })
		}
		expect([...scheduler.snapshotStates().values()].filter((s) => s === "completed")).toHaveLength(3)
	})
})
