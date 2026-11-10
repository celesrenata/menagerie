import { AnalysisTransportError, GraniteAnalysisClient, OMNIROUTE_ANALYSIS_HEADERS, buildRequestBody, parseCompletion } from "../GraniteAnalysisClient"

const messages = [
	{ role: "system" as const, content: "s" },
	{ role: "user" as const, content: "u" },
]

function okResponse(content: string, extra: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 2 },
			...extra,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	)
}

function client(fetchImpl: typeof fetch, timeoutMs = 1000) {
	return new GraniteAnalysisClient({ baseUrl: "http://svc.test/v1/", model: "granite-4.2-8b", timeoutMs, fetchImpl })
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
	} catch (error) {
		if (error instanceof AnalysisTransportError) return error.kind
		throw error
	}
	return "no-error"
}

describe("buildRequestBody", () => {
	it("is non-streaming, bounded, and never carries tools, tool_choice or temperature", () => {
		const body = buildRequestBody("granite-4.2-8b", messages, 768)
		expect(body).toEqual({ model: "granite-4.2-8b", stream: false, max_tokens: 768, messages })
		for (const forbidden of ["tools", "tool_choice", "temperature", "functions"]) {
			expect(forbidden in body).toBe(false)
		}
	})

	it("rejects a missing or non-positive max_tokens", () => {
		expect(() => buildRequestBody("m", messages, 0)).toThrow(RangeError)
		expect(() => buildRequestBody("m", messages, 1.5)).toThrow(RangeError)
	})
})

describe("GraniteAnalysisClient", () => {
	it("posts exactly the pinned body to <base>/chat/completions and returns text + usage", async () => {
		const fetchImpl = vi.fn(async () => okResponse('{"findings":[]}'))
		const result = await client(fetchImpl as unknown as typeof fetch).complete(messages, 256)
		expect(result).toEqual({
			content: '{"findings":[]}',
			finishReason: "stop",
			promptTokens: 5,
			completionTokens: 2,
		})
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("http://svc.test/v1/chat/completions")
		expect(JSON.parse(String(init.body))).toEqual({
			model: "granite-4.2-8b",
			stream: false,
			max_tokens: 256,
			messages,
		})
	})

	it("sends a bearer token only when configured", async () => {
		const fetchImpl = vi.fn(async () => okResponse("{}"))
		await new GraniteAnalysisClient({
			baseUrl: "http://x/v1",
			model: "m",
			timeoutMs: 1000,
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		}).complete(messages, 8)
		const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer k")
	})

	it("sends extra headers (OmniRoute opt-outs) but never lets them replace content-type", async () => {
		const fetchImpl = vi.fn(async () => okResponse("{}"))
		await new GraniteAnalysisClient({
			baseUrl: "http://x/v1",
			model: "m",
			timeoutMs: 1000,
			extraHeaders: { ...OMNIROUTE_ANALYSIS_HEADERS, "content-type": "text/plain" },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		}).complete(messages, 8)
		const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
		expect(headers["x-omniroute-no-memory"]).toBe("true")
		expect(headers["x-omniroute-compression"]).toBe("off")
		expect(headers["content-type"]).toBe("application/json")
	})
	it("maps 429 to rate-limited and other HTTP errors to unavailable", async () => {
		expect(
			await kindOf(client((async () => new Response("", { status: 429 })) as typeof fetch).complete(messages, 8)),
		).toBe("rate-limited")
		expect(
			await kindOf(client((async () => new Response("", { status: 503 })) as typeof fetch).complete(messages, 8)),
		).toBe("unavailable")
		expect(
			await kindOf(client((async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch).complete(messages, 8)),
		).toBe("unavailable")
	})

	it("maps a non-JSON envelope to non-json", async () => {
		const fetchImpl = (async () => new Response("<html>", { status: 200 })) as typeof fetch
		expect(await kindOf(client(fetchImpl).complete(messages, 8))).toBe("non-json")
	})

	it("times out and aborts the in-flight fetch", async () => {
		let aborted = false
		const fetchImpl = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					aborted = true
					reject(new Error("aborted"))
				})
			})) as unknown as typeof fetch
		expect(await kindOf(client(fetchImpl, 20).complete(messages, 8))).toBe("timeout")
		expect(aborted).toBe(true)
	})

	it("honours caller cancellation, including before send", async () => {
		const pre = new AbortController()
		pre.abort()
		const never = vi.fn()
		expect(await kindOf(client(never as unknown as typeof fetch).complete(messages, 8, pre.signal))).toBe("cancelled")
		expect(never).not.toHaveBeenCalled()

		const mid = new AbortController()
		const fetchImpl = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
			})) as unknown as typeof fetch
		const pending = kindOf(client(fetchImpl, 5000).complete(messages, 8, mid.signal))
		mid.abort()
		expect(await pending).toBe("cancelled")
	})
})

describe("parseCompletion", () => {
	it("rejects envelopes without choices or text", () => {
		expect(() => parseCompletion({})).toThrow(AnalysisTransportError)
		expect(() => parseCompletion({ choices: [{ message: {} }] })).toThrow(AnalysisTransportError)
		expect(() => parseCompletion({ choices: [{ message: { content: null } }] })).toThrow(AnalysisTransportError)
	})
})
