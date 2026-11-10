import * as fs from "fs/promises"
import * as path from "path"

import { SPEC_ID_PATTERN, type SpecApproval, type SpecRevision } from "@roo-code/types"

import { compileSpec } from "./SpecCompiler"
import { evaluateSpecGate } from "./SpecGate"
import { syncProjection } from "./SpecMarkdownProjection"
import { SpecRevisionStore } from "./SpecRevisionStore"
import { parseSpecDraft, sealRevision } from "./specRevision"
import { validateSpecGraph } from "./SpecTraceability"
import { currentSourceRevision, SPECS_DIR } from "./strictSpecRun"
import type { ExecFn } from "./SpecCheckRunner"
import { verifySpecRevision } from "./SpecVerifier"

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
	const approval = { revisionId: rev.revisionId, approvedBy: "user" as const, approvedAt: (args.now ?? Date.now)() }
	await store.recordApproval(rev.specId, approval)
	const dispatchFile = await writeDispatchFile(specsRoot, rev, approval)
	args.ui.info(`Approved spec ${rev.specId} revision ${rev.revisionId.slice(0, 19)}.${dispatchFile ? ` Dispatch its tasks with the parallel_tasks input in ${SPECS_DIR}/${rev.specId}/dispatch.json.` : ""}`)
	return { approved: true, revisionId: rev.revisionId }
}

export type VerifyResult = { verified: true; verdict: string; reasons: string[] } | { verified: false; reason: string }

/**
 * Run an APPROVED revision's executable checks in the real workspace and refresh the Kiro checkboxes
 * from the resulting evidence. Use this after the parent has integrated the workers' patches: the
 * strict batch gate verifies a sandbox of the patches, this verifies what is actually in the checkout.
 * Running a check is authorized by the earlier approval; nothing here asks the model anything.
 */
export async function verifyApprovedRevision(args: { ui: SpecUi; workspaceRoot: string; exec?: ExecFn; now?: () => number }): Promise<VerifyResult> {
	const specsRoot = path.join(args.workspaceRoot, SPECS_DIR)
	const store = new SpecRevisionStore(specsRoot)
	let dirs: string[] = []
	try {
		dirs = (await fs.readdir(specsRoot)).filter((d) => SPEC_ID_PATTERN.test(d))
	} catch {
		// no specs directory
	}
	const approved: Array<{ id: string; specId: string; revisionId: string; label: string; detail: string }> = []
	for (const specId of dirs) {
		for (const revisionId of await store.listRevisionIds(specId)) {
			if (!(await store.findApproval(specId, revisionId))) continue
			try {
				const rev = await store.loadRevision(specId, revisionId)
				approved.push({ id: `${specId}|${revisionId}`, specId, revisionId, label: `${specId} · ${revisionId.slice(0, 19)} · ${rev.policy}`, detail: `${rev.checks.filter((c) => c.command).length} executable checks` })
			} catch {
				// integrity failure: never offered
			}
		}
	}
	if (approved.length === 0) {
		args.ui.info("No approved spec revisions to verify.")
		return { verified: false, reason: "nothing approved" }
	}
	const choice = await args.ui.chooseRevision(approved.map((a) => ({ id: a.id, label: a.label, detail: a.detail })))
	const picked = approved.find((a) => a.id === choice)
	if (!picked) return { verified: false, reason: "cancelled" }
	const rev = await store.loadRevision(picked.specId, picked.revisionId)
	try {
		const gate = await verifySpecRevision({
			store,
			revision: rev,
			workspaceRoot: args.workspaceRoot,
			sourceRevision: await currentSourceRevision(args.workspaceRoot),
			// User-triggered, on the integrated checkout: the host-run checks are the verification.
			verifierOutcomes: [{ kind: "pass", reason: "user-triggered verification of the integrated checkout" }],
			exec: args.exec,
			now: args.now,
		})
		await syncProjection(path.join(specsRoot, rev.specId), rev, gate)
		const summary = `Spec ${rev.specId}: ${gate.verdict} (${gate.coverage.covered}/${gate.coverage.total} requirements covered).${gate.reasons.length ? ` ${gate.reasons.slice(0, 3).join("; ")}` : ""}`
		if (gate.verdict === "pass") args.ui.info(summary)
		else args.ui.warn(summary)
		return { verified: true, verdict: gate.verdict, reasons: gate.reasons }
	} catch (error) {
		const reason = error instanceof Error ? error.message : "verification failed"
		args.ui.warn(`Spec verification did not run: ${reason}`)
		return { verified: false, reason }
	}
}

/**
 * Write the compiled `parallel_tasks` input for an approved revision, so a model (or you) can dispatch it
 * unchanged: every task already carries its `specTrace`, which strict dispatch requires. Regenerated on every
 * approval, so it always names the latest approved revision. Returns false when nothing compiles (e.g. `explore`).
 */
export async function writeDispatchFile(specsRoot: string, rev: SpecRevision, approval: SpecApproval): Promise<boolean> {
	const compiled = compileSpec(rev, { approval })
	if (!compiled.ok) return false
	const file = path.join(specsRoot, rev.specId, "dispatch.json")
	await fs.mkdir(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.tmp`
	await fs.writeFile(tmp, JSON.stringify({ tasks: compiled.taskSpecs }, null, 2), "utf8")
	await fs.rename(tmp, file)
	return true
}
