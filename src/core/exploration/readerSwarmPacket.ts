import type { EvidencePacket } from "./types"
import { MAX_EVIDENCE_PACKET_ITEMS } from "./types"
import type { RetrievalGatewayClient } from "./retrievalGatewayClient"

/**
 * Reader-swarm per-scope packet delivery.
 *
 * Delivers exactly one bounded {@link EvidencePacket} per reader scope by
 * invoking the retrieval gateway with the `reader_scope` intent for each scope
 * before that reader begins targeted investigation (Req 10.1, 10.2). Each scope
 * reasons over its packet rather than discovering filenames via broad
 * filesystem walking (Req 10.3).
 *
 * Swarm SCHEDULING is owned by the elastic-parallel-execution spec, NOT this
 * module (Req 10.4): this module defines only that each reader scope receives a
 * bounded packet.
 */

/**
 * A single reader scope to retrieve evidence for.
 */
export interface ReaderScope {
	/** Scope label, e.g. "deployment", "authentication", "frontend", "tests". */
	name: string
	/** The scope-specific query sent to the gateway. */
	query: string
	workspace: string
}

/**
 * A reader scope paired with the bounded packet retrieved for it.
 */
export interface ReaderScopePacket {
	scope: ReaderScope
	packet: EvidencePacket
}

/**
 * Deliver one bounded {@link EvidencePacket} per reader scope by invoking the
 * gateway (`intent: "reader_scope"`) for each scope. Retrievals run in parallel
 * and the returned pairs preserve the input scope order.
 *
 * This function does NOT schedule the swarm (owned by elastic-parallel-execution);
 * it only retrieves the packets. An unavailable gateway surfaces as an empty
 * packet for the affected scope because the gateway client never throws.
 *
 * Requirements traced: 10.1, 10.2, 10.3, 10.4
 */
export async function deliverReaderSwarmPackets(
	scopes: ReadonlyArray<ReaderScope>,
	gateway: RetrievalGatewayClient,
	limit?: number,
): Promise<ReadonlyArray<ReaderScopePacket>> {
	const effectiveLimit = limit ?? MAX_EVIDENCE_PACKET_ITEMS
	const packets = await Promise.all(
		scopes.map((scope) => gateway.retrieve(scope.query, scope.workspace, "reader_scope", effectiveLimit)),
	)
	return scopes.map((scope, index) => ({ scope, packet: packets[index] }))
}
