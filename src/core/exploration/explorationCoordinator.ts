import type { EvidencePacket, RetrievalIntent, SemanticFinding } from "./types"
import type { SemanticExplorationCache, SharedRetrievalMemory } from "./semanticExplorationState"
import type { RetrievalMetricsRecorder } from "./retrievalMetricsRecorder"
import type { RetrievalGatewayClient } from "./retrievalGatewayClient"

/**
 * Dependencies for the thin exploration coordinator. All are per-task-scoped
 * except the gateway client, which is a shared thin transport wrapper.
 */
export interface ExplorationCoordinatorDeps {
	cache: SemanticExplorationCache
	sharedMemory: SharedRetrievalMemory
	metrics: RetrievalMetricsRecorder
	gateway: RetrievalGatewayClient
}

/**
 * Origin of the findings returned by {@link retrieveWithReuse}: a per-task
 * cache hit, a cross-worker shared-memory hit, or a fresh gateway retrieve.
 */
export type RetrievalSource = "cache" | "shared_memory" | "gateway"

/**
 * Result of a reuse-aware retrieval: the findings plus where they came from.
 */
export interface RetrievalResult {
	findings: ReadonlyArray<SemanticFinding>
	source: RetrievalSource
}

/**
 * Normalize a query so the same concept maps to the same reuse key regardless
 * of surrounding or internal whitespace or case. Mirrors the normalization in
 * `semanticExplorationState` (trim, collapse internal whitespace, lowercase);
 * it is re-implemented here because that module does not export it.
 */
function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Convert a gateway {@link EvidencePacket} into {@link SemanticFinding}
 * records, tagging each with the (un-normalized) `query` so cache/shared-memory
 * keying stays consistent across readers.
 */
function toFindings(query: string, packet: EvidencePacket): SemanticFinding[] {
	return packet.items.map((item) => ({
		query,
		file: item.file,
		startLine: item.startLine,
		endLine: item.endLine,
		score: item.score,
	}))
}

/**
 * Attempt to reuse cached/shared findings before issuing a new gateway call
 * (design: Requirement 5 cache reuse extended to Requirement 11 cross-worker
 * visibility).
 *
 * Precedence:
 * 1. Per-task cache hit → record `queries-reused`, return `{ source: "cache" }`
 *    with no gateway call (Req 5.2, 5.4).
 * 2. Cross-worker shared-memory hit → copy into the per-task cache so later
 *    reuse is a cache hit, record `queries-reused`, return
 *    `{ source: "shared_memory" }` with no gateway call (Req 11.4).
 * 3. Otherwise call `gateway.retrieve(...)`, convert the packet to findings,
 *    store in cache, publish to shared memory, record one semantic query and
 *    the number of files returned, return `{ source: "gateway" }` (Req 5.1).
 *
 * The gateway client never throws (it normalizes failures to an empty packet),
 * so a gateway miss still returns a valid-but-empty `gateway` result.
 *
 * Requirements traced: 5.2, 5.4, 11.4
 */
export async function retrieveWithReuse(
	query: string,
	workspace: string,
	intent: RetrievalIntent,
	limit: number,
	deps: ExplorationCoordinatorDeps,
): Promise<RetrievalResult> {
	const { cache, sharedMemory, metrics, gateway } = deps

	// 1. Per-task cache hit: reuse without touching the gateway.
	const cached = cache.lookup(query)
	if (cached !== undefined) {
		metrics.recordQueriesReused()
		return { findings: cached, source: "cache" }
	}

	// 2. Cross-worker shared-memory hit: reuse, and seed the per-task cache so
	//    subsequent lookups for this concept resolve as a cache hit.
	const shared = sharedMemory.lookup(query)
	if (shared !== undefined) {
		cache.store(query, shared)
		metrics.recordQueriesReused()
		return { findings: shared, source: "shared_memory" }
	}

	// 3. Miss: issue the gateway retrieve, then store + publish the findings.
	const packet = await gateway.retrieve(query, workspace, intent, limit)
	const findings = toFindings(query, packet)
	cache.store(query, findings)
	sharedMemory.publish(findings)
	metrics.recordSemanticQuery()
	metrics.recordFilesReturned(findings.length)
	return { findings, source: "gateway" }
}
