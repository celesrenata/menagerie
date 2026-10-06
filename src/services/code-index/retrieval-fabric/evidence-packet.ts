// Feature: retrieval-fabric
//
// Bounds a reranked candidate list into the final `EvidencePacket` the
// Menagerie consumer sees.
//
// By design the gateway returns a small, high-signal evidence set and never
// the full 30-50 fused/reranked candidate set (Req 10.1, 10.2, 10.5). This
// module is pure: given the same reranked list and `degraded` flag it always
// produces the same packet, so it is safe to call from the `retrieve()`
// pipeline and from property tests without side effects.

import type { EvidenceItem, EvidencePacket, RankedCandidate, RetrievalMode } from "./types"

/**
 * Upper bound on the number of {@link EvidenceItem}s in an
 * {@link EvidencePacket}. The gateway targets ~5-8 items; this is the hard
 * ceiling so the packet is never the full candidate set (Req 10.1, 14.1).
 */
export const MAX_EVIDENCE_ITEMS = 8

/**
 * Human-readable justification for an evidence item, derived from the
 * retrieval mode that surfaced the underlying candidate (Req 10.4).
 */
function reasonForMode(mode: RetrievalMode): string {
	switch (mode) {
		case "dense":
			return "Semantic (dense) similarity match"
		case "lexical":
			return "Exact lexical / identifier match"
		case "symbol":
			return "Symbol / file / path match"
	}
}

/**
 * Convert a reranked candidate list into a bounded {@link EvidencePacket}.
 *
 * Keeps at most {@link MAX_EVIDENCE_ITEMS} top-ranked candidates (preserving
 * the reranked order), maps each to a correctly shaped {@link EvidenceItem},
 * derives a `reason` from the candidate's mode, and carries `snippet` through
 * only when it is present (Req 10.4). Pure and deterministic (Req 10.5).
 *
 * @param reranked Candidates in final reranked order (best first).
 * @param degraded Whether the packet is served via fallback (Req 22.7, 22.8).
 * @returns A bounded evidence packet; `items.length` is never greater than
 *   {@link MAX_EVIDENCE_ITEMS} and never the full candidate set.
 */
export function toEvidencePacket(reranked: RankedCandidate[], degraded: boolean): EvidencePacket {
	const items: EvidenceItem[] = reranked.slice(0, MAX_EVIDENCE_ITEMS).map((candidate): EvidenceItem => {
		const item: EvidenceItem = {
			file: candidate.file,
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			score: candidate.score,
			reason: reasonForMode(candidate.mode),
		}
		if (candidate.snippet !== undefined) {
			item.snippet = candidate.snippet
		}
		return item
	})

	return { items, degraded }
}
