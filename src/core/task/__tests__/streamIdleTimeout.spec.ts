import { awaitWithStreamTimeout, StreamIdleTimeoutError } from "../streamIdleTimeout"

describe("awaitWithStreamTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("resolves with the value and clears the timer when next settles first", async () => {
		const result = awaitWithStreamTimeout(Promise.resolve("chunk"), { timeoutMs: 1000, phase: "between_chunks" })

		await expect(result).resolves.toBe("chunk")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects with StreamIdleTimeoutError carrying phase and timeoutMs on timeout", async () => {
		const result = awaitWithStreamTimeout(new Promise<string>(() => {}), {
			timeoutMs: 30_000,
			phase: "first_chunk",
		})
		const assertion = expect(result).rejects.toSatisfy((error: unknown) => {
			return (
				error instanceof StreamIdleTimeoutError &&
				error.name === "StreamIdleTimeoutError" &&
				error.phase === "first_chunk" &&
				error.timeoutMs === 30_000 &&
				error.message.includes("No data received from the provider for 30s (first_chunk)")
			)
		})

		await vi.advanceTimersByTimeAsync(30_000)
		await assertion
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects with a cancellation error when the signal aborts", async () => {
		const controller = new AbortController()
		const result = awaitWithStreamTimeout(new Promise<string>(() => {}), {
			signal: controller.signal,
			timeoutMs: 30_000,
			phase: "between_chunks",
		})
		const assertion = expect(result).rejects.toThrow("Request cancelled by user")

		controller.abort()
		await assertion
		expect(vi.getTimerCount()).toBe(0)
	})

	it("never times out when timeoutMs is 0", async () => {
		let resolveNext: (value: string) => void = () => {}
		const next = new Promise<string>((resolve) => {
			resolveNext = resolve
		})
		let settled = false
		const result = awaitWithStreamTimeout(next, { timeoutMs: 0, phase: "between_chunks" }).finally(() => {
			settled = true
		})

		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(10_000_000)
		expect(settled).toBe(false)

		resolveNext("late")
		await expect(result).resolves.toBe("late")
	})

	it("removes the abort listener after settling", async () => {
		const controller = new AbortController()
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

		await awaitWithStreamTimeout(Promise.resolve(1), {
			signal: controller.signal,
			timeoutMs: 1000,
			phase: "between_chunks",
		})

		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	it("rejects immediately on an already-aborted signal without a timer or listener", async () => {
		const controller = new AbortController()
		controller.abort()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")

		const result = awaitWithStreamTimeout(new Promise<string>(() => {}), {
			signal: controller.signal,
			timeoutMs: 1000,
			phase: "first_chunk",
		})

		expect(vi.getTimerCount()).toBe(0)
		expect(addSpy).not.toHaveBeenCalled()
		await expect(result).rejects.toThrow("Request cancelled by user")
	})

	it("does not leak an unhandled rejection when next rejects after a timeout or abort", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)

		try {
			let rejectAfterTimeout: (error: Error) => void = () => {}
			const timedOut = awaitWithStreamTimeout(
				new Promise<string>((_, reject) => {
					rejectAfterTimeout = reject
				}),
				{ timeoutMs: 100, phase: "between_chunks" },
			)
			const timedOutAssertion = expect(timedOut).rejects.toBeInstanceOf(StreamIdleTimeoutError)
			await vi.advanceTimersByTimeAsync(100)
			await timedOutAssertion
			rejectAfterTimeout(new Error("late failure after timeout"))

			const controller = new AbortController()
			let rejectAfterAbort: (error: Error) => void = () => {}
			const aborted = awaitWithStreamTimeout(
				new Promise<string>((_, reject) => {
					rejectAfterAbort = reject
				}),
				{ signal: controller.signal, timeoutMs: 100, phase: "between_chunks" },
			)
			const abortedAssertion = expect(aborted).rejects.toThrow("Request cancelled by user")
			controller.abort()
			await abortedAssertion
			rejectAfterAbort(new Error("late failure after abort"))

			// Flush microtasks and macrotasks so any unhandled rejection would be reported.
			vi.useRealTimers()
			await new Promise((resolve) => setImmediate(resolve))
			await new Promise((resolve) => setImmediate(resolve))

			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})
})
