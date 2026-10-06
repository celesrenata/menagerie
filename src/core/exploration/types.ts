import type { IndexingState } from "../../services/code-index/interfaces/manager"

/**
 * Maximum number of items in an Evidence_Packet surfaced from the retrieval gateway.
 */
export const MAX_EVIDENCE_PACKET_ITEMS = 8

/**
 * Availability snapshot captured once per decision from CodeIndexManager.
 * `available` is derived: all four getters true && state !== "Indexing".
 */
export interface IndexAvailabilitySnapshot {
	isConfigurationLoaded: boolean
	isFeatureEnabled: boolean
	isFeatureConfigured: boolean
	isInitialized: boolean
	state: IndexingState
	readonly available: boolean
}

/**
 * Result of known-target detection. When `present` is true a direct read is
 * permitted without a prior retrieve.
 */
export interface KnownTargetResult {
	present: boolean
	path?: string
	line?: number
	source?: "user_instruction" | "diagnostic" | "worker_held"
}

/**
 * Inputs to the known-target detector.
 */
export interface KnownTargetInputs {
	userInstruction?: string
	diagnostics?: ReadonlyArray<{ message: string }>
	workerHeldPath?: string
}

/**
 * Pure inputs to ExplorationPolicy.decide.
 */
export interface ExplorationPolicyInputs {
	indexAvailability: IndexAvailabilitySnapshot
	gatewayAvailable: boolean
	knownTarget: KnownTargetResult
	exploringUnseenArea: boolean
}

export type ExplorationOutcome = "PreferSemantic" | "KnownTarget" | "AllowWalking"

/**
 * Advisory decision produced by the ExplorationPolicy. `blocks` is invariantly
 * false: the policy never blocks a tool call.
 */
export interface ExplorationDecision {
	outcome: ExplorationOutcome
	readonly blocks: false
	requiresRetrieveBeforeRead: boolean
	metricEvent?: "index-unavailable" | "gateway-unavailable" | "queries-reused"
}

/**
 * Preferred next exploration affordance and ordered tool preference.
 */
export interface ExplorationAffordance {
	preferredNext: "semantic_retrieval" | "known_target_read" | "broad_walking"
	ordered: ReadonlyArray<"semantic_retrieval" | "read_file" | "list_files" | "search_files">
}

/**
 * A single semantic finding stored in the per-task cache / shared memory.
 */
export interface SemanticFinding {
	query: string
	file: string
	startLine: number
	endLine: number
	score: number
}

export type RetrievalIntent = "exploration" | "bootstrap" | "reader_scope"

/**
 * One item in a reranked Evidence_Packet returned by the retrieval gateway.
 */
export interface EvidenceItem {
	file: string
	startLine: number
	endLine: number
	score: number
	reason: string
	snippet?: string
	fresh?: boolean
}

/**
 * Bounded reranked Evidence_Packet (~5-8 items) for a single query.
 */
export interface EvidencePacket {
	query: string
	items: ReadonlyArray<EvidenceItem>
}

/**
 * Compact ranked evidence surfaced to the parent context.
 */
export interface SurfacedEvidence {
	file: string
	startLine: number
	endLine: number
	score: number
	reason: string
}

/**
 * Snapshot of retrieval metrics for a task.
 */
export interface RetrievalMetrics {
	semanticQueries: number
	semanticHitRate: number
	filesReturned: number
	filesOpened: number
	rawReads: number
	tokensFromReads: number
	queriesReused: number
	indexUnavailableEvents: number
	gatewayUnavailableEvents: number
	pctRawReadsPrecededByUsefulHit: number
	indexFreshnessMisses: number
	timeToFirstUsefulEvidenceMs?: number
}
