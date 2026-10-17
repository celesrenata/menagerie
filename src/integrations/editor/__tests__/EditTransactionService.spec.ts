import * as vscode from "vscode"
import { changeIndex } from "../ChangeIndex"
import {
	applyFileWrite,
	canSafelyRevert,
	EditConflictError,
	hashContents,
	isPathEscape,
	revertPath,
} from "../EditTransactionService"

vi.mock("vscode", () => ({
	workspace: {
		textDocuments: [] as Array<{ isDirty: boolean; uri: { fsPath: string }; fileName: string }>,
	},
}))

describe("EditTransactionService", () => {
	beforeEach(() => {
		changeIndex.clear()
		;(vscode.workspace as { textDocuments: unknown[] }).textDocuments = []
	})

	it("refuses path escapes", async () => {
		expect(isPathEscape("/ws", "../outside.ts")).toBe(true)
		await expect(
			applyFileWrite({ cwd: "/ws", relPath: "../outside.ts", content: "x", writeFile: vi.fn() }),
		).rejects.toMatchObject({ code: "path-escape" })
	})

	it("refuses to overwrite a dirty buffer and does not write", async () => {
		const writeFile = vi.fn()
		;(vscode.workspace as { textDocuments: unknown[] }).textDocuments = [
			{ isDirty: true, uri: { fsPath: "/ws/a.ts" }, fileName: "/ws/a.ts" },
		]
		await expect(
			applyFileWrite({
				cwd: "/ws",
				relPath: "a.ts",
				content: "next",
				writeFile,
				readFile: async () => "old",
			}),
		).rejects.toBeInstanceOf(EditConflictError)
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("applies a clean write and records the change index", async () => {
		const writeFile = vi.fn()
		const result = await applyFileWrite({
			cwd: "/ws",
			relPath: "a.ts",
			content: "next",
			taskId: "task-1",
			writeFile,
			readFile: async () => "old",
		})
		expect(writeFile).toHaveBeenCalledWith("/ws/a.ts", "next")
		expect(result.beforeHash).toBe(hashContents("old"))
		expect(result.afterHash).toBe(hashContents("next"))
		expect(changeIndex.getChangesForTask("task-1")).toHaveLength(1)
		expect(changeIndex.getChangesForPath("/ws/a.ts")[0]?.status).toBe("applied")
	})

	it("serializes concurrent writes to the same path", async () => {
		const order: string[] = []
		const writeFile = async (_path: string, content: string) => {
			order.push(`start:${content}`)
			await new Promise((resolve) => setTimeout(resolve, 15))
			order.push(`end:${content}`)
		}
		await Promise.all([
			applyFileWrite({ cwd: "/ws", relPath: "a.ts", content: "one", writeFile, readFile: async () => "" }),
			applyFileWrite({ cwd: "/ws", relPath: "a.ts", content: "two", writeFile, readFile: async () => "" }),
		])
		expect(order).toEqual(
			order[0] === "start:one"
				? ["start:one", "end:one", "start:two", "end:two"]
				: ["start:two", "end:two", "start:one", "end:one"],
		)
	})

	it("refuses revert when the baseline has changed", async () => {
		await applyFileWrite({
			cwd: "/ws",
			relPath: "a.ts",
			content: "next",
			taskId: "task-1",
			writeFile: vi.fn(),
			readFile: async () => "old",
		})
		const restore = vi.fn()
		await expect(revertPath("/ws/a.ts", "tampered", restore)).rejects.toMatchObject({ code: "unsafe-revert" })
		expect(restore).not.toHaveBeenCalled()
		expect(canSafelyRevert("tampered", hashContents("next"))).toBe(false)
	})

	it("reverts when the current hash still matches the applied write", async () => {
		await applyFileWrite({
			cwd: "/ws",
			relPath: "a.ts",
			content: "next",
			taskId: "task-1",
			writeFile: vi.fn(),
			readFile: async () => "old",
		})
		const restore = vi.fn()
		await revertPath("/ws/a.ts", "next", restore)
		expect(restore).toHaveBeenCalledWith("/ws/a.ts", "old")
		expect(changeIndex.latestForPath("/ws/a.ts")?.status).toBe("reverted")
	})
})
