import type { SemanticFinding } from "./types"
import {
	createRetrievalMetricsRecorder,
	type RetrievalMetricsRecorder,
} from "./retrievalMetricsRecorder"

/**
 * Per-task cache of semantic findings keyed by a normalized query. Scoped to a
 * single task (Req 5.3): each {@link SemanticExplorationState} owns its own
 * cache instance, with no module-level shared state.
 */
export interface SemanticExplorationCache {
	/** Store findings for a query under its normalized key (Req 5.1). */
	store(query: string, findings: ReadonlyArray<SemanticFinding>): void

	/** Return findings for a normalized query, or `undefined` on a miss. */
	lookup(query: string): ReadonlyArray<SemanticFinding> | undefined

	/** Enumerate every stored finding across all queries (useful-hit detection). */
	allFindings(): ReadonlyArray<SemanticFinding>
}

/**
 * Cross-worker view of findings within a single task (Req 11). Carries ONLY
 * `SemanticFinding` fields and never a worker's chat transcript (Req 11.3).
 */
export interface SharedRetrievalMemory {
	/** Publish findings keyed by their normalized `query` field (Req 11.1). */
	publish(findings: ReadonlyArray<SemanticFinding>): void

	/** Return findings for a normalized query, readable by siblings + mastermind (Req 11.2). */
	lookup(query: string): ReadonlyArray<SemanticFinding> | undefined

	/** Enumerate every published finding across all queries (useful-hit detection). */
	allFindings(): ReadonlyArray<SemanticFinding>
}

/**
 * Per-task container wiring the cache, cross-worker shared memory, and the
 * retrieval-metrics recorder.
 */
export interface SemanticExplorationState {
	readonly cache: SemanticExplorationCache
	readonly sharedMemory: SharedRetrievalMemory
	readonly metrics: RetrievalMetricsRecorder
}

/**
 * Normalize a query so the same concept maps to the same cache/shared-memory
 * key regardless of surrounding or internal whitespace or case: trim, collapse
 * internal whitespace runs to a single space, and lowercase. Applied
 * consistently in both store/publish and lookup.
 */
function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Defensively copy an arbitrary {@link SemanticFinding}-shaped value into a
 * plain object carrying only the five SemanticFinding fields, so no extra
 * fields (e.g. a chat transcript) can leak through shared memory (Req 11.3).
 */
function toPlainFinding(finding: SemanticFinding): SemanticFinding {
	return {
		query: finding.query,
		file: finding.file,
		startLine: finding.startLine,
		endLine: finding.endLine,
		score: finding.score,
	}
}

/**
 * Create a per-task {@link SemanticExplorationCache}. The backing map lives in
 * this closure, so each call produces an independently scoped cache (Req 5.3).
 */
function createSemanticExplorationCache(): SemanticExplorationCache {
	const byQuery = new Map<string, ReadonlyArray<SemanticFinding>>()
	return {
		store(query: string, findings: ReadonlyArray<SemanticFinding>): void {
			byQuery.set(normalizeQuery(query), findings)
		},
		lookup(query: string): ReadonlyArray<SemanticFinding> | undefined {
			return byQuery.get(normalizeQuery(query))
		},
		allFindings(): ReadonlyArray<SemanticFinding> {
			const all: SemanticFinding[] = []
			for (const findings of byQuery.values()) {
				all.push(...findings)
			}
			return all
		},
	}
}

/**
 * Create a per-task {@link SharedRetrievalMemory}. `publish` groups findings by
 * the normalized value of their own `query` field and stores defensive plain
 * copies so only SemanticFinding fields are visible to consumers (Req 11.3).
 */
function createSharedRetrievalMemory(): SharedRetrievalMemory {
	const byQuery = new Map<string, SemanticFinding[]>()
	return {
		publish(findings: ReadonlyArray<SemanticFinding>): void {
			for (const finding of findings) {
				const key = normalizeQuery(finding.query)
				const existing = byQuery.get(key)
				const plain = toPlainFinding(finding)
				if (existing === undefined) {
					byQuery.set(key, [plain])
				} else {
					existing.push(plain)
				}
			}
		},
		lookup(query: string): ReadonlyArray<SemanticFinding> | undefined {
			return byQuery.get(normalizeQuery(query))
		},
		allFindings(): ReadonlyArray<SemanticFinding> {
			const all: SemanticFinding[] = []
			for (const findings of byQuery.values()) {
				all.push(...findings)
			}
			return all
		},
	}
}

/**
 * Factory wiring a fresh per-task {@link SemanticExplorationState}: an isolated
 * cache, an isolated cross-worker shared memory, and a metrics recorder.
 *
 * Requirements traced: 5.1, 5.3, 11.1, 11.2, 11.3
 */
export function createSemanticExplorationState(): SemanticExplorationState {
	return {
		cache: createSemanticExplorationCache(),
		sharedMemory: createSharedRetrievalMemory(),
		metrics: createRetrievalMetricsRecorder(),
	}
}
