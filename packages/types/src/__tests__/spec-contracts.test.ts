import { EVIDENCE_SOURCES, SPEC_ID_PATTERN, specEvidenceRecordSchema, specRevisionSchema, specTaskSchema } from "../spec-contracts.js"

const digest = "sha256:" + "a".repeat(64)

describe("spec contracts", () => {
	it("has no model-generated evidence source, so a model cannot be the recorded source of a PASS", () => {
		expect([...EVIDENCE_SOURCES].sort()).toEqual(["human", "runner", "verifier-gate"])
		const base = {
			revisionId: digest,
			acceptanceId: "A1",
			checkId: "C1",
			sourceRevision: "git:aaa",
			checkRunId: "run-1",
			status: "pass",
			exitCode: 0,
			artifactDigest: "b".repeat(64),
			recordedAt: 1,
		}
		expect(specEvidenceRecordSchema.safeParse({ ...base, source: "runner" }).success).toBe(true)
		expect(specEvidenceRecordSchema.safeParse({ ...base, source: "model" }).success).toBe(false)
		expect(specEvidenceRecordSchema.safeParse({ ...base, source: "granite" }).success).toBe(false)
	})

	it("ids cannot contain path separators or traversal", () => {
		for (const bad of ["../x", "a/b", "", "1abc", "a b"]) expect(SPEC_ID_PATTERN.test(bad)).toBe(false)
		expect(SPEC_ID_PATTERN.test("req-1.a_b")).toBe(true)
	})

	it("tasks must trace to at least one requirement; unknown keys are rejected", () => {
		const task = { id: "t1", summary: "s", dependsOn: [], requirementIds: ["R1"], acceptanceIds: [] }
		expect(specTaskSchema.safeParse(task).success).toBe(true)
		expect(specTaskSchema.safeParse({ ...task, requirementIds: [] }).success).toBe(false)
		expect(specTaskSchema.safeParse({ ...task, status: "done" }).success).toBe(false)
	})

	it("revision requires a well-formed revisionId", () => {
		const rev = { specId: "demo", revisionId: "not-a-digest", policy: "strict", sourceRevision: "x", requirements: [], decisions: [], tasks: [], acceptance: [], checks: [] }
		expect(specRevisionSchema.safeParse(rev).success).toBe(false)
		expect(specRevisionSchema.safeParse({ ...rev, revisionId: digest }).success).toBe(true)
	})
})
