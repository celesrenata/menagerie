import type { AnalysisOutcome, AnalysisRequest } from "@roo-code/types"

import { createPreparedContextWorkPackageBuilder } from "../../../core/task/preparedContextWorkPackage"
import { sha256Hex } from "../analysisDigest"
import { evidencePacketToAnalysisEvidence, outcomeToReaderFindings } from "../evidenceAdapter"

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
