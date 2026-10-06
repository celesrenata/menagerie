import type { EvidenceItem, EvidencePacket, SurfacedEvidence } from "./types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "./types"

/**
 * Enforces the retrieval output budget when consuming an {@link EvidencePacket}.
 *
 * `surfaceToParent` yields a compact ranked list (file, line range, score, and a
 * one-line reason only) bounded to {@link MAX_EVIDENCE_PACKET_ITEMS}; the parent
 * context never receives large code chunks or the full candidate set.
 * `retainWorkerLocal` keeps the full items (including any `snippet`) in a
 * per-instance worker-local store that is never surfaced to the parent.
 *
 * Requirements traced: 6.1, 6.2, 6.3, 6.4, 8.2, 10.2
 */
export interface RetrievalOutputBudget {
	/** Compact ranked list for the parent context: file, line range, score, one-line reason (Req 6.1, 6.2, 8.2, 10.2). */
	surfaceToParent(packet: EvidencePacket): ReadonlyArray<SurfacedEvidence>

	/** Retain full items (incl. snippets) worker-local, never surfaced to the parent (Req 6.3, 6.4). */
	retainWorkerLocal(packet: EvidencePacket): void
}

/**
 * Default one-line reason used when an item has no usable `reason`.
 */
const DEFAULT_REASON = "semantic match"

/**
 * Collapse any whitespace (including newlines) to single spaces and trim, so a
 * surfaced reason is always a single line. Falls back to {@link DEFAULT_REASON}
 * when the input is empty or whitespace-only.
 */
function toOneLineReason(reason: string | undefined): string {
	const collapsed = (reason ?? "").replace(/\s+/g, " ").trim()
	return collapsed === "" ? DEFAULT_REASON : collapsed
}

/**
 * Normalize a query so the same concept maps to the same worker-local key
 * regardless of surrounding or internal whitespace or case.
 */
function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Defensively copy an {@link EvidenceItem}, preserving all fields including the
 * optional `snippet` and `fresh` flags, so the worker-local store is insulated
 * from later mutation of the source packet.
 */
function toPlainItem(item: EvidenceItem): EvidenceItem {
	const copy: EvidenceItem = {
		file: item.file,
		startLine: item.startLine,
		endLine: item.endLine,
		score: item.score,
		reason: item.reason,
	}
	if (item.snippet !== undefined) {
		copy.snippet = item.snippet
	}
	if (item.fresh !== undefined) {
		copy.fresh = item.fresh
	}
	return copy
}

/**
 * Create a {@link RetrievalOutputBudget}. The worker-local store lives in this
 * closure, so each call produces an independently scoped instance.
 *
 * Requirements traced: 6.1, 6.2, 6.3, 6.4, 8.2, 10.2
 */
export function createRetrievalOutputBudget(): RetrievalOutputBudget {
	// Worker-local store of full items keyed by normalized query. Never surfaced
	// to the parent context (Req 6.3).
	const workerLocal = new Map<string, EvidenceItem[]>()

	return {
		surfaceToParent(packet: EvidencePacket): ReadonlyArray<SurfacedEvidence> {
			if (packet === null || packet === undefined || packet.items === null || packet.items === undefined) {
				return []
			}

			// Truncate to the bound (Req 8.2) and project to compact fields only;
			// snippets and any large chunk are intentionally dropped (Req 6.2).
			return packet.items.slice(0, MAX_EVIDENCE_PACKET_ITEMS).map(
				(item): SurfacedEvidence => ({
					file: item.file,
					startLine: item.startLine,
					endLine: item.endLine,
					score: item.score,
					reason: toOneLineReason(item.reason),
				}),
			)
		},

		retainWorkerLocal(packet: EvidencePacket): void {
			if (packet === null || packet === undefined || packet.items === null || packet.items === undefined) {
				return
			}
			workerLocal.set(
				normalizeQuery(packet.query),
				packet.items.map(toPlainItem),
			)
		},
	}
}
