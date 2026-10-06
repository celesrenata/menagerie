import { describe, it, expect, vi } from "vitest"
import type { RetrievalGatewayRequest, RetrievalGatewayTransport } from "../retrievalGatewayClient"
import { createRetrievalGatewayClient } from "../retrievalGatewayClient"

/**
 * Example-based tests for the thin `createRetrievalGatewayClient`.
 *
 * The client forwards a request to an injected transport and normalizes the
 * result. It exposes no node/replica selection (Req 8.3), drops malformed
 * evidence items, and never throws to the caller: a rejecting `retrieve`
 * resolves to an empty packet and a rejecting `health` resolves to `false`
 * (Req 8.5).
 *
 * Requirements traced: 8.1, 8.3, 8.5
 */
describe("createRetrievalGatewayClient", () => {
	const wellFormedItem = {
		file: "src/core/task/Task.ts",
		startLine: 10,
		endLine: 42,
		score: 0.91,
		reason: "defines the task lifecycle",
		snippet: "class Task {}",
		fresh: true,
	}

	it("forwards only { query, workspace, intent, limit } with no node/replica field (Req 8.3)", async () => {
		const retrieve = vi.fn().mockResolvedValue({ items: [] })
		const health = vi.fn().mockResolvedValue(true)
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		await client.retrieve("find the lifecycle", "/workspace", "exploration", 8)

		expect(retrieve).toHaveBeenCalledTimes(1)
		const request = retrieve.mock.calls[0][0] as RetrievalGatewayRequest
		// Exactly the four documented fields — no node/replica selection.
		expect(Object.keys(request).sort()).toEqual(["intent", "limit", "query", "workspace"])
		expect(request).toEqual({
			query: "find the lifecycle",
			workspace: "/workspace",
			intent: "exploration",
			limit: 8,
		})
	})

	it("drops malformed items and keeps only the valid ones", async () => {
		const retrieve = vi.fn().mockResolvedValue({
			items: [
				wellFormedItem,
				{ startLine: 1, endLine: 2, score: 0.5 }, // missing file
				{ file: "a.ts", endLine: 2, score: 0.5 }, // missing startLine
				{ file: "b.ts", startLine: 1, score: 0.5 }, // missing endLine
				{ file: "c.ts", startLine: 1, endLine: 2 }, // missing score
				{ file: "d.ts", startLine: "x", endLine: 2, score: 0.5 }, // non-numeric startLine
				null, // not an object
				{ file: "e.ts", startLine: 3, endLine: 7, score: 0.4, reason: "ok" }, // valid
			],
		})
		const health = vi.fn().mockResolvedValue(true)
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		const packet = await client.retrieve("q", "/ws", "exploration", 8)

		expect(packet.query).toBe("q")
		expect(packet.items).toEqual([
			{
				file: "src/core/task/Task.ts",
				startLine: 10,
				endLine: 42,
				score: 0.91,
				reason: "defines the task lifecycle",
				snippet: "class Task {}",
				fresh: true,
			},
			{ file: "e.ts", startLine: 3, endLine: 7, score: 0.4, reason: "ok" },
		])
	})

	it("resolves to an empty packet when the transport retrieve rejects (never throws) (Req 8.5)", async () => {
		const retrieve = vi.fn().mockRejectedValue(new Error("gateway down"))
		const health = vi.fn().mockResolvedValue(true)
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		const packet = await client.retrieve("needle", "/ws", "bootstrap", 5)

		expect(packet).toEqual({ query: "needle", items: [] })
	})

	it("resolves isAvailable to false when the transport health rejects (Req 8.5)", async () => {
		const retrieve = vi.fn().mockResolvedValue({ items: [] })
		const health = vi.fn().mockRejectedValue(new Error("probe failed"))
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		await expect(client.isAvailable()).resolves.toBe(false)
	})

	it("resolves isAvailable to true when the transport health resolves true", async () => {
		const retrieve = vi.fn().mockResolvedValue({ items: [] })
		const health = vi.fn().mockResolvedValue(true)
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		await expect(client.isAvailable()).resolves.toBe(true)
	})

	it("resolves isAvailable to false when health resolves a non-true value", async () => {
		const retrieve = vi.fn().mockResolvedValue({ items: [] })
		const health = vi.fn().mockResolvedValue("ok")
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		await expect(client.isAvailable()).resolves.toBe(false)
	})

	it("returns a proper EvidencePacket with all items on the happy path (Req 8.1)", async () => {
		const secondItem = {
			file: "src/core/exploration/explorationPolicy.ts",
			startLine: 5,
			endLine: 30,
			score: 0.77,
			reason: "the decision core",
		}
		const retrieve = vi.fn().mockResolvedValue({ items: [wellFormedItem, secondItem] })
		const health = vi.fn().mockResolvedValue(true)
		const transport: RetrievalGatewayTransport = { retrieve, health }
		const client = createRetrievalGatewayClient({ transport })

		const packet = await client.retrieve("the decision core", "/ws", "exploration", 8)

		expect(packet.query).toBe("the decision core")
		expect(packet.items).toHaveLength(2)
		expect(packet.items[0]).toEqual({
			file: "src/core/task/Task.ts",
			startLine: 10,
			endLine: 42,
			score: 0.91,
			reason: "defines the task lifecycle",
			snippet: "class Task {}",
			fresh: true,
		})
		expect(packet.items[1]).toEqual(secondItem)
	})
})
