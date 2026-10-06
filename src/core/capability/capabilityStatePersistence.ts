/**
 * Structured persistence of per-worker capability state inside
 * `AutonomousTaskState` for the Dynamic Capability Broker (FEAT-013).
 *
 * Capability lease state (the two-level ALLOWED/ACTIVE sets plus per-lease scope
 * and lifetime) must survive a `condenseContext` cycle intact. The authoritative
 * `AutonomousTaskState` lives out-of-band from the transcript and is never
 * summarized, so persisting lease state as a STRUCTURED field on that object is
 * what makes it condensation-safe.
 *
 * This module is deliberately additive and read-only toward the sibling
 * mastermind-execution-metadata `AutonomousTaskState` base type (exported from
 * `@roo-code/types`): it never modifies, removes, or widens any base field.
 * `AutonomousTaskStateCapabilities` declares the single optional `capabilities`
 * extension; an absent `capabilities` reads as legacy "all allowed"
 * compatibility mode, never an error. The read path derives lease state
 * EXCLUSIVELY from the structured `capabilities.workers` field and never from
 * transcript prose: when the structured field is absent or unreadable it returns
 * an explicit unavailable result rather than any reconstructed value.
 *
 * _Requirements: 8.2, 8.3, 8.4_
 */

import type { AutonomousTaskState } from "@roo-code/types"

import type { WorkerCapabilityState } from "./capabilityLease"

/**
 * Additive extension of `AutonomousTaskState`. Purely additive: it introduces
 * exactly one optional `capabilities` field and redefines no base field.
 * An absent `capabilities` reads as legacy compatibility mode (every worker
 * implicitly "all allowed"), never as an error.
 */
export interface AutonomousTaskStateCapabilities {
	/** Per-worker two-level state; absent ⇒ legacy "all allowed" compat mode. */
	capabilities?: {
		workers: WorkerCapabilityState[]
		brokerDegraded?: boolean
	}
}

/**
 * The sibling base `AutonomousTaskState` intersected with the additive
 * capability extension. Used only as a view type at this module's boundary; the
 * base type is consumed read-only and never redefined.
 */
export type AutonomousTaskStateWithCapabilities = AutonomousTaskState & AutonomousTaskStateCapabilities

/** Why a structured capability-state read could not return a value. */
export type CapabilityStateUnavailableReason =
	| "capabilities-absent" // no structured `capabilities` field at all (legacy compat)
	| "workers-absent" // `capabilities` present but has no structured `workers` array
	| "worker-not-found" // structured state present but no entry for the worker
	| "worker-unreadable" // the matched worker entry is structurally malformed

/**
 * Explicit result of reading a worker's capability state. `read` NEVER returns a
 * value reconstructed from transcript prose: when the structured field is absent
 * or unreadable it returns `{ ok: false, reason }` so the broker can treat the
 * worker's capability state as unavailable and surface an error.
 */
export type ReadWorkerCapabilityStateResult =
	| { ok: true; state: WorkerCapabilityState }
	| { ok: false; reason: CapabilityStateUnavailableReason }

/** True when `value` is a structurally valid `WorkerCapabilityState`. */
function isWorkerCapabilityState(value: unknown): value is WorkerCapabilityState {
	if (typeof value !== "object" || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.workerId === "string" &&
		Array.isArray(candidate.allowed) &&
		Array.isArray(candidate.active) &&
		Array.isArray(candidate.leases)
	)
}

/**
 * Persist a worker's two-level capability state into structured
 * `AutonomousTaskState` fields, returning a NEW state (the input is never
 * mutated and its arrays are never shared with the result).
 *
 * The write replaces any existing entry for the same `workerId` and preserves
 * every other worker's entry and the `brokerDegraded` flag. Only structured
 * data is written; nothing is encoded into prose. If the base state carried no
 * `capabilities` field, one is created additively.
 *
 * _Requirements: 8.2, 8.3_
 */
export function writeWorkerCapabilityState(
	taskState: AutonomousTaskState,
	state: WorkerCapabilityState,
): AutonomousTaskStateWithCapabilities {
	const current = taskState as AutonomousTaskStateWithCapabilities
	const existingWorkers = current.capabilities?.workers ?? []
	const nextWorkers = [...existingWorkers.filter((worker) => worker.workerId !== state.workerId), state]

	return {
		...current,
		capabilities: {
			...current.capabilities,
			workers: nextWorkers,
		},
	}
}

/**
 * Read a worker's two-level capability state from structured
 * `AutonomousTaskState` fields ONLY.
 *
 * Returns `{ ok: true, state }` with the structured entry for `workerId`, or an
 * explicit `{ ok: false, reason }` when the structured field is absent, missing
 * its `workers` array, has no entry for the worker, or has a malformed entry.
 * It never parses, infers, or reconstructs any value from the conversation
 * transcript prose.
 *
 * _Requirements: 8.3, 8.4_
 */
export function readWorkerCapabilityState(
	taskState: AutonomousTaskState,
	workerId: string,
): ReadWorkerCapabilityStateResult {
	const current = taskState as AutonomousTaskStateWithCapabilities
	const capabilities = current.capabilities

	if (capabilities === undefined || capabilities === null) {
		return { ok: false, reason: "capabilities-absent" }
	}
	if (!Array.isArray(capabilities.workers)) {
		return { ok: false, reason: "workers-absent" }
	}

	const match = capabilities.workers.find((worker) => worker?.workerId === workerId)
	if (match === undefined) {
		return { ok: false, reason: "worker-not-found" }
	}
	if (!isWorkerCapabilityState(match)) {
		return { ok: false, reason: "worker-unreadable" }
	}

	return { ok: true, state: match }
}
