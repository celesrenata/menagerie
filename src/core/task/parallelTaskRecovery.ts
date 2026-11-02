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

// Real manifests are a few KB. Anything past this is not a resumable batch record, and parsing it on
// every model turn (once for each task in the host) is expensive, so it is skipped without being read.
const MAX_MANIFEST_BYTES = 1024 * 1024

// Parsed manifests keyed by path, revalidated against mtime and size so an unchanged file is not
// re-read and re-parsed on each model turn.
const manifestCache = new Map<string, { mtimeMs: number; size: number; manifest: SavedBatch | undefined }>()

async function readManifest(
	manifestPath: string,
	oldestAllowed: number,
): Promise<{ manifest: SavedBatch | undefined; modified: number } | undefined> {
	let stat: Awaited<ReturnType<typeof fs.stat>>
	try {
		stat = await fs.stat(manifestPath)
	} catch {
		return undefined
	}
	// Age and size are checked on the stat alone, before any bytes are read.
	if (stat.mtimeMs < oldestAllowed || stat.size > MAX_MANIFEST_BYTES) return undefined
	const cached = manifestCache.get(manifestPath)
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return { manifest: cached.manifest, modified: stat.mtimeMs }
	}
	const manifest = await readJson<SavedBatch>(manifestPath)
	manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, manifest })
	return { manifest, modified: stat.mtimeMs }
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		if ((await fs.stat(file)).size > MAX_MANIFEST_BYTES) return undefined
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

	// Age-bound the candidates BEFORE reading so an ancient interrupted batch cannot shadow (or resurface
	// in place of) a recent one, and so expired or oversized manifests are never parsed. Reuses the shared
	// retention window; no duplicated literal.
	const oldestAllowed = Date.now() - MAX_RECOVERABLE_BATCH_AGE_MS
	const batches = await Promise.all(
		entries.map(async (entry) => {
			const directory = path.join(root, entry)
			const read = await readManifest(path.join(directory, "manifest.json"), oldestAllowed)
			const manifest = read?.manifest
			if (!read || manifest?.parentTaskId !== parentTaskId || !Array.isArray(manifest.tasks)) return undefined
			return { directory, manifest, modified: read.modified }
		}),
	)
	const present = new Set(entries)
	for (const cachedPath of manifestCache.keys()) {
		if (cachedPath.startsWith(root + path.sep) && !present.has(path.basename(path.dirname(cachedPath)))) {
			manifestCache.delete(cachedPath)
		}
	}
	const latest = batches
		.filter((batch) => batch !== undefined)
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
