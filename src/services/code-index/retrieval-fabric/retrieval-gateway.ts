// Feature: retrieval-fabric
//
// The logical Retrieval Gateway orchestration (Requirements 8, 9, 11, 14, 22).
//
// `RetrievalGatewayImpl.retrieve()` is the single entry point the Menagerie
// consumer sees. It runs the hybrid retrieval pipeline end to end:
//
//   decompose → (per sub-query) planHybridQuery → dense + lexical/symbol
//   retrievers → fuseRRF → Qwen3 reranker → applyFreshness → toEvidencePacket
//
// By design the caller never names a physical node or OVMS replica: which
// embedding/reranker replica serves each request is owned by the Kubernetes
// Service and OmniRoute below this surface, so `RetrieveParams` carries no
// node/replica field (Req 8.3, 22.3). The collaborators injected here (dense
// retriever, lexical/symbol retriever, reranker) reach the fabric through that
// Service; this module only orchestrates them and never selects a replica.
//
// The collaborators are dependency-injected interfaces so the orchestration is
// unit-testable without a live cluster. In production the dense retriever wraps
// the existing embedder + Qdrant (reusing the preserved request-batching and
// splitting guards), the lexical/symbol retriever wraps exact-token search, and
// the reranker wraps Qwen3-Reranker-0.6B served via OVMS.
//
// Graceful degradation (Req 22.1, 22.2, 22.5, 22.6, 22.7, 22.8): if the
// reranker or any part of the fabric is unavailable (a collaborator throws),
// `retrieve()` never throws. It falls back to the fused top candidates it was
// able to gather, bounds them, and marks the packet `degraded: true`.

import type { EvidencePacket, RankedCandidate, RetrieveParams, RetrievalGateway } from "./types"
import { decomposeQuery, planHybridQuery } from "./query-planning"
import { fuseRRF } from "./fusion"
import { applyFreshness, type FreshnessChangeInfo } from "./freshness"
import { toEvidencePacket } from "./evidence-packet"
import { NOOP_METRICS_SINK, RetrievalMetricsRecorder, safeRecord, type MetricsSink } from "./metrics"

/**
 * Context passed to a {@link DenseRetriever} / {@link LexicalSymbolRetriever}
 * for a single planned sub-query.
 *
 * Carries no node/replica selection by design (Req 8.3, 22.3): the retriever
 * reaches the fabric through the Kubernetes Service / OmniRoute, which owns
 * replica selection. `workspace` scopes the retrieval; `intent` and
 * `exactTokens` let a retriever shape its own ranking without changing the
 * gateway's bounded output contract.
 */
export interface RetrievalRequest {
	/** The (possibly decomposed) sub-query to run. */
	query: string
	/** Absolute workspace path the retrieval is scoped to. */
	workspace: string
	/** Caller intent for the originating request. */
	intent: RetrieveParams["intent"]
	/** Exact tokens the query planner detected for this sub-query. */
	exactTokens: string[]
}

/**
 * Dense (embedding-similarity) retriever collaborator.
 *
 * The production implementation embeds the query with the existing embedder and
 * searches the Qdrant collection through the Kubernetes Service, reusing the
 * preserved request-batching/splitting guards. It returns a ranked list whose
 * `rank` fields are 0-based positions in best-first order.
 */
export interface DenseRetriever {
	retrieveDense(request: RetrievalRequest): Promise<RankedCandidate[]>
}

/**
 * Lexical / symbol retriever collaborator.
 *
 * Runs exact identifier/lexical search and symbol/file/path relevance so
 * retrieval never relies on dense similarity alone (Req 11.2, 11.3). Returns a
 * ranked list in best-first order with 0-based `rank` fields.
 */
export interface LexicalSymbolRetriever {
	retrieveLexicalSymbol(request: RetrievalRequest): Promise<RankedCandidate[]>
}

/**
 * Reranker collaborator (Qwen3-Reranker-0.6B in production).
 *
 * Scores the fused candidates against the original query and returns them in
 * final reranked order (best first) with renumbered 0-based `rank` fields.
 */
export interface Reranker {
	rerank(query: string, candidates: RankedCandidate[]): Promise<RankedCandidate[]>
}

/**
 * Supplies per-candidate freshness state for a fused/reranked list so the
 * gateway can prefer current code over stale index entries (Req 18).
 *
 * The production implementation inspects working-tree modifications, parallel
 * worker patches, and index timestamps. It is optional: when absent, every
 * candidate is treated as current and freshness reordering is a no-op.
 */
export interface FreshnessProvider {
	changeInfoFor(workspace: string, candidates: RankedCandidate[]): FreshnessChangeInfo
}

/** Collaborators injected into {@link RetrievalGatewayImpl}. */
export interface RetrievalGatewayDeps {
	/** Dense embedding-similarity retriever. */
	denseRetriever: DenseRetriever
	/** Exact lexical / symbol retriever. */
	lexicalSymbolRetriever: LexicalSymbolRetriever
	/** Production reranker (Qwen3-Reranker-0.6B). */
	reranker: Reranker
	/** Optional freshness provider; when omitted, freshness is a no-op. */
	freshnessProvider?: FreshnessProvider
	/**
	 * Optional sink that receives a complete {@link RetrievalMetrics} object for
	 * every `retrieve()` call (Req 19). When omitted, recording is a no-op so
	 * wiring is non-breaking. The gateway never lets a sink failure escape, so
	 * its never-throw contract (Req 22) is preserved.
	 */
	metricsSink?: MetricsSink
}

/** Empty freshness info: every candidate current, non-stale, unchanged. */
function noChangeInfo(candidates: RankedCandidate[]): FreshnessChangeInfo {
	return { perCandidate: candidates.map(() => ({ isStale: false, changedAfterIndexing: false })) }
}

/**
 * Logical Retrieval Gateway over the Intel-GPU OVMS fabric.
 *
 * Orchestrates the hybrid retrieval pipeline using dependency-injected
 * collaborators so the orchestration is unit-testable without a live cluster.
 * Exposes a single {@link RetrievalGateway.retrieve} surface and never a
 * node/replica selector (Req 8.1, 8.4, 22.3).
 */
export class RetrievalGatewayImpl implements RetrievalGateway {
	private readonly denseRetriever: DenseRetriever
	private readonly lexicalSymbolRetriever: LexicalSymbolRetriever
	private readonly reranker: Reranker
	private readonly freshnessProvider?: FreshnessProvider
	private readonly metricsSink: MetricsSink

	constructor(deps: RetrievalGatewayDeps) {
		this.denseRetriever = deps.denseRetriever
		this.lexicalSymbolRetriever = deps.lexicalSymbolRetriever
		this.reranker = deps.reranker
		this.freshnessProvider = deps.freshnessProvider
		this.metricsSink = deps.metricsSink ?? NOOP_METRICS_SINK
	}

	/**
	 * Run the hybrid retrieval pipeline for a single request and return a
	 * bounded ~5-8 item evidence packet (Req 8.1, 8.2, 9, 11, 14).
	 *
	 * Pipeline:
	 *   1. `decomposeQuery` the query into one or more sub-queries.
	 *   2. For each sub-query: `planHybridQuery`, then run the dense retriever and
	 *      (when the plan calls for exact-token modes) the lexical/symbol
	 *      retriever, collecting one ranked list per retriever.
	 *   3. `fuseRRF` merges every ranked list into a deterministic ~30-50
	 *      candidate list before reranking (Req 9.4, 12).
	 *   4. The reranker (Qwen3-Reranker-0.6B) reduces the fused list.
	 *   5. `applyFreshness` reorders so current code beats stale index entries.
	 *   6. `toEvidencePacket` bounds the result to ~5-8 items with `degraded`
	 *      false.
	 *
	 * Never throws: if the reranker or any retriever is unavailable, the fused
	 * top candidates gathered so far are bounded and returned with
	 * `degraded: true` (Req 22.1, 22.2, 22.5, 22.6, 22.7, 22.8). Dense and
	 * lexical/symbol retrieval are reached only through the Kubernetes Service /
	 * OmniRoute, so no node/replica is ever selected by the caller (Req 8.3,
	 * 22.3).
	 */
	async retrieve(params: RetrieveParams): Promise<EvidencePacket> {
		// A single clock drives both the per-stage latencies and the headline
		// time-to-first-useful-evidence, which is the elapsed time from the start
		// of the call to the moment the bounded packet is ready (Req 19.3).
		const startedAtMs = Date.now()
		const recorder = new RetrievalMetricsRecorder()

		const subQueries = decomposeQuery(params.query, params.intent)
		recorder
			.setSemanticQueriesIssued(subQueries.length)
			// decomposeQuery expands into >1 sub-query only where it adds distinct
			// coverage; a single sub-query means no decomposition was produced.
			.setQueryDecompositionsProduced(subQueries.length > 1 ? subQueries.length : 0)

		// Fuse up front so the fused list is always available for the degraded
		// fallback path even if reranking later fails. Retriever failures are
		// themselves fabric-unavailability signals and surface as a degraded
		// packet built from whatever ranked lists were gathered.
		let fused: RankedCandidate[]
		const embeddingStartedAtMs = Date.now()
		try {
			const rankedLists = await this.gatherRankedLists(subQueries, params)
			fused = fuseRRF(rankedLists)
		} catch {
			// Retrieval unavailable: still emit what we observed before failing.
			recorder.setEmbeddingLatencyMs(Date.now() - embeddingStartedAtMs)
			return this.recordAndReturn(recorder, toEvidencePacket([], true), startedAtMs)
		}
		recorder.setEmbeddingLatencyMs(Date.now() - embeddingStartedAtMs).setCandidatesBeforeRerank(fused.length)

		const rerankStartedAtMs = Date.now()
		try {
			const reranked = await this.reranker.rerank(params.query, fused)
			recorder.setRerankingLatencyMs(Date.now() - rerankStartedAtMs)
			const fresh = this.applyFreshnessPass(params.workspace, reranked)
			const packet = toEvidencePacket(fresh, false)
			recorder.setResultsAfterRerank(packet.items.length)
			return this.recordAndReturn(recorder, packet, startedAtMs)
		} catch {
			// Reranker/fabric unavailable: return the fused top candidates bounded
			// and degraded rather than throwing (Req 22.5, 22.6, 22.7, 22.8).
			recorder.setRerankingLatencyMs(Date.now() - rerankStartedAtMs)
			const packet = toEvidencePacket(fused, true)
			recorder.setResultsAfterRerank(packet.items.length)
			return this.recordAndReturn(recorder, packet, startedAtMs)
		}
	}

	/**
	 * Stamp the time-to-first-useful-evidence, emit the completed metrics to the
	 * sink (best-effort; never throws), and return the packet unchanged.
	 *
	 * Centralizing this on both the success and degraded paths guarantees every
	 * `retrieve()` call records a complete {@link RetrievalMetrics} object
	 * carrying every field, and keeps the gateway's never-throw contract intact.
	 */
	private recordAndReturn(
		recorder: RetrievalMetricsRecorder,
		packet: EvidencePacket,
		startedAtMs: number,
	): EvidencePacket {
		recorder.setTimeToFirstUsefulEvidenceMs(Date.now() - startedAtMs)
		safeRecord(this.metricsSink, recorder.build())
		return packet
	}

	/**
	 * Run every retriever for every sub-query and collect one ranked list per
	 * retriever invocation. The dense retriever runs for every sub-query; the
	 * lexical/symbol retriever runs only when the plan includes an exact-token
	 * mode (Req 11.2, 11.3).
	 */
	private async gatherRankedLists(subQueries: string[], params: RetrieveParams): Promise<RankedCandidate[][]> {
		const retrievals: Array<Promise<RankedCandidate[]>> = []

		for (const subQuery of subQueries) {
			const plan = planHybridQuery(subQuery)
			const request: RetrievalRequest = {
				query: subQuery,
				workspace: params.workspace,
				intent: params.intent,
				exactTokens: plan.exactTokens,
			}

			retrievals.push(this.denseRetriever.retrieveDense(request))

			if (plan.modes.includes("lexical") || plan.modes.includes("symbol")) {
				retrievals.push(this.lexicalSymbolRetriever.retrieveLexicalSymbol(request))
			}
		}

		return Promise.all(retrievals)
	}

	/**
	 * Apply the freshness pass over a reranked list using the injected provider.
	 * When no provider is configured, candidates are treated as current and the
	 * reranked order is preserved.
	 */
	private applyFreshnessPass(workspace: string, reranked: RankedCandidate[]): RankedCandidate[] {
		const changeInfo = this.freshnessProvider
			? this.freshnessProvider.changeInfoFor(workspace, reranked)
			: noChangeInfo(reranked)
		return applyFreshness(reranked, changeInfo)
	}
}

/**
 * Factory for a {@link RetrievalGateway} backed by {@link RetrievalGatewayImpl}.
 *
 * @param deps The injected collaborators (dense retriever, lexical/symbol
 *   retriever, reranker, optional freshness provider).
 * @returns A gateway whose `retrieve()` surface exposes no node/replica
 *   selector.
 */
export function createRetrievalGateway(deps: RetrievalGatewayDeps): RetrievalGateway {
	return new RetrievalGatewayImpl(deps)
}
