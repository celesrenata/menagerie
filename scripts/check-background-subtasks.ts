import assert from "node:assert/strict"
import {
	cancelBackgroundWorker,
	deliverSettledResults,
	detachBatch,
	drainWorkerSteering,
	loseBackgroundParent,
	settleBackgroundWorker,
	steerBackgroundWorker,
	type BackgroundBatch,
	type BackgroundWorkerOutcome,
} from "../src/core/task-persistence/backgroundBatchLifecycle"
import { LifecycleTransitionError } from "../src/core/task-persistence/taskLifecycle"

/**
 * Production-backed bounded model of detached background batches. Every step
 * drives the real reducers in `backgroundBatchLifecycle.ts`; a reducer that
 * throws `LifecycleTransitionError` means the action is not enabled in that
 * state. Ghost counters record what the runtime would observe so that the
 * invariants can catch a reducer that wrongly accepts an illegal move.
 */
const WORKERS = ["a", "b"] as const
const OUTCOMES: readonly BackgroundWorkerOutcome[] = ["completed", "failed", "cancelled"]
const MAX_STATES = 50_000
const EXPECTED_ACTIONS = ["settle", "deliver", "steer", "drain", "cancel", "lose-parent"] as const

type ModelState = {
	batch: BackgroundBatch
	/** Ghost: how many times each worker's result reached the parent. */
	deliveries: Record<string, number>
	/** Ghost: illegal acceptances observed while stepping. */
	breaches: string[]
}
type Transition = { name: string; kind: string; next: ModelState }
type Reducers = { deliver: typeof deliverSettledResults }

const REAL: Reducers = { deliver: deliverSettledResults }
/** A deliberately broken deliver that forgets to mark results delivered. */
const MUTANT_FORGETS_DELIVERED: Reducers = {
	deliver: (batch) => {
		const { delivered } = deliverSettledResults(batch)
		return { batch, delivered }
	},
}

const LANDMARKS: Record<string, (state: ModelState) => boolean> = {
	"partial-settle": ({ batch }) =>
		Object.values(batch.workers).some((w) => w.state === "running") &&
		Object.values(batch.workers).some((w) => w.state !== "running"),
	"steering-pending": ({ batch }) => Object.values(batch.workers).some((w) => w.steering.length > 0),
	"steering-consumed": ({ batch }) => Object.values(batch.workers).some((w) => w.steeringDelivered > 0),
	"steering-dropped-on-settle": ({ batch }) =>
		Object.values(batch.workers).some((w) => w.steeringDropped.some((d) => d.reason === "worker-settled")),
	"steering-dropped-on-parent-loss": ({ batch }) =>
		Object.values(batch.workers).some((w) => w.steeringDropped.some((d) => d.reason === "parent-lost")),
	"result-delivered": ({ deliveries }) => Object.values(deliveries).some((n) => n === 1),
	"parent-lost-running-cancelled": ({ batch }) =>
		!batch.parentLive && Object.values(batch.workers).some((w) => w.state === "cancelled"),
	"undelivered-result-at-parent-loss": ({ batch }) =>
		!batch.parentLive && Object.values(batch.workers).some((w) => w.state !== "running" && !w.delivered),
}

function initialState(): ModelState {
	return {
		batch: detachBatch("batch", "parent", WORKERS),
		deliveries: { a: 0, b: 0 },
		breaches: [],
	}
}

function invariantViolations(state: ModelState): string[] {
	const out = [...state.breaches]
	const { batch } = state
	for (const [name, w] of Object.entries(batch.workers)) {
		if ((state.deliveries[name] ?? 0) > 1) out.push(`result of ${name} delivered more than once`)
		if (w.delivered && w.state === "running") out.push(`${name} delivered before it settled`)
		if (w.state !== "running" && w.steering.length > 0) out.push(`settled worker ${name} still holds steering`)
		const accounted = w.steeringDelivered + w.steeringDropped.length + w.steering.length
		if (accounted !== w.steeringSent) {
			out.push(`${name}: ${w.steeringSent} steering items sent but ${accounted} accounted for`)
		}
		if (!batch.parentLive && w.state === "running") out.push(`${name} still running after parent loss`)
		if (!batch.parentLive && w.steering.length > 0) out.push(`${name} holds steering after parent loss`)
	}
	return out
}

function attempt(state: ModelState, name: string, kind: string, step: (next: ModelState) => void): Transition[] {
	const next: ModelState = {
		batch: state.batch,
		deliveries: { ...state.deliveries },
		breaches: [...state.breaches],
	}
	try {
		step(next)
	} catch (error) {
		if (error instanceof LifecycleTransitionError) return []
		throw error
	}
	return [{ name, kind, next }]
}

function transitions(state: ModelState, reducers: Reducers): Transition[] {
	const result: Transition[] = []
	for (const name of WORKERS) {
		const before = state.batch.workers[name]!
		for (const outcome of OUTCOMES) {
			if (outcome === "cancelled") {
				result.push(
					...attempt(state, `cancel(${name})`, "cancel", (next) => {
						next.batch = cancelBackgroundWorker(state.batch, name)
					}),
				)
			} else {
				result.push(
					...attempt(state, `settle(${name}, ${outcome})`, "settle", (next) => {
						next.batch = settleBackgroundWorker(state.batch, name, outcome)
					}),
				)
			}
		}
		// Bound the model: at most two steering items per worker.
		if (before.steeringSent < 2) {
			result.push(
				...attempt(state, `steer(${name})`, "steer", (next) => {
					next.batch = steerBackgroundWorker(state.batch, name, `note-${before.steeringSent}`)
					if (before.state !== "running" || !state.batch.parentLive) {
						next.breaches.push(
							`steering accepted for ${name} while ${before.state}/parentLive=${state.batch.parentLive}`,
						)
					}
				}),
			)
		}
		result.push(
			...attempt(state, `drain(${name})`, "drain", (next) => {
				next.batch = drainWorkerSteering(state.batch, name).batch
			}),
		)
	}
	result.push(
		...attempt(state, "deliver", "deliver", (next) => {
			const delivered = reducers.deliver(state.batch)
			next.batch = delivered.batch
			if (!state.batch.parentLive) next.breaches.push("result delivered after parent loss")
			for (const name of delivered.delivered) {
				next.deliveries[name] = (next.deliveries[name] ?? 0) + 1
				if (state.batch.workers[name]!.state === "running")
					next.breaches.push(`${name} delivered while running`)
			}
		}),
	)
	result.push(
		...attempt(state, "lose-parent", "lose-parent", (next) => {
			next.batch = loseBackgroundParent(state.batch)
		}),
	)
	return result
}

function canonical(state: ModelState): string {
	return JSON.stringify({ batch: state.batch, deliveries: state.deliveries, breaches: state.breaches })
}

function explore(reducers: Reducers, stopAtViolation: boolean) {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: string[] }> = [{ state: start, trace: ["initial"] }]
	const visited = new Set([canonical(start)])
	const actions = new Set<string>()
	const landmarks = new Set<string>()
	let maxDepth = 0
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		maxDepth = Math.max(maxDepth, node.trace.length - 1)
		for (const [name, predicate] of Object.entries(LANDMARKS)) if (predicate(node.state)) landmarks.add(name)
		const violations = invariantViolations(node.state)
		if (violations.length) {
			if (stopAtViolation)
				return {
					states: visited.size,
					actions,
					landmarks,
					violation: violations[0],
					trace: node.trace,
					maxDepth,
				}
			throw new Error(`${violations.join("; ")}\n  ${node.trace.join(" -> ")}`)
		}
		for (const transition of transitions(node.state, reducers)) {
			actions.add(transition.kind)
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: transition.next, trace: [...node.trace, transition.name] })
			if (visited.size > MAX_STATES) throw new Error(`exceeded ${MAX_STATES}-state budget`)
		}
	}
	if (stopAtViolation) throw new Error("expected counterexample was not found")
	const missingActions = EXPECTED_ACTIONS.filter((kind) => !actions.has(kind))
	if (missingActions.length) throw new Error(`Unreachable actions: ${missingActions.join(", ")}`)
	const missingLandmarks = Object.keys(LANDMARKS).filter((name) => !landmarks.has(name))
	if (missingLandmarks.length) throw new Error(`Unreachable landmarks: ${missingLandmarks.join(", ")}`)
	return { states: visited.size, actions, landmarks, maxDepth }
}

const fixed = explore(REAL, false)
const mutant = explore(MUTANT_FORGETS_DELIVERED, true)
assert.match(mutant.violation ?? "", /delivered more than once/, "mutant must be caught as a double delivery")
console.log(
	`Background subtasks model check passed: ${fixed.states} distinct reachable states, ${fixed.actions.size}/${EXPECTED_ACTIONS.length} actions, ${fixed.landmarks.size}/${Object.keys(LANDMARKS).length} landmarks, depth <= ${fixed.maxDepth}, states <= ${MAX_STATES}, 1/1 mutant counterexample`,
)
console.log(`Mutant counterexample double-delivery: ${mutant.violation}\n  ${mutant.trace!.join(" -> ")}`)
