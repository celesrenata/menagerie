import { getRooProviderModels } from "./use-roo-provider-models"

describe("getRooProviderModels", () => {
	const originalCatalogUrl = process.env.NEXT_PUBLIC_ROO_EVALS_MODEL_CATALOG_URL

	beforeEach(() => {
		vi.unstubAllGlobals()
		delete process.env.NEXT_PUBLIC_ROO_EVALS_MODEL_CATALOG_URL
	})

	afterAll(() => {
		if (originalCatalogUrl === undefined) {
			delete process.env.NEXT_PUBLIC_ROO_EVALS_MODEL_CATALOG_URL
		} else {
			process.env.NEXT_PUBLIC_ROO_EVALS_MODEL_CATALOG_URL = originalCatalogUrl
		}
	})

	it("returns an empty list when no Roo model catalog URL is configured", async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)

		await expect(getRooProviderModels()).resolves.toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("filters deprecated models and sorts the remaining catalog entries", async () => {
		process.env.NEXT_PUBLIC_ROO_EVALS_MODEL_CATALOG_URL = "https://catalog.example.test/models"
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					object: "list",
					data: [
						{
							object: "model",
							id: "z-model",
							name: "Zulu",
							context_window: 1,
							max_tokens: 1,
							type: "language",
							owned_by: "roo",
							pricing: { input: "0", output: "0" },
							created: 1,
						},
						{
							object: "model",
							id: "a-model",
							name: "Alpha",
							context_window: 1,
							max_tokens: 1,
							type: "language",
							owned_by: "roo",
							pricing: { input: "0", output: "0" },
							created: 1,
						},
						{
							object: "model",
							id: "old-model",
							name: "Deprecated",
							context_window: 1,
							max_tokens: 1,
							type: "language",
							owned_by: "roo",
							pricing: { input: "0", output: "0" },
							created: 1,
							deprecated: true,
						},
					],
				}),
			}),
		)

		await expect(getRooProviderModels()).resolves.toMatchObject([
			{ id: "a-model", name: "Alpha" },
			{ id: "z-model", name: "Zulu" },
		])
	})
})
