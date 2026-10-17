import { sameTaskRef, taskRefKey, type TaskRef, type TaskSummary } from "./types"

export interface TaskViewClient {
	id: string
}

export interface TaskRuntimeHandle {
	ref: TaskRef
	summary: TaskSummary
	/** Optional cancel hook. Detach never calls this. */
	cancel?: () => void
}

export type TaskSessionEvent = { ref: TaskRef; sequence: number; summary: TaskSummary }

const STORAGE_KEY = "menagerie.taskSessionIndex.v1"

export interface TaskSessionStorage {
	get: (key: string) => unknown
	update: (key: string, value: unknown) => Thenable<void> | void
}

interface PersistedIndex {
	schemaVersion: 1
	sessions: TaskSummary[]
}

/**
 * In-memory + compact persisted index of live/known tasks, keyed by stable
 * TaskRef. View attach/detach is ephemeral and never cancels a task.
 */
export class TaskSessionRegistry {
	private readonly handles = new Map<string, TaskRuntimeHandle>()
	private readonly views = new Map<string, Set<string>>()
	private readonly listeners = new Set<(e: TaskSessionEvent) => void>()
	private sequence = 0
	private storage?: TaskSessionStorage

	bindStorage(storage: TaskSessionStorage): void {
		this.storage = storage
	}

	register(handle: TaskRuntimeHandle): void {
		this.handles.set(taskRefKey(handle.ref), handle)
		this.emit(handle.ref, handle.summary)
		void this.persist()
	}

	unregister(ref: TaskRef): void {
		const key = taskRefKey(ref)
		this.handles.delete(key)
		this.views.delete(key)
		void this.persist()
	}

	summaries(): TaskSummary[] {
		return [...this.handles.values()]
			.map((handle) => handle.summary)
			.sort((a, b) => {
				const workspace = a.ref.workspaceUri.localeCompare(b.ref.workspaceUri)
				if (workspace !== 0) return workspace
				return a.ref.taskId.localeCompare(b.ref.taskId)
			})
	}

	get(ref: TaskRef): TaskRuntimeHandle | null {
		return this.handles.get(taskRefKey(ref)) ?? null
	}

	attachView(ref: TaskRef, client: TaskViewClient): void {
		const handle = this.get(ref)
		if (!handle) return
		const key = taskRefKey(ref)
		const clients = this.views.get(key) ?? new Set<string>()
		clients.add(client.id)
		this.views.set(key, clients)
	}

	detachView(ref: TaskRef, client: TaskViewClient): void {
		const key = taskRefKey(ref)
		const clients = this.views.get(key)
		clients?.delete(client.id)
		if (clients && clients.size === 0) this.views.delete(key)
		// Detach is ephemeral: the handle and its cancel hook stay untouched.
	}

	viewCount(ref: TaskRef): number {
		return this.views.get(taskRefKey(ref))?.size ?? 0
	}

	onEvent(cb: (e: TaskSessionEvent) => void): () => void {
		this.listeners.add(cb)
		return () => {
			this.listeners.delete(cb)
		}
	}

	updateSummary(ref: TaskRef, patch: Partial<Omit<TaskSummary, "ref">>): TaskSummary | null {
		const handle = this.get(ref)
		if (!handle) return null
		handle.summary = {
			...handle.summary,
			...patch,
			ref: handle.ref,
			revision: handle.summary.revision + 1,
		}
		this.emit(ref, handle.summary)
		void this.persist()
		return handle.summary
	}

	/**
	 * Restore previously persisted summaries as inactive records. Live handles
	 * already registered win over the stored copy.
	 */
	restorePersisted(): TaskSummary[] {
		const raw = this.storage?.get(STORAGE_KEY)
		const parsed = parsePersistedIndex(raw)
		for (const summary of parsed.sessions) {
			const key = taskRefKey(summary.ref)
			if (this.handles.has(key)) continue
			this.handles.set(key, { ref: summary.ref, summary })
		}
		return this.summaries()
	}

	/**
	 * Snapshot-on-gap recovery: if the observed sequence is behind the last
	 * emitted sequence, return current summaries so a consumer can reconcile.
	 */
	snapshotIfGap(lastSeenSequence: number): TaskSummary[] | null {
		if (lastSeenSequence >= this.sequence) return null
		return this.summaries()
	}

	private emit(ref: TaskRef, summary: TaskSummary): void {
		this.sequence += 1
		const event: TaskSessionEvent = { ref, sequence: this.sequence, summary }
		for (const listener of this.listeners) listener(event)
	}

	private persist(): void {
		if (!this.storage) return
		const payload: PersistedIndex = { schemaVersion: 1, sessions: this.summaries() }
		void this.storage.update(STORAGE_KEY, payload)
	}
}

function parsePersistedIndex(raw: unknown): PersistedIndex {
	if (!raw || typeof raw !== "object") return { schemaVersion: 1, sessions: [] }
	const record = raw as { schemaVersion?: unknown; sessions?: unknown }
	if (!Array.isArray(record.sessions)) return { schemaVersion: 1, sessions: [] }
	const sessions: TaskSummary[] = []
	for (const item of record.sessions) {
		const summary = migrateSummary(item)
		if (summary) sessions.push(summary)
	}
	return { schemaVersion: 1, sessions }
}

/** Accept current summaries and older `{ id, workspace }` records without dropping history. */
export function migrateSummary(item: unknown): TaskSummary | null {
	if (!item || typeof item !== "object") return null
	const record = item as Record<string, unknown>
	const ref = record.ref as TaskRef | undefined
	if (ref && typeof ref.taskId === "string" && typeof ref.hostId === "string" && typeof ref.workspaceUri === "string") {
		return {
			ref,
			parentTaskId: typeof record.parentTaskId === "string" ? record.parentTaskId : undefined,
			role: typeof record.role === "string" ? record.role : "code",
			route: typeof record.route === "string" ? record.route : undefined,
			status: isStatus(record.status) ? record.status : "queued",
			title: typeof record.title === "string" ? record.title.slice(0, 120) : "Task",
			changedFileCount: numberOrZero(record.changedFileCount),
			pendingApprovalCount: numberOrZero(record.pendingApprovalCount),
			lastMeaningfulEventAt: numberOrZero(record.lastMeaningfulEventAt),
			revision: numberOrZero(record.revision),
		}
	}
	const taskId = typeof record.id === "string" ? record.id : typeof record.taskId === "string" ? record.taskId : undefined
	if (!taskId) return null
	const workspaceUri =
		typeof record.workspaceUri === "string"
			? record.workspaceUri
			: typeof record.workspace === "string"
				? record.workspace
				: ""
	return {
		ref: {
			hostId: typeof record.hostId === "string" ? record.hostId : "unknown",
			workspaceUri,
			taskId,
		},
		role: typeof record.mode === "string" ? record.mode : "code",
		status: isStatus(record.status) ? record.status : "queued",
		title: typeof record.title === "string" ? record.title.slice(0, 120) : "Task",
		changedFileCount: 0,
		pendingApprovalCount: 0,
		lastMeaningfulEventAt: numberOrZero(record.updatedAt),
		revision: 0,
	}
}

function isStatus(value: unknown): value is TaskSummary["status"] {
	return (
		value === "queued" ||
		value === "running" ||
		value === "waiting-input" ||
		value === "review" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	)
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export { sameTaskRef, taskRefKey, STORAGE_KEY }
