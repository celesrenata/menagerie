import { DEFAULT_PROVIDER } from "@/types/index.js"
import { hasRooCredential, resolveProviderPreference } from "../run.js"

describe("run provider resolution", () => {
	it("defaults to the login-free provider even when a Roo token is stored", () => {
		const result = resolveProviderPreference({
			hasStoredOrExplicitRooCredential: hasRooCredential({ storedToken: "stored-token" }),
		})

		expect(result).toEqual({
			provider: DEFAULT_PROVIDER,
			fellBackFromStoredRooPreference: false,
		})
	})

	it("falls back from saved Roo preferences when credentials are missing", () => {
		const result = resolveProviderPreference({
			settingsProvider: "roo",
			hasStoredOrExplicitRooCredential: false,
		})

		expect(result).toEqual({
			provider: DEFAULT_PROVIDER,
			fellBackFromStoredRooPreference: true,
		})
	})

	it("keeps an explicitly requested Roo provider selection", () => {
		const result = resolveProviderPreference({
			flagProvider: "roo",
			hasStoredOrExplicitRooCredential: false,
		})

		expect(result).toEqual({
			provider: "roo",
			fellBackFromStoredRooPreference: false,
		})
	})
})
