import type { RetrievalGatewayClient } from "./retrievalGatewayClient"

/**
 * Module-level injectable holder for the {@link RetrievalGatewayClient}.
 *
 * This is the seam that lets the dispatch hook in `presentAssistantMessage`
 * route `PreferSemantic` retrieval through a gateway without hard-wiring a
 * concrete transport. There is no real transport wired in the repo yet, so the
 * default is `undefined` — which the hook interprets as `gatewayAvailable:
 * false`, falling through to broad walking (Req 8.5). Tests inject a faked
 * `RetrievalGatewayClient` spy via {@link setRetrievalGatewayClient}.
 */
let current: RetrievalGatewayClient | undefined

/**
 * Return the currently injected {@link RetrievalGatewayClient}, or `undefined`
 * when no gateway has been wired. An `undefined` result means the gateway is
 * unavailable (`gatewayAvailable: false`).
 */
export function getRetrievalGatewayClient(): RetrievalGatewayClient | undefined {
	return current
}

/**
 * Inject (or clear, with `undefined`) the {@link RetrievalGatewayClient}.
 * Intended primarily for wiring and tests; pass `undefined` to reset to the
 * no-gateway default.
 */
export function setRetrievalGatewayClient(client: RetrievalGatewayClient | undefined): void {
	current = client
}
