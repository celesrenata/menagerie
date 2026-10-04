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
})
