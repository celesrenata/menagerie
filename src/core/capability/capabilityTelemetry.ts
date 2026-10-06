/**
 * Context-accounting telemetry for the Dynamic Capability Broker (FEAT-013).
 *
 * Least-privilege leasing avoids serializing tool schemas that a worker is not
 * actively leasing. This module quantifies that saving per generation: how many
 * tool-schema tokens were actually serialized (always-resident core + ACTIVE
 * leases) versus the counterfactual where every configured capability's schema
 * was exposed (`toolSchemaTokensTotalIfAllExposed`). The headline metric is
 *
 *     toolSchemaTokensAvoided = toolSchemaTokensTotalIfAllExposed − toolSchemaTokensActive
 *
 * The accounting is EXACT with a hard invariant:
 *   - both operands are non-negative integers, and
 *   - toolSchemaTokensActive ≤ toolSchemaTokensTotalIfAllExposed
 *     (you can never serialize more than the full configured universe), so
 *   - toolSchemaTokensAvoided is a non-negative integer.
 *
 * This module is deliberately additive and read-only toward the sibling
 * mastermind-execution-metadata `WorkerResult` base type (exported from
 * `@roo-code/types`): it never modifies, removes, or widens any base field.
 * `WorkerResultWithCapabilityTelemetry` declares the single optional
 * `capabilityTelemetry` extension; an absent field means accounting is
 * UNREPORTED, never zero. IF the invariant is violated, the computation omits
 * `capabilityTelemetry` and records an explicit error indication without
 * altering the generation's primary result.
 *
 * The computation is pure: no I/O. Counts and token costs are passed in by the
 * broker, which sources them from the composed surface, the catalog/registry
 * universe, and the per-generation lease deltas.
 *
 * _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
 */

import type { WorkerResult } from "@roo-code/types"

/**
 * Per-generation context-accounting metrics. Mirrors the design's
 * `CapabilityTelemetry` exactly. Every count is a non-negative integer. The
 * headline `toolSchemaTokensAvoided` is the tokens saved by not exposing
 * unleased schemas.
 */
export interface CapabilityTelemetry {
	/** Count of MCP tools available (allowed/configured) this generation. */
	availableMcpToolCount: number
	/** Count of MCP tools whose schema was actually serialized this generation. */
	activeMcpToolCount: number
	/** Counterfactual: tokens if EVERY configured capability's schema were exposed. */
	toolSchemaTokensTotalIfAllExposed: number
	/** Tokens actually serialized this generation (core + active leases). */
	toolSchemaTokensActive: number
	/** Tokens attributable to the always-resident core prefix. */
	coreToolTokens: number
	/** Tokens attributable to the leased (active, non-core) tools. */
	leasedToolTokens: number
	/** Headline metric: tokens avoided by not exposing unleased schemas. */
	toolSchemaTokensAvoided: number
	/** Capabilities moved into ACTIVE this generation. */
	capabilitiesActivated: number
	/** Capabilities moved out of ACTIVE this generation. */
	capabilitiesReleased: number
	/** Capability requests observed this generation. */
	capabilityRequests: number
	/** Capability denials observed this generation. */
	capabilityDenials: number
	/** Correlation signals (reported, not gated). */
	invalidToolCalls?: number
	malformedArgCount?: number
	retries?: number
	hallucinatedToolCount?: number
}

/**
 * Additive optional extension of the sibling `WorkerResult`. Purely additive:
 * it introduces exactly one optional `capabilityTelemetry` field and redefines
 * no base field. An absent field means accounting is UNREPORTED, never zero.
 */
export interface WorkerResultWithCapabilityTelemetry extends WorkerResult {
	capabilityTelemetry?: CapabilityTelemetry
}

/**
 * Inputs to the per-generation accounting computation. Correlation signals are
 * optional and pass through to the telemetry untouched when supplied.
 *
 * `toolSchemaTokensActive` is the sum of `coreToolTokens` and
 * `leasedToolTokens`; callers that already have the split pass both and the
 * total is derived, keeping the invariant check anchored on the authoritative
 * operands.
 */
export interface CapabilityTelemetryInput {
	/** MCP tools available (allowed/configured) this generation. */
	availableMcpToolCount: number
	/** MCP tools whose schema was actually serialized this generation. */
	activeMcpToolCount: number
	/** Counterfactual token cost if every configured capability were exposed. */
	toolSchemaTokensTotalIfAllExposed: number
	/** Tokens attributable to the always-resident core prefix. */
	coreToolTokens: number
	/** Tokens attributable to the leased (active, non-core) tools. */
	leasedToolTokens: number
	/** Capabilities moved into ACTIVE this generation. */
	capabilitiesActivated: number
	/** Capabilities moved out of ACTIVE this generation. */
	capabilitiesReleased: number
	/** Capability requests observed this generation. */
	capabilityRequests: number
	/** Capability denials observed this generation. */
	capabilityDenials: number
	/** Correlation signals (reported, not gated). */
	invalidToolCalls?: number
	malformedArgCount?: number
	retries?: number
	hallucinatedToolCount?: number
}

/** Why the accounting invariant was violated. */
export type CapabilityTelemetryInvariantError =
	| "negative-operand" // a token/count operand was negative or non-integer
	| "active-exceeds-total" // toolSchemaTokensActive > toolSchemaTokensTotalIfAllExposed

/**
 * Explicit result of the per-generation accounting computation. `ok: true`
 * carries the exact telemetry; `ok: false` carries the invariant-violation
 * reason so the broker can OMIT `capabilityTelemetry` and record an error
 * indication without altering the generation's primary result.
 */
export type ComputeCapabilityTelemetryResult =
	| { ok: true; telemetry: CapabilityTelemetry }
	| { ok: false; error: CapabilityTelemetryInvariantError }

/** True when `value` is a non-negative integer. */
function isNonNegativeInteger(value: number): boolean {
	return Number.isInteger(value) && value >= 0
}

/**
 * Compute the per-generation context-accounting telemetry.
 *
 * The savings invariant is exact: serialized tokens are `coreToolTokens +
 * leasedToolTokens`; the baseline is `toolSchemaTokensTotalIfAllExposed`; and
 * `toolSchemaTokensAvoided = baseline − serialized`. The computation enforces
 * that every count/token operand is a non-negative integer and that serialized
 * never exceeds the baseline, so the saving is never negative.
 *
 * IF any operand is negative/non-integer, or serialized exceeds the baseline,
 * the function returns `{ ok: false, error }` so the caller OMITS the field and
 * records an error indication — it NEVER returns a telemetry object with a
 * clamped or negative saving, and NEVER substitutes zero for an invariant
 * violation.
 *
 * _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
 */
export function computeCapabilityTelemetry(input: CapabilityTelemetryInput): ComputeCapabilityTelemetryResult {
	const {
		availableMcpToolCount,
		activeMcpToolCount,
		toolSchemaTokensTotalIfAllExposed,
		coreToolTokens,
		leasedToolTokens,
		capabilitiesActivated,
		capabilitiesReleased,
		capabilityRequests,
		capabilityDenials,
		invalidToolCalls,
		malformedArgCount,
		retries,
		hallucinatedToolCount,
	} = input

	// Every required count/token operand must be a non-negative integer.
	const requiredOperands = [
		availableMcpToolCount,
		activeMcpToolCount,
		toolSchemaTokensTotalIfAllExposed,
		coreToolTokens,
		leasedToolTokens,
		capabilitiesActivated,
		capabilitiesReleased,
		capabilityRequests,
		capabilityDenials,
	]
	if (requiredOperands.some((operand) => !isNonNegativeInteger(operand))) {
		return { ok: false, error: "negative-operand" }
	}

	// Optional correlation signals, when supplied, must also be non-negative integers.
	const optionalOperands = [invalidToolCalls, malformedArgCount, retries, hallucinatedToolCount]
	if (optionalOperands.some((operand) => operand !== undefined && !isNonNegativeInteger(operand))) {
		return { ok: false, error: "negative-operand" }
	}

	// Serialized tokens this generation = core prefix + leased (active) tools.
	const toolSchemaTokensActive = coreToolTokens + leasedToolTokens

	// You can never serialize more than the full configured universe.
	if (toolSchemaTokensActive > toolSchemaTokensTotalIfAllExposed) {
		return { ok: false, error: "active-exceeds-total" }
	}

	// Savings is exact and, by the checks above, a non-negative integer.
	const toolSchemaTokensAvoided = toolSchemaTokensTotalIfAllExposed - toolSchemaTokensActive

	const telemetry: CapabilityTelemetry = {
		availableMcpToolCount,
		activeMcpToolCount,
		toolSchemaTokensTotalIfAllExposed,
		toolSchemaTokensActive,
		coreToolTokens,
		leasedToolTokens,
		toolSchemaTokensAvoided,
		capabilitiesActivated,
		capabilitiesReleased,
		capabilityRequests,
		capabilityDenials,
		...(invalidToolCalls !== undefined ? { invalidToolCalls } : {}),
		...(malformedArgCount !== undefined ? { malformedArgCount } : {}),
		...(retries !== undefined ? { retries } : {}),
		...(hallucinatedToolCount !== undefined ? { hallucinatedToolCount } : {}),
	}

	return { ok: true, telemetry }
}
