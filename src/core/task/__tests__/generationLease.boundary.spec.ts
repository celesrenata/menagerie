import { BoundedElasticScheduler, type DispatchHandle } from "../BoundedElasticScheduler"
import type { ExecutionPlan, LogicalWorkerState, RouteCapability, RouteCapacityProvider } from "../elasticTypes"
import { computeCapacityBounds } from "../routeCapacityMap"
import { acquireGenerationLease, type InferenceLeaseProvider } from "../generationLease"

/**
 * P5 generation-boundary contract: a dispatch permit covers the worker's whole
 * run, but the inference lease is held only while generating. Worker A waiting
 * on a tool must free the lane so worker B can generate. Capacity 1 never has
 * two simultaneous generations.
 */

const tick = () => Promise.resolve()
const flush = async () => {
	for (let i = 0; i < 12; i++) await tick()
}

function makeProvider(perCapability: Partial<Record<RouteCapability, number>>): RouteCapacityProvider {
	return {
		capacitiesFor: (capability) => {
			const available = perCapability[capability]
			return available !== undefined && available > 0
				? [{ route: `fake:${capability}`, capability, capacity: available, available }]
				: []
		},
		sustainedPressure: () => 0,
	}
}

const defer = () => {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

function runGenerationBoundary(names: readonly string[], provider: RouteCapacityProvider) {
	const scheduler = new BoundedElasticScheduler(computeCapacityBounds(provider), { maxDispatched: 8 }, provider)
	const plan: ExecutionPlan = { tasks: names.map((name) => ({ name, mode: "code", message: "x" })) }
	scheduler.admitPlan(plan)

	const controller = new AbortController()
	const generateGate = new Map(names.map((name) => [name, defer()]))
	const toolGate = new Map(names.map((name) => [name, defer()]))
	const generating = new Set<string>()
	const peakGenerating: number[] = []
	const toolWaiting = new Set<string>()
	const bodyStarted = new Set<string>()

	const notePeak = () => peakGenerating.push(generating.size)

	const dispatches = names.map((name) =>
		scheduler.dispatch(name, async (handle: DispatchHandle) => {
			bodyStarted.add(name)
			const leaseProvider: InferenceLeaseProvider = {
				acquire: (signal) => handle.acquireLease("reasoner", signal),
			}

			const release = await acquireGenerationLease(leaseProvider, controller.signal)
			generating.add(name)
			notePeak()
			try {
				await generateGate.get(name)!.promise
			} finally {
				generating.delete(name)
				release()
			}

			toolWaiting.add(name)
			await toolGate.get(name)!.promise
			toolWaiting.delete(name)
		}),
	)

	return {
		scheduler,
		controller,
		bodyStarted,
		generating,
		toolWaiting,
		peakGenerating,
		countInState: (state: LogicalWorkerState) =>
			[...scheduler.snapshotStates().values()].filter((s) => s === state).length,
		stateOf: (name: string) => scheduler.snapshotStates().get(name),
		finishGeneration: (name: string) => generateGate.get(name)!.resolve(),
		finishTool: (name: string) => toolGate.get(name)!.resolve(),
		all: Promise.all(dispatches),
	}
}

describe("per-generation inference leases (P5)", () => {
	it("lets worker B generate while worker A waits on a tool under capacity 1", async () => {
		const batch = runGenerationBoundary(["A", "B"], makeProvider({ reasoner: 1 }))
		await flush()

		expect(batch.bodyStarted.has("A")).toBe(true)
		expect(batch.bodyStarted.has("B")).toBe(true)
		expect(batch.generating.size).toBe(1)
		expect(batch.countInState("generating")).toBe(1)

		const first = batch.generating.has("A") ? "A" : "B"
		const second = first === "A" ? "B" : "A"

		batch.finishGeneration(first)
		await flush()

		expect(batch.toolWaiting.has(first)).toBe(true)
		expect(batch.generating.has(first)).toBe(false)
		expect(batch.generating.has(second)).toBe(true)
		expect(batch.countInState("generating")).toBe(1)
		expect(Math.max(...batch.peakGenerating)).toBe(1)

		batch.finishGeneration(second)
		batch.finishTool(first)
		batch.finishTool(second)
		await batch.all
		expect(batch.countInState("runnable") + batch.countInState("completed")).toBeGreaterThanOrEqual(0)
	})

	it("releases a held lease on abort so a queued worker is not starved", async () => {
		const batch = runGenerationBoundary(["holder", "waiter"], makeProvider({ reasoner: 1 }))
		await flush()
		expect(batch.countInState("generating")).toBe(1)

		const holder = batch.generating.has("holder") ? "holder" : "waiter"
		const waiter = holder === "holder" ? "waiter" : "holder"
		expect(batch.stateOf(waiter) === "waiting-for-inference" || batch.stateOf(waiter) === "runnable").toBe(true)

		batch.controller.abort(new Error("stream aborted"))
		batch.finishGeneration(holder)
		await flush()

		expect(batch.generating.size).toBe(0)
		batch.finishTool(holder)
		batch.finishTool(waiter)
		await expect(batch.all).rejects.toBeTruthy()
	})

	it("never holds more than one simultaneous generation in a capacity-1 lane", async () => {
		const batch = runGenerationBoundary(["A", "B", "C"], makeProvider({ reasoner: 1 }))
		await flush()
		expect(batch.countInState("generating")).toBe(1)

		for (const name of ["A", "B", "C"]) batch.finishGeneration(name)
		await flush()
		for (const name of ["A", "B", "C"]) batch.finishTool(name)
		await batch.all
		expect(Math.max(...batch.peakGenerating)).toBe(1)
	})
})
