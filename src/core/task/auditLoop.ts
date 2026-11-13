import {
	DEFAULT_WORKER_AUDIT_MODE,
	type VerificationPolicy,
	type WorkerAuditMode,
	type WorkerResult,
} from "@roo-code/types"
import {
	decideFixerLoop,
	decideVerifierScheduling,
	gateParentOutcome,
	type ParentOutcome,
	type WorkerTerminalState,
} from "./verificationGate"

/**
 * Audit-and-send-back loop for a single parallel worker.
 *
 * Sequencing only: it composes the existing pure gate functions
 * (`decideVerifierScheduling`, `gateParentOutcome`, `decideFixerLoop`) and delegates every
 * actual run (verifier, rework, deeper-lane follow-up) to injected callbacks, so it is unit
 * testable without a scheduler, filesystem, or model.
 *
 * Evidence rule (Granite ADR): this module takes NO analysis/Granite output. A PASS is only
 * ever produced by `gateParentOutcome` from a completed implementer plus a completed verifier
 * `WorkerResult`. Analysis summaries are advisory and have no input path here.
 */

/** Rework rounds allowed before escalating. Matches `MAX_FIXER_ATTEMPTS` in the strict spec run. */
export const MAX_REWORK_ROUNDS = 2

/** The terminal state plus structured result of one worker run (implementer, rework, or verifier). */
export interface AuditAttempt {
	state: WorkerTerminalState
	result?: WorkerResult
	taskId?: string
}

export interface AuditEscalation {
	/** Lane the follow-up ran on, e.g. `reader.deep` or `reasoning.escalation`. */
	lane: string
	/** Advisory text from the follow-up. Never evidence that a check passed. */
	summary?: string
}

/** Compact audit record attached to the worker result. */
export interface AuditRecord {
	rounds: number
	verifierTaskIds: string[]
	outcome: ParentOutcome["kind"]
	reason: string
	escalation?: AuditEscalation
}

export type AuditStep =
	| { action: "verify"; criteria: string[]; mode?: string }
	| { action: "rework"; reason: string }
	| { action: "escalate"; outcome: ParentOutcome }
	| { action: "done"; outcome: ParentOutcome }

export interface AuditState {
	policy: VerificationPolicy | undefined
	implementerState: WorkerTerminalState
	verifierState?: WorkerTerminalState
	verifierResult?: WorkerResult
	/** Rework rounds already spent. */
	reworkRounds: number
	maxRounds?: number
}

/**
 * Pure next-step function. Verify first, then gate; on a verifier FAIL rework while rounds
 * remain, otherwise escalate. Escalation never changes the outcome kind.
 */
export function nextAuditStep(state: AuditState): AuditStep {
	const { policy, implementerState, verifierState, verifierResult, reworkRounds } = state
	const max = state.maxRounds ?? MAX_REWORK_ROUNDS

	if (verifierState === undefined) {
		const decision = decideVerifierScheduling(policy, implementerState)
		if (decision.schedule) {
			return {
				action: "verify",
				criteria: decision.criteria,
				...(decision.mode !== undefined ? { mode: decision.mode } : {}),
			}
		}
		return { action: "done", outcome: gateParentOutcome({ policy, implementerState }) }
	}

	const outcome = gateParentOutcome({ policy, implementerState, verifierState, verifierResult })
	const fixer = decideFixerLoop({ outcome, implementerState, verifierState, verifierResult })
	if (!fixer.schedule) return { action: "done", outcome }
	if (reworkRounds < max) return { action: "rework", reason: fixer.reason }
	return { action: "escalate", outcome }
}

export interface AuditDeps {
	policy: VerificationPolicy
	implementer: AuditAttempt
	/** Run an independent read-only verifier against the worker's current workspace. */
	runVerifier(args: { criteria: string[]; mode?: string; round: number }): Promise<AuditAttempt>
	/** Send the same worker back with the verifier's findings. */
	rework(args: { feedback: string; round: number }): Promise<AuditAttempt>
	/** Run one deeper-lane follow-up after retries are exhausted. Returns undefined when none applies. */
	escalate(args: {
		feedback: string
		rounds: number
		implementer: AuditAttempt
	}): Promise<AuditEscalation | undefined>
	isCancelled?: () => boolean
	maxRounds?: number
}

export const DEFAULT_AUDIT_CRITERIA = [
	"The change fulfils the task as written",
	"The relevant tests or checks pass, or none apply and the code compiles",
]

/**
 * Decide whether a worker is audited. An explicit `verification.required` always wins.
 * Otherwise `"edits"` mode synthesizes a default policy for edit-capable workers only.
 */
export function resolveAuditPolicy(
	spec: { verification?: VerificationPolicy | null },
	mode: WorkerAuditMode | undefined,
	canEdit: boolean,
	verifierAvailable = true,
): VerificationPolicy | undefined {
	// No read-only verifier mode: auditing would fail every worker, so skip (see AUDIT_SKIPPED_WARNING).
	if (!verifierAvailable) return undefined
	if (spec.verification) return spec.verification.required ? spec.verification : undefined
	if ((mode ?? DEFAULT_WORKER_AUDIT_MODE) === "edits" && canEdit) {
		return { required: true, criteria: DEFAULT_AUDIT_CRITERIA }
	}
	return undefined
}

/** Mode the verifier runs in. It is user-configurable, not built in, so it may be missing. */
export const AUDIT_VERIFIER_MODE = "project-reader"

/** Warning attached to a worker whose audit was skipped because the verifier mode is unavailable. */
export const AUDIT_SKIPPED_WARNING = `Audit skipped: no read-only "${AUDIT_VERIFIER_MODE}" mode is available, so this work was NOT independently verified. Add that mode or set workerAuditMode to "off" to silence this.`

/** True when the verifier mode exists and cannot edit (an editing verifier would not be independent). */
export function isVerifierModeUsable(
	mode: { groups?: ReadonlyArray<unknown> } | undefined,
	canEdit: (groups: ReadonlyArray<unknown> | undefined) => boolean,
): boolean {
	return mode !== undefined && !canEdit(mode.groups)
}

/** Instruction for the read-only verifier. It must judge the workspace itself, not the worker's claims. */
export function buildVerifierMessage(taskMessage: string, criteria: string[]): string {
	return [
		"You are an independent verifier. Inspect the files in this workspace and run read-only checks.",
		"Do not modify files. Do not trust the implementer's own claims; check the actual workspace.",
		`Original task:\n${taskMessage}`,
		`Criteria:\n${criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n")}`,
		'Finish with attempt_completion whose result is a JSON WorkerResult. Use status "completed" only if EVERY criterion passes, otherwise "failed". Add one evidence entry per criterion ({"type":"test","reference":<criterion>,"result":"pass"|"fail"}) and put concrete problems in findings.',
	].join("\n\n")
}

/** Build the feedback sent back to the worker from a failed verifier result. */
export function buildReworkFeedback(result: WorkerResult | undefined, state: WorkerTerminalState): string {
	if (!result) return `The verifier did not complete (state: ${state}). Re-check your work against the task.`
	const failed = (result.evidence ?? []).filter((entry) => entry.result === "fail").map((entry) => entry.reference)
	const findings = (result.findings ?? []).map((finding) =>
		typeof finding === "string" ? finding : JSON.stringify(finding),
	)
	return [
		`Independent verification failed: ${result.summary}`,
		failed.length ? `Failed criteria:\n- ${failed.join("\n- ")}` : "",
		findings.length ? `Findings:\n- ${findings.join("\n- ")}` : "",
		"Fix these problems in the existing workspace, then call attempt_completion again.",
	]
		.filter(Boolean)
		.join("\n\n")
}

/** Drive the audit to a terminal outcome. Never reports `pass` without a passing verifier. */
export async function runAuditLoop(
	deps: AuditDeps,
): Promise<{ outcome: ParentOutcome; record: AuditRecord; implementer: AuditAttempt }> {
	let implementer = deps.implementer
	let verifier: AuditAttempt | undefined
	let rounds = 0
	const verifierTaskIds: string[] = []
	let escalation: AuditEscalation | undefined

	const finish = (outcome: ParentOutcome) => ({
		outcome,
		implementer,
		record: {
			rounds,
			verifierTaskIds,
			outcome: outcome.kind,
			reason: outcome.reason,
			...(escalation ? { escalation } : {}),
		} satisfies AuditRecord,
	})

	for (;;) {
		const step = nextAuditStep({
			policy: deps.policy,
			implementerState: implementer.state,
			verifierState: verifier?.state,
			verifierResult: verifier?.result,
			reworkRounds: rounds,
			maxRounds: deps.maxRounds,
		})
		if (step.action === "done") return finish(step.outcome)
		if (deps.isCancelled?.()) {
			return finish({ kind: "not-successfully-verified", reason: "Audit cancelled before completion." })
		}
		if (step.action === "verify") {
			verifier = await deps.runVerifier({ criteria: step.criteria, mode: step.mode, round: rounds })
			if (verifier.taskId) verifierTaskIds.push(verifier.taskId)
			continue
		}
		const feedback = buildReworkFeedback(verifier?.result, verifier?.state ?? "failed")
		if (step.action === "escalate") {
			escalation = await deps.escalate({ feedback, rounds, implementer })
			return finish(step.outcome)
		}
		rounds += 1
		implementer = await deps.rework({ feedback, round: rounds })
		verifier = undefined
	}
}

/**
 * Map a finished audit onto the worker's parent-visible terminal state. Anything but a
 * passing verification (including `not-successfully-verified`) is not reported as completed,
 * so the scheduler does not unlock DAG dependents on unverified work.
 */
export function auditTerminalState(
	outcome: ParentOutcome,
	cancelled: boolean,
): { state: "completed" | "failed" | "cancelled"; error?: string } {
	if (outcome.kind === "pass") return { state: "completed" }
	const label = outcome.kind === "failed" ? "Worker failed" : "Verification not passed"
	return { state: cancelled ? "cancelled" : "failed", error: `${label}: ${outcome.reason}` }
}
