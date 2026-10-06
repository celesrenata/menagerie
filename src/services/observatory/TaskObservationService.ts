import * as vscode from "vscode"
import { RooCodeEventName } from "@roo-code/types"
import type {
	ObservedTask,
	ObservationEvent,
	ObservationSource,
	SummaryHeader,
} from "@roo-code/types"
import { deriveStatus } from "./deriveStatus.js"

// Minimal read-only structural interfaces (decoupled from Task/ClineProvider)

interface ObservedClineMessage {
	readonly type: "ask" | "say"
	readonly ask?: string
	readonly say?: string
	readonly text?: string
	readonly ts: number
	readonly isAnswered?: boolean
	readonly partial?: boolean
}

export interface ObservableTask {
	readonly taskId: string
	readonly parallelWorker: boolean
	readonly parallelParentTaskId?: string
	readonly parentTaskId?: string
	readonly parallelWorkerFailure?: string
	readonly abort: boolean
	readonly isStreaming: boolean
	readonly clineMessages: readonly ObservedClineMessage[]
	readonly cwd: string
	readonly todoList?: readonly unknown[]
	getTaskMode(): Promise<string>
	getTaskApiConfigName(): Promise<string>
	readonly api: { getModel(): { id: string } }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter variadic signature
	on(event: string, listener: (...args: any[]) => void): unknown
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter variadic signature
	off(event: string, listener: (...args: any[]) => void): unknown
}

export interface ObservableProvider {
	getCurrentTask(): ObservableTask | undefined
	taskHistoryStore: { get(taskId: string): { status?: string; task?: string } | undefined }
	postMessageToWebview(message: { type: string; observatory?: unknown }): Promise<void> | void
}

export type GetAllInstances = () => ObservableProvider[]

interface AttachedRecord {
	readonly taskId: string
	dispose(): void
}

type ObservationKind = ObservationEvent["kind"]

const EVENT_MAP: ReadonlyArray<readonly [RooCodeEventName, ObservationKind]> = [
	[RooCodeEventName.Message, "message"],
	[RooCodeEventName.TaskActive, "active"],
	[RooCodeEventName.TaskInteractive, "interactive"],
	[RooCodeEventName.TaskResumable, "resumable"],
	[RooCodeEventName.TaskIdle, "idle"],
	[RooCodeEventName.TaskStarted, "started"],
	[RooCodeEventName.TaskAborted, "aborted"],
	[RooCodeEventName.TaskAskResponded, "askResponded"],
	[RooCodeEventName.TaskUserMessage, "userMessage"],
	[RooCodeEventName.TaskTokenUsageUpdated, "tokenUsage"],
	[RooCodeEventName.TaskToolFailed, "toolFailed"],
	[RooCodeEventName.QueuedMessagesUpdated, "queued"],
]

/**
 * Maximum number of normalized {@link ObservationEvent}s retained per task for
 * the live-timeline window. Matches the webview VirtualTimeline in-memory cap
 * (500) so a page the webview can hold is always available to serve.
 */
const MAX_RETAINED_EVENTS = 500

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Read-only observer service for the Task Observatory.
 *
 * P0 SAFETY: This service NEVER mutates task state. It does not import Task or
 * ClineProvider — it only operates on the structural {@link ObservableTask} /
 * {@link ObservableProvider} interfaces, attaching/detaching event listeners
 * and reading fields. All outbound communication is via
 * `postMessageToWebview`, and every observer error is swallowed and reported
 * so it can never propagate into task execution.
 */
export class TaskObservationService implements vscode.Disposable {
	private readonly getAllInstancesFn: GetAllInstances
	private readonly debounceMs: number
	private readonly reconcileIntervalMs: number
	private provider: ObservableProvider | undefined
	private started = false
	private disposed = false
	private reconcileTimer: ReturnType<typeof setInterval> | undefined
	private readonly attached = new Map<string, AttachedRecord>()
	private readonly pending = new Map<string, ObservationEvent[]>()
	/**
	 * Bounded per-task event ring retained INDEPENDENTLY of the `pending` drain,
	 * so a window request can be served after `postBatch` has flushed+cleared
	 * `pending`. Capped at {@link MAX_RETAINED_EVENTS} per task (oldest evicted).
	 * Retained until `dispose()` — NOT cleared on `detachFrom`, so a detached
	 * (e.g. aborted) task's timeline stays inspectable. Memory stays bounded by
	 * the per-task cap and the finite number of tasks.
	 */
	private readonly history = new Map<string, ObservationEvent[]>()
	private readonly seqCounters = new Map<string, number>()
	private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(
		getAllInstances: GetAllInstances,
		options?: { debounceMs?: number; reconcileIntervalMs?: number },
	) {
		this.getAllInstancesFn = getAllInstances
		this.debounceMs = options?.debounceMs ?? 80
		this.reconcileIntervalMs = clamp(options?.reconcileIntervalMs ?? 10_000, 5_000, 30_000)
	}

	// --- Lifecycle (Task 6.1) ---

	start(provider: ObservableProvider): void {
		if (this.started) return
		this.started = true
		this.provider = provider
		for (const p of this.getAllInstancesFn()) {
			const task = p.getCurrentTask()
			if (task) this.attachTo(task)
		}
		this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileIntervalMs)
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.reconcileTimer !== undefined) {
			clearInterval(this.reconcileTimer)
			this.reconcileTimer = undefined
		}
		for (const record of this.attached.values()) {
			try { record.dispose() } catch { /* swallow */ }
		}
		this.attached.clear()
		for (const timer of this.flushTimers.values()) clearTimeout(timer)
		this.flushTimers.clear()
		this.pending.clear()
		this.seqCounters.clear()
		this.history.clear()
		this.provider = undefined
		this.started = false
	}

	attachTo(task: ObservableTask): void {
		if (this.attached.has(task.taskId)) return
		const disposers: Array<() => void> = []
		for (const [eventName, kind] of EVENT_MAP) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler stored for on/off reference equality
			const handler = (...args: any[]): void => {
				try {
					const event = this.normalize(task, kind, args as unknown[])
					this.enqueue(task.taskId, event)
					if (kind === "aborted") this.detachFrom(task.taskId)
				} catch (error) {
					this.handleObserverError(task.taskId, error)
				}
			}
			try {
				task.on(eventName, handler)
				disposers.push(() => { try { task.off(eventName, handler) } catch { /* swallow */ } })
			} catch (error) {
				this.handleObserverError(task.taskId, error)
			}
		}
		this.attached.set(task.taskId, {
			taskId: task.taskId,
			dispose: () => { for (const d of disposers) d() },
		})
	}

	detachFrom(taskId: string): void {
		const record = this.attached.get(taskId)
		if (!record) return
		try { record.dispose() } catch { /* swallow */ }
		this.attached.delete(taskId)
	}

	// --- Normalization + batching (Task 6.2) ---

	private normalize(task: ObservableTask, kind: ObservationKind, args: readonly unknown[]): ObservationEvent {
		const taskId = task.taskId
		const nextSeq = (this.seqCounters.get(taskId) ?? 0) + 1
		this.seqCounters.set(taskId, nextSeq)
		return {
			taskId,
			kind,
			committedAt: Date.now(),
			seq: nextSeq,
			payload: this.buildPayload(kind, args),
		}
	}

	private buildPayload(kind: ObservationKind, args: readonly unknown[]): unknown {
		switch (kind) {
			case "message": {
				const rec = safeRecord(args[0])
				const msg = rec ? safeRecord(rec["message"]) : undefined
				return Object.freeze({
					action: rec ? safeString(rec["action"]) : undefined,
					text: msg ? safeString(msg["text"]) : undefined,
					say: msg ? safeString(msg["say"]) : undefined,
					ask: msg ? safeString(msg["ask"]) : undefined,
					ts: msg && typeof msg["ts"] === "number" ? msg["ts"] : undefined,
				})
			}
			case "toolFailed":
				return Object.freeze({ toolName: safeString(args[1]), error: safeString(args[2]) })
			case "tokenUsage":
				return Object.freeze({ tokenUsage: args[1], toolUsage: args[2] })
			case "queued":
				return Object.freeze({ count: Array.isArray(args[1]) ? args[1].length : 0 })
			case "userMessage":
				return Object.freeze({ text: safeString(args[1]) })
			default:
				return Object.freeze({})
		}
	}

	private enqueue(taskId: string, event: ObservationEvent): void {
		const buffer = this.pending.get(taskId) ?? []
		buffer.push(event)
		this.pending.set(taskId, buffer)
		// Retain the event in the bounded per-task history ring for window paging,
		// independently of the pending-buffer drain in postBatch. Evict from the
		// front once the cap is exceeded so only the most recent events are kept.
		const retained = this.history.get(taskId) ?? []
		retained.push(event)
		if (retained.length > MAX_RETAINED_EVENTS) {
			retained.splice(0, retained.length - MAX_RETAINED_EVENTS)
		}
		this.history.set(taskId, retained)
		if (this.flushTimers.has(taskId)) return
		const timer = setTimeout(() => {
			this.flushTimers.delete(taskId)
			void this.postBatch(taskId).catch((error) => this.handleObserverError(taskId, error))
		}, this.debounceMs)
		this.flushTimers.set(taskId, timer)
	}

	private async postBatch(taskId: string): Promise<void> {
		try {
			const provider = this.provider
			if (!provider) return
			const events = this.pending.get(taskId)
			if (!events || events.length === 0) return
			this.pending.set(taskId, [])
			const found = this.findTask(taskId)
			let observedTask: ObservedTask | undefined
			if (found) {
				observedTask = await this.toObservedTask(found.task, found.provider, "LIVE")
			}
			await provider.postMessageToWebview({
				type: "observatoryUpdate",
				observatory: {
					kind: "update",
					reason: "event",
					source: "LIVE" as ObservationSource,
					tasks: observedTask ? [observedTask] : [],
					events,
				},
			})
		} catch (error) {
			this.handleObserverError(taskId, error)
		}
	}

	private handleObserverError(taskId: string | undefined, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[TaskObservationService] Error${taskId ? ` (task ${taskId})` : ""}:`, message)
		try {
			void this.provider?.postMessageToWebview({
				type: "observatoryError",
				observatory: { kind: "error", message, taskId },
			})
		} catch {
			// Swallow — never propagate observer errors into task execution
		}
	}

	// --- SNAPSHOT reconciliation (Task 6.3) ---

	/**
	 * Reconciles listener attachments with the current set of active tasks and
	 * posts a full SNAPSHOT of all observable tasks to the webview.
	 */
	reconcile(): void {
		try {
			const providers = this.getAllInstancesFn()
			const seen = new Map<string, { task: ObservableTask; provider: ObservableProvider }>()
			for (const p of providers) {
				const task = p.getCurrentTask()
				if (task) seen.set(task.taskId, { task, provider: p })
			}
			// Listener reconciliation: attach newly-seen, detach gone
			for (const [taskId, { task }] of seen) {
				if (!this.attached.has(taskId)) this.attachTo(task)
			}
			for (const taskId of this.attached.keys()) {
				if (!seen.has(taskId)) this.detachFrom(taskId)
			}
			const entries = Array.from(seen.values())
			void this.buildAndPostSnapshot(entries).catch((error) =>
				this.handleObserverError(undefined, error),
			)
		} catch (error) {
			this.handleObserverError(undefined, error)
		}
	}

	private async buildAndPostSnapshot(
		entries: ReadonlyArray<{ task: ObservableTask; provider: ObservableProvider }>,
	): Promise<void> {
		const provider = this.provider
		if (!provider) return
		const tasks: ObservedTask[] = []
		for (const entry of entries) {
			try {
				tasks.push(await this.toObservedTask(entry.task, entry.provider, "SNAPSHOT"))
			} catch (error) {
				this.handleObserverError(entry.task.taskId, error)
			}
		}
		await provider.postMessageToWebview({
			type: "observatoryUpdate",
			observatory: {
				kind: "update",
				reason: "snapshot",
				source: "SNAPSHOT" as ObservationSource,
				tasks,
			},
		})
	}

	// --- Live-timeline window paging ---

	/**
	 * Read-only window into a task's retained live event history, serving the
	 * webview `observatoryRequestWindow` paging. Clamps `offset` to >= 0 and
	 * `limit` to [0, {@link MAX_RETAINED_EVENTS}], and returns a shallow copy of
	 * the ascending-ordered slice (callers cannot mutate the retained buffer).
	 * Returns `[]` when the task has no retained history. P0: never mutates any
	 * task state and posts nothing.
	 */
	getEventWindow(taskId: string, offset: number, limit: number): ObservationEvent[] {
		const retained = this.history.get(taskId)
		if (!retained || retained.length === 0) return []
		const start = Math.max(0, Math.floor(offset))
		const boundedLimit = clamp(Math.floor(limit), 0, MAX_RETAINED_EVENTS)
		return retained.slice(start, start + boundedLimit)
	}

	// --- Shared helpers ---

	private findTask(taskId: string): { task: ObservableTask; provider: ObservableProvider } | undefined {
		for (const p of this.getAllInstancesFn()) {
			const task = p.getCurrentTask()
			if (task?.taskId === taskId) return { task, provider: p }
		}
		return undefined
	}

	private async toObservedTask(
		task: ObservableTask,
		provider: ObservableProvider,
		source: ObservationSource,
	): Promise<ObservedTask> {
		const last = task.clineMessages.at(-1)
		const history = provider.taskHistoryStore.get(task.taskId)
		const status = deriveStatus({
			historyStatus: history?.status,
			lastMessageType: last?.type,
			lastMessageSay: last?.say,
			lastMessageIsAnswered: last?.isAnswered,
			lastMessagePartial: last?.partial,
			abort: task.abort,
			isStreaming: task.isStreaming,
			hasActivity: task.clineMessages.length > 0,
			parallelWorkerFailure: task.parallelWorkerFailure,
		})
		let mode: string | null = null
		let profile: string | null = null
		let model: string | null = null
		try { mode = await task.getTaskMode() } catch { /* fallback null */ }
		try { profile = await task.getTaskApiConfigName() } catch { /* fallback null */ }
		try { model = task.api.getModel().id } catch { /* fallback null */ }
		const parentId = task.parallelParentTaskId ?? task.parentTaskId
		const header: SummaryHeader = {
			status,
			mode,
			route: null,
			profile,
			model,
			reasoning: null,
			contextUsed: null,
			contextLimit: null,
			startedAt: task.clineMessages[0]?.ts ?? null,
			lastActivityAt: last?.ts ?? null,
			workspace: task.cwd,
			parentId: parentId ?? null,
			workerId: null,
		}
		return {
			id: task.taskId,
			parentId,
			logicalWorkerId: undefined,
			isParallelWorker: task.parallelWorker,
			status,
			source,
			header,
		}
	}
}
