// Feature: retrieval-fabric
//
// Matryoshka ↔ Qdrant dimension coupling for the Retrieval Gateway.
//
// A `DimensionConfig` is accepted iff the stored embedding dimension (reported
// by `getModelDimension` in `src/shared/embeddingModels.ts`) equals the Qdrant
// collection's configured vector dimension. Otherwise it is rejected as a
// dimension mismatch — exactly as `vector-store-factory.ts` / `QdrantVectorStore`
// enforce when a collection exists at a different vector size (Req 16.4, 16.6).
//
// When the stored Matryoshka dimension changes, the existing `qdrant` instance
// (`qdrant-0` in `omniroute-memory`) must be reindexed to the new dimension
// (Req 16.5). This module exposes a pure helper that signals that requirement
// without performing any I/O, so it is safe to call from the `retrieve()`
// pipeline and from property tests.

import { getModelDimension } from "../../../shared/embeddingModels"
import type { EmbedderProvider } from "@roo-code/types"

import type { DimensionConfig } from "./sizing-types"

/**
 * Qdrant instance that holds the Retrieval Fabric collection and must be
 * reindexed on a Matryoshka dimension change (Req 16.5).
 */
export const QDRANT_INSTANCE = "qdrant-0" as const

/**
 * Result of validating a {@link DimensionConfig}.
 *
 * `accepted` is `true` iff the stored embedding dimension equals the Qdrant
 * collection dimension. When rejected, `mismatch` is `true` and `reason`
 * explains the rejection. `requiresReindex` is `true` whenever the two
 * dimensions differ, signalling that `qdrant-0` must be reindexed to the new
 * stored dimension before the configuration can be accepted (Req 16.4-16.6).
 */
export interface DimensionValidation {
	/** True iff `storedDimension === qdrantCollectionDimension`. */
	accepted: boolean
	/** True when the configuration was rejected as a dimension mismatch. */
	mismatch: boolean
	/** True when `qdrant-0` must be reindexed to reconcile the dimensions. */
	requiresReindex: boolean
	/** Human-readable explanation when rejected; omitted when accepted. */
	reason?: string
}

/**
 * Validate a {@link DimensionConfig} against the Matryoshka ↔ Qdrant coupling.
 *
 * Accepts the configuration iff the stored embedding dimension equals the
 * Qdrant collection vector dimension. Any difference is rejected as a dimension
 * mismatch — mirroring `vector-store-factory.ts` / `QdrantVectorStore`, which
 * refuse to serve a collection whose vector size differs from the stored
 * embedding dimension — and flags that `qdrant-0` requires reindexing to the
 * new dimension (Req 16.4, 16.5, 16.6). Pure and deterministic.
 *
 * @param config The stored vs. collection dimension pair to validate.
 * @returns The validation outcome.
 */
export function validateDimensionConfig(config: DimensionConfig): DimensionValidation {
	const { storedDimension, qdrantCollectionDimension } = config

	if (storedDimension === qdrantCollectionDimension) {
		return { accepted: true, mismatch: false, requiresReindex: false }
	}

	return {
		accepted: false,
		mismatch: true,
		requiresReindex: true,
		reason:
			`Stored embedding dimension (${storedDimension}) does not match the ` +
			`Qdrant collection vector dimension (${qdrantCollectionDimension}). ` +
			`Reindex ${QDRANT_INSTANCE} to ${storedDimension} to reconcile.`,
	}
}

/**
 * Resolve a {@link DimensionConfig} from the configured embedder and the
 * current Qdrant collection dimension, using `getModelDimension` as the
 * source-of-truth stored dimension (Req 16.4). Mirrors how
 * `vector-store-factory.ts` resolves the stored vector size.
 *
 * @param provider The embedder provider.
 * @param modelId The embedding model ID.
 * @param qdrantCollectionDimension The Qdrant collection's configured vector dimension.
 * @returns A `DimensionConfig`, or `undefined` when the stored dimension cannot
 *   be determined for the given provider/model (the same unresolvable case
 *   `vector-store-factory.ts` rejects).
 */
export function resolveDimensionConfig(
	provider: EmbedderProvider,
	modelId: string,
	qdrantCollectionDimension: number,
): DimensionConfig | undefined {
	const storedDimension = getModelDimension(provider, modelId)
	if (storedDimension === undefined || storedDimension <= 0) {
		return undefined
	}
	return { storedDimension, qdrantCollectionDimension }
}

/**
 * Whether moving from a current stored Matryoshka dimension to a new one
 * requires reindexing `qdrant-0` (Req 16.5). Any change of the stored dimension
 * requires a reindex; an unchanged dimension does not.
 *
 * @param currentStoredDimension The dimension the collection was indexed at.
 * @param newStoredDimension The newly selected Matryoshka dimension.
 * @returns `true` when `qdrant-0` must be reindexed to `newStoredDimension`.
 */
export function dimensionChangeRequiresReindex(
	currentStoredDimension: number,
	newStoredDimension: number,
): boolean {
	return currentStoredDimension !== newStoredDimension
}
