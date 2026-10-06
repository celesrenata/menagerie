/**
 * Serving-ceiling / pod-memory sizing, Matryoshka ↔ Qdrant dimension coupling,
 * evaluation-harness, and metrics types for the Retrieval Fabric.
 *
 * These shapes live in a sibling module to the base gateway surface types so the
 * sizing/dimension/eval/metrics surface can evolve independently of the core
 * retrieval surface defined in `./types`.
 */

/**
 * Serving-ceiling / pod-memory sizing parameters.
 *
 * Invariant: raising `perItemServingCeilingTokens` must raise `podMemoryLimitGi`
 * monotonically, and `maxPaddedTokens` / `maxItems` must never drop below the
 * guard defaults (16384 / 32).
 */
export interface ServingSizing {
	/** Per-item serving ceiling (OOM guard); documented, configurable, measured-safe default (not fixed 4096). */
	perItemServingCeilingTokens: number
	/** Mirrors MAX_EMBEDDING_REQUEST_PADDED_TOKENS; sized with the ceiling, never weakened. */
	maxPaddedTokens: number
	/** Mirrors MAX_EMBEDDING_REQUEST_ITEMS; sized with the ceiling, never weakened. */
	maxItems: number
	/** Pod memory limit in GiB; raised in tandem whenever the ceiling is raised. */
	podMemoryLimitGi: number
}

/**
 * Matryoshka ↔ Qdrant dimension coupling.
 *
 * A mismatch is rejected exactly as `vector-store-factory.ts` enforces; a change
 * requires reindexing `qdrant-0`.
 */
export interface DimensionConfig {
	/** Stored embedding dimension (256 | 512 | 768 | 1024), from getModelDimension. */
	storedDimension: number
	/** Qdrant_Collection configured vector dimension; MUST equal storedDimension. */
	qdrantCollectionDimension: number
}

/**
 * A single evaluation-harness case: a real Menagerie / NerveCenter task paired
 * with the files and symbols/ranges expected to be relevant.
 */
export interface EvalCase {
	id: string
	query: string // real Menagerie / NerveCenter task
	expectedFiles: string[]
	expectedSymbolsOrRanges: Array<{ file: string; symbol?: string; startLine?: number; endLine?: number }>
}

/**
 * Retrieval configuration variant compared by the evaluation harness.
 */
export type EvalConfig = "vector-only" | "lexical-only" | "hybrid" | "hybrid+reranker-0.6b" | "hybrid+reranker-4b"

/**
 * The quality metrics the evaluation harness emits for a given config at a given
 * stored dimension.
 */
export interface EvalResult {
	config: EvalConfig
	dimension: 256 | 512 | 768 | 1024
	recallAt30: number
	recallAt10: number
	mrrAt5: number
	ndcgAt5: number
	top5ExpectedFileHitRate: number
}

/**
 * Metrics recorded for a retrieval pass, including the headline product metrics
 * `rawReadsPrecededByRelevantHitPct` and `timeToFirstUsefulEvidenceMs`.
 */
export interface RetrievalMetrics {
	semanticQueriesIssued: number
	queryDecompositionsProduced: number
	embeddingLatencyMs: number
	rerankingLatencyMs: number
	candidatesBeforeRerank: number
	resultsAfterRerank: number
	semanticHitRate: number
	subsequentFileReads: number
	rawFileReadTokens: number
	cacheHits: number
	indexFreshnessMisses: number
	rerankerTopNQuality: number
	/** Key product metric: % of raw file reads preceded by a relevant retrieval hit. */
	rawReadsPrecededByRelevantHitPct: number
	/** Time from task creation to first useful source-code evidence. */
	timeToFirstUsefulEvidenceMs: number
}
