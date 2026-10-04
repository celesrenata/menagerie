import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { addSharedDocumentReader } from "../ParallelTaskReader"
import type { ParallelTaskSpec } from "../../tools/ParallelTasksTool"

// Build N workers that each reference `document`. Pass `modes` to control count and per-worker
// mode (defaults to three Code workers for the existing cases).
const workers = (document: string, modes: string[] = ["code", "code", "code"]): ParallelTaskSpec[] =>
	modes.map((mode, offset) => ({
		name: `${mode}-${offset + 1}`,
		mode,
		message: `Implement scope ${offset + 1} according to ${document}.`,
		todos: null,
	}))

describe("addSharedDocumentReader", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-reader-"))
		await fs.mkdir(path.join(root, "docs"))
		await fs.writeFile(path.join(root, "docs", "design.md"), "# Shared contract\n")
	})
	afterEach(async () => fs.rm(root, { recursive: true, force: true }))

	it("adds a bounded M5 audit when three Code workers share a real design document", async () => {
		const tasks = await addSharedDocumentReader(workers("docs/design.md"), root, true, true)
		expect(tasks).toHaveLength(4)
		expect(tasks[3]).toMatchObject({ name: "m5-contract-audit", mode: "project-reader" })
		expect(tasks[3]!.message).toContain("from docs/design.md")
		expect(tasks[3]!.message).toContain("L1: # Shared contract")
		expect(tasks[3]!.message).toContain("Do not call read_file")
		expect(tasks[3]!.todos).toContain("Read the shared document")
	})

	it("does not add filler work without a shared existing document or reader mode", async () => {
		expect(await addSharedDocumentReader(workers("docs/missing.md"), root, true)).toHaveLength(3)
		expect(await addSharedDocumentReader(workers("docs/design.md"), root, false)).toHaveLength(3)
		expect(await addSharedDocumentReader(workers("docs/design.md").slice(0, 1), root, true)).toHaveLength(1)
	})

	it("ignores paths that escape the worktree", async () => {
		const tasks = await addSharedDocumentReader(workers("docs/../../outside.md"), root, true)
		expect(tasks).toHaveLength(3)
	})

	it("adds a reader when two Code workers share a real document", async () => {
		const tasks = await addSharedDocumentReader(workers("docs/design.md", ["code", "code"]), root, true)
		expect(tasks).toHaveLength(3)
		expect(tasks[2]).toMatchObject({ name: "m5-contract-audit", mode: "project-reader" })
		expect(tasks[2]!.message).toContain("2 sibling workers")
		expect(tasks[2]!.message).toContain("Do not call read_file")
	})

	it("adds a reader for a mixed-mode fan-out sharing a document", async () => {
		const tasks = await addSharedDocumentReader(workers("docs/design.md", ["code", "project-research"]), root, true)
		expect(tasks).toHaveLength(3)
		expect(tasks[2]).toMatchObject({ name: "m5-contract-audit", mode: "project-reader" })
		expect(tasks[2]!.message).toContain("Do not call read_file")
	})

	it("fires when only one of several workers references the shared document", async () => {
		const specs = workers("docs/design.md", ["code", "code"])
		specs[1]!.message = "Implement scope 2 with no document reference."
		const tasks = await addSharedDocumentReader(specs, root, true)
		expect(tasks).toHaveLength(3)
		expect(tasks[2]).toMatchObject({ name: "m5-contract-audit", mode: "project-reader" })
	})

	it("never appends past the four-worker cap", async () => {
		const tasks = await addSharedDocumentReader(
			workers("docs/design.md", ["code", "code", "code", "code"]),
			root,
			true,
		)
		expect(tasks).toHaveLength(4)
		expect(tasks.some(({ name }) => name === "m5-contract-audit")).toBe(false)
	})

	it("samples relevant contracts throughout a long document", async () => {
		const lines = Array.from({ length: 400 }, (_, index) =>
			index === 305 ? "## API endpoints and integration contract" : `ordinary line ${index}`,
		)
		await fs.writeFile(path.join(root, "docs", "design.md"), lines.join("\n"))
		const tasks = await addSharedDocumentReader(workers("docs/design.md"), root, true)
		expect(tasks[3]!.message).toContain("L306: ## API endpoints and integration contract")
	})
})
