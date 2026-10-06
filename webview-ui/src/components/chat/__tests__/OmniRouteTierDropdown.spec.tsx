import { providerIdentifiers } from "@roo-code/types"

import { renderWithExtensionState, fireEvent, screen } from "@src/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import { OmniRouteTierDropdown } from "../OmniRouteTierDropdown"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const mockPostMessage = vscode.postMessage as ReturnType<typeof vi.fn>

const omniRouteState = {
	apiConfiguration: { apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: true },
}

/** Default controlled props for the tier dropdown (FEAT-003). */
const noopSelectTier = vi.fn()
const controlledProps = { selectedTier: undefined as number | undefined, onSelectTier: noopSelectTier }

describe("OmniRouteTierDropdown", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
		noopSelectTier.mockClear()
	})

	it("does not render for a non-OmniRoute profile", () => {
		renderWithExtensionState(<OmniRouteTierDropdown {...controlledProps} />, {
			state: { apiConfiguration: { apiProvider: providerIdentifiers.anthropic } },
		})
		expect(screen.queryByTestId("omniroute-tier-dropdown-trigger")).toBeNull()
	})

	it("does not render for an OpenAI profile that is not opted into OmniRoute", () => {
		renderWithExtensionState(<OmniRouteTierDropdown {...controlledProps} />, {
			state: { apiConfiguration: { apiProvider: providerIdentifiers.openai, openAiIsOmniRoute: false } },
		})
		expect(screen.queryByTestId("omniroute-tier-dropdown-trigger")).toBeNull()
	})

	it("renders the Default label when no tier is set (unset case)", () => {
		renderWithExtensionState(<OmniRouteTierDropdown {...controlledProps} />, { state: omniRouteState })
		const trigger = screen.getByTestId("omniroute-tier-dropdown-trigger")
		expect(trigger.textContent).toContain("Tier")
		expect(trigger.textContent).not.toContain("$")
	})

	it("shows the saved tier value from state ($$$ for tier 3)", () => {
		renderWithExtensionState(
			<OmniRouteTierDropdown {...controlledProps} selectedTier={3} />,
			{ state: { ...omniRouteState, omniRouteTier: 3 } },
		)
		expect(screen.getByTestId("omniroute-tier-dropdown-trigger").textContent).toContain("$$$")
	})

	it("saves the selected tier via updateSettings when a tier is chosen", () => {
		renderWithExtensionState(<OmniRouteTierDropdown {...controlledProps} />, { state: omniRouteState })
		fireEvent.click(screen.getByTestId("omniroute-tier-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("omniroute-tier-option-4"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { omniRouteTier: 4 },
		})
	})

	it("clears the tier (emits undefined) when Default is chosen", () => {
		renderWithExtensionState(
			<OmniRouteTierDropdown {...controlledProps} selectedTier={2} />,
			{ state: { ...omniRouteState, omniRouteTier: 2 } },
		)
		fireEvent.click(screen.getByTestId("omniroute-tier-dropdown-trigger"))
		fireEvent.click(screen.getByTestId("omniroute-tier-option-default"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { omniRouteTier: undefined },
		})
	})
})
