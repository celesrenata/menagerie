/**
 * Per-generation inference-lease helpers (Menagerie lift P5).
 *
 * A dispatch permit covers the worker's whole run. An inference lease covers
 * only the model generation/stream: acquire after prompt construction, just
 * before network dispatch; release in `finally` on stream end, error, abort,
 * timeout, or provider fallback. Never held during tools, edits, approvals,
 * UI, or backoff. Reacquired for the next turn.
 */

export interface InferenceLeaseProvider {
	acquire(signal: AbortSignal): Promise<() => void>
}

/** Auto-reader workers keep the measured exemption from Menagerie lease queuing. */
export function isAutoReaderWorker(mode: string, name: string, autoReaderName: string): boolean {
	return mode === "project-reader" && name.startsWith(autoReaderName)
}

/**
 * Acquire a generation lease, or a no-op when the task has no provider
 * (non-parallel work and exempt auto-readers). The returned release is
 * idempotent so callers can pair it with `try/finally` and also release
 * explicitly before backoff/user-ask paths.
 */
export async function acquireGenerationLease(
	provider: InferenceLeaseProvider | undefined,
	signal: AbortSignal,
): Promise<() => void> {
	if (!provider) return () => {}
	const release = await provider.acquire(signal)
	let released = false
	return () => {
		if (released) return
		released = true
		release()
	}
}
