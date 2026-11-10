import type { AnalysisEvidenceItem } from "@roo-code/types"

import {
	DEFAULT_ANALYSIS_BUDGET,
	GRANITE_SERVED_CONTEXT_TOKENS,
	chunkEvidence,
	estimateTokens,
	inputLimit,
	preflight,
} from "../AnalysisBudget"

const item = (id: string, chars: number): AnalysisEvidenceItem => ({
	anchorId: id,
	anchor: { workspaceUri: "file:///w", path: `${id}.ts`, fileDigest: "d", startLine: 1, endLine: 2 },
	excerpt: "a".repeat(chars),
})

describe("estimateTokens", () => {
	it("over-counts ASCII relative to 4 chars/token and counts non-ASCII 1:1", () => {
		expect(estimateTokens("a".repeat(100))).toBe(40)
		expect(estimateTokens("日本語")).toBe(3)
	})
})

describe("inputLimit / preflight", () => {
	it("serves 32768, not the 131072 checkpoint window", () => {
		expect(GRANITE_SERVED_CONTEXT_TOKENS).toBe(32_768)
		expect(DEFAULT_ANALYSIS_BUDGET.servedContextTokens).toBe(32_768)
	})

	it("limits input to the working ceiling, below the window", () => {
		expect(inputLimit(768)).toBe(3_000)
	})

	it("respects output reserve and safety margin when the ceiling is raised to the window", () => {
		const cfg = { ...DEFAULT_ANALYSIS_BUDGET, maxInputTokens: 1_000_000 }
		// 32768 - 1024 - ceil(3276.8)=3277 => 28467
		expect(inputLimit(1_024, cfg)).toBe(28_467)
	})

	it("refuses a 31K+ token prompt rather than sending or truncating it", () => {
		const big = "x".repeat(31_000 * 3)
		const result = preflight(big, 768)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toMatch(/exceeds/)
		const cfg = { ...DEFAULT_ANALYSIS_BUDGET, maxInputTokens: 1_000_000 }
		expect(preflight(big, 768, cfg).ok).toBe(false)
	})

	it("refuses when the output allowance exhausts the window", () => {
		const cfg = { ...DEFAULT_ANALYSIS_BUDGET, servedContextTokens: 1_000 }
		const result = preflight("hi", 990, cfg)
		expect(result.ok).toBe(false)
		expect(inputLimit(990, cfg)).toBe(0)
	})

	it("accepts a prompt inside the budget", () => {
		expect(preflight("a".repeat(2_000), 768).ok).toBe(true)
	})
})

describe("chunkEvidence", () => {
	it("keeps every item exactly once, in order, within budget", () => {
		const items = Array.from({ length: 10 }, (_, i) => item(`e${i}`, 1_000)) // 400 tokens each
		const result = chunkEvidence(items, 1_000)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.batches.flat().map((i) => i.anchorId)).toEqual(items.map((i) => i.anchorId))
		for (const batch of result.batches) {
			expect(batch.reduce((n, i) => n + estimateTokens(i.excerpt), 0)).toBeLessThanOrEqual(1_000)
		}
		expect(result.batches.length).toBe(5)
	})

	it("reports a single oversize item instead of truncating it", () => {
		const result = chunkEvidence([item("small", 100), item("huge", 50_000)], 1_000)
		expect(result).toMatchObject({ ok: false, oversizeAnchorId: "huge" })
	})

	it("returns no batches for no items", () => {
		expect(chunkEvidence([], 1_000)).toEqual({ ok: true, batches: [] })
	})
})
