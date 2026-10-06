import { InferenceLeasePool } from "../InferenceLeasePool"
import type { RouteCapability, RouteCapacity, RouteCapacityProvider, SchedulingPriority } from "../elasticTypes"

/**
 * A mutable in-memory capacity provider for the `reader` capability. Tests mutate
 * `available` to simulate OmniRoute capacity changes; the pool reads it read-only.
 */
const makeRoutes = (initialAvailable: number, capability: RouteCapability = "reader") => {
	const snapshot: RouteCapacity = {
		route: "route-0",
		capacity: Math.max(initialAvailable, 1),
		available: initialAvailable,
		capability,
	}
	const provider: RouteCapacityProvider & { set(available: number): void } = {
		capacitiesFor: (c) => (c === capability ? [snapshot] : []),
		sustainedPressure: () => 0,
		set: (available: number) => {
			snapshot.available = available
		},
	}
	return provider
}

const tick = () => Promise.resolve()

describe("InferenceLeasePool", () => {
	it("grants a lease immediately when capacity is available", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(2))
		expect(pool.available).toBe(2)

		const release = await pool.acquire("normal", new AbortController().signal)
		expect(typeof release).toBe("function")
		expect(pool.available).toBe(1)
		expect(pool.waiting).toBe(0)
	})

	it("queues over-capacity acquirers instead of rejecting them (PAR-011.1)", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(1))
		const r1 = await pool.acquire("normal", new AbortController().signal)
		expect(pool.available).toBe(0)

		let admitted = false
		const pending = pool.acquire("normal", new AbortController().signal).then((release) => {
			admitted = true
			return release
		})
		await tick()

		// The over-capacity acquirer is waiting, not rejected or failed.
		expect(pool.waiting).toBe(1)
		expect(admitted).toBe(false)

		// Freeing the held lease admits the queued waiter (PAR-011.2).
		r1()
		await pending
		expect(admitted).toBe(true)
		expect(pool.waiting).toBe(0)
	})

	it("admits higher-priority waiters first when capacity frees (PAR-010.2)", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(1))
		const held = await pool.acquire("normal", new AbortController().signal)

		const admissionOrder: SchedulingPriority[] = []
		const enqueue = (priority: SchedulingPriority) =>
			pool.acquire(priority, new AbortController().signal).then((release) => {
				admissionOrder.push(priority)
				return release
			})

		// Enqueue in deliberately mixed order; capacity frees one at a time.
		const background = enqueue("background")
		await tick()
		const critical = enqueue("critical")
		await tick()
		const normal = enqueue("normal")
		await tick()
		expect(pool.waiting).toBe(3)

		held()
		const first = await Promise.race([critical, background, normal])
		first()
		await tick()
		const second = await Promise.race([background, normal])
		second()
		await tick()
		await background

		expect(admissionOrder).toEqual(["critical", "normal", "background"])
	})

	it("returns an idempotent release fn that cannot double-free (PAR-021.5)", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(1))
		const release = await pool.acquire("normal", new AbortController().signal)
		expect(pool.available).toBe(0)

		release()
		expect(pool.available).toBe(1)
		// A second (defensive) call is a no-op; it must not inflate availability.
		release()
		expect(pool.available).toBe(1)
	})

	it("rejects immediately when the signal is already aborted", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(2))
		const controller = new AbortController()
		controller.abort(new Error("already-gone"))

		await expect(pool.acquire("normal", controller.signal)).rejects.toThrow("already-gone")
		// No lease was consumed.
		expect(pool.available).toBe(2)
		expect(pool.waiting).toBe(0)
	})

	it("aborting a waiter rejects only that waiter and leaves held leases untouched (PAR-021.5)", async () => {
		const pool = new InferenceLeasePool("reader", makeRoutes(1))
		const held = await pool.acquire("normal", new AbortController().signal)

		const controller = new AbortController()
		const errors: unknown[] = []
		const waiting = pool.acquire("normal", controller.signal).catch((e) => errors.push(e))
		await tick()
		expect(pool.waiting).toBe(1)

		controller.abort(new Error("waiter-cancelled"))
		await waiting
		expect(errors).toHaveLength(1)
		expect(pool.waiting).toBe(0)

		// The held lease is still held — cancellation never touched it.
		expect(pool.available).toBe(0)
		held()
		expect(pool.available).toBe(1)
	})

	it("reads capacity read-only and admits waiters when a held lease frees (PAR-002.3)", async () => {
		const routes = makeRoutes(1)
		const pool = new InferenceLeasePool("reader", routes)
		const held = await pool.acquire("normal", new AbortController().signal)
		expect(pool.available).toBe(0)

		let admitted = false
		const pending = pool.acquire("normal", new AbortController().signal).then((release) => {
			admitted = true
			return release
		})
		await tick()
		expect(pool.waiting).toBe(1)
		expect(admitted).toBe(false)

		// OmniRoute lowering capacity to 0 must not admit the waiter and must clamp
		// `available` at 0 (read-only consumption, never negative).
		routes.set(0)
		await tick()
		expect(pool.waiting).toBe(1)
		expect(pool.available).toBe(0)

		// Restoring capacity alone does not pump; a freed lease does (PAR-011.2).
		routes.set(1)
		held()
		const release = await pending
		expect(admitted).toBe(true)
		release()
	})
})
