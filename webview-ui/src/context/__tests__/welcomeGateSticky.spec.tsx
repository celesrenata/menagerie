// npx vitest run src/context/__tests__/welcomeGateSticky.spec.tsx

import { providerIdentifiers } from "@roo-code/types"
import type { ExtensionState } from "@roo-code/types"
import { render, screen, act } from "@/utils/test-utils"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const WelcomeGateProbe = () => {
	const { showWelcome, didHydrateState } = useExtensionState()
	return (
		<div>
			<div data-testid="show-welcome">{JSON.stringify(showWelcome)}</div>
			<div data-testid="did-hydrate">{JSON.stringify(didHydrateState)}</div>
		</div>
	)
}

const dispatchState = (state: Partial<ExtensionState>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})
}

const getShowWelcome = () => JSON.parse(screen.getByTestId("show-welcome").textContent!)

describe("welcome gate stickiness", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// A valid, configured Zoo Gateway state (authenticated via global login).
	const configuredState = (): Partial<ExtensionState> => ({
		apiConfiguration: { apiProvider: providerIdentifiers.zooGateway },
		zooCodeIsAuthenticated: true,
	})

	// A transient, task-scoped push seen mid-open: the task-scoped apiConfiguration is
	// under-configured and the cached auth flag is momentarily cold. The presence of
	// `currentTaskId` marks this push as task-scoped.
	const transientTaskScopedState = (): Partial<ExtensionState> => ({
		apiConfiguration: { apiProvider: providerIdentifiers.zooGateway },
		zooCodeIsAuthenticated: false,
		currentTaskId: "task-123",
	})

	it("keeps the welcome gate down when a task-scoped under-configured push follows a valid state", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeGateProbe />
			</ExtensionStateContextProvider>,
		)

		// 1. A valid configured state lowers the gate.
		dispatchState(configuredState())
		expect(getShowWelcome()).toBe(false)

		// 2. During a task open, an intermediate task-scoped push carries an under-configured
		//    apiConfiguration and a cold auth flag. This must NOT bounce the user to WelcomeView.
		dispatchState(transientTaskScopedState())
		expect(getShowWelcome()).toBe(false)

		// 3. A final authoritative push restores the valid state; gate stays down.
		dispatchState(configuredState())
		expect(getShowWelcome()).toBe(false)
	})

	it("still shows the welcome gate on a genuinely unconfigured fresh install", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeGateProbe />
			</ExtensionStateContextProvider>,
		)

		// Fresh install: no provider configured and not authenticated.
		dispatchState({ apiConfiguration: {}, zooCodeIsAuthenticated: false })
		expect(getShowWelcome()).toBe(true)
	})

	it("dismisses the welcome gate when sign-in completes after a fresh install", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeGateProbe />
			</ExtensionStateContextProvider>,
		)

		dispatchState({ apiConfiguration: {}, zooCodeIsAuthenticated: false })
		expect(getShowWelcome()).toBe(true)

		// Sign-in arrives: gate drops.
		dispatchState(configuredState())
		expect(getShowWelcome()).toBe(false)
	})

	it("re-raises the welcome gate on an authoritative, non-task-scoped sign-out push", () => {
		render(
			<ExtensionStateContextProvider>
				<WelcomeGateProbe />
			</ExtensionStateContextProvider>,
		)

		// Authenticated first.
		dispatchState(configuredState())
		expect(getShowWelcome()).toBe(false)

		// Explicit sign-out: authoritative global apiConfiguration is now unconfigured and there
		// is no current task scoping this push, so the gate returns to WelcomeView.
		dispatchState({ apiConfiguration: {}, zooCodeIsAuthenticated: false })
		expect(getShowWelcome()).toBe(true)
	})
})
