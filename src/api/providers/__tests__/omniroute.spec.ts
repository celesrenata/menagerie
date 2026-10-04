import { describe, it, expect, vi, beforeEach } from "vitest"

import axios from "axios"

import { providerIdentifiers, omniRouteCatalogEntrySchema, omniRouteComboEntrySchema } from "@roo-code/types"

import {
	fetchOmniRouteCatalog,
	isOmniRoute,
	omniRouteRequestHeaders,
	omniRouteTokenizedBaseUrl,
	OMNIROUTE_PUBLIC_TOKEN,
	OMNIROUTE_TIER_HEADER,
	withOmniRouteTier,
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
})
