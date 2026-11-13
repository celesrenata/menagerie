import { describe, expect, it, vi } from "vitest"
import type { Task } from "../../Task"
import type { ClineProvider } from "../../../webview/ClineProvider"
import type { ParallelTaskSpec } from "../../../tools/ParallelTasksTool"
import type { ParallelTaskResult, RunParallelTasksOptions } from "../../runParallelTasks"
import { BackgroundBatchService, type BackgroundRunner } from "../BackgroundBatchService"
import { renderBackgroundTasksSection, renderSteeringSection } from "../renderBackgroundReport"

const spec = (name: string): ParallelTaskSpec =>
	({ name, mode: "code", message: "do it", todos: null }) as ParallelTaskSpec

function makeParent(taskId = "parent-1") {
	const controller = new AbortController()
	const addMessage = vi.fn()
	const parent = {
		taskId,
		lifetimeSignal: controller.signal,
		idleAsk: undefined as unknown,
		messageQueueService: { addMessage },
	}
	return { parent: parent as unknown as Task, raw: parent, controller, addMessage }
}

/** A runner the test drives by hand: settle workers individually, then finish the batch. */
function makeControlledRunner() {
	let options!: RunParallelTasksOptions
	let finish!: () => void
	let fail!: (error: Error) => void
	const runner: BackgroundRunner = (_parent, _provider, _specs, _policy, opts) => {
		options = opts
		return new Promise((resolve, reject) => {
			finish = () => resolve({ manifestPath: "/tmp/manifest.json" })
			fail = reject
		})
	}
	return {
		runner,
		options: () => options,
		finish: () => finish(),
		fail: (error: Error) => fail(error),
	}
}

const done = (name: string, state: ParallelTaskResult["state"] = "completed"): ParallelTaskResult => ({
	name,
	mode: "code",
	state,
	result: `${name} output`,
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("BackgroundBatchService", () => {
	it("returns immediately while workers are still running", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		const started = service.start({
			parent,
			provider: {} as ClineProvider,
			specs: [spec("a"), spec("b")],
			policy: {},
		})
		expect(started.names).toEqual(["a", "b"])
		expect(service.hasActive("parent-1")).toBe(true)
		expect(service.status("parent-1")[0]!.workers.map((w) => w.state)).toEqual(["running", "running"])
		control.finish()
	})

	it("delivers a settled result exactly once and keeps listing the still-running worker", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a"), spec("b")], policy: {} })
		control.options().onWorkerSettled?.(done("a"))
		const first = service.takeReport("parent-1")!
		expect(first.batches[0]!.results.map((r) => r.name)).toEqual(["a"])
		expect(first.running.map((w) => w.name)).toEqual(["b"])
		const second = service.takeReport("parent-1")!
		expect(second.batches).toEqual([])
		expect(second.running.map((w) => w.name)).toEqual(["b"])
		expect(renderBackgroundTasksSection(first)).toContain("# Background Tasks")
		expect(renderBackgroundTasksSection(first)).toContain("a output")
	})

	it("forgets a batch once it is finished, delivered and idle", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {} })
		control.options().onWorkerSettled?.(done("a"))
		control.finish()
		await flush()
		service.takeReport("parent-1")
		expect(service.hasActive("parent-1")).toBe(false)
		expect(service.takeReport("parent-1")).toBeUndefined()
	})

	it("steers a running worker once and rejects steering after it settles", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a"), spec("b")], policy: {} })
		const child = {} as Task
		control.options().onWorkerStarted?.("a", child)
		expect(service.steer("parent-1", "a", "use v2")).toEqual({ steered: ["a"], rejected: [] })
		expect(child.steeringDrain!()).toEqual(["use v2"])
		expect(child.steeringDrain!()).toEqual([])
		control.options().onWorkerSettled?.(done("a"))
		const late = service.steer("parent-1", "a", "too late")
		expect(late.steered).toEqual([])
		expect(late.rejected[0]!.name).toBe("a")
		expect(renderSteeringSection(["x"])).toContain("# Steering from parent")
	})

	it("steers every running worker of a batch by batchId and reports unknown targets", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		const { batchId } = service.start({
			parent,
			provider: {} as ClineProvider,
			specs: [spec("a"), spec("b")],
			policy: {},
		})
		control.options().onWorkerSettled?.(done("b"))
		expect(service.steer("parent-1", batchId, "hi").steered).toEqual(["a"])
		expect(service.steer("parent-1", "nope", "hi").rejected[0]!.reason).toBe("unknown target")
		expect(service.steer("other-parent", "a", "hi").rejected[0]!.reason).toBe("unknown target")
	})

	it("cancels one worker through its registered cancel hook and delivers it as cancelled", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {} })
		const cancel = vi.fn()
		control.options().registerWorkerCancel?.("a", cancel)
		expect(service.cancel("parent-1", "a").cancelled).toEqual(["a"])
		expect(cancel).toHaveBeenCalledOnce()
		// The runner reports the aborted worker afterwards; it must not be delivered twice.
		control.options().onWorkerSettled?.(done("a", "cancelled"))
		const report = service.takeReport("parent-1")!
		expect(report.batches[0]!.results.map((r) => r.state)).toEqual(["cancelled"])
		expect(service.cancel("parent-1", "a").rejected[0]!.reason).toBe("already cancelled")
	})

	it("cancels running workers and stops delivery when the parent stops", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent, controller } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {} })
		controller.abort()
		expect(control.options().abortSignal!.aborted).toBe(true)
		expect(service.status("parent-1")[0]!.workers[0]!.state).toBe("cancelled")
		control.options().onWorkerSettled?.(done("a"))
		expect(service.takeReport("parent-1")?.batches ?? []).toEqual([])
		expect(service.steer("parent-1", "a", "x").steered).toEqual([])
	})

	it("fails every unsettled worker when the whole run rejects", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a"), spec("b")], policy: {} })
		control.options().onWorkerSettled?.(done("a"))
		control.fail(new Error("snapshot failed"))
		await flush()
		const report = service.takeReport("parent-1")!
		expect(report.batches[0]!.results.map((r) => `${r.name}:${r.state}`).sort()).toEqual([
			"a:completed",
			"b:failed",
		])
	})

	it("delivers the afterBatch result once after the batch finishes", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent } = makeParent()
		const afterBatch = vi.fn().mockResolvedValue({ specGate: "pass" })
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {}, afterBatch })
		control.options().onWorkerSettled?.(done("a"))
		control.finish()
		await flush()
		expect(afterBatch).toHaveBeenCalledWith(expect.objectContaining({ manifestPath: "/tmp/manifest.json" }))
		const report = service.takeReport("parent-1")!
		expect(report.batches[0]!.postProcessing).toEqual({ specGate: "pass" })
		expect(service.takeReport("parent-1")).toBeUndefined()
	})

	it("queues a notice through the message queue only when the parent is idle", async () => {
		const control = makeControlledRunner()
		const service = new BackgroundBatchService(control.runner)
		const { parent, raw, addMessage } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a"), spec("b")], policy: {} })
		control.options().onWorkerSettled?.(done("a"))
		expect(addMessage).not.toHaveBeenCalled()
		raw.idleAsk = { ask: "completion_result" }
		control.options().onWorkerSettled?.(done("b"))
		expect(addMessage).toHaveBeenCalledOnce()
		expect(addMessage.mock.calls[0]![0]).toContain('Worker "b"')
	})

	it("wait resolves when a result is ready and on timeout", async () => {
		vi.useFakeTimers()
		try {
			const control = makeControlledRunner()
			const service = new BackgroundBatchService(control.runner)
			const { parent } = makeParent()
			service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {} })
			let resolved = false
			const waiting = service.wait("parent-1", 5_000).then(() => (resolved = true))
			await vi.advanceTimersByTimeAsync(100)
			expect(resolved).toBe(false)
			control.options().onWorkerSettled?.(done("a"))
			await waiting
			expect(resolved).toBe(true)

			const second = makeControlledRunner()
			const other = new BackgroundBatchService(second.runner)
			other.start({ parent, provider: {} as ClineProvider, specs: [spec("z")], policy: {} })
			const timedOut = other.wait("parent-1", 1_000)
			await vi.advanceTimersByTimeAsync(1_000)
			await expect(timedOut).resolves.toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it("passes one shared lease-pool map to every batch", async () => {
		const first = makeControlledRunner()
		const second = makeControlledRunner()
		let which = 0
		const service = new BackgroundBatchService((...args) =>
			which++ === 0 ? first.runner(...args) : second.runner(...args),
		)
		const { parent } = makeParent()
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("a")], policy: {} })
		service.start({ parent, provider: {} as ClineProvider, specs: [spec("b")], policy: {} })
		expect(first.options().sharedLeasePools).toBeDefined()
		expect(first.options().sharedLeasePools).toBe(second.options().sharedLeasePools)
	})
})
