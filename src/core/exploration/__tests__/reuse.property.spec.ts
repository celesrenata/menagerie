// Feature: semantic-first-retrieval, Property 4: A concept already in the cache or shared memory reuses prior findings instead of a new retrieve

import fc from "fast-check"
import { describe, it, expect, vi } from "vitest"

import { retrieveWithReuse } from "../explorationCoordinator"
import { createSemanticExplorationState } from "../semanticExplorationState"
import type { RetrievalGatewayClient } from "../retrievalGatewayClient"
import type { EvidencePacket, SemanticFinding } from "../types"
import { queryArb, semanticFindingsArb } from "./arbitraries"

/**
 * Build a gateway whose `retrieve` is a spy so the test can assert it is NEVER
 * invoked on a cache / shared-memory reuse. `retrieve` would resolve to an
 * empty packet if (incorrectly) called, which keeps the spy's return type
 * valid without masking a wrongful invocation.
 */
function makeSpiedGateway(): { gateway: RetrievalGatewayClient; retrieveSpy: ReturnType<typeof vi.fn> } {
	const retrieveSpy = vi.fn(
		async (query: string): Promise<EvidencePacket> => ({ query, items: [] }),
	)
	const gateway: RetrievalGatewayClient = {
		retrieve: retrieveSpy,
		isAvailable: async () => true,
	}
	return { gateway, retrieveSpy }
}

/**
 * Re-key the generated findings so each finding's own `query` field equals the
 * query under test. Shared memory keys by each finding's `query`, so this
 * guarantees the shared-memory lookup hits; the cache stores under `query`
 * directly, so the same shaped findings serve both branches.
 */
function withQuery(query: string, findings: ReadonlyArray<SemanticFinding>): ReadonlyArray<SemanticFinding> {
	return findings.map((finding) => ({ ...finding, query }))
}

describe("retrieveWithReuse — Property 4", () => {
	// Validates: Requirements 5.1, 5.2, 5.4, 11.1, 11.3, 11.4
	it("reuses cached findings without a new retrieve and records queries-reused", async () => {
		await fc.assert(
			fc.asyncProperty(queryArb, semanticFindingsArb, async (query, rawFindings) => {
				const findings = withQuery(query, rawFindings)
				const state = createSemanticExplorationState()
				const { gateway, retrieveSpy } = makeSpiedGateway()

				// Pre-populate the per-task cache for this concept.
				state.cache.store(query, findings)

				const result = await retrieveWithReuse(query, "/ws", "exploration", 8, {
					cache: state.cache,
					sharedMemory: state.sharedMemory,
					metrics: state.metrics,
					gateway,
				})

				expect(result.source).toBe("cache")
				expect(result.findings).toEqual(findings)
				expect(retrieveSpy).not.toHaveBeenCalled()
				expect(state.metrics.snapshot().queriesReused).toBe(1)
			}),
			{ numRuns: 150 },
		)
	})

	// Validates: Requirements 5.1, 5.2, 5.4, 11.1, 11.3, 11.4
	it("reuses shared-memory findings without a new retrieve and records queries-reused", async () => {
		await fc.assert(
			fc.asyncProperty(queryArb, semanticFindingsArb, async (query, rawFindings) => {
				const findings = withQuery(query, rawFindings)
				const state = createSemanticExplorationState()
				const { gateway, retrieveSpy } = makeSpiedGateway()

				// Publish into cross-worker shared memory; findings carry `query`.
				state.sharedMemory.publish(findings)

				const result = await retrieveWithReuse(query, "/ws", "exploration", 8, {
					cache: state.cache,
					sharedMemory: state.sharedMemory,
					metrics: state.metrics,
					gateway,
				})

				expect(result.source).toBe("shared_memory")
				// Shared memory stores defensive plain copies carrying only
				// SemanticFinding fields (Req 11.3), so compare by value.
				expect(result.findings).toEqual(findings)
				expect(retrieveSpy).not.toHaveBeenCalled()
				expect(state.metrics.snapshot().queriesReused).toBe(1)
			}),
			{ numRuns: 150 },
		)
	})
})
