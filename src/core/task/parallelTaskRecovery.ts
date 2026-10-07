import path from "node:path"
import * as fs from "node:fs/promises"

import { MAX_BATCH_AGE_MS as MAX_RECOVERABLE_BATCH_AGE_MS } from "./parallelTaskRetention"

type SavedWorker = {
	name?: string
	state?: string
	patch?: string
}

type SavedBatch = {
	parentTaskId?: string
	tasks?: SavedWorker[]
}

// Environment details are regenerated for every model turn. Only surface a saved
// batch once per extension-host session so the reminder cannot become a loop.
const surfacedBatches = new Set<string>()

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T
	} catch {
		return undefined
	}
}

/** Surface work that survived an interrupted parallel_tasks call before the parent repeats it. */
export async function getInterruptedParallelBatchSummary(storageRoot: string, parentTaskId: string): Promise<string | undefined> {
	const root = path.join(storageRoot, "parallel-tasks")
	let entries: string[]
	try {
		entries = await fs.readdir(root)
	} catch {
		return undefined
	}

	const batches = await Promise.all(
		entries.map(async (entry) => {
			const directory = path.join(root, entry)
			const manifestPath = path.join(directory, "manifest.json")
			const manifest = await readJson<SavedBatch>(manifestPath)
			if (manifest?.parentTaskId !== parentTaskId || !Array.isArray(manifest.tasks)) return undefined
			try {
				return { directory, manifest, modified: (await fs.stat(manifestPath)).mtimeMs }
			} catch {
				return undefined
			}
		}),
	)
	// Age-bound the candidates BEFORE picking the newest so an ancient interrupted
	// batch cannot shadow (or resurface in place of) a recent one. Reuses the shared
	// retention window; no duplicated literal.
	const oldestAllowed = Date.now() - MAX_RECOVERABLE_BATCH_AGE_MS
	const latest = batches
		.filter((batch) => batch !== undefined)
		.filter((batch) => batch.modified >= oldestAllowed)
		.sort((a, b) => b.modified - a.modified)[0]
	if (!latest) return undefined
	const batchKey = `${parentTaskId}:${latest.directory}:${latest.modified}`
	if (surfacedBatches.has(batchKey)) return undefined

	const workers = await Promise.all(
		(latest.manifest.tasks ?? []).slice(0, 4).map(async (task, index) => {
			const saved = await readJson<SavedWorker>(path.join(latest.directory, `worker-${index + 1}.json`))
			return { ...task, ...saved, index }
		}),
	)
	if (workers.length === 0 || workers.every((worker) => worker.state === "completed")) return undefined

	const lines = workers.map((worker) => {
		const name = JSON.stringify(worker.name ?? `worker-${worker.index + 1}`)
		const state = ["completed", "cancelled", "failed", "running", "queued"].includes(worker.state ?? "")
			? worker.state
			: "unknown"
		const patch = worker.patch ? `; saved patch: ${path.join(latest.directory, `worker-${worker.index + 1}.patch`)}` : ""
		return `- ${name}: ${state}${patch}`
	})
	if (surfacedBatches.has(batchKey)) return undefined
	surfacedBatches.add(batchKey)
	return [
		"# Recoverable Parallel Work",
		`A previous parallel_tasks call for this chat was interrupted. Its saved manifest is ${path.join(latest.directory, "manifest.json")}.`,
		...lines,
		"This reminder appears once per extension-host session. Inspect current files and git status before applying any saved patch; never reapply a patch that has already been integrated. Resume only unfinished scopes. An interrupted call does not mean parallel_tasks is unavailable.",
	].join("\n")
}
