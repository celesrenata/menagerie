import { EventEmitter } from "node:events"
import { RooCodeEventName } from "@roo-code/types"
import type { Task } from "../Task"
import { waitForParallelTask } from "../runParallelTasks"

type Child = Parameters<typeof waitForParallelTask>[0]

function fixture() {
	const parent = new AbortController()
	const worker = new AbortController()
	const events = new EventEmitter()
	const childEvents = new EventEmitter()
	// The child's TaskEvents typing is irrelevant here; only its TaskCompleted on/off pair is used.
	const childEmitter = childEvents as unknown as Pick<Task, "on" | "off">
	// run() stays pending until the test ends the loop: a resolved run() now means the loop ended.
	let resolveLoop: (() => void) | undefined
	let rejectLoop: ((error: unknown) => void) | undefined
	const child: Child = {
		taskId: "worker",
		clineMessages: [{ ts: 1, type: "say", say: "completion_result", text: "Worker result" }],
		lifetimeSignal: worker.signal,
		parallelWorkerFailure: undefined,
		run: vi.fn(
			() =>
				new Promise<void>((resolve, reject) => {
					resolveLoop = resolve
					rejectLoop = reject
				}),
		),
		on: childEmitter.on.bind(childEmitter),
		off: childEmitter.off.bind(childEmitter),
	}
	// The provider's extra methods are irrelevant to this event-only contract.
	const provider = events as unknown as Parameters<typeof waitForParallelTask>[1]
	const endLoop = () => resolveLoop?.()
	const failLoop = (error: unknown) => rejectLoop?.(error)
	return { parent, worker, events, childEvents, child, provider, endLoop, failLoop }
}

// Lets run().then(...) and other queued callbacks run.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("parallel worker completion ownership", () => {
	it("subscribes before dispatch and ignores another task's completion", async () => {
		const { parent, events, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		let settled = false
		void pending.then(() => {
			settled = true
		})
		events.emit(RooCodeEventName.TaskCompleted, "unrelated")
		await Promise.resolve()
		expect(settled).toBe(false)
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		await expect(pending).resolves.toBe("Worker result")
		expect(events.listenerCount(RooCodeEventName.TaskCompleted)).toBe(0)
		expect(child.run).toHaveBeenCalledOnce()
	})
	it("removes the result writer on cancellation so late completion cannot revive it", async () => {
		const { parent, events, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		parent.abort(new Error("Parent cancelled"))
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		await expect(pending).rejects.toThrow("Parent cancelled")
		expect(events.listenerCount(RooCodeEventName.TaskCompleted)).toBe(0)
	})
	it("settles when the worker is stopped independently", async () => {
		const { parent, worker, events, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		worker.abort()
		await expect(pending).rejects.toThrow("Worker stopped before completing")
		expect(events.listenerCount(RooCodeEventName.TaskCompleted)).toBe(0)
	})
	it("never starts a worker belonging to an already cancelled parent", async () => {
		const { parent, child, provider } = fixture()
		parent.abort(new Error("Already stopped"))
		await expect(waitForParallelTask(child, provider, parent.signal)).rejects.toThrow("Already stopped")
		expect(child.run).not.toHaveBeenCalled()
	})
	it("returns a stalled worker to the parent without blocking its siblings", async () => {
		const { parent, events, child, provider } = fixture()
		child.clineMessages.push({ ts: 2, type: "ask", ask: "mistake_limit_reached", text: "Repeated list_files" })
		const pending = waitForParallelTask(child, provider, parent.signal)
		events.emit(RooCodeEventName.TaskIdle, "unrelated")
		events.emit(RooCodeEventName.TaskIdle, "worker")
		await expect(pending).rejects.toThrow("mistake_limit_reached")
		expect(events.listenerCount(RooCodeEventName.TaskIdle)).toBe(0)
	})
	it("does not mistake the normal completion prompt for a stalled worker", async () => {
		const { parent, events, child, provider } = fixture()
		child.clineMessages.push({ ts: 2, type: "ask", ask: "completion_result", text: "" })
		const pending = waitForParallelTask(child, provider, parent.signal)
		events.emit(RooCodeEventName.TaskIdle, "worker")
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		await expect(pending).resolves.toBe("Worker result")
	})

	it("reports the worker's own failure reason when it stops itself", async () => {
		const { parent, worker, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		child.parallelWorkerFailure = "boom"
		worker.abort()
		await expect(pending).rejects.toThrow("Worker failed: boom")
	})
	it("rejects when the worker loop ends without attempt_completion", async () => {
		const { parent, child, provider, endLoop } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		endLoop()
		await expect(pending).rejects.toThrow("Worker task loop ended without attempt_completion")
	})
	it("resolves from the child's completion even if the lifetime aborts before the provider re-emits", async () => {
		const { parent, worker, events, childEvents, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		childEvents.emit(RooCodeEventName.TaskCompleted, "worker")
		worker.abort()
		await expect(pending).resolves.toBe("Worker result")
		// The provider's delayed re-emit is a no-op once settled.
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		await expect(pending).resolves.toBe("Worker result")
	})
	it("resolves from the child's completion even if run() resolves before the provider re-emits", async () => {
		const { parent, childEvents, child, provider, endLoop } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		childEvents.emit(RooCodeEventName.TaskCompleted, "worker")
		endLoop()
		await flush()
		await expect(pending).resolves.toBe("Worker result")
	})
	it("falls back to the provider's completion when the child's event is not seen", async () => {
		const { parent, events, child, provider } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		await expect(pending).resolves.toBe("Worker result")
	})
	it("removes both TaskCompleted listeners on every settle path", async () => {
		const paths: Array<(f: ReturnType<typeof fixture>) => void> = [
			(f) => f.childEvents.emit(RooCodeEventName.TaskCompleted, "worker"),
			(f) => f.events.emit(RooCodeEventName.TaskCompleted, "worker"),
			(f) => f.parent.abort(new Error("Parent cancelled")),
			(f) => f.worker.abort(),
			(f) => f.endLoop(),
			(f) => f.failLoop(new Error("loop threw")),
		]
		for (const settleBy of paths) {
			const f = fixture()
			const pending = waitForParallelTask(f.child, f.provider, f.parent.signal)
			expect(f.childEvents.listenerCount(RooCodeEventName.TaskCompleted)).toBe(1)
			expect(f.events.listenerCount(RooCodeEventName.TaskCompleted)).toBe(1)
			settleBy(f)
			await pending.catch(() => {})
			expect(f.childEvents.listenerCount(RooCodeEventName.TaskCompleted)).toBe(0)
			expect(f.events.listenerCount(RooCodeEventName.TaskCompleted)).toBe(0)
		}
		const f = fixture()
		const pending = waitForParallelTask(f.child, f.provider, f.parent.signal)
		f.failLoop(new Error("loop threw"))
		await expect(pending).rejects.toThrow("loop threw")
	})
	it("still resolves when the provider's completion arrives just before run() resolves", async () => {
		const { parent, events, child, provider, endLoop } = fixture()
		const pending = waitForParallelTask(child, provider, parent.signal)
		events.emit(RooCodeEventName.TaskCompleted, "worker")
		endLoop()
		await flush()
		await expect(pending).resolves.toBe("Worker result")
	})
})
