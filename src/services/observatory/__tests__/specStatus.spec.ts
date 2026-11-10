import type { ObservedTask, SpecStatusSummary } from "@roo-code/types"
import { beforeEach, describe, expect, it } from "vitest"

import { computeMastermindSummary } from "../aggregation"
import { clearSpecStatusForTests, getSpecStatus, setSpecStatus } from "../specStatusRegistry"
import { analysisMetricsSnapshot, recordAnalysisEscalation, recordAnalysisEvent, resetAnalysisMetricsForTests } from "../../analysis/analysisMetrics"

const status = (specId: string): SpecStatusSummary => ({
	specId,
	revisionId: `sha256:${"0".repeat(64)}`,
	phase: "verified",
	verdict: "pass",
	requirementsCovered: "1/1",
	reasons: [],
	updatedAt: 1,
})

describe("spec status in the Mastermind summary", () => {
	beforeEach(() => {
		clearSpecStatusForTests()
		resetAnalysisMetricsForTests()
	})

	it("leaves the summary byte-identical when there is no spec status", () => {
		const workers: ObservedTask[] = []
		expect(computeMastermindSummary("p", workers)).toEqual(computeMastermindSummary("p", workers, undefined))
		expect(computeMastermindSummary("p", workers, [])).not.toHaveProperty("spec")
	})

	it("adds spec status when present, per parent task", () => {
		setSpecStatus("p1", [status("a")])
		expect(computeMastermindSummary("p1", [], getSpecStatus("p1")).spec?.[0].specId).toBe("a")
		expect(getSpecStatus("p2")).toBeUndefined()
	})

	it("bounds the registry and evicts the oldest parent", () => {
		for (let i = 0; i < 70; i++) setSpecStatus(`p${i}`, [status("s")])
		expect(getSpecStatus("p0")).toBeUndefined()
		expect(getSpecStatus("p69")).toBeDefined()
	})
})

describe("analysis metrics", () => {
	beforeEach(() => resetAnalysisMetricsForTests())
	it("counts requests, cache hits, retries, tokens and outcomes from events only", () => {
		recordAnalysisEvent({ type: "cache-hit", requestId: "a" })
		recordAnalysisEvent({ type: "attempt-failed", requestId: "b", attempt: 1, kind: "non-json", reason: "x" })
		recordAnalysisEvent({ type: "completed", requestId: "b", kind: "valid", attempts: 2, promptTokens: 10, completionTokens: 5, suppressedFindings: 0 })
		recordAnalysisEvent({ type: "completed", requestId: "c", kind: "timeout", attempts: 1, suppressedFindings: 0 })
		recordAnalysisEscalation()
		expect(analysisMetricsSnapshot({ active: 2, waiting: 1 })).toEqual({
			requests: 2,
			cacheHits: 1,
			retries: 1,
			outcomes: { valid: 1, timeout: 1 },
			promptTokens: 10,
			completionTokens: 5,
			escalations: 1,
			queueActive: 2,
			queueWaiting: 1,
			queueWaitMsAvg: 0,
			queueWaitMsMax: 0,
			latencyMsAvg: 0,
			latencyMsMax: 0,
		})
		recordAnalysisEvent({ type: "completed", requestId: "d", kind: "valid", attempts: 1, suppressedFindings: 0, queueWaitMs: 100, latencyMs: 400 })
		recordAnalysisEvent({ type: "completed", requestId: "e", kind: "valid", attempts: 1, suppressedFindings: 0, queueWaitMs: 300, latencyMs: 800 })
		expect(analysisMetricsSnapshot({ active: 0, waiting: 0 })).toMatchObject({ queueWaitMsAvg: 200, queueWaitMsMax: 300, latencyMsAvg: 600, latencyMsMax: 800 })
	})
})
