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
import { createVerificationSandbox, dependencyOrder, type SandboxFactory } from "./strictSandbox"

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
			violations.push(`Task ${t.name} has no specTrace; the "strict" workflow policy only dispatches tasks compiled from an approved spec revision. Use the "tasks" array in .kiro/specs/<specId>/dispatch.json (written when the user approves a revision) unchanged`)
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
	/** The parent task's working directory (inside the git repository). */
	workspaceRoot: string
	/** Batch manifest from `runParallelTasks`; names the snapshot the workers started from. */
	manifestPath: string | undefined
	tasks: ReadonlyArray<{ name: string; state: string; patch?: string }>
	/** Test seam; defaults to a real git worktree sandbox. */
	sandbox?: SandboxFactory
}): Promise<StrictGateSummary[]> {
	const out: StrictGateSummary[] = []
	for (const revision of args.revisions) {
		const base = { specId: revision.specId, revisionId: revision.revisionId }
		const covered = (n: number) => `${n}/${revision.requirements.length}`

		// Workers must have finished before there is anything to verify.
		const runs = revision.tasks.map((t) => ({ spec: t, run: args.tasks.find((x) => x.name === t.id) }))
		const unfinished = runs.filter((r) => r.run?.state !== "completed")
		if (unfinished.length > 0) {
			const reasons = unfinished.map((r) => `task ${r.spec.id} ${r.run ? `ended ${r.run.state}` : "did not run"}`).slice(0, 10)
			out.push({ ...base, verdict: "failed", reasons, requirementsCovered: covered(0), criteria: [] })
			continue
		}

		// The workers' changes live only in their exported patches, so verify a sandbox that has them applied.
		const order = dependencyOrder(revision.tasks)
		const box = await (args.sandbox ?? createVerificationSandbox)({
			repoCwd: args.workspaceRoot,
			manifestPath: args.manifestPath,
			patches: order.map((id) => ({ taskId: id, patchPath: args.tasks.find((x) => x.name === id)?.patch })),
		})
		if (!box.ok) {
			out.push({ ...base, verdict: "blocked", reasons: [box.reason], requirementsCovered: covered(0), criteria: [] })
			continue
		}
		try {
			// Every task completed, so the implementer-side gate passes; the host-run checks are the independent verification.
			const outcomes: ParentOutcome[] = runs.map((r) => gateParentOutcome({ policy: undefined, implementerState: r.run!.state as WorkerTerminalState }))
			const gate = await verifySpecRevision({ store: args.store, revision, workspaceRoot: box.dir, sourceRevision: box.sourceRevision, verifierOutcomes: outcomes })
			let fixer: SpecFixerAdvice | undefined
			if (gate.verdict === "failed") {
				const { records } = await args.store.readEvidence(revision.specId)
				// Attempts so far come from the persisted evidence (survives a restart): the most failed runs any
				// failing criterion has accumulated on this revision, not counting the run that just happened.
				const failing = gate.acceptance.filter((a) => a.required && a.state === "failed").map((a) => a.acceptanceId)
				const failedRuns = Math.max(0, ...failing.map((id) => records.filter((r) => r.revisionId === revision.revisionId && r.acceptanceId === id && r.status === "fail").length))
				const attemptsSoFar = Math.max(0, failedRuns - 1)
				// The host-run checks play the verifier role here: they ran and did not pass.
				const failedVerifier = buildVerifierResult(["executable checks"], [{ criterion: "executable checks", passed: false }])
				const loop = decideFixerLoop({
					outcome: { kind: "not-successfully-verified", reason: "executable check failed" },
					implementerState: "completed",
					verifierState: "completed",
					verifierResult: failedVerifier,
				})
				const plan = planSpecFixer({ rev: revision, gate, evidence: records, loop, attemptsSoFar, maxAttempts: MAX_FIXER_ATTEMPTS })
				if (plan.schedule) fixer = { attempt: plan.attempt, maxAttempts: MAX_FIXER_ATTEMPTS, exhausted: false, links: plan.links }
				else if ("exhausted" in plan) fixer = { attempt: attemptsSoFar, maxAttempts: MAX_FIXER_ATTEMPTS, exhausted: true, links: plan.links }
			}
			out.push({
				...base,
				verdict: gate.verdict,
				reasons: gate.reasons.slice(0, 10),
				requirementsCovered: `${gate.coverage.covered}/${gate.coverage.total}`,
				criteria: gate.acceptance.slice(0, 50).map((a) => ({ acceptanceId: a.acceptanceId, required: a.required, state: a.state, reason: a.reason.slice(0, 200) })),
				...(fixer ? { fixer } : {}),
			})
		} catch (error) {
			// A runner refusal or store failure is never a pass.
			out.push({ ...base, verdict: "blocked", reasons: [error instanceof Error ? error.message.slice(0, 200) : "gate error"], requirementsCovered: covered(0), criteria: [] })
		} finally {
			await box.cleanup()
		}
	}
	return out
}
