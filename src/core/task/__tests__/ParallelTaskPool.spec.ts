import { ParallelTaskPool } from "../ParallelTaskPool"

function barrier() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe("ParallelTaskPool", () => {
	it("admits four independent workers before queueing a fifth", async () => {
		const pool = new ParallelTaskPool(4)
		const gate = barrier()
		const started: number[] = []
		const jobs = [1, 2, 3, 4, 5].map((index) =>
			pool.run(new AbortController().signal, async () => {
				started.push(index)
				await gate.promise
			}),
		)
		await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]))
		gate.release()
		await Promise.all(jobs)
		expect(started).toEqual([1, 2, 3, 4, 5])
	})

	it("runs independent jobs together, queues excess jobs, and releases failed permits", async () => {
		const pool = new ParallelTaskPool(2)
		const signal = new AbortController().signal
		const gate = barrier()
		const started: number[] = []
		const first = pool
			.run(signal, async () => {
				started.push(1)
				await gate.promise
				throw new Error("failed")
			})
			.catch(String)
		const second = pool.run(signal, async () => {
			started.push(2)
			await gate.promise
		})
		const third = pool.run(signal, async () => {
			started.push(3)
		})
		await vi.waitFor(() => expect(started).toEqual([1, 2]))
		gate.release()
		await Promise.all([first, second, third])
		expect(started).toEqual([1, 2, 3])
	})

	it("cancels only the requesting parent's queued jobs without waiting for another parent", async () => {
		const pool = new ParallelTaskPool(1)
		const gate = barrier()
		const running = pool.run(new AbortController().signal, () => gate.promise)
		const cancelled = new AbortController()
		const operation = vi.fn(async () => {})
		const queued = pool.run(cancelled.signal, operation)
		const rejected = expect(queued).rejects.toThrow("stopped")
		cancelled.abort(new Error("stopped"))
		await rejected
		expect(operation).not.toHaveBeenCalled()
		gate.release()
		await running
		await pool.run(new AbortController().signal, operation)
		expect(operation).toHaveBeenCalledTimes(1)
	})

	it("never runs a job cancelled before admission", async () => {
		const pool = new ParallelTaskPool(3)
		const cancelled = new AbortController()
		cancelled.abort(new Error("stopped"))
		const operation = vi.fn(async () => {})
		await expect(pool.run(cancelled.signal, operation)).rejects.toThrow("stopped")
		expect(operation).not.toHaveBeenCalled()
	})
})
