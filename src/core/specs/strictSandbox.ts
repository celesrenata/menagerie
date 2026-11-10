import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { execa } from "execa"

/**
 * Verification sandbox for a finished parallel batch (MEN-GRANITE-SDD-001 R8).
 *
 * Workers edit isolated worktrees and export patches; nothing is applied to the user's checkout. To
 * check a spec against what the workers actually produced, this builds a throwaway detached worktree
 * at the batch's snapshot commit, applies the completed tasks' patches in dependency order, and hands
 * back that directory. The user's checkout is never read for results or modified, and the worktree is
 * removed afterwards. A patch that does not apply is a blocked verification, not a pass.
 */
export type Sandbox =
	| { ok: true; dir: string; sourceRevision: string; cleanup: () => Promise<void> }
	| { ok: false; reason: string }

export interface SandboxRequest {
	/** The parent task's working directory (inside the repository). */
	repoCwd: string
	/** Batch manifest written by `runParallelTasks`; records the snapshot commit the workers started from. */
	manifestPath: string | undefined
	/** Completed spec tasks with their exported patch file, already in dependency order. */
	patches: ReadonlyArray<{ taskId: string; patchPath?: string | undefined }>
}

export type SandboxFactory = (request: SandboxRequest) => Promise<Sandbox>

const COMMIT = /^[0-9a-f]{40}$/

/** Dependency order (prerequisites first) over the tasks that appear in `ids`; stable for ties. */
export function dependencyOrder(tasks: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>): string[] {
	const byId = new Map(tasks.map((t) => [t.id, t]))
	const out: string[] = []
	const state = new Map<string, "visiting" | "done">()
	const visit = (id: string): void => {
		if (state.get(id) === "done" || state.get(id) === "visiting") return
		state.set(id, "visiting")
		for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep)
		state.set(id, "done")
		out.push(id)
	}
	for (const t of tasks) visit(t.id)
	return out
}

export const createVerificationSandbox: SandboxFactory = async ({ repoCwd, manifestPath, patches }) => {
	if (!manifestPath) return { ok: false, reason: "no batch manifest to verify against" }
	let commit: string
	try {
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { snapshot?: unknown }
		if (typeof manifest.snapshot !== "string" || !COMMIT.test(manifest.snapshot)) return { ok: false, reason: "batch manifest has no valid snapshot commit" }
		commit = manifest.snapshot
	} catch {
		return { ok: false, reason: "cannot read batch manifest" }
	}

	const manifestDir = path.dirname(path.resolve(manifestPath))
	const resolvedPatches: Array<{ taskId: string; file: string }> = []
	for (const p of patches) {
		if (!p.patchPath) continue // a task that changed nothing exports no patch
		const file = path.resolve(p.patchPath)
		// Patches are produced inside the batch directory; refuse anything else.
		if (path.dirname(file) !== manifestDir) return { ok: false, reason: `patch for ${p.taskId} is outside the batch directory` }
		resolvedPatches.push({ taskId: p.taskId, file })
	}

	let root: string
	try {
		root = (await execa("git", ["rev-parse", "--show-toplevel"], { cwd: repoCwd })).stdout
	} catch {
		return { ok: false, reason: "workspace is not inside a git repository" }
	}
	const relativeCwd = path.relative(await fs.realpath(root), await fs.realpath(repoCwd))

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-verify-"))
	const cleanup = async (): Promise<void> => {
		await execa("git", ["worktree", "remove", "--force", dir], { cwd: root, reject: false })
		await fs.rm(dir, { recursive: true, force: true })
		await execa("git", ["worktree", "prune"], { cwd: root, reject: false })
	}
	try {
		await execa("git", ["worktree", "add", "--detach", dir, commit], { cwd: root })
		const digest = createHash("sha256")
		for (const { taskId, file } of resolvedPatches) {
			const content = await fs.readFile(file)
			digest.update(taskId).update(content)
			if (content.length === 0) continue
			const applied = await execa("git", ["apply", "--whitespace=nowarn", file], { cwd: dir, reject: false })
			if (applied.exitCode !== 0) {
				await cleanup()
				return { ok: false, reason: `patch for ${taskId} does not apply with the earlier tasks' patches: ${String(applied.stderr).split("\n")[0].slice(0, 160)}` }
			}
		}
		await linkInstalledDependencies(root, dir)
		return { ok: true, dir: path.join(dir, relativeCwd), sourceRevision: `batch:${commit.slice(0, 12)}+${digest.digest("hex").slice(0, 12)}`, cleanup }
	} catch (error) {
		await cleanup()
		return { ok: false, reason: `cannot prepare verification sandbox: ${error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "unknown error"}` }
	}
}

/**
 * Snapshots exclude ignored files, so a fresh worktree has no installed dependencies and most checks
 * would fail for the wrong reason. Link `node_modules` at the root and one level down (pnpm/npm
 * workspaces) from the real checkout. Read-only use: the links point at the user's installed tree.
 */
async function linkInstalledDependencies(root: string, sandbox: string): Promise<void> {
	const candidates = ["node_modules"]
	for (const group of [".", "packages", "apps"]) {
		let names: string[] = []
		try {
			names = group === "." ? (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name) : (await fs.readdir(path.join(root, group), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(group, e.name))
		} catch {
			continue
		}
		for (const n of names) if (!n.startsWith(".")) candidates.push(path.join(n, "node_modules"))
	}
	for (const rel of candidates) {
		const from = path.join(root, rel)
		const to = path.join(sandbox, rel)
		try {
			await fs.access(from)
			await fs.mkdir(path.dirname(to), { recursive: true })
			await fs.symlink(from, to, "dir")
		} catch {
			// not present or already exists
		}
	}
}
