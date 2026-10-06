/**
 * CapabilityLease, two-level per-worker capability state, and the pure state
 * transitions over that state for the Dynamic Capability Broker (FEAT-013).
 *
 * A worker's capability state has two load-bearing levels:
 *  - ALLOWED: the capabilities the worker is authorized to use (policy-approved
 *    or always-resident core). Being allowed does NOT put a schema in context.
 *  - ACTIVE: the subset of ALLOWED whose tool schemas are currently serialized
 *    into the outbound model request. Only ACTIVE capabilities cost tokens.
 *
 * The headline invariant is ACTIVE ⊆ ALLOWED. The helpers here enforce it and
 * perform no I/O: they take a `WorkerCapabilityState` plus a core-capability set
 * and return a discriminated result rather than throwing.
 */

import type { ToolCapabilityId, CapabilityAccessKind } from "./toolCapability"

/** Who asked for a capability lease. */
export type LeaseRequester = "mastermind" | "worker" | "scheduler" | "policy"

/** Lifecycle state of a single lease. */
export type LeaseState = "requested" | "active" | "released" | "denied"

/** The boundary at which a lease expires. */
export type LeaseLifetime = "tool-complete" | "phase-complete" | "task-complete"

/**
 * The explicit record of who holds what capability, why, at what scope, for how
 * long, in which state. Mirrors the design's `CapabilityLease` exactly.
 */
export interface CapabilityLease {
	capability: ToolCapabilityId
	taskId: string
	/** undefined => parent-held; leases are worker-specific by default. */
	workerId?: string
	requestedBy: LeaseRequester
	reason: string
	access: CapabilityAccessKind
	/** Best-effort scope tokens, e.g. ["/workspace"], ["namespace=nervecenter"]. */
	scope?: string[]
	state: LeaseState
	expiresWhen: LeaseLifetime
	/** Resolved provider for an active lease; enables provider-failure errors. */
	providerId?: string
	requestedAt: number
	activatedAt?: number
	releasedAt?: number
}

/**
 * Per-worker two-level state (ALLOWED vs ACTIVE) that lives in
 * `AutonomousTaskState`. `active` is always a subset of `allowed`.
 */
export interface WorkerCapabilityState {
	workerId: string
	/** Authorized capabilities (includes always-resident core). */
	allowed: ToolCapabilityId[]
	/** Capabilities whose schema is currently in context (⊆ allowed). */
	active: ToolCapabilityId[]
	/** Full lease history for this worker. */
	leases: CapabilityLease[]
}

/** Reasons a pure transition can reject a mutation. */
export type CapabilityTransitionError =
	| "not-allowed" // tried to activate a capability absent from ALLOWED
	| "already-active" // tried to activate a capability already ACTIVE
	| "not-active" // tried to release a capability that is not ACTIVE

/**
 * Discriminated result for a pure transition. On failure the original state is
 * returned unchanged alongside an error marker; transitions never throw.
 */
export type CapabilityTransitionResult =
	| { ok: true; state: WorkerCapabilityState }
	| { ok: false; error: CapabilityTransitionError; state: WorkerCapabilityState }

/** True when `capability` is currently ACTIVE for the worker. */
export function isActive(state: WorkerCapabilityState, capability: ToolCapabilityId): boolean {
	return state.active.includes(capability)
}

/**
 * Move a capability into ACTIVE, enforcing ACTIVE ⊆ ALLOWED.
 *
 * Rejects (returning the state unchanged plus an error marker) any attempt to
 * activate a capability that is not in ALLOWED, or that is already ACTIVE. On
 * success the capability is appended to `active` without disturbing existing
 * entries, preserving composer prefix stability.
 */
export function activate(state: WorkerCapabilityState, capability: ToolCapabilityId): CapabilityTransitionResult {
	if (!state.allowed.includes(capability)) {
		return { ok: false, error: "not-allowed", state }
	}
	if (state.active.includes(capability)) {
		return { ok: false, error: "already-active", state }
	}
	return {
		ok: true,
		state: { ...state, active: [...state.active, capability] },
	}
}

/**
 * Move a capability out of ACTIVE (its schema disappears next generation) while
 * leaving ALLOWED untouched, so the capability may be re-activated later.
 *
 * Core capabilities are always ACTIVE and never released: a release of a core
 * capability is rejected as `not-active` so the always-resident surface stays
 * intact. A release of a capability that is not currently ACTIVE is likewise
 * rejected without mutation.
 */
export function release(
	state: WorkerCapabilityState,
	capability: ToolCapabilityId,
	coreCapabilities: readonly ToolCapabilityId[],
): CapabilityTransitionResult {
	if (coreCapabilities.includes(capability) || !state.active.includes(capability)) {
		return { ok: false, error: "not-active", state }
	}
	return {
		ok: true,
		state: { ...state, active: state.active.filter((c) => c !== capability) },
	}
}

/**
 * Deny a capability: remove it from both ALLOWED and ACTIVE so it can never be
 * serialized or re-activated without a fresh grant.
 *
 * Always-resident core capabilities are never removable: a deny targeting a
 * core capability leaves both sets unchanged (core remains in ALLOWED
 * regardless of lease state). Denying a capability that is present in neither
 * set is a no-op success, since the post-condition (absent from both) already
 * holds.
 */
export function deny(
	state: WorkerCapabilityState,
	capability: ToolCapabilityId,
	coreCapabilities: readonly ToolCapabilityId[],
): CapabilityTransitionResult {
	if (coreCapabilities.includes(capability)) {
		return { ok: true, state }
	}
	return {
		ok: true,
		state: {
			...state,
			allowed: state.allowed.filter((c) => c !== capability),
			active: state.active.filter((c) => c !== capability),
		},
	}
}
