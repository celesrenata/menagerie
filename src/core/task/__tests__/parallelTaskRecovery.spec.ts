import path from "node:path"
import os from "node:os"
import * as fs from "node:fs/promises"

import { getInterruptedParallelBatchSummary } from "../parallelTaskRecovery"

describe("interrupted parallel batch recovery", () => {
	let storageRoot: string

	beforeEach(async () => {
		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-parallel-recovery-"))
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("surfaces completed and cancelled workers from an interrupted batch", async () => {
		const directory = path.join(storageRoot, "parallel-tasks", "batch-1")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(
			path.join(directory, "manifest.json"),
			JSON.stringify({ parentTaskId: "parent", tasks: [{ name: "api", state: "queued" }, { name: "ui", state: "queued" }] }),
		)
		await fs.writeFile(
			path.join(directory, "worker-1.json"),
			JSON.stringify({ name: "api", state: "completed", patch: path.join(directory, "worker-1.patch") }),
		)
		await fs.writeFile(path.join(directory, "worker-2.json"), JSON.stringify({ name: "ui", state: "cancelled" }))

		const summary = await getInterruptedParallelBatchSummary(storageRoot, "parent")
		expect(summary).toContain('"api": completed; saved patch:')
		expect(summary).toContain('"ui": cancelled')
		expect(summary).toContain("never reapply a patch")
		expect(await getInterruptedParallelBatchSummary(storageRoot, "parent")).toBeUndefined()
		expect(await getInterruptedParallelBatchSummary(storageRoot, "different-parent")).toBeUndefined()
	})

	it("does not repeat a fully completed batch", async () => {
		const directory = path.join(storageRoot, "parallel-tasks", "batch-1")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(
			path.join(directory, "manifest.json"),
			JSON.stringify({ parentTaskId: "parent", tasks: [{ name: "api", state: "completed" }] }),
		)
		expect(await getInterruptedParallelBatchSummary(storageRoot, "parent")).toBeUndefined()
	})

	it("skips an interrupted batch whose manifest is older than the recovery age bound", async () => {
		// Unique parentTaskId: surfacedBatches is module-level and persists across tests.
		const directory = path.join(storageRoot, "parallel-tasks", "aged-batch")
		await fs.mkdir(directory, { recursive: true })
		const manifest = path.join(directory, "manifest.json")
		await fs.writeFile(
			manifest,
			JSON.stringify({ parentTaskId: "aged-parent", tasks: [{ name: "api", state: "queued" }] }),
		)
		// 8 days old — past the 7-day bound reused from parallelTaskRetention.
		const eightDaysAgoSeconds = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
		await fs.utimes(manifest, eightDaysAgoSeconds, eightDaysAgoSeconds)

		expect(await getInterruptedParallelBatchSummary(storageRoot, "aged-parent")).toBeUndefined()
	})

	it("still surfaces a recent matching interrupted batch within the age bound", async () => {
		const directory = path.join(storageRoot, "parallel-tasks", "fresh-batch")
		await fs.mkdir(directory, { recursive: true })
		const manifest = path.join(directory, "manifest.json")
		await fs.writeFile(
			manifest,
			JSON.stringify({ parentTaskId: "fresh-parent", tasks: [{ name: "api", state: "queued" }] }),
		)
		const oneHourAgoSeconds = (Date.now() - 60 * 60 * 1000) / 1000
		await fs.utimes(manifest, oneHourAgoSeconds, oneHourAgoSeconds)

		const summary = await getInterruptedParallelBatchSummary(storageRoot, "fresh-parent")
		expect(summary).toContain("# Recoverable Parallel Work")
		expect(summary).toContain('"api": queued')
	})
})
