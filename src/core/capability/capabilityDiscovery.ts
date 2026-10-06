/**
 * Capability Discovery for the Dynamic Capability Broker (FEAT-013).
 *
 * Discovery ranks the compact Capability Catalog descriptions against a task
 * intent and returns a RECOMMENDATION signal only. It is the "which capabilities
 * look relevant to this intent" hint that influences ranking order so the
 * mastermind can see the most plausible capabilities first.
 *
 * Critically, this is NOT an authorization authority. The score it produces is a
 * relevance signal (0..1); it MUST NOT activate a capability, and in particular a
 * high score for a high-risk capability (e.g. `cluster.deploy`) never grants it.
 * The Capability Policy Engine and the broker own authorization; discovery only
 * reorders the menu. See the design: "Embeddings never authorize a capability."
 *
 * Discovery/retrieval failure is NOT an authorization error. The retrieval
 * contract (`RetrievalGatewayClient.retrieve`) is already defined to never throw
 * and to degrade to an empty/partial packet when the gateway is unavailable;
 * `recommend` mirrors that discipline and additionally guards against any
 * unexpected throw so the broker can always proceed with mastermind/worker-
 * initiated requests and the always-resident core capabilities.
 */

import type { CapabilityCatalog, CapabilityMastermindEntry } from "./capabilityCatalog"
import type { ToolCapabilityId } from "./toolCapability"
// Consumed read-only from the semantic-first-retrieval module. These are the
// real `EvidencePacket` / `SemanticFinding`-adjacent types; this spec never
// redefines them.
import type { EvidencePacket, RetrievalIntent } from "../exploration/types"

/**
 * A single capability recommendation: the capability, a 0..1 relevance score,
 * and a short human-readable justification. This is a ranking signal only.
 */
export interface CapabilityRecommendation {
	capability: ToolCapabilityId
	/** 0..1 relevance from retrieval. NOT an authorization. */
	score: number
	/** Short, human-readable reason the capability was surfaced. */
	why: string
}

/**
 * Narrow, passed-in view of the retrieval client the discovery needs. It mirrors
 * the `retrieve` shape of the semantic-first-retrieval `RetrievalGatewayClient`
 * (`retrieve(query, workspace, intent, limit): Promise<EvidencePacket>`) so this
 * module is testable with a small fake and does not depend on the gateway's
 * construction or transport. Consumed read-only.
 */
export interface RetrievalLike {
	retrieve(query: string, workspace: string, intent: RetrievalIntent, limit: number): Promise<EvidencePacket>
}

/** The retrieval intent used for capability discovery queries. */
const DISCOVERY_INTENT: RetrievalIntent = "exploration"

/** Upper bound on evidence items requested per discovery query. */
const DISCOVERY_EVIDENCE_LIMIT = 8

/**
 * The Capability Discovery surface. `recommend` ranks the catalog's compact
 * descriptions for an intent and returns a recommendation signal only.
 */
export interface CapabilityDiscovery {
	recommend(intent: string, workspace: string): Promise<CapabilityRecommendation[]>
}

/** Dependencies for {@link createCapabilityDiscovery}. */
export interface CapabilityDiscoveryDeps {
	catalog: CapabilityCatalog
	retrieval: RetrievalLike
}

/**
 * Tokenize a string into lowercased alphanumeric terms for lexical matching.
 * Namespaced ids like "cluster.deploy" split on the dot into "cluster"/"deploy".
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0)
}

/**
 * Build the lexical token set describing a capability from its compact catalog
 * entry: the id (namespace + name), the description, and any required-arg hints.
 * Discovery only ever sees the compact mastermind view — never tool schemas.
 */
function capabilityTokens(entry: CapabilityMastermindEntry): Set<string> {
	const tokens = new Set<string>()
	for (const token of tokenize(String(entry.id))) {
		tokens.add(token)
	}
	for (const token of tokenize(entry.description)) {
		tokens.add(token)
	}
	for (const hint of entry.requiredArgHints ?? []) {
		for (const token of tokenize(hint)) {
			tokens.add(token)
		}
	}
	return tokens
}

/**
 * Score a capability against the intent tokens and the retrieval evidence.
 *
 * The score blends two lexical signals, both bounded to 0..1:
 *   - intent overlap: fraction of the capability's tokens that appear in the
 *     task intent (direct relevance to what the worker set out to do), and
 *   - evidence overlap: whether the capability's tokens appear in the reasons /
 *     file paths of the retrieved evidence (what the codebase suggests matters).
 * The evidence signal is weighted lower; it refines ordering without letting the
 * index dominate the worker's stated intent.
 */
function scoreCapability(
	capabilityToks: Set<string>,
	intentToks: Set<string>,
	evidenceToks: Set<string>,
): number {
	if (capabilityToks.size === 0) {
		return 0
	}
	let intentHits = 0
	let evidenceHits = 0
	for (const token of capabilityToks) {
		if (intentToks.has(token)) {
			intentHits += 1
		}
		if (evidenceToks.has(token)) {
			evidenceHits += 1
		}
	}
	const intentScore = intentHits / capabilityToks.size
	const evidenceScore = evidenceHits / capabilityToks.size
	// Intent dominates; evidence refines. Clamp to 0..1 for a stable signal.
	const combined = intentScore * 0.75 + evidenceScore * 0.25
	return combined < 0 ? 0 : combined > 1 ? 1 : combined
}

/** Collect lexical tokens from an evidence packet's reasons and file paths. */
function evidenceTokens(packet: EvidencePacket): Set<string> {
	const tokens = new Set<string>()
	for (const item of packet.items) {
		for (const token of tokenize(item.reason)) {
			tokens.add(token)
		}
		for (const token of tokenize(item.file)) {
			tokens.add(token)
		}
	}
	return tokens
}

/**
 * Compose a short justification for a surfaced capability. Kept compact and
 * free of any schema/server/transport detail, consistent with the mastermind
 * view boundary.
 */
function buildWhy(entry: CapabilityMastermindEntry, usedEvidence: boolean): string {
	const basis = usedEvidence ? "intent and retrieved evidence" : "task intent"
	return `Matches ${basis}: ${entry.description}`
}

/**
 * Create a {@link CapabilityDiscovery} over a catalog and a retrieval client.
 *
 * `recommend` indexes the compact catalog descriptions, queries retrieval for
 * the intent (read-only), and ranks capabilities by lexical relevance to the
 * intent refined by the retrieved evidence. It returns a recommendation signal
 * ONLY and never authorizes activation.
 *
 * Failure handling: retrieval is contractually non-throwing, but `recommend`
 * additionally catches any unexpected error and falls back to intent-only
 * ranking (a partial result), returning `[]` only if even that cannot be
 * produced. It never throws — a discovery failure must let the broker proceed.
 */
export function createCapabilityDiscovery(deps: CapabilityDiscoveryDeps): CapabilityDiscovery {
	const { catalog, retrieval } = deps

	return {
		async recommend(intent: string, workspace: string): Promise<CapabilityRecommendation[]> {
			let entries: readonly CapabilityMastermindEntry[]
			try {
				entries = catalog.mastermindView()
			} catch {
				// Even enumerating the catalog failed: an empty ranking is a valid,
				// non-fatal outcome — the broker proceeds on core capabilities.
				return []
			}

			const intentToks = new Set(tokenize(intent))

			// Retrieval is a refinement signal only. Any failure (including an
			// unexpected throw from a non-conforming client) degrades to an empty
			// evidence set, yielding intent-only ranking — never an error.
			let evidenceToks = new Set<string>()
			let usedEvidence = false
			try {
				const packet = await retrieval.retrieve(intent, workspace, DISCOVERY_INTENT, DISCOVERY_EVIDENCE_LIMIT)
				if (packet && Array.isArray(packet.items)) {
					evidenceToks = evidenceTokens(packet)
					usedEvidence = evidenceToks.size > 0
				}
			} catch {
				evidenceToks = new Set<string>()
				usedEvidence = false
			}

			const recommendations: CapabilityRecommendation[] = []
			for (const entry of entries) {
				const capabilityToks = capabilityTokens(entry)
				const score = scoreCapability(capabilityToks, intentToks, evidenceToks)
				if (score <= 0) {
					continue
				}
				recommendations.push({
					capability: entry.id,
					score,
					why: buildWhy(entry, usedEvidence),
				})
			}

			// Deterministic ordering: score descending, then capability id ascending
			// as a stable tie-breaker so repeated calls yield identical rankings.
			recommendations.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score
				}
				return String(a.capability).localeCompare(String(b.capability))
			})

			return recommendations
		},
	}
}
