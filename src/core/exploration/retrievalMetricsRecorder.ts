import type { RetrievalMetrics } from "./types"

/**
 * Per-task recorder for retrieval metrics. Every method is best-effort:
 * a thrown error inside any recorder call is swallowed so that the
 * decision/dispatch flow is never affected (Req 7.*).
 *
 * Requirements traced: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11
 */
export interface RetrievalMetricsRecorder {
	recordSemanticQuery(): void
	recordUsefulHit(): void
	recordFilesReturned(count: number): void
	recordFileOpened(): void
	recordRawRead(precededByUsefulHit: boolean): void
	recordTokensFromReads(tokens: number): void
	recordQueriesReused(): void
	recordIndexUnavailable(): void
	recordGatewayUnavailable(): void
	recordIndexFreshnessMiss(): void
	/** Record the epoch-ms timestamp of the first useful evidence. Only the first call takes effect. */
	markFirstUsefulEvidence(at: number): void
	snapshot(): RetrievalMetrics
}

/**
 * Safe zero-value snapshot returned when `snapshot()` itself encounters an
 * error, ensuring the caller is never disrupted.
 */
const SAFE_SNAPSHOT: Readonly<RetrievalMetrics> = Object.freeze({
	semanticQueries: 0,
	semanticHitRate: 0,
	filesReturned: 0,
	filesOpened: 0,
	rawReads: 0,
	tokensFromReads: 0,
	queriesReused: 0,
	indexUnavailableEvents: 0,
	gatewayUnavailableEvents: 0,
	pctRawReadsPrecededByUsefulHit: 0,
	indexFreshnessMisses: 0,
})

/**
 * Clamp `value` to `[lo, hi]`. Returns `lo` when `value` is `NaN`.
 */
function clamp(value: number, lo: number, hi: number): number {
	if (Number.isNaN(value)) {
		return lo
	}
	return Math.min(hi, Math.max(lo, value))
}

/**
 * Treat negative / NaN counts as 0 so callers with bad data cannot decrement a
 * monotonic counter.
 */
function safeCount(n: number): number {
	return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Create a per-task {@link RetrievalMetricsRecorder}.
 *
 * @param taskCreatedAt  Epoch-ms of task creation. Defaults to `Date.now()` at
 *   factory-call time so `markFirstUsefulEvidence` can compute the elapsed
 *   duration without external clock injection.
 *
 * Every public method body is wrapped in a try/catch so a thrown error never
 * propagates to callers — the decision/dispatch must never be affected by a
 * recorder error.
 */
export function createRetrievalMetricsRecorder(taskCreatedAt?: number): RetrievalMetricsRecorder {
	const createdAt: number = taskCreatedAt ?? Date.now()

	// Monotonic counters
	let semanticQueries = 0
	let usefulHits = 0
	let filesReturned = 0
	let filesOpened = 0
	let rawReads = 0
	let rawReadsPrecededByUsefulHit = 0
	let tokensFromReads = 0
	let queriesReused = 0
	let indexUnavailableEvents = 0
	let gatewayUnavailableEvents = 0
	let indexFreshnessMisses = 0

	// Optional first-evidence timing
	let timeToFirstUsefulEvidenceMs: number | undefined

	return {
		recordSemanticQuery(): void {
			try {
				semanticQueries++
			} catch {
				/* best-effort */
			}
		},

		recordUsefulHit(): void {
			try {
				usefulHits++
			} catch {
				/* best-effort */
			}
		},

		recordFilesReturned(count: number): void {
			try {
				filesReturned += safeCount(count)
			} catch {
				/* best-effort */
			}
		},

		recordFileOpened(): void {
			try {
				filesOpened++
			} catch {
				/* best-effort */
			}
		},

		recordRawRead(precededByUsefulHit: boolean): void {
			try {
				rawReads++
				if (precededByUsefulHit) {
					rawReadsPrecededByUsefulHit++
				}
			} catch {
				/* best-effort */
			}
		},

		recordTokensFromReads(tokens: number): void {
			try {
				tokensFromReads += safeCount(tokens)
			} catch {
				/* best-effort */
			}
		},

		recordQueriesReused(): void {
			try {
				queriesReused++
			} catch {
				/* best-effort */
			}
		},

		recordIndexUnavailable(): void {
			try {
				indexUnavailableEvents++
			} catch {
				/* best-effort */
			}
		},

		recordGatewayUnavailable(): void {
			try {
				gatewayUnavailableEvents++
			} catch {
				/* best-effort */
			}
		},

		recordIndexFreshnessMiss(): void {
			try {
				indexFreshnessMisses++
			} catch {
				/* best-effort */
			}
		},

		markFirstUsefulEvidence(at: number): void {
			try {
				if (timeToFirstUsefulEvidenceMs !== undefined) {
					return // Only the first call takes effect.
				}
				timeToFirstUsefulEvidenceMs = Math.max(0, at - createdAt)
			} catch {
				/* best-effort */
			}
		},

		snapshot(): RetrievalMetrics {
			try {
				const semanticHitRate = clamp(semanticQueries === 0 ? 0 : usefulHits / semanticQueries, 0, 1)

				const pctRawReadsPrecededByUsefulHit = clamp(
					rawReads === 0 ? 0 : rawReadsPrecededByUsefulHit / rawReads,
					0,
					1,
				)

				const metrics: RetrievalMetrics = {
					semanticQueries,
					semanticHitRate,
					filesReturned,
					filesOpened,
					rawReads,
					tokensFromReads,
					queriesReused,
					indexUnavailableEvents,
					gatewayUnavailableEvents,
					pctRawReadsPrecededByUsefulHit,
					indexFreshnessMisses,
				}

				if (timeToFirstUsefulEvidenceMs !== undefined) {
					metrics.timeToFirstUsefulEvidenceMs = timeToFirstUsefulEvidenceMs
				}

				return metrics
			} catch {
				return { ...SAFE_SNAPSHOT }
			}
		},
	}
}
