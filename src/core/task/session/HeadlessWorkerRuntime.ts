import * as vscode from "vscode"
import type { ClineProvider } from "../../webview/ClineProvider"
import { resolveWorkerPresentation, shouldCreateWorkerPanel, type WorkerPresentation } from "./workerPresentation"

export interface WorkerPanelFactory {
	createWebviewPanel: typeof vscode.window.createWebviewPanel
}

/**
 * Decide whether a parallel worker should get an editor tab. Headless (default)
 * and task-hub never auto-create panels; editor-tabs preserves the legacy path.
 */
export function resolveWorkerPresentationFromState(state: { workerPresentation?: unknown } | undefined): WorkerPresentation {
	return resolveWorkerPresentation(state?.workerPresentation)
}

export function createWorkerPanelIfNeeded(
	presentation: WorkerPresentation,
	title: string,
	extensionUri: vscode.Uri,
	tabPanelId: string,
	factory: WorkerPanelFactory = vscode.window,
): vscode.WebviewPanel | undefined {
	if (!shouldCreateWorkerPanel(presentation)) return undefined
	return factory.createWebviewPanel(
		tabPanelId,
		title,
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
	)
}

/** Lazy attach: create a panel for an already-running headless worker. */
export function createOnDemandWorkerPanel(
	title: string,
	extensionUri: vscode.Uri,
	tabPanelId: string,
	factory: WorkerPanelFactory = vscode.window,
): vscode.WebviewPanel {
	return factory.createWebviewPanel(
		tabPanelId,
		title,
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
	)
}

export type { ClineProvider }
