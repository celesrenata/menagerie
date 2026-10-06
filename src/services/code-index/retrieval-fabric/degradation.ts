// Feature: retrieval-fabric
//
// Graceful degradation across every `CodeIndexManager` availability state.
//
// When the Retrieval Fabric or logical Retrieval Gateway is unavailable,
// Menagerie keeps working: retrieval still returns a result (marked
// `degraded: true`) served from whatever the existing code-index service and
// direct reads can provide, rather than throwing (Req 22.7, 22.8). This holds
// for ANY availability state the `CodeIndexManager` can be in: not configured,
// disabled, not initialized, Indexing, or Indexed.
//
// This module is pure and side-effect free. It does NOT walk the filesystem,
// embed, or call the fabric; the caller supplies whatever fallback candidates
// it was able to gather (possibly none) and this function shapes them into a
// bounded, `degraded` evidence packet. It deliberately does NOT reimplement the
// Menagerie-side exploration policy owned by `semantic-first-retrieval` — it
// only guarantees the fabric-unavailable path returns a packet instead of
// throwing.

import type { RankedCandidate, EvidencePacket } from "./types"
import { toEvidencePacket } from "./evidence-packet"

/**
 * The `CodeIndexManager` availability states relevant to degradation.
 *
 * These collapse the manager's `isFeatureConfigured` / `isFeatureEnabled` /
 * `isInitialized` flags and its `IndexingState` into the five availability
 * cases the design enumerates (Req 22.7):
 *
 * - `not-configured`  — the feature has no valid configuration.
 * - `disabled`        — configured but the feature is turned off.
 * - `not-initialized` — enabled and configured but services are not up yet.
 * - `indexing`        — an index build/update is in progress.
 * - `indexed`         — an index is present and ready to serve.
 */
export type CodeIndexAvailabilityState = "not-configured" | "disabled" | "not-initialized" | "indexing" | "indexed"

/**
 * All {@link CodeIndexAvailabilityState} values, for exhaustive iteration in
 * tests and for callers that need to enumerate the states.
 */
export const CODE_INDEX_AVAILABILITY_STATES: readonly CodeIndexAvailabilityState[] = [
	"not-configured",
	"disabled",
	"not-initialized",
	"indexing",
	"indexed",
] as const

/**
 * Build a degraded {@link EvidencePacket} for a fabric/gateway-unavailable
 * retrieval, for ANY {@link CodeIndexAvailabilityState}.
 *
 * This never throws. Whatever fallback candidates the caller managed to gather
 * (from the existing code index or direct reads) are bounded into the normal
 * evidence-packet shape and the packet is marked `degraded: true` (Req 22.7,
 * 22.8). When no fallback candidates are available the packet is simply empty
 * and still `degraded` — an empty-but-degraded result is a valid outcome, not
 * an error.
 *
 * The `state` parameter is accepted so this function is total over every
 * availability state (and so property tests can assert no state throws); the
 * returned packet is `degraded` regardless of state because the distinguishing
 * fact is that the fabric/gateway is unavailable, not which state the manager
 * is in. Shaping/bounding and ordering are delegated to
 * {@link toEvidencePacket}, keeping this module pure and deterministic.
 *
 * @param state Current manager availability state (any value is handled).
 * @param fallbackItems Candidates gathered from existing code indexing and/or
 *   direct reads; may be empty.
 * @returns A bounded packet with `degraded: true`.
 */
export function handleUnavailable(
	state: CodeIndexAvailabilityState,
	fallbackItems: readonly RankedCandidate[] = [],
): EvidencePacket {
	// `state` does not change the degraded contract: every availability state
	// yields a bounded, degraded packet rather than a throw. It is referenced
	// here so callers can branch on it in the future without changing this
	// surface, and so the function is explicitly total over the state union.
	void state
	return toEvidencePacket([...fallbackItems], true)
}

/**
 * Convenience wrapper returning an empty degraded {@link EvidencePacket} for a
 * given availability state, when the caller has no fallback candidates to
 * supply. Equivalent to calling {@link handleUnavailable} with no items.
 *
 * @param state Current manager availability state (any value is handled).
 * @returns An empty packet with `degraded: true`; never throws.
 */
export function degradedResult(state: CodeIndexAvailabilityState): EvidencePacket {
	return handleUnavailable(state, [])
}
