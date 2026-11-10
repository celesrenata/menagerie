import { execFile } from "child_process"
import { createHash } from "crypto"
import * as path from "path"

import type { SpecRevision } from "@roo-code/types"

import type { SpecCriterionStatus, SpecFixerAdvice } from "@roo-code/types"

import { buildVerifierResult, decideFixerLoop, gateParentOutcome, type ParentOutcome, type WorkerTerminalState } from "../task/verificationGate"
import type { GateResult } from "./SpecGate"
import { SpecRevisionStore, SpecStoreError } from "./SpecRevisionStore"
import { planSpecFixer } from "./SpecGateJoin"
import { verifySpecRevision } from "./SpecVerifier"

/**
 * `strict` workflow glue (MEN-GRANITE-SDD-001 R1.1, R8.3). Two steps around the existing batch run:
 *  1. before dispatch, every task must trace to a task of a stored, user-approved revision;
 *  2. after the batch, the revision's executable checks run on the host and the deterministic
 *     gate decides. Nothing here schedules work or touches the DAG.
 */
export const SPECS_DIR = path.join(".kiro", "specs")

export interface TracedTask {
	name: string
	specTrace?: { specId: string; revisionId: string; taskId: string }
}

export interface StrictDispatchCheck {
	violations: string[]
	/** Revisions the batch traces to, loaded and integrity-verified. */
	revisions: SpecRevision[]
}

export async function checkStrictDispatch(tasks: readonly TracedTask[], store: SpecRevisionStore): Promise<StrictDispatchCheck> {
	const violations: string[] = []
	const revisions = new Map<string, SpecRevision>()
	for (const t of tasks) {
		const trace = t.specTrace
		if (!trace) {
			violations.push(`Task ${t.name} has no specTrace; the "strict" workflow policy only dispatches tasks compiled from an approved spec revision`)
			continue
		}
		if (trace.taskId !== t.name) {
			violations.push(`Task ${t.name} does not match its specTrace task ${trace.taskId}`)
			continue
		}
		let rev = revisions.get(trace.revisionId)
		if (!rev) {
			try {
				rev = await store.loadRevision(trace.specId, trace.revisionId)
			} catch (error) {
				violations.push(`Task ${t.name}: ${error instanceof SpecStoreError ? error.message : "cannot load spec revision"}`)
				continue
			}
			const approval = await store.findApproval(trace.specId, trace.revisionId)
			if (!approval || approval.approvedBy !== "user") {
				violations.push(`Task ${t.name}: revision ${trace.revisionId.slice(0, 19)} is not user-approved`)
				continue
			}
			revisions.set(trace.revisionId, rev)
		}
		if (!rev.tasks.some((x) => x.id === trace.taskId)) violations.push(`Task ${t.name} is not part of revision ${trace.revisionId.slice(0, 19)}`)
	}
	return { violations, revisions: [...revisions.values()] }
}

/** Git HEAD plus a digest of uncommitted changes, so dirty edits change the source revision. Falls back to "workspace". */
export async function currentSourceRevision(workspaceRoot: string): Promise<string> {
	const git = (args: string[]) =>
		new Promise<string>((resolve) => {
			execFile("git", args, { cwd: workspaceRoot, maxBuffer: 20_000_000 }, (error, stdout) => resolve(error ? "" : stdout))
		})
	const head = (await git(["rev-parse", "HEAD"])).trim()
	if (!head) return "workspace"
	const dirty = await git(["diff", "HEAD"])
	return dirty ? `git:${head}+${createHash("sha256").update(dirty).digest("hex").slice(0, 12)}` : `git:${head}`
}

/** Bound on advised fixer rounds per revision. Nothing is scheduled here; the planner decides. */
export const MAX_FIXER_ATTEMPTS = 2
// Failed gate runs per revision in this process; display/advice only, evidence in the store is the record.
const failedRuns = new Map<string, number>()

export function resetFixerAttemptsForTests(): void {
	failedRuns.clear()
}

export interface StrictGateSummary {
	specId: string
	revisionId: string
	verdict: GateResult["verdict"]
	reasons: string[]
	requirementsCovered: string
	criteria: SpecCriterionStatus[]
	fixer?: SpecFixerAdvice
}

export async function runStrictGate(args: {
	revisions: readonly SpecRevision[]
	store: SpecRevisionStore
	workspaceRoot: string
	tasks: ReadonlyArray<{ name: string; state: string }>
}): Promise<StrictGateSummary[]> {
	const sourceRevision = await currentSourceRevision(args.workspaceRoot)
	const out: StrictGateSummary[] = []
	for (const revision of args.revisions) {
		// The implementer's own terminal state is the only worker-side input; verification is the host-run checks.
		const outcomes: ParentOutcome[] = revision.tasks.map((t) => {
			const run = args.tasks.find((x) => x.name === t.id)
			return gateParentOutcome({ policy: undefined, implementerState: (run?.state ?? "failed") as WorkerTerminalState })
		})
		try {
			const gate = await verifySpecRevision({ store: args.store, revision, workspaceRoot: args.workspaceRoot, sourceRevision, verifierOutcomes: outcomes })
			let fixer: SpecFixerAdvice | undefined
			if (gate.verdict === "pass") {
				failedRuns.delete(revision.revisionId)
			} else if (gate.verdict === "failed") {
				const attemptsSoFar = failedRuns.get(revision.revisionId) ?? 0
				failedRuns.set(revision.revisionId, attemptsSoFar + 1)
				// The host-run checks play the verifier role here: they ran and did not pass.
				const failedVerifier = buildVerifierResult(["executable checks"], [{ criterion: "executable checks", passed: false }])
				const loop = decideFixerLoop({
					outcome: { kind: "not-successfully-verified", reason: "executable check failed" },
					implementerState: "completed",
					verifierState: "completed",
					verifierResult: failedVerifier,
				})
				const { records } = await args.store.readEvidence(revision.specId)
				const plan = planSpecFixer({ rev: revision, gate, evidence: records, loop, attemptsSoFar, maxAttempts: MAX_FIXER_ATTEMPTS })
				if (plan.schedule) fixer = { attempt: plan.attempt, maxAttempts: MAX_FIXER_ATTEMPTS, exhausted: false, links: plan.links }
				else if ("exhausted" in plan) fixer = { attempt: attemptsSoFar, maxAttempts: MAX_FIXER_ATTEMPTS, exhausted: true, links: plan.links }
			}
			out.push({
				specId: revision.specId,
				revisionId: revision.revisionId,
				verdict: gate.verdict,
				reasons: gate.reasons.slice(0, 10),
				requirementsCovered: `${gate.coverage.covered}/${gate.coverage.total}`,
				criteria: gate.acceptance.slice(0, 50).map((a) => ({ acceptanceId: a.acceptanceId, required: a.required, state: a.state, reason: a.reason.slice(0, 200) })),
				...(fixer ? { fixer } : {}),
			})
		} catch (error) {
			// A runner refusal or store failure is never a pass.
			out.push({ specId: revision.specId, revisionId: revision.revisionId, verdict: "blocked", reasons: [error instanceof Error ? error.message.slice(0, 200) : "gate error"], requirementsCovered: "0/" + revision.requirements.length, criteria: [] })
		}
	}
	return out
}
