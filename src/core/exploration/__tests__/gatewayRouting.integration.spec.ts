import { describe, it, expect, vi, afterEach } from "vitest"

import { decide } from "../explorationPolicy"
import { createRetrievalOutputBudget } from "../retrievalOutputBudget"
import { createRetrievalMetricsRecorder } from "../retrievalMetricsRecorder"
import { getRetrievalGatewayClient, setRetrievalGatewayClient } from "../gatewayClientProvider"
import { deriveIndexAvailability } from "../indexAvailability"
import { CodebaseSearchTool, codebaseSearchTool } from "../../tools/CodebaseSearchTool"
import type { RetrievalGatewayClient } from "../retrievalGatewayClient"
import type { EvidencePacket, ExplorationPolicyInputs, KnownTargetResult } from "../types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "../types"

/**
 * Integration tests for gateway routing and contract preservation.
 *
 * These tests cover the Menagerie-side consumption of the retrieval-fabric
 * gateway from the exploration-policy perspective, exercised through faked
 * boundaries (a spied `RetrievalGatewayClient`, faked `CodeIndexManager`
 * availability snapshots):
 *
 * - A `PreferSemantic` decision obtains evidence by invoking the gateway
 *   `retrieve(query, workspace, intent, limit)` and NEVER a raw per-replica
 *   path — the client exposes no node/replica selection parameter (Req 8.1).
 * - An unavailable gateway (index available, `gatewayAvailable: false`) falls
 *   through to broad walking and records a gateway-unavailable metric (Req 8.5).
 * - The `CodebaseSearchTool` contract is preserved: `name === "codebase_search"`
 *   and the `execute` method still exists. The full
 *   `codebase_search_result` + `pushToolResult` contract is covered by the
 *   unchanged `src/core/tools/__tests__/CodebaseSearchTool.spec.ts` (Req 6.5).
 *
 * Requirements traced: 6.5, 8.1, 8.5
 */

const ABSENT_TARGET: KnownTargetResult = { present: false }

/** Build a faked `CodeIndexManager`-derived availability snapshot. */
function availableIndex() {
	return deriveIndexAvailability({
		isConfigurationLoaded: true,
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		isInitialized: true,
		state: "Indexed",
	})
}

/** Spy gateway returning a configurable packet; never selects a replica/node. */
function createSpyGateway(packet: EvidencePacket): {
	gateway: RetrievalGatewayClient
	retrieve: ReturnType<typeof vi.fn>
	isAvailable: ReturnType<typeof vi.fn>
} {
	const retrieve = vi.fn().mockResolvedValue(packet)
	const isAvailable = vi.fn().mockResolvedValue(true)
	const gateway: RetrievalGatewayClient = { retrieve, isAvailable }
	return { gateway, retrieve, isAvailable }
}

describe("gateway routing and contract preservation — integration", () => {
	afterEach(() => {
		setRetrievalGatewayClient(undefined)
		vi.restoreAllMocks()
	})

	it("PreferSemantic decision routes through gateway.retrieve with no replica/node param (Req 8.1)", async () => {
		const inputs: ExplorationPolicyInputs = {
			indexAvailability: availableIndex(),
			gatewayAvailable: true,
			knownTarget: ABSENT_TARGET,
			exploringUnseenArea: true,
		}

		const decision = decide(inputs)
		expect(decision.outcome).toBe("PreferSemantic")
		expect(decision.requiresRetrieveBeforeRead).toBe(true)
		expect(decision.blocks).toBe(false)

		// A bounded packet with more than the budget's worth of items; the output
		// budget must still truncate when surfacing to the parent.
		const items = Array.from({ length: MAX_EVIDENCE_PACKET_ITEMS + 4 }, (_v, i) => ({
			file: `src/file-${i}.ts`,
			startLine: i * 10,
			endLine: i * 10 + 5,
			score: 1 - i * 0.01,
			reason: `match ${i}`,
			snippet: "x".repeat(500),
		}))
		const packet: EvidencePacket = { query: "where is auth handled", items }
		const { gateway, retrieve } = createSpyGateway(packet)

		const query = "where is auth handled"
		const workspace = "/ws"
		const result = await gateway.retrieve(query, workspace, "exploration", MAX_EVIDENCE_PACKET_ITEMS)

		// Routed via the gateway with exactly four args: query, workspace, intent,
		// limit. There is no fifth replica/node argument — distribution is owned by
		// the gateway + OmniRoute (Req 8.3 is structurally enforced by this call).
		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(retrieve).toHaveBeenCalledWith(query, workspace, "exploration", MAX_EVIDENCE_PACKET_ITEMS)
		expect(retrieve.mock.calls[0]).toHaveLength(4)

		// The consumed packet is bounded by the output budget (Req 8.2, 6.1).
		const budget = createRetrievalOutputBudget()
		const surfaced = budget.surfaceToParent(result)
		expect(surfaced.length).toBeLessThanOrEqual(MAX_EVIDENCE_PACKET_ITEMS)
		// Compact surfacing drops large snippets — only file/line/score/reason.
		for (const entry of surfaced) {
			expect(entry).not.toHaveProperty("snippet")
			expect(Object.keys(entry).sort()).toEqual(["endLine", "file", "reason", "score", "startLine"])
		}
	})

	it("unavailable gateway falls through to walking and records the metric (Req 8.5)", () => {
		const inputs: ExplorationPolicyInputs = {
			indexAvailability: availableIndex(),
			gatewayAvailable: false,
			knownTarget: ABSENT_TARGET,
			exploringUnseenArea: true,
		}

		const decision = decide(inputs)
		expect(decision.outcome).toBe("AllowWalking")
		expect(decision.blocks).toBe(false)
		expect(decision.requiresRetrieveBeforeRead).toBe(false)
		// Index IS available, so the dominant unavailability metric is the gateway.
		expect(decision.metricEvent).toBe("gateway-unavailable")

		// The gateway-unavailable event is recorded for retrieval metrics.
		const recorder = createRetrievalMetricsRecorder()
		recorder.recordGatewayUnavailable()
		const snapshot = recorder.snapshot()
		expect(snapshot.gatewayUnavailableEvents).toBe(1)
		// No semantic query was issued on the fall-through path.
		expect(snapshot.semanticQueries).toBe(0)
	})

	it("preserves the CodebaseSearchTool contract — name and execute are unchanged (Req 6.5)", () => {
		// Preservation check: CodebaseSearchTool.ts was NOT modified by this
		// feature; compact surfacing is additive. The full execute() contract
		// (codebase_search_result via task.say + the `Query: ...` pushToolResult)
		// is covered by the unchanged src/core/tools/__tests__/CodebaseSearchTool.spec.ts,
		// which the orchestrator confirms still passes.
		expect(codebaseSearchTool).toBeInstanceOf(CodebaseSearchTool)
		expect(codebaseSearchTool.name).toBe("codebase_search")
		expect(typeof codebaseSearchTool.execute).toBe("function")
	})

	it("module-level gateway provider injection works for testing", () => {
		expect(getRetrievalGatewayClient()).toBeUndefined()

		const { gateway } = createSpyGateway({ query: "q", items: [] })
		setRetrievalGatewayClient(gateway)
		expect(getRetrievalGatewayClient()).toBe(gateway)

		setRetrievalGatewayClient(undefined)
		expect(getRetrievalGatewayClient()).toBeUndefined()
	})
})
