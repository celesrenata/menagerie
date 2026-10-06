import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { ObservedTask, TimelineEvent, SummaryHeader } from "@roo-code/types"

import { deriveStatus, type DeriveStatusFields } from "./deriveStatus.js"

/**
 * Shape of `manifest.json` inside a persisted batch directory
 * (`parallel-tasks/<batchId>/manifest.json`).
 */
interface PersistedManifest {
	readonly batchId: string
	readonly parentTaskId: string
	readonly snapshot: string
	readonly tasks: readonly PersistedWorkerRecord[]
}

/**
 * Shape of `worker-N.json` (and the manifest task entries), matching the
 * persisted `ParallelTaskResult`. Defined inline here rather than imported so
 * this reader never constructs a `Task` instance.
 */
interface PersistedWorkerRecord {
	readonly name: string
	readonly mode: string
	readonly state: "completed" | "failed" | "cancelled"
	readonly taskId?: string
	readonly profile?: string
	readonly workspace?: string
	readonly patch?: string
	readonly result?: string
	readonly error?: string
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

/**
 * Reads the persisted parallel-tasks store (`parallel-tasks/<batchId>/`) and
 * maps batch manifests and per-worker records to Observatory data models.
 *
 * This class performs **only file reads and JSON parsing** and never constructs
 * a `Task` instance (Requirement 9.4). It correlates each worker with the
 * manifest under one `logicalWorkerId` (Requirement 9.5).
 */
export class PersistedTaskStoreReader {
	/**
	 * Lists batch directory names under the given parallel-tasks directory.
	 * Returns an empty array if the directory does not exist.
	 */
	public async listBatches(parallelTasksDir: string): Promise<string[]> {
		try {
			const entries = await readdir(parallelTasksDir, { withFileTypes: true })
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		} catch (error) {
			if (isEnoent(error)) {
				return []
			}
			throw error
		}
	}

	/**
	 * Reads a full batch: the manifest plus every worker record, mapped to
	 * Observatory data models. Corrupt worker files are warned about and skipped.
	 */
	public async readBatch(
		batchDir: string,
	): Promise<{ batchId: string; parentTaskId: string; tasks: ObservedTask[]; events: Map<string, TimelineEvent[]> }> {
		const manifest = await this.readManifest(batchDir)

		const tasks: ObservedTask[] = []
		const events = new Map<string, TimelineEvent[]>()

		for (let index = 0; index < manifest.tasks.length; index++) {
			const record = await this.resolveWorkerRecord(batchDir, manifest, index + 1)

			if (record === undefined) {
				console.warn(
					`[PersistedTaskStoreReader] Skipping corrupt worker record at index ${index + 1} in ${batchDir}`,
				)
				continue
			}

			const task = this.mapToObservedTask(manifest, record, index)
			tasks.push(task)
			events.set(task.id, this.mapToTimelineEvents(manifest, record, index))
		}

		return {
			batchId: manifest.batchId,
			parentTaskId: manifest.parentTaskId,
			tasks,
			events,
		}
	}

	/**
	 * Reads a single 1-indexed worker record (worker-N.json, falling back to
	 * the manifest entry at index N-1). Throws if the worker cannot be found.
	 */
	public async readWorker(batchDir: string, workerIndex: number): Promise<{ task: ObservedTask; events: TimelineEvent[] }> {
		const manifest = await this.readManifest(batchDir)
		const record = await this.resolveWorkerRecord(batchDir, manifest, workerIndex)

		if (record === undefined) {
			throw new Error(`Worker ${workerIndex} not found in batch directory: ${batchDir}`)
		}

		const index = workerIndex - 1
		const task = this.mapToObservedTask(manifest, record, index)
		return { task, events: this.mapToTimelineEvents(manifest, record, index) }
	}

	private async readManifest(batchDir: string): Promise<PersistedManifest> {
		const manifestPath = path.join(batchDir, "manifest.json")
		const raw = await readFile(manifestPath, "utf8")
		return JSON.parse(raw) as PersistedManifest
	}

	/**
	 * Resolves a worker record for the given 1-indexed worker position.
	 * Prefers worker-N.json; falls back to the manifest entry. Returns
	 * undefined when both the file is corrupt and the manifest entry is missing.
	 */
	private async resolveWorkerRecord(
		batchDir: string,
		manifest: PersistedManifest,
		workerIndex: number,
	): Promise<PersistedWorkerRecord | undefined> {
		const filePath = path.join(batchDir, `worker-${workerIndex}.json`)
		try {
			const raw = await readFile(filePath, "utf8")
			return JSON.parse(raw) as PersistedWorkerRecord
		} catch (error) {
			if (isEnoent(error)) {
				return manifest.tasks[workerIndex - 1]
			}
			console.warn(`[PersistedTaskStoreReader] Failed to parse worker record at ${filePath}:`, error)
			return undefined
		}
	}

	private mapRecordToFields(record: PersistedWorkerRecord): DeriveStatusFields {
		if (record.state === "completed") {
			return { hasActivity: true, historyStatus: "completed" }
		}
		if (record.state === "cancelled") {
			return { hasActivity: true, abort: true }
		}
		// failed
		return {
			hasActivity: true,
			workerFailureOutcome: true,
			parallelWorkerFailure: record.error ?? "Unknown failure",
		}
	}

	private mapToObservedTask(manifest: PersistedManifest, record: PersistedWorkerRecord, index: number): ObservedTask {
		const logicalWorkerId = `${manifest.batchId}:worker-${index + 1}`
		const status = deriveStatus(this.mapRecordToFields(record))
		const header: SummaryHeader = {
			status,
			mode: record.mode ?? null,
			route: null,
			profile: record.profile ?? null,
			model: null,
			reasoning: null,
			contextUsed: null,
			contextLimit: null,
			startedAt: null,
			lastActivityAt: null,
			workspace: record.workspace ?? null,
			parentId: manifest.parentTaskId,
			workerId: logicalWorkerId,
		}
		return {
			id: record.taskId ?? logicalWorkerId,
			parentId: manifest.parentTaskId,
			logicalWorkerId,
			isParallelWorker: true,
			status,
			source: "COMPLETED",
			header,
		}
	}

	private mapToTimelineEvents(
		manifest: PersistedManifest,
		record: PersistedWorkerRecord,
		index: number,
	): TimelineEvent[] {
		const logicalWorkerId = `${manifest.batchId}:worker-${index + 1}`
		const taskId = record.taskId ?? logicalWorkerId

		const startEvent: TimelineEvent = {
			id: `${logicalWorkerId}:start`,
			taskId,
			ts: 0,
			label: `Worker ${index + 1} started`,
			kind: "say",
			lineCount: 1,
			byteSize: record.name.length,
			collapsedByDefault: false,
			preview: `Task: ${record.name}`,
		}

		const terminalLabel =
			record.state === "completed" ? "Completed" : record.state === "cancelled" ? "Cancelled" : "Failed"
		const outcome = record.state === "completed" ? "success" : "error"
		const detailText = record.result ?? record.error ?? "No details"

		const terminalEvent: TimelineEvent = {
			id: `${logicalWorkerId}:terminal`,
			taskId,
			ts: 1,
			label: terminalLabel,
			kind: "say",
			outcome,
			lineCount: 1,
			byteSize: (record.result ?? record.error ?? "").length,
			collapsedByDefault: false,
			preview: detailText.slice(0, 200),
		}

		return [startEvent, terminalEvent]
	}
}
