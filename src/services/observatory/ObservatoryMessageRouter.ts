import type { WebviewMessage } from "@roo-code/types"
import type { ObservableProvider, ObservableTask, GetAllInstances } from "./TaskObservationService.js"
import type { TaskObservationService } from "./TaskObservationService.js"
import { PersistedTaskStoreReader } from "./PersistedTaskStoreReader.js"
import { computeMastermindSummary, computeAttentionQueue } from "./aggregation.js"

/**
 * Read-only message router for Task Observatory webview requests.
 *
 * Handles the Observatory read-only `WebviewMessage` variants and responds
 * via `postMessageToWebview`. NO handler invokes a lifecycle-mutating operation.
 */
export class ObservatoryMessageRouter {
	private readonly service: TaskObservationService
	private readonly provider: ObservableProvider
	private readonly getAllInstances: GetAllInstances
	private readonly reader: PersistedTaskStoreReader
	private readonly parallelTasksDir: string

	constructor(options: {
		service: TaskObservationService
		provider: ObservableProvider
		getAllInstances: GetAllInstances
		parallelTasksDir: string
	}) {
		this.service = options.service
		this.provider = options.provider
		this.getAllInstances = options.getAllInstances
		this.reader = new PersistedTaskStoreReader()
		this.parallelTasksDir = options.parallelTasksDir
	}

	/**
	 * Returns true if this message was handled (is an observatory message).
	 * The caller can skip further processing.
	 */
	async handle(message: WebviewMessage): Promise<boolean> {
		switch (message.type) {
			case "observatorySubscribe":
				await this.handleSubscribe()
				return true
			case "observatoryRequestWindow":
				await this.handleRequestWindow(message)
				return true
			case "observatoryRequestPersisted":
				await this.handleRequestPersisted(message)
				return true
			case "observatoryRequestMastermind":
				await this.handleRequestMastermind(message)
				return true
			case "observatoryRefresh":
				await this.handleRefresh()
				return true
			default:
				return false
		}
	}

	private async handleSubscribe(): Promise<void> {
		// Trigger a fresh reconciliation so the webview gets an initial snapshot
		this.service.reconcile()
	}

	private async handleRequestWindow(message: WebviewMessage): Promise<void> {
		const payload = message.observatory as
			| { kind: "requestWindow"; taskId: string; offset: number; limit: number }
			| undefined
		if (!payload || payload.kind !== "requestWindow") return

		const { taskId, offset, limit } = payload
		const boundedLimit = Math.min(Math.max(limit, 0), 500)

		// Serve the requested page from the service's bounded per-task event ring.
		const events = this.service.getEventWindow(taskId, offset, boundedLimit)
		await this.provider.postMessageToWebview({
			type: "observatoryWindow",
			observatory: {
				kind: "window",
				taskId,
				offset,
				events,
			},
		})
	}

	private async handleRequestPersisted(message: WebviewMessage): Promise<void> {
		const payload = message.observatory as
			| { kind: "requestPersisted"; batchId: string; workerId: string }
			| undefined
		if (!payload || payload.kind !== "requestPersisted") return

		const { batchId, workerId } = payload
		try {
			const batchDir = `${this.parallelTasksDir}/${batchId}`
			// Parse workerIndex from workerId: format is `${batchId}:worker-${N}`
			const workerMatch = workerId.match(/:worker-(\d+)$/)
			const workerIndex = workerMatch ? parseInt(workerMatch[1], 10) : 1

			const result = await this.reader.readWorker(batchDir, workerIndex)
			await this.provider.postMessageToWebview({
				type: "observatoryPersisted",
				observatory: {
					kind: "persisted",
					batchId,
					workerId,
					task: result.task,
					events: result.events,
				},
			})
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			await this.provider.postMessageToWebview({
				type: "observatoryError",
				observatory: { kind: "error", message: `Failed to read persisted worker: ${msg}`, taskId: workerId },
			})
		}
	}

	private async handleRequestMastermind(message: WebviewMessage): Promise<void> {
		const payload = message.observatory as
			| { kind: "requestMastermind"; parentTaskId: string }
			| undefined
		if (!payload || payload.kind !== "requestMastermind") return

		const { parentTaskId } = payload
		// Gather all workers for this parent from all providers
		const workers = []
		for (const p of this.getAllInstances()) {
			const task = p.getCurrentTask()
			if (task && (task.parallelParentTaskId === parentTaskId || task.parentTaskId === parentTaskId)) {
				// Build a minimal ObservedTask for the summary
				const { deriveStatus } = await import("./deriveStatus.js")
				const last = task.clineMessages.at(-1)
				const history = p.taskHistoryStore.get(task.taskId)
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
				workers.push({
					id: task.taskId,
					parentId: parentTaskId,
					logicalWorkerId: undefined,
					isParallelWorker: task.parallelWorker,
					status,
					source: "LIVE" as const,
					header: {
						status,
						mode: null,
						route: null,
						profile: null,
						model: null,
						reasoning: null,
						contextUsed: null,
						contextLimit: null,
						startedAt: task.clineMessages[0]?.ts ?? null,
						lastActivityAt: last?.ts ?? null,
						workspace: task.cwd,
						parentId: parentTaskId,
						workerId: null,
					},
				})
			}
		}

		const summary = computeMastermindSummary(parentTaskId, workers)
		await this.provider.postMessageToWebview({
			type: "observatoryMastermind",
			observatory: { kind: "mastermind", summary },
		})
	}

	private async handleRefresh(): Promise<void> {
		this.service.reconcile()
	}
}
