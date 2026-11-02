import path from "node:path"
import os from "node:os"
import * as fs from "node:fs/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>()
	hoisted.readFile.mockImplementation(actual.readFile)
	return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => hoisted.readFile(...args) }
})

import { getInterruptedParallelBatchSummary } from "../parallelTaskRecovery"

// surfacedBatches is module-level, so every test uses its own parent id.
describe("interrupted parallel batch recovery reads", () => {
	let storageRoot: string

	const manifestReads = () =>
		hoisted.readFile.mock.calls.filter(([file]) => String(file).endsWith("manifest.json")).length

	const writeBatch = async (name: string, parentTaskId: string, extra: Record<string, unknown> = {}) => {
		const directory = path.join(storageRoot, "parallel-tasks", name)
		await fs.mkdir(directory, { recursive: true })
		const manifest = path.join(directory, "manifest.json")
		await fs.writeFile(manifest, JSON.stringify({ parentTaskId, tasks: [{ name: "api", state: "queued" }], ...extra }))
		return { directory, manifest }
	}

	beforeEach(async () => {
		hoisted.readFile.mockClear()
		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-parallel-recovery-reads-"))
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("never reads a manifest larger than the size bound", async () => {
		const { manifest } = await writeBatch("oversized", "oversized-parent", { error: "x".repeat(2 * 1024 * 1024) })
		expect((await fs.stat(manifest)).size).toBeGreaterThan(1024 * 1024)
		hoisted.readFile.mockClear()

		expect(await getInterruptedParallelBatchSummary(storageRoot, "oversized-parent")).toBeUndefined()
		expect(manifestReads()).toBe(0)
	})

	it("never reads a manifest older than the age bound", async () => {
		const { manifest } = await writeBatch("expired", "expired-parent")
		const eightDaysAgoSeconds = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
		await fs.utimes(manifest, eightDaysAgoSeconds, eightDaysAgoSeconds)
		hoisted.readFile.mockClear()

		expect(await getInterruptedParallelBatchSummary(storageRoot, "expired-parent")).toBeUndefined()
		expect(manifestReads()).toBe(0)
	})

	it("does not re-read an unchanged manifest on later scans", async () => {
		await writeBatch("stable", "stable-owner")
		hoisted.readFile.mockClear()

		// Scans for other parents never match, so they exercise the scan without surfacing the batch.
		await getInterruptedParallelBatchSummary(storageRoot, "someone-else-1")
		await getInterruptedParallelBatchSummary(storageRoot, "someone-else-2")
		await getInterruptedParallelBatchSummary(storageRoot, "someone-else-3")

		expect(manifestReads()).toBe(1)
	})

	it("re-reads a manifest after it changes", async () => {
		const { manifest } = await writeBatch("changing", "changing-owner")
		await getInterruptedParallelBatchSummary(storageRoot, "someone-else-4")
		hoisted.readFile.mockClear()

		await fs.writeFile(
			manifest,
			JSON.stringify({ parentTaskId: "changing-owner", tasks: [{ name: "api", state: "running" }, { name: "ui", state: "queued" }] }),
		)
		await getInterruptedParallelBatchSummary(storageRoot, "someone-else-5")

		expect(manifestReads()).toBe(1)
	})
})
