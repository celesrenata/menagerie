// Feature: elastic-parallel-execution, Task 14.1: logical-worker → persisted lifecycle status mapping
import { describe, expect, it } from "vitest"

import { logicalWorkerStateToLifecycleStatus, type LogicalWorkerState } from "../elasticTypes"

/**
 * Validates: Requirements 21.4 — the twelve scheduler-internal states integrate
 * with the existing persisted lifecycle statuses only at proven boundaries
 * (`active` while running, `completed` on success) and introduce no new
 * persisted status for `failed`/`cancelled`, which flow through existing paths.
 */
describe("logicalWorkerStateToLifecycleStatus", () => {
	const runningStates: readonly LogicalWorkerState[] = [
		"queued",
		"runnable",
		"waiting-for-inference",
		"generating",
		"running-tool",
		"waiting-on-tool",
		"waiting-on-dependency",
		"waiting-for-user",
		"verifying",
	]

	it.each(runningStates)("maps non-terminal running state %s onto persisted 'active'", (state) => {
		expect(logicalWorkerStateToLifecycleStatus(state)).toBe("active")
	})

	it("maps terminal success onto persisted 'completed'", () => {
		expect(logicalWorkerStateToLifecycleStatus("completed")).toBe("completed")
	})

	it.each<LogicalWorkerState>(["failed", "cancelled"])(
		"returns undefined for terminal %s so it flows through existing cancel/fail paths, not a synthesized persisted status",
		(state) => {
			expect(logicalWorkerStateToLifecycleStatus(state)).toBeUndefined()
		},
	)

	it("never synthesizes the delegation-owned 'delegated' or 'interrupted' statuses from a worker state", () => {
		const allStates: readonly LogicalWorkerState[] = [
			...runningStates,
			"completed",
			"failed",
			"cancelled",
		]
		const produced = allStates.map(logicalWorkerStateToLifecycleStatus)
		expect(produced).not.toContain("delegated")
		expect(produced).not.toContain("interrupted")
	})
})
