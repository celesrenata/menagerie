import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { execa } from "execa"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SpecRevisionStore } from "../SpecRevisionStore"
import { sealRevision } from "../specRevision"
import { createVerificationSandbox, dependencyOrder } from "../strictSandbox"
import { runStrictGate, SPECS_DIR } from "../strictSpecRun"

const git = (cwd: string, ...args: string[]) => execa("git", args, { cwd, env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

describe("dependencyOrder", () => {
	it("puts prerequisites first and ignores unknown dependencies", () => {
		expect(dependencyOrder([{ id: "b", dependsOn: ["a"] }, { id: "a", dependsOn: [] }, { id: "c", dependsOn: ["ghost"] }])).toEqual(["a", "b", "c"])
	})
})

describe("verification sandbox (real git)", () => {
	let repo: string
	let batch: string
	let base: string
	beforeEach(async () => {
		repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-repo-")))
		batch = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-batch-"))
		await git(repo, "init", "-q")
		await fs.writeFile(path.join(repo, "app.txt"), "one\n")
		await fs.mkdir(path.join(repo, "node_modules"))
		await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\n")
		await git(repo, "add", "-A")
		await git(repo, "commit", "-q", "-m", "base")
		base = (await git(repo, "rev-parse", "HEAD")).stdout
		await fs.writeFile(path.join(batch, "manifest.json"), JSON.stringify({ snapshot: base }))
	})
	afterEach(async () => {
		await fs.rm(repo, { recursive: true, force: true })
		await fs.rm(batch, { recursive: true, force: true })
	})

	/** A patch made the way the workers make theirs: a diff against the snapshot, written into the batch dir. */
	const makePatch = async (name: string, edit: (dir: string) => Promise<void>): Promise<string> => {
		const wt = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-wt-"))
		await fs.rm(wt, { recursive: true })
		await git(repo, "worktree", "add", "--detach", wt, base)
		await edit(wt)
		await git(wt, "add", "-A")
		const diff = (await git(wt, "diff", "--cached", "--binary", "--full-index", base)).stdout
		await git(repo, "worktree", "remove", "--force", wt)
		const file = path.join(batch, `${name}.patch`)
		await fs.writeFile(file, diff ? diff + "\n" : "")
		return file
	}
	const req = (patches: Array<{ taskId: string; patchPath?: string }>) => ({ repoCwd: repo, manifestPath: path.join(batch, "manifest.json"), patches })

	it("applies the workers' patches in a throwaway worktree and leaves the user's checkout untouched", async () => {
		const p1 = await makePatch("w1", (d) => fs.writeFile(path.join(d, "feature.txt"), "feature\n"))
		const p2 = await makePatch("w2", (d) => fs.appendFile(path.join(d, "app.txt"), "two\n"))
		const box = await createVerificationSandbox(req([{ taskId: "t1", patchPath: p1 }, { taskId: "t2", patchPath: p2 }]))
		if (!box.ok) throw new Error(box.reason)
		expect(await fs.readFile(path.join(box.dir, "feature.txt"), "utf8")).toBe("feature\n")
		expect(await fs.readFile(path.join(box.dir, "app.txt"), "utf8")).toBe("one\ntwo\n")
		expect(box.sourceRevision).toMatch(/^batch:[0-9a-f]{12}\+[0-9a-f]{12}$/)
		// installed dependencies are visible to the checks
		expect((await fs.lstat(path.join(box.dir, "node_modules"))).isSymbolicLink()).toBe(true)
		// the user's checkout was not modified
		await expect(fs.access(path.join(repo, "feature.txt"))).rejects.toThrow()
		expect(await fs.readFile(path.join(repo, "app.txt"), "utf8")).toBe("one\n")
		await box.cleanup()
		await expect(fs.access(box.dir)).rejects.toThrow()
		expect((await git(repo, "worktree", "list")).stdout.split("\n")).toHaveLength(1)
	})

	it("treats a task that changed nothing as fine", async () => {
		const box = await createVerificationSandbox(req([{ taskId: "t1", patchPath: undefined }, { taskId: "t2", patchPath: await makePatch("empty", async () => {}) }]))
		expect(box.ok).toBe(true)
		if (box.ok) await box.cleanup()
	})

	it("is blocked when two patches conflict, and cleans up after itself", async () => {
		const p1 = await makePatch("w1", (d) => fs.writeFile(path.join(d, "app.txt"), "from one\n"))
		const p2 = await makePatch("w2", (d) => fs.writeFile(path.join(d, "app.txt"), "from two\n"))
		const box = await createVerificationSandbox(req([{ taskId: "t1", patchPath: p1 }, { taskId: "t2", patchPath: p2 }]))
		expect(box).toMatchObject({ ok: false })
		if (!box.ok) expect(box.reason).toContain("patch for t2 does not apply")
		expect((await git(repo, "worktree", "list")).stdout.split("\n")).toHaveLength(1)
	})

	it("refuses a missing manifest, a bad snapshot and a patch outside the batch directory", async () => {
		expect(await createVerificationSandbox({ ...req([]), manifestPath: undefined })).toMatchObject({ ok: false })
		await fs.writeFile(path.join(batch, "manifest.json"), JSON.stringify({ snapshot: "not-a-commit" }))
		expect(await createVerificationSandbox(req([]))).toMatchObject({ ok: false })
		await fs.writeFile(path.join(batch, "manifest.json"), JSON.stringify({ snapshot: base }))
		const outside = path.join(repo, "evil.patch")
		await fs.writeFile(outside, "")
		expect(await createVerificationSandbox(req([{ taskId: "t1", patchPath: outside }]))).toMatchObject({ ok: false, reason: expect.stringContaining("outside the batch directory") })
	})

	it("end to end: a check that needs the workers' change fails on the base and passes once their patch is applied", async () => {
		const rev = sealRevision({
			specId: "demo",
			policy: "strict",
			sourceRevision: "git:aaa",
			requirements: [{ id: "R1", text: "feature file exists", acceptanceIds: ["A1"] }],
			decisions: [],
			tasks: [{ id: "t1", summary: "add feature", dependsOn: [], requirementIds: ["R1"], decisionIds: [], acceptanceIds: ["A1"] }],
			acceptance: [{ id: "A1", text: "feature.txt exists", required: true, evidenceKind: "test", checkRef: "C1" }],
			checks: [{ id: "C1", kind: "test", command: [process.execPath, "-e", "process.exit(require('fs').existsSync('feature.txt') ? 0 : 1)"] }],
		})
		const store = new SpecRevisionStore(path.join(repo, SPECS_DIR))
		await store.saveRevision(rev)
		await store.recordApproval("demo", { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 1 })
		const manifestPath = path.join(batch, "manifest.json")

		const withoutPatch = await runStrictGate({ revisions: [rev], store, workspaceRoot: repo, manifestPath, tasks: [{ name: "t1", state: "completed" }] })
		expect(withoutPatch[0].verdict).toBe("failed") // the unmodified snapshot lacks the feature

		const patch = await makePatch("w1", (d) => fs.writeFile(path.join(d, "feature.txt"), "x\n"))
		const withPatch = await runStrictGate({ revisions: [rev], store, workspaceRoot: repo, manifestPath, tasks: [{ name: "t1", state: "completed", patch }] })
		expect(withPatch[0]).toMatchObject({ verdict: "pass", requirementsCovered: "1/1" })
		// still nothing in the user's checkout
		await expect(fs.access(path.join(repo, "feature.txt"))).rejects.toThrow()
	})
})
