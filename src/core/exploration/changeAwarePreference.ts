import type { EvidenceItem, EvidencePacket } from "./types"
import type { RetrievalMetricsRecorder } from "./retrievalMetricsRecorder"

/**
 * Inputs to {@link applyChangeAwarePreference}.
 */
export interface ChangeAwarePreferenceInputs {
	/** The gateway-supplied Evidence_Packet being consumed. */
	packet: EvidencePacket
	/**
	 * Files that are currently changed from Menagerie's point of view:
	 * working-tree modifications, parallel worker patches, recently changed
	 * files, and files changed after indexing (Req 12.1).
	 */
	changedFiles: ReadonlySet<string>
}

/**
 * Result of applying the Menagerie-side Change_Aware_Preference ordering.
 */
export interface ChangeAwarePreferenceResult {
	/** Items reordered so a stale item never ranks above a current/changed item. */
	orderedItems: ReadonlyArray<EvidenceItem>
	/** Count of changed files not reflected anywhere in the consumed evidence. */
	freshnessMisses: number
}

/**
 * Classification of a single evidence item relative to freshness and change state.
 * Lower rank sorts first.
 */
const enum FreshnessRank {
	Current = 0,
	Neutral = 1,
	Stale = 2,
}

/**
 * Classify an item into current / neutral / stale per Req 12.2:
 * - `fresh === true` OR file is in `changedFiles` → current.
 * - `fresh === false` AND file NOT in `changedFiles` → stale.
 * - otherwise (`fresh === undefined` and not changed) → neutral.
 *
 * Unknown (neutral) items are placed with the conservative middle rank so they
 * never outrank a known-current item.
 */
function rankItem(item: EvidenceItem, changedFiles: ReadonlySet<string>): FreshnessRank {
	const isChanged = changedFiles.has(item.file)
	if (item.fresh === true || isChanged) {
		return FreshnessRank.Current
	}
	if (item.fresh === false) {
		return FreshnessRank.Stale
	}
	return FreshnessRank.Neutral
}

/**
 * Apply the Menagerie-side Change_Aware_Preference ordering when consuming
 * gateway evidence.
 *
 * The index-freshness mechanism itself (incremental reindex, freshness
 * weighting) is owned by retrieval-fabric; this function applies only the
 * Menagerie-side consumption rule (Req 12.3): it never ranks a stale item above
 * a current/changed item (Req 12.1), honors the gateway-supplied `fresh` signal
 * (Req 12.2), and records an `index-freshness-miss` for every currently-changed
 * file absent from the consumed evidence (Req 12.4).
 *
 * Ordering is a stable partition: current items first, then neutral/unknown
 * items, then stale items, preserving the gateway's original order within each
 * group.
 *
 * @param inputs   The Evidence_Packet and the set of currently-changed files.
 * @param metrics  Per-task recorder used to record `index-freshness-miss` events.
 * @returns        The reordered items and the number of freshness misses.
 */
export function applyChangeAwarePreference(
	inputs: ChangeAwarePreferenceInputs,
	metrics: RetrievalMetricsRecorder,
): ChangeAwarePreferenceResult {
	const { packet, changedFiles } = inputs
	const items = packet.items

	// Stable partition by freshness rank, preserving original order within each
	// group. `Array.prototype.sort` is stable in modern engines; we sort on a
	// precomputed rank so equal ranks keep their relative position.
	const orderedItems = items
		.map((item, index) => ({ item, index, rank: rankItem(item, changedFiles) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item)

	// Record one index-freshness-miss per changed file absent from the packet.
	const filesInPacket = new Set<string>()
	for (const item of items) {
		filesInPacket.add(item.file)
	}

	let freshnessMisses = 0
	for (const file of changedFiles) {
		if (!filesInPacket.has(file)) {
			freshnessMisses++
			metrics.recordIndexFreshnessMiss()
		}
	}

	return { orderedItems, freshnessMisses }
}
