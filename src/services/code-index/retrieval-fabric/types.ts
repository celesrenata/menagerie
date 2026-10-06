// Feature: retrieval-fabric
//
// Gateway surface and evidence types for the logical Retrieval Gateway.
//
// This module defines the public shape the Menagerie consumer sees
// (`RetrievalIntent`, `RetrieveParams`, `EvidenceItem`, `EvidencePacket`,
// `RetrievalGateway`) plus the internal pure-logic shapes (`RankedCandidate`,
// `HybridQueryPlan`) consumed by fusion and query-planning surfaces.
//
// By design the caller never selects a physical node or OVMS replica:
// request distribution is owned by the gateway and OmniRoute, so
// `RetrieveParams` carries NO node/replica selection field (Req 8.3, 22.3).

/**
 * Caller intent for a retrieval request. Shapes query decomposition and
 * ranking without changing the gateway's bounded output contract.
 */
export type RetrievalIntent = "implement" | "debug" | "explain" | "locate" | "review"

/**
 * Parameters for a single {@link RetrievalGateway.retrieve} call.
 *
 * Carries no node/replica selection by design (Req 8.3, 22.3): the gateway and
 * OmniRoute decide which replica serves the request.
 */
export interface RetrieveParams {
	/** Natural-language task or query from the caller. */
	query: string
	/** Absolute workspace path the retrieval is scoped to. */
	workspace: string
	/** Caller intent, used to shape decomposition and ranking. */
	intent: RetrievalIntent
	/** Caller hint for result count; the gateway still bounds output to ~5-8. */
	limit: number
}

/**
 * A single piece of evidence returned in an {@link EvidencePacket}.
 *
 * `snippet` is included only where it materially aids the caller (Req 10.4).
 */
export interface EvidenceItem {
	/** Workspace-relative file path. */
	file: string
	/** 1-based inclusive start line of the relevant range. */
	startLine: number
	/** 1-based inclusive end line of the relevant range. */
	endLine: number
	/** Relevance score (higher is more relevant). */
	score: number
	/** Short human-readable justification for why this item was selected. */
	reason: string
	/** Compact excerpt, included only where it materially aids the caller. */
	snippet?: string
}

/**
 * Bounded result set returned by {@link RetrievalGateway.retrieve}.
 *
 * `items` is bounded to ~5-8 and is never the full 30-50 candidate set
 * (Req 10.1, 10.2, 10.5). `degraded` is `true` when the packet was served via
 * fallback because the fabric or gateway was unavailable (Req 22.7, 22.8).
 */
export interface EvidencePacket {
	/** Bounded (~5-8) ranked evidence items; never the full candidate set. */
	items: EvidenceItem[]
	/** True when served via fallback (fabric/gateway unavailable). */
	degraded: boolean
}

/**
 * The logical entry point the Menagerie consumer sees. Exposes a single
 * `retrieve` surface and never a node/replica selector (Req 8.1, 8.4, 22.3).
 */
export interface RetrievalGateway {
	retrieve(params: RetrieveParams): Promise<EvidencePacket>
}

/**
 * Retrieval modes a {@link HybridQueryPlan} can request.
 *
 * - `dense`: dense embedding similarity over the Qdrant collection.
 * - `lexical`: exact identifier/lexical search.
 * - `symbol`: symbol / file / path relevance.
 */
export type RetrievalMode = "dense" | "lexical" | "symbol"

/**
 * A candidate produced by one retrieval mode and consumed by the pure-logic
 * surfaces (RRF fusion, reranking, freshness, bounding).
 *
 * The identity triple (`file`, `startLine`, `endLine`) deduplicates the same
 * range surfaced by different modes during fusion; `rank` is the 0-based
 * position within its source ranked list and `score` is the mode-local
 * relevance used for tie-breaking and later reranking.
 */
export interface RankedCandidate {
	/** Workspace-relative file path. */
	file: string
	/** 1-based inclusive start line of the candidate range. */
	startLine: number
	/** 1-based inclusive end line of the candidate range. */
	endLine: number
	/** 0-based position within the source ranked list. */
	rank: number
	/** Mode-local relevance score (higher is more relevant). */
	score: number
	/** Retrieval mode that produced this candidate. */
	mode: RetrievalMode
	/** Optional compact excerpt carried through the pipeline. */
	snippet?: string
}

/**
 * The retrieval modes a query needs, as decided by `planHybridQuery`.
 *
 * `modes` always includes `dense`, and additionally includes `lexical` and
 * `symbol` when the query carries an exact token (identifier, error string,
 * named resource, file path, or UUID) so retrieval never relies on dense
 * similarity alone (Req 11.2, 11.3). `exactTokens` captures the detected exact
 * tokens that drove that decision.
 */
export interface HybridQueryPlan {
	/** The original query the plan was built from. */
	query: string
	/** Retrieval modes to run; always includes `dense`. */
	modes: RetrievalMode[]
	/** Exact tokens detected in the query (identifiers, errors, paths, UUIDs). */
	exactTokens: string[]
}
