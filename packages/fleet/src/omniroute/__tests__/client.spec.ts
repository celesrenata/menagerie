import { describe, expect, it, vi } from "vitest"

import {
	HttpOmniRouteClient,
	MissingSecretError,
	OmniRouteApiError,
	REDACTION_MARKER,
	type CallLogRecord,
	type Combo,
	type ComboInput,
	type Connection,
	type FetchInit,
	type FetchLike,
	type FetchResponse,
	type SecretResolver,
} from "../client.js"

// A recorded fetch call so a test can assert the method, URL, and headers that
// the client issued.
interface RecordedCall {
	url: string
	init?: FetchInit
}

// Build a fetch stub that records every call and returns a scripted response.
// `respond` maps the Nth call to a response; by default a 200 with `[]`.
const makeFetch = (
	respond: (call: RecordedCall, index: number) => FetchResponse,
): { fetch: FetchLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = []
	const fetch: FetchLike = (url, init) => {
		const call: RecordedCall = { url, init }
		calls.push(call)
		return Promise.resolve(respond(call, calls.length - 1))
	}
	return { fetch, calls }
}

const okJson = (value: unknown): FetchResponse => ({
	ok: true,
	status: 200,
	text: () => Promise.resolve(JSON.stringify(value)),
})

const okEmpty = (): FetchResponse => ({ ok: true, status: 200, text: () => Promise.resolve("") })

const errorResponse = (status: number, body: string): FetchResponse => ({
	ok: false,
	status,
	text: () => Promise.resolve(body),
})

const BEARER = "super-secret-management-key-12345"

const resolver = (value: string | undefined): SecretResolver => ({
	resolve: vi.fn(() => Promise.resolve(value)),
})

const makeClient = (
	fetch: FetchLike,
	options: { secret?: string | undefined; secretResolves?: boolean; baseUrl?: string } = {},
): HttpOmniRouteClient => {
	// `secretResolves: false` models a missing secret; otherwise the configured
	// value (or the default BEARER) resolves.
	const secretValue = options.secretResolves === false ? undefined : (options.secret ?? BEARER)
	return new HttpOmniRouteClient({
		baseUrl: options.baseUrl ?? "https://cluster.example:8080",
		managementSecretRef: "secret:omniroute-management-key",
		managementSecretFieldPath: "instances[cluster].secret",
		secretResolver: resolver(secretValue),
		fetch,
	})
}

const sampleComboInput: ComboInput = {
	name: "code",
	strategy: "priority",
	models: [{ id: "m1", kind: "model", model: "glm", providerId: "vllm", connectionId: "c1", weight: 1 }],
	config: { maxRetries: 2, fleetRevision: "abc123" },
	context_length: 131072,
	isHidden: false,
}

describe("HttpOmniRouteClient — bearer handling", () => {
	it("resolves the management secret and sends it as a Bearer header", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		const client = makeClient(fetch)

		await client.listCombos()

		expect(calls).toHaveLength(1)
		expect(calls[0]?.init?.headers?.Authorization).toBe(`Bearer ${BEARER}`)
	})

	it("throws MissingSecretError without a value when the secret does not resolve", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		const client = makeClient(fetch, { secretResolves: false })

		await expect(client.listCombos()).rejects.toBeInstanceOf(MissingSecretError)
		// No request is sent when the secret is unavailable (Requirement 22.8).
		expect(calls).toHaveLength(0)
	})
})

describe("HttpOmniRouteClient — error redaction (Req 22.4, 22.5)", () => {
	it("redacts the bearer value from a 5xx error", async () => {
		const { fetch } = makeFetch(() => errorResponse(500, "internal error"))
		const client = makeClient(fetch)

		const error = await client.listCombos().catch((e) => e as unknown)

		expect(error).toBeInstanceOf(OmniRouteApiError)
		const apiError = error as OmniRouteApiError
		const serialized = JSON.stringify({
			message: apiError.message,
			operation: apiError.operation,
			method: apiError.method,
			status: apiError.status,
			redactedUrl: apiError.redactedUrl,
			redactedBody: apiError.redactedBody,
		})
		expect(serialized).not.toContain(BEARER)
	})

	it("redacts a secret value echoed in a 4xx error body", async () => {
		const { fetch } = makeFetch(() => errorResponse(401, `invalid key ${BEARER} rejected`))
		const client = makeClient(fetch)

		const error = (await client.listCombos().catch((e) => e as unknown)) as OmniRouteApiError

		expect(error).toBeInstanceOf(OmniRouteApiError)
		expect(error.redactedBody).not.toContain(BEARER)
		expect(error.redactedBody).toContain(REDACTION_MARKER)
	})

	it("redacts a tokenized path segment from the error URL", async () => {
		// A base URL that embeds a token-scoped path segment to prove the
		// api/v1/vscode/<token> rule applies to the error URL (Requirement 22.5).
		const { fetch } = makeFetch(() => errorResponse(404, "not found"))
		const client = makeClient(fetch, { baseUrl: "https://cluster.example/api/v1/vscode/TOKEN123" })

		const error = (await client.getComboTrace("req-9").catch((e) => e as unknown)) as OmniRouteApiError

		expect(error.redactedUrl).not.toContain("TOKEN123")
		expect(error.redactedUrl).toContain(REDACTION_MARKER)
		// The rest of the path is preserved.
		expect(error.redactedUrl).toContain("/api/usage/combo-trace/req-9")
	})
})

describe("HttpOmniRouteClient — method + path per operation", () => {
	const lastCall = (calls: RecordedCall[]): RecordedCall => {
		const call = calls.at(-1)
		if (!call) throw new Error("expected at least one fetch call")
		return call
	}

	it("listCombos -> GET /api/combos", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).listCombos()
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/combos")
	})

	it("listConnections -> GET /api/providers", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).listConnections()
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/providers")
	})

	it("getAdvertisedModels -> GET /api/providers/{id}/models", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).getAdvertisedModels("c1")
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/providers/c1/models")
	})

	it("getContextOverrides -> GET /api/model-capability-overrides", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).getContextOverrides()
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/model-capability-overrides")
	})

	it("getComboTrace -> GET /api/usage/combo-trace/{id}", async () => {
		const { fetch, calls } = makeFetch(() => okJson({ id: "req-1", steps: [] }))
		await makeClient(fetch).getComboTrace("req-1")
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/usage/combo-trace/req-1")
	})

	it("readCallLogs -> GET /api/usage/call-logs with query", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).readCallLogs({ status: 200, model: "glm", limit: 10 })
		expect(lastCall(calls).init?.method).toBe("GET")
		expect(lastCall(calls).url).toBe(
			"https://cluster.example:8080/api/usage/call-logs?status=200&model=glm&limit=10",
		)
	})

	it("createCombo -> POST /api/combos with body", async () => {
		const created: Combo = { id: "cmb1", ...sampleComboInput }
		const { fetch, calls } = makeFetch(() => okJson(created))
		const result = await makeClient(fetch).createCombo(sampleComboInput)
		expect(lastCall(calls).init?.method).toBe("POST")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/combos")
		expect(lastCall(calls).init?.body).toBe(JSON.stringify(sampleComboInput))
		expect(result.id).toBe("cmb1")
	})

	it("updateCombo -> PUT /api/combos/{id}", async () => {
		const updated: Combo = { id: "cmb1", ...sampleComboInput }
		const { fetch, calls } = makeFetch(() => okJson(updated))
		await makeClient(fetch).updateCombo("cmb1", sampleComboInput)
		expect(lastCall(calls).init?.method).toBe("PUT")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/combos/cmb1")
	})

	it("deleteCombo -> DELETE /api/combos/{id}", async () => {
		const { fetch, calls } = makeFetch(() => okEmpty())
		await makeClient(fetch).deleteCombo("cmb1")
		expect(lastCall(calls).init?.method).toBe("DELETE")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/combos/cmb1")
	})

	it("patchConnection -> PATCH /api/providers/{id}", async () => {
		const connection: Connection = {
			id: "c1",
			provider: "vllm",
			address: "http://host:8000",
			isActive: true,
			maxConcurrent: 4,
		}
		const { fetch, calls } = makeFetch(() => okJson(connection))
		await makeClient(fetch).patchConnection("c1", { maxConcurrent: 4 })
		expect(lastCall(calls).init?.method).toBe("PATCH")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/providers/c1")
		expect(lastCall(calls).init?.body).toBe(JSON.stringify({ maxConcurrent: 4 }))
	})

	it("patchContextOverrides -> PATCH /api/model-capability-overrides", async () => {
		const { fetch, calls } = makeFetch(() => okJson([]))
		await makeClient(fetch).patchContextOverrides({ upserts: [{ model: "glm", contextLength: 131072 }] })
		expect(lastCall(calls).init?.method).toBe("PATCH")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/model-capability-overrides")
	})

	it("syncModels -> POST /api/providers/{id}/sync-models", async () => {
		const { fetch, calls } = makeFetch(() => okEmpty())
		await makeClient(fetch).syncModels("c1")
		expect(lastCall(calls).init?.method).toBe("POST")
		expect(lastCall(calls).url).toBe("https://cluster.example:8080/api/providers/c1/sync-models")
	})

	it("parses a typed call-log response", async () => {
		const record: CallLogRecord = {
			timestamp: "2026-10-14T00:00:00Z",
			status: 200,
			provider: "vllm",
			model: "glm",
			correlationId: "corr-1",
		}
		const { fetch } = makeFetch(() => okJson([record]))
		const logs = await makeClient(fetch).readCallLogs({})
		expect(logs).toEqual([record])
	})
})


describe("HttpOmniRouteClient — list-read response unwrapping (live wraps list payloads)", () => {
	const combo: Combo = {
		id: "cmb1",
		name: "code",
		strategy: "priority",
		models: [{ id: "m1", kind: "model", model: "glm", providerId: "vllm", connectionId: "c1", weight: 1 }],
		config: { fleetRevision: "abc123" },
		context_length: 131072,
		isHidden: false,
	}

	it("unwraps combos from a { object, data } wrapper (the live /api/combos shape)", async () => {
		const { fetch } = makeFetch(() => okJson({ object: "list", data: [combo] }))
		const result = await makeClient(fetch).listCombos()
		expect(Array.isArray(result)).toBe(true)
		expect(result).toEqual([combo])
	})

	it("unwraps combos from a { combos } wrapper (the webview client's fallback key)", async () => {
		const { fetch } = makeFetch(() => okJson({ combos: [combo] }))
		const result = await makeClient(fetch).listCombos()
		expect(result).toEqual([combo])
	})

	it("still accepts a bare combo array (back-compat with the in-memory fake)", async () => {
		const { fetch } = makeFetch(() => okJson([combo]))
		const result = await makeClient(fetch).listCombos()
		expect(result).toEqual([combo])
	})

	it("returns [] for an empty body instead of undefined (no crash downstream)", async () => {
		const { fetch } = makeFetch(() => okEmpty())
		const result = await makeClient(fetch).listCombos()
		expect(result).toEqual([])
	})

	it("returns [] for a wrapper object carrying no array (degrade, never throw)", async () => {
		const { fetch } = makeFetch(() => okJson({ object: "list", total: 0 }))
		const result = await makeClient(fetch).listCombos()
		expect(result).toEqual([])
	})

	it("unwraps connections from a { providers } wrapper", async () => {
		const connection: Connection = {
			id: "c1",
			provider: "vllm",
			address: "http://host:8000",
			isActive: true,
			maxConcurrent: 2,
		}
		const { fetch } = makeFetch(() => okJson({ providers: [connection] }))
		const result = await makeClient(fetch).listConnections()
		expect(result).toEqual([connection])
	})

	it("unwraps connections from a { data } wrapper", async () => {
		const connection: Connection = {
			id: "c2",
			provider: "ollama-local",
			address: "http://host:2701",
			isActive: true,
		}
		const { fetch } = makeFetch(() => okJson({ data: [connection] }))
		const result = await makeClient(fetch).listConnections()
		expect(result).toEqual([connection])
	})
})


describe("HttpOmniRouteClient — listConnections lifts address from providerSpecificData.baseUrl", () => {
	it("maps a live vllm record's nested baseUrl into the top-level address", async () => {
		const live = {
			id: "e9bd13fb",
			provider: "vllm",
			name: "esnixi-5090",
			isActive: true,
			defaultModel: "qwen3.8-27b-nvfp4",
			maxConcurrent: 2,
			providerSpecificData: { baseUrl: "http://192.168.133.3:2701/v1", passthroughModels: true },
		}
		const { fetch } = makeFetch(() => okJson({ data: [live] }))
		const [conn] = await makeClient(fetch).listConnections()
		expect(conn?.id).toBe("e9bd13fb")
		expect(conn?.provider).toBe("vllm")
		// The nested baseUrl is lifted so hostPort(address) resolves the endpoint.
		expect(conn?.address).toBe("http://192.168.133.3:2701/v1")
		expect(conn?.isActive).toBe(true)
		expect(conn?.maxConcurrent).toBe(2)
		expect(conn?.defaultModel).toBe("qwen3.8-27b-nvfp4")
	})

	it("honors a top-level address when the server provides one", async () => {
		const live = { id: "c1", provider: "vllm", isActive: true, address: "http://host:9000/v1" }
		const { fetch } = makeFetch(() => okJson([live]))
		const [conn] = await makeClient(fetch).listConnections()
		expect(conn?.address).toBe("http://host:9000/v1")
	})

	it("falls back to snake_case provider_specific_data.base_url for older builds", async () => {
		const live = { id: "c2", provider: "llama-cpp", is_active: true, provider_specific_data: { base_url: "http://192.168.133.2:7777/v1" } }
		const { fetch } = makeFetch(() => okJson([live]))
		const [conn] = await makeClient(fetch).listConnections()
		expect(conn?.address).toBe("http://192.168.133.2:7777/v1")
		expect(conn?.isActive).toBe(true)
	})

	it("leaves address empty when no address is present (treated as unresolved)", async () => {
		const live = { id: "c3", provider: "openai", isActive: true, providerSpecificData: { apiKeyHealth: {} } }
		const { fetch } = makeFetch(() => okJson([live]))
		const [conn] = await makeClient(fetch).listConnections()
		expect(conn?.address).toBe("")
	})
})
