import { MAX_EMBEDDING_REQUEST_ITEMS, MAX_EMBEDDING_REQUEST_PADDED_TOKENS } from "../constants"
import { extractStatusCode } from "./validation-helpers"

export interface EmbeddingRequestLimits {
	/** Maximum number of inputs in one embeddings request. */
	maxItems: number
	/** Maximum of (inputs x longest input's estimated tokens) in one request. */
	maxPaddedTokens: number
}

export const DEFAULT_EMBEDDING_REQUEST_LIMITS: EmbeddingRequestLimits = {
	maxItems: MAX_EMBEDDING_REQUEST_ITEMS,
	maxPaddedTokens: MAX_EMBEDDING_REQUEST_PADDED_TOKENS,
}

/** Same rough chars/4 estimate the embedders use for their per-item limits. */
export function estimateEmbeddingTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Groups texts into embeddings requests that respect both the item cap and the padded-token budget.
 *
 * Texts are sorted by estimated length (stable) before grouping so each request holds similarly sized items,
 * which keeps padding to the longest item low. Each group lists indices into `texts`; callers use them to put
 * results back in the original order. A single text always forms a request on its own, even if it alone
 * exceeds the padded budget, so per-item limits stay the embedder's responsibility.
 */
export function planEmbeddingRequests(
	texts: readonly string[],
	limits: EmbeddingRequestLimits = DEFAULT_EMBEDDING_REQUEST_LIMITS,
): number[][] {
	const maxItems = Math.max(1, Math.floor(limits.maxItems))
	const maxPaddedTokens = Math.max(1, limits.maxPaddedTokens)
	const tokens = texts.map(estimateEmbeddingTokens)
	const order = texts.map((_, index) => index).sort((a, b) => tokens[a] - tokens[b] || a - b)

	const requests: number[][] = []
	let current: number[] = []
	let currentLongest = 0

	for (const index of order) {
		const longest = Math.max(currentLongest, tokens[index])
		const exceedsItems = current.length + 1 > maxItems
		const exceedsPadded = (current.length + 1) * longest > maxPaddedTokens
		if (current.length > 0 && (exceedsItems || exceedsPadded)) {
			requests.push(current)
			current = []
			currentLongest = 0
		}
		current.push(index)
		currentLongest = Math.max(currentLongest, tokens[index])
	}
	if (current.length > 0) {
		requests.push(current)
	}
	return requests
}

const CONNECTION_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
])

// Messages from the OpenAI SDK (APIConnectionError / APIConnectionTimeoutError), undici fetch and Node sockets.
const CONNECTION_ERROR_MESSAGE = /connection error|request timed out|fetch failed|socket hang up|other side closed/i

function readCode(value: unknown): string | undefined {
	if (typeof value === "object" && value !== null && "code" in value) {
		const code = (value as { code?: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

/**
 * True for failures where resending the same request is likely to fail the same way but a smaller request may
 * succeed: HTTP 5xx (e.g. the server ran out of memory) or a dropped/refused connection (e.g. the server was killed
 * mid-request). 4xx errors, including 429, are not split.
 */
export function isSplittableEmbeddingError(error: unknown): boolean {
	const status = extractStatusCode(error)
	if (status !== undefined) {
		return status >= 500 && status < 600
	}
	if (!(error instanceof Error)) {
		return false
	}
	const cause: unknown = error.cause
	const code = readCode(error) ?? readCode(cause)
	if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) {
		return true
	}
	return CONNECTION_ERROR_MESSAGE.test(error.message)
}
