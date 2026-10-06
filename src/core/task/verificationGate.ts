import type { EvidenceReference, VerificationPolicy, WorkerResult } from "@roo-code/types"

/**
 * Verifier scheduling and the required-verification gate (FEAT-008).
 *
 * This module expresses verification as **orchestration sequencing** layered over the
 * existing worker-terminal states (`completed` / `failed` / `cancelled`), NOT as a new
 * lifecycle status. For a task with required verification, the batch plan schedules an
 * independent verifier worker role (a distinct runtime from the implementer) and gates
 * the parent-visible PASS on the verifier's criteria passing; otherwise the task is
 * reported as not-successfully-verified. The implementer is never the sole source
 * asserting the correctness of its own work (Requirements 11.1, 11.3, 12.2, 12.3).
 *
 * Pure/testable by construction: the exported functions take a {@link VerificationPolicy}
 * and a terminal state (or a verifier {@link WorkerResult}) and return decisions without
 * touching the scheduler, filesystem, or task runtime. The caller (runParallelTasks /
 * ParallelTasksTool wiring) turns a {@link VerifierSchedulingDecision} into an actual
 * worker spec and feeds the verifier's completion back through {@link gateParentOutcome}.
 *
 * Criteria evaluation detail (task 8.2) and the fixer loop (task 8.3) are follow-on tasks
 * in this same file; the roles and seams they build on are defined here.
 *
 * _Requirements: 9.3, 11.1, 11.3, 11.4, 12.2, 12.3_
 */

/**
 * The cognition roles sequenced by the gate. Each role maps to an ordinary parallel-task
 * worker (a distinct runtime), so result ownership, persistence, and the bounded-parent
 * path are unchanged. Verifier/fixer scheduling is a cognition concern within the batch,
 * never a GPU/placement concern (Requirement 11.4).
 */
export type WorkerRole = "implementer" | "verifier" | "fixer"

/**
 * The terminal state of a worker run, mirroring the `state` field of `ParallelTaskResult`
 * in {@link ./runParallelTasks}. The gate reasons over these existing terminal states
 * rather than introducing a new lifecycle status.
 */
export type WorkerTerminalState = "completed" | "failed" | "cancelled"

/**
 * The parent-visible outcome of a (possibly verified) task.
 *
 * - `pass`: the work is reported PASS to the parent. For a required-verification task this
 *   is reached ONLY after the verifier's criteria pass.
 * - `not-successfully-verified`: required verification was requested but the verifier did
 *   not pass (verifier FAIL, verifier did not run to completion, or no verifier result yet).
 * - `failed`: the implementer itself did not reach a `completed` terminal state, so there is
 *   nothing to verify.
 */
export type ParentOutcomeKind = "pass" | "not-successfully-verified" | "failed"

/**
 * A parent-visible outcome plus a short human-readable reason the orchestrator can surface.
 */
export interface ParentOutcome {
	kind: ParentOutcomeKind
	/** Short, parent-facing explanation of why this outcome was reached. */
	reason: string
}

/**
 * Whether a verifier should be scheduled, and (when it should) the role metadata the caller
 * needs to construct an independent verifier worker spec distinct from the implementer.
 */
export type VerifierSchedulingDecision =
	| {
			schedule: false
			/** Why no verifier is scheduled (verification not required, or implementer did not complete). */
			reason: string
	  }
	| {
			schedule: true
			role: "verifier"
			/** Criteria the verifier must evaluate, in order (task 8.2 produces one evidence entry each). */
			criteria: string[]
			/** Optional verification mode carried from the policy (opaque to this module). */
			mode?: string
	  }

/**
 * Returns whether a given {@link VerificationPolicy} requires an independent verifier.
 *
 * A task omitting the `verification` field (policy `undefined`) is treated as not requiring
 * verification (Requirement 9.2); a policy with `required: true` requires it (Requirement 9.3).
 */
export function verificationIsRequired(policy: VerificationPolicy | undefined): boolean {
	return policy?.required === true
}

/**
 * Decides whether to schedule an independent verifier after the implementer terminates.
 *
 * Expresses the gate as sequencing over existing worker-terminal states: a verifier is
 * scheduled only when verification is required AND the implementer reached the `completed`
 * terminal state. An implementer that `failed` or was `cancelled` has nothing to verify, so
 * no verifier is scheduled and the gate reports failure through {@link gateParentOutcome}.
 *
 * The returned decision carries the role as `"verifier"` so the caller builds a worker whose
 * role is distinct from the `"implementer"` — the implementer is never the sole source
 * asserting its own correctness (Requirements 11.1, 11.3, 11.4).
 *
 * _Requirements: 9.3, 11.1, 11.3, 11.4_
 */
export function decideVerifierScheduling(
	policy: VerificationPolicy | undefined,
	implementerState: WorkerTerminalState,
): VerifierSchedulingDecision {
	if (!verificationIsRequired(policy)) {
		return { schedule: false, reason: "Verification is not required for this task." }
	}

	if (implementerState !== "completed") {
		return {
			schedule: false,
			reason: `Implementer did not complete (state: ${implementerState}); nothing to verify.`,
		}
	}

	// `policy` is defined here because verificationIsRequired returned true.
	return {
		schedule: true,
		role: "verifier",
		criteria: policy!.criteria ?? [],
		...(policy!.mode !== undefined ? { mode: policy!.mode } : {}),
	}
}

/**
 * Confirms the verifier role is distinct from the implementer role, so the gate never lets
 * the implementer verify its own work (Requirement 11.3). Used by the caller when assembling
 * the batch to assert the two roles are not collapsed onto one runtime.
 */
export function verifierIsDistinctFromImplementer(implementerRole: WorkerRole, verifierRole: WorkerRole): boolean {
	return implementerRole === "implementer" && verifierRole === "verifier"
}

/**
 * Determines whether a verifier's result passed.
 *
 * A verifier passes only when it reached the `completed` terminal state and its
 * {@link WorkerResult} status is `"completed"`. Any other verifier outcome (`failed`,
 * `blocked`, or a non-completed terminal state) is a FAIL that must gate parent success.
 *
 * Detailed per-criterion pass/fail evaluation is task 8.2; this function answers the overall
 * PASS/FAIL question the gate needs, derived from the verifier's reported status.
 *
 * _Requirements: 12.2, 12.3_
 */
export function verifierPassed(verifierState: WorkerTerminalState, verifierResult: WorkerResult | undefined): boolean {
	return verifierState === "completed" && verifierResult?.status === "completed"
}

/**
 * The required-verification gate: computes the parent-visible outcome for a task.
 *
 * - When verification is not required, the parent outcome tracks the implementer's terminal
 *   state directly: `completed` → PASS, otherwise `failed`.
 * - When verification is required, the task is reported PASS to the parent ONLY after the
 *   verifier passed (Requirements 11.1, 12.2). If the implementer did not complete, there is
 *   nothing to verify (`failed`). If the implementer completed but the verifier did not pass
 *   — including when no verifier result is available yet — the task is reported as
 *   `not-successfully-verified` (Requirement 12.3).
 *
 * The fixer loop (task 8.3) reacts to a `not-successfully-verified` outcome whose cause is a
 * verifier FAIL by scheduling a fixer followed by a verifier re-run; this function supplies
 * the gate decision that loop keys off.
 *
 * _Requirements: 11.1, 12.2, 12.3_
 */
export function gateParentOutcome(args: {
	policy: VerificationPolicy | undefined
	implementerState: WorkerTerminalState
	verifierState?: WorkerTerminalState
	verifierResult?: WorkerResult
}): ParentOutcome {
	const { policy, implementerState, verifierState, verifierResult } = args

	if (!verificationIsRequired(policy)) {
		return implementerState === "completed"
			? { kind: "pass", reason: "Implementer completed; verification not required." }
			: { kind: "failed", reason: `Implementer did not complete (state: ${implementerState}).` }
	}

	if (implementerState !== "completed") {
		return { kind: "failed", reason: `Implementer did not complete (state: ${implementerState}); nothing to verify.` }
	}

	if (verifierState === undefined) {
		return {
			kind: "not-successfully-verified",
			reason: "Required verification has not run yet; a verifier must pass before reporting PASS.",
		}
	}

	if (verifierPassed(verifierState, verifierResult)) {
		return { kind: "pass", reason: "Verifier criteria passed." }
	}

	return {
		kind: "not-successfully-verified",
		reason:
			verifierState === "completed"
				? "Verifier ran but its criteria did not pass."
				: `Verifier did not complete (state: ${verifierState}).`,
	}
}

/**
 * The pass/fail outcome of a single verification criterion.
 *
 * `criterion` is the exact criterion string supplied by the policy (so the evidence entry is
 * self-describing), and `passed` is the verifier's binary assessment of that one criterion.
 */
export interface CriterionOutcome {
	criterion: string
	passed: boolean
}

/**
 * Builds the compact per-criterion evidence list the verifier reports.
 *
 * Produces exactly one {@link EvidenceReference} entry per supplied criterion, in the same
 * order as `criteria`, so the result is a compact pass/fail roll-up and NOT a transcript
 * (Requirement 12.4). Each entry is typed `"test"` (a criterion check is an assertion-style
 * verification), references the criterion text, and records `"pass"` or `"fail"` in the
 * EvidenceReference `result` field (Requirement 12.1).
 *
 * `outcomes` supplies the per-criterion pass/fail derived from the verifier's assessment. A
 * criterion with no matching outcome is treated as a FAIL (the verifier did not establish that
 * it passed), keeping the evidence list total over the supplied criteria. Extra outcomes that
 * do not correspond to a supplied criterion are ignored, so the evidence array length always
 * equals `criteria.length` in criterion order.
 *
 * Pure/testable: no scheduler, filesystem, or runtime access.
 *
 * _Requirements: 12.1, 12.4_
 */
export function buildCriteriaEvidence(criteria: string[], outcomes: CriterionOutcome[]): EvidenceReference[] {
	const passedByCriterion = new Map<string, boolean>()
	for (const outcome of outcomes) {
		// First outcome for a criterion wins; later duplicates do not override it.
		if (!passedByCriterion.has(outcome.criterion)) {
			passedByCriterion.set(outcome.criterion, outcome.passed)
		}
	}

	return criteria.map((criterion) => ({
		type: "test" as const,
		reference: criterion,
		result: passedByCriterion.get(criterion) === true ? "pass" : "fail",
	}))
}

/**
 * Assembles the verifier's {@link WorkerResult} from its per-criterion assessment.
 *
 * The `evidence` array carries exactly one pass/fail entry per supplied criterion, in criterion
 * order (see {@link buildCriteriaEvidence}) — a compact roll-up, never a transcript. The overall
 * `status` is `"completed"` only when every supplied criterion passed; any failing (or missing)
 * criterion yields `"failed"`, which {@link verifierPassed} and {@link gateParentOutcome} treat
 * as a verifier FAIL that gates parent PASS. The `summary` reports the pass count against the
 * total so the parent-facing roll-up is self-describing.
 *
 * All other `WorkerResult` array fields are present and empty: a verifier reports criteria
 * evidence, not implementer-style changes/tests/artifacts.
 *
 * Pure/testable: deterministic function of `criteria` and `outcomes`.
 *
 * _Requirements: 12.1, 12.4_
 */
export function buildVerifierResult(criteria: string[], outcomes: CriterionOutcome[]): WorkerResult {
	const evidence = buildCriteriaEvidence(criteria, outcomes)
	const passedCount = evidence.filter((entry) => entry.result === "pass").length
	const allPassed = passedCount === evidence.length

	return {
		status: allPassed ? "completed" : "failed",
		summary: `Verifier evaluated ${evidence.length} criteria: ${passedCount} passed, ${evidence.length - passedCount} failed.`,
		findings: [],
		evidence,
		changes: [],
		tests: [],
		blockers: [],
		artifacts: [],
	}
}

/**
 * The next orchestration step after a required-verification gate decision.
 *
 * - `done`: no further workers are sequenced. The gate reached a terminal parent outcome
 *   (PASS, a non-verifier failure with nothing to verify, or verification was not required),
 *   so the loop stops.
 * - `schedule`: the fixer loop reacts to a verifier FAIL. The orchestrator schedules the
 *   `roles` in order — a `"fixer"` worker to address the failed criteria, then a `"verifier"`
 *   worker to re-run verification — before re-applying {@link gateParentOutcome} to the
 *   re-run's result. The roles are cognition roles sequenced within the batch and carry no
 *   GPU/placement information (Requirement 11.4).
 */
export type FixerLoopDecision =
	| {
			schedule: false
			/** Why the loop stops (terminal gate outcome; nothing to fix or re-verify). */
			reason: string
	  }
	| {
			schedule: true
			/**
			 * The cognition roles to schedule, in sequence: a fixer followed by a verifier re-run.
			 * Each maps to an ordinary parallel-task worker (a distinct runtime); the array order is
			 * the scheduling order (Requirement 11.2).
			 */
			roles: ["fixer", "verifier"]
			/** Short, orchestrator-facing explanation of why the fixer loop was triggered. */
			reason: string
	  }

/**
 * Decides the next step of the fixer loop from a gate {@link ParentOutcome}.
 *
 * The loop fires on exactly one condition: a `not-successfully-verified` outcome caused by a
 * verifier FAIL (the implementer completed and a verifier ran but its criteria did not pass).
 * In that case it sequences a `"fixer"` worker followed by a `"verifier"` re-run (Requirement
 * 11.2); the caller schedules those roles in order and feeds the re-run's result back through
 * {@link gateParentOutcome}, so the loop can repeat until the verifier passes or the caller's
 * own bound stops it.
 *
 * Every other outcome stops the loop: a `pass` has nothing to fix; a `failed` outcome had no
 * completed implementer to fix; and a `not-successfully-verified` outcome where the verifier
 * has not run yet is a pending verification, not a FAIL, so a fixer is premature (a verifier
 * must run first). To distinguish those `not-successfully-verified` sub-cases without parsing
 * the human-readable `reason`, this function takes the gate inputs and recomputes the verifier
 * FAIL condition structurally.
 *
 * The decision names only cognition roles and carries no GPU/placement detail: verifier/fixer
 * scheduling is a cognition concern within the batch, never a silicon-placement one
 * (Requirement 11.4).
 *
 * Pure/testable: a deterministic function of the gate outcome and its inputs; no scheduler,
 * filesystem, or runtime access.
 *
 * _Requirements: 11.2, 11.4_
 */
export function decideFixerLoop(args: {
	outcome: ParentOutcome
	implementerState: WorkerTerminalState
	verifierState?: WorkerTerminalState
	verifierResult?: WorkerResult
}): FixerLoopDecision {
	const { outcome, implementerState, verifierState, verifierResult } = args

	if (outcome.kind !== "not-successfully-verified") {
		return {
			schedule: false,
			reason:
				outcome.kind === "pass"
					? "Verifier passed; no fix needed."
					: "Implementer did not complete; nothing to fix or verify.",
		}
	}

	// A `not-successfully-verified` outcome with no verifier run yet is a pending verification,
	// not a FAIL: the verifier must run before a fixer is scheduled.
	if (verifierState === undefined) {
		return {
			schedule: false,
			reason: "Verification has not run yet; schedule the verifier before any fixer.",
		}
	}

	// Defensive: a passing verifier should have yielded a `pass` outcome above. If it somehow
	// passed, there is nothing to fix.
	if (verifierPassed(verifierState, verifierResult)) {
		return { schedule: false, reason: "Verifier passed; no fix needed." }
	}

	return {
		schedule: true,
		roles: ["fixer", "verifier"],
		reason:
			verifierState === "completed"
				? "Verifier FAIL: scheduling a fixer followed by a verifier re-run."
				: `Verifier did not complete (state: ${verifierState}): scheduling a fixer followed by a verifier re-run.`,
	}
}
