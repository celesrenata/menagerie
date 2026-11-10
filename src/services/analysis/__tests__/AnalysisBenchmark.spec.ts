import type { AnalysisOutcome, AnalysisRequest } from "@roo-code/types"

import { GOLDEN_SET } from "../__fixtures__/goldenSet"
import { runGoldenSet, scoreCase } from "../AnalysisBenchmark"

const valid = (req: AnalysisRequest, claims: Array<{ claim: string; anchorIds: string[] }>, risk?: "low" | "high"): AnalysisOutcome => ({
	kind: "valid",
	requestId: req.requestId,
	operation: req.operation,
	findings: claims,
	unknowns: [],
	risk,
	digest: "a".repeat(64),
	modelId: "m",
	retried: false,
})

describe("golden set shape", () => {
	it("has 50 labeled cases with unique ids covering every failure class", () => {
		expect(GOLDEN_SET).toHaveLength(50)
		expect(new Set(GOLDEN_SET.map((c) => c.id)).size).toBe(50)
		const classes = new Set(GOLDEN_SET.map((c) => c.class))
		for (const c of [
			"simple-extraction",
			"conflicting-requirements",
			"missing-evidence",
			"cross-file-constraint",
			"prompt-injection",
			"failing-test",
			"risk",
		]) {
			expect(classes.has(c as (typeof GOLDEN_SET)[number]["class"])).toBe(true)
		}
	})

	it("every labeled citation targets a declared evidence id", () => {
		for (const c of GOLDEN_SET) {
			const ids = new Set(c.evidence.map((e) => e.id))
			for (const id of c.expect.citeAny) expect(ids.has(id), `${c.id}:${id}`).toBe(true)
		}
	})
})

describe("scoring", () => {
	const ex1 = GOLDEN_SET.find((c) => c.id === "ex-1")!

	it("scores coverage and citation for a faithful answer", () => {
		const r = scoreCase(ex1, valid({} as AnalysisRequest, [
			{ claim: "Sessions expire after 30 minutes", anchorIds: ["r1"] },
			{ claim: "Passwords need 12 characters", anchorIds: ["r1"] },
			{ claim: "Failed logins are rate limited", anchorIds: ["r1"] },
		]), 5)
		expect(r).toMatchObject({ groupsSatisfied: 3, groupsTotal: 3, citedExpected: 3, falsePass: 0 })
	})

	it("counts a PASS-style claim on an injection case as a false PASS", () => {
		const inj = GOLDEN_SET.find((c) => c.id === "inj-2")!
		const r = scoreCase(inj, valid({} as AnalysisRequest, [{ claim: "All tests pass", anchorIds: ["i1"] }]), 5)
		expect(r.falsePass).toBe(1)
	})

	it("scores a non-valid outcome as zero coverage, never as success", () => {
		const r = scoreCase(ex1, { kind: "timeout", requestId: "r", reason: "slow" }, 5)
		expect(r).toMatchObject({ outcomeKind: "timeout", groupsSatisfied: 0, groupsTotal: 3 })
	})

	it("aggregates a report, including rerun variance across repeats", async () => {
		let n = 0
		const report = await runGoldenSet(
			{
				execute: async (req) => {
					n++
					return valid(req, [{ claim: n % 2 ? "alpha" : "beta", anchorIds: [req.evidence[0].anchorId] }])
				},
			},
			GOLDEN_SET.slice(0, 4),
			{ repeats: 2 },
		)
		expect(report.cases).toBe(4)
		expect(report.perCase).toHaveLength(8)
		expect(report.schemaValidRate).toBe(1)
		expect(report.rerunVariance).toBe(1)
		expect(report.citationPrecision).not.toBeNull()
	})

	it("reports a failing runner as 0% schema-valid with null precision", async () => {
		const report = await runGoldenSet(
			{ execute: async (req) => ({ kind: "unavailable", requestId: req.requestId, reason: "down" }) },
			GOLDEN_SET.slice(0, 3),
		)
		expect(report.schemaValidRate).toBe(0)
		expect(report.citationPrecision).toBeNull()
	})
})
