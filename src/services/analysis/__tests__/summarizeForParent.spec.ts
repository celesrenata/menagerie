import type { AnalysisOutcome } from "@roo-code/types"

import { DEFAULT_PARENT_SUMMARY_CHARS, summarizeOutcomeForParent } from "../summarizeForParent"

const valid = (n: number): AnalysisOutcome => ({
	kind: "valid",
	requestId: "r",
	operation: "summarize-evidence",
	findings: Array.from({ length: n }, (_, i) => ({ claim: `claim ${i} ${"x".repeat(200)}`, anchorIds: ["a1"] })),
	unknowns: [],
	digest: "a".repeat(64),
	modelId: "m",
	retried: false,
})

describe("summarizeOutcomeForParent", () => {
	it("stays within the per-operation budget no matter how many findings", () => {
		const text = summarizeOutcomeForParent(valid(32))
		expect(text.length).toBeLessThanOrEqual(DEFAULT_PARENT_SUMMARY_CHARS)
		expect(text).toContain("more lines omitted")
	})

	it("is far below the legacy 64K reader cap and carries ids, not excerpts", () => {
		expect(DEFAULT_PARENT_SUMMARY_CHARS).toBeLessThan(6_000)
		expect(summarizeOutcomeForParent(valid(1))).toContain("[a1]")
	})

	it("renders failures as a short tagged line, never as success", () => {
		expect(summarizeOutcomeForParent({ kind: "timeout", requestId: "r", reason: "slow" })).toBe("[analysis timeout] slow")
	})
})
