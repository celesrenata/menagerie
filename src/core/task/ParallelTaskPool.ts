/** A process-wide, abortable limit for independent task runtimes. */
export class ParallelTaskPool {
	private active = 0
	private queue: Array<() => void> = []

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid task capacity")
	}

	async run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
		const release = await this.acquire(signal)
		try {
			signal.throwIfAborted()
			return await run()
		} finally {
			release()
		}
	}

	private acquire(signal: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.queue = this.queue.filter((entry) => entry !== admit)
				reject(signal.reason ?? new Error("Task cancelled"))
			}
			const admit = () => {
				signal.removeEventListener("abort", abort)
				if (signal.aborted) {
					abort()
					this.drain()
					return
				}
				this.active++
				let released = false
				resolve(() => {
					if (released) return
					released = true
					this.active--
					this.drain()
				})
			}
			if (signal.aborted) return abort()
			signal.addEventListener("abort", abort, { once: true })
			this.queue.push(admit)
			this.drain()
		})
	}

	private drain() {
		while (this.active < this.capacity && this.queue.length) this.queue.shift()!()
	}
}

export const parallelTaskPool = new ParallelTaskPool(4)
