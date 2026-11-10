import type { SpecApproval } from "@roo-code/types"

import { TaskDag } from "../../task/TaskDag"
import { compileSpec, isSafeWorkspacePath } from "../SpecCompiler"
import { computeRevisionId, sealRevision, verifyRevisionId } from "../specRevision"
import { validateSpecGraph } from "../SpecTraceability"
import { baseContent, baseRevision } from "./specFixtures"

const approve = (revisionId: string): SpecApproval => ({ revisionId, approvedBy: "user", approvedAt: 1 })
const codes = (r: ReturnType<typeof compileSpec>) => (r.ok ? [] : r.issues.map((i) => i.code))

describe("specRevision", () => {
	it("derives a stable id from content and detects tampering", () => {
		const a = baseRevision()
		expect(a.revisionId).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(baseRevision().revisionId).toBe(a.revisionId)
		expect(verifyRevisionId(a)).toBe(true)
		expect(verifyRevisionId({ ...a, requirements: [{ ...a.requirements[0], text: "changed" }, ...a.requirements.slice(1)] })).toBe(false)
		expect(computeRevisionId({ ...baseContent(), policy: "build" } as never)).not.toBe(a.revisionId)
	})

	it("rejects ids that could escape or collide as paths/keys", () => {
		expect(() => sealRevision(baseContent({ specId: "../etc" }))).toThrow()
	})
})

describe("validateSpecGraph", () => {
	it("accepts the fixture", () => {
		expect(validateSpecGraph(baseRevision())).toEqual([])
	})

	it("reports duplicate ids, missing references, kind mismatch and missing commands", () => {
		const c = baseContent()
		const rev = sealRevision({
			...c,
			tasks: [...c.tasks, { ...c.tasks[0] }],
			acceptance: [{ ...c.acceptance[0], checkRef: "NOPE" }, { ...c.acceptance[1], evidenceKind: "lint" }, c.acceptance[2]],
			checks: [c.checks[0], c.checks[1], { id: "C3", kind: "test" }],
		})
		const found = new Set(validateSpecGraph(rev).map((i) => i.code))
		for (const code of ["duplicate-id", "missing-reference", "check-kind-mismatch", "check-missing-command"]) {
			expect(found.has(code as never), code).toBe(true)
		}
	})

	it("flags uncovered required acceptance, orphan acceptance and tasks claiming foreign criteria", () => {
		const c = baseContent()
		const rev = sealRevision({
			...c,
			tasks: [c.tasks[0], { ...c.tasks[1], acceptanceIds: ["A1"] }], // t2 claims A1 (owned by R1), A2/A3 uncovered
			requirements: [c.requirements[0], c.requirements[1]], // A3 now orphan
		})
		const found = new Set(validateSpecGraph(rev).map((i) => i.code))
		expect(found.has("acceptance-outside-task-requirements")).toBe(true)
		expect(found.has("uncovered-required-acceptance")).toBe(true)
		expect(found.has("orphan-acceptance")).toBe(true)
	})
})

describe("compileSpec", () => {
	it("compiles an approved strict spec into the EXISTING plan shape, acyclic via TaskDag", () => {
		const rev = baseRevision()
		const result = compileSpec(rev, { approval: approve(rev.revisionId) })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.plan.tasks.map((t) => t.name)).toEqual(["t1", "t2", "t3"])
		expect(result.plan.dependencies).toEqual([{ dependent: "t2", dependsOn: ["t1"] }])
		expect(result.taskSpecs[1].specTrace).toMatchObject({ specId: "demo", revisionId: rev.revisionId, taskId: "t2", acceptanceIds: ["A2"] })
		expect(result.taskSpecs[0].message).toContain("run: pnpm test session")
		const dag = new TaskDag(result.plan)
		expect(dag.isRunnable("t1")).toBe(true)
		expect(dag.isRunnable("t3")).toBe(true)
		expect(dag.isRunnable("t2")).toBe(false)
		expect(dag.unlockedBy("t1")).toEqual(["t2"])
	})

	it("is deterministic", () => {
		const rev = baseRevision()
		const a = compileSpec(rev, { approval: approve(rev.revisionId) })
		const b = compileSpec(rev, { approval: approve(rev.revisionId) })
		expect(JSON.stringify(a)).toBe(JSON.stringify(b))
	})

	it("refuses a strict spec without approval of EXACTLY this revision", () => {
		const rev = baseRevision()
		expect(codes(compileSpec(rev))).toContain("unapproved-revision")
		expect(codes(compileSpec(rev, { approval: approve("sha256:" + "0".repeat(64)) }))).toContain("unapproved-revision")
		expect(codes(compileSpec(rev, { approval: { ...approve(rev.revisionId), approvedBy: "model" as never } }))).toContain("unapproved-revision")
	})

	it("build policy needs no approval and tolerates coverage gaps, but not structural errors", () => {
		const c = baseContent({ policy: "build" })
		const gap = sealRevision({ ...c, tasks: c.tasks.slice(0, 2) }) // A3 uncovered
		expect(compileSpec(gap).ok).toBe(true)
		const broken = sealRevision({ ...c, tasks: [{ ...c.tasks[0], dependsOn: ["ghost"] }, ...c.tasks.slice(1)] })
		expect(codes(compileSpec(broken))).toContain("missing-reference")
	})

	it("explore compiles no work", () => {
		expect(codes(compileSpec(baseRevision({ policy: "explore" })))).toEqual(["policy-explore-has-no-tasks"])
	})

	it("rejects a three-task dependency cycle before dispatch (acceptance demo 4)", () => {
		const c = baseContent({ policy: "build" })
		const cyc = sealRevision({
			...c,
			tasks: [
				{ ...c.tasks[0], dependsOn: ["t3"] },
				{ ...c.tasks[1], dependsOn: ["t1"] },
				{ ...c.tasks[2], dependsOn: ["t2"] },
			],
		})
		const r = compileSpec(cyc)
		expect(codes(r)).toEqual(["dependency-cycle"])
		if (!r.ok) expect(r.issues[0].message).toMatch(/cycle/)
	})

	it("rejects unordered overlapping writers but allows ordered ones", () => {
		const c = baseContent({ policy: "build" })
		const clash = sealRevision({ ...c, tasks: [{ ...c.tasks[0], filesWrite: ["src"] }, { ...c.tasks[2], filesWrite: ["src/ratelimit.ts"] }, c.tasks[1]] })
		expect(codes(compileSpec(clash))).toContain("write-collision")
		const ordered = sealRevision({ ...c, tasks: [{ ...c.tasks[0], filesWrite: ["src/x.ts"] }, { ...c.tasks[1], filesWrite: ["src/x.ts"] }, c.tasks[2]] })
		expect(compileSpec(ordered).ok).toBe(true)
	})

	it("rejects tampered content and unsafe paths", () => {
		const rev = baseRevision()
		const tampered = { ...rev, sourceRevision: "git:evil" }
		expect(codes(compileSpec(tampered, { approval: approve(rev.revisionId) }))).toEqual(["revision-id-mismatch"])
		const c = baseContent({ policy: "build" })
		const unsafe = sealRevision({ ...c, tasks: [{ ...c.tasks[0], filesWrite: ["../../etc/passwd"] }, ...c.tasks.slice(1)] })
		expect(codes(compileSpec(unsafe))).toContain("unsafe-path")
		expect(isSafeWorkspacePath("src/a.ts")).toBe(true)
		expect(isSafeWorkspacePath("/abs")).toBe(false)
	})
})
