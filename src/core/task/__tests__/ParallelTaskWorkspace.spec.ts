import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execa } from "execa"
import { snapshotWorkingTree, createParallelWorkspace, exportParallelPatch } from "../ParallelTaskWorkspace"

describe("parallel task working tree snapshots", () => {
	let temporary: string
	beforeEach(async () => {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-parallel-test-"))
	})
	afterEach(async () => {
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it("starts workers from an unborn repository without committing the user's branch", async () => {
		const root = path.join(temporary, "new-repo")
		await fs.mkdir(root)
		const git = (...args: string[]) => execa("git", args, { cwd: root })
		await git("init", "-q")
		await fs.writeFile(path.join(root, "source.txt"), "first draft\n")
		await fs.writeFile(path.join(root, ".gitignore"), "secret.txt\n")
		await fs.writeFile(path.join(root, "secret.txt"), "private\n")
		const before = (await git("status", "--short")).stdout

		const snapshot = await snapshotWorkingTree(root, path.join(temporary, "storage"))
		const worker = path.join(temporary, "worker")
		await createParallelWorkspace(snapshot.root, snapshot.commit, worker)
		expect(await fs.readFile(path.join(worker, "source.txt"), "utf8")).toBe("first draft\n")
		await expect(fs.stat(path.join(worker, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" })
		await expect(git("rev-parse", "--verify", "HEAD")).rejects.toBeDefined()
		expect((await git("status", "--short")).stdout).toBe(before)

		await fs.writeFile(path.join(worker, "source.txt"), "worker draft\n")
		const patch = path.join(temporary, "storage", "worker.patch")
		await exportParallelPatch(worker, snapshot.commit, patch)
		expect(await fs.readFile(patch, "utf8")).toContain("+worker draft")
	})

	it("preserves staged/unstaged/user files and exports only worker edits, including new and binary files", async () => {
		const root = path.join(temporary, "repo")
		await fs.mkdir(root)
		const git = (...args: string[]) => execa("git", args, { cwd: root })
		await git("init", "-q")
		await git("config", "user.name", "Test")
		await git("config", "user.email", "test@localhost")
		await fs.writeFile(path.join(root, "tracked"), "base\n")
		await fs.writeFile(path.join(root, ".gitignore"), "secret\n")
		await git("add", ".")
		await git("commit", "-qm", "base")
		await fs.writeFile(path.join(root, "tracked"), "staged\n")
		await git("add", "tracked")
		await fs.writeFile(path.join(root, "tracked"), "user working copy\n")
		await fs.writeFile(path.join(root, "user-new"), "untracked user data\n")
		await fs.writeFile(path.join(root, "secret"), "ignored\n")
		const indexBefore = await fs.readFile(path.join(root, ".git/index"))
		const headBefore = (await git("rev-parse", "HEAD")).stdout
		const snapshot = await snapshotWorkingTree(root, path.join(temporary, "storage"))
		const worker = path.join(temporary, "worker")
		await createParallelWorkspace(snapshot.root, snapshot.commit, worker)
		expect(await fs.readFile(path.join(worker, "tracked"), "utf8")).toBe("user working copy\n")
		expect(await fs.readFile(path.join(worker, "user-new"), "utf8")).toBe("untracked user data\n")
		await expect(fs.stat(path.join(worker, "secret"))).rejects.toMatchObject({ code: "ENOENT" })
		await fs.writeFile(path.join(worker, "tracked"), "worker change\n")
		await fs.writeFile(path.join(worker, "worker-new"), "new code\n")
		await fs.writeFile(path.join(worker, "binary"), Buffer.from([0, 1, 2, 255]))
		const patch = path.join(temporary, "storage", "worker.patch")
		await exportParallelPatch(worker, snapshot.commit, patch)
		const diff = await fs.readFile(patch, "utf8")
		expect(diff).toContain("-user working copy\n+worker change")
		expect(diff).toContain("new code")
		expect(diff).toContain("GIT binary patch")
		expect(diff).not.toContain("untracked user data")
		expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(indexBefore)
		expect((await git("rev-parse", "HEAD")).stdout).toBe(headBefore)
		expect(await fs.readFile(path.join(root, "tracked"), "utf8")).toBe("user working copy\n")
		await git("apply", "--check", patch)
	})

	it("includes an untracked non-ignored nested directory without warning, and excludes ignored artifacts", async () => {
		const root = path.join(temporary, "nested-repo")
		await fs.mkdir(root)
		const git = (...args: string[]) => execa("git", args, { cwd: root })
		await git("init", "-q")
		await git("config", "user.name", "Test")
		await git("config", "user.email", "test@localhost")
		await fs.writeFile(path.join(root, "tracked"), "base\n")
		await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n")
		await git("add", ".")
		await git("commit", "-qm", "base")
		// Untracked, non-ignored nested directory (no matching .gitignore rule).
		await fs.mkdir(path.join(root, "web", "src"), { recursive: true })
		await fs.writeFile(path.join(root, "web", "src", "app.ts"), "export const app = 1\n")
		// Ignored artifact directory that must stay out of the snapshot.
		await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true })
		await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {}\n")

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		try {
			const snapshot = await snapshotWorkingTree(root, path.join(temporary, "storage"))
			const worker = path.join(temporary, "worker")
			await createParallelWorkspace(snapshot.root, snapshot.commit, worker)

			expect(await fs.readFile(path.join(worker, "web", "src", "app.ts"), "utf8")).toBe("export const app = 1\n")
			await expect(fs.stat(path.join(worker, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
			// The non-ignored directory is present in the tree, so no diagnostic fires for it.
			const warnedAboutWeb = warnSpy.mock.calls.some(
				(call) => typeof call[0] === "string" && call[0].includes("[ParallelTaskWorkspace]") && call[0].includes('"web"'),
			)
			expect(warnedAboutWeb).toBe(false)
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("warns when a non-ignored top-level directory on disk is absent from the snapshot tree", async () => {
		const root = path.join(temporary, "empty-dir-repo")
		await fs.mkdir(root)
		const git = (...args: string[]) => execa("git", args, { cwd: root })
		await git("init", "-q")
		await git("config", "user.name", "Test")
		await git("config", "user.email", "test@localhost")
		await fs.writeFile(path.join(root, "tracked"), "base\n")
		await git("add", ".")
		await git("commit", "-qm", "base")
		// An empty directory is not ignored, yet Git never records empty dirs in a tree,
		// so `git add -A` leaves it absent from the written tree -> the diagnostic fires.
		await fs.mkdir(path.join(root, "generated"))

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const indexBefore = await fs.readFile(path.join(root, ".git/index"))
		const headBefore = (await git("rev-parse", "HEAD")).stdout
		try {
			await snapshotWorkingTree(root, path.join(temporary, "storage"))
			const warnedAboutGenerated = warnSpy.mock.calls.some(
				(call) =>
					typeof call[0] === "string" &&
					call[0].includes("[ParallelTaskWorkspace]") &&
					call[0].includes('"generated"'),
			)
			expect(warnedAboutGenerated).toBe(true)
		} finally {
			warnSpy.mockRestore()
		}
		// Core invariant: the user's real index/HEAD remain untouched.
		expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(indexBefore)
		expect((await git("rev-parse", "HEAD")).stdout).toBe(headBefore)
	})
})
