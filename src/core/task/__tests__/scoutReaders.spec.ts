import { buildScoutReaderSpecs, planScoutReaders } from "../scoutReaders"

describe("planScoutReaders", () => {
	it("produces only readers that have a concrete scope (no filler)", () => {
		expect(planScoutReaders({}).map((r) => r.kind)).toEqual([])
		const ranked = planScoutReaders({
			symbols: ["foo"],
			failingTests: ["bar"],
			dependencies: ["baz"],
		})
		expect(ranked.map((r) => r.kind)).toEqual(["symbol-locator", "test-failure-analyst", "dependency-docs-scout"])
	})

	it("ranks by information gain, highest first", () => {
		const ranked = planScoutReaders({
			symbols: ["a"],
			callGraphEntryPoints: ["b"],
			contractDocs: ["c"],
			dependencies: ["d"],
		})
		const gains = ranked.map((r) => r.informationGain)
		expect(gains).toEqual([...gains].sort((a, b) => b - a))
		// api-contract-reader (0.8) outranks call-graph-scout (0.75), which outranks
		// dependency-docs-scout (0.6); symbol-locator (0.9) leads.
		expect(ranked[0]?.kind).toBe("symbol-locator")
		expect(ranked[ranked.length - 1]?.kind).toBe("dependency-docs-scout")
	})

	it("gives every reader a bounded budget, timeout, and structured result schema", () => {
		const [scout] = planScoutReaders({ failingTests: ["t1"] })
		expect(scout).toMatchObject({
			kind: "test-failure-analyst",
			byteBudget: expect.any(Number),
			timeoutMs: expect.any(Number),
			priority: "background",
		})
		expect(scout?.resultSchema).toContain("failures[]")
		expect(scout?.byteBudget).toBeGreaterThan(0)
	})
})

describe("buildScoutReaderSpecs", () => {
	it("returns nothing for a zero or negative ceiling (no fabricated work)", () => {
		expect(buildScoutReaderSpecs({ symbols: ["a"], failingTests: ["b"] }, 0)).toEqual([])
		expect(buildScoutReaderSpecs({ symbols: ["a"], failingTests: ["b"] }, -1)).toEqual([])
	})

	it("caps fan-out at the ceiling and projects bounded ParallelTaskSpecs", () => {
		const specs = buildScoutReaderSpecs(
			{
				readerMode: "project-reader",
				symbols: ["a"],
				callGraphEntryPoints: ["b"],
				failingTests: ["c"],
				contractDocs: ["d"],
				dependencies: ["e"],
			},
			2,
		)
		expect(specs).toHaveLength(2)
		// Highest information gain first: symbol-locator (0.9), then test-failure (0.85);
		// the api-contract reader (0.8) is dropped by the ceiling of 2.
		expect(specs.map((s) => s.name)).toEqual(["scout-symbol-locator", "scout-test-failure"])
		expect(specs[1]).toMatchObject({
			mode: "project-reader",
			todos: null,
			priority: "background",
		})
		expect(specs[1]!.expectedOutput).toContain("failures[]")
		expect(typeof specs[1]!.deadlineMs).toBe("number")
	})
})
