/**
 * Serving-ceiling / pod-memory sizing coupling for the Retrieval Fabric.
 *
 * The per-item serving ceiling is the OOM guard for a local inference server (e.g. OVMS on an
 * iGPU) where one request runs as one GPU batch padded to its longest item. Raising the ceiling
 * lets each padded batch grow, so the pod memory limit MUST grow with it. This module derives the
 * coupled `ServingSizing` (pod memory + preserved request guards) from a chosen ceiling so the
 * committed manifest can be sized together with the ceiling.
 *
 * Invariants (see `ServingSizing` and Property 6):
 * - `podMemoryLimitGi` is a monotonically non-decreasing function of `perItemServingCeilingTokens`.
 * - `maxPaddedTokens` never drops below `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` (16384).
 * - `maxItems` never drops below `MAX_EMBEDDING_REQUEST_ITEMS` (32).
 *
 * This never weakens `DEFAULT_EMBEDDING_REQUEST_LIMITS`, `planEmbeddingRequests`, or the request
 * splitter: it reuses the existing guard constants as hard floors.
 */

import { MAX_EMBEDDING_REQUEST_PADDED_TOKENS, MAX_EMBEDDING_REQUEST_ITEMS } from "../constants/index"

import type { ServingSizing } from "./sizing-types"

/**
 * Base pod memory floor (GiB) that covers the OVMS runtime and model weights independent of the
 * serving ceiling. Mirrors the legacy committed `8Gi` limit.
 */
export const BASE_POD_MEMORY_GI = 8

/**
 * GiB of pod memory added per `MEMORY_SCALING_TOKENS_PER_GI` tokens of serving ceiling. Keeps the
 * ceiling-to-memory coupling explicit and monotonic.
 */
export const MEMORY_SCALING_TOKENS_PER_GI = 4096

/**
 * Derive the coupled {@link ServingSizing} from a chosen per-item serving ceiling.
 *
 * `podMemoryLimitGi` grows monotonically with the ceiling: a non-negative ceiling contributes a
 * non-negative, non-decreasing increment on top of {@link BASE_POD_MEMORY_GI}. The preserved
 * request guards are clamped to their existing floors so they can only ever be raised, never
 * weakened.
 *
 * @param perItemServingCeilingTokens The configurable, measured-safe per-item serving ceiling.
 * @returns The full coupled serving sizing, including the pod memory limit to emit into the manifest.
 */
export function computeServingSizing(perItemServingCeilingTokens: number): ServingSizing {
	// Treat a negative/invalid ceiling as zero so the increment is always non-negative and the
	// function stays monotonically non-decreasing across the whole input domain.
	const safeCeiling = Math.max(0, perItemServingCeilingTokens)

	// Monotonically non-decreasing increment: ceil() of a non-decreasing argument is non-decreasing.
	const memoryIncrementGi = Math.ceil(safeCeiling / MEMORY_SCALING_TOKENS_PER_GI)
	const podMemoryLimitGi = BASE_POD_MEMORY_GI + memoryIncrementGi

	// Preserved guards: never drop below the existing embedding-request floors. The padded-token
	// budget is sized with the ceiling (raised, never lowered); the item cap holds at its floor
	// because the OOM risk the ceiling guards against scales with padded tokens, not item count.
	const maxPaddedTokens = Math.max(MAX_EMBEDDING_REQUEST_PADDED_TOKENS, safeCeiling)
	const maxItems = MAX_EMBEDDING_REQUEST_ITEMS

	return {
		perItemServingCeilingTokens,
		maxPaddedTokens,
		maxItems,
		podMemoryLimitGi,
	}
}
