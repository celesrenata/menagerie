import { LifecycleTransitionError } from "./taskLifecycle"

/**
 * Pure reducers for detached ("fire and forget") parallel-task batches.
 *
 * A batch is detached from its parent's turn. Workers settle independently,
 * results are delivered into the parent's next turn at most once, and the
 * parent can send steering text to a worker that is still running. Every
 * transition returns a new state or throws `LifecycleTransitionError`; the
 * runtime (`BackgroundBatchService`) and the bounded model checker
 * (`scripts/check-background-subtasks.ts`) both drive these same functions.
 */

export type BackgroundWorkerState = "running" | "completed" | "failed" | "cancelled"
export type BackgroundWorkerOutcome = Exclude<BackgroundWorkerState, "running">
export type SteeringDropReason = "worker-settled" | "parent-lost" | "worker-cancelled"

export interface SteeringDrop {
	readonly text: string
	readonly reason: SteeringDropReason
}

export interface BackgroundWorker {
	readonly state: BackgroundWorkerState
	/** True once the settled result was handed to the parent's turn. */
	readonly delivered: boolean
	/** Steering waiting for the worker's next request boundary. */
	readonly steering: readonly string[]
	/** Count of steering items ever accepted for this worker. */
	readonly steeringSent: number
	/** Count of steering items the worker consumed. */
	readonly steeringDelivered: number
	readonly steeringDropped: readonly SteeringDrop[]
}

export interface BackgroundBatch {
	readonly batchId: string
	readonly parentTaskId: string
	readonly parentLive: boolean
	readonly workers: Readonly<Record<string, BackgroundWorker>>
}

function worker(batch: BackgroundBatch, name: string): BackgroundWorker {
	const found = batch.workers[name]
	if (!found) throw new LifecycleTransitionError(`Unknown background worker ${name} in batch ${batch.batchId}`)
	return found
}

function withWorker(batch: BackgroundBatch, name: string, next: BackgroundWorker): BackgroundBatch {
	return { ...batch, workers: { ...batch.workers, [name]: next } }
}

/** Move all pending steering to the dropped list with a reason. */
function dropPending(w: BackgroundWorker, reason: SteeringDropReason): BackgroundWorker {
	if (w.steering.length === 0) return w
	return {
		...w,
		steering: [],
		steeringDropped: [...w.steeringDropped, ...w.steering.map((text) => ({ text, reason }))],
	}
}

export function detachBatch(batchId: string, parentTaskId: string, names: readonly string[]): BackgroundBatch {
	if (names.length === 0) throw new LifecycleTransitionError(`Cannot detach batch ${batchId} with no workers`)
	if (new Set(names).size !== names.length) {
		throw new LifecycleTransitionError(`Cannot detach batch ${batchId} with duplicate worker names`)
	}
	const workers: Record<string, BackgroundWorker> = {}
	for (const name of names) {
		workers[name] = {
			state: "running",
			delivered: false,
			steering: [],
			steeringSent: 0,
			steeringDelivered: 0,
			steeringDropped: [],
		}
	}
	return { batchId, parentTaskId, parentLive: true, workers }
}

/** A running worker reaches a terminal state. Pending steering is dropped. */
export function settleBackgroundWorker(
	batch: BackgroundBatch,
	name: string,
	outcome: BackgroundWorkerOutcome,
): BackgroundBatch {
	const w = worker(batch, name)
	if (w.state !== "running") {
		throw new LifecycleTransitionError(`Cannot settle worker ${name}: already ${w.state}`)
	}
	const reason: SteeringDropReason = outcome === "cancelled" ? "worker-cancelled" : "worker-settled"
	return withWorker(batch, name, { ...dropPending(w, reason), state: outcome })
}

/**
 * Hand every settled, not-yet-delivered result to the parent's turn exactly once.
 * Rejected once the parent is gone.
 */
export function deliverSettledResults(batch: BackgroundBatch): { batch: BackgroundBatch; delivered: string[] } {
	if (!batch.parentLive) {
		throw new LifecycleTransitionError(`Cannot deliver results of batch ${batch.batchId}: parent is gone`)
	}
	const delivered: string[] = []
	const workers: Record<string, BackgroundWorker> = {}
	for (const [name, w] of Object.entries(batch.workers)) {
		if (w.state !== "running" && !w.delivered) {
			delivered.push(name)
			workers[name] = { ...w, delivered: true }
		} else {
			workers[name] = w
		}
	}
	return { batch: { ...batch, workers }, delivered }
}

/** Queue steering text for a worker. Only a running worker of a live parent accepts it. */
export function steerBackgroundWorker(batch: BackgroundBatch, name: string, text: string): BackgroundBatch {
	if (!batch.parentLive) {
		throw new LifecycleTransitionError(`Cannot steer ${name}: parent of batch ${batch.batchId} is gone`)
	}
	const w = worker(batch, name)
	if (w.state !== "running") {
		throw new LifecycleTransitionError(`Cannot steer worker ${name}: it is ${w.state}`)
	}
	if (text.trim().length === 0) throw new LifecycleTransitionError(`Cannot steer worker ${name} with empty text`)
	return withWorker(batch, name, { ...w, steering: [...w.steering, text], steeringSent: w.steeringSent + 1 })
}

/** The worker consumes its pending steering at a request boundary. At most once per item. */
export function drainWorkerSteering(batch: BackgroundBatch, name: string): { batch: BackgroundBatch; items: string[] } {
	const w = worker(batch, name)
	if (w.steering.length === 0) return { batch, items: [] }
	const items = [...w.steering]
	return {
		batch: withWorker(batch, name, {
			...w,
			steering: [],
			steeringDelivered: w.steeringDelivered + items.length,
		}),
		items,
	}
}

/** The parent explicitly cancels one running worker. */
export function cancelBackgroundWorker(batch: BackgroundBatch, name: string): BackgroundBatch {
	return settleBackgroundWorker(batch, name, "cancelled")
}

/** The parent task is gone: running workers are cancelled and nothing more is delivered. */
export function loseBackgroundParent(batch: BackgroundBatch): BackgroundBatch {
	if (!batch.parentLive) return batch
	const workers: Record<string, BackgroundWorker> = {}
	for (const [name, w] of Object.entries(batch.workers)) {
		if (w.state === "running") {
			workers[name] = { ...dropPending(w, "parent-lost"), state: "cancelled" }
		} else {
			workers[name] = dropPending(w, "parent-lost")
		}
	}
	return { ...batch, parentLive: false, workers }
}

export function hasRunningWorkers(batch: BackgroundBatch): boolean {
	return Object.values(batch.workers).some((w) => w.state === "running")
}

export function hasUndeliveredResults(batch: BackgroundBatch): boolean {
	return batch.parentLive && Object.values(batch.workers).some((w) => w.state !== "running" && !w.delivered)
}
