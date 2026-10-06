import type { EvidenceItem, EvidencePacket, RetrievalIntent } from "./types"

/**
 * Thin client over the retrieval-fabric gateway.
 *
 * Exposes NO node/replica selection parameters: request distribution is owned
 * by the gateway and OmniRoute (Req 8.3). A rejecting `retrieve` or
 * `isAvailable() === false` is treated as gateway-unavailable; failures never
 * throw to the caller (Req 8.5).
 */
export interface RetrievalGatewayClient {
	/** Returns a bounded reranked Evidence_Packet (~5-8 items). Never throws. */
	retrieve(query: string, workspace: string, intent: RetrievalIntent, limit: number): Promise<EvidencePacket>

	/** Health probe used to compute `gatewayAvailable`. Resolves `false` instead of throwing. */
	isAvailable(): Promise<boolean>
}

/**
 * Raw gateway request forwarded to the injected transport. Carries no
 * node/replica selection by design (Req 8.3).
 */
export interface RetrievalGatewayRequest {
	query: string
	workspace: string
	intent: RetrievalIntent
	limit: number
}

/**
 * Transport abstraction. Implementations perform the actual HTTP/RPC call so
 * the client stays testable without real network access.
 */
export interface RetrievalGatewayTransport {
	/** Perform the retrieve call. May reject; the client normalizes failures. */
	retrieve(request: RetrievalGatewayRequest): Promise<unknown>

	/** Perform the health probe. May reject; the client normalizes failures. */
	health(): Promise<unknown>
}

/**
 * Dependencies for {@link createRetrievalGatewayClient}.
 */
export interface RetrievalGatewayClientDeps {
	transport: RetrievalGatewayTransport
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

/**
 * Normalize an arbitrary item from a transport response into an
 * {@link EvidenceItem}, or return `undefined` when a required field
 * (`file`, `startLine`, `endLine`, `score`) is missing or malformed.
 */
function normalizeItem(raw: unknown): EvidenceItem | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined
	}
	const candidate = raw as Record<string, unknown>
	const { file, startLine, endLine, score } = candidate
	if (typeof file !== "string" || !isFiniteNumber(startLine) || !isFiniteNumber(endLine) || !isFiniteNumber(score)) {
		return undefined
	}
	const item: EvidenceItem = {
		file,
		startLine,
		endLine,
		score,
		reason: typeof candidate.reason === "string" ? candidate.reason : "",
	}
	if (typeof candidate.snippet === "string") {
		item.snippet = candidate.snippet
	}
	if (typeof candidate.fresh === "boolean") {
		item.fresh = candidate.fresh
	}
	return item
}

/**
 * Normalize an arbitrary transport response into a valid {@link EvidencePacket}.
 * Malformed items are dropped; the result is always a valid packet.
 */
function normalizePacket(query: string, raw: unknown): EvidencePacket {
	const rawItems =
		typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).items)
			? ((raw as Record<string, unknown>).items as ReadonlyArray<unknown>)
			: []
	const items: EvidenceItem[] = []
	for (const rawItem of rawItems) {
		const item = normalizeItem(rawItem)
		if (item !== undefined) {
			items.push(item)
		}
	}
	return { query, items }
}

/**
 * Create a thin {@link RetrievalGatewayClient} backed by an injected transport.
 *
 * The client is intentionally thin: it forwards the request to the transport
 * and normalizes the result. All failures are caught internally so the caller
 * never sees a throw (Req 8.5):
 * - `retrieve` on failure resolves to a valid-but-empty packet.
 * - `isAvailable` on failure resolves to `false`.
 */
export function createRetrievalGatewayClient(deps: RetrievalGatewayClientDeps): RetrievalGatewayClient {
	const { transport } = deps
	return {
		async retrieve(
			query: string,
			workspace: string,
			intent: RetrievalIntent,
			limit: number,
		): Promise<EvidencePacket> {
			try {
				const raw = await transport.retrieve({ query, workspace, intent, limit })
				return normalizePacket(query, raw)
			} catch {
				// A rejected call surfaces as unavailable (never throws to the caller).
				return { query, items: [] }
			}
		},
		async isAvailable(): Promise<boolean> {
			try {
				const raw = await transport.health()
				return raw === true
			} catch {
				return false
			}
		},
	}
}
