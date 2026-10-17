import { acquireGenerationLease, isAutoReaderWorker } from "../generationLease"
import { AUTO_READER_NAME } from "../ParallelTaskReader"

describe("generationLease helpers", () => {
	it("treats m5-contract-audit project-readers as exempt auto-readers", () => {
		expect(isAutoReaderWorker("project-reader", AUTO_READER_NAME, AUTO_READER_NAME)).toBe(true)
		expect(isAutoReaderWorker("project-reader", `${AUTO_READER_NAME}-2`, AUTO_READER_NAME)).toBe(true)
		expect(isAutoReaderWorker("code", AUTO_READER_NAME, AUTO_READER_NAME)).toBe(false)
		expect(isAutoReaderWorker("project-reader", "manual-reader", AUTO_READER_NAME)).toBe(false)
	})

	it("returns an idempotent no-op when no provider is attached", async () => {
		const release = await acquireGenerationLease(undefined, new AbortController().signal)
		expect(() => {
			release()
			release()
		}).not.toThrow()
	})

	it("acquires once and ignores a second release", async () => {
		const inner = vi.fn()
		const acquire = vi.fn(async () => inner)
		const release = await acquireGenerationLease({ acquire }, new AbortController().signal)
		expect(acquire).toHaveBeenCalledOnce()
		release()
		release()
		expect(inner).toHaveBeenCalledOnce()
	})

	it("propagates abort while waiting to acquire", async () => {
		const controller = new AbortController()
		const acquire = vi.fn(
			(signal: AbortSignal) =>
				new Promise<() => void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })
				}),
		)
		const pending = acquireGenerationLease({ acquire }, controller.signal)
		controller.abort(new Error("cancelled"))
		await expect(pending).rejects.toThrow("cancelled")
	})
})
