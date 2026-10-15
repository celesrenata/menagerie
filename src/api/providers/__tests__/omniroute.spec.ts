import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import axios from "axios"

import { providerIdentifiers, omniRouteCatalogEntrySchema, omniRouteComboEntrySchema } from "@roo-code/types"

import {
	fetchOmniRouteCatalog,
	isOmniRoute,
	omniRouteRequestHeaders,
	omniRouteTokenizedBaseUrl,
	refreshPublishedCatalogIfStale,
	resolveOmniRouteContextWindow,
	OMNIROUTE_DEFAULT_CONTEXT_WINDOW,
	OMNIROUTE_ROUTE_CONTEXT_WINDOWS,
	OMNIROUTE_PUBLIC_TOKEN,
	OMNIROUTE_TIER_HEADER,
	withOmniRouteTier,
	__resetPublishedCatalogCache,
	__setPublishedCatalogDeps,
} from "../omniroute"

vi.mock("axios", () => ({
	default: {
		get: vi.fn(),
		isAxiosError: vi.fn().mockReturnValue(false),
	},
}))

const mockedAxiosGet = vi.mocked(axios.get)

describe("isOmniRoute", () => {
	it("is true only for an OpenAI profile with the flag enabled", () => {
		expect(isOmniRoute({ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true })).toBe(true)
	})

	it("is false for an OpenAI profile without the flag, regardless of host", () => {
		expect(
			isOmniRoute({
				apiProvider: providerIdentifiers.openai,
				openAiBaseUrl: "https://omniroute.celestium.life/v1",
			}),
		).toBe(false)
		expect(isOmniRoute({ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: false })).toBe(false)
	})

	it("is false for a non-OpenAI provider even with the flag set", () => {
		expect(isOmniRoute({ apiProvider: providerIdentifiers.anthropic, openAiIsOmniRoute: true })).toBe(false)
	})
})

describe("omniRouteRequestHeaders", () => {
	it("emits X-OmniRoute-Tier for an OmniRoute profile with a set tier", () => {
		expect(
			omniRouteRequestHeaders({
				apiProvider: providerIdentifiers.openai,
				openAiIsOmniRoute: true,
				omniRouteTier: 3,
			}),
		).toEqual({ [OMNIROUTE_TIER_HEADER]: "3" })
	})

	it("omits the header when the tier is unset", () => {
		expect(omniRouteRequestHeaders({ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true })).toEqual(
			{},
		)
	})

	it("omits the header for a non-OmniRoute profile even when a tier is set", () => {
		expect(
			omniRouteRequestHeaders({
				apiProvider: providerIdentifiers.anthropic,
				openAiIsOmniRoute: true,
				omniRouteTier: 4,
			}),
		).toEqual({})
		expect(
			omniRouteRequestHeaders({
				apiProvider: providerIdentifiers.openai,
				openAiIsOmniRoute: false,
				omniRouteTier: 4,
			}),
		).toEqual({})
	})

	it("omits the header for out-of-range or non-integer tiers", () => {
		for (const tier of [0, 6, -1, 2.5, Number.NaN]) {
			expect(
				omniRouteRequestHeaders({
					apiProvider: providerIdentifiers.openai,
					openAiIsOmniRoute: true,
					omniRouteTier: tier,
				}),
			).toEqual({})
		}
	})
})

describe("withOmniRouteTier", () => {
	it("sets the live tier on an OmniRoute profile so the header is emitted", () => {
		const result = withOmniRouteTier({ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true }, 1)
		expect(result.omniRouteTier).toBe(1)
		expect(omniRouteRequestHeaders(result)).toEqual({ [OMNIROUTE_TIER_HEADER]: "1" })
	})

	it("removes a stale snapshot when the global tier is unset", () => {
		const result = withOmniRouteTier(
			{ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true, omniRouteTier: 4 },
			undefined,
		)
		expect(result).not.toHaveProperty("omniRouteTier")
		expect(omniRouteRequestHeaders(result)).toEqual({})
	})

	it("never carries the tier on a non-OmniRoute profile", () => {
		for (const configuration of [
			{ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: false, omniRouteTier: 3 },
			{ apiProvider: providerIdentifiers.anthropic, omniRouteTier: 3 },
		]) {
			const result = withOmniRouteTier(configuration, 1)
			expect(result).not.toHaveProperty("omniRouteTier")
			expect(omniRouteRequestHeaders(result)).toEqual({})
		}
	})

	it("drops invalid tiers", () => {
		for (const tier of [0, 6, 2.5]) {
			const result = withOmniRouteTier(
				{ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true, omniRouteTier: 2 },
				tier,
			)
			expect(result).not.toHaveProperty("omniRouteTier")
		}
	})

	it("does not mutate the input", () => {
		const input = { apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true, omniRouteTier: 4 }
		withOmniRouteTier(input, 2)
		withOmniRouteTier(input, undefined)
		expect(input).toEqual({ apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true, omniRouteTier: 4 })
	})
})

describe("omniRouteTokenizedBaseUrl", () => {
	it("appends the tokenized path using the api key as the token", () => {
		expect(omniRouteTokenizedBaseUrl("https://omniroute.example", "secret")).toBe(
			"https://omniroute.example/api/v1/vscode/secret",
		)
	})

	it("uses the public placeholder when no key is provided", () => {
		expect(omniRouteTokenizedBaseUrl("https://omniroute.example")).toBe(
			`https://omniroute.example/api/v1/vscode/${OMNIROUTE_PUBLIC_TOKEN}`,
		)
	})

	it("trims trailing slashes from the server root", () => {
		expect(omniRouteTokenizedBaseUrl("https://omniroute.example///", "k")).toBe(
			"https://omniroute.example/api/v1/vscode/k",
		)
	})

	it("never emits the old hardcoded host", () => {
		expect(omniRouteTokenizedBaseUrl("https://my-host.internal", "token")).not.toContain("omniroute.celestium.life")
	})
})

describe("omniRouteCatalogEntrySchema", () => {
	it("parses an enrichModelForVscode-shaped chat entry and preserves the url verbatim", () => {
		const raw = {
			id: "qwen3-27b",
			name: "Qwen3 27B",
			url: "https://omniroute.example/api/v1/vscode/token/chat/completions#models.ai.azure.com",
			family: "qwen",
			toolCalling: true,
			vision: false,
			maxInputTokens: 262144,
			maxOutputTokens: 8192,
			supportedReasoningEfforts: ["low", "high"],
			defaultReasoningEffort: "high",
			extraFutureField: "ignored",
		}
		const result = omniRouteCatalogEntrySchema.parse(raw)
		expect(result.id).toBe("qwen3-27b")
		// URL (including the #models.ai.azure.com fragment) is carried verbatim.
		expect(result.url).toBe(raw.url)
		expect(result.url).toContain("#models.ai.azure.com")
		// Unknown fields are stripped, not rejected.
		expect((result as Record<string, unknown>).extraFutureField).toBeUndefined()
	})

	it("keeps a responses-API entry (url ending in /responses)", () => {
		const raw = {
			id: "gpt-5.5-codex",
			url: "https://omniroute.example/api/v1/vscode/token/responses#models.ai.azure.com",
		}
		const result = omniRouteCatalogEntrySchema.parse(raw)
		expect(result.url).toBe(raw.url)
		expect(result.url).toContain("/responses")
	})
})

describe("omniRouteComboEntrySchema", () => {
	it("maps a combo's tier/role name to the catalog entry id", () => {
		const raw = {
			name: "hybrid/code",
			strategy: "priority",
			models: [{ kind: "model", model: "vllm/qwen3.8-27b-nvfp4", providerId: "vllm" }],
			capabilities: { reasoning: true },
		}
		const result = omniRouteComboEntrySchema.parse(raw)
		// The selectable chat id is the full combo id, not a bare alias.
		expect(result.id).toBe("hybrid/code")
		expect(result.name).toBe("hybrid/code")
		// Combo-shape fields that are not needed to render a selectable entry are stripped.
		expect((result as Record<string, unknown>).models).toBeUndefined()
		expect((result as Record<string, unknown>).strategy).toBeUndefined()
	})

	it("carries the published route metadata through the transform", () => {
		const raw = {
			name: "hybrid/code",
			strategy: "priority",
			models: [{ kind: "model", model: "vllm/qwen3.8-27b-nvfp4", providerId: "vllm" }],
			kind: "public",
			contextWindow: 163840,
			routeCapacity: { route: "hybrid/code", capacity: 2 },
			capabilityLane: { "coder.primary": "hybrid/code" },
		}
		const result = omniRouteComboEntrySchema.parse(raw)
		expect(result.id).toBe("hybrid/code")
		expect(result.kind).toBe("public")
		expect(result.contextWindow).toBe(163840)
		expect(result.routeCapacity).toEqual({ route: "hybrid/code", capacity: 2 })
		expect(result.capabilityLane).toEqual({ "coder.primary": "hybrid/code" })
		// Combo-shape fields still stripped alongside the carried published fields.
		expect((result as Record<string, unknown>).models).toBeUndefined()
		expect((result as Record<string, unknown>).strategy).toBeUndefined()
	})

	it("still parses a combo that publishes no metadata (older OmniRoute)", () => {
		const result = omniRouteComboEntrySchema.parse({ name: "local/long" })
		expect(result.id).toBe("local/long")
		expect(result.name).toBe("local/long")
		expect(result.kind).toBeUndefined()
		expect(result.contextWindow).toBeUndefined()
		expect(result.routeCapacity).toBeUndefined()
		expect(result.capabilityLane).toBeUndefined()
	})

	it("rejects an out-of-range contextWindow and an unknown kind", () => {
		expect(omniRouteComboEntrySchema.safeParse({ name: "hybrid/code", contextWindow: 0 }).success).toBe(false)
		expect(
			omniRouteComboEntrySchema.safeParse({ name: "hybrid/code", contextWindow: 16_777_217 }).success,
		).toBe(false)
		expect(omniRouteComboEntrySchema.safeParse({ name: "hybrid/code", kind: "mystery" }).success).toBe(false)
	})
})

describe("fetchOmniRouteCatalog", () => {
	beforeEach(() => {
		mockedAxiosGet.mockReset()
	})

	it("fetches the combos endpoint and yields full tier/role combo ids", async () => {
		mockedAxiosGet.mockResolvedValueOnce({
			data: {
				object: "list",
				data: [
					{ name: "hybrid/code", strategy: "priority", models: [], capabilities: {} },
					{ name: "local/long", strategy: "priority", models: [], capabilities: {} },
				],
			},
		})

		const result = await fetchOmniRouteCatalog("https://omniroute.example", "secret")

		// The request targets the tokenized combos route, not /models?prefix=alias.
		expect(mockedAxiosGet).toHaveBeenCalledWith(
			"https://omniroute.example/api/v1/vscode/secret/combos",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
		)
		expect(result.status).toBe("connected")
		expect(result.entries.map((entry) => entry.id)).toEqual(["hybrid/code", "local/long"])
	})

	it("falls back to the top-level combos array when data is absent", async () => {
		mockedAxiosGet.mockResolvedValueOnce({
			data: { combos: [{ name: "hybrid/reader" }] },
		})

		const result = await fetchOmniRouteCatalog("https://omniroute.example")

		expect(result.entries.map((entry) => entry.id)).toEqual(["hybrid/reader"])
	})

	it("reports an error status when the server URL is missing", async () => {
		const result = await fetchOmniRouteCatalog(undefined)
		expect(result.status).toBe("error")
		expect(result.entries).toEqual([])
		expect(mockedAxiosGet).not.toHaveBeenCalled()
	})

	it("round-trips published route metadata into the returned entries", async () => {
		mockedAxiosGet.mockResolvedValueOnce({
			data: {
				object: "list",
				data: [
					{
						name: "hybrid/code",
						strategy: "priority",
						kind: "public",
						contextWindow: 163840,
						routeCapacity: { route: "hybrid/code", capacity: 2 },
						capabilityLane: { "coder.primary": "hybrid/code" },
					},
					// A combo without the new fields still parses (fields optional).
					{ name: "local/long" },
				],
			},
		})

		const result = await fetchOmniRouteCatalog("https://omniroute.example", "secret")

		expect(result.status).toBe("connected")
		expect(result.entries).toHaveLength(2)
		const [code, long] = result.entries
		expect(code.id).toBe("hybrid/code")
		expect(code.kind).toBe("public")
		expect(code.contextWindow).toBe(163840)
		expect(code.routeCapacity).toEqual({ route: "hybrid/code", capacity: 2 })
		expect(code.capabilityLane).toEqual({ "coder.primary": "hybrid/code" })
		expect(long.id).toBe("local/long")
		expect(long.kind).toBeUndefined()
		expect(long.contextWindow).toBeUndefined()
	})
})


describe("resolveOmniRouteContextWindow", () => {
	afterEach(() => {
		__resetPublishedCatalogCache()
		__setPublishedCatalogDeps()
	})

	it("returns the mapped served window for a known route (constant fallback)", () => {
		expect(resolveOmniRouteContextWindow("hybrid/code")).toBe(163840)
		expect(resolveOmniRouteContextWindow("hybrid/planner")).toBe(262144)
		expect(resolveOmniRouteContextWindow("hybrid/reader")).toBe(32768)
	})

	it("falls back to the profile window for an unknown route when one is given", () => {
		expect(resolveOmniRouteContextWindow("hybrid/nope", 200000)).toBe(200000)
	})

	it("falls back to 128k for an unknown route with no profile window", () => {
		expect(resolveOmniRouteContextWindow("hybrid/nope")).toBe(OMNIROUTE_DEFAULT_CONTEXT_WINDOW)
		expect(resolveOmniRouteContextWindow("")).toBe(OMNIROUTE_DEFAULT_CONTEXT_WINDOW)
	})

	it("prefers the constant map over the profile window and the 128k default", () => {
		// A boilerplate profile default must not over-fill a small route or shrink a large one.
		expect(resolveOmniRouteContextWindow("hybrid/reader", 131072)).toBe(32768)
		expect(resolveOmniRouteContextWindow("hybrid/code", 32768)).toBe(163840)
	})

	it("maps every coder route to the vLLM served max-model-len", () => {
		for (const route of ["hybrid/code", "pool/tier1/code", "pool/tier2/code"]) {
			expect(OMNIROUTE_ROUTE_CONTEXT_WINDOWS[route]).toBe(163840)
		}
	})

	describe("precedence with a published catalog", () => {
		const serverUrl = "https://omniroute.example"

		it("prefers the published window over the constant, profile, and 128k", async () => {
			__setPublishedCatalogDeps({
				now: () => 1_000_000,
				fetchCatalog: vi.fn().mockResolvedValue({
					status: "connected",
					// hybrid/code is 163840 in the static map; the published catalog overrides it.
					entries: [{ id: "hybrid/code", contextWindow: 32768 }],
				}),
			})
			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", 999, serverUrl)).toBe(32768))
		})

		it("falls through to the constant when the published catalog lacks the route", async () => {
			__setPublishedCatalogDeps({
				now: () => 1_000_000,
				fetchCatalog: vi.fn().mockResolvedValue({
					status: "connected",
					entries: [{ id: "hybrid/planner", contextWindow: 32768 }],
				}),
			})
			refreshPublishedCatalogIfStale(serverUrl)
			// hybrid/code is absent from the published catalog -> constant map (163840).
			await vi.waitFor(() =>
				expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(163840),
			)
		})

		it("keys the cache by server URL so a different URL does not see the window", async () => {
			__setPublishedCatalogDeps({
				now: () => 1_000_000,
				fetchCatalog: vi.fn().mockResolvedValue({
					status: "connected",
					entries: [{ id: "hybrid/nope", contextWindow: 7777 }],
				}),
			})
			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/nope", undefined, serverUrl)).toBe(7777))
			// A different server URL has no cached catalog -> 128k default for the unknown route.
			expect(resolveOmniRouteContextWindow("hybrid/nope", undefined, "https://other.example")).toBe(
				OMNIROUTE_DEFAULT_CONTEXT_WINDOW,
			)
		})
	})

	describe("stale refresh without delaying the first request", () => {
		const serverUrl = "https://omniroute.example"

		it("does not fetch while the cache is fresh (<=60 min)", async () => {
			let clock = 1_000_000
			const fetchCatalog = vi.fn().mockResolvedValue({
				status: "connected",
				entries: [{ id: "hybrid/code", contextWindow: 50000 }],
			})
			__setPublishedCatalogDeps({ now: () => clock, fetchCatalog })

			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1))

			// Advance 59 minutes — still fresh, so no second fetch.
			clock += 59 * 60 * 1000
			refreshPublishedCatalogIfStale(serverUrl)
			expect(fetchCatalog).toHaveBeenCalledTimes(1)
		})

		it("refreshes in the background when stale >60 min and the first read uses the old value", async () => {
			let clock = 1_000_000
			const fetchCatalog = vi
				.fn()
				.mockResolvedValueOnce({ status: "connected", entries: [{ id: "hybrid/code", contextWindow: 50000 }] })
				.mockResolvedValueOnce({ status: "connected", entries: [{ id: "hybrid/code", contextWindow: 60000 }] })
			__setPublishedCatalogDeps({ now: () => clock, fetchCatalog })

			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000))

			// Advance 61 minutes: now stale. The refresh is fire-and-forget, so the read
			// taken on this same tick still returns the OLD cached value (no first-request delay).
			clock += 61 * 60 * 1000
			refreshPublishedCatalogIfStale(serverUrl)
			expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000)

			// A later read, after the background fetch resolves, gets the fresh value.
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(60000))
			expect(fetchCatalog).toHaveBeenCalledTimes(2)
		})

		it("does not stack concurrent refreshes for the same server URL", async () => {
			const clock = 1_000_000
			let resolveFetch: ((value: unknown) => void) | undefined
			const fetchCatalog = vi.fn().mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveFetch = resolve
					}),
			)
			__setPublishedCatalogDeps({ now: () => clock, fetchCatalog })

			refreshPublishedCatalogIfStale(serverUrl)
			refreshPublishedCatalogIfStale(serverUrl)
			expect(fetchCatalog).toHaveBeenCalledTimes(1)

			resolveFetch?.({ status: "connected", entries: [{ id: "hybrid/code", contextWindow: 50000 }] })
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000))
		})
	})

	describe("a failed refresh keeps the last successful published catalog", () => {
		const serverUrl = "https://omniroute.example"

		it("retains the prior window when a stale refresh errors", async () => {
			let clock = 1_000_000
			const fetchCatalog = vi
				.fn()
				.mockResolvedValueOnce({ status: "connected", entries: [{ id: "hybrid/code", contextWindow: 50000 }] })
				.mockResolvedValueOnce({ status: "error", entries: [], error: "boom" })
			__setPublishedCatalogDeps({ now: () => clock, fetchCatalog })

			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000))

			clock += 61 * 60 * 1000
			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2))

			// The error response did not overwrite the cache: the last successful window stands.
			expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000)
		})

		it("retains the prior window when a stale refresh throws", async () => {
			let clock = 1_000_000
			const fetchCatalog = vi
				.fn()
				.mockResolvedValueOnce({ status: "connected", entries: [{ id: "hybrid/code", contextWindow: 50000 }] })
				.mockRejectedValueOnce(new Error("network down"))
			__setPublishedCatalogDeps({ now: () => clock, fetchCatalog })

			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000))

			clock += 61 * 60 * 1000
			refreshPublishedCatalogIfStale(serverUrl)
			await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2))

			expect(resolveOmniRouteContextWindow("hybrid/code", undefined, serverUrl)).toBe(50000)
		})

		it("ignores an empty-key server URL and never fetches", () => {
			const fetchCatalog = vi.fn()
			__setPublishedCatalogDeps({ now: () => 1_000_000, fetchCatalog })
			refreshPublishedCatalogIfStale(undefined)
			refreshPublishedCatalogIfStale("   ")
			expect(fetchCatalog).not.toHaveBeenCalled()
		})
	})
})
