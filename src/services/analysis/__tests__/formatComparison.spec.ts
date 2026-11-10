import { formatComparison, runGoldenSet } from "../AnalysisBenchmark"
import { GOLDEN_SET } from "../__fixtures__/goldenSet"

describe("formatComparison", () => {
	it("renders both labelled columns from two reports", async () => {
		const down = await runGoldenSet({ execute: async (r) => ({ kind: "unavailable", requestId: r.requestId, reason: "x" }) }, GOLDEN_SET.slice(0, 2))
		const md = formatComparison({ label: "granite", report: down }, { label: "reader", report: down })
		expect(md.split("\n")[0]).toBe("| Metric | granite | reader |")
		expect(md).toContain("| Schema-valid after <=1 retry | 0.0% | 0.0% |")
		expect(md).toContain("| Citation precision | n/a | n/a |")
	})
})
