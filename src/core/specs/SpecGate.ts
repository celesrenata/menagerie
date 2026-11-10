import type { SpecApproval, SpecEvidenceRecord, SpecRevision } from "@roo-code/types"

import { invalidatedByRevision, requirementCoverage, type RequirementCoverage } from "./SpecTraceability"

/**
 * Deterministic acceptance gate (MEN-GRANITE-SDD-001 R8).
 *
 *   PASS := every required acceptance id has a FRESH passing artifact from an allowed source
 *           AND (policy=strict => this exact revision is user-approved)
 *           AND the existing independent verifier gate passed
 *           AND nothing is blocked.
 *
 * The inputs are artifacts and booleans produced by test runners and `verificationGate.ts`.
 * There is no parameter through which model text can contribute a PASS: evidence `source` has no
 * model-generated member (see `EVIDENCE_SOURCES`), and unknown sources are rejected here too.
 */

export type GateVerdict = "pass" | "failed" | "not-verified" | "blocked"
export type AcceptanceState = "pass" | "failed" | "missing" | "stale" | "invalid-evidence"

export interface AcceptanceStatus {
	acceptanceId: string
	required: boolean
	state: AcceptanceState
	reason: string
}

export interface GateInput {
	revision: SpecRevision
	/** Revision this one descends from. Used only to carry over evidence for unchanged criteria. */
	previousRevision?: SpecRevision
	approval?: SpecApproval
	evidence: readonly SpecEvidenceRecord[]
	/** Workspace revision right now. */
	currentSourceRevision: string
	/** Current content digest per workspace path, for the paths checks declare as `inputs`. */
	currentInputDigests: Readonly<Record<string, string>>
	/** Outcome of the existing independent verifier gate (`verificationGate.ts`). */
	verifierGatePassed: boolean
	/** A dependency of this spec is blocked, or a spec change is awaiting approval. */
	blocked?: { reason: string }
}

export interface GateResult {
	verdict: GateVerdict
	reasons: string[]
	acceptance: AcceptanceStatus[]
	coverage: RequirementCoverage
}

function allowedSource(kind: string, source: string): boolean {
	// Executable checks are decided by a runner (or the verifier gate); only an inspection may be a human.
	return kind === "inspection" ? source === "human" : source === "runner" || source === "verifier-gate"
}

export function evaluateSpecGate(input: GateInput): GateResult {
	const { revision: rev } = input
	const reasons: string[] = []

	// Evidence for the previous revision counts only for criteria the new revision did not invalidate.
	const carriedOver = input.previousRevision !== undefined && input.previousRevision.revisionId !== rev.revisionId
	const invalidated = carriedOver ? new Set(invalidatedByRevision(input.previousRevision!, rev).acceptanceIds) : new Set<string>()
	const checkById = new Map(rev.checks.map((c) => [c.id, c]))

	const usable = (r: SpecEvidenceRecord): boolean =>
		r.revisionId === rev.revisionId || (carriedOver && r.revisionId === input.previousRevision!.revisionId && !invalidated.has(r.acceptanceId))

	const acceptance: AcceptanceStatus[] = rev.acceptance.map((a) => {
		const base = { acceptanceId: a.id, required: a.required }
		const check = checkById.get(a.checkRef)
		const records = input.evidence.filter((r) => r.acceptanceId === a.id && r.checkId === a.checkRef && usable(r))
		if (records.length === 0 || !check) return { ...base, state: "missing", reason: "no evidence recorded for this criterion" }

		// Latest record decides, so a fixer's later pass supersedes an earlier fail and a later fail beats an earlier pass.
		const latest = records.reduce((x, y) => (y.recordedAt >= x.recordedAt ? y : x))

		const inputs = check.inputs ?? []
		const fresh =
			inputs.length > 0
				? inputs.every((p) => input.currentInputDigests[p] !== undefined && latest.inputDigests[p] === input.currentInputDigests[p])
				: latest.sourceRevision === input.currentSourceRevision
		if (!fresh) return { ...base, state: "stale", reason: "evidence predates the current source" }

		if (!allowedSource(check.kind, latest.source)) {
			return { ...base, state: "invalid-evidence", reason: `source ${latest.source} cannot decide a ${check.kind} check` }
		}
		if (latest.status === "fail") return { ...base, state: "failed", reason: "latest check run failed" }
		if (latest.status === "unknown") return { ...base, state: "missing", reason: "latest check run was inconclusive" }
		if (latest.source === "runner" && latest.exitCode !== 0) {
			return { ...base, state: "invalid-evidence", reason: "pass recorded without exit code 0" }
		}
		return { ...base, state: "pass", reason: "fresh passing artifact" }
	})

	const passing = new Set(acceptance.filter((s) => s.state === "pass").map((s) => s.acceptanceId))
	const coverage = requirementCoverage(rev, passing)
	const required = acceptance.filter((s) => s.required)

	if (input.blocked) {
		reasons.push(`blocked: ${input.blocked.reason}`)
		return { verdict: "blocked", reasons, acceptance, coverage }
	}
	if (rev.policy === "strict" && !(input.approval && input.approval.revisionId === rev.revisionId && input.approval.approvedBy === "user")) {
		reasons.push("blocked: strict revision is not user-approved")
		return { verdict: "blocked", reasons, acceptance, coverage }
	}

	const failed = required.filter((s) => s.state === "failed")
	if (failed.length > 0) {
		reasons.push(...failed.map((s) => `${s.acceptanceId}: ${s.reason}`))
		return { verdict: "failed", reasons, acceptance, coverage }
	}
	if (!input.verifierGatePassed) {
		reasons.push("independent verifier gate did not pass")
		return { verdict: "failed", reasons, acceptance, coverage }
	}
	if (required.length === 0) {
		reasons.push("no required acceptance criteria: nothing can be verified")
		return { verdict: "not-verified", reasons, acceptance, coverage }
	}
	const unverified = required.filter((s) => s.state !== "pass")
	if (unverified.length > 0) {
		reasons.push(...unverified.map((s) => `${s.acceptanceId}: ${s.state} (${s.reason})`))
		return { verdict: "not-verified", reasons, acceptance, coverage }
	}
	return { verdict: "pass", reasons: ["all required criteria have fresh passing artifacts"], acceptance, coverage }
}
