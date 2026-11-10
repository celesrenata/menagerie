import type { AnalysisFailureKind } from "@roo-code/types"

/**
 * Non-streaming OpenAI-compatible transport for the pure-analysis executor.
 *
 * Contract (MEN-GRANITE-SDD-001 R2): `stream:false`, an explicit `max_tokens`, and NEVER
 * `tools` / `tool_choice` / `temperature`. The live service silently accepts `stream:true`
 * and `tools`, so these rules are enforced here on the client, not by the server.
 *
 * URL, model and credentials are injected configuration. Nothing here knows a LAN address,
 * a GPU, or a physical placement; OmniRoute (or an operator-supplied base URL) owns that.
 */

export interface GraniteClientConfig {
	/** Base URL including the `/v1` segment, e.g. `https://omniroute.example/v1`. */
	baseUrl: string
	/** Served model id, resolved from published route metadata. */
	model: string
	apiKey?: string
	/** Per-request deadline. */
	timeoutMs: number
	fetchImpl?: typeof fetch
}

export interface AnalysisChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

export interface AnalysisCompletion {
	content: string
	finishReason: string | undefined
	promptTokens?: number
	completionTokens?: number
}

export class AnalysisTransportError extends Error {
	constructor(
		readonly kind: Extract<
			AnalysisFailureKind,
			"unavailable" | "rate-limited" | "queue-full" | "timeout" | "cancelled" | "non-json"
		>,
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = "AnalysisTransportError"
	}
}

export interface AnalysisRequestBody {
	model: string
	stream: false
	max_tokens: number
	messages: AnalysisChatMessage[]
}

/** Pure and exported so tests can pin the exact wire shape. */
export function buildRequestBody(
	model: string,
	messages: AnalysisChatMessage[],
	maxTokens: number,
): AnalysisRequestBody {
	if (!Number.isInteger(maxTokens) || maxTokens < 1) {
		throw new RangeError("max_tokens must be a positive integer")
	}
	return { model, stream: false, max_tokens: maxTokens, messages }
}

function endpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`
}

/** The only surface the executor needs; lets tests inject a precise fake. */
export interface AnalysisCompletionClient {
	readonly model: string
	complete(messages: AnalysisChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<AnalysisCompletion>
}

export class GraniteAnalysisClient implements AnalysisCompletionClient {
	constructor(private readonly config: GraniteClientConfig) {}

	get model(): string {
		return this.config.model
	}

	async complete(
		messages: AnalysisChatMessage[],
		maxTokens: number,
		signal?: AbortSignal,
	): Promise<AnalysisCompletion> {
		const body = buildRequestBody(this.config.model, messages, maxTokens)
		if (signal?.aborted) throw new AnalysisTransportError("cancelled", "request cancelled before send")

		const controller = new AbortController()
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, this.config.timeoutMs)
		const onAbort = () => controller.abort()
		signal?.addEventListener("abort", onAbort, { once: true })

		try {
			const doFetch = this.config.fetchImpl ?? fetch
			const headers: Record<string, string> = { "content-type": "application/json" }
			if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`

			let response: Response
			try {
				response = await doFetch(endpoint(this.config.baseUrl), {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: controller.signal,
				})
			} catch (error) {
				if (timedOut) throw new AnalysisTransportError("timeout", `no response within ${this.config.timeoutMs}ms`)
				if (signal?.aborted || controller.signal.aborted) {
					throw new AnalysisTransportError("cancelled", "request cancelled")
				}
				throw new AnalysisTransportError("unavailable", `network error: ${errorMessage(error)}`)
			}

			if (response.status === 429) {
				throw new AnalysisTransportError("rate-limited", "HTTP 429", 429)
			}
			if (!response.ok) {
				throw new AnalysisTransportError("unavailable", `HTTP ${response.status}`, response.status)
			}

			let payload: unknown
			try {
				payload = await response.json()
			} catch {
				if (timedOut) throw new AnalysisTransportError("timeout", `body not received within ${this.config.timeoutMs}ms`)
				if (signal?.aborted) throw new AnalysisTransportError("cancelled", "request cancelled")
				throw new AnalysisTransportError("non-json", "response envelope is not JSON", response.status)
			}
			return parseCompletion(payload)
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/** Exported for tests. Extracts the first choice's text from an OpenAI chat.completion envelope. */
export function parseCompletion(payload: unknown): AnalysisCompletion {
	if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
		throw new AnalysisTransportError("non-json", "response has no choices")
	}
	const choice = payload.choices[0]
	const message = choice.message
	if (!isRecord(message) || typeof message.content !== "string") {
		throw new AnalysisTransportError("non-json", "first choice has no text content")
	}
	const usage = isRecord(payload.usage) ? payload.usage : undefined
	return {
		content: message.content,
		finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
		promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
		completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined,
	}
}
