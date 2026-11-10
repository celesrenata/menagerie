import { sealRevision } from "../specRevision"
import { evaluateSpecGate, type GateInput } from "../SpecGate"
import { impactOf, invalidatedByRevision, requirementCoverage } from "../SpecTraceability"
import { baseContent, baseRevision, currentDigests, evidence } from "./specFixtures"

const rev = baseRevision()
const approval = { revisionId: rev.revisionId, approvedBy: "user" as const, approvedAt: 1 }
const allPass = () => ["A1", "A2", "A3"].map((id) => evidence(rev, id))

const gate = (over: Partial<GateInput> = {}) =>
	evaluateSpecGate({
		revision: rev,
		approval,
		evidence: allPass(),
		currentSourceRevision: "git:aaa",
		currentInputDigests: currentDigests(rev),
		verifierGatePassed: true,
		...over,
	})

describe("evaluateSpecGate", () => {
	it("passes only when every required criterion has fresh runner evidence AND the verifier gate passed", () => {
		const r = gate()
		expect(r.verdict).toBe("pass")
		expect(r.coverage).toMatchObject({ total: 3, covered: 3 })
	})

	it("acceptance demo 5: a failing test is not verified even if everything else (incl. verifier-claimed text) is positive", () => {
		const r = gate({ evidence: [evidence(rev, "A1"), evidence(rev, "A2", { status: "fail", exitCode: 1 }), evidence(rev, "A3")] })
		expect(r.verdict).toBe("failed")
		expect(r.coverage.covered).toBe(2)
	})

	it("a later passing run (fixer) supersedes an earlier failure; a later failure beats an earlier pass", () => {
		const fixed = gate({ evidence: [evidence(rev, "A1", { status: "fail", exitCode: 1, recordedAt: 1 }), evidence(rev, "A1", { recordedAt: 2 }), evidence(rev, "A2"), evidence(rev, "A3")] })
		expect(fixed.verdict).toBe("pass")
		const regressed = gate({ evidence: [evidence(rev, "A1", { recordedAt: 1 }), evidence(rev, "A1", { status: "fail", exitCode: 2, recordedAt: 2 }), evidence(rev, "A2"), evidence(rev, "A3")] })
		expect(regressed.verdict).toBe("failed")
	})

	it("missing evidence is not-verified, never pass", () => {
		const r = gate({ evidence: [evidence(rev, "A1"), evidence(rev, "A2")] })
		expect(r.verdict).toBe("not-verified")
		expect(r.reasons.join()).toContain("A3")
	})

	it("stale evidence (input digest changed) is not-verified", () => {
		const r = gate({ currentInputDigests: { ...currentDigests(rev), "src/password.ts": "different" } })
		expect(r.verdict).toBe("not-verified")
		expect(r.acceptance.find((a) => a.acceptanceId === "A2")?.state).toBe("stale")
		expect(r.acceptance.find((a) => a.acceptanceId === "A1")?.state).toBe("pass")
	})

	it("cannot be satisfied by a model-sourced record, a runner pass without exit 0, or a human on an executable check", () => {
		const modelSourced = gate({ evidence: [evidence(rev, "A1", { source: "model" as never }), evidence(rev, "A2"), evidence(rev, "A3")] })
		expect(modelSourced.verdict).toBe("not-verified")
		expect(modelSourced.acceptance[0].state).toBe("invalid-evidence")
		const noExit = gate({ evidence: [evidence(rev, "A1", { exitCode: 1 }), evidence(rev, "A2"), evidence(rev, "A3")] })
		expect(noExit.acceptance[0].state).toBe("invalid-evidence")
		const human = gate({ evidence: [evidence(rev, "A1", { source: "human" }), evidence(rev, "A2"), evidence(rev, "A3")] })
		expect(human.verdict).toBe("not-verified")
	})

	it("a failing independent verifier gate fails an otherwise-green spec", () => {
		expect(gate({ verifierGatePassed: false }).verdict).toBe("failed")
	})

	it("strict needs approval of this exact revision; blocked dependencies block", () => {
		expect(gate({ approval: undefined }).verdict).toBe("blocked")
		expect(gate({ approval: { ...approval, revisionId: "sha256:" + "1".repeat(64) } }).verdict).toBe("blocked")
		expect(gate({ blocked: { reason: "dependency blocked" } }).verdict).toBe("blocked")
	})

	it("a spec with no required criteria can never pass vacuously", () => {
		const optional = sealRevision(baseContent({ acceptance: baseContent().acceptance.map((a) => ({ ...a, required: false })) }))
		const r = evaluateSpecGate({ revision: optional, approval: { ...approval, revisionId: optional.revisionId }, evidence: [], currentSourceRevision: "git:aaa", currentInputDigests: {}, verifierGatePassed: true })
		expect(r.verdict).toBe("not-verified")
	})

	it("inspection criteria need human evidence", () => {
		const c = baseContent()
		const insp = sealRevision({
			...c,
			acceptance: [{ ...c.acceptance[0], evidenceKind: "inspection" }, c.acceptance[1], c.acceptance[2]],
			checks: [{ id: "C1", kind: "inspection", inputs: ["src/session.ts"] }, c.checks[1], c.checks[2]],
		})
		const ok = evaluateSpecGate({
			revision: insp,
			approval: { ...approval, revisionId: insp.revisionId },
			evidence: [evidence(insp, "A1", { source: "human", exitCode: undefined }), evidence(insp, "A2"), evidence(insp, "A3")],
			currentSourceRevision: "git:aaa",
			currentInputDigests: currentDigests(insp),
			verifierGatePassed: true,
		})
		expect(ok.verdict).toBe("pass")
	})
})

describe("revision lineage: only dependent evidence is invalidated (acceptance demo 6)", () => {
	const next = sealRevision(
		baseContent({
			parentRevisionId: rev.revisionId,
			requirements: baseContent().requirements.map((r) => (r.id === "R2" ? { ...r, text: "Passwords are at least 16 characters." } : r)),
		}),
	)

	it("invalidates R2's criteria and its dependents only", () => {
		const impact = invalidatedByRevision(rev, next)
		expect(impact.acceptanceIds).toEqual(["A2"])
		expect(impact.taskIds).toEqual(["t2"])
		expect(impact.checkIds).toEqual(["C2"])
	})

	it("a changed upstream task invalidates its dependents' criteria too", () => {
		const c = baseContent()
		const edited = sealRevision({ ...c, tasks: c.tasks.map((t) => (t.id === "t1" ? { ...t, summary: "Session expiry v2" } : t)) })
		const impact = invalidatedByRevision(rev, edited)
		expect(impact.taskIds).toEqual(["t1", "t2"])
		expect(impact.acceptanceIds).toEqual(["A1", "A2"])
	})

	it("carries over unaffected evidence from the parent revision, but not invalidated evidence", () => {
		const parentEvidence = allPass()
		const r = evaluateSpecGate({
			revision: next,
			previousRevision: rev,
			approval: { ...approval, revisionId: next.revisionId },
			evidence: parentEvidence,
			currentSourceRevision: "git:aaa",
			currentInputDigests: currentDigests(next),
			verifierGatePassed: true,
		})
		expect(r.verdict).toBe("not-verified")
		expect(Object.fromEntries(r.acceptance.map((a) => [a.acceptanceId, a.state]))).toEqual({ A1: "pass", A2: "missing", A3: "pass" })
	})

	it("path impact: editing one source file touches only the check/task that reads or writes it", () => {
		const impact = impactOf(rev, { paths: ["src/ratelimit.ts"] })
		expect(impact).toMatchObject({ checkIds: ["C3"], taskIds: ["t3"], acceptanceIds: ["A3"], requirementIds: ["R3"] })
	})
})

describe("requirementCoverage", () => {
	it("counts a requirement covered only when all its required criteria pass", () => {
		expect(requirementCoverage(rev, new Set(["A1", "A3"]))).toMatchObject({ total: 3, covered: 2, uncoveredIds: ["R2"] })
		expect(requirementCoverage(rev, new Set())).toMatchObject({ covered: 0 })
	})
})
