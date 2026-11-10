import type { SpecPolicy } from "@roo-code/types"

/**
 * What each workflow policy permits (MEN-GRANITE-SDD-001 R1). Pure lookup: it neither starts
 * work nor schedules anything, so the existing DAG/scheduler stay the only execution path.
 *
 * `enabled === false` returns the inert legacy behaviour: no policy applies and callers must
 * not alter any existing flow.
 */
export interface WorkflowPolicyBehavior {
	/** False means the feature is off and existing behaviour is untouched. */
	active: boolean
	policy?: SpecPolicy
	/** `explore` is evidence-only and may not write code. */
	mayWriteCode: boolean
	/** A complete versioned requirements/design/tasks spec must exist before dispatch. */
	requiresFrozenSpec: boolean
	/** A user approval of the exact revision is needed before dispatch. */
	requiresApproval: boolean
	/** Acceptance gates are enforced; missing evidence means blocked/not-verified. */
	gateEnforced: boolean
	/** Trivial changes may run on one worker; workers are never spawned just to fill capacity. */
	allowSingleWorker: boolean
	/** Required analysis that cannot run must escalate or block, never be skipped. */
	requiredAnalysisFailsClosed: boolean
}

const INERT: WorkflowPolicyBehavior = {
	active: false,
	mayWriteCode: true,
	requiresFrozenSpec: false,
	requiresApproval: false,
	gateEnforced: false,
	allowSingleWorker: true,
	requiredAnalysisFailsClosed: false,
}

export function resolveWorkflowPolicy(input: { enabled: boolean; policy?: SpecPolicy }): WorkflowPolicyBehavior {
	if (!input.enabled || input.policy === undefined) return INERT
	switch (input.policy) {
		case "explore":
			return { ...INERT, active: true, policy: "explore", mayWriteCode: false, allowSingleWorker: true }
		case "build":
			return { ...INERT, active: true, policy: "build", allowSingleWorker: true }
		case "strict":
			return {
				active: true,
				policy: "strict",
				mayWriteCode: true,
				requiresFrozenSpec: true,
				requiresApproval: true,
				gateEnforced: true,
				allowSingleWorker: true,
				requiredAnalysisFailsClosed: true,
			}
	}
}
