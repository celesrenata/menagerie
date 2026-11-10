import { describe, expect, it } from "vitest"

import { decideFixerLoop, gateParentOutcome } from "../../task/verificationGate"
import { evaluateSpecGate } from "../SpecGate"
import { planSpecFixer, runnerEvidence, verifierGatePassed } from "../SpecGateJoin"
import { resolveWorkflowPolicy } from "../SpecWorkflowPolicy"
import { baseRevision, currentDigests } from "./specFixtures"

const rev = baseRevision()
const approval = { revisionId: rev.revisionId, approvedBy: "user" as const, approvedAt: 1 }
const run = (exitCode: number, over = {}) => ({
	checkRunId: `r${exitCode}`,
	sourceRevision: "git:aaa",
	exitCode,
	artifactDigest: "b".repeat(64),
	inputDigests: { "src/session.ts": "digest-of-src/session.ts" },
	recordedAt: 10,
	...over,
})
const gate = (evidence: ReturnType<typeof runnerEvidence>[], verifier = true) =>
	evaluateSpecGate({ revision: rev, approval, evidence, currentSourceRevision: "git:aaa", currentInputDigests: currentDigests(rev), verifierGatePassed: verifier })

describe("runnerEvidence", () => {
	it("is pass only for exit code 0", () => {
		expect(runnerEvidence(rev, "A1", run(0)).status).toBe("pass")
		expect(runnerEvidence(rev, "A1", run(1)).status).toBe("fail")
		expect(runnerEvidence(rev, "A1", run(137)).status).toBe("fail")
	})
	it("rejects unknown acceptance ids", () => {
		expect(() => runnerEvidence(rev, "nope", run(0))).toThrow()
	})
})

describe("acceptance demonstration: coder says success but the executable test fails", () => {
	it("is not verified even though the implementer completed and the verifier gate passed", () => {
		const outcome = gateParentOutcome({ policy: { required: true, criteria: ["c"] }, implementerState: "completed", verifierState: "completed", verifierResult: { status: "completed" } as never })
		expect(outcome.kind).toBe("pass")
		const result = gate([runnerEvidence(rev, "A1", run(1))], verifierGatePassed([outcome]))
		expect(result.verdict).toBe("failed")
	})

	it("records the old failure alongside new passing evidence on a fixer re-run", () => {
		const fail = runnerEvidence(rev, "A1", run(1, { recordedAt: 10 }))
		const pass = runnerEvidence(rev, "A1", run(0, { checkRunId: "fixed", recordedAt: 20 }))
		const result = gate([fail, pass])
		expect(result.acceptance.find((a) => a.acceptanceId === "A1")?.state).toBe("pass")
		// verdict still not-verified because A2/A3 have no evidence; the old failure remains in the list
		expect([fail, pass].map((e) => e.checkRunId)).toEqual(["r1", "fixed"])
		expect(result.verdict).toBe("not-verified")
	})
})

describe("verifierGatePassed", () => {
	it("treats an empty outcome list as not passed", () => {
		expect(verifierGatePassed([])).toBe(false)
		expect(verifierGatePassed([{ kind: "pass", reason: "" }, { kind: "not-successfully-verified", reason: "" }])).toBe(false)
		expect(verifierGatePassed([{ kind: "pass", reason: "" }])).toBe(true)
	})
})

describe("planSpecFixer", () => {
	const failed = runnerEvidence(rev, "A1", run(1))
	const failedGate = gate([failed])
	const loop = decideFixerLoop({
		outcome: { kind: "not-successfully-verified", reason: "" },
		implementerState: "completed",
		verifierState: "completed",
		verifierResult: { status: "failed" } as never,
	})

	it("links the retry to the failing requirement and keeps prior evidence", () => {
		const plan = planSpecFixer({ rev, gate: failedGate, evidence: [failed], loop, attemptsSoFar: 0, maxAttempts: 2 })
		expect(plan).toEqual({ schedule: true, attempt: 1, links: [{ acceptanceId: "A1", requirementIds: ["R1"], priorCheckRunIds: ["r1"] }] })
	})

	it("stops at the attempt bound", () => {
		const plan = planSpecFixer({ rev, gate: failedGate, evidence: [failed], loop, attemptsSoFar: 2, maxAttempts: 2 })
		expect(plan).toMatchObject({ schedule: false, exhausted: true })
	})

	it("does not schedule when the existing loop does not", () => {
		const idle = decideFixerLoop({ outcome: { kind: "pass", reason: "" }, implementerState: "completed" })
		expect(planSpecFixer({ rev, gate: failedGate, evidence: [failed], loop: idle, attemptsSoFar: 0, maxAttempts: 2 }).schedule).toBe(false)
	})
})

describe("resolveWorkflowPolicy", () => {
	it("is inert when disabled, whatever the policy", () => {
		for (const policy of ["explore", "build", "strict"] as const) {
			expect(resolveWorkflowPolicy({ enabled: false, policy })).toMatchObject({ active: false, mayWriteCode: true, gateEnforced: false, requiresFrozenSpec: false })
		}
		expect(resolveWorkflowPolicy({ enabled: true }).active).toBe(false)
	})
	it("explore cannot write code; strict requires approval and gates; build allows one worker", () => {
		expect(resolveWorkflowPolicy({ enabled: true, policy: "explore" }).mayWriteCode).toBe(false)
		expect(resolveWorkflowPolicy({ enabled: true, policy: "strict" })).toMatchObject({ requiresApproval: true, gateEnforced: true, requiredAnalysisFailsClosed: true })
		expect(resolveWorkflowPolicy({ enabled: true, policy: "build" })).toMatchObject({ allowSingleWorker: true, requiresFrozenSpec: false })
	})
})
