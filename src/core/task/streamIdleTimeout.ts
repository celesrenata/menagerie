export type StreamWaitPhase = "first_chunk" | "between_chunks"

/**
 * Raised when a provider stream produces no data for longer than the configured
 * timeout. Callers abort the underlying request with this error as the reason
 * and then retry through their normal failure path.
 */
export class StreamIdleTimeoutError extends Error {
	readonly phase: StreamWaitPhase
	readonly timeoutMs: number

	constructor(phase: StreamWaitPhase, timeoutMs: number) {
		super(
			`No data received from the provider for ${Math.round(timeoutMs / 1000)}s (${phase}); the request was aborted and will be retried.`,
		)
		this.name = "StreamIdleTimeoutError"
		this.phase = phase
		this.timeoutMs = timeoutMs
	}
}

/**
 * Waits for `next` while racing an optional abort signal and an optional timeout.
 *
 * - The first settle wins; `next` is always observed so a late rejection is never unhandled.
 * - An already-aborted signal rejects immediately without starting a timer or adding a listener.
 * - `timeoutMs <= 0` disables the timer.
 * - The timer and the abort listener are always cleaned up on settle.
 * - This never calls `iterator.return()`; cleanup of the stream is the caller's job.
 */
export function awaitWithStreamTimeout<T>(
	next: Promise<T>,
	opts: { signal?: AbortSignal; timeoutMs: number; phase: StreamWaitPhase },
): Promise<T> {
	const { signal, timeoutMs, phase } = opts

	return new Promise<T>((resolve, reject) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined

		const onAbort = () => settle(() => reject(new Error("Request cancelled by user")))

		const settle = (finish: () => void) => {
			if (settled) {
				return
			}
			settled = true
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
			signal?.removeEventListener("abort", onAbort)
			finish()
		}

		next.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		)

		if (signal?.aborted) {
			settled = true
			reject(new Error("Request cancelled by user"))
			return
		}

		signal?.addEventListener("abort", onAbort)

		if (timeoutMs > 0) {
			timer = setTimeout(() => settle(() => reject(new StreamIdleTimeoutError(phase, timeoutMs))), timeoutMs)
		}
	})
}
