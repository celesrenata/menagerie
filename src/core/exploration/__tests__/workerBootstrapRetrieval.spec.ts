import { describe, it, expect, vi } from "vitest"
import type { EvidencePacket, KnownTargetResult } from "../types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "../types"
import type { RetrievalGatewayClient } from "../retrievalGatewayClient"
import type { WorkerBootstrapInputs } from "../workerBootstrapRetrieval"
import { bootstrapWorkerRetrieval } from "../workerBootstrapRetrieval"

/**
 * Example-based tests for {@link bootstrapWorkerRetrieval} gating.
 *
 * Bootstrap occurs iff `enabled && (reader || reasoner) && !knownTarget.present`.
 * When gated true exactly one gateway `retrieve()` is issued with the
 * `bootstrap` intent and the bounded packet is returned; otherwise the function
 * skips (no `retrieve()`) and returns `undefined`.
 *
 * Requirements traced: 9.1, 9.3, 9.4
 */
describe("bootstrapWorkerRetrieval", () => {
	const description = "investigate the ingress deployment path"
	const workspace = "/workspace"

	const makeGateway = (packet: EvidencePacket) => {
		const retrieve = vi.fn().mockResolvedValue(packet)
		const isAvailable = vi.fn().mockResolvedValue(true)
		const gateway: RetrievalGatewayClient = { retrieve, isAvailable }
		return { gateway, retrieve, isAvailable }
	}

	const absentTarget: KnownTargetResult = { present: false }

	it("gated true (reader) issues exactly one retrieve and returns the packet (Req 9.1)", async () => {
		const packet: EvidencePacket = { query: description, items: [] }
		const { gateway, retrieve } = makeGateway(packet)
		const inputs: WorkerBootstrapInputs = {
			enabled: true,
			workerType: "reader",
			knownTarget: absentTarget,
			description,
			workspace,
		}

		const result = await bootstrapWorkerRetrieval(inputs, gateway)

		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(retrieve).toHaveBeenCalledWith(description, workspace, "bootstrap", MAX_EVIDENCE_PACKET_ITEMS)
		expect(retrieve).toHaveBeenCalledWith(description, workspace, "bootstrap", 8)
		expect(result).toEqual({ packet })
	})

	it("gated true (reasoner) also bootstraps (Req 9.1)", async () => {
		const packet: EvidencePacket = { query: description, items: [] }
		const { gateway, retrieve } = makeGateway(packet)
		const inputs: WorkerBootstrapInputs = {
			enabled: true,
			workerType: "reasoner",
			knownTarget: absentTarget,
			description,
			workspace,
		}

		const result = await bootstrapWorkerRetrieval(inputs, gateway)

		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(result).toBeDefined()
		expect(result).toEqual({ packet })
	})

	it("skips bootstrap when a known target applies (Req 9.3)", async () => {
		const packet: EvidencePacket = { query: description, items: [] }
		const { gateway, retrieve } = makeGateway(packet)
		const inputs: WorkerBootstrapInputs = {
			enabled: true,
			workerType: "reader",
			knownTarget: { present: true, path: "src/x.ts", source: "worker_held" },
			description,
			workspace,
		}

		const result = await bootstrapWorkerRetrieval(inputs, gateway)

		expect(retrieve).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
	})

	it("skips bootstrap when disabled (Req 9.4)", async () => {
		const packet: EvidencePacket = { query: description, items: [] }
		const { gateway, retrieve } = makeGateway(packet)
		const inputs: WorkerBootstrapInputs = {
			enabled: false,
			workerType: "reader",
			knownTarget: absentTarget,
			description,
			workspace,
		}

		const result = await bootstrapWorkerRetrieval(inputs, gateway)

		expect(retrieve).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
	})

	it("skips bootstrap for non-reader/reasoner workers (Req 9.1)", async () => {
		const packet: EvidencePacket = { query: description, items: [] }

		for (const workerType of ["verifier", "other"] as const) {
			const { gateway, retrieve } = makeGateway(packet)
			const inputs: WorkerBootstrapInputs = {
				enabled: true,
				workerType,
				knownTarget: absentTarget,
				description,
				workspace,
			}

			const result = await bootstrapWorkerRetrieval(inputs, gateway)

			expect(retrieve).not.toHaveBeenCalled()
			expect(result).toBeUndefined()
		}
	})
})
