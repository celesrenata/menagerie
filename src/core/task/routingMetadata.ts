// Consume WorkerResult read-only from the mastermind-execution-metadata types
// (exported from @roo-code/types, as the sibling modules autonomousTaskState.ts
// and normalizeWorkerResult.ts do). This module never modifies, removes, or
// widens any base WorkerResult field — RoutingMetadata is purely additive
// (Req 12.1, 12.2).
import type { WorkerResult } from "@roo-code/types"

import type { CapabilityLane } from "./capabilityLanes"

/**
 * Additive, all-optional routing telemetry (Req 12.1, 12.2).
 *
 * `RoutingMetadata` is machine-readable and consumed by OmniRoute/NerveCenter.
 * Every field is optional so an absent field reads as "unset" rather than an
 * error, letting downstream gates treat a missing trigger as "not present"
 * (Req 12.5). Lane fields name semantic *roles* (`CapabilityLane`), never a
 * model, size, quantization, or GPU; `hardware_lane` is an opaque,
 * OmniRoute-owned label, never a device identity Menagerie branches on.
 */
export interface RoutingMetadata {
	confidence?: number
	files_inspected?: number
	symbols_inspected?: number
	ambiguities?: number
	conflicting_findings?: number
	recommended_escalation?: CapabilityLane | null
	tests_run?: number
	tests_passed?: number
	failure_class?: string | null
	model_lane?: CapabilityLane
	hardware_lane?: string | null
}

/**
 * The extended worker result consumed by OmniRoute/NerveCenter. The base
 * `WorkerResult` contract is unchanged; `routing` is optional so an absent
 * `routing` (or any absent sub-field) reads as unset, never an error
 * (Req 12.5).
 */
export interface WorkerResultWithRouting extends WorkerResult {
	routing?: RoutingMetadata
}

/**
 * Typed, total reader for a single `RoutingMetadata` field. Returns `undefined`
 * for any absent field (missing `routing` block or missing sub-field) without
 * throwing, so downstream gates treat a missing trigger as "not present" rather
 * than an error (Req 12.5).
 */
export function readRoutingField<K extends keyof RoutingMetadata>(
	result: WorkerResultWithRouting | undefined,
	field: K,
): RoutingMetadata[K] | undefined {
	return result?.routing?.[field]
}
