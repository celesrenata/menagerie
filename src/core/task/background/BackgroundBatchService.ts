import crypto from "node:crypto"
import type { Task } from "../Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { ParallelTaskSpec } from "../../tools/ParallelTasksTool"
import type { UserParallelismPolicy, RouteCapability } from "../elasticTypes"
import type { InferenceLeasePool } from "../InferenceLeasePool"
import { runParallelTasks, type ParallelTaskResult, type RunParallelTasksOptions } from "../runParallelTasks"
import {
	cancelBackgroundWorker,
	deliverSettledResults,
	detachBatch,
	drainWorkerSteering,
	hasRunningWorkers,
	hasUndeliveredResults,
	loseBackgroundParent,
	settleBackgroundWorker,
	steerBackgroundWorker,
	type BackgroundBatch,
	type BackgroundWorkerOutcome,
} from "../../task-persistence/backgroundBatchLifecycle"
import { LifecycleTransitionError } from "../../task-persistence/taskLifecycle"

/** What `runParallelTasks` looks like to the service; injectable for tests. */
export type BackgroundRunner = (
	parent: Task,
	provider: ClineProvider,
	specs: ParallelTaskSpec[],
	policy: UserParallelismPolicy,
	options: RunParallelTasksOptions,
) => Promise<{ manifestPath?: string }>

export interface BackgroundStartParams {
	parent: Task
	provider: ClineProvider
	specs: ParallelTaskSpec[]
	policy: UserParallelismPolicy
	/** Runs once the whole batch finishes; its value is delivered with the final results. */
	afterBatch?: (info: { batchId: string; results: ParallelTaskResult[]; manifestPath?: string }) => Promise<unknown>
}

interface BatchEntry {
	batchId: string
	parent: Task
	batch: BackgroundBatch
	results: Map<string, ParallelTaskResult>
	workerCancels: Map<string, () => void>
	abort: AbortController
	manifestPath?: string
	/** Present once `afterBatch` finished; delivered once. */
	postProcessing?: unknown
	postProcessingDelivered: boolean
	finished: boolean
	done: Promise<void>
}

export interface BackgroundWorkerStatus {
	name: string
	state: string
	delivered: boolean
	pendingSteering: number
}

export interface BackgroundBatchStatus {
	batchId: string
	finished: boolean
	workers: BackgroundWorkerStatus[]
}

export interface BackgroundTurnReport {
	batches: Array<{
		batchId: string
		manifestPath?: string
		/** Workers newly delivered this turn. */
		results: ParallelTaskResult[]
		/** Present once, after the whole batch finished. */
		postProcessing?: unknown
	}>
	running: Array<{ batchId: string; name: string; pendingSteering: number }>
}

export interface SteerOutcome {
	steered: string[]
	rejected: Array<{ name: string; reason: string }>
}

function outcomeFor(state: ParallelTaskResult["state"]): BackgroundWorkerOutcome {
	return state
}

/** Owns detached parallel-task batches for one provider. All state changes go through the shared reducer. */
export class BackgroundBatchService {
	private readonly entries = new Map<string, BatchEntry>()
	private readonly sharedLeasePools = new Map<RouteCapability, InferenceLeasePool>()
	private readonly waiters = new Set<() => void>()

	constructor(private readonly runner: BackgroundRunner = runParallelTasks) {}

	/** Detach a batch: returns immediately, workers keep running. */
	start(params: BackgroundStartParams): { batchId: string; names: string[] } {
		const { parent, provider, specs, policy, afterBatch } = params
		const batchId = crypto.randomUUID()
		const names = specs.map((spec) => spec.name)
		const entry: BatchEntry = {
			batchId,
			parent,
			batch: detachBatch(batchId, parent.taskId, names),
			results: new Map(),
			workerCancels: new Map(),
			abort: new AbortController(),
			postProcessingDelivered: false,
			finished: false,
			done: Promise.resolve(),
		}
		this.entries.set(batchId, entry)

		const onParentStop = () => this.loseParent(entry)
		parent.lifetimeSignal.addEventListener("abort", onParentStop, { once: true })

		entry.done = this.runner(parent, provider, specs, policy, {
			batchId,
			sharedLeasePools: this.sharedLeasePools,
			abortSignal: entry.abort.signal,
			registerWorkerCancel: (name, cancel) => entry.workerCancels.set(name, cancel),
			onWorkerStarted: (name, child) => {
				child.steeringDrain = () => this.drainSteering(entry, name)
			},
			onWorkerSettled: (result) => this.settle(entry, result),
		})
			.then(async (result) => {
				entry.manifestPath = result.manifestPath
				if (afterBatch && entry.batch.parentLive) {
					try {
						entry.postProcessing = await afterBatch({
							batchId,
							results: [...entry.results.values()],
							manifestPath: result.manifestPath,
						})
					} catch (error) {
						entry.postProcessing = {
							status: "skipped",
							reason: `post-processing error: ${error instanceof Error ? error.message : "unknown"}`.slice(
								0,
								200,
							),
						}
					}
				}
			})
			.catch((error: unknown) => {
				// The whole run failed: every worker that never settled is a failure.
				const message = error instanceof Error ? error.message : String(error)
				for (const name of names) {
					this.settle(entry, { name, mode: "", state: "failed", error: message.slice(0, 500) })
				}
			})
			.finally(() => {
				entry.finished = true
				parent.lifetimeSignal.removeEventListener("abort", onParentStop)
				this.notify()
			})
		return { batchId, names }
	}

	private settle(entry: BatchEntry, result: ParallelTaskResult): void {
		const current = entry.batch.workers[result.name]
		if (!current || current.state !== "running") return
		entry.results.set(result.name, result)
		entry.batch = settleBackgroundWorker(entry.batch, result.name, outcomeFor(result.state))
		entry.workerCancels.delete(result.name)
		this.wakeIdleParent(entry, result)
		this.notify()
	}

	/** When the parent is idle, queue a short notice through the normal user message queue. */
	private wakeIdleParent(entry: BatchEntry, result: ParallelTaskResult): void {
		const parent = entry.parent
		if (!entry.batch.parentLive || !parent.idleAsk) return
		parent.messageQueueService.addMessage(
			`[Background task update] Worker "${result.name}" of batch ${entry.batchId} ${result.state}. See "# Background Tasks" in environment details.`,
		)
	}

	private loseParent(entry: BatchEntry): void {
		entry.batch = loseBackgroundParent(entry.batch)
		entry.abort.abort(new Error("Parent task stopped"))
		this.notify()
	}

	private drainSteering(entry: BatchEntry, name: string): string[] {
		const drained = drainWorkerSteering(entry.batch, name)
		entry.batch = drained.batch
		return drained.items
	}

	private notify(): void {
		for (const waiter of [...this.waiters]) waiter()
	}

	private entriesFor(parentTaskId: string): BatchEntry[] {
		return [...this.entries.values()].filter((entry) => entry.batch.parentTaskId === parentTaskId)
	}

	private targetsFor(parentTaskId: string, target: string): Array<{ entry: BatchEntry; name: string }> {
		const entries = this.entriesFor(parentTaskId)
		const byBatch = entries.find((entry) => entry.batchId === target)
		if (byBatch) return Object.keys(byBatch.batch.workers).map((name) => ({ entry: byBatch, name }))
		return entries.filter((entry) => target in entry.batch.workers).map((entry) => ({ entry, name: target }))
	}

	/** True while the parent still has running workers or results it has not seen. */
	hasActive(parentTaskId: string): boolean {
		return this.entriesFor(parentTaskId).some(
			(entry) =>
				hasRunningWorkers(entry.batch) ||
				hasUndeliveredResults(entry.batch) ||
				(entry.finished && entry.postProcessing !== undefined && !entry.postProcessingDelivered),
		)
	}

	status(parentTaskId: string): BackgroundBatchStatus[] {
		return this.entriesFor(parentTaskId).map((entry) => ({
			batchId: entry.batchId,
			finished: entry.finished,
			workers: Object.entries(entry.batch.workers).map(([name, w]) => ({
				name,
				state: w.state,
				delivered: w.delivered,
				pendingSteering: w.steering.length,
			})),
		}))
	}

	/** Send steering text to one worker (by name) or every running worker of a batch (by batchId). */
	steer(parentTaskId: string, target: string, message: string): SteerOutcome {
		const targets = this.targetsFor(parentTaskId, target)
		if (targets.length === 0) return { steered: [], rejected: [{ name: target, reason: "unknown target" }] }
		const outcome: SteerOutcome = { steered: [], rejected: [] }
		for (const { entry, name } of targets) {
			try {
				entry.batch = steerBackgroundWorker(entry.batch, name, message)
				outcome.steered.push(name)
			} catch (error) {
				if (!(error instanceof LifecycleTransitionError)) throw error
				outcome.rejected.push({ name, reason: error.message })
			}
		}
		return outcome
	}

	/** Cancel one worker (by name) or every running worker of a batch (by batchId). */
	cancel(
		parentTaskId: string,
		target: string,
	): { cancelled: string[]; rejected: Array<{ name: string; reason: string }> } {
		const targets = this.targetsFor(parentTaskId, target)
		const outcome = { cancelled: [] as string[], rejected: [] as Array<{ name: string; reason: string }> }
		if (targets.length === 0) outcome.rejected.push({ name: target, reason: "unknown target" })
		for (const { entry, name } of targets) {
			const w = entry.batch.workers[name]!
			if (w.state !== "running") {
				outcome.rejected.push({ name, reason: `already ${w.state}` })
				continue
			}
			try {
				entry.batch = cancelBackgroundWorker(entry.batch, name)
			} catch (error) {
				if (!(error instanceof LifecycleTransitionError)) throw error
				outcome.rejected.push({ name, reason: error.message })
				continue
			}
			entry.results.set(name, { name, mode: "", state: "cancelled", error: "Cancelled by parent" })
			entry.workerCancels.get(name)?.()
			entry.workerCancels.delete(name)
			outcome.cancelled.push(name)
		}
		this.notify()
		return outcome
	}

	/**
	 * Mark newly settled results delivered (exactly once) and describe what is still
	 * running. Returns undefined when there is nothing to report.
	 */
	takeReport(parentTaskId: string): BackgroundTurnReport | undefined {
		const report: BackgroundTurnReport = { batches: [], running: [] }
		for (const entry of this.entriesFor(parentTaskId)) {
			if (entry.batch.parentLive) {
				const delivered = deliverSettledResults(entry.batch)
				entry.batch = delivered.batch
				const finalPost = entry.finished && entry.postProcessing !== undefined && !entry.postProcessingDelivered
				if (delivered.delivered.length > 0 || finalPost) {
					report.batches.push({
						batchId: entry.batchId,
						manifestPath: entry.manifestPath,
						results: delivered.delivered
							.map((name) => entry.results.get(name))
							.filter((result): result is ParallelTaskResult => result !== undefined),
						...(finalPost ? { postProcessing: entry.postProcessing } : {}),
					})
					if (finalPost) entry.postProcessingDelivered = true
				}
			}
			for (const [name, w] of Object.entries(entry.batch.workers)) {
				if (w.state === "running") {
					report.running.push({ batchId: entry.batchId, name, pendingSteering: w.steering.length })
				}
			}
			if (
				entry.finished &&
				!hasRunningWorkers(entry.batch) &&
				!hasUndeliveredResults(entry.batch) &&
				(entry.postProcessing === undefined || entry.postProcessingDelivered)
			) {
				this.entries.delete(entry.batchId)
			}
		}
		return report.batches.length > 0 || report.running.length > 0 ? report : undefined
	}

	/**
	 * Resolve when a result is ready to deliver, nothing is running, or the timeout/abort
	 * hits. Never rejects.
	 */
	wait(parentTaskId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const ready = () =>
			this.entriesFor(parentTaskId).some(
				(entry) =>
					hasUndeliveredResults(entry.batch) ||
					(entry.finished && entry.postProcessing !== undefined && !entry.postProcessingDelivered),
			) || !this.entriesFor(parentTaskId).some((entry) => hasRunningWorkers(entry.batch))
		return new Promise((resolve) => {
			if (ready() || signal?.aborted) return resolve()
			const finish = () => {
				clearTimeout(timer)
				this.waiters.delete(check)
				signal?.removeEventListener("abort", finish)
				resolve()
			}
			const check = () => {
				if (ready()) finish()
			}
			const timer = setTimeout(finish, timeoutMs)
			this.waiters.add(check)
			signal?.addEventListener("abort", finish, { once: true })
		})
	}

	/** Cancel everything and forget all batches (provider shutdown). */
	dispose(): void {
		for (const entry of this.entries.values()) {
			entry.batch = loseBackgroundParent(entry.batch)
			entry.abort.abort(new Error("Provider disposed"))
		}
		this.entries.clear()
		this.notify()
	}
}
