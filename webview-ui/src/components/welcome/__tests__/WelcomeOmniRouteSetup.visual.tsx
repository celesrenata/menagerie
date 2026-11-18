import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders first-run OmniRoute provider setup in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 900 })
		const component = mountedStory(await mount("welcome-omniroute-setup"))
		await applyVisualTheme(page, theme)
		await component
			.getByRole("button", { name: /provider/i })
			.first()
			.click()

		const omniRouteChoice = component.getByTestId("welcome-setup-omniroute")
		await expect(omniRouteChoice).toHaveAttribute("aria-pressed", "true")
		await expect(component.getByTestId("omniroute-check-connection")).toBeVisible()

		const screen = component.locator(".fixed.inset-0")
		await expect(screen).toHaveScreenshot(`welcome-omniroute-setup-${theme.name}.png`)
		await expectBoundedLayout(page, component, {
			actionRows: [omniRouteChoice.locator("..")],
			focusedControl: omniRouteChoice,
		})
	})
}
