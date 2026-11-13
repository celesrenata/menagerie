import { describe, expect, it } from "vitest"
import { BoundedElasticScheduler } from "../BoundedElasticScheduler"
import type { InferenceLeasePool } from "../InferenceLeasePool"
import type { RouteCapability, RouteCapacityProvider } from "../elasticTypes"

const oneSlot: RouteCapacityProvider = {
	capacitiesFor: (capability: RouteCapability) => [
		{ route: `static:${capability}`, capability, capacity: 1, available: 1 },
	],
	sustainedPressure: () => 0,
} as unknown as RouteCapacityProvider

const bounds = { maxLive: 12, maxDispatched: 8, maxInferenceLeases: 1 }
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`)

function schedulerWith(names: string[], shared?: Map<RouteCapability, InferenceLeasePool>) {
	const scheduler = new BoundedElasticScheduler(bounds, {}, oneSlot, shared)
	scheduler.admitPlan({ tasks: names.map((name) => ({ name, mode: "code", message: "m", todos: null })) } as never)
	return scheduler
}

describe("BoundedElasticScheduler shared lease pools", () => {
	it("makes two concurrent batches compete for the same capability slots", async () => {
		const shared = new Map<RouteCapability, InferenceLeasePool>()
		const first = schedulerWith(ids("a", 1), shared)
		const second = schedulerWith(ids("b", 1), shared)
		const events: string[] = []
		let releaseFirst!: () => void
		const hold = new Promise<void>((resolve) => (releaseFirst = resolve))
		const signal = new AbortController().signal
		const runFirst = first.dispatch("a0", async (handle) => {
			const release = await handle.acquireLease("reasoner", signal)
			events.push("a0-lease")
			await hold
			release()
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		const runSecond = second.dispatch("b0", async (handle) => {
			const release = await handle.acquireLease("reasoner", signal)
			events.push("b0-lease")
			release()
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		// One shared slot: the second batch must still be queued.
		expect(events).toEqual(["a0-lease"])
		releaseFirst()
		await Promise.all([runFirst, runSecond])
		expect(events).toEqual(["a0-lease", "b0-lease"])
	})

	it("keeps pools private when no shared map is given", async () => {
		const first = schedulerWith(ids("a", 1))
		const second = schedulerWith(ids("b", 1))
		const signal = new AbortController().signal
		const events: string[] = []
		let releaseFirst!: () => void
		const hold = new Promise<void>((resolve) => (releaseFirst = resolve))
		const runFirst = first.dispatch("a0", async (handle) => {
			const release = await handle.acquireLease("reasoner", signal)
			events.push("a0")
			await hold
			release()
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		await second.dispatch("b0", async (handle) => {
			const release = await handle.acquireLease("reasoner", signal)
			events.push("b0")
			release()
		})
		expect(events).toEqual(["a0", "b0"])
		releaseFirst()
		await runFirst
	})
})
