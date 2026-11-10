import type { SpecApproval, SpecRevision } from "@roo-code/types"

import { TaskDag } from "../task/TaskDag"
import type { ExecutionPlan } from "../task/elasticTypes"
import { ParallelTasksArgumentError } from "../tools/parallelTasksErrors"
import { buildExecutionPlan, parallelTaskSpecSchema, type ParallelTaskSpec } from "../tools/ParallelTasksTool"
import { verifyRevisionId } from "./specRevision"
import { validateSpecGraph, type SpecIssue } from "./SpecTraceability"

/**
 * Deterministic spec -> existing `ExecutionPlan` compiler (MEN-GRANITE-SDD-001 R6.3, R6.4).
 *
 * Pure and independent of inference. It does NOT schedule, track state or create a second DAG:
 * it validates the contract, then emits the same `ParallelTaskSpec[]` / `ExecutionPlan` the
 * existing `TaskDag` + `BoundedElasticScheduler` already consume.
 */

export type CompileIssueCode =
	| SpecIssue["code"]
	| "revision-id-mismatch"
	| "policy-explore-has-no-tasks"
	| "unapproved-revision"
	| "dependency-cycle"
	| "write-collision"
	| "unsafe-path"
	| "invalid-task-spec"

export interface CompileIssue {
	code: CompileIssueCode
	message: string
	ids: string[]
}

export type CompileResult =
	| { ok: true; plan: ExecutionPlan; taskSpecs: ParallelTaskSpec[]; issues: [] }
	| { ok: false; issues: CompileIssue[] }

const MAX_MESSAGE_CHARS = 100_000

export function isSafeWorkspacePath(p: string): boolean {
	return p.length > 0 && !p.includes("\0") && !p.includes("\\") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split("/").includes("..")
}

function normalizePath(p: string): string {
	return p.replace(/\/+$/, "")
}

/** Two write scopes collide when equal or one contains the other (directory prefix). */
function overlaps(a: string, b: string): boolean {
	const x = normalizePath(a)
	const y = normalizePath(b)
	return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** Task ids that can reach `id` by following dependsOn (all transitive prerequisites). */
function transitivePrerequisites(rev: SpecRevision): Map<string, Set<string>> {
	const deps = new Map(rev.tasks.map((t) => [t.id, t.dependsOn]))
	const memo = new Map<string, Set<string>>()
	const visit = (id: string, stack: Set<string>): Set<string> => {
		const hit = memo.get(id)
		if (hit) return hit
		const out = new Set<string>()
		if (stack.has(id)) return out // cycle: TaskDag reports it; do not recurse forever
		stack.add(id)
		for (const d of deps.get(id) ?? []) {
			out.add(d)
			visit(d, stack).forEach((x) => out.add(x))
		}
		stack.delete(id)
		memo.set(id, out)
		return out
	}
	for (const t of rev.tasks) visit(t.id, new Set())
	return memo
}

function renderTaskMessage(rev: SpecRevision, taskId: string): string {
	const task = rev.tasks.find((t) => t.id === taskId)!
	const reqs = rev.requirements.filter((r) => task.requirementIds.includes(r.id))
	const acc = rev.acceptance.filter((a) => task.acceptanceIds.includes(a.id))
	const checkOf = (id: string) => rev.checks.find((c) => c.id === id)
	const lines = [
		`Spec ${rev.specId} @ ${rev.revisionId.slice(0, 19)} - task ${task.id}`,
		"",
		task.summary,
		"",
		"Requirements:",
		...reqs.map((r) => `- ${r.id}: ${r.text}`),
		"",
		"Acceptance criteria (decided by running the check, not by your report):",
		...acc.map((a) => {
			const c = checkOf(a.checkRef)
			const how = c?.command ? `run: ${c.command.join(" ")}` : "inspection"
			return `- ${a.id}${a.required ? " (required)" : ""}: ${a.text} [${a.evidenceKind}; ${how}]`
		}),
	]
	return lines.join("\n").slice(0, MAX_MESSAGE_CHARS)
}

export function compileSpec(rev: SpecRevision, options: { approval?: SpecApproval } = {}): CompileResult {
	const issues: CompileIssue[] = []
	const add = (code: CompileIssueCode, message: string, ...ids: string[]) => issues.push({ code, message, ids })

	if (!verifyRevisionId(rev)) {
		// Nothing else is trustworthy if the content does not match its id.
		return { ok: false, issues: [{ code: "revision-id-mismatch", message: "revisionId does not match content", ids: [rev.revisionId] }] }
	}
	if (rev.policy === "explore") {
		return { ok: false, issues: [{ code: "policy-explore-has-no-tasks", message: "explore policy is evidence-only and compiles no work", ids: [] }] }
	}
	if (rev.policy === "strict") {
		const a = options.approval
		if (!a || a.revisionId !== rev.revisionId || a.approvedBy !== "user") {
			add("unapproved-revision", "strict policy requires a user approval of exactly this revision", rev.revisionId)
		}
	}

	for (const issue of validateSpecGraph(rev)) {
		// `build` is a just-in-time micro-spec: coverage gaps are tolerated, structural errors are not.
		const structural = issue.code === "duplicate-id" || issue.code === "missing-reference" || issue.code === "check-kind-mismatch" || issue.code === "check-missing-command"
		if (rev.policy === "strict" || structural) add(issue.code, issue.message, ...issue.ids)
	}

	for (const t of rev.tasks) {
		for (const p of [...(t.filesWrite ?? []), ...(t.filesRead ?? [])]) {
			if (!isSafeWorkspacePath(p)) add("unsafe-path", `task ${t.id} has unsafe path ${p}`, t.id)
		}
	}

	// Mutable-file collisions: only between tasks with no ordering between them.
	const prereq = transitivePrerequisites(rev)
	for (let i = 0; i < rev.tasks.length; i++) {
		for (let j = i + 1; j < rev.tasks.length; j++) {
			const a = rev.tasks[i]
			const b = rev.tasks[j]
			const ordered = prereq.get(a.id)?.has(b.id) || prereq.get(b.id)?.has(a.id)
			if (ordered) continue
			const clash = (a.filesWrite ?? []).some((x) => (b.filesWrite ?? []).some((y) => overlaps(x, y)))
			if (clash) add("write-collision", `tasks ${a.id} and ${b.id} write overlapping files with no ordering`, a.id, b.id)
		}
	}

	if (issues.length > 0) return { ok: false, issues }

	const taskSpecs: ParallelTaskSpec[] = []
	for (const t of rev.tasks) {
		const candidate = {
			name: t.id,
			mode: t.mode ?? "code",
			message: renderTaskMessage(rev, t.id),
			dependsOn: t.dependsOn.length > 0 ? t.dependsOn : undefined,
			filesWrite: t.filesWrite,
			filesRead: t.filesRead,
			expectedOutput: `Satisfies ${t.acceptanceIds.join(", ") || "its requirements"}`.slice(0, 2_000),
			specTrace: {
				specId: rev.specId,
				revisionId: rev.revisionId,
				taskId: t.id,
				requirementIds: t.requirementIds,
				acceptanceIds: t.acceptanceIds,
			},
		}
		const parsed = parallelTaskSpecSchema.safeParse(candidate)
		if (!parsed.success) {
			add("invalid-task-spec", `task ${t.id}: ${parsed.error.issues[0]?.message ?? "invalid"}`, t.id)
			continue
		}
		taskSpecs.push(parsed.data)
	}
	if (issues.length > 0) return { ok: false, issues }

	const plan = buildExecutionPlan(taskSpecs)
	try {
		// Reuse the production DAG validator (cycles, unknown/self dependencies, duplicate names).
		new TaskDag(plan)
	} catch (error) {
		if (error instanceof ParallelTasksArgumentError) {
			return { ok: false, issues: [{ code: "dependency-cycle", message: error.message, ids: [] }] }
		}
		throw error
	}
	return { ok: true, plan, taskSpecs, issues: [] }
}
