// Feature: retrieval-fabric
//
// Change-awareness / freshness ranking (Requirement 18). The gateway runs this
// after fusion/reranking and before bounding, so that current code is preferred
// over stale index entries when the two disagree.
//
// Two facts drive ranking:
//   - `changedAfterIndexing`: the file changed on disk after it was indexed, so
//     the index entry for the stale version may no longer reflect current code
//     (working-tree modifications, parallel worker patches, recently changed
//     files all surface here) (Req 18.2, 18.4).
//   - `isStale`: this specific candidate was produced from an index entry that
//     predates the current on-disk version of its file (Req 18.3).
//
// The key invariant (Property 7): for any file that has BOTH a current
// (changed-after-indexing) version and a stale index entry, the stale entry
// MUST NOT silently outrank the current changed version of the same file. This
// module enforces that by reordering so current beats stale for the same file,
// without otherwise disturbing the fused/reranked order.
//
// `applyFreshness` is a pure function of its inputs: it reads only the supplied
// candidates and change info and returns a new array; it performs no I/O and
// never mutates its inputs.

import type { RankedCandidate } from "./types"

/**
 * Per-candidate freshness state describing how a candidate relates to the
 * current on-disk version of its file.
 */
export interface CandidateFreshness {
	/**
	 * True when this candidate came from an index entry that predates the
	 * current on-disk version of its file (a stale index entry) (Req 18.3).
	 */
	isStale: boolean
	/**
	 * True when the candidate's file changed after it was indexed — working-tree
	 * modification, parallel worker patch, or recently changed file (Req 18.2,
	 * 18.4). A candidate that is both current and `changedAfterIndexing` reflects
	 * the up-to-date code and should be preferred over a stale entry of the same
	 * file.
	 */
	changedAfterIndexing: boolean
}

/**
 * Change info for a freshness pass: per-candidate freshness state aligned by
 * index with the candidates array passed to {@link applyFreshness}.
 *
 * `perCandidate[i]` describes `candidates[i]`. Candidates with no entry (or an
 * out-of-range index) are treated as current, non-stale, unchanged.
 */
export interface FreshnessChangeInfo {
	/** Freshness state per candidate, aligned by array index. */
	perCandidate: CandidateFreshness[]
}

/**
 * Signal that a file changed after indexing and therefore needs an incremental
 * reindex or a freshness weighting applied (Req 18.4).
 */
export interface FreshnessReindexSignal {
	/** Workspace-relative file path that changed after indexing. */
	file: string
	/**
	 * Recommended remediation: `reindex` when a current changed version should
	 * be re-embedded, otherwise `freshness-weighting` when ranking-time
	 * weighting is sufficient to keep current code ahead of stale entries.
	 */
	action: "reindex" | "freshness-weighting"
}

/** A candidate paired with its freshness state and original fused position. */
interface FreshnessEntry {
	candidate: RankedCandidate
	freshness: CandidateFreshness
	/** 0-based position in the input list, used as a stable tie-break. */
	originalIndex: number
	/**
	 * Freshness tier: lower sorts first. `0` = current version of a file that
	 * changed after indexing (most authoritative), `1` = current/unchanged,
	 * `2` = stale index entry (least authoritative).
	 */
	tier: number
}

/** Default freshness state for a candidate with no supplied change info. */
const DEFAULT_FRESHNESS: CandidateFreshness = { isStale: false, changedAfterIndexing: false }

/**
 * Compute the freshness tier for a candidate. A current (non-stale) version of
 * a file that changed after indexing is the most authoritative (tier 0); a
 * stale index entry is the least authoritative (tier 2); everything else sits
 * in between (tier 1).
 */
function freshnessTier(freshness: CandidateFreshness): number {
	if (freshness.isStale) {
		return 2
	}
	if (freshness.changedAfterIndexing) {
		return 0
	}
	return 1
}

/**
 * Reorder ranked candidates so current code is preferred over stale index
 * entries, enforcing that a stale entry never outranks a current changed
 * version of the same file (Req 18.1, 18.2, 18.3; Property 7).
 *
 * Candidates are grouped by file. Within a file that has both a current
 * changed-after-indexing version and one or more stale entries, the current
 * version is ordered ahead of the stale entries. Across files and among
 * candidates of the same freshness tier, the original fused/reranked order is
 * preserved (a stable sort by tier then original position). The returned
 * candidates have their `rank` field renumbered to their new 0-based position.
 *
 * Pure: inputs are never mutated and no I/O is performed.
 *
 * @param candidates Fused/reranked candidates, best-first.
 * @param changeInfo Per-candidate freshness state aligned by index.
 * @returns A new array ordered so current code beats stale entries per file.
 */
export function applyFreshness(
	candidates: RankedCandidate[],
	changeInfo: FreshnessChangeInfo,
): RankedCandidate[] {
	const perCandidate = changeInfo.perCandidate

	// Which files have a current (non-stale) changed-after-indexing version?
	// Only those files need stale entries demoted below their current version.
	const filesWithCurrentChanged = new Set<string>()
	for (let index = 0; index < candidates.length; index++) {
		const freshness = perCandidate[index] ?? DEFAULT_FRESHNESS
		if (!freshness.isStale && freshness.changedAfterIndexing) {
			filesWithCurrentChanged.add(candidates[index].file)
		}
	}

	const entries: FreshnessEntry[] = candidates.map((candidate, index) => {
		const freshness = perCandidate[index] ?? DEFAULT_FRESHNESS
		// A stale entry is only demoted when its file has a current changed
		// version to defer to; otherwise it keeps its tier-1 position so stale
		// results for unchanged files are not needlessly disturbed.
		const relevantStale = freshness.isStale && filesWithCurrentChanged.has(candidate.file)
		const effective: CandidateFreshness = relevantStale ? freshness : { ...freshness, isStale: false }
		return {
			candidate,
			freshness,
			originalIndex: index,
			tier: freshnessTier(effective),
		}
	})

	entries.sort((a, b) => {
		if (a.tier !== b.tier) {
			return a.tier - b.tier
		}
		return a.originalIndex - b.originalIndex
	})

	return entries.map((entry, index) => ({ ...entry.candidate, rank: index }))
}

/**
 * Collect the reindex/freshness-weighting signals for files that changed after
 * indexing (Req 18.4). Each distinct file with a candidate marked
 * `changedAfterIndexing` yields one signal. A file whose change set still
 * contains a stale index entry is recommended for `reindex` (the index is out
 * of date); a file with only current candidates is served by
 * `freshness-weighting` at ranking time.
 *
 * Pure: inputs are never mutated and no I/O is performed.
 *
 * @param candidates The candidates considered during ranking.
 * @param changeInfo Per-candidate freshness state aligned by index.
 * @returns One signal per distinct changed-after-indexing file, in first-seen
 *   order.
 */
export function collectReindexSignals(
	candidates: RankedCandidate[],
	changeInfo: FreshnessChangeInfo,
): FreshnessReindexSignal[] {
	const perCandidate = changeInfo.perCandidate

	const changedFiles: string[] = []
	const changedSeen = new Set<string>()
	const filesWithStale = new Set<string>()

	for (let index = 0; index < candidates.length; index++) {
		const freshness = perCandidate[index] ?? DEFAULT_FRESHNESS
		const file = candidates[index].file
		if (freshness.changedAfterIndexing && !changedSeen.has(file)) {
			changedSeen.add(file)
			changedFiles.push(file)
		}
		if (freshness.isStale) {
			filesWithStale.add(file)
		}
	}

	return changedFiles.map((file) => ({
		file,
		action: filesWithStale.has(file) ? "reindex" : "freshness-weighting",
	}))
}
