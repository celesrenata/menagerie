import { CachedUiValue } from "../CachedUiValue"

describe("CachedUiValue", () => {
	afterEach(() => vi.useRealTimers())

	it("returns immediately and shares one pending credential read", async () => {
		let resolve!: (value: boolean) => void
		const load = vi.fn(() => new Promise<boolean>((done) => (resolve = done)))
		const changed = vi.fn()
		const cache = new CachedUiValue(false, load, changed)
		expect(cache.get()).toBe(false)
		expect(cache.get()).toBe(false)
		await Promise.resolve()
		expect(load).toHaveBeenCalledOnce()
		resolve(true)
		await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
		expect(cache.get()).toBe(true)
	})

	it("does not refresh on each chat update or notify for unchanged values", async () => {
		vi.useFakeTimers()
		const load = vi.fn().mockResolvedValue(false)
		const changed = vi.fn()
		const cache = new CachedUiValue(false, load, changed)
		cache.get()
		await vi.advanceTimersByTimeAsync(29_999)
		cache.get()
		expect(load).toHaveBeenCalledOnce()
		expect(changed).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		cache.get()
		await vi.advanceTimersByTimeAsync(0)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it("discards a pending result invalidated by sign-out", async () => {
		let resolve!: (value: boolean) => void
		const load = vi.fn().mockImplementationOnce(() => new Promise<boolean>((done) => (resolve = done)))
		load.mockResolvedValue(false)
		const changed = vi.fn()
		const cache = new CachedUiValue(false, load, changed)
		cache.get()
		await Promise.resolve()
		cache.invalidate(false)
		resolve(true)
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
		expect(cache.get()).toBe(false)
		expect(changed).not.toHaveBeenCalled()
	})

	it("keeps failures off the caller and stops notifications after disposal", async () => {
		const load = vi.fn().mockRejectedValue(new Error("secret service unavailable"))
		const changed = vi.fn()
		const cache = new CachedUiValue(false, load, changed)
		expect(cache.get()).toBe(false)
		cache.dispose()
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
		expect(cache.get()).toBe(false)
		expect(changed).not.toHaveBeenCalled()
	})
})
