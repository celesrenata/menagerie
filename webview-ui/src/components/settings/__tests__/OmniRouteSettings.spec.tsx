import { render, screen, fireEvent } from "@testing-library/react"
import { vi, describe, it, expect, beforeEach } from "vitest"

import type { OmniRouteCatalogResponse, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import { TooltipProvider } from "@src/components/ui/tooltip"

const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: (...args: unknown[]) => mockPostMessage(...args) },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
	}),
}))

import { OmniRouteSettings } from "../OmniRouteSettings"

const baseConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.openai,
	openAiIsOmniRoute: true,
	openAiBaseUrl: "https://omniroute.example",
	openAiApiKey: "secret",
}

const postCatalog = (response: OmniRouteCatalogResponse) => {
	fireEvent(window, new MessageEvent("message", { data: { type: "omniRouteCatalog", omniRouteCatalog: response } }))
}

const renderSettings = (
	apiConfiguration: ProviderSettings,
	setApiConfigurationField: (...args: unknown[]) => void = vi.fn(),
) =>
	render(
		<TooltipProvider>
			<OmniRouteSettings
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField as never}
			/>
		</TooltipProvider>,
	)

describe("OmniRouteSettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("binds the OmniRoute opt-in checkbox to cachedState via setApiConfigurationField", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings({ apiProvider: providerIdentifiers.openai }, setApiConfigurationField)
		fireEvent.click(screen.getByText("settings:omniroute.useOmniRoute"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiIsOmniRoute", true)
	})

	it("posts a catalog request with the unsaved server url + key when checking the connection", () => {
		renderSettings(baseConfig)
		fireEvent.click(screen.getByTestId("omniroute-check-connection"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "requestOmniRouteCatalog",
			values: { serverUrl: "https://omniroute.example", apiKey: "secret" },
		})
	})

	it("renders the catalog from a response and selects a model id on click", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(baseConfig, setApiConfigurationField)
		postCatalog({
			status: "connected",
			entries: [
				{ id: "qwen3-27b", name: "Qwen3 27B" },
				{ id: "gpt-5.5-codex", name: "GPT 5.5 Codex" },
			],
		})
		fireEvent.click(screen.getByTestId("omniroute-model-qwen3-27b"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiModelId", "qwen3-27b")
	})

	it("sets the reader/reasoner route ids on cachedState", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(baseConfig, setApiConfigurationField)
		fireEvent.input(screen.getByTestId("omniroute-reader-route"), { target: { value: "fast-id" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteReaderRouteId", "fast-id")
		fireEvent.input(screen.getByTestId("omniroute-reasoner-route"), { target: { value: "big-id" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteReasonerRouteId", "big-id")
	})

	it("shows an error status when the catalog fetch fails", () => {
		renderSettings(baseConfig)
		postCatalog({ status: "error", entries: [], error: "unreachable" })
		expect(screen.getByTestId("omniroute-status")).toHaveTextContent("settings:omniroute.status.error")
	})

	it("adds a custom route carrying the selected capability", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(baseConfig, setApiConfigurationField)
		fireEvent.input(screen.getByTestId("omniroute-new-route-name"), { target: { value: "overflow" } })
		fireEvent.input(screen.getByTestId("omniroute-new-route-model"), { target: { value: "ollama/code" } })
		fireEvent.change(screen.getByTestId("omniroute-new-route-capability"), { target: { value: "reasoner" } })
		fireEvent.click(screen.getByTestId("omniroute-add-route"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteCustomRoutes", [
			{ name: "overflow", modelId: "ollama/code", capability: "reasoner" },
		])
	})

	it("adds a custom route with no capability when the selection is left unclassified", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(baseConfig, setApiConfigurationField)
		fireEvent.input(screen.getByTestId("omniroute-new-route-name"), { target: { value: "legacy" } })
		fireEvent.input(screen.getByTestId("omniroute-new-route-model"), { target: { value: "hybrid/code" } })
		fireEvent.click(screen.getByTestId("omniroute-add-route"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteCustomRoutes", [
			{ name: "legacy", modelId: "hybrid/code" },
		])
	})

	it("updates an existing route's capability via the per-row select", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(
			{ ...baseConfig, openAiOmniRouteCustomRoutes: [{ name: "overflow", modelId: "ollama/code" }] },
			setApiConfigurationField,
		)
		fireEvent.change(screen.getByTestId("omniroute-route-capability-0"), { target: { value: "general" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteCustomRoutes", [
			{ name: "overflow", modelId: "ollama/code", capability: "general" },
		])
	})

	it("clearing a route's capability drops the field (back to unclassified)", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings(
			{
				...baseConfig,
				openAiOmniRouteCustomRoutes: [{ name: "overflow", modelId: "ollama/code", capability: "reasoner" }],
			},
			setApiConfigurationField,
		)
		fireEvent.change(screen.getByTestId("omniroute-route-capability-0"), { target: { value: "" } })
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiOmniRouteCustomRoutes", [
			{ name: "overflow", modelId: "ollama/code" },
		])
	})

	it("renders an existing route with no capability without error (back-compat)", () => {
		renderSettings({ ...baseConfig, openAiOmniRouteCustomRoutes: [{ name: "legacy", modelId: "hybrid/code" }] })
		const select = screen.getByTestId("omniroute-route-capability-0") as HTMLSelectElement
		expect(select.value).toBe("")
	})
})
