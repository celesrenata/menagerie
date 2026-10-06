import fc from "fast-check"
import type { IndexingState } from "../../../services/code-index/interfaces/manager"
import type {
	IndexAvailabilitySnapshot,
	KnownTargetResult,
	ExplorationPolicyInputs,
	EvidenceItem,
	EvidencePacket,
	SemanticFinding,
} from "../types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "../types"

// ---------------------------------------------------------------------------
// IndexingState
// ---------------------------------------------------------------------------

const indexingStates: readonly IndexingState[] = ["Standby", "Indexing", "Indexed", "Error", "Stopping"] as const

export const indexingStateArb: fc.Arbitrary<IndexingState> = fc.constantFrom(...indexingStates)

// ---------------------------------------------------------------------------
// IndexAvailabilitySnapshot
// ---------------------------------------------------------------------------

/**
 * Generates an `IndexAvailabilitySnapshot` with `available` derived consistently:
 * all four getters true AND state !== "Indexing".
 */
export const indexAvailabilitySnapshotArb: fc.Arbitrary<IndexAvailabilitySnapshot> = fc
	.record({
		isConfigurationLoaded: fc.boolean(),
		isFeatureEnabled: fc.boolean(),
		isFeatureConfigured: fc.boolean(),
		isInitialized: fc.boolean(),
		state: indexingStateArb,
	})
	.map(({ isConfigurationLoaded, isFeatureEnabled, isFeatureConfigured, isInitialized, state }) => {
		const available =
			isConfigurationLoaded && isFeatureEnabled && isFeatureConfigured && isInitialized && state !== "Indexing"
		return {
			isConfigurationLoaded,
			isFeatureEnabled,
			isFeatureConfigured,
			isInitialized,
			state,
			get available() {
				return available
			},
		}
	})

// ---------------------------------------------------------------------------
// KnownTargetResult
// ---------------------------------------------------------------------------

const knownTargetSources = ["user_instruction", "diagnostic", "worker_held"] as const

/**
 * Generates a `KnownTargetResult`:
 * - ~50 % absent `{ present: false }`
 * - ~50 % present with one of the three sources, a path, and an optional line.
 */
export const knownTargetResultArb: fc.Arbitrary<KnownTargetResult> = fc.oneof(
	// Absent case
	fc.constant<KnownTargetResult>({ present: false }),
	// Present case — each of the three sources
	fc
		.record({
			source: fc.constantFrom(...knownTargetSources),
			path: fc.stringMatching(/^[a-zA-Z0-9_/.\\-]{1,120}$/),
			line: fc.option(fc.nat({ max: 50_000 }), { nil: undefined }),
		})
		.map(({ source, path, line }) => ({ present: true, path, line, source })),
)

// ---------------------------------------------------------------------------
// ExplorationPolicyInputs
// ---------------------------------------------------------------------------

/**
 * Composes `IndexAvailabilitySnapshot`, `KnownTargetResult`, plus arbitrary booleans for
 * `gatewayAvailable` and `exploringUnseenArea`.
 */
export const explorationPolicyInputsArb: fc.Arbitrary<ExplorationPolicyInputs> = fc.record({
	indexAvailability: indexAvailabilitySnapshotArb,
	gatewayAvailable: fc.boolean(),
	knownTarget: knownTargetResultArb,
	exploringUnseenArea: fc.boolean(),
})

// ---------------------------------------------------------------------------
// EvidenceItem / EvidencePacket
// ---------------------------------------------------------------------------

/** A single `EvidenceItem` with arbitrary scores, paths, and optional fresh flag. */
export const evidenceItemArb: fc.Arbitrary<EvidenceItem> = fc.record({
	file: fc.stringMatching(/^[a-zA-Z0-9_/.\\-]{1,120}$/),
	startLine: fc.nat({ max: 10_000 }),
	endLine: fc.nat({ max: 10_000 }),
	score: fc.double({ min: 0, max: 1, noNaN: true }),
	reason: fc.string({ minLength: 1, maxLength: 200 }),
	snippet: fc.option(fc.string({ minLength: 0, maxLength: 500 }), { nil: undefined }),
	fresh: fc.option(fc.boolean(), { nil: undefined }),
})

/**
 * Generates an `EvidencePacket` with 0 to ~20 items to exercise truncation past
 * `MAX_EVIDENCE_PACKET_ITEMS` (8).
 */
export const evidencePacketArb: fc.Arbitrary<EvidencePacket> = fc.record({
	query: fc.string({ minLength: 1, maxLength: 200 }),
	items: fc.array(evidenceItemArb, { minLength: 0, maxLength: 20 }),
})

/**
 * Generates an `EvidencePacket` that always exceeds the max bound,
 * useful for testing truncation specifically.
 */
export const overBoundEvidencePacketArb: fc.Arbitrary<EvidencePacket> = fc.record({
	query: fc.string({ minLength: 1, maxLength: 200 }),
	items: fc.array(evidenceItemArb, {
		minLength: MAX_EVIDENCE_PACKET_ITEMS + 1,
		maxLength: 20,
	}),
})

// ---------------------------------------------------------------------------
// Query / SemanticFinding seeds
// ---------------------------------------------------------------------------

/** Normalized query strings: non-empty, trimmed, lowercased, no leading/trailing whitespace. */
export const queryArb: fc.Arbitrary<string> = fc
	.stringMatching(/^[a-z0-9][a-z0-9 ._/-]{0,99}$/)
	.map((s) => s.trim().toLowerCase())
	.filter((s) => s.length > 0)

/** A single `SemanticFinding`. */
export const semanticFindingArb: fc.Arbitrary<SemanticFinding> = fc.record({
	query: queryArb,
	file: fc.stringMatching(/^[a-zA-Z0-9_/.\\-]{1,120}$/),
	startLine: fc.nat({ max: 10_000 }),
	endLine: fc.nat({ max: 10_000 }),
	score: fc.double({ min: 0, max: 1, noNaN: true }),
})

/** An array of `SemanticFinding` entries (1-15 items). */
export const semanticFindingsArb: fc.Arbitrary<ReadonlyArray<SemanticFinding>> = fc.array(semanticFindingArb, {
	minLength: 1,
	maxLength: 15,
})
