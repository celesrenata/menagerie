import { InferenceLeasePool } from "../../core/task/InferenceLeasePool"
import type { RouteCapacityProvider, SchedulingPriority } from "../../core/task/elasticTypes"
import { AnalysisTransportError } from "./GraniteAnalysisClient"

/**
 * Bounded admission for the analysis route (MEN-GRANITE-SDD-001 R2.3).
 *
 * Reuses `InferenceLeasePool` (priority + FIFO + idempotent release + abort-safe waiters)
 * instead of inventing a second admission primitive. The pool is given a PRIVATE capacity
 * provider, so analysis permits are never counted against, or borrowed from, the reader
 * tier's pool. `maxActive` is the analysis route's own published capacity (default 2).
 *
 * On top of the pool this adds what the spec requires and the pool deliberately lacks:
 * a finite queue (`queue-full`), a total deadline (`timeout`) and cancellation
 * (`cancelled`), all surfaced as typed {@link AnalysisTransportError}s.
 */
export interface AnalysisQueueOptions {
	/** Live ceiling for concurrent generations on the analysis route. */
	maxActive: number | (() => number)
	/** Maximum jobs allowed to wait. Beyond this, `run` rejects with `queue-full`. */
	maxQueued: number
}

export interface AnalysisRunOptions {
	/** Total budget covering queue wait AND execution. */
	deadlineMs: number
	signal?: AbortSignal
	priority?: SchedulingPriority
}

export class AnalysisQueue {
	private readonly pool: InferenceLeasePool
	private activeCount = 0

	constructor(private readonly options: AnalysisQueueOptions) {
		const live = () => {
			const raw = typeof options.maxActive === "function" ? options.maxActive() : options.maxActive
			return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1
		}
		// A private provider: only this pool ever reads it. "general" is used purely as the
		// pool's lookup key; no scheduling decision here depends on the label.
		const provider: RouteCapacityProvider = {
			capacitiesFor: () => [{ route: "analysis", capacity: live(), available: live(), capability: "general" }],
			sustainedPressure: () => 0,
		}
		this.pool = new InferenceLeasePool("general", provider)
	}

	get active(): number {
		return this.activeCount
	}

	get waiting(): number {
		return this.pool.waiting
	}

	async run<T>(job: (signal: AbortSignal) => Promise<T>, options: AnalysisRunOptions): Promise<T> {
		if (options.signal?.aborted) throw new AnalysisTransportError("cancelled", "cancelled before admission")
		if (this.pool.available === 0 && this.pool.waiting >= this.options.maxQueued) {
			throw new AnalysisTransportError("queue-full", `analysis queue full (${this.options.maxQueued} waiting)`)
		}

		const controller = new AbortController()
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, options.deadlineMs)
		const onCallerAbort = () => controller.abort()
		options.signal?.addEventListener("abort", onCallerAbort, { once: true })

		let release: (() => void) | undefined
		try {
			try {
				release = await this.pool.acquire(options.priority ?? "normal", controller.signal)
			} catch {
				throw this.abortError(timedOut, "while queued")
			}
			this.activeCount++
			try {
				return await job(controller.signal)
			} catch (error) {
				if (error instanceof AnalysisTransportError) {
					// The client reports its own abort as `cancelled`; if the queue deadline fired
					// first, that is really a timeout.
					if (timedOut && error.kind === "cancelled") throw this.abortError(true, "while running")
					throw error
				}
				if (controller.signal.aborted) throw this.abortError(timedOut, "while running")
				throw error
			} finally {
				this.activeCount--
			}
		} finally {
			release?.()
			clearTimeout(timer)
			options.signal?.removeEventListener("abort", onCallerAbort)
		}
	}

	private abortError(timedOut: boolean, phase: string): AnalysisTransportError {
		return timedOut
			? new AnalysisTransportError("timeout", `analysis deadline exceeded ${phase}`)
			: new AnalysisTransportError("cancelled", `analysis cancelled ${phase}`)
	}
}
