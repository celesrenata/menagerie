// Feature: retrieval-fabric
//
// Deterministic Reciprocal Rank Fusion (RRF) over multiple ranked candidate
// lists (Requirement 12). The gateway runs this to merge the dense, lexical,
// and symbol ranked lists into one ~30-50 candidate list *before* reranking.
//
// RRF is a pure function of its inputs: identical `rankedLists` (and `k`)
// always produce the identical merged order. Determinism is guaranteed by a
// stable tie-break — RRF score descending, then the identity triple
// (`file`, `startLine`, `endLine`) ascending — so equal-scoring candidates can
// never land in a nondeterministic order (Req 12.1, 12.2, 12.3).

import type { RankedCandidate } from "./types"

/**
 * Default RRF constant. The standard Reciprocal Rank Fusion damping constant;
 * larger `k` flattens the contribution of top ranks relative to lower ones.
 */
export const DEFAULT_RRF_K = 60

/** Internal accumulator for a single identity triple during fusion. */
interface FusionAccumulator {
	file: string
	startLine: number
	endLine: number
	/** Accumulated RRF score summed across every list the triple appears in. */
	rrfScore: number
	/**
	 * The source candidate contributing the best (lowest) rank seen so far,
	 * used to carry `mode`/`snippet`/`score` through fusion deterministically.
	 */
	best: RankedCandidate
	/** Lowest 0-based rank seen for this triple across all lists. */
	bestRank: number
}

/** Stable identity key for a candidate range (Req 12 dedup identity triple). */
function identityKey(candidate: RankedCandidate): string {
	return `${candidate.file}\u0000${candidate.startLine}\u0000${candidate.endLine}`
}

/**
 * Deterministic tie-break comparator: RRF score descending, then the identity
 * triple (file, startLine, endLine) ascending. Guarantees a total order over
 * distinct triples so fusing identical inputs yields an identical ordering.
 */
function compareFused(a: FusionAccumulator, b: FusionAccumulator): number {
	if (a.rrfScore !== b.rrfScore) {
		return b.rrfScore - a.rrfScore
	}
	if (a.file !== b.file) {
		return a.file < b.file ? -1 : 1
	}
	if (a.startLine !== b.startLine) {
		return a.startLine - b.startLine
	}
	return a.endLine - b.endLine
}

/**
 * Merge multiple ranked candidate lists with Reciprocal Rank Fusion.
 *
 * Each candidate contributes `1 / (k + rank)` to its identity triple, summed
 * across every list it appears in. The same range surfaced by different modes
 * is deduplicated by its (`file`, `startLine`, `endLine`) triple. The result is
 * sorted by RRF score descending with a stable identity tie-break, so identical
 * inputs always produce the identical merged order (Req 12.1, 12.2, 12.3).
 *
 * Each returned candidate's `score` is its summed RRF score and `rank` is its
 * 0-based position in the merged list; `mode`/`snippet` are carried from the
 * candidate contributing the triple's best (lowest) source rank.
 *
 * @param rankedLists One ranked list per retrieval mode. Each list is assumed
 *   ordered best-first; a candidate's `rank` field is used as its position.
 * @param k RRF damping constant; defaults to {@link DEFAULT_RRF_K} (60).
 * @returns The merged ~30-50 candidate list consumed before reranking.
 */
export function fuseRRF(rankedLists: RankedCandidate[][], k: number = DEFAULT_RRF_K): RankedCandidate[] {
	const accumulators = new Map<string, FusionAccumulator>()

	for (const list of rankedLists) {
		for (const candidate of list) {
			const contribution = 1 / (k + candidate.rank)
			const key = identityKey(candidate)
			const existing = accumulators.get(key)

			if (existing === undefined) {
				accumulators.set(key, {
					file: candidate.file,
					startLine: candidate.startLine,
					endLine: candidate.endLine,
					rrfScore: contribution,
					best: candidate,
					bestRank: candidate.rank,
				})
				continue
			}

			existing.rrfScore += contribution
			if (candidate.rank < existing.bestRank) {
				existing.bestRank = candidate.rank
				existing.best = candidate
			}
		}
	}

	const fused = Array.from(accumulators.values()).sort(compareFused)

	return fused.map((entry, index) => ({
		file: entry.file,
		startLine: entry.startLine,
		endLine: entry.endLine,
		rank: index,
		score: entry.rrfScore,
		mode: entry.best.mode,
		...(entry.best.snippet !== undefined ? { snippet: entry.best.snippet } : {}),
	}))
}
