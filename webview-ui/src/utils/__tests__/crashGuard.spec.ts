import { afterEach, describe, expect, it, vi } from "vitest"
import { activateCrashGuard, resetCrashGuardForTesting } from "../crashGuard"

/** Mount a populated #root so the guard watches it. */
function mountRoot(): HTMLElement {
	document.body.innerHTML = ""
	const root = document.createElement("div")
	root.id = "root"
	const app = document.createElement("div")
	app.textContent = "Zoo Code app content"
	root.append(app)
	document.body.append(root)
	return root
}

/** Yield to microtasks so the MutationObserver callback runs. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("crashGuard", () => {
	afterEach(() => {
		resetCrashGuardForTesting()
		document.body.innerHTML = ""
		vi.restoreAllMocks()
	})

	it("records uncaught window errors", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		activateCrashGuard()

		window.dispatchEvent(Object.assign(new Event("error"), { message: "boom" }))

		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[crashGuard:window.error]"), expect.any(Error))
	})

	it("records unhandled promise rejections", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		activateCrashGuard()

		window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("rejected") }))

		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("[crashGuard:unhandledrejection]"),
			expect.any(Error),
		)
	})

	it("shows a diagnostic overlay when #root is emptied (the gray state)", async () => {
		const root = mountRoot()
		vi.spyOn(console, "error").mockImplementation(() => {})
		activateCrashGuard()

		expect(document.getElementById("crash-guard-overlay")).toBeNull()

		root.firstChild?.remove()
		await flush()

		const overlay = document.getElementById("crash-guard-overlay")
		expect(overlay).not.toBeNull()
		expect(overlay?.textContent).toContain("Zoo Code webview crashed")
	})

	it("hides the overlay again once React re-renders into #root", async () => {
		const root = mountRoot()
		vi.spyOn(console, "error").mockImplementation(() => {})
		activateCrashGuard()

		root.firstChild?.remove()
		await flush()
		expect(document.getElementById("crash-guard-overlay")).not.toBeNull()

		const restored = document.createElement("div")
		restored.textContent = "app restored"
		root.append(restored)
		await flush()

		expect(document.getElementById("crash-guard-overlay")).toBeNull()
	})

	it("notes when no errors were recorded before the tree was destroyed", async () => {
		const root = mountRoot()
		vi.spyOn(console, "error").mockImplementation(() => {})
		activateCrashGuard()

		root.textContent = ""
		await flush()

		const overlay = document.getElementById("crash-guard-overlay")
		expect(overlay).not.toBeNull()
		expect(overlay?.textContent).toContain("No uncaught errors were recorded")
	})
})
