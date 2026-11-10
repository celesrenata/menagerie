import {
	ANALYSIS_FAILURE_KINDS,
	ANALYSIS_LIMITS,
	ANALYSIS_OPERATIONS,
	analysisFindingSchema,
	analysisModelResponseSchema,
	analysisOperationSchema,
	analysisOutcomeSchema,
	analysisRequestSchema,
	evidenceAnchorSchema,
} from "../analysis-contracts.js"

const anchor = {
	workspaceUri: "file:///ws",
	path: "src/a.ts",
	fileDigest: "abc",
	startLine: 1,
	endLine: 3,
}
const request = {
	requestId: "r1",
	operation: "summarize-evidence",
	evidence: [{ anchorId: "a1", anchor, excerpt: "x" }],
	instructionsVersion: "v1",
	schemaVersion: 1,
	maxOutputTokens: 512,
}

describe("analysis contracts", () => {
	it("covers exactly the eight spec operations", () => {
		expect([...ANALYSIS_OPERATIONS].sort()).toEqual(
			[
				"classify-change-risk",
				"extract-code-contract",
				"extract-requirements",
				"find-contradictions",
				"map-acceptance-to-tests",
				"review-diff-against-criteria",
				"summarize-evidence",
				"triage-test-failure",
			].sort(),
		)
		for (const op of ANALYSIS_OPERATIONS) expect(analysisOperationSchema.safeParse(op).success).toBe(true)
		expect(analysisOperationSchema.safeParse("write-file").success).toBe(false)
	})

	it("accepts a valid request and rejects unknown keys, bad lines and duplicate anchor ids", () => {
		expect(analysisRequestSchema.safeParse(request).success).toBe(true)
		expect(analysisRequestSchema.safeParse({ ...request, tools: [] }).success).toBe(false)
		expect(evidenceAnchorSchema.safeParse({ ...anchor, startLine: 5, endLine: 2 }).success).toBe(false)
		expect(evidenceAnchorSchema.safeParse({ ...anchor, startLine: 0 }).success).toBe(false)
		const dup = { ...request, evidence: [request.evidence[0], request.evidence[0]] }
		expect(analysisRequestSchema.safeParse(dup).success).toBe(false)
	})

	it("bounds output tokens, evidence count, and schema version", () => {
		expect(
			analysisRequestSchema.safeParse({ ...request, maxOutputTokens: ANALYSIS_LIMITS.maxOutputTokens + 1 })
				.success,
		).toBe(false)
		expect(analysisRequestSchema.safeParse({ ...request, maxOutputTokens: 0 }).success).toBe(false)
		expect(analysisRequestSchema.safeParse({ ...request, schemaVersion: 2 }).success).toBe(false)
		expect(analysisRequestSchema.safeParse({ ...request, evidence: [] }).success).toBe(false)
	})

	it("validates findings: confidence range, claim length, strict keys", () => {
		expect(analysisFindingSchema.safeParse({ claim: "c", anchorIds: ["a1"], confidence: 0.5 }).success).toBe(true)
		expect(analysisFindingSchema.safeParse({ claim: "c", anchorIds: [], confidence: 1.5 }).success).toBe(false)
		expect(
			analysisFindingSchema.safeParse({ claim: "x".repeat(ANALYSIS_LIMITS.maxClaimChars + 1), anchorIds: [] })
				.success,
		).toBe(false)
		expect(analysisFindingSchema.safeParse({ claim: "c", anchorIds: [], digest: "model-supplied" }).success).toBe(
			false,
		)
	})

	it("model response cannot carry a self-asserted digest or pass status", () => {
		expect(analysisModelResponseSchema.safeParse({ findings: [] }).success).toBe(true)
		expect(analysisModelResponseSchema.safeParse({ findings: [], digest: "d" }).success).toBe(false)
		expect(analysisModelResponseSchema.safeParse({ findings: [], status: "PASS" }).success).toBe(false)
		expect(analysisModelResponseSchema.safeParse({ findings: [], risk: "extreme" }).success).toBe(false)
	})

	it("outcome union accepts every failure kind and a valid outcome, rejects unknown kinds", () => {
		for (const kind of ANALYSIS_FAILURE_KINDS) {
			expect(analysisOutcomeSchema.safeParse({ kind, requestId: "r", reason: "why" }).success).toBe(true)
		}
		const valid = {
			kind: "valid",
			requestId: "r",
			operation: "summarize-evidence",
			findings: [],
			unknowns: [],
			digest: "a".repeat(64),
			modelId: "granite-4.2-8b",
			retried: false,
		}
		expect(analysisOutcomeSchema.safeParse(valid).success).toBe(true)
		expect(analysisOutcomeSchema.safeParse({ ...valid, digest: "short" }).success).toBe(false)
		expect(analysisOutcomeSchema.safeParse({ kind: "pass", requestId: "r", reason: "x" }).success).toBe(false)
	})
})
