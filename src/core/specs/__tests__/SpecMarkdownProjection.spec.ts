import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { evaluateSpecGate } from "../SpecGate"
import { completedTaskIds, mergeProjection, renderProjection, syncProjection } from "../SpecMarkdownProjection"
import { baseRevision, currentDigests, evidence } from "./specFixtures"

const rev = baseRevision()
const gateWith = (passing: string[]) =>
	evaluateSpecGate({
		revision: rev,
		approval: { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 1 },
		evidence: passing.map((id) => evidence(rev, id)),
		currentSourceRevision: "git:aaa",
		currentInputDigests: currentDigests(rev),
		verifierGatePassed: true,
	})

const tasksDoc = (done: string[]) => renderProjection(rev, new Set(done)).find((d) => d.doc === "tasks")!

describe("SpecMarkdownProjection", () => {
	it("checks a task box only when every acceptance criterion has passing evidence", () => {
		expect(completedTaskIds(rev, gateWith([]))).toEqual(new Set())
		expect(completedTaskIds(rev, gateWith(["A1", "A3"]))).toEqual(new Set(["t1", "t3"]))
	})

	it("creates a new document from the skeleton with managed blocks", () => {
		const merged = mergeProjection(tasksDoc(["t1"]), undefined)
		expect(merged.conflicts).toEqual([])
		expect(merged.content).toContain("- [x] **t1**")
		expect(merged.content).toContain("- [ ] **t2**")
	})

	it("preserves human text outside managed blocks and refreshes untouched blocks", () => {
		const first = mergeProjection(tasksDoc([]), undefined).content!
		const withNotes = `${first}\n## My notes\nkeep me\n`
		const merged = mergeProjection(tasksDoc(["t1"]), withNotes)
		expect(merged.conflicts).toEqual([])
		expect(merged.content).toContain("## My notes\nkeep me")
		expect(merged.content).toContain("- [x] **t1**")
	})

	it("keeps a hand-edited block and reports a conflict with the proposal", () => {
		const first = mergeProjection(tasksDoc([]), undefined).content!
		const edited = first.replace("Session expiry", "Session expiry (human tweak)")
		const merged = mergeProjection(tasksDoc([]), edited)
		expect(merged.content).toContain("(human tweak)")
		expect(merged.conflicts).toHaveLength(1)
		expect(merged.conflicts[0]).toMatchObject({ blockId: "t1", kind: "hand-edited" })
		expect(merged.conflicts[0].proposed).toContain("Session expiry _Req")
	})

	it("corrects a hand-ticked checkbox that has no evidence behind it", () => {
		const first = mergeProjection(tasksDoc([]), undefined).content!
		const ticked = first.replace("- [ ] **t2**", "- [x] **t2**")
		const merged = mergeProjection(tasksDoc([]), ticked)
		expect(merged.content).toContain("- [ ] **t2**")
		expect(merged.content).not.toContain("- [x] **t2**")
		expect(merged.conflicts).toEqual([{ doc: "tasks", blockId: "t2", kind: "checkbox-corrected" }])
	})

	it("keeps blocks for renamed/removed tasks as orphaned and appends new ones", () => {
		const first = mergeProjection(tasksDoc([]), undefined).content!
		const smaller = tasksDoc([])
		smaller.blocks = smaller.blocks.filter((b) => b.id !== "t3")
		smaller.blocks.push({ id: "t4", body: "- [ ] **t4** New" })
		const merged = mergeProjection(smaller, first)
		expect(merged.conflicts).toEqual([{ doc: "tasks", blockId: "t3", kind: "orphaned" }])
		expect(merged.content).toContain("**t3**")
		expect(merged.content).toContain("**t4**")
	})

	it("refuses to touch a file with unbalanced markers", () => {
		const first = mergeProjection(tasksDoc([]), undefined).content!
		const torn = first.replace("<!-- /menagerie:managed -->", "")
		const merged = mergeProjection(tasksDoc([]), torn)
		expect(merged.content).toBeUndefined()
		expect(merged.conflicts[0].kind).toBe("malformed")
	})

	describe("syncProjection on disk", () => {
		let dir: string
		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-proj-"))
		})
		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true })
		})

		it("writes all three docs, is idempotent, and leaves no temp files", async () => {
			expect(await syncProjection(dir, rev, gateWith(["A1"]))).toEqual([])
			expect(await syncProjection(dir, rev, gateWith(["A1"]))).toEqual([])
			expect((await fs.readdir(dir)).sort()).toEqual(["design.md", "requirements.md", "tasks.md"])
			expect(await fs.readFile(path.join(dir, "tasks.md"), "utf8")).toContain("- [x] **t1**")
		})

		it("leaves a malformed file byte-for-byte unchanged", async () => {
			await syncProjection(dir, rev, gateWith([]))
			const file = path.join(dir, "tasks.md")
			const torn = (await fs.readFile(file, "utf8")).replace("<!-- /menagerie:managed -->", "")
			await fs.writeFile(file, torn)
			const conflicts = await syncProjection(dir, rev, gateWith(["A1"]))
			expect(conflicts.some((c) => c.kind === "malformed")).toBe(true)
			expect(await fs.readFile(file, "utf8")).toBe(torn)
		})
	})
})
