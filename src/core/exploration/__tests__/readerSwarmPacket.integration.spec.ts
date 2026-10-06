import { describe, it, expect, vi } from "vitest"
import type { ReaderScope } from "../readerSwarmPacket"
import { deliverReaderSwarmPackets } from "../readerSwarmPacket"
import type { RetrievalGatewayClient } from "../retrievalGatewayClient"
import type { EvidencePacket } from "../types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "../types"

/**
 * Integration tests for `deliverReaderSwarmPackets`.
 *
 * These tests verify that each reader scope receives exactly one bounded
 * Evidence_Packet via the retrieval gateway with the `reader_scope` intent
 * before that reader begins targeted investigation (Reqs 10.1, 10.2, 10.3).
 *
 * Swarm SCHEDULING is owned by the elastic-parallel-execution spec and is NOT
 * exercised here (Req 10.4). This test module covers only packet delivery.
 *
 * Requirements traced: 10.1, 10.2, 10.3
 */
describe("deliverReaderSwarmPackets — integration", () => {
	const scopes: ReadonlyArray<ReaderScope> = [
		{ name: "deployment", query: "deployment configuration", workspace: "/ws" },
		{ name: "authentication", query: "auth flows", workspace: "/ws" },
		{ name: "frontend", query: "React components", workspace: "/ws" },
		{ name: "tests", query: "test utilities", workspace: "/ws" },
	]

	function createSpyGateway(): {
		gateway: RetrievalGatewayClient
		retrieve: ReturnType<typeof vi.fn>
	} {
		const retrieve = vi.fn().mockImplementation(
			async (query: string): Promise<EvidencePacket> => ({
				query,
				items: [],
			}),
		)
		const gateway: RetrievalGatewayClient = {
			retrieve,
			isAvailable: vi.fn().mockResolvedValue(true),
		}
		return { gateway, retrieve }
	}

	it("each scope receives exactly one bounded packet before investigation (Req 10.1, 10.2)", async () => {
		const { gateway, retrieve } = createSpyGateway()

		const results = await deliverReaderSwarmPackets(scopes, gateway)

		// retrieve called exactly scopes.length times — one per scope.
		expect(retrieve).toHaveBeenCalledTimes(scopes.length)

		// Each call used intent "reader_scope" (3rd arg).
		for (let i = 0; i < scopes.length; i++) {
			expect(retrieve.mock.calls[i][2]).toBe("reader_scope")
		}

		// Each scope's query and workspace were forwarded.
		for (let i = 0; i < scopes.length; i++) {
			const [query, workspace] = retrieve.mock.calls[i] as [string, string, string, number]
			expect(query).toBe(scopes[i].query)
			expect(workspace).toBe(scopes[i].workspace)
		}

		// Result array has one { scope, packet } per scope, preserving input order.
		expect(results).toHaveLength(scopes.length)
		for (let i = 0; i < scopes.length; i++) {
			expect(results[i].scope).toBe(scopes[i])
			expect(results[i].packet).toEqual({ query: scopes[i].query, items: [] })
		}
	})

	it("passes default MAX_EVIDENCE_PACKET_ITEMS limit when none provided (Req 10.2)", async () => {
		const { gateway, retrieve } = createSpyGateway()

		await deliverReaderSwarmPackets(scopes, gateway)

		// 4th arg (limit) equals MAX_EVIDENCE_PACKET_ITEMS when not explicitly provided.
		for (const call of retrieve.mock.calls) {
			expect(call[3]).toBe(MAX_EVIDENCE_PACKET_ITEMS)
		}
	})

	it("forwards a custom limit when provided", async () => {
		const { gateway, retrieve } = createSpyGateway()
		const customLimit = 3

		await deliverReaderSwarmPackets(scopes, gateway, customLimit)

		for (const call of retrieve.mock.calls) {
			expect(call[3]).toBe(customLimit)
		}
	})

	it("gateway unavailable per scope surfaces as empty packet (Req 10.3)", async () => {
		// Simulate a scope where the gateway returns an empty packet (as it
		// does on failure — the real gateway client never throws).
		const retrieve = vi.fn().mockImplementation(
			async (query: string): Promise<EvidencePacket> => ({
				query,
				items: [],
			}),
		)
		const gateway: RetrievalGatewayClient = {
			retrieve,
			isAvailable: vi.fn().mockResolvedValue(false),
		}

		const results = await deliverReaderSwarmPackets(scopes, gateway)

		// Every scope still has an entry with items: [].
		expect(results).toHaveLength(scopes.length)
		for (let i = 0; i < scopes.length; i++) {
			expect(results[i].scope).toBe(scopes[i])
			expect(results[i].packet.items).toEqual([])
		}
	})

	// Scheduling is NOT exercised here. Per Req 10.4, swarm scheduling is owned
	// by the elastic-parallel-execution spec; this module only tests that each
	// scope receives a bounded packet via the gateway.
})
