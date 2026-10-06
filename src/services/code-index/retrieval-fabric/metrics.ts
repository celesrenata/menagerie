// Feature: retrieval-fabric
//
// Accumulates and emits the per-pass `RetrievalMetrics` for the Retrieval
// Gateway (Req 19.1, 19.2, 19.3).
//
// The gateway's `retrieve()` records what it can observe directly during the
// pipeline (semantic queries issued, decompositions produced, embedding /
// reranking latency, candidates before/after rerank, time-to-first-useful
// evidence). The remaining product metrics — semantic hit rate, subsequent
// file reads, raw file-read tokens, cache hits, index-freshness misses,
// reranker top-N quality, and the headline `rawReadsPrecededByRelevantHitPct`
// — are driven by downstream consumer behavior that the gateway cannot see in
// a single call, so a `RetrievalMetricsRecorder` lets a caller fold in those
// observations before building the complete `RetrievalMetrics` object.
//
// A `MetricsSink` is the extension point the gateway writes to. The default
// sink is a no-op so wiring recording into `retrieve()` is non-breaking and the
// gateway's never-throw contract is preserved: recording failures must never
// surface to the caller.

import type { RetrievalMetrics } from "./sizing-types"

/**
 * Receives a completed {@link RetrievalMetrics} object for one retrieval pass.
 *
 * Implementations persist, aggregate, or forward the metrics. The gateway
 * guarantees it never throws, so a sink MUST NOT throw either; the
 * {@link safeRecord} helper enforces this for untrusted sinks.
 */
export interface MetricsSink {
	/** Record the metrics for a single completed retrieval pass. */
	record(metrics: RetrievalMetrics): void
}

/**
 * A {@link MetricsSink} that discards everything. Used as the gateway default
 * so metric recording is opt-in and never changes behavior when no real sink
 * is injected.
 */
export const NOOP_METRICS_SINK: MetricsSink = {
	record() {
		// Intentionally empty: discards metrics so recording is a no-op by default.
	},
}

/**
 * Record metrics on a sink without ever propagating a failure.
 *
 * The gateway's `retrieve()` must never throw (Req 22), so recording is a
 * side effect that is swallowed on error rather than allowed to escape.
 *
 * @param sink The sink to write to.
 * @param metrics The completed metrics object for the pass.
 */
export function safeRecord(sink: MetricsSink, metrics: RetrievalMetrics): void {
	try {
		sink.record(metrics)
	} catch {
		// Recording is best-effort; a failing sink must not break retrieval.
	}
}

/**
 * The default/zero value for every {@link RetrievalMetrics} field.
 *
 * Starting from a complete zeroed object guarantees the recorder always
 * produces an object carrying EVERY field — including the headline
 * `rawReadsPrecededByRelevantHitPct` and `timeToFirstUsefulEvidenceMs` — even
 * when a consumer only records a subset.
 */
const ZERO_METRICS: RetrievalMetrics = {
	semanticQueriesIssued: 0,
	queryDecompositionsProduced: 0,
	embeddingLatencyMs: 0,
	rerankingLatencyMs: 0,
	candidatesBeforeRerank: 0,
	resultsAfterRerank: 0,
	semanticHitRate: 0,
	subsequentFileReads: 0,
	rawFileReadTokens: 0,
	cacheHits: 0,
	indexFreshnessMisses: 0,
	rerankerTopNQuality: 0,
	rawReadsPrecededByRelevantHitPct: 0,
	timeToFirstUsefulEvidenceMs: 0,
}

/**
 * Accumulates {@link RetrievalMetrics} fields across a retrieval pass and the
 * downstream consumer behavior that follows it, then produces one complete
 * `RetrievalMetrics` object.
 *
 * The recorder is seeded with a fully zeroed metrics object so every field is
 * always present in the output regardless of which fields a caller recorded.
 * Setters are chainable so the gateway can fold in the fields it observes
 * directly during `retrieve()` and a consumer can later fold in the
 * read-behavior / cache / freshness fields the gateway cannot see.
 */
export class RetrievalMetricsRecorder {
	private readonly metrics: RetrievalMetrics

	constructor(initial?: Partial<RetrievalMetrics>) {
		this.metrics = { ...ZERO_METRICS, ...initial }
	}

	/** Number of semantic (sub-)queries issued against the fabric. */
	setSemanticQueriesIssued(value: number): this {
		this.metrics.semanticQueriesIssued = value
		return this
	}

	/** Number of query decompositions produced for the original query. */
	setQueryDecompositionsProduced(value: number): this {
		this.metrics.queryDecompositionsProduced = value
		return this
	}

	/** Observed embedding latency for the pass, in milliseconds. */
	setEmbeddingLatencyMs(value: number): this {
		this.metrics.embeddingLatencyMs = value
		return this
	}

	/** Observed reranking latency for the pass, in milliseconds. */
	setRerankingLatencyMs(value: number): this {
		this.metrics.rerankingLatencyMs = value
		return this
	}

	/** Count of fused candidates presented to the reranker. */
	setCandidatesBeforeRerank(value: number): this {
		this.metrics.candidatesBeforeRerank = value
		return this
	}

	/** Count of results emitted after reranking (the bounded evidence set). */
	setResultsAfterRerank(value: number): this {
		this.metrics.resultsAfterRerank = value
		return this
	}

	/** Fraction of passes where semantic retrieval produced a relevant hit. */
	setSemanticHitRate(value: number): this {
		this.metrics.semanticHitRate = value
		return this
	}

	/** Raw file reads the consumer performed after this retrieval. */
	setSubsequentFileReads(value: number): this {
		this.metrics.subsequentFileReads = value
		return this
	}

	/** Token count of raw file-read content pulled in after retrieval. */
	setRawFileReadTokens(value: number): this {
		this.metrics.rawFileReadTokens = value
		return this
	}

	/** Number of cache hits served during the pass. */
	setCacheHits(value: number): this {
		this.metrics.cacheHits = value
		return this
	}

	/** Count of results served from a stale index (freshness misses). */
	setIndexFreshnessMisses(value: number): this {
		this.metrics.indexFreshnessMisses = value
		return this
	}

	/** Measured top-N quality of the reranker output. */
	setRerankerTopNQuality(value: number): this {
		this.metrics.rerankerTopNQuality = value
		return this
	}

	/** Headline metric: % of raw file reads preceded by a relevant hit. */
	setRawReadsPrecededByRelevantHitPct(value: number): this {
		this.metrics.rawReadsPrecededByRelevantHitPct = value
		return this
	}

	/** Time from task creation to first useful source-code evidence, in ms. */
	setTimeToFirstUsefulEvidenceMs(value: number): this {
		this.metrics.timeToFirstUsefulEvidenceMs = value
		return this
	}

	/**
	 * Produce the complete {@link RetrievalMetrics} object.
	 *
	 * The returned object is a fresh copy carrying every field, so later
	 * mutations on the recorder do not affect an already-built snapshot.
	 */
	build(): RetrievalMetrics {
		return { ...this.metrics }
	}
}
