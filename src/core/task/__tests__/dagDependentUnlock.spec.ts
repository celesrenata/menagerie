import { BoundedElasticScheduler } from "../BoundedElasticScheduler"
import type { ExecutionPlan, RouteCapacityProvider, WorkerCompletionEvent } from "../elasticTypes"
import { computeCapacityBounds } from "../routeCapacityMap"
import { buildExecutionPlan } from "../../tools/ParallelTasksTool"

/**
 * P6 DAG end-to-end (lift C4): per-spec `dependsOn` becomes real DAG edges; a
 * dependent is admitted `waiting-on-dependency`, and the instant its
 * prerequisite settles `completed`, the dependent unlocks to `runnable` without
 * any sibling being touched.
 */
function makeScheduler() {
	const provider: RouteCapacityProvider = {
		capacitiesFor: () => [{ route: "fake/general", capability: "general", capacity: 4, available: 4 }],
		sustainedPressure: () => 0,
	}
	return { scheduler: new BoundedElasticScheduler(computeCapacityBounds(provider), { maxDispatched: 8 }, provider), provider }
}

describe("DAG dependent unlock end-to-end", () => {
	it("a dependent is admitted waiting-on-dependency and unlocks when its prerequisite completes", () => {
		const { scheduler } = makeScheduler()
		const plan: ExecutionPlan = buildExecutionPlan([
			{ name: "build", mode: "code", message: "x" },
			{ name: "test", mode: "code", message: "x", dependsOn: ["build"] },
		])
		scheduler.admitPlan(plan)

		const events: WorkerCompletionEvent[] = []
		scheduler.subscribeCompletion((event) => {
			events.push(event)
		})

		// Build completes → its dependent (test) unlocks.
		scheduler.onWorkerSettled("build", { kind: "completed", resultRef: "manifest-build" })
		expect(events).toHaveLength(1)
		expect(events[0]!.workerId).toBe("build")
		expect(events[0]!.unlockedDependents).toEqual(["test"])

		// A failed prerequisite does NOT unlock dependents.
	})

	it("a failed prerequisite does not unlock its dependents", () => {
		const { scheduler } = makeScheduler()
		const plan: ExecutionPlan = buildExecutionPlan([
			{ name: "build", mode: "code", message: "x" },
			{ name: "test", mode: "code", message: "x", dependsOn: ["build"] },
		])
		scheduler.admitPlan(plan)

		const events: WorkerCompletionEvent[] = []
		scheduler.subscribeCompletion((event) => {
			events.push(event)
		})

		scheduler.onWorkerSettled("build", { kind: "failed", error: "boom" })
		expect(events).toHaveLength(1)
		expect(events[0]!.unlockedDependents).toEqual([])
	})
})
