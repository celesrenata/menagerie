import type * as vscode from "vscode"
import { describe, expect, it, vi } from "vitest"

describe("DecorationController decoration types", () => {
	it("are not created at import time, and are created once on first use", async () => {
		vi.resetModules()
		// Import vscode AFTER the reset so the spy is on the same mock instance the controller will see.
		const host = await import("vscode")
		const create = vi.spyOn(host.window, "createTextEditorDecorationType")
		create.mockClear()
		const { DecorationController } = await import("../DecorationController")
		expect(create).not.toHaveBeenCalled() // importing must not require a full vscode.window

		const editor = { setDecorations: vi.fn() } as unknown as vscode.TextEditor
		const faded = new DecorationController("fadedOverlay", editor)
		const first = faded.getDecoration()
		const second = faded.getDecoration()
		expect(first).toBe(second)
		expect(create).toHaveBeenCalledTimes(1)

		new DecorationController("activeLine", editor).getDecoration()
		expect(create).toHaveBeenCalledTimes(2)
	})
})
