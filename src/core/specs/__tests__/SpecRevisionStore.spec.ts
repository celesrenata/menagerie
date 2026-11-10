import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises"
import * as os from "os"
import * as path from "path"

import { SpecRevisionStore, SpecStoreError } from "../SpecRevisionStore"
import { sealRevision } from "../specRevision"
import { baseContent, baseRevision, evidence } from "./specFixtures"

describe("SpecRevisionStore", () => {
	let root: string
	let store: SpecRevisionStore
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "specstore-"))
		store = new SpecRevisionStore(root)
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it("round-trips a revision and re-saving is a no-op that leaves no temp files", async () => {
		const rev = baseRevision()
		await store.saveRevision(rev)
		await store.saveRevision(rev)
		expect(await store.loadRevision("demo", rev.revisionId)).toEqual(rev)
		expect(await store.listRevisionIds("demo")).toEqual([rev.revisionId])
		const files = await readdir(path.join(root, "demo", ".revisions"))
		expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
	})

	it("refuses a revision whose id does not match its content, and detects on-disk tampering", async () => {
		const rev = baseRevision()
		await expect(store.saveRevision({ ...rev, sourceRevision: "git:evil" })).rejects.toThrow(SpecStoreError)
		await store.saveRevision(rev)
		const file = path.join(root, "demo", ".revisions", `${rev.revisionId.slice(7)}.json`)
		await writeFile(file, (await readFile(file, "utf8")).replace("Sessions expire", "Sessions NEVER expire"))
		await expect(store.loadRevision("demo", rev.revisionId)).rejects.toThrow(/integrity/)
	})

	it("rejects path-escaping spec and revision ids", async () => {
		await expect(store.loadRevision("../x", "sha256:" + "a".repeat(64))).rejects.toThrow(SpecStoreError)
		await expect(store.loadRevision("demo", "sha256:../../etc")).rejects.toThrow(SpecStoreError)
	})

	it("walks lineage newest-first and never mutates the parent when a new revision is created", async () => {
		const v1 = baseRevision()
		const v2 = sealRevision({ ...baseContent(), parentRevisionId: v1.revisionId, sourceRevision: "git:bbb" })
		await store.saveRevision(v1)
		await store.saveRevision(v2)
		expect((await store.lineage("demo", v2.revisionId)).map((r) => r.revisionId)).toEqual([v2.revisionId, v1.revisionId])
		expect(await store.loadRevision("demo", v1.revisionId)).toEqual(v1)
	})

	it("rehydrates evidence and approval after a 'restart' (new store instance)", async () => {
		const rev = baseRevision()
		await store.saveRevision(rev)
		await store.appendEvidence(evidence(rev, "A1"))
		await store.recordApproval("demo", { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 5 })
		const reopened = new SpecRevisionStore(root)
		expect((await reopened.readEvidence("demo")).records).toHaveLength(1)
		expect(await reopened.findApproval("demo", rev.revisionId)).toMatchObject({ approvedBy: "user" })
	})

	it("survives a torn final evidence line without losing earlier records", async () => {
		const rev = baseRevision()
		await store.saveRevision(rev)
		await store.appendEvidence(evidence(rev, "A1"))
		await appendFile(path.join(root, "demo", ".revisions", "evidence.jsonl"), '{"revisionId":"sha256:')
		const read = await store.readEvidence("demo")
		expect(read.records).toHaveLength(1)
		expect(read.skipped).toBe(1)
	})

	it("refuses evidence or approval for an unknown revision, and a model-sourced evidence record", async () => {
		const rev = baseRevision()
		await expect(store.appendEvidence(evidence(rev, "A1"))).rejects.toThrow(SpecStoreError)
		await store.saveRevision(rev)
		await expect(store.appendEvidence(evidence(rev, "A1", { source: "model" as never }))).rejects.toThrow()
		await expect(store.recordApproval("demo", { revisionId: "sha256:" + "9".repeat(64), approvedBy: "user", approvedAt: 1 })).rejects.toThrow(SpecStoreError)
	})
})
