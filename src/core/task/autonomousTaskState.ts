import { autonomousTaskStateSchema, type AutonomousTaskState, type WorkerResult } from "@roo-code/types"

import type { Task } from "./Task"

/**
 * Out-of-band store for each {@link Task}'s authoritative
 * {@link AutonomousTaskState}.
 *
 * The state is deliberately held in a module-level {@link WeakMap} keyed by the
 * `Task` instance rather than on a `Task` field. This keeps the structured task
 * state entirely off the conversational `apiConversationHistory`, so
 * `condenseContext` summarizes the transcript without reading, rewriting, or
 * dropping the state object. A read after condensation therefore returns the
 * preserved object rather than a reconstruction from the transcript (the
 * condensation-survival hook itself is task 9.3). Using a `WeakMap` also lets
 * the state be garbage-collected with its `Task`.
 *
 * _Requirements: 13.1, 14.3_
 */
const autonomousTaskStateStore = new WeakMap<Task, AutonomousTaskState>()

/**
 * Builds a fresh, empty {@link AutonomousTaskState}. Every array field starts
 * empty and `objective` defaults to the empty string (or the supplied value).
 * Returns a new object on each call so callers never share mutable arrays.
 *
 * _Requirements: 13.1, 13.2_
 */
export function createAutonomousTaskState(objective = ""): AutonomousTaskState {
	return {
		objective,
		constraints: [],
		decisions: [],
		assumptions: [],
		activeWork: [],
		completedWork: [],
		filesTouched: [],
		blockers: [],
		openQuestions: [],
		evidence: [],
		nextActions: [],
	}
}

/**
 * Reads the authoritative {@link AutonomousTaskState} for a {@link Task}.
 *
 * This is the authoritative task-state source: callers that need the current
 * objective, decisions, work status, touched files, blockers, or evidence read
 * it here rather than reconstructing from the transcript. If no state has been
 * attached yet, a fresh empty state is created, stored, and returned so the
 * store always holds a single authoritative object for the task.
 *
 * _Requirements: 13.1, 13.3, 14.3_
 */
export function getAutonomousTaskState(task: Task): AutonomousTaskState {
	const existing = autonomousTaskStateStore.get(task)

	if (existing !== undefined) {
		return existing
	}

	const initial = createAutonomousTaskState()
	autonomousTaskStateStore.set(task, initial)
	return initial
}

/**
 * Replaces the authoritative {@link AutonomousTaskState} for a {@link Task}.
 * The value is validated against `autonomousTaskStateSchema` so only a
 * conforming state is ever stored, keeping the store authoritative.
 *
 * _Requirements: 13.1, 13.3, 14.3_
 */
export function setAutonomousTaskState(task: Task, state: AutonomousTaskState): void {
	autonomousTaskStateStore.set(task, autonomousTaskStateSchema.parse(state))
}

/**
 * Appends `incoming` entries to `base` that are not already present, returning a
 * new array. Preserves the existing order and appends new entries in arrival
 * order so accumulation is deterministic and idempotent for repeated reports.
 */
function appendUnique<T>(base: readonly T[], incoming: readonly T[], key: (value: T) => string): T[] {
	const seen = new Set(base.map(key))
	const merged = [...base]

	for (const value of incoming) {
		const id = key(value)
		if (!seen.has(id)) {
			seen.add(id)
			merged.push(value)
		}
	}

	return merged
}

/**
 * Merges a worker's reported {@link WorkerResult} into an
 * {@link AutonomousTaskState}, returning a NEW state (the input is never
 * mutated and its arrays are never shared with the result).
 *
 * The merge accumulates each reported dimension into the corresponding
 * authoritative field:
 *
 * - `findings` — each finding's `claim` accumulates into `decisions` as a
 *   recorded conclusion the worker reached.
 * - `changes` — accumulate into `completedWork` as the units of work the worker
 *   reports having completed.
 * - `blockers` — accumulate into `blockers`.
 * - `evidence` — accumulate into `evidence`, reusing the shared
 *   evidence-reference shape.
 *
 * Accumulation is additive and de-duplicated: entries already present (by their
 * identifying content) are not appended again, so applying the same result
 * twice is idempotent while distinct successive results accumulate.
 *
 * _Requirements: 13.2, 13.3_
 */
export function applyWorkerResult(state: AutonomousTaskState, result: WorkerResult): AutonomousTaskState {
	const claims = result.findings.map((finding) => finding.claim)

	return {
		objective: state.objective,
		constraints: [...state.constraints],
		decisions: appendUnique(state.decisions, claims, (claim) => claim),
		assumptions: [...state.assumptions],
		activeWork: [...state.activeWork],
		completedWork: appendUnique(state.completedWork, result.changes, (change) => change),
		filesTouched: [...state.filesTouched],
		blockers: appendUnique(state.blockers, result.blockers, (blocker) => blocker),
		openQuestions: [...state.openQuestions],
		evidence: appendUnique(
			state.evidence,
			result.evidence,
			(ref) => `${ref.type}\u0000${ref.reference}\u0000${ref.lines?.join("-") ?? ""}\u0000${ref.result ?? ""}`,
		),
		nextActions: [...state.nextActions],
	}
}

/**
 * Condensation-survival capture point.
 *
 * Called from `Task.condenseContext` immediately before the transcript is
 * summarized. Because {@link AutonomousTaskState} lives in an out-of-band
 * {@link WeakMap} keyed by the `Task` — never on `apiConversationHistory` —
 * summarization cannot read, rewrite, or drop it. This hook makes that
 * invariant explicit and testable: it captures the authoritative state object
 * via {@link getAutonomousTaskState} before summarization, and the store
 * returns that same object afterward, so a read after condensation yields the
 * preserved state rather than a reconstruction from the summarized transcript.
 *
 * The returned object is the live stored reference (identity-preserving); the
 * store is left unchanged so the state remains authoritative across the
 * condensation boundary.
 *
 * _Requirements: 14.1, 14.2, 14.3_
 */
export function preserveAutonomousTaskState(task: Task): AutonomousTaskState {
	return getAutonomousTaskState(task)
}

/**
 * Applies a worker result to the authoritative state stored for a {@link Task}
 * and persists the merged result back to the store, returning the new state.
 *
 * Convenience wrapper over {@link getAutonomousTaskState} +
 * {@link applyWorkerResult} + {@link setAutonomousTaskState} for callers in the
 * worker-result layer that update task state as workers report findings.
 *
 * _Requirements: 13.3, 14.3_
 */
export function applyWorkerResultToTask(task: Task, result: WorkerResult): AutonomousTaskState {
	const current = getAutonomousTaskState(task)
	const next = applyWorkerResult(current, result)
	setAutonomousTaskState(task, next)
	return next
}
