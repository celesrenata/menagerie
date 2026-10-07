import path from "node:path"
import os from "node:os"
import * as fs from "node:fs/promises"

import { MAX_BATCH_AGE_MS, MAX_BATCH_COUNT, pruneParallelTaskBatches } from "../parallelTaskRetention"

async function createBatch(root: string, name: string, modifiedMs: number): Promise<string> {
	const directory = path.join(root, "parallel-tasks", name)
	await fs.mkdir(directory, { recursive: true })
	const manifest = path.join(directory, "manifest.json")
	await fs.writeFile(manifest, JSON.stringify({ parentTaskId: "parent", tasks: [] }))
	const seconds = modifiedMs / 1000
	await fs.utimes(manifest, seconds, seconds)
	return directory
}

describe("parallel task retention prune", () => {
	let storageRoot: string
	const now = Date.UTC(2024, 0, 15)

	beforeEach(async () => {
		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-parallel-retention-"))
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("removes dirs older than the age bound and keeps recent ones", async () => {
		await createBatch(storageRoot, "old", now - MAX_BATCH_AGE_MS - 60_000)
		await createBatch(storageRoot, "recent", now - 60_000)

		const result = await pruneParallelTaskBatches(storageRoot, now)

		expect(result.removed).toEqual(["old"])
		expect(result.kept).toBe(1)
		const surviving = await fs.readdir(path.join(storageRoot, "parallel-tasks"))
		expect(surviving).toEqual(["recent"])
	})

	it("falls back to the dir mtime when the manifest is missing", async () => {
		const directory = path.join(storageRoot, "parallel-tasks", "no-manifest")
		await fs.mkdir(directory, { recursive: true })
		const seconds = (now - MAX_BATCH_AGE_MS - 60_000) / 1000
		await fs.utimes(directory, seconds, seconds)

		const result = await pruneParallelTaskBatches(storageRoot, now)

		expect(result.removed).toEqual(["no-manifest"])
		expect(result.kept).toBe(0)
	})

	it("enforces the count cap by evicting the oldest recent dirs first", async () => {
		const total = MAX_BATCH_COUNT + 10
		for (let index = 0; index < total; index++) {
			// All recent (within the age window) but staggered so order is deterministic.
			await createBatch(storageRoot, `batch-${String(index).padStart(3, "0")}`, now - (total - index) * 1000)
		}

		const result = await pruneParallelTaskBatches(storageRoot, now)

		expect(result.kept).toBe(MAX_BATCH_COUNT)
		expect(result.removed).toHaveLength(10)
		// The 10 oldest (lowest index) are evicted; the newest survive.
		for (let index = 0; index < 10; index++) {
			expect(result.removed).toContain(`batch-${String(index).padStart(3, "0")}`)
		}
		const surviving = await fs.readdir(path.join(storageRoot, "parallel-tasks"))
		expect(surviving).toHaveLength(MAX_BATCH_COUNT)
		expect(surviving).toContain(`batch-${String(total - 1).padStart(3, "0")}`)
	})

	it("never deletes a batch dir created after the prune (active-batch exclusion by ordering)", async () => {
		await createBatch(storageRoot, "old", now - MAX_BATCH_AGE_MS - 60_000)

		// Model runParallelTasks ordering: prune first, THEN create the active batch dir.
		const result = await pruneParallelTaskBatches(storageRoot, now)
		const activeDir = path.join(storageRoot, "parallel-tasks", "active-batch")
		await fs.mkdir(activeDir, { recursive: true })

		expect(result.removed).toEqual(["old"])
		expect(result.removed).not.toContain("active-batch")
		expect(await fs.readdir(path.join(storageRoot, "parallel-tasks"))).toContain("active-batch")
	})

	it("resolves without throwing when the storage root does not exist", async () => {
		const result = await pruneParallelTaskBatches(path.join(storageRoot, "does", "not", "exist"), now)
		expect(result).toEqual({ removed: [], kept: 0 })
	})

	it("continues the sweep when a per-dir stat fails", async () => {
		// A dangling symlink entry: readdir lists it, but statting the entry (and the
		// manifest inside it) rejects, exercising the warn-and-continue path. A valid
		// aged dir alongside it must still be removed, proving the sweep did not abort.
		const parallelRoot = path.join(storageRoot, "parallel-tasks")
		await fs.mkdir(parallelRoot, { recursive: true })
		await fs.symlink(path.join(storageRoot, "nonexistent-target"), path.join(parallelRoot, "broken-link"))
		await createBatch(storageRoot, "old", now - MAX_BATCH_AGE_MS - 60_000)

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const result = await pruneParallelTaskBatches(storageRoot, now)

		// The aged dir was removed despite the broken-link stat failure; function resolved.
		expect(result.removed).toContain("old")
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[ParallelTaskRetention]"), expect.anything())

		warnSpy.mockRestore()
	})
})
