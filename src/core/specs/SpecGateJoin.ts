import type { SpecEvidenceRecord, SpecRevision } from "@roo-code/types"

import type { FixerLoopDecision, ParentOutcome } from "../task/verificationGate"
import type { GateResult } from "./SpecGate"

/**
 * Joins the deterministic `SpecGate` to the EXISTING execution machinery (MEN-GRANITE-SDD-001
 * R8.1, R8.3, R8.4). Nothing here runs a command or schedules a worker; it converts results the
 * existing runners and `verificationGate.ts` already produce into gate inputs and a bounded
 * fixer plan.
 */

export interface RunnerResult {
	checkRunId: string
	/** Workspace revision the command ran against. */
	sourceRevision: string
	/** Process exit status. The ONLY thing that decides pass/fail. */
	exitCode: number
	/** sha256 hex of the captured output artifact. */
	artifactDigest: string
	/** Digests of the check's declared inputs at run time. */
	inputDigests: Record<string, string>
	recordedAt: number
}

/**
 * Evidence from a real command run. pass iff exit code 0. There is no text parameter: prose,
 * including a model saying "tests pass", cannot reach this function.
 */
export function runnerEvidence(rev: SpecRevision, acceptanceId: string, run: RunnerResult): SpecEvidenceRecord {
	const acceptance = rev.acceptance.find((a) => a.id === acceptanceId)
	if (!acceptance) throw new Error(`unknown acceptance ${acceptanceId}`)
	const check = rev.checks.find((c) => c.id === acceptance.checkRef)
	if (!check) throw new Error(`acceptance ${acceptanceId} references undefined check ${acceptance.checkRef}`)
	if (check.kind === "inspection") throw new Error(`check ${check.id} is an inspection; runner evidence cannot decide it`)
	return {
		revisionId: rev.revisionId,
		acceptanceId,
		checkId: check.id,
		sourceRevision: run.sourceRevision,
		inputDigests: run.inputDigests,
		checkRunId: run.checkRunId,
		status: run.exitCode === 0 ? "pass" : "fail",
		exitCode: run.exitCode,
		artifactDigest: run.artifactDigest,
		source: "runner",
		recordedAt: run.recordedAt,
	}
}

/**
 * `GateInput.verifierGatePassed` from the existing per-task `gateParentOutcome` results. Empty
 * means nothing was verified, which is not a pass.
 */
export function verifierGatePassed(outcomes: readonly ParentOutcome[]): boolean {
	return outcomes.length > 0 && outcomes.every((o) => o.kind === "pass")
}

export interface FixerLink {
	acceptanceId: string
	requirementIds: string[]
	/** Run ids of earlier failing evidence. Retained, never erased. */
	priorCheckRunIds: string[]
}

export type SpecFixerPlan =
	| { schedule: false; reason: string }
	| { schedule: true; attempt: number; links: FixerLink[] }
	| { schedule: false; exhausted: true; reason: string; links: FixerLink[] }

/**
 * Bounds the existing fixer loop and links each retry to the requirements it serves. The loop
 * decision itself comes from `decideFixerLoop`; this adds the attempt cap and traceability.
 */
export function planSpecFixer(args: {
	rev: SpecRevision
	gate: GateResult
	evidence: readonly SpecEvidenceRecord[]
	loop: FixerLoopDecision
	attemptsSoFar: number
	maxAttempts: number
}): SpecFixerPlan {
	if (!args.loop.schedule) return { schedule: false, reason: args.loop.reason }

	const failing = args.gate.acceptance.filter((a) => a.required && (a.state === "failed" || a.state === "stale"))
	if (failing.length === 0) return { schedule: false, reason: "no required criterion is failing" }

	const links: FixerLink[] = failing.map((f) => ({
		acceptanceId: f.acceptanceId,
		requirementIds: args.rev.requirements.filter((r) => r.acceptanceIds.includes(f.acceptanceId)).map((r) => r.id),
		priorCheckRunIds: args.evidence.filter((e) => e.acceptanceId === f.acceptanceId && e.status === "fail").map((e) => e.checkRunId),
	}))
	if (args.attemptsSoFar >= args.maxAttempts) {
		return { schedule: false, exhausted: true, reason: `fixer attempts exhausted (${args.maxAttempts}); requires human attention`, links }
	}
	return { schedule: true, attempt: args.attemptsSoFar + 1, links }
}
