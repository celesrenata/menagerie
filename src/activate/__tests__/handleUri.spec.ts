vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
	},
}))

import * as vscode from "vscode"

import { handleUri } from "../handleUri"

const mockVisibleProvider = {
	handleOpenRouterCallback: vi.fn(),
	handleRequestyCallback: vi.fn(),
} as any

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: {
		getVisibleInstance: vi.fn(() => mockVisibleProvider),
	},
}))

describe("handleUri", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("ignores legacy cloud auth callback", async () => {
		await handleUri({
			path: "/auth/clerk/callback",
			query: "code=test-code&state=test-state&organizationId=test-org",
		} as any)

		expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})
})
