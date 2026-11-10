import type { WorkflowPolicyBehavior } from "./SpecWorkflowPolicy"

/**
 * Dispatch-time check of a task batch against the active workflow policy
 * (MEN-GRANITE-SDD-001 R1.1). Pure and additive: it returns violations for the caller to
 * report recoverably and never changes, reorders or schedules tasks.
 *
 * Disabled (`behavior.active === false`) always yields no violations, so existing flows are
 * untouched. Only `explore` restricts work here: it is evidence-only, so any task that declares
 * write targets or runs in a mode with edit rights is rejected.
 */
export interface GuardedTask {
	name: string
	mode: string
	filesWrite?: readonly string[]
}

/** Whether a mode's tool groups include edit rights (plain `"edit"` or a `["edit", {...}]` entry). */
export function groupsCanEdit(groups: ReadonlyArray<unknown> | undefined): boolean {
	return (groups ?? []).some((g) => g === "edit" || (Array.isArray(g) && g[0] === "edit"))
}

export function findPolicyViolations(
	tasks: readonly GuardedTask[],
	behavior: WorkflowPolicyBehavior,
	modeCanWrite: (modeSlug: string) => boolean,
): string[] {
	if (!behavior.active || behavior.mayWriteCode) return []
	const violations: string[] = []
	for (const t of tasks) {
		if ((t.filesWrite?.length ?? 0) > 0) {
			violations.push(`Task ${t.name} declares filesWrite, which the "${behavior.policy}" workflow policy does not allow`)
		} else if (modeCanWrite(t.mode)) {
			violations.push(`Task ${t.name} uses mode ${t.mode}, which can edit files; the "${behavior.policy}" workflow policy is evidence-only`)
		}
	}
	return violations
}
