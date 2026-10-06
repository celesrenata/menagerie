import type { RouteCapability, RouteCapacityProvider, SchedulingPriority } from "./elasticTypes"

/**
 * Priority ordering for lease admission (PAR-010.1, PAR-010.2). A waiter with a
 * numerically smaller rank is admitted before one with a larger rank, so
 * `critical` work is never delayed behind `background`/`speculative` work
 * (PAR-010.5). Equal-priority waiters are admitted in arrival order (FIFO),
 * mirroring the `TaskSemaphore` discipline.
 */
const PRIORITY_RANK: Record<SchedulingPriority, number> = {
	critical: 0,
	high: 1,
	normal: 2,
	background: 3,
	speculative: 4,
}

/** A queued acquirer waiting for inference capacity to free. */
interface Waiter {
	readonly priority: SchedulingPriority
	/**
	 * True when the acquirer sits on the DAG's critical path. Used only as a
	 * tiebreaker *within* an equal {@link priority}: a critical-path waiter is
	 * admitted ahead of a non-critical-path waiter of the same priority
	 * (PAR-010.4), but never ahead of a strictly higher-priority waiter, so it
	 * can never let low-priority work jump the architect / required verifier
	 * (PAR-010.5).
	 */
	readonly criticalPath: boolean
	/** Monotonic enqueue order; breaks priority+critical-path ties so admission is FIFO. */
	readonly seq: number
	/** Resolves the pending `acquire()` with the lease's release fn. */
	readonly resolve: (release: () => void) => void
	/** Rejects the pending `acquire()` (used only when the waiter's signal aborts). */
	readonly reject: (reason: unknown) => void
	/** Detaches the abort listener once the waiter settles. */
	readonly cleanup: () => void
}

/**
 * A priority-aware lease pool over OmniRoute route capacity, modeling physical
 * generation slots as leases (design §`InferenceLeasePool`).
 *
 * The pool is parameterized by a single {@link RouteCapability} and reads the
 * {@link RouteCapacityProvider} **read-only** to decide whether a lease may be
 * granted (PAR-002.3). It consumes only `available`/`capacity` and never derives
 * GPU placement from any field (PAR-002.4, PAR-002.5): no scheduling decision
 * here branches on physical identity.
 *
 * Admission is priority-ordered: when capacity is constrained, higher-priority
 * requests are admitted first (PAR-010.2). Over-capacity acquirers are **queued,
 * never rejected** (PAR-011.1) — a delay or queue is not a failure (PAR-003.6) —
 * and are admitted when a lease frees (PAR-011.2).
 *
 * It reuses the `TaskSemaphore` discipline (design §Admission ordering):
 * `waiting` exposes queue depth for backpressure, and aborting a waiter rejects
 * only that waiter without touching any held lease (PAR-021.5). The release fn
 * returned by {@link acquire} is idempotent, so callers can wire it into a
 * `try/finally` and guarantee release-on-throw without risking a double-release
 * that would corrupt the held count.
 */
export class InferenceLeasePool {
	private readonly capability: RouteCapability
	private readonly routes: RouteCapacityProvider

	/** Leases currently held (workers in the `generating` state). */
	private held = 0
	/** Priority-ordered queue of acquirers blocked on capacity. */
	private readonly waiters: Waiter[] = []
	/** Monotonic sequence used to make equal-priority admission FIFO. */
	private seq = 0

	constructor(capability: RouteCapability, routes: RouteCapacityProvider) {
		this.capability = capability
		this.routes = routes
	}

	/**
	 * Live lease ceiling for this capability, read read-only from OmniRoute. It
	 * is the summed `available` across every route exposing the capability; this
	 * is the maximum number of leases that may be concurrently held. The value is
	 * read fresh on every decision so capacity changes are observed without any
	 * local caching (PAR-002.3).
	 */
	private liveCapacity(): number {
		const snapshots = this.routes.capacitiesFor(this.capability)
		let total = 0
		for (const snapshot of snapshots) {
			// `available` is a count of free generation slots; clamp defensively so a
			// malformed negative reading can never make capacity go below zero.
			total += Math.max(0, snapshot.available)
		}
		return total
	}

	/** Free leases right now: live capacity minus those already held, never negative. */
	get available(): number {
		return Math.max(0, this.liveCapacity() - this.held)
	}

	/** Acquirers currently queued waiting for capacity (observable queue depth). */
	get waiting(): number {
		return this.waiters.length
	}

	/**
	 * Acquire an inference lease for a `generating` worker, returning a release fn.
	 *
	 * Grants immediately iff route capacity for the capability allows and no
	 * higher-priority waiter is already queued; otherwise the acquirer is queued
	 * by `priority` — and, within an equal priority, a `criticalPath` acquirer is
	 * admitted ahead of a non-critical-path peer (PAR-010.4) — and admitted when a
	 * lease frees. It is never rejected for being over capacity (PAR-011.1,
	 * PAR-011.2). The critical-path flag is only a within-priority tiebreaker, so
	 * it can never let low-priority work jump a strictly higher-priority request
	 * such as the architect or a required verifier (PAR-010.5). The only rejection
	 * path is the caller's own `signal` aborting, which detaches just this waiter
	 * and leaves every held lease untouched (PAR-021.5).
	 *
	 * The returned release fn is idempotent: the first call frees the lease and
	 * pumps the queue; later calls are no-ops. Callers wire it into a
	 * `try/finally` to guarantee release-on-throw.
	 */
	acquire(priority: SchedulingPriority, signal: AbortSignal, criticalPath = false): Promise<() => void> {
		if (signal.aborted) {
			return Promise.reject(signal.reason ?? new Error("InferenceLeasePool.acquire aborted"))
		}

		// Grant immediately only when capacity allows AND no one is already queued.
		// Honoring the queue first keeps admission priority-ordered: a fresh
		// `critical` acquirer still goes behind an earlier `critical` waiter, and a
		// fresh low-priority acquirer never jumps a queued higher-priority one.
		if (this.waiters.length === 0 && this.held < this.liveCapacity()) {
			this.held++
			return Promise.resolve(this.makeRelease())
		}

		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = {
				priority,
				criticalPath,
				seq: this.seq++,
				resolve: (release) => {
					waiter.cleanup()
					resolve(release)
				},
				reject: (reason) => {
					waiter.cleanup()
					reject(reason)
				},
				cleanup: () => {
					signal.removeEventListener("abort", onAbort)
				},
			}

			const onAbort = () => {
				const index = this.waiters.indexOf(waiter)
				if (index !== -1) {
					this.waiters.splice(index, 1)
				}
				// Aborting a waiter never touches a held lease, so there is nothing to
				// release and no queue to pump (PAR-021.5).
				waiter.reject(signal.reason ?? new Error("InferenceLeasePool.acquire aborted"))
			}
			signal.addEventListener("abort", onAbort, { once: true })

			this.insertByPriority(waiter)
		})
	}

	/**
	 * Reject every queued waiter without touching any held lease, mirroring
	 * {@link import("../../utils/TaskSemaphore").TaskSemaphore.cancel}: a worker
	 * that already holds a lease keeps it and settles on its own, so cancelling
	 * the queue never abandons a sibling mid-generation (PAR-021.5). The pool
	 * remains usable afterward. Each rejected waiter detaches its own abort
	 * listener via its `reject` wrapper.
	 */
	cancelWaiters(): void {
		const pending = this.waiters.splice(0, this.waiters.length)
		for (const waiter of pending) {
			waiter.reject(new Error("InferenceLeasePool.cancelWaiters: waiter cancelled"))
		}
	}

	/**
	 * Insert `waiter` keeping the queue ordered by priority rank, then — *within*
	 * an equal priority — critical-path waiters ahead of non-critical-path ones
	 * (PAR-010.4), then FIFO by seq.
	 *
	 * The critical-path flag is strictly a within-priority tiebreaker: it is only
	 * consulted when two waiters share the same `priority`, so a critical-path
	 * `normal` waiter still queues behind every `high`/`critical` waiter and a
	 * critical-path `speculative`/`background` waiter can never jump the
	 * architect or a required verifier (PAR-010.5).
	 */
	private insertByPriority(waiter: Waiter): void {
		const rank = PRIORITY_RANK[waiter.priority]
		let index = this.waiters.length
		for (let i = 0; i < this.waiters.length; i++) {
			const other = this.waiters[i]
			const otherRank = PRIORITY_RANK[other.priority]
			// Strictly lower-priority waiter: insert before it.
			if (otherRank > rank) {
				index = i
				break
			}
			// Same priority: a critical-path waiter is admitted before a
			// non-critical-path peer. Insert before the first same-priority,
			// non-critical-path waiter (never ahead of an equal critical-path peer,
			// preserving FIFO among them).
			if (otherRank === rank && waiter.criticalPath && !other.criticalPath) {
				index = i
				break
			}
		}
		this.waiters.splice(index, 0, waiter)
	}

	/**
	 * Build an idempotent release fn for one held lease. The first call decrements
	 * the held count and pumps the queue; subsequent calls are no-ops so a
	 * double-release (e.g. a defensive `finally` after an already-released path)
	 * cannot corrupt the held count or steal another worker's lease.
	 */
	private makeRelease(): () => void {
		let released = false
		return () => {
			if (released) return
			released = true
			this.held--
			this.pump()
		}
	}

	/**
	 * Admit as many queued waiters as freed capacity allows, highest priority
	 * first. Each admitted waiter takes a held lease, so the loop stops once
	 * capacity is exhausted or the queue drains.
	 */
	private pump(): void {
		while (this.waiters.length > 0 && this.held < this.liveCapacity()) {
			const waiter = this.waiters.shift()!
			this.held++
			waiter.resolve(this.makeRelease())
		}
	}
}
