vi.mock("vscode", () => ({
	window: { createWebviewPanel: vi.fn() },
	ViewColumn: { Active: -1 },
	Uri: { file: (value: string) => ({ fsPath: value }) },
}))

import {
	createOnDemandWorkerPanel,
	createWorkerPanelIfNeeded,
	resolveWorkerPresentationFromState,
} from "../HeadlessWorkerRuntime"
import {
	DEFAULT_WORKER_PRESENTATION,
	isDetachableWorkerPresentation,
	resolveWorkerPresentation,
	shouldCreateWorkerPanel,
} from "../workerPresentation"

describe("worker presentation policy", () => {
	it("defaults unknown/unset values to headless", () => {
		expect(resolveWorkerPresentation(undefined)).toBe(DEFAULT_WORKER_PRESENTATION)
		expect(resolveWorkerPresentationFromState(undefined)).toBe("headless")
		expect(resolveWorkerPresentationFromState({})).toBe("headless")
		expect(resolveWorkerPresentation("nope")).toBe("headless")
	})

	it("never auto-creates panels for headless or task-hub", () => {
		expect(shouldCreateWorkerPanel("headless")).toBe(false)
		expect(shouldCreateWorkerPanel("task-hub")).toBe(false)
		expect(shouldCreateWorkerPanel("editor-tabs")).toBe(true)
		expect(isDetachableWorkerPresentation("headless")).toBe(true)
		expect(isDetachableWorkerPresentation("task-hub")).toBe(true)
		expect(isDetachableWorkerPresentation("editor-tabs")).toBe(false)
	})
})

const extensionUri = { fsPath: "/ext" } as import("vscode").Uri

describe("createWorkerPanelIfNeeded", () => {
	it("opens zero panels for ten headless workers", () => {
		const createWebviewPanel = vi.fn()
		for (let i = 0; i < 10; i++) {
			const panel = createWorkerPanelIfNeeded("headless", `Zoo: worker-${i}`, extensionUri, "zoo.tab", {
				createWebviewPanel,
			})
			expect(panel).toBeUndefined()
		}
		expect(createWebviewPanel).not.toHaveBeenCalled()
	})

	it("opens zero panels for task-hub workers", () => {
		const createWebviewPanel = vi.fn()
		expect(
			createWorkerPanelIfNeeded("task-hub", "Zoo: hub", extensionUri, "zoo.tab", {
				createWebviewPanel,
			}),
		).toBeUndefined()
		expect(createWebviewPanel).not.toHaveBeenCalled()
	})

	it("creates a panel only in editor-tabs legacy mode", () => {
		const panel = { id: "panel" }
		const createWebviewPanel = vi.fn().mockReturnValue(panel)
		expect(
			createWorkerPanelIfNeeded("editor-tabs", "Zoo: legacy", extensionUri, "zoo.tab", {
				createWebviewPanel,
			}),
		).toBe(panel)
		expect(createWebviewPanel).toHaveBeenCalledOnce()
	})

	it("creates a panel on explicit open-in-editor", () => {
		const panel = { id: "ondemand" }
		const createWebviewPanel = vi.fn().mockReturnValue(panel)
		expect(createOnDemandWorkerPanel("Zoo: inspect", extensionUri, "zoo.tab", { createWebviewPanel })).toBe(panel)
		expect(createWebviewPanel).toHaveBeenCalledOnce()
	})
})
