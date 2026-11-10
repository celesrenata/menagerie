import type { SpecRevision } from "@roo-code/types"

import { canonicalJson } from "../../services/analysis/analysisDigest"

/**
 * Pure requirement -> decision -> task -> acceptance -> check graph operations
 * (MEN-GRANITE-SDD-001 R6.2, R6.3, R8.5). Deterministic: the model may suggest links, but
 * only links that survive this validation exist.
 */

export type SpecIssueCode =
	| "duplicate-id"
	| "missing-reference"
	| "check-kind-mismatch"
	| "check-missing-command"
	| "acceptance-outside-task-requirements"
	| "uncovered-required-acceptance"
	| "requirement-without-acceptance"
	| "orphan-acceptance"

export interface SpecIssue {
	code: SpecIssueCode
	message: string
	ids: string[]
}

type Kind = "requirement" | "decision" | "task" | "acceptance" | "check"

export function validateSpecGraph(rev: SpecRevision): SpecIssue[] {
	const issues: SpecIssue[] = []
	const add = (code: SpecIssueCode, message: string, ...ids: string[]) => issues.push({ code, message, ids })

	const tables: Array<[Kind, string[]]> = [
		["requirement", rev.requirements.map((r) => r.id)],
		["decision", rev.decisions.map((d) => d.id)],
		["task", rev.tasks.map((t) => t.id)],
		["acceptance", rev.acceptance.map((a) => a.id)],
		["check", rev.checks.map((c) => c.id)],
	]
	const sets = new Map<Kind, Set<string>>()
	for (const [kind, ids] of tables) {
		const seen = new Set<string>()
		for (const id of ids) {
			if (seen.has(id)) add("duplicate-id", `duplicate ${kind} id ${id}`, id)
			seen.add(id)
		}
		sets.set(kind, seen)
	}
	const has = (kind: Kind, id: string) => sets.get(kind)!.has(id)
	const ref = (from: string, kind: Kind, id: string) => {
		if (!has(kind, id)) add("missing-reference", `${from} references unknown ${kind} ${id}`, from, id)
	}

	for (const r of rev.requirements) r.acceptanceIds.forEach((id) => ref(`requirement ${r.id}`, "acceptance", id))
	for (const d of rev.decisions) d.requirementIds.forEach((id) => ref(`decision ${d.id}`, "requirement", id))
	for (const t of rev.tasks) {
		t.dependsOn.forEach((id) => ref(`task ${t.id}`, "task", id))
		t.requirementIds.forEach((id) => ref(`task ${t.id}`, "requirement", id))
		t.decisionIds.forEach((id) => ref(`task ${t.id}`, "decision", id))
		t.acceptanceIds.forEach((id) => ref(`task ${t.id}`, "acceptance", id))
	}
	for (const a of rev.acceptance) ref(`acceptance ${a.id}`, "check", a.checkRef)

	// Acceptance <-> check consistency.
	const checkById = new Map(rev.checks.map((c) => [c.id, c]))
	for (const a of rev.acceptance) {
		const check = checkById.get(a.checkRef)
		if (check && check.kind !== a.evidenceKind) {
			add("check-kind-mismatch", `acceptance ${a.id} expects ${a.evidenceKind} but check ${check.id} is ${check.kind}`, a.id, check.id)
		}
	}
	for (const c of rev.checks) {
		if (c.kind !== "inspection" && (!c.command || c.command.length === 0)) {
			add("check-missing-command", `check ${c.id} (${c.kind}) has no command to run`, c.id)
		}
	}

	// Tasks may only claim acceptance criteria belonging to requirements they serve.
	const acceptanceOfRequirement = new Map(rev.requirements.map((r) => [r.id, new Set(r.acceptanceIds)]))
	for (const t of rev.tasks) {
		const allowed = new Set<string>()
		for (const rid of t.requirementIds) acceptanceOfRequirement.get(rid)?.forEach((id) => allowed.add(id))
		for (const aid of t.acceptanceIds) {
			if (has("acceptance", aid) && !allowed.has(aid)) {
				add("acceptance-outside-task-requirements", `task ${t.id} claims ${aid}, which none of its requirements own`, t.id, aid)
			}
		}
	}

	// Coverage.
	const claimed = new Set(rev.tasks.flatMap((t) => t.acceptanceIds))
	for (const a of rev.acceptance) {
		if (a.required && !claimed.has(a.id)) add("uncovered-required-acceptance", `required acceptance ${a.id} is claimed by no task`, a.id)
	}
	const owned = new Set(rev.requirements.flatMap((r) => r.acceptanceIds))
	for (const a of rev.acceptance) {
		if (!owned.has(a.id)) add("orphan-acceptance", `acceptance ${a.id} belongs to no requirement`, a.id)
	}
	if (rev.policy === "strict") {
		for (const r of rev.requirements) {
			if (r.acceptanceIds.length === 0) add("requirement-without-acceptance", `requirement ${r.id} has no acceptance criterion`, r.id)
		}
	}
	return issues
}

export interface RequirementCoverage {
	total: number
	/** Requirements whose every required acceptance criterion is in `passingAcceptanceIds`. */
	covered: number
	uncoveredIds: string[]
}

/** `requirements covered / total`, computed from passing acceptance ids. Never from model claims. */
export function requirementCoverage(rev: SpecRevision, passingAcceptanceIds: ReadonlySet<string>): RequirementCoverage {
	const required = new Map(rev.acceptance.map((a) => [a.id, a.required]))
	const uncoveredIds: string[] = []
	for (const r of rev.requirements) {
		const mustPass = r.acceptanceIds.filter((id) => required.get(id) === true)
		const ok = mustPass.length > 0 ? mustPass.every((id) => passingAcceptanceIds.has(id)) : r.acceptanceIds.length > 0 && r.acceptanceIds.every((id) => passingAcceptanceIds.has(id))
		if (!ok) uncoveredIds.push(r.id)
	}
	return { total: rev.requirements.length, covered: rev.requirements.length - uncoveredIds.length, uncoveredIds }
}

export interface SpecImpact {
	requirementIds: string[]
	taskIds: string[]
	acceptanceIds: string[]
	checkIds: string[]
}

/**
 * Transitive impact of changing requirements and/or workspace paths: the affected tasks,
 * acceptance criteria and checks. Unrelated branches are untouched, so only dependent evidence
 * is invalidated (R6.5, not a full-project reset).
 */
export function impactOf(
	rev: SpecRevision,
	changed: { requirementIds?: string[]; taskIds?: string[]; acceptanceIds?: string[]; checkIds?: string[]; paths?: string[] },
): SpecImpact {
	const reqs = new Set(changed.requirementIds ?? [])
	const acc = new Set(changed.acceptanceIds ?? [])
	const checks = new Set(changed.checkIds ?? [])
	const paths = new Set(changed.paths ?? [])

	for (const c of rev.checks) if ((c.inputs ?? []).some((p) => paths.has(p))) checks.add(c.id)
	for (const a of rev.acceptance) if (checks.has(a.checkRef)) acc.add(a.id)
	for (const r of rev.requirements) if (reqs.has(r.id)) r.acceptanceIds.forEach((id) => acc.add(id))

	const tasks = new Set<string>(changed.taskIds ?? [])
	for (const t of rev.tasks) {
		const touchesPath = [...(t.filesWrite ?? []), ...(t.filesRead ?? [])].some((p) => paths.has(p))
		if (t.requirementIds.some((id) => reqs.has(id)) || t.acceptanceIds.some((id) => acc.has(id)) || touchesPath) tasks.add(t.id)
	}
	// Dependents of an affected task are affected.
	let grew = true
	while (grew) {
		grew = false
		for (const t of rev.tasks) {
			if (!tasks.has(t.id) && t.dependsOn.some((d) => tasks.has(d))) {
				tasks.add(t.id)
				grew = true
			}
		}
	}
	for (const t of rev.tasks) if (tasks.has(t.id)) t.acceptanceIds.forEach((id) => acc.add(id))
	for (const a of rev.acceptance) if (acc.has(a.id)) checks.add(a.checkRef)
	for (const r of rev.requirements) if (r.acceptanceIds.some((id) => acc.has(id))) reqs.add(r.id)

	return { requirementIds: [...reqs].sort(), taskIds: [...tasks].sort(), acceptanceIds: [...acc].sort(), checkIds: [...checks].sort() }
}

function changedIds<T extends { id: string }>(prev: T[], next: T[]): string[] {
	const before = new Map(prev.map((x) => [x.id, canonicalJson(x)]))
	const out: string[] = []
	for (const x of next) if (before.get(x.id) !== canonicalJson(x)) out.push(x.id)
	return out
}

/**
 * Acceptance criteria whose existing evidence is NOT valid for `next`: anything added or edited
 * in a requirement, acceptance, check or task, plus transitive dependents. Evidence for the
 * rest carries over from `prev`.
 */
export function invalidatedByRevision(prev: SpecRevision, next: SpecRevision): SpecImpact {
	const requirementIds = changedIds(prev.requirements, next.requirements)
	const acceptanceIds = changedIds(prev.acceptance, next.acceptance)
	const checkIds = changedIds(prev.checks, next.checks)
	const taskIds = changedIds(prev.tasks, next.tasks)
	return impactOf(next, { requirementIds, taskIds, acceptanceIds, checkIds })
}
