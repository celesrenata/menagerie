import { ParallelismMetricsCollector } from "../ParallelismMetrics"

describe("ParallelismMetricsCollector C5 counters", () => {
	it("counts backpressure decisions and lease-starvation events separately", () => {
		const collector = new ParallelismMetricsCollector(() => 0)
		collector.onWorkerCreated("w1", "runnable")

		collector.onNewFanOutDeniedByBackpressure()
		collector.onNewFanOutDeniedByBackpressure()
		collector.onLeaseStarvation()

		const snapshot = collector.snapshot()
		expect(snapshot.newFanOutDeniedByBackpressure).toBe(2)
		expect(snapshot.leaseStarvationEvents).toBe(1)
	})

	it("defaults both counters to zero", () => {
		const collector = new ParallelismMetricsCollector(() => 0)
		expect(collector.snapshot().newFanOutDeniedByBackpressure).toBe(0)
		expect(collector.snapshot().leaseStarvationEvents).toBe(0)
	})
})
