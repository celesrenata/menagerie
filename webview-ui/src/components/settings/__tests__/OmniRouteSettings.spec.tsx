import { render, screen, fireEvent, within } from "@testing-library/react"
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
	options: {
		parallelCapacityMap?: Partial<Record<string, number>>
		parallelReadDenylist?: Partial<Record<string, string[]>>
		publishedLaneRouting?: boolean
		setCachedStateField?: (...args: unknown[]) => void
	} = {},
) =>
	render(
		<TooltipProvider>
			<OmniRouteSettings
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField as never}
				parallelCapacityMap={options.parallelCapacityMap as never}
				parallelReadDenylist={options.parallelReadDenylist as never}
				publishedLaneRouting={options.publishedLaneRouting}
				setCachedStateField={(options.setCachedStateField ?? vi.fn()) as never}
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

describe("OmniRouteSettings — route-reference flags (Requirement 15)", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not validate references until a successful refresh with a published Public_Route", () => {
		renderSettings({ ...baseConfig, openAiModelId: "pool/tier2/reader" })
		// No catalog yet ⇒ references not validated, no flags.
		expect(screen.getByTestId("omniroute-route-flags-not-validated")).toBeInTheDocument()
		expect(screen.queryByTestId("omniroute-route-flag-openAiModelId")).not.toBeInTheDocument()
	})

	it("flags a missing route reference after a successful refresh", () => {
		renderSettings({ ...baseConfig, openAiModelId: "auto/gemma" })
		postCatalog({
			status: "connected",
			entries: [{ id: "hybrid/code", kind: "public" }],
		})
		const flag = screen.getByTestId("omniroute-route-flag-openAiModelId")
		expect(flag).toHaveAttribute("data-flag-id", "auto/gemma")
		expect(flag).toHaveAttribute("data-flag-reason", "missing")
		// References were validated ⇒ the "not validated" note is gone.
		expect(screen.queryByTestId("omniroute-route-flags-not-validated")).not.toBeInTheDocument()
	})

	it("flags an internal/diagnostic route reference as internal", () => {
		renderSettings({ ...baseConfig, openAiOmniRouteReaderRouteId: "pool/tier2/reader" })
		postCatalog({
			status: "connected",
			entries: [
				{ id: "hybrid/code", kind: "public" },
				{ id: "pool/tier2/reader", kind: "internal" },
			],
		})
		const flag = screen.getByTestId("omniroute-route-flag-openAiOmniRouteReaderRouteId")
		expect(flag).toHaveAttribute("data-flag-id", "pool/tier2/reader")
		expect(flag).toHaveAttribute("data-flag-reason", "internal")
	})

	it("flags a direct provider model id as direct-model", () => {
		renderSettings({ ...baseConfig, openAiModelId: "ollama/code" })
		postCatalog({
			status: "connected",
			entries: [
				{ id: "hybrid/code", kind: "public" },
				// A model-shaped entry (carries model metadata, no route kind) = direct model id.
				{ id: "ollama/code", name: "Ollama Code", family: "ollama" },
			],
		})
		const flag = screen.getByTestId("omniroute-route-flag-openAiModelId")
		expect(flag).toHaveAttribute("data-flag-id", "ollama/code")
		expect(flag).toHaveAttribute("data-flag-reason", "direct-model")
	})

	it("does not flag a reference that matches a published public route or alias (case-sensitive)", () => {
		renderSettings({ ...baseConfig, openAiModelId: "hybrid/code", openAiOmniRouteReasonerRouteId: "code" })
		postCatalog({
			status: "connected",
			entries: [
				{ id: "hybrid/code", kind: "public" },
				{ id: "code", kind: "alias" },
			],
		})
		expect(screen.queryByTestId("omniroute-route-flag-openAiModelId")).not.toBeInTheDocument()
		expect(screen.queryByTestId("omniroute-route-flag-openAiOmniRouteReasonerRouteId")).not.toBeInTheDocument()
	})

	it("flags a case-mismatched reference as missing (exact-match including case)", () => {
		renderSettings({ ...baseConfig, openAiModelId: "Hybrid/Code" })
		postCatalog({
			status: "connected",
			entries: [{ id: "hybrid/code", kind: "public" }],
		})
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toHaveAttribute(
			"data-flag-reason",
			"missing",
		)
	})

	it("flags each flagged custom route id", () => {
		renderSettings({
			...baseConfig,
			openAiOmniRouteCustomRoutes: [{ name: "overflow", modelId: "pool/dead" }],
		})
		postCatalog({
			status: "connected",
			entries: [
				{ id: "hybrid/code", kind: "public" },
				{ id: "pool/dead", kind: "diagnostic" },
			],
		})
		const flag = screen.getByTestId("omniroute-route-flag-openAiOmniRouteCustomRoutes[overflow]")
		expect(flag).toHaveAttribute("data-flag-id", "pool/dead")
		expect(flag).toHaveAttribute("data-flag-reason", "internal")
	})

	it("replaces prior flags on a later successful refresh", () => {
		renderSettings({ ...baseConfig, openAiModelId: "auto/gemma" })
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		// A later refresh that now publishes the route clears the flag.
		postCatalog({
			status: "connected",
			entries: [
				{ id: "hybrid/code", kind: "public" },
				{ id: "auto/gemma", kind: "public" },
			],
		})
		expect(screen.queryByTestId("omniroute-route-flag-openAiModelId")).not.toBeInTheDocument()
	})

	it("keeps the existing flags on a failed refresh and marks references not validated", () => {
		renderSettings({ ...baseConfig, openAiModelId: "auto/gemma" })
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		// A failed refresh keeps the prior flag and shows the not-validated note.
		postCatalog({ status: "error", entries: [], error: "unreachable" })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		expect(screen.getByTestId("omniroute-route-flags-not-validated")).toBeInTheDocument()
	})

	it("keeps the existing flags on a refresh that returns no Public_Route", () => {
		renderSettings({ ...baseConfig, openAiModelId: "auto/gemma" })
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		// A connected refresh with only non-public entries does not re-validate.
		postCatalog({ status: "connected", entries: [{ id: "pool/x", kind: "internal" }] })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		expect(screen.getByTestId("omniroute-route-flags-not-validated")).toBeInTheDocument()
	})

	it("flags the codebase-index embedder id only when its base URL shares the catalog origin", () => {
		const { rerender } = render(
			<TooltipProvider>
				<OmniRouteSettings
					apiConfiguration={baseConfig}
					setApiConfigurationField={vi.fn() as never}
					setCachedStateField={vi.fn() as never}
					codebaseIndexEmbedderModelId={"nomic-embed"}
					codebaseIndexEmbedderBaseUrl={"https://omniroute.example"}
				/>
			</TooltipProvider>,
		)
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.getByTestId("omniroute-route-flag-codebaseIndexEmbedderModelId")).toHaveAttribute(
			"data-flag-id",
			"nomic-embed",
		)

		// A different-origin embedder base URL is not validated against this catalog.
		rerender(
			<TooltipProvider>
				<OmniRouteSettings
					apiConfiguration={baseConfig}
					setApiConfigurationField={vi.fn() as never}
					setCachedStateField={vi.fn() as never}
					codebaseIndexEmbedderModelId={"nomic-embed"}
					codebaseIndexEmbedderBaseUrl={"https://other.example"}
				/>
			</TooltipProvider>,
		)
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.queryByTestId("omniroute-route-flag-codebaseIndexEmbedderModelId")).not.toBeInTheDocument()
	})

	it("never rewrites a saved reference or posts a message when flagging (display-only)", () => {
		const setApiConfigurationField = vi.fn()
		renderSettings({ ...baseConfig, openAiModelId: "auto/gemma" }, setApiConfigurationField)
		mockPostMessage.mockClear()
		postCatalog({ status: "connected", entries: [{ id: "hybrid/code", kind: "public" }] })
		expect(screen.getByTestId("omniroute-route-flag-openAiModelId")).toBeInTheDocument()
		// Flagging must not rewrite the saved value nor send any message (Req 15.5/15.8).
		expect(setApiConfigurationField).not.toHaveBeenCalled()
		expect(mockPostMessage).not.toHaveBeenCalled()
	})
})

describe("OmniRouteSettings parallel capacity map", () => {
	beforeEach(() => vi.clearAllMocks())

	it("renders a numeric input per capability, always visible (not gated on isOmniRoute)", () => {
		// `openAiIsOmniRoute` unset ⇒ the OmniRoute body is hidden, but the fleet-wide
		// capacity grid is still rendered because it is outside the isOmniRoute guard.
		renderSettings({ apiProvider: providerIdentifiers.openai })
		for (const capability of ["reader", "reasoner", "long-context", "general", "vision"]) {
			expect(screen.getByTestId(`parallel-capacity-${capability}`)).toBeInTheDocument()
		}
	})

	it("seeds the inputs from a persisted parallelCapacityMap and leaves unset capabilities blank", () => {
		renderSettings(baseConfig, vi.fn(), { parallelCapacityMap: { reader: 6 } })
		const readerInput = screen.getByTestId("parallel-capacity-reader") as HTMLInputElement
		const reasonerInput = screen.getByTestId("parallel-capacity-reasoner") as HTMLInputElement
		expect(readerInput.value).toBe("6")
		expect(reasonerInput.value).toBe("")
	})

	it("writes a valid positive integer back to cachedState via setCachedStateField", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), { parallelCapacityMap: {}, setCachedStateField })
		fireEvent.input(screen.getByTestId("parallel-capacity-reader"), { target: { value: "8" } })
		expect(setCachedStateField).toHaveBeenCalledWith("parallelCapacityMap", { reader: 8 })
	})

	it("deletes the key when an input is cleared so the capability falls back to default", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), { parallelCapacityMap: { reader: 6 }, setCachedStateField })
		fireEvent.input(screen.getByTestId("parallel-capacity-reader"), { target: { value: "" } })
		expect(setCachedStateField).toHaveBeenCalledWith("parallelCapacityMap", {})
	})

	it("deletes the key for a non-positive / non-integer entry (floor-of-1 preserved at the control)", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), { parallelCapacityMap: { reasoner: 2 }, setCachedStateField })
		fireEvent.input(screen.getByTestId("parallel-capacity-reasoner"), { target: { value: "0" } })
		expect(setCachedStateField).toHaveBeenCalledWith("parallelCapacityMap", {})
	})
})

describe("OmniRouteSettings — parallel read exclusions (FEAT-003)", () => {
	beforeEach(() => vi.clearAllMocks())

	it("renders one textarea per denylist category, always visible (not gated on isOmniRoute)", () => {
		// `openAiIsOmniRoute` unset ⇒ the OmniRoute body is hidden, but the fleet-wide
		// read-exclusions editor is still rendered because it is outside the guard.
		renderSettings({ apiProvider: providerIdentifiers.openai })
		for (const field of ["vendoredDirs", "rootDirs", "files", "globs"]) {
			expect(screen.getByTestId(`parallel-read-exclusions-${field}`)).toBeInTheDocument()
		}
	})

	it("seeds each textarea from the persisted cachedState denylist (never live state)", () => {
		renderSettings(baseConfig, vi.fn(), {
			parallelReadDenylist: { globs: ["**/*.min.js", "**/*.map"], files: ["package-lock.json"] },
		})
		const globs = screen.getByTestId("parallel-read-exclusions-globs") as HTMLTextAreaElement
		const files = screen.getByTestId("parallel-read-exclusions-files") as HTMLTextAreaElement
		const rootDirs = screen.getByTestId("parallel-read-exclusions-rootDirs") as HTMLTextAreaElement

		expect(globs.value).toBe("**/*.min.js\n**/*.map")
		expect(files.value).toBe("package-lock.json")
		expect(rootDirs.value).toBe("")
	})

	it("writes an edited category back to cachedState as a trimmed, blank-filtered array", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), {
			parallelReadDenylist: { files: ["package-lock.json"] },
			setCachedStateField,
		})
		fireEvent.input(screen.getByTestId("parallel-read-exclusions-globs"), {
			target: { value: "  **/*.min.js \n\n **/*.css.map  " },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("parallelReadDenylist", {
			files: ["package-lock.json"],
			globs: ["**/*.min.js", "**/*.css.map"],
		})
	})

	it("emptying a category writes an explicit [] so the save payload clears it (per-field replace)", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), {
			parallelReadDenylist: { globs: ["**/typescript/lib/*.d.ts"] },
			setCachedStateField,
		})
		fireEvent.input(screen.getByTestId("parallel-read-exclusions-globs"), { target: { value: "" } })

		expect(setCachedStateField).toHaveBeenCalledWith("parallelReadDenylist", { globs: [] })
	})
})

describe("OmniRouteSettings — published lane routing (Requirement 14.6)", () => {
	beforeEach(() => vi.clearAllMocks())

	// The published-lane-routing control toggles the number of distinct inputs the
	// vscrui Checkbox renders inside the labelled wrapper; the real checkbox input
	// lives inside the `data-testid` label element.
	const laneRoutingInput = () =>
		within(screen.getByTestId("omniroute-published-lane-routing")).getByRole("checkbox") as HTMLInputElement

	it("binds the checkbox to cachedState via setCachedStateField, not live state", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), { publishedLaneRouting: false, setCachedStateField })
		// Default off (unset case): the control reads the cachedState prop, not live state.
		expect(laneRoutingInput().checked).toBe(false)

		fireEvent.click(laneRoutingInput())
		// Toggling writes the enabled value to cachedState (buffered until Save).
		expect(setCachedStateField).toHaveBeenCalledWith("openAiOmniRoutePublishedLaneRouting", true)
	})

	it("renders the enabled (true) case from the cachedState prop", () => {
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, vi.fn(), { publishedLaneRouting: true, setCachedStateField })
		expect(laneRoutingInput().checked).toBe(true)

		// Toggling an enabled control off writes false to cachedState.
		fireEvent.click(laneRoutingInput())
		expect(setCachedStateField).toHaveBeenCalledWith("openAiOmniRoutePublishedLaneRouting", false)
	})

	it("defaults to off when the cachedState prop is unset (undefined)", () => {
		renderSettings(baseConfig, vi.fn(), {})
		expect(laneRoutingInput().checked).toBe(false)
	})

	it("never writes the setting through setApiConfigurationField (it is a global cachedState setting)", () => {
		const setApiConfigurationField = vi.fn()
		const setCachedStateField = vi.fn()
		renderSettings(baseConfig, setApiConfigurationField, { publishedLaneRouting: false, setCachedStateField })
		fireEvent.click(laneRoutingInput())
		expect(setApiConfigurationField).not.toHaveBeenCalledWith(
			"openAiOmniRoutePublishedLaneRouting",
			expect.anything(),
		)
	})
})
