import { describe, expect, it } from "vitest"
import {
	cancelBackgroundWorker,
	deliverSettledResults,
	detachBatch,
	drainWorkerSteering,
	hasRunningWorkers,
	hasUndeliveredResults,
	loseBackgroundParent,
	settleBackgroundWorker,
	steerBackgroundWorker,
} from "../backgroundBatchLifecycle"
import { LifecycleTransitionError } from "../taskLifecycle"

const fresh = () => detachBatch("b1", "parent", ["a", "b"])

describe("backgroundBatchLifecycle", () => {
	it("detaches with every worker running and the parent live", () => {
		const batch = fresh()
		expect(batch.parentLive).toBe(true)
		expect(batch.workers.a.state).toBe("running")
		expect(hasRunningWorkers(batch)).toBe(true)
	})

	it("rejects empty and duplicate worker lists", () => {
		expect(() => detachBatch("b", "p", [])).toThrow(LifecycleTransitionError)
		expect(() => detachBatch("b", "p", ["x", "x"])).toThrow(LifecycleTransitionError)
	})

	it("delivers a settled result exactly once and never before it settles", () => {
		let batch = fresh()
		expect(deliverSettledResults(batch).delivered).toEqual([])
		batch = settleBackgroundWorker(batch, "a", "completed")
		const first = deliverSettledResults(batch)
		expect(first.delivered).toEqual(["a"])
		expect(deliverSettledResults(first.batch).delivered).toEqual([])
		expect(hasUndeliveredResults(first.batch)).toBe(false)
	})

	it("refuses to settle a worker twice", () => {
		const batch = settleBackgroundWorker(fresh(), "a", "failed")
		expect(() => settleBackgroundWorker(batch, "a", "completed")).toThrow(LifecycleTransitionError)
	})

	it("queues steering for a running worker and drains it once", () => {
		let batch = steerBackgroundWorker(fresh(), "a", "use tabs")
		batch = steerBackgroundWorker(batch, "a", "also add tests")
		const drained = drainWorkerSteering(batch, "a")
		expect(drained.items).toEqual(["use tabs", "also add tests"])
		expect(drained.batch.workers.a.steeringDelivered).toBe(2)
		expect(drainWorkerSteering(drained.batch, "a").items).toEqual([])
	})

	it("rejects steering for settled workers, empty text, and unknown workers", () => {
		const settled = settleBackgroundWorker(fresh(), "a", "completed")
		expect(() => steerBackgroundWorker(settled, "a", "late")).toThrow(LifecycleTransitionError)
		expect(() => steerBackgroundWorker(fresh(), "a", "  ")).toThrow(LifecycleTransitionError)
		expect(() => steerBackgroundWorker(fresh(), "zzz", "x")).toThrow(LifecycleTransitionError)
	})

	it("drops pending steering with a reason when the worker settles", () => {
		const steered = steerBackgroundWorker(fresh(), "a", "too late")
		const settled = settleBackgroundWorker(steered, "a", "completed")
		expect(settled.workers.a.steering).toEqual([])
		expect(settled.workers.a.steeringDropped).toEqual([{ text: "too late", reason: "worker-settled" }])
	})

	it("explicit cancel settles the worker as cancelled and stays deliverable", () => {
		const batch = cancelBackgroundWorker(fresh(), "b")
		expect(batch.workers.b.state).toBe("cancelled")
		expect(deliverSettledResults(batch).delivered).toEqual(["b"])
	})

	it("parent loss cancels running workers, drops steering, and blocks delivery and steering", () => {
		let batch = steerBackgroundWorker(fresh(), "a", "hello")
		batch = settleBackgroundWorker(batch, "b", "completed")
		const lost = loseBackgroundParent(batch)
		expect(lost.parentLive).toBe(false)
		expect(lost.workers.a.state).toBe("cancelled")
		expect(lost.workers.b.state).toBe("completed")
		expect(lost.workers.a.steeringDropped).toEqual([{ text: "hello", reason: "parent-lost" }])
		expect(() => deliverSettledResults(lost)).toThrow(LifecycleTransitionError)
		expect(() => steerBackgroundWorker(lost, "a", "x")).toThrow(LifecycleTransitionError)
		expect(hasUndeliveredResults(lost)).toBe(false)
		expect(loseBackgroundParent(lost)).toBe(lost)
	})
})
