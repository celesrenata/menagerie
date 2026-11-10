import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SpecRevisionStore } from "../SpecRevisionStore"
import { approveSpecRevision, importSpecDraft, type SpecUi } from "../specCommands"
import { SPECS_DIR } from "../strictSpecRun"
import { baseContent } from "./specFixtures"

const ui = (over: Partial<SpecUi> = {}): SpecUi & { warnings: string[]; infos: string[] } => {
	const warnings: string[] = []
	const infos: string[] = []
	return {
		warnings,
		infos,
		chooseFile: vi.fn(async () => undefined),
		chooseRevision: vi.fn(async (items) => items[0]?.id),
		confirm: vi.fn(async () => true),
		info: (m) => infos.push(m),
		warn: (m) => warnings.push(m),
		...over,
	}
}

describe("spec import and approval commands", () => {
	let root: string
	let specsRoot: string
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spec-cmd-")))
		specsRoot = path.join(root, SPECS_DIR)
		await fs.mkdir(path.join(specsRoot, "demo"), { recursive: true })
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const writeDraft = async (content: unknown, name = "spec.draft.json") => {
		const file = path.join(specsRoot, "demo", name)
		await fs.writeFile(file, JSON.stringify(content))
		return file
	}

	it("seals a valid draft, saves an immutable revision and writes the Kiro markdown projection", async () => {
		const u = ui()
		const out = await importSpecDraft({ ui: u, workspaceRoot: root, file: await writeDraft(baseContent()) })
		expect(out.ok).toBe(true)
		if (!out.ok) return
		const store = new SpecRevisionStore(specsRoot)
		expect((await store.loadRevision("demo", out.revisionId)).requirements).toHaveLength(3)
		expect(await store.findApproval("demo", out.revisionId)).toBeUndefined() // import never approves
		for (const doc of ["requirements.md", "design.md", "tasks.md"]) {
			expect(await fs.readFile(path.join(specsRoot, "demo", doc), "utf8")).toContain("menagerie:managed")
		}
		expect(await fs.readFile(path.join(specsRoot, "demo", "tasks.md"), "utf8")).toContain("- [ ] **t1**") // no evidence => unchecked
	})

	it("rejects invalid drafts with reasons and saves nothing", async () => {
		const cycle = baseContent()
		cycle.tasks = cycle.tasks.map((t) => (t.id === "t1" ? { ...t, dependsOn: ["t2"] } : t))
		for (const draft of [{ nope: true }, cycle, baseContent({ checks: [{ id: "C1", kind: "test", command: ["bash", "-c", "true"] }, { id: "C2", kind: "test", command: ["true"] }, { id: "C3", kind: "test", command: ["true"] }] })]) {
			const u = ui()
			const out = await importSpecDraft({ ui: u, workspaceRoot: root, file: await writeDraft(draft) })
			expect(out.ok).toBe(false)
			expect(u.warnings.length).toBe(1)
		}
		expect(await new SpecRevisionStore(specsRoot).listRevisionIds("demo")).toEqual([])
	})

	it("refuses a draft outside the specs directory", async () => {
		const outside = path.join(root, "evil.json")
		await fs.writeFile(outside, JSON.stringify(baseContent()))
		const out = await importSpecDraft({ ui: ui(), workspaceRoot: root, file: outside })
		expect(out).toMatchObject({ ok: false })
	})

	it("records a user approval only after the modal confirmation, and shows the exact commands", async () => {
		const imported = await importSpecDraft({ ui: ui(), workspaceRoot: root, file: await writeDraft(baseContent()) })
		if (!imported.ok) throw new Error("fixture")
		const u = ui()
		const out = await approveSpecRevision({ ui: u, workspaceRoot: root, now: () => 42 })
		expect(out).toEqual({ approved: true, revisionId: imported.revisionId })
		const [, detail] = vi.mocked(u.confirm).mock.calls[0]
		expect(detail).toContain("pnpm test session")
		expect(await new SpecRevisionStore(specsRoot).findApproval("demo", imported.revisionId)).toEqual({ revisionId: imported.revisionId, approvedBy: "user", approvedAt: 42 })
	})

	it("records nothing when the user declines or cancels", async () => {
		const imported = await importSpecDraft({ ui: ui(), workspaceRoot: root, file: await writeDraft(baseContent()) })
		if (!imported.ok) throw new Error("fixture")
		const store = new SpecRevisionStore(specsRoot)
		expect(await approveSpecRevision({ ui: ui({ confirm: async () => false }), workspaceRoot: root })).toMatchObject({ approved: false, reason: "declined" })
		expect(await approveSpecRevision({ ui: ui({ chooseRevision: async () => undefined }), workspaceRoot: root })).toMatchObject({ approved: false, reason: "cancelled" })
		expect(await store.findApproval("demo", imported.revisionId)).toBeUndefined()
	})

	it("does not offer a tampered revision for approval", async () => {
		const imported = await importSpecDraft({ ui: ui(), workspaceRoot: root, file: await writeDraft(baseContent()) })
		if (!imported.ok) throw new Error("fixture")
		const file = path.join(specsRoot, "demo", ".revisions", `${imported.revisionId.slice(7)}.json`)
		await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("pnpm", "rm"))
		const u = ui()
		expect(await approveSpecRevision({ ui: u, workspaceRoot: root })).toMatchObject({ approved: false, reason: "nothing to approve" })
		expect(u.confirm).not.toHaveBeenCalled()
	})
})
