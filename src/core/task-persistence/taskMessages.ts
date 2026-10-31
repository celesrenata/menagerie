import * as path from "path"

import type { ClineMessage } from "@roo-code/types"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { ensureMessageIdentifiers, mergeClineMessageSnapshots } from "./mergeMessageSnapshots"
import { getErrorCode, readFileWithMissingRetry } from "./readFileWithMissingRetry"

export type TaskMessagesReadErrorKind = "not_found" | "invalid" | "io_error"

export class TaskMessagesReadError extends Error {
	constructor(
		public readonly kind: TaskMessagesReadErrorKind,
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message)
		this.name = "TaskMessagesReadError"
	}
}

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)

	let fileContent: string
	try {
		fileContent = await readFileWithMissingRetry(filePath)
	} catch (error) {
		const kind = getErrorCode(error) === "ENOENT" ? "not_found" : "io_error"
		throw new TaskMessagesReadError(kind, `Failed to read task messages for ${taskId} at ${filePath}`, error)
	}

	let parsedData: unknown
	try {
		parsedData = JSON.parse(fileContent)
	} catch (error) {
		throw new TaskMessagesReadError("invalid", `Failed to parse task messages for ${taskId} at ${filePath}`, error)
	}

	if (!Array.isArray(parsedData)) {
		throw new TaskMessagesReadError(
			"invalid",
			`Task messages for ${taskId} at ${filePath} must be an array, got ${typeof parsedData}`,
		)
	}

	return parsedData
}

/**
 * Serializes saves per task within this process. Concurrent saves otherwise contend for the same
 * proper-lockfile lock, and a save that loses the race is dropped after the lock retries run out.
 * The queue slot is claimed synchronously on call so saves run in call order; each save still
 * writes the full snapshot it was given.
 */
const pendingSavesByTask = new Map<string, Promise<unknown>>()

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
	merge?: boolean
}

export async function saveTaskMessages(options: SaveTaskMessagesOptions): Promise<ClineMessage[]> {
	const key = `${options.globalStoragePath}\0${options.taskId}`
	const previous = pendingSavesByTask.get(key) ?? Promise.resolve()
	const save = previous.then(() => writeTaskMessages(options))
	const settled = save.catch(() => undefined)
	pendingSavesByTask.set(key, settled)
	try {
		return await save
	} finally {
		if (pendingSavesByTask.get(key) === settled) {
			pendingSavesByTask.delete(key)
		}
	}
}

async function writeTaskMessages({
	messages,
	taskId,
	globalStoragePath,
	merge = false,
}: SaveTaskMessagesOptions): Promise<ClineMessage[]> {
	ensureMessageIdentifiers(messages)
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	let savedMessages = messages
	await safeWriteJson(
		filePath,
		messages,
		merge
			? {
					merge: (existing, incoming) => {
						savedMessages = mergeClineMessageSnapshots(existing, incoming) as ClineMessage[]
						return savedMessages
					},
				}
			: undefined,
	)
	return savedMessages
}
