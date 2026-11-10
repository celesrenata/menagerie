import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import type { SpecRevision } from "@roo-code/types"

import type { GateResult } from "./SpecGate"

/**
 * Kiro markdown projections of a canonical `SpecRevision` (MEN-GRANITE-SDD-001 R6.6, R6.7).
 *
 * The revision (JSON) is the machine state; `.kiro/specs/<slug>/{requirements,design,tasks}.md`
 * are reviewable projections. Generated content lives in MANAGED BLOCKS whose marker carries a
 * hash of the body as last written. Text outside blocks is never touched. A block whose current
 * body no longer matches its marker hash was hand-edited: it is kept and reported as a
 * conflict, never overwritten.
 *
 * A task checkbox is `[x]` only when every one of its acceptance criteria is `pass` in a
 * deterministic gate result. A hand-ticked box without evidence is corrected back (and
 * reported), because completion is derived from recorded evidence, not text (R6.7).
 */

export const PROJECTION_DOCS = ["requirements", "design", "tasks"] as const
export type ProjectionDoc = (typeof PROJECTION_DOCS)[number]

export type ProjectionConflictKind = "hand-edited" | "malformed" | "orphaned" | "checkbox-corrected"

export interface ProjectionConflict {
	doc: ProjectionDoc
	blockId: string
	kind: ProjectionConflictKind
	/** What the generator wanted to write (absent for orphaned/malformed). */
	proposed?: string
}

export interface MergedDoc {
	doc: ProjectionDoc
	/** Content to write. Undefined when the file must not be touched (malformed markers). */
	content?: string
	conflicts: ProjectionConflict[]
}

const OPEN = (id: string, sha: string) => `<!-- menagerie:managed id="${id}" sha="${sha}" -->`
const CLOSE = "<!-- /menagerie:managed -->"
const BLOCK_RE = /<!-- menagerie:managed id="([^"]+)" sha="([a-f0-9]{12})" -->\n([\s\S]*?)\n<!-- \/menagerie:managed -->/g
const OPEN_RE = /<!-- menagerie:managed id="/g

const bodySha = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 12)
const wrap = (id: string, body: string): string => `${OPEN(id, bodySha(body))}\n${body}\n${CLOSE}`

export interface RenderedBlock {
	id: string
	body: string
}
export interface RenderedDoc {
	doc: ProjectionDoc
	skeleton: string
	blocks: RenderedBlock[]
}

/** Task ids whose acceptance criteria ALL pass in the gate result. Derived, never claimed. */
export function completedTaskIds(rev: SpecRevision, gate: GateResult): Set<string> {
	const pass = new Set(gate.acceptance.filter((a) => a.state === "pass").map((a) => a.acceptanceId))
	return new Set(rev.tasks.filter((t) => t.acceptanceIds.length > 0 && t.acceptanceIds.every((id) => pass.has(id))).map((t) => t.id))
}

export function renderProjection(rev: SpecRevision, doneTaskIds: ReadonlySet<string>): RenderedDoc[] {
	const meta = (doc: string): RenderedBlock => ({
		id: "meta",
		body: `Spec \`${rev.specId}\` · ${doc} · policy \`${rev.policy}\` · revision \`${rev.revisionId.slice(0, 19)}\` · source \`${rev.sourceRevision}\``,
	})
	const accById = new Map(rev.acceptance.map((a) => [a.id, a]))

	const requirements: RenderedDoc = {
		doc: "requirements",
		skeleton: `# Requirements: ${rev.specId}\n`,
		blocks: [
			meta("requirements"),
			...rev.requirements.map((r) => ({
				id: r.id,
				body: [
					`### ${r.id}`,
					r.text,
					...r.acceptanceIds.map((id) => {
						const a = accById.get(id)
						return a ? `- ${a.id} (${a.required ? "required" : "optional"}, ${a.evidenceKind}): ${a.text}` : `- ${id} (undefined)`
					}),
				].join("\n"),
			})),
		],
	}
	const design: RenderedDoc = {
		doc: "design",
		skeleton: `# Design: ${rev.specId}\n`,
		blocks: [meta("design"), ...rev.decisions.map((d) => ({ id: d.id, body: `### ${d.id}\n${d.rationale}\n_Requirements: ${d.requirementIds.join(", ")}_` }))],
	}
	const tasks: RenderedDoc = {
		doc: "tasks",
		skeleton: `# Implementation Plan: ${rev.specId}\n`,
		blocks: [
			meta("tasks"),
			...rev.tasks.map((t) => {
				const box = doneTaskIds.has(t.id) ? "x" : " "
				const deps = t.dependsOn.length > 0 ? ` _Depends on: ${t.dependsOn.join(", ")}_` : ""
				return {
					id: t.id,
					body: `- [${box}] **${t.id}** ${t.summary} _Requirements: ${t.requirementIds.join(", ")}_ _Acceptance: ${t.acceptanceIds.join(", ") || "none"}_${deps}`,
				}
			}),
		],
	}
	return [requirements, design, tasks]
}

const uncheck = (s: string): string => s.replace(/^- \[[ xX]\]/gm, "- [ ]")

/**
 * Merge freshly rendered blocks into the existing file text. `existing` undefined means the file
 * does not exist yet. Pure: the caller decides whether and how to write `content`.
 */
export function mergeProjection(rendered: RenderedDoc, existing: string | undefined): MergedDoc {
	const conflicts: ProjectionConflict[] = []
	const fresh = new Map(rendered.blocks.map((b) => [b.id, b.body]))

	if (existing === undefined) {
		return { doc: rendered.doc, content: `${rendered.skeleton}\n${rendered.blocks.map((b) => wrap(b.id, b.body)).join("\n\n")}\n`, conflicts }
	}

	const opens = existing.match(OPEN_RE)?.length ?? 0
	const found = [...existing.matchAll(BLOCK_RE)]
	const ids = found.map((m) => m[1])
	if (found.length !== opens || new Set(ids).size !== ids.length) {
		// Unbalanced or duplicated markers: refuse to guess where human text ends.
		return { doc: rendered.doc, conflicts: [{ doc: rendered.doc, blockId: "*", kind: "malformed" }] }
	}

	const seen = new Set<string>()
	let out = existing.replace(BLOCK_RE, (whole, id: string, sha: string, body: string) => {
		seen.add(id)
		const next = fresh.get(id)
		if (next === undefined) {
			conflicts.push({ doc: rendered.doc, blockId: id, kind: "orphaned" })
			return whole
		}
		if (bodySha(body) === sha) return wrap(id, next) // untouched since last write: safe to refresh
		if (body === next) return wrap(id, next) // human converged on the same text
		if (rendered.doc === "tasks" && uncheck(body) === uncheck(next)) {
			// Only the checkbox differs: evidence decides, not the text.
			conflicts.push({ doc: rendered.doc, blockId: id, kind: "checkbox-corrected" })
			return wrap(id, next)
		}
		conflicts.push({ doc: rendered.doc, blockId: id, kind: "hand-edited", proposed: next })
		return whole
	})

	const added = rendered.blocks.filter((b) => !seen.has(b.id))
	if (added.length > 0) out = `${out.replace(/\s*$/, "")}\n\n${added.map((b) => wrap(b.id, b.body)).join("\n\n")}\n`
	return { doc: rendered.doc, content: out, conflicts }
}

/** Write via temp file + rename so an interrupted write never leaves a torn document. */
async function atomicWrite(file: string, content: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await fs.writeFile(tmp, content, "utf8")
	try {
		await fs.rename(tmp, file)
	} catch (error) {
		await fs.rm(tmp, { force: true })
		throw error
	}
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

/**
 * Refresh the three projection files in `specDir`. Files with malformed markers are left
 * untouched; hand-edited blocks are kept. Returns every conflict for the caller to surface.
 */
export async function syncProjection(specDir: string, rev: SpecRevision, gate: GateResult): Promise<ProjectionConflict[]> {
	await fs.mkdir(specDir, { recursive: true })
	const conflicts: ProjectionConflict[] = []
	for (const doc of renderProjection(rev, completedTaskIds(rev, gate))) {
		const file = path.join(specDir, `${doc.doc}.md`)
		const merged = mergeProjection(doc, await readIfExists(file))
		conflicts.push(...merged.conflicts)
		if (merged.content !== undefined) await atomicWrite(file, merged.content)
	}
	return conflicts
}
