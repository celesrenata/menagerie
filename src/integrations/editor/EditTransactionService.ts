import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { changeIndex } from "./ChangeIndex"

export type EditPresentation = "silent" | "review" | "interactive"

export class EditConflictError extends Error {
	readonly code: "dirty-buffer" | "path-escape" | "unsafe-revert"

	constructor(code: EditConflictError["code"], message: string) {
		super(message)
		this.name = "EditConflictError"
		this.code = code
	}
}

const pathLocks = new Map<string, Promise<void>>()

async function withPathLock<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
	const previous = pathLocks.get(absolutePath) ?? Promise.resolve()
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const queued = previous.then(() => gate)
	pathLocks.set(absolutePath, queued)
	await previous
	try {
		return await run()
	} finally {
		release()
		if (pathLocks.get(absolutePath) === queued) pathLocks.delete(absolutePath)
	}
}

export function hashContents(contents: string): string {
	return crypto.createHash("sha256").update(contents).digest("hex")
}

export function isPathEscape(_cwd: string, relPath: string): boolean {
	return relPath.split(/[\\/]/).includes("..")
}

export function findDirtyDocument(absolutePath: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(
		(doc) => doc.isDirty && (doc.uri.fsPath === absolutePath || doc.fileName === absolutePath),
	)
}

export interface ApplyFileWriteInput {
	cwd: string
	relPath: string
	content: string
	taskId?: string
	writeFile?: (absolutePath: string, content: string) => Promise<void>
	readFile?: (absolutePath: string) => Promise<string>
}

export async function applyFileWrite(input: ApplyFileWriteInput): Promise<{ beforeHash: string; afterHash: string }> {
	if (isPathEscape(input.cwd, input.relPath)) {
		throw new EditConflictError("path-escape", `Refusing to write outside the workspace: ${input.relPath}`)
	}
	const absolutePath = path.resolve(input.cwd, input.relPath)
	return withPathLock(absolutePath, async () => {
		if (findDirtyDocument(absolutePath)) {
			throw new EditConflictError(
				"dirty-buffer",
				`File has unsaved user edits; write refused, reconcile: ${input.relPath}`,
			)
		}
		const read = input.readFile ?? ((filePath) => fs.readFile(filePath, "utf-8"))
		let before = ""
		try {
			before = await read(absolutePath)
		} catch {
			before = ""
		}
		const beforeHash = hashContents(before)
		const write = input.writeFile ?? ((filePath, content) => fs.writeFile(filePath, content, "utf-8"))
		await write(absolutePath, input.content)
		const afterHash = hashContents(input.content)
		if (input.taskId) {
			changeIndex.record({
				taskId: input.taskId,
				path: absolutePath,
				beforeHash,
				afterHash,
				beforeContents: before,
				patch: input.content,
				timestamp: Date.now(),
				status: "applied",
			})
		}
		return { beforeHash, afterHash }
	})
}

export async function revertPath(
	filePath: string,
	currentContents: string,
	writeFile: (absolutePath: string, content: string) => Promise<void> = (p, c) => fs.writeFile(p, c, "utf-8"),
): Promise<void> {
	const latest = changeIndex.latestForPath(filePath)
	if (!latest || latest.status !== "applied") {
		throw new EditConflictError("unsafe-revert", `No applied change to revert for ${filePath}`)
	}
	if (hashContents(currentContents) !== latest.afterHash) {
		throw new EditConflictError(
			"unsafe-revert",
			`Changed baseline; revert refused for ${filePath} because the file no longer matches the applied write.`,
		)
	}
	await writeFile(filePath, latest.beforeContents)
	changeIndex.markReverted(latest)
}

export function canSafelyRevert(currentContents: string, afterHash: string): boolean {
	return hashContents(currentContents) === afterHash
}
