import * as fs from "node:fs/promises"
import path from "node:path"
import { execa } from "execa"

/** Snapshot the current tree through a private index; never stage or commit the user's checkout. */
export async function snapshotWorkingTree(cwd: string, storage: string): Promise<{ root: string; commit: string }> {
	const { stdout: root } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd })
	await fs.mkdir(storage, { recursive: true })
	const temporary = await fs.mkdtemp(path.join(storage, "index-"))
	const env = { GIT_INDEX_FILE: path.join(temporary, "index") }
	try {
		const headResult = await execa("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, reject: false })
		const head = headResult.exitCode === 0 ? headResult.stdout : null
		if (!head) {
			// An initialized repository can have an unborn branch. Keep its real
			// HEAD untouched and make a root snapshot commit only in Git's object store.
			const branch = await execa("git", ["symbolic-ref", "-q", "HEAD"], { cwd: root, reject: false })
			if (branch.exitCode !== 0) throw new Error("Unable to resolve Git HEAD")
		} else {
			await execa("git", ["read-tree", head], { cwd: root, env })
		}
		await execa("git", ["add", "-A", "--", "."], { cwd: root, env })
		const { stdout: tree } = await execa("git", ["write-tree"], { cwd: root, env })
		const { stdout: commit } = await execa("git", ["commit-tree", tree, ...(head ? ["-p", head] : [])], {
			cwd: root,
			input: "Zoo parallel task snapshot\n",
			env: {
				...env,
				GIT_AUTHOR_NAME: "Zoo Code",
				GIT_AUTHOR_EMAIL: "parallel@localhost",
				GIT_COMMITTER_NAME: "Zoo Code",
				GIT_COMMITTER_EMAIL: "parallel@localhost",
			},
		})
		return { root, commit }
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}

export async function createParallelWorkspace(root: string, commit: string, directory: string): Promise<void> {
	await execa("git", ["worktree", "add", "--detach", directory, commit], { cwd: root })
}

/** Export tracked and new files relative to the shared snapshot, including binary changes. */
export async function exportParallelPatch(workspace: string, base: string, patchPath: string): Promise<void> {
	const snapshot = await snapshotWorkingTree(workspace, path.dirname(patchPath))
	const result = await execa("git", ["diff", "--binary", "--full-index", base, snapshot.commit, "--"], {
		cwd: workspace,
		maxBuffer: 64 * 1024 * 1024,
	})
	await fs.writeFile(patchPath, result.stdout ? result.stdout + "\n" : "", { mode: 0o600 })
}
