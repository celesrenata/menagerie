import { describe, it, expect, vi } from "vitest"
import { createSemanticExplorationState } from "../semanticExplorationState"
import { createRetrievalMetricsRecorder } from "../retrievalMetricsRecorder"
import { retrieveWithReuse } from "../explorationCoordinator"
import { applyChangeAwarePreference } from "../changeAwarePreference"
import { createRetrievalOutputBudget } from "../retrievalOutputBudget"
import { decide } from "../explorationPolicy"
import type { RetrievalGatewayClient } from "../retrievalGatewayClient"
import type { EvidencePacket, ExplorationPolicyInputs, IndexAvailabilitySnapshot } from "../types"

/**
 * End-to-end metric-wiring integration test.
 *
 * Drives a short exploration sequence through the faked boundaries — a per-task
 * `SemanticExplorationState` (cache + shared memory + metrics), the pure
 * `ExplorationPolicy.decide`, a spied `RetrievalGatewayClient`, the
 * `RetrievalOutputBudget`, and `applyChangeAwarePreference` — and asserts the
 * per-task `snapshot()` reflects every recorded event, including the
 * index-unavailable, gateway-unavailable, and index-freshness-miss counters.
 *
 * Requirements traced: 7.8, 7.9, 7.10, 7.11
 */
describe("metrics wiring — end-to-end", () => {
	/** Index snapshot where every getter is true and the index is not indexing. */
	function availableIndex(): IndexAvailabilitySnapshot {
		return {
			isConfigurationLoaded: true,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
			state: "Indexed",
			available: true,
		}
	}

	/** A spy gateway returning a small packet (3 items) for every query. */
	function createSpyGateway(packet: EvidencePacket): {
		gateway: RetrievalGatewayClient
		retrieve: ReturnType<typeof vi.fn>
	} {
		const retrieve = vi.fn().mockImplementation(
			async (query: string): Promise<EvidencePacket> => ({
				query,
				items: packet.items,
			}),
		)
		const gateway: RetrievalGatewayClient = {
			retrieve,
			isAvailable: vi.fn().mockResolvedValue(true),
		}
		return { gateway, retrieve }
	}

	it("records a full exploration flow and the snapshot reflects every event", async () => {
		// a. Per-task state (cache + shared memory + metrics).
		const state = createSemanticExplorationState()
		const { cache, sharedMemory, metrics } = state

		// b. Spy gateway returning a 3-item packet.
		const packet: EvidencePacket = {
			query: "auth flow",
			items: [
				{ file: "src/auth/login.ts", startLine: 1, endLine: 20, score: 0.9, reason: "login handler", fresh: true },
				{ file: "src/auth/token.ts", startLine: 5, endLine: 30, score: 0.8, reason: "token mint" },
				{ file: "src/auth/session.ts", startLine: 10, endLine: 40, score: 0.7, reason: "session store", fresh: false },
			],
		}
		const { gateway, retrieve } = createSpyGateway(packet)

		// c. PreferSemantic decision — no index/gateway metric should be emitted yet.
		const inputs: ExplorationPolicyInputs = {
			indexAvailability: availableIndex(),
			gatewayAvailable: true,
			knownTarget: { present: false },
			exploringUnseenArea: true,
		}
		const decision = decide(inputs)
		expect(decision.outcome).toBe("PreferSemantic")
		expect(decision.blocks).toBe(false)
		expect(decision.metricEvent).toBeUndefined()

		// d. Dispatch-hook recording of the semantic query + files returned.
		metrics.recordSemanticQuery()
		metrics.recordFilesReturned(3)

		// e. First retrieval hits the gateway (nothing cached yet) and the
		//    coordinator records its own semantic query + files returned.
		const query = "auth flow"
		const first = await retrieveWithReuse(query, "/ws", "exploration", 8, {
			cache,
			sharedMemory,
			metrics,
			gateway,
		})
		expect(first.source).toBe("gateway")
		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(first.findings).toHaveLength(3)

		// Surface compact evidence to the parent (budget boundary, no large chunks).
		const budget = createRetrievalOutputBudget()
		const surfaced = budget.surfaceToParent(packet)
		expect(surfaced).toHaveLength(3)

		// f. First targeted read_file preceded by a useful semantic hit.
		metrics.recordFileOpened()
		metrics.recordRawRead(true)
		metrics.recordUsefulHit()
		metrics.markFirstUsefulEvidence(Date.now())

		// g. Second read_file NOT preceded by a useful hit.
		metrics.recordFileOpened()
		metrics.recordRawRead(false)

		// h. Reuse: the same concept now resolves from the per-task cache and
		//    records a queries-reused event without a second gateway call.
		const second = await retrieveWithReuse(query, "/ws", "exploration", 8, {
			cache,
			sharedMemory,
			metrics,
			gateway,
		})
		expect(second.source).toBe("cache")
		expect(retrieve).toHaveBeenCalledTimes(1)

		// i. Change-aware preference: one currently-changed file absent from the
		//    packet records exactly one index-freshness-miss.
		const changeResult = applyChangeAwarePreference(
			{ packet, changedFiles: new Set(["src/missing.ts"]) },
			metrics,
		)
		expect(changeResult.freshnessMisses).toBe(1)

		// j. Explicit gateway-unavailable + index-unavailable events.
		metrics.recordGatewayUnavailable()
		metrics.recordIndexUnavailable()

		// k. Snapshot reflects every recorded event.
		const snapshot = metrics.snapshot()
		expect(snapshot.semanticQueries).toBeGreaterThanOrEqual(1)
		expect(snapshot.filesReturned).toBeGreaterThanOrEqual(3)
		expect(snapshot.filesOpened).toBe(2)
		expect(snapshot.rawReads).toBe(2)
		expect(snapshot.pctRawReadsPrecededByUsefulHit).toBe(0.5)
		expect(snapshot.semanticHitRate).toBeGreaterThan(0)
		expect(snapshot.semanticHitRate).toBeGreaterThanOrEqual(0)
		expect(snapshot.semanticHitRate).toBeLessThanOrEqual(1)
		expect(snapshot.queriesReused).toBeGreaterThanOrEqual(1)
		expect(snapshot.indexUnavailableEvents).toBe(1)
		expect(snapshot.gatewayUnavailableEvents).toBe(1)
		expect(snapshot.indexFreshnessMisses).toBe(1)
		expect(snapshot.timeToFirstUsefulEvidenceMs).toBeDefined()
	})

	it("reflects index/gateway/freshness events exactly in the snapshot", () => {
		// Minimal recorder-level check: counts map 1:1 into the snapshot (Req 7.8, 7.10).
		const metrics = createRetrievalMetricsRecorder()

		metrics.recordIndexUnavailable()
		metrics.recordIndexUnavailable()
		metrics.recordGatewayUnavailable()
		metrics.recordGatewayUnavailable()
		metrics.recordGatewayUnavailable()
		metrics.recordIndexFreshnessMiss()

		const snapshot = metrics.snapshot()
		expect(snapshot.indexUnavailableEvents).toBe(2)
		expect(snapshot.gatewayUnavailableEvents).toBe(3)
		expect(snapshot.indexFreshnessMisses).toBe(1)
	})
})
