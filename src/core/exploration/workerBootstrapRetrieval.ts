import type { EvidencePacket, KnownTargetResult } from "./types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "./types"
import type { RetrievalGatewayClient } from "./retrievalGatewayClient"

/**
 * Worker types eligible for Worker_Bootstrap_Retrieval. Only `reader` and
 * `reasoner` workers bootstrap before broad investigation (Req 9.1).
 */
export type WorkerType = "reader" | "reasoner" | "verifier" | "other"

/**
 * Pure inputs to {@link bootstrapWorkerRetrieval}.
 */
export interface WorkerBootstrapInputs {
	/** Feature flag making bootstrap retrieval configurable (Req 9.4). */
	enabled: boolean
	/** The worker role about to begin investigation; only reader/reasoner bootstrap (Req 9.1). */
	workerType: WorkerType
	/** Known-target detection result; a present target suppresses bootstrap (Req 9.3). */
	knownTarget: KnownTargetResult
	/** Task or worker description used as the retrieval query (Req 9.1). */
	description: string
	/** Workspace the retrieval is scoped to. */
	workspace: string
}

/**
 * Result of a performed Worker_Bootstrap_Retrieval. The caller injects
 * `packet` into the worker's initial context (Req 9.2); this function returns
 * the evidence and does not mutate any context itself.
 */
export interface WorkerBootstrapResult {
	packet: EvidencePacket
}

/**
 * Gate and perform Worker_Bootstrap_Retrieval for a worker about to begin broad
 * repository investigation.
 *
 * Bootstrap occurs iff `enabled && (reader || reasoner) && !knownTarget.present`
 * (Req 9.1, 9.3, 9.4). When gated true, exactly one gateway `retrieve()` is
 * issued from the worker/task description with the `bootstrap` intent and the
 * bounded packet is returned so the caller can seed the worker's initial
 * context (Req 9.2). Otherwise the function skips (no `retrieve()`) and returns
 * `undefined`.
 */
export async function bootstrapWorkerRetrieval(
	inputs: WorkerBootstrapInputs,
	gateway: RetrievalGatewayClient,
): Promise<WorkerBootstrapResult | undefined> {
	if (!inputs.enabled) {
		return undefined
	}
	if (inputs.workerType !== "reader" && inputs.workerType !== "reasoner") {
		return undefined
	}
	if (inputs.knownTarget.present) {
		return undefined
	}

	const packet = await gateway.retrieve(inputs.description, inputs.workspace, "bootstrap", MAX_EVIDENCE_PACKET_ITEMS)
	return { packet }
}
