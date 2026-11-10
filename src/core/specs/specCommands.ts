import * as fs from "fs/promises"
import * as path from "path"

import { SPEC_ID_PATTERN } from "@roo-code/types"

import { compileSpec } from "./SpecCompiler"
import { evaluateSpecGate } from "./SpecGate"
import { syncProjection } from "./SpecMarkdownProjection"
import { SpecRevisionStore } from "./SpecRevisionStore"
import { parseSpecDraft, sealRevision } from "./specRevision"
import { validateSpecGraph } from "./SpecTraceability"
import { SPECS_DIR } from "./strictSpecRun"

/**
 * User-driven authoring and approval of spec revisions (MEN-GRANITE-SDD-001 R6.1, R6.6, R1.1).
 *
 * Approval is deliberately NOT a model tool: it records `approvedBy: "user"` only after a modal
 * confirmation that lists the exact commands the revision will be allowed to run, so a model can
 * draft a spec but cannot grant itself permission to execute anything. The UI is injected so the
 * logic is testable without VS Code.
 */
export interface SpecUi {
	chooseFile(defaultDir: string): Promise<string | undefined>
	chooseRevision(items: Array<{ id: string; label: string; detail: string }>): Promise<string | undefined>
	/** Modal confirmation. Must return true only on an explicit user action. */
	confirm(message: string, detail: string, actionLabel: string): Promise<boolean>
	info(message: string): void
	warn(message: string): void
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "csh", "tcsh", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"])

export type ImportResult = { ok: true; revisionId: string; specId: string; conflicts: number } | { ok: false; issues: string[] }

export async function importSpecDraft(args: { ui: SpecUi; workspaceRoot: string; file?: string }): Promise<ImportResult> {
	const specsRoot = path.join(args.workspaceRoot, SPECS_DIR)
	const file = args.file ?? (await args.ui.chooseFile(specsRoot))
	if (!file) return { ok: false, issues: ["no draft file chosen"] }
	// Only drafts inside the workspace's specs directory are accepted.
	const resolved = path.resolve(file)
	if (resolved !== specsRoot && !resolved.startsWith(specsRoot + path.sep)) {
		return fail(args.ui, [`draft must be inside ${SPECS_DIR}`])
	}
	let raw: unknown
	try {
		raw = JSON.parse(await fs.readFile(resolved, "utf8"))
	} catch (error) {
		return fail(args.ui, [`cannot read draft: ${error instanceof Error ? error.message : "unknown error"}`])
	}
	const parsed = parseSpecDraft(raw)
	if (!parsed.ok) return fail(args.ui, parsed.issues)

	const rev = sealRevision(parsed.content)
	const issues = validateSpecGraph(rev).map((i) => i.message)
	for (const c of rev.checks) {
		if (c.command && SHELLS.has(path.basename(c.command[0]).toLowerCase())) issues.push(`check ${c.id} invokes a shell (${c.command[0]}); use an argv without a shell`)
	}
	// Surface compile problems (cycles, write collisions, unsafe paths) now; the approval used here is local and never stored.
	const compiled = compileSpec(rev, { approval: { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 0 } })
	if (!compiled.ok) issues.push(...compiled.issues.filter((i) => i.code !== "policy-explore-has-no-tasks").map((i) => i.message))
	if (issues.length > 0) return fail(args.ui, [...new Set(issues)].slice(0, 20))

	const store = new SpecRevisionStore(specsRoot)
	await store.saveRevision(rev)
	// Kiro markdown projection; hand edits are preserved and reported, never overwritten.
	const gate = evaluateSpecGate({ revision: rev, evidence: [], currentSourceRevision: rev.sourceRevision, currentInputDigests: {}, verifierGatePassed: false })
	const conflicts = await syncProjection(path.join(specsRoot, rev.specId), rev, gate)
	args.ui.info(`Saved spec ${rev.specId} revision ${rev.revisionId.slice(0, 19)}. Approve it to allow its checks to run.${conflicts.length ? ` ${conflicts.length} projection conflict(s) kept for you to resolve.` : ""}`)
	return { ok: true, revisionId: rev.revisionId, specId: rev.specId, conflicts: conflicts.length }
}

function fail(ui: SpecUi, issues: string[]): ImportResult {
	ui.warn(`Spec draft rejected: ${issues.join("; ")}`)
	return { ok: false, issues }
}

export type ApproveResult = { approved: true; revisionId: string } | { approved: false; reason: string }

export async function approveSpecRevision(args: { ui: SpecUi; workspaceRoot: string; now?: () => number }): Promise<ApproveResult> {
	const specsRoot = path.join(args.workspaceRoot, SPECS_DIR)
	const store = new SpecRevisionStore(specsRoot)
	let dirs: string[] = []
	try {
		dirs = (await fs.readdir(specsRoot)).filter((d) => SPEC_ID_PATTERN.test(d))
	} catch {
		// no specs directory
	}
	const pending: Array<{ id: string; specId: string; label: string; detail: string }> = []
	for (const specId of dirs) {
		for (const revisionId of await store.listRevisionIds(specId)) {
			if (await store.findApproval(specId, revisionId)) continue
			try {
				const rev = await store.loadRevision(specId, revisionId)
				pending.push({ id: `${specId}|${revisionId}`, specId, label: `${specId} · ${revisionId.slice(0, 19)} · ${rev.policy}`, detail: `${rev.requirements.length} requirements, ${rev.tasks.length} tasks, ${rev.checks.length} checks` })
			} catch {
				// A revision that fails integrity verification is never offered for approval.
			}
		}
	}
	if (pending.length === 0) {
		args.ui.info("No unapproved spec revisions.")
		return { approved: false, reason: "nothing to approve" }
	}
	const choice = await args.ui.chooseRevision(pending.map((p) => ({ id: p.id, label: p.label, detail: p.detail })))
	const picked = pending.find((p) => p.id === choice)
	if (!picked) return { approved: false, reason: "cancelled" }
	const rev = await store.loadRevision(picked.specId, picked.id.split("|")[1])

	const commands = rev.checks.filter((c) => c.command).map((c) => `  ${c.id}: ${c.command!.join(" ")}`)
	const detail = [
		`Policy: ${rev.policy}`,
		`Requirements: ${rev.requirements.length}, tasks: ${rev.tasks.length}`,
		commands.length ? `Approving allows these commands to run in your workspace (no shell):\n${commands.join("\n")}` : "No commands will run (inspection checks only).",
	].join("\n")
	const ok = await args.ui.confirm(`Approve spec ${rev.specId} revision ${rev.revisionId.slice(0, 19)}?`, detail, "Approve")
	if (!ok) return { approved: false, reason: "declined" }
	await store.recordApproval(rev.specId, { revisionId: rev.revisionId, approvedBy: "user", approvedAt: (args.now ?? Date.now)() })
	args.ui.info(`Approved spec ${rev.specId} revision ${rev.revisionId.slice(0, 19)}.`)
	return { approved: true, revisionId: rev.revisionId }
}
