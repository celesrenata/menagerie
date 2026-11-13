import { render, fireEvent, screen, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { vscode } from "@/utils/vscode"

import { SkillHubSettings } from "../SkillHubSettings"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const catalog = [
	{ id: "s1", name: "alpha", description: "Alpha skill" },
	{ id: "s2", name: "beta", description: "Beta skill" },
]

const postFromExtension = (data: unknown) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

describe("SkillHubSettings remove key", () => {
	it("shows Remove only when a key is saved and posts clearSkillHubApiKey", () => {
		const { rerender } = render(<SkillHubSettings skillHubEnabled={true} setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("skill-hub-remove-key")).toBeNull()
		rerender(<SkillHubSettings skillHubEnabled={true} skillHubApiKeySet={true} setCachedStateField={vi.fn()} />)
		fireEvent.click(screen.getByTestId("skill-hub-remove-key"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearSkillHubApiKey" })
	})
})
describe("SkillHubSettings", () => {
	const setCachedStateField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("defaults to disabled, hides the skill list and does not request the catalog", () => {
		render(<SkillHubSettings setCachedStateField={setCachedStateField} />)
		expect((screen.getByTestId("skill-hub-enabled-checkbox") as HTMLInputElement).checked).toBe(false)
		expect(screen.queryByTestId("skill-hub-refresh")).toBeNull()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("reflects an explicit true and an explicit false", () => {
		const { rerender } = render(
			<SkillHubSettings skillHubEnabled={true} setCachedStateField={setCachedStateField} />,
		)
		expect((screen.getByTestId("skill-hub-enabled-checkbox") as HTMLInputElement).checked).toBe(true)
		rerender(<SkillHubSettings skillHubEnabled={false} setCachedStateField={setCachedStateField} />)
		expect((screen.getByTestId("skill-hub-enabled-checkbox") as HTMLInputElement).checked).toBe(false)
	})

	it("writes edits to cached state fields", () => {
		render(<SkillHubSettings skillHubEnabled={true} setCachedStateField={setCachedStateField} />)

		fireEvent.click(screen.getByTestId("skill-hub-enabled-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("skillHubEnabled", false)

		fireEvent.change(screen.getByTestId("skill-hub-url-input"), { target: { value: "http://hub:20128" } })
		expect(setCachedStateField).toHaveBeenCalledWith("skillHubBaseUrl", "http://hub:20128")

		fireEvent.change(screen.getByTestId("skill-hub-max-input"), { target: { value: "4" } })
		expect(setCachedStateField).toHaveBeenCalledWith("skillHubMaxSkills", 4)

		fireEvent.change(screen.getByTestId("skill-hub-key-input"), { target: { value: "sk-new" } })
		expect(setCachedStateField).toHaveBeenCalledWith("skillHubApiKey", "sk-new")
	})

	it("renders the key as a write-only password field and never shows a stored key", () => {
		render(
			<SkillHubSettings
				skillHubEnabled={true}
				skillHubApiKeySet={true}
				setCachedStateField={setCachedStateField}
			/>,
		)
		const input = screen.getByTestId("skill-hub-key-input") as HTMLInputElement
		expect(input.type).toBe("password")
		expect(input.value).toBe("")
		expect(input.placeholder).toMatch(/saved/i)
	})

	it("requests the catalog once enabled with a stored key", () => {
		render(
			<SkillHubSettings
				skillHubEnabled={true}
				skillHubApiKeySet={true}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestSkillHubCatalog" })
	})

	it("shows each hub skill with its saved state and defaults unset skills to auto", () => {
		render(
			<SkillHubSettings
				skillHubEnabled={true}
				skillHubSkillModes={{ s1: "on" }}
				setCachedStateField={setCachedStateField}
			/>,
		)
		postFromExtension({ type: "skillHubCatalog", skillHubCatalog: catalog })
		expect((screen.getByTestId("skill-hub-mode-s1") as HTMLSelectElement).value).toBe("on")
		expect((screen.getByTestId("skill-hub-mode-s2") as HTMLSelectElement).value).toBe("auto")
	})

	it("sets on/off and removes the entry for auto, keeping other skills' states", () => {
		render(
			<SkillHubSettings
				skillHubEnabled={true}
				skillHubSkillModes={{ s1: "on", s2: "off" }}
				setCachedStateField={setCachedStateField}
			/>,
		)
		postFromExtension({ type: "skillHubCatalog", skillHubCatalog: catalog })

		fireEvent.change(screen.getByTestId("skill-hub-mode-s1"), { target: { value: "off" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("skillHubSkillModes", { s1: "off", s2: "off" })

		fireEvent.change(screen.getByTestId("skill-hub-mode-s2"), { target: { value: "auto" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("skillHubSkillModes", { s1: "on" })
	})

	it("shows the sanitized error when the hub is unavailable", () => {
		render(<SkillHubSettings skillHubEnabled={true} setCachedStateField={setCachedStateField} />)
		postFromExtension({
			type: "skillHubCatalog",
			skillHubCatalog: [],
			skillHubCatalogError: "Skill Hub rejected the key (401)",
		})
		expect(screen.getByTestId("skill-hub-error").textContent).toBe("Skill Hub rejected the key (401)")
	})

	it("refresh asks the extension for the catalog again", () => {
		render(<SkillHubSettings skillHubEnabled={true} setCachedStateField={setCachedStateField} />)
		fireEvent.click(screen.getByTestId("skill-hub-refresh"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestSkillHubCatalog" })
	})
})
