import type { AnalysisOutcome } from "@roo-code/types"

import { adviseAnalysisEscalation, analysisOutcomeToEscalationSignals, selectAnalysisExecutor } from "../analysisWorkRouting"
import { decide } from "../readerEscalationDecision"

const healthy = { published: true, healthy: true }
const base = { enabled: true, requiresTools: false, required: false, route: healthy }

describe("selectAnalysisExecutor", () => {
	it("disabled means the legacy reader path, byte-for-byte: no new executor, lane unchanged", () => {
		expect(selectAnalysisExecutor({ ...base, enabled: false })).toEqual({ executor: "tool-reader", lane: "reader.fast", reason: "disabled" })
		expect(selectAnalysisExecutor({ ...base, enabled: false, route: { published: false, healthy: false }, required: true })).toMatchObject({ executor: "tool-reader" })
	})

	it("never routes tool-using discovery to the analysis executor, even when healthy and required", () => {
		expect(selectAnalysisExecutor({ ...base, requiresTools: true, required: true })).toEqual({ executor: "tool-reader", lane: "reader.fast", reason: "requires-tools" })
	})

	it("routes pure transforms to the analysis executor when the published route is healthy", () => {
		expect(selectAnalysisExecutor(base)).toEqual({ executor: "analysis" })
	})

	it("acceptance demo 8: optional analysis is skipped visibly; required analysis escalates, never fails open", () => {
		for (const route of [{ published: false, healthy: false }, { published: true, healthy: false }]) {
			const optional = selectAnalysisExecutor({ ...base, route })
			expect(optional).toMatchObject({ executor: "skipped" })
			const required = selectAnalysisExecutor({ ...base, route, required: true })
			expect(required).toMatchObject({ executor: "escalate", lane: "reader.deep" })
			expect(required.executor).not.toBe("analysis")
		}
		expect((selectAnalysisExecutor({ ...base, route: { published: false, healthy: false } }) as { reason: string }).reason).toMatch(/no analysis route/)
	})
})

describe("analysisOutcomeToEscalationSignals feeds the EXISTING escalation decision", () => {
	const cost = { modelSwapLoadLatencyMs: 0, interruptsParallelFastCapacity: false, queuedFastReaderWork: 0, expectedDeepTaskMs: 0, alternateHardwareCanAnswer: true, capacity: [{ route: "r", capacity: 4, available: 4, capability: "reader" as const }] }
	const valid = (over: Partial<Extract<AnalysisOutcome, { kind: "valid" }>>): AnalysisOutcome => ({ kind: "valid", requestId: "r", operation: "summarize-evidence", findings: [], unknowns: [], digest: "a".repeat(64), modelId: "m", retried: false, ...over })

	it("contradictions raise conflicting_findings; low self-reported confidence raises low-confidence", () => {
		const s = analysisOutcomeToEscalationSignals(valid({ operation: "find-contradictions", findings: [{ claim: "c", anchorIds: ["a", "b"], confidence: 0.3 }] }))
		expect(s.metadata).toMatchObject({ conflicting_findings: 1, confidence: 0.3 })
		const outcome = decide({ ...s, explicitRequest: false, cost })
		expect(outcome.action).toBe("escalate-deep")
		if (outcome.action === "escalate-deep") expect(outcome.triggers).toEqual(expect.arrayContaining(["contradictory-evidence", "low-confidence"]))
	})

	it("unknowns raise ambiguity; unusable output raises hard-analysis; infra failures raise nothing", () => {
		expect(analysisOutcomeToEscalationSignals(valid({ unknowns: ["u"] })).metadata.ambiguities).toBe(1)
		expect(analysisOutcomeToEscalationSignals({ kind: "oversize", requestId: "r", reason: "x" }).callerFlags.hardAnalysis).toBe(true)
		expect(analysisOutcomeToEscalationSignals({ kind: "stale-evidence", requestId: "r", reason: "x" }).callerFlags.unsuccessfulSearch).toBe(true)
		for (const kind of ["unavailable", "timeout", "rate-limited", "queue-full", "cancelled"] as const) {
			expect(analysisOutcomeToEscalationSignals({ kind, requestId: "r", reason: "x" })).toEqual({ metadata: {}, callerFlags: {} })
		}
	})

	it("a clean, confident result stays on the fast path", () => {
		const s = analysisOutcomeToEscalationSignals(valid({ findings: [{ claim: "c", anchorIds: ["a"], confidence: 0.9 }] }))
		expect(decide({ ...s, explicitRequest: false, cost }).action).toBe("stay-fast")
	})
})

describe("adviseAnalysisEscalation", () => {
	const valid = (over: Partial<Extract<AnalysisOutcome, { kind: "valid" }>> = {}): AnalysisOutcome => ({
		kind: "valid",
		requestId: "r",
		operation: "summarize-evidence",
		findings: [{ claim: "c", anchorIds: ["e1"], confidence: 0.9 }],
		unknowns: [],
		digest: "d".repeat(64),
		modelId: "m",
		retried: false,
		...over,
	})
	it("fires no trigger for a confident, grounded outcome", () => {
		expect(adviseAnalysisEscalation(valid())).toMatchObject({ qualityTriggered: false, triggers: [] })
	})
	it("reports low confidence", () => {
		const out = adviseAnalysisEscalation(valid({ findings: [{ claim: "c", anchorIds: ["e1"], confidence: 0.2 }] }))
		expect(out.qualityTriggered).toBe(true)
		expect(out.triggers).toContain("low-confidence")
	})
	it("reports high risk, contradictions and unknowns", () => {
		expect(adviseAnalysisEscalation(valid({ risk: "high" })).triggers).toContain("hard-analysis")
		const contradictions = valid({ operation: "find-contradictions", findings: [{ claim: "A vs B", anchorIds: ["e1"] }] })
		expect(adviseAnalysisEscalation(contradictions).triggers).toContain("contradictory-evidence")
		expect(adviseAnalysisEscalation(valid({ unknowns: ["what is X"] })).triggers).toContain("architectural-ambiguity")
	})
	it("reports an outcome the bounded executor could not handle", () => {
		expect(adviseAnalysisEscalation({ kind: "oversize", requestId: "r", reason: "too big" } as AnalysisOutcome).triggers).toContain("hard-analysis")
	})
	it("does not treat an infrastructure failure as a quality signal", () => {
		expect(adviseAnalysisEscalation({ kind: "unavailable", requestId: "r", reason: "down" } as AnalysisOutcome).qualityTriggered).toBe(false)
	})
})
