import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SpecRevisionStore } from "../SpecRevisionStore"
import { checkStrictDispatch, MAX_FIXER_ATTEMPTS, runStrictGate, SPECS_DIR } from "../strictSpecRun"
import type { SandboxFactory } from "../strictSandbox"
import { sealRevision } from "../specRevision"

describe("strict gate fixer advice", () => {
	let root: string
	let store: SpecRevisionStore
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "strict-run-"))
		store = new SpecRevisionStore(path.join(root, SPECS_DIR))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	const revision = async (exitCode: number) => {
		const rev = sealRevision({
			specId: "demo",
			policy: "strict",
			sourceRevision: "git:aaa",
			requirements: [{ id: "R1", text: "works", acceptanceIds: ["A1"] }],
			decisions: [],
			tasks: [{ id: "t1", summary: "do", dependsOn: [], requirementIds: ["R1"], decisionIds: [], acceptanceIds: ["A1"] }],
			acceptance: [{ id: "A1", text: "passes", required: true, evidenceKind: "test", checkRef: "C1" }],
			checks: [{ id: "C1", kind: "test", command: [process.execPath, "-e", `process.exit(${exitCode})`] }],
		})
		await store.saveRevision(rev)
		await store.recordApproval("demo", { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 1 })
		return rev
	}
	// The real sandbox is covered by strictSandbox.spec; here the "sandbox" is just the temp dir.
	const sandbox: SandboxFactory = async () => ({ ok: true, dir: root, sourceRevision: "batch:test", cleanup: async () => {} })
	const run = (rev: Awaited<ReturnType<typeof revision>>, tasks = [{ name: "t1", state: "completed" }], factory: SandboxFactory = sandbox) =>
		runStrictGate({ revisions: [rev], store, workspaceRoot: root, manifestPath: "unused", tasks, sandbox: factory })

	it("advises a bounded number of fixes linked to the failing requirement, then reports exhaustion", async () => {
		const rev = await revision(3)
		const first = (await run(rev))[0]
		expect(first.verdict).toBe("failed")
		expect(first.fixer).toMatchObject({ attempt: 1, exhausted: false, links: [{ acceptanceId: "A1", requirementIds: ["R1"] }] })
		const second = (await run(rev))[0]
		expect(second.fixer).toMatchObject({ attempt: 2, exhausted: false })
		const third = (await run(rev))[0]
		expect(third.fixer).toMatchObject({ exhausted: true, maxAttempts: MAX_FIXER_ATTEMPTS })
		// Earlier failing runs stay in the append-only record, and the advice links to them.
		expect((await store.readEvidence("demo")).records.filter((r) => r.status === "fail")).toHaveLength(3)
		expect(third.fixer?.links[0].priorCheckRunIds.length).toBe(3)
	})

	it("gives no fixer advice for a passing gate and reports every criterion", async () => {
		const out = (await run(await revision(0)))[0]
		expect(out.verdict).toBe("pass")
		expect(out.fixer).toBeUndefined()
		expect(out.criteria).toEqual([{ acceptanceId: "A1", required: true, state: "pass", reason: "fresh passing artifact" }])
	})

	it("leaves an inspection criterion missing so it blocks verification", async () => {
		const rev = sealRevision({
			specId: "demo",
			policy: "strict",
			sourceRevision: "git:aaa",
			requirements: [{ id: "R1", text: "works", acceptanceIds: ["A1"] }],
			decisions: [],
			tasks: [{ id: "t1", summary: "do", dependsOn: [], requirementIds: ["R1"], decisionIds: [], acceptanceIds: ["A1"] }],
			acceptance: [{ id: "A1", text: "passes", required: true, evidenceKind: "inspection", checkRef: "C1" }],
			checks: [{ id: "C1", kind: "inspection" }],
		})
		await store.saveRevision(rev)
		await store.recordApproval("demo", { revisionId: rev.revisionId, approvedBy: "user", approvedAt: 1 })
		const out = (await run(rev))[0]
		// An inspection check is never run by the host, so it stays missing and blocks verification.
		expect(out.verdict).toBe("not-verified")
		expect(out.criteria[0]).toMatchObject({ acceptanceId: "A1", state: "missing" })
	})

	it("rejects a dispatch whose trace names a task that is not in the revision", async () => {
		const rev = await revision(0)
		const out = await checkStrictDispatch([{ name: "ghost", specTrace: { specId: "demo", revisionId: rev.revisionId, taskId: "ghost" } }], store)
		expect(out.violations.join(" ")).toContain("not part of revision")
	})

	it("does not run any check when a worker did not complete", async () => {
		const rev = await revision(0)
		for (const tasks of [[{ name: "t1", state: "failed" }], []]) {
			const out = (await run(rev, tasks))[0]
			expect(out.verdict).toBe("failed")
			expect(out.reasons[0]).toMatch(/task t1/)
		}
		expect((await store.readEvidence("demo")).records).toEqual([])
	})

	it("is blocked, not passed, when the sandbox cannot be built, and still cleans up", async () => {
		const rev = await revision(0)
		const out = (await run(rev, undefined, async () => ({ ok: false, reason: "patch for t1 does not apply" })))[0]
		expect(out).toMatchObject({ verdict: "blocked", reasons: ["patch for t1 does not apply"] })
		let cleaned = 0
		await run(rev, undefined, async () => ({ ok: true, dir: root, sourceRevision: "batch:x", cleanup: async () => void cleaned++ }))
		expect(cleaned).toBe(1)
	})

	it("derives fixer attempts from persisted evidence, so a new process continues the count", async () => {
		const rev = await revision(3)
		await run(rev)
		await run(rev)
		// A fresh store over the same directory stands in for a restart: attempts come from the evidence file.
		const reopened = new SpecRevisionStore(path.join(root, SPECS_DIR))
		const third = (await runStrictGate({ revisions: [rev], store: reopened, workspaceRoot: root, manifestPath: "unused", tasks: [{ name: "t1", state: "completed" }], sandbox }))[0]
		expect(third.fixer).toMatchObject({ exhausted: true })
	})
})
