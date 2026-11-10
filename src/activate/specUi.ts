import * as vscode from "vscode"

import type { SpecUi } from "../core/specs/specCommands"

/** Thin VS Code adapter for the spec import/approval flows. All decisions live in `core/specs/specCommands`. */
export function createVscodeSpecUi(): SpecUi {
	return {
		async chooseFile(defaultDir) {
			const picked = await vscode.window.showOpenDialog({
				defaultUri: vscode.Uri.file(defaultDir),
				canSelectMany: false,
				filters: { "Spec draft": ["json"] },
				openLabel: "Import spec draft",
			})
			return picked?.[0]?.fsPath
		},
		async chooseRevision(items) {
			const picked = await vscode.window.showQuickPick(
				items.map((i) => ({ label: i.label, detail: i.detail, id: i.id })),
				{ placeHolder: "Choose a spec revision to review for approval" },
			)
			return picked?.id
		},
		async confirm(message, detail, actionLabel) {
			// Modal, and only an explicit click on the action counts. Escape/close returns undefined.
			const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, actionLabel)
			return choice === actionLabel
		},
		info: (message) => void vscode.window.showInformationMessage(message),
		warn: (message) => void vscode.window.showWarningMessage(message),
	}
}
