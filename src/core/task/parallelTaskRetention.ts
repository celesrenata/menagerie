import path from "node:path"
import * as fs from "node:fs/promises"

// Single source of truth for parallel-tasks cache retention bounds. Both the
// prune sweep (runParallelTasks) and the interrupted-batch recovery age bound
// (parallelTaskRecovery) import these so the window is never duplicated.
export const MAX_BATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const MAX_BATCH_COUNT = 50

/** Resolve a directory's effective age timestamp: its manifest.json mtime, falling back to the dir's own mtime. */
async function resolveBatchModified(directory: string): Promise<number> {
	try {
		return (await fs.stat(path.join(directory, "manifest.json"))).mtimeMs
	} catch {
		return (await fs.stat(directory)).mtimeMs
	}
}

/**
 * Prune the parallel-tasks cache under `<storageRoot>/parallel-tasks`.
 *
 * Deletes batch dirs older than {@link MAX_BATCH_AGE_MS}, then—if still over
 * {@link MAX_BATCH_COUNT}—deletes the oldest survivors down to the cap. Eviction
 * is by age/count only; patches within the window are preserved, never inspected.
 *
 * Resilience contract: never throws. A missing storage root resolves to
 * `{ removed: [], kept: 0 }`; per-dir stat/delete failures are swallowed with a
 * `[ParallelTaskRetention]` console.warn and the sweep continues.
 */
export async function pruneParallelTaskBatches(
	storageRoot: string,
	now: number = Date.now(),
): Promise<{ removed: string[]; kept: number }> {
	const root = path.join(storageRoot, "parallel-tasks")
	const removed: string[] = []

	let entries: string[]
	try {
		entries = await fs.readdir(root)
	} catch {
		// Storage root (or the parallel-tasks subdir) does not exist yet: nothing to prune.
		return { removed: [], kept: 0 }
	}

	// First pass: resolve each batch's age and delete anything past the age bound.
	const survivors: { entry: string; modified: number }[] = []
	for (const entry of entries) {
		const directory = path.join(root, entry)
		let modified: number
		try {
			modified = await resolveBatchModified(directory)
		} catch (error) {
			console.warn(`[ParallelTaskRetention] failed to stat batch ${entry}:`, error)
			continue
		}
		if (now - modified > MAX_BATCH_AGE_MS) {
			try {
				await fs.rm(directory, { recursive: true, force: true })
				removed.push(entry)
			} catch (error) {
				console.warn(`[ParallelTaskRetention] failed to remove aged batch ${entry}:`, error)
				survivors.push({ entry, modified })
			}
		} else {
			survivors.push({ entry, modified })
		}
	}

	// Second pass: enforce the count cap by evicting the oldest survivors first.
	if (survivors.length > MAX_BATCH_COUNT) {
		const oldestFirst = survivors.slice().sort((a, b) => a.modified - b.modified)
		const overflow = oldestFirst.slice(0, survivors.length - MAX_BATCH_COUNT)
		for (const { entry } of overflow) {
			const directory = path.join(root, entry)
			try {
				await fs.rm(directory, { recursive: true, force: true })
				removed.push(entry)
				const index = survivors.findIndex((survivor) => survivor.entry === entry)
				if (index !== -1) survivors.splice(index, 1)
			} catch (error) {
				console.warn(`[ParallelTaskRetention] failed to evict batch ${entry} over count cap:`, error)
			}
		}
	}

	return { removed, kept: survivors.length }
}
