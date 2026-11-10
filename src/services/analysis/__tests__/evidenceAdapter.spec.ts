import type { AnalysisOutcome, AnalysisRequest } from "@roo-code/types"

import { createPreparedContextWorkPackageBuilder } from "../../../core/task/preparedContextWorkPackage"
import { sha256Hex } from "../analysisDigest"
import { evidencePacketToAnalysisEvidence, outcomeToReaderFindings, workerResultToEvidencePacket, extractFileCitations } from "../evidenceAdapter"

const files: Record<string, string> = { "src/a.ts": "l1\nl2\nl3\nl4", "src/big.ts": "x".repeat(10_000) }
const opts = { workspaceUri: "file:///w", readFileText: async (p: string) => files[p] }
const item = (file: string, startLine: number, endLine: number, extra = {}) => ({ file, startLine, endLine, score: 1, reason: "r", ...extra })

describe("evidencePacketToAnalysisEvidence", () => {
	it("reads real text, pins the file digest and assigns Menagerie-owned anchor ids", async () => {
		const r = await evidencePacketToAnalysisEvidence({ query: "q", items: [item("src/a.ts", 2, 3, { snippet: "ignored" })] }, opts)
		expect(r.skipped).toEqual([])
		expect(r.evidence[0]).toMatchObject({ anchorId: "e1", excerpt: "l2\nl3" })
		expect(r.evidence[0].anchor).toMatchObject({ path: "src/a.ts", fileDigest: sha256Hex(files["src/a.ts"]), startLine: 2, endLine: 3 })
	})

	it("skips, visibly, stale / unsafe / unreadable / out-of-range / oversize items and never truncates", async () => {
		const r = await evidencePacketToAnalysisEvidence(
			{
				query: "q",
				items: [
					item("src/a.ts", 1, 1, { fresh: false }),
					item("../secret", 1, 1),
					item("/etc/passwd", 1, 1),
					item("src/none.ts", 1, 1),
					item("src/a.ts", 3, 99),
					item("src/big.ts", 1, 1),
				],
			},
			opts,
		)
		expect(r.evidence).toEqual([])
		expect(r.skipped.map((s) => s.reason)).toEqual(["stale", "unsafe-path", "unsafe-path", "unreadable", "bad-range", "over-limit"])
	})

	it("caps item count", async () => {
		const items = Array.from({ length: 5 }, () => item("src/a.ts", 1, 1))
		const r = await evidencePacketToAnalysisEvidence({ query: "q", items }, { ...opts, maxItems: 2 })
		expect(r.evidence).toHaveLength(2)
		expect(r.skipped).toHaveLength(3)
	})
})

describe("outcomeToReaderFindings", () => {
	const request = {
		requestId: "r",
		operation: "summarize-evidence",
		evidence: [{ anchorId: "e1", anchor: { workspaceUri: "file:///w", path: "src/a.ts", fileDigest: "d", startLine: 2, endLine: 3 }, excerpt: "l2\nl3" }],
		instructionsVersion: "v",
		schemaVersion: 1,
		maxOutputTokens: 256,
	} as AnalysisRequest
	const valid: AnalysisOutcome = {
		kind: "valid",
		requestId: "r",
		operation: "summarize-evidence",
		findings: [{ claim: "A claim", anchorIds: ["e1"], confidence: 0.7, uncertainty: "maybe" }],
		unknowns: [],
		digest: "a".repeat(64),
		modelId: "m",
		retried: false,
	}

	it("maps to the existing ReaderFinding shape with file:line pointers and no source text", () => {
		const [f] = outcomeToReaderFindings(valid, request)
		expect(f).toMatchObject({ claim: "A claim", location: "src/a.ts:2-3", uncertainty: "maybe", confidence: 0.7 })
		expect(f.evidence).toEqual([{ type: "file", reference: "src/a.ts", lines: [2, 3] }])
		expect(JSON.stringify(f)).not.toContain("l2")
	})

	it("yields nothing for any non-valid outcome", () => {
		expect(outcomeToReaderFindings({ kind: "timeout", requestId: "r", reason: "x" }, request)).toEqual([])
	})

	it("feeds the existing PreparedContextWorkPackage builder without a new package type", () => {
		const builder = createPreparedContextWorkPackageBuilder()
		const pkg = builder.build({ objective: "do it", readerFindings: outcomeToReaderFindings(valid, request) })
		expect(pkg.readerFindings?.[0].claim).toBe("A claim")
	})
})

describe("workerResultToEvidencePacket", () => {
	const base = { summary: "s", findings: [{ claim: "x" }], changes: [], tests: [], blockers: [], artifacts: [] }
	it("keeps only file references with line ranges from a completed result, deduplicated", () => {
		const packet = workerResultToEvidencePacket(
			{
				...base,
				status: "completed",
				evidence: [
					{ type: "file", reference: "src/a.ts", lines: [1, 3] },
					{ type: "file", reference: "src/a.ts", lines: [1, 3] },
					{ type: "file", reference: "src/b.ts" },
					{ type: "test", reference: "a.spec.ts", result: "pass" },
				],
			},
			"q",
		)
		expect(packet.items.map((i) => `${i.file}:${i.startLine}-${i.endLine}`)).toEqual(["src/a.ts:1-3"])
	})
	it("contributes nothing from failed or blocked results", () => {
		for (const status of ["failed", "blocked"] as const) {
			expect(workerResultToEvidencePacket({ ...base, status, evidence: [{ type: "file", reference: "a.ts", lines: [1, 2] }] }, "q").items).toEqual([])
		}
	})
	it("a scout-cited invented range is dropped by the digest-pinning adapter", async () => {
		const packet = workerResultToEvidencePacket(
			{ ...base, status: "completed", evidence: [{ type: "file", reference: "src/a.ts", lines: [1, 99] }] },
			"q",
		)
		const out = await evidencePacketToAnalysisEvidence(packet, { workspaceUri: "file:///w", readFileText: async () => "one\ntwo" })
		expect(out.evidence).toEqual([])
		expect(out.skipped[0].reason).toBe("bad-range")
	})
})

describe("extractFileCitations", () => {
	it("finds path:line and path:start-end citations in prose, deduplicated", () => {
		const text = "The cache lives in src/cache.ts:10-24 and is read at src/api/user.ts:7. Again src/cache.ts:10-24."
		expect(extractFileCitations(text)).toEqual([
			{ type: "file", reference: "src/cache.ts", lines: [10, 24] },
			{ type: "file", reference: "src/api/user.ts", lines: [7, 7] },
		])
	})
	it("ignores urls, versions and inverted or oversize ranges, and bounds the count", () => {
		expect(extractFileCitations("see http://host:8080 and v1.2:3 and a.ts:9-2 and b.ts:1-9999")).toEqual([])
		const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts:${i + 1}`).join(" ")
		expect(extractFileCitations(many)).toHaveLength(8)
	})
	it("extracted citations to a nonexistent range are dropped by the digest-pinning adapter", async () => {
		const packet = { query: "q", items: extractFileCitations("see src/a.ts:1-3 and src/a.ts:50").map((e) => ({ file: e.reference, startLine: e.lines![0], endLine: e.lines![1], score: 1, reason: "r" })) }
		const out = await evidencePacketToAnalysisEvidence(packet, opts)
		expect(out.evidence.map((e) => e.anchor.startLine)).toEqual([1])
		expect(out.skipped.map((s) => s.reason)).toEqual(["bad-range"])
	})
})
