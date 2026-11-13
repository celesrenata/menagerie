import type { VerificationPolicy, WorkerResult } from "@roo-code/types"
import {
	MAX_REWORK_ROUNDS,
	buildReworkFeedback,
	nextAuditStep,
	resolveAuditPolicy,
	isVerifierModeUsable,
	AUDIT_SKIPPED_WARNING,
	runAuditLoop,
	auditTerminalState,
	type AuditAttempt,
} from "../auditLoop"
import { gateParentOutcome } from "../verificationGate"

const policy: VerificationPolicy = { required: true, criteria: ["tests pass", "no lint errors"] }

const result = (status: WorkerResult["status"], failedCriteria: string[] = []): WorkerResult => ({
	status,
	summary: status === "completed" ? "all good" : "criteria failed",
	findings: [],
	evidence: failedCriteria.map((reference) => ({ type: "test" as const, reference, result: "fail" })),
	changes: [],
	tests: [],
	blockers: [],
	artifacts: [],
})

const pass: AuditAttempt = { state: "completed", result: result("completed"), taskId: "v-pass" }
const fail: AuditAttempt = { state: "completed", result: result("failed", ["tests pass"]), taskId: "v-fail" }
const implementer: AuditAttempt = { state: "completed", result: result("completed"), taskId: "impl" }

describe("nextAuditStep", () => {
	it("verifies first when the implementer completed", () => {
		expect(nextAuditStep({ policy, implementerState: "completed", reworkRounds: 0 })).toEqual({
			action: "verify",
			criteria: ["tests pass", "no lint errors"],
		})
	})

	it("does not verify a failed implementer", () => {
		const step = nextAuditStep({ policy, implementerState: "failed", reworkRounds: 0 })
		expect(step).toMatchObject({ action: "done", outcome: { kind: "failed" } })
	})

	it("reworks on verifier FAIL while rounds remain, then escalates", () => {
		const base = { policy, implementerState: "completed" as const, verifierState: "completed" as const }
		expect(nextAuditStep({ ...base, verifierResult: fail.result, reworkRounds: 0 }).action).toBe("rework")
		expect(nextAuditStep({ ...base, verifierResult: fail.result, reworkRounds: MAX_REWORK_ROUNDS }).action).toBe(
			"escalate",
		)
	})
})

describe("runAuditLoop", () => {
	const deps = (overrides: Partial<Parameters<typeof runAuditLoop>[0]> = {}) => ({
		policy,
		implementer,
		runVerifier: vi.fn(async () => pass),
		rework: vi.fn(async () => implementer),
		escalate: vi.fn(async () => undefined),
		...overrides,
	})

	it("passes first time with one verifier and no rework", async () => {
		const d = deps()
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("pass")
		expect(out.record).toMatchObject({ rounds: 0, verifierTaskIds: ["v-pass"] })
		expect(d.rework).not.toHaveBeenCalled()
	})

	it("reworks once after FAIL, then passes after re-verify", async () => {
		const runVerifier = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(pass)
		const d = deps({ runVerifier })
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("pass")
		expect(out.record.rounds).toBe(1)
		expect(d.rework).toHaveBeenCalledTimes(1)
		expect(vi.mocked(d.rework).mock.calls[0]![0].feedback).toContain("tests pass")
		expect(out.record.verifierTaskIds).toEqual(["v-fail", "v-pass"])
	})

	it("exhausts bounded rounds, escalates once, and never reports pass", async () => {
		const escalate = vi.fn(async () => ({ lane: "reader.deep", summary: "look at X" }))
		const d = deps({ runVerifier: vi.fn(async () => fail), escalate })
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("not-successfully-verified")
		expect(out.record.rounds).toBe(MAX_REWORK_ROUNDS)
		expect(d.rework).toHaveBeenCalledTimes(MAX_REWORK_ROUNDS)
		expect(escalate).toHaveBeenCalledTimes(1)
		expect(out.record.escalation).toEqual({ lane: "reader.deep", summary: "look at X" })
	})

	it("treats a cancelled verifier as not verified and reworks", async () => {
		const runVerifier = vi.fn().mockResolvedValueOnce({ state: "cancelled" }).mockResolvedValueOnce(pass)
		const out = await runAuditLoop(deps({ runVerifier }))
		expect(out.record.rounds).toBe(1)
		expect(out.outcome.kind).toBe("pass")
	})

	it("skips the verifier when the implementer failed", async () => {
		const d = deps({ implementer: { state: "failed" } })
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("failed")
		expect(d.runVerifier).not.toHaveBeenCalled()
	})

	it("stops when a rework run fails", async () => {
		const d = deps({
			runVerifier: vi.fn(async () => fail),
			rework: vi.fn(async () => ({ state: "failed" as const })),
		})
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("failed")
	})

	it("stops when cancelled mid-audit", async () => {
		const d = deps({ isCancelled: () => true })
		const out = await runAuditLoop(d)
		expect(out.outcome.kind).toBe("not-successfully-verified")
		expect(d.runVerifier).not.toHaveBeenCalled()
	})
})

describe("Granite evidence constraint", () => {
	it("cannot reach pass without a passing verifier result, whatever analysis says", () => {
		// The audit API has no analysis/Granite input; the only path to pass is a verifier result.
		const outcome = gateParentOutcome({ policy, implementerState: "completed" })
		expect(outcome.kind).toBe("not-successfully-verified")
		expect(gateParentOutcome({ policy, implementerState: "completed", verifierState: "completed" }).kind).toBe(
			"not-successfully-verified",
		)
	})

	it("builds rework feedback from failed criteria", () => {
		expect(buildReworkFeedback(fail.result, "completed")).toContain("- tests pass")
		expect(buildReworkFeedback(undefined, "cancelled")).toContain("cancelled")
	})
})

describe("resolveAuditPolicy", () => {
	it("audits edit-capable workers by default and skips readers", () => {
		expect(resolveAuditPolicy({}, undefined, true)?.required).toBe(true)
		expect(resolveAuditPolicy({}, "edits", false)).toBeUndefined()
	})
	it("off skips synthesized audits but honors an explicit required policy", () => {
		expect(resolveAuditPolicy({}, "off", true)).toBeUndefined()
		expect(resolveAuditPolicy({ verification: policy }, "off", false)).toBe(policy)
		expect(resolveAuditPolicy({ verification: { required: false } }, "edits", true)).toBeUndefined()
	})
})

describe("auditTerminalState", () => {
	it("keeps a passing audit completed", () => {
		expect(auditTerminalState({ kind: "pass", reason: "ok" }, false)).toEqual({ state: "completed" })
	})
	it("does not report unverified work as completed", () => {
		const out = auditTerminalState({ kind: "not-successfully-verified", reason: "tests fail" }, false)
		expect(out.state).toBe("failed")
		expect(out.error).toContain("Verification not passed")
	})
	it("reports cancelled when stopped", () => {
		expect(auditTerminalState({ kind: "not-successfully-verified", reason: "x" }, true).state).toBe("cancelled")
	})
})

describe("escalation seed", () => {
	it("passes the latest reworked implementer to escalate", async () => {
		const reworked = { state: "completed" as const, taskId: "latest" }
		const escalate = vi.fn(async () => undefined)
		await runAuditLoop({
			policy: { required: true, criteria: ["c"] },
			implementer: { state: "completed", taskId: "first" },
			runVerifier: vi.fn(async () => ({ state: "failed" as const })),
			rework: vi.fn(async () => reworked),
			escalate,
		})
		expect((escalate.mock.calls[0] as unknown[])[0]).toMatchObject({ implementer: { taskId: "latest" } })
	})
})

describe("audit verifier availability", () => {
	it("skips the default audit when the verifier mode is unavailable instead of failing every edit worker", () => {
		expect(resolveAuditPolicy({}, "edits", true, false)).toBeUndefined()
		expect(
			resolveAuditPolicy({ verification: { required: true, criteria: ["x"] } }, "edits", true, false),
		).toBeUndefined()
		expect(resolveAuditPolicy({}, "edits", true, true)?.required).toBe(true)
		expect(AUDIT_SKIPPED_WARNING).toContain("NOT independently verified")
	})
	it("treats a missing or edit-capable verifier mode as unusable", () => {
		const canEdit = (groups: ReadonlyArray<unknown> | undefined) => (groups ?? []).includes("edit")
		expect(isVerifierModeUsable(undefined, canEdit)).toBe(false)
		expect(isVerifierModeUsable({ groups: ["read", "edit"] }, canEdit)).toBe(false)
		expect(isVerifierModeUsable({ groups: ["read"] }, canEdit)).toBe(true)
	})
})
