import { AnalysisQueue } from "../AnalysisQueue"
import { AnalysisTransportError } from "../GraniteAnalysisClient"

function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
	} catch (error) {
		if (error instanceof AnalysisTransportError) return error.kind
		throw error
	}
	return "no-error"
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("AnalysisQueue", () => {
	it("runs at most maxActive jobs at once and queues the third", async () => {
		const queue = new AnalysisQueue({ maxActive: 2, maxQueued: 8 })
		const gates = [deferred(), deferred(), deferred()]
		let running = 0
		let peak = 0
		const jobs = gates.map((gate, i) =>
			queue.run(
				async () => {
					running++
					peak = Math.max(peak, running)
					await gate.promise
					running--
					return i
				},
				{ deadlineMs: 5000 },
			),
		)
		await tick()
		expect(queue.active).toBe(2)
		expect(queue.waiting).toBe(1)
		gates[0].resolve()
		await tick()
		expect(queue.active).toBe(2)
		expect(queue.waiting).toBe(0)
		gates[1].resolve()
		gates[2].resolve()
		expect(await Promise.all(jobs)).toEqual([0, 1, 2])
		expect(peak).toBe(2)
		expect(queue.active).toBe(0)
	})

	it("never exceeds capacity across many random-duration jobs and drains fully", async () => {
		const queue = new AnalysisQueue({ maxActive: 2, maxQueued: 100 })
		let running = 0
		let peak = 0
		const jobs = Array.from({ length: 40 }, (_, i) =>
			queue.run(
				async () => {
					running++
					peak = Math.max(peak, running)
					await new Promise((r) => setTimeout(r, (i * 7) % 5))
					running--
				},
				{ deadlineMs: 5000 },
			),
		)
		await Promise.all(jobs)
		expect(peak).toBeLessThanOrEqual(2)
		expect(queue.active).toBe(0)
		expect(queue.waiting).toBe(0)
	})

	it("rejects with queue-full once the bounded queue is occupied", async () => {
		const queue = new AnalysisQueue({ maxActive: 1, maxQueued: 1 })
		const gate = deferred()
		const first = queue.run(() => gate.promise, { deadlineMs: 5000 })
		const second = queue.run(async () => 2, { deadlineMs: 5000 })
		await tick()
		expect(await kindOf(queue.run(async () => 3, { deadlineMs: 5000 }))).toBe("queue-full")
		gate.resolve()
		await first
		expect(await second).toBe(2)
	})

	it("releases the permit when a job throws", async () => {
		const queue = new AnalysisQueue({ maxActive: 1, maxQueued: 4 })
		await expect(queue.run(async () => Promise.reject(new Error("boom")), { deadlineMs: 5000 })).rejects.toThrow("boom")
		expect(await queue.run(async () => "ok", { deadlineMs: 5000 })).toBe("ok")
		expect(queue.active).toBe(0)
	})

	it("times out a queued job and keeps the permit holder untouched", async () => {
		const queue = new AnalysisQueue({ maxActive: 1, maxQueued: 4 })
		const gate = deferred()
		const holder = queue.run(() => gate.promise.then(() => "held"), { deadlineMs: 5000 })
		await tick()
		expect(await kindOf(queue.run(async () => 1, { deadlineMs: 20 }))).toBe("timeout")
		expect(queue.waiting).toBe(0)
		gate.resolve()
		expect(await holder).toBe("held")
		// Permit is intact: a new job runs immediately.
		expect(await queue.run(async () => "next", { deadlineMs: 5000 })).toBe("next")
	})

	it("times out a running job via the abort signal and frees its permit", async () => {
		const queue = new AnalysisQueue({ maxActive: 1, maxQueued: 4 })
		const stuck = queue.run(
			(signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")))
				}),
			{ deadlineMs: 20 },
		)
		expect(await kindOf(stuck)).toBe("timeout")
		expect(await queue.run(async () => "after", { deadlineMs: 5000 })).toBe("after")
	})

	it("cancels queued and running jobs and releases their permits", async () => {
		const queue = new AnalysisQueue({ maxActive: 1, maxQueued: 4 })
		const callerA = new AbortController()
		const callerB = new AbortController()
		const running = queue.run(
			(signal) =>
				new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
			{ deadlineMs: 5000, signal: callerA.signal },
		)
		const queued = queue.run(async () => 1, { deadlineMs: 5000, signal: callerB.signal })
		await tick()
		callerB.abort()
		expect(await kindOf(queued)).toBe("cancelled")
		callerA.abort()
		expect(await kindOf(running)).toBe("cancelled")
		expect(queue.active).toBe(0)
		expect(await queue.run(async () => "free", { deadlineMs: 5000 })).toBe("free")
	})

	it("rejects immediately when already cancelled", async () => {
		const queue = new AnalysisQueue({ maxActive: 2, maxQueued: 4 })
		const c = new AbortController()
		c.abort()
		const job = vi.fn(async () => 1)
		expect(await kindOf(queue.run(job, { deadlineMs: 5000, signal: c.signal }))).toBe("cancelled")
		expect(job).not.toHaveBeenCalled()
	})

	it("reads capacity live so an operator-published change applies", async () => {
		let cap = 1
		const queue = new AnalysisQueue({ maxActive: () => cap, maxQueued: 4 })
		const gate = deferred()
		const a = queue.run(() => gate.promise, { deadlineMs: 5000 })
		const b = queue.run(() => gate.promise, { deadlineMs: 5000 })
		await tick()
		expect(queue.active).toBe(1)
		gate.resolve()
		await Promise.all([a, b])
		cap = 2
		const g2 = deferred()
		const c = queue.run(() => g2.promise, { deadlineMs: 5000 })
		const d = queue.run(() => g2.promise, { deadlineMs: 5000 })
		await tick()
		expect(queue.active).toBe(2)
		g2.resolve()
		await Promise.all([c, d])
	})
})
