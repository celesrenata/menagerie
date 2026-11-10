import type { AnalysisOutcome, AnalysisRequest } from "@roo-code/types"

import { PairwiseAnalysisRunner, type AnalysisRunner } from "../PairwiseAnalysisRunner"

const anchor = (path: string) => ({ workspaceUri: "file:///w", path, fileDigest: "d", startLine: 1, endLine: 1 })
const request = (n: number, operation: AnalysisRequest["operation"] = "find-contradictions"): AnalysisRequest => ({
	requestId: "r",
	operation,
	evidence: Array.from({ length: n }, (_, i) => ({ anchorId: `p${i + 1}`, anchor: anchor(`f${i}.md`), excerpt: `s${i}` })),
	instructionsVersion: "v",
	schemaVersion: 1,
	maxOutputTokens: 400,
})
const valid = (req: AnalysisRequest, claim?: string): AnalysisOutcome => ({
	kind: "valid",
	requestId: req.requestId,
	operation: req.operation,
	findings: claim ? [{ claim, anchorIds: req.evidence.map((e) => e.anchorId) }] : [],
	unknowns: [],
	digest: "a".repeat(64),
	modelId: "m",
	retried: false,
})
const opts = { votes: 3, maxItems: 6, modelId: "m", templateVersion: "t", minPositive: 1 }
const runner = (fn: (r: AnalysisRequest) => AnalysisOutcome): { r: PairwiseAnalysisRunner; calls: AnalysisRequest[] } => {
	const calls: AnalysisRequest[] = []
	const inner: AnalysisRunner = { execute: async (req) => (calls.push(req), fn(req)) }
	return { r: new PairwiseAnalysisRunner(inner, opts), calls }
}

describe("PairwiseAnalysisRunner", () => {
	it("passes every other operation straight through", async () => {
		const { r, calls } = runner((q) => valid(q))
		await r.execute(request(3, "summarize-evidence"))
		expect(calls).toHaveLength(1)
	})

	it("runs one vote set per pair with distinct sample indexes, and cites exactly the pair", async () => {
		const { r, calls } = runner((q) => valid(q, "conflict"))
		const out = await r.execute(request(3))
		expect(calls).toHaveLength(9) // 3 pairs x 3 votes
		expect(new Set(calls.map((c) => c.sample))).toEqual(new Set([0, 1, 2]))
		expect(out.kind === "valid" && out.findings.map((f) => f.anchorIds)).toEqual([["p1", "p2"], ["p1", "p3"], ["p2", "p3"]])
	})

	const mk = (minPositive: number | undefined, fn: (q: AnalysisRequest) => AnalysisOutcome) =>
		new PairwiseAnalysisRunner({ execute: async (q) => fn(q) }, { ...opts, minPositive })

	it("with a majority threshold (2 of 3), a lone positive is outvoted", async () => {
		const lone = mk(2, (q) => valid(q, q.sample === 0 ? "conflict" : undefined))
		expect((await lone.execute(request(2))) as { findings: unknown[] }).toMatchObject({ findings: [] })
		const two = mk(2, (q) => valid(q, q.sample === 2 ? undefined : "conflict"))
		expect(((await two.execute(request(2))) as { findings: unknown[] }).findings).toHaveLength(1)
	})

	it("defaults to ANY positive vote (recall-oriented), as measured", async () => {
		const out = await mk(undefined, (q) => valid(q, q.sample === 0 ? "conflict" : undefined)).execute(request(2))
		expect((out as { findings: unknown[] }).findings).toHaveLength(1)
	})

	it("marks a pair undecided, not clean, when too few votes were valid", async () => {
		const { r } = runner((q) => (q.sample === 0 ? valid(q) : { kind: "non-json", requestId: q.requestId, reason: "x" }))
		const out = await r.execute(request(2))
		expect(out.kind === "valid" && out.findings).toHaveLength(0)
		expect(out.kind === "valid" && out.unknowns.join()).toContain("undecided")
	})

	it("fails the whole call when every vote failed, and on timeout/cancel", async () => {
		expect((await runner((q) => ({ kind: "unavailable", requestId: q.requestId, reason: "down" })).r.execute(request(2))).kind).toBe("unavailable")
		const t = await runner((q) => (q.sample === 1 ? { kind: "timeout", requestId: q.requestId, reason: "slow" } : valid(q))).r.execute(request(2))
		expect(t).toMatchObject({ kind: "timeout", requestId: "r" })
	})

	it("refuses to fan out beyond maxItems", async () => {
		const { r, calls } = runner((q) => valid(q))
		expect((await r.execute(request(7))).kind).toBe("oversize")
		expect(calls).toHaveLength(0)
	})
})
