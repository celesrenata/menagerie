import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { AnalysisOutcome, AnalysisRequest, WorkerResult } from "@roo-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { analyzeReaderResults, resolveAnalysisRouteConfig, type AnalysisRunner } from "../AnalysisService"

describe("resolveAnalysisRouteConfig", () => {
	it("requires both a base URL and a model id (fails closed)", () => {
		expect(resolveAnalysisRouteConfig({})).toBeUndefined()
		expect(resolveAnalysisRouteConfig({ MENAGERIE_ANALYSIS_BASE_URL: "http://h/v1" })).toBeUndefined()
		expect(resolveAnalysisRouteConfig({ MENAGERIE_ANALYSIS_MODEL: "m" })).toBeUndefined()
		expect(resolveAnalysisRouteConfig({ MENAGERIE_ANALYSIS_BASE_URL: "ftp://h", MENAGERIE_ANALYSIS_MODEL: "m" })).toBeUndefined()
	})
	it("caps concurrency at the service's two active generations", () => {
		const env = { MENAGERIE_ANALYSIS_BASE_URL: "https://h/v1", MENAGERIE_ANALYSIS_MODEL: "m" }
		expect(resolveAnalysisRouteConfig(env)?.maxActive).toBe(2)
		expect(resolveAnalysisRouteConfig({ ...env, MENAGERIE_ANALYSIS_MAX_ACTIVE: "9" })?.maxActive).toBe(2)
		expect(resolveAnalysisRouteConfig({ ...env, MENAGERIE_ANALYSIS_MAX_ACTIVE: "0" })?.maxActive).toBe(1)
	})
})

describe("analyzeReaderResults", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "analysis-svc-")))
		await fs.mkdir(path.join(root, "src"))
		await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 1\nexport const b = 2\n")
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	const worker = (evidence: WorkerResult["evidence"], status: WorkerResult["status"] = "completed"): WorkerResult => ({
		status,
		summary: "s",
		findings: [],
		evidence,
		changes: [],
		tests: [],
		blockers: [],
		artifacts: [],
	})
	const valid = (r: AnalysisRequest): AnalysisOutcome => ({
		kind: "valid",
		requestId: r.requestId,
		operation: r.operation,
		findings: [{ claim: "exports a and b", anchorIds: [r.evidence[0].anchorId] }],
		unknowns: [],
		digest: "d".repeat(64),
		modelId: "m",
		retried: false,
	})
	const base = { batchId: "b1", workspaceRoot: "", required: false, env: {} }

	it("skips optional analysis with a visible cause when no route is published", async () => {
		const out = await analyzeReaderResults({ ...base, workspaceRoot: root, readers: [{ name: "r", result: worker([]) }] })
		expect(out).toEqual({ status: "skipped", reason: "no analysis route published" })
	})

	it("escalates, never skips, when required analysis has no route", async () => {
		const out = await analyzeReaderResults({ ...base, workspaceRoot: root, required: true, readers: [] })
		expect(out).toMatchObject({ status: "escalate", lane: "reader.deep" })
	})

	it("escalates required analysis when the route is unhealthy", async () => {
		const out = await analyzeReaderResults({ ...base, workspaceRoot: root, required: true, readers: [], routeOverride: { published: true, healthy: false } })
		expect(out).toMatchObject({ status: "escalate", reason: "analysis route unhealthy" })
	})

	it("analyzes a scout's file citation, including an absolute path inside the workspace", async () => {
		const runner: AnalysisRunner = { execute: vi.fn(async (r) => valid(r)) }
		const out = await analyzeReaderResults({
			...base,
			workspaceRoot: root,
			runner,
			readers: [{ name: "r", result: worker([{ type: "file", reference: path.join(root, "src/a.ts"), lines: [1, 2] }]) }],
		})
		expect(out.status).toBe("analyzed")
		expect(runner.execute).toHaveBeenCalledOnce()
		const req = vi.mocked(runner.execute).mock.calls[0][0]
		expect(req.evidence[0].anchor.path).toBe("src/a.ts")
		expect(req.evidence[0].excerpt).toBe("export const a = 1\nexport const b = 2")
		if (out.status === "analyzed") expect(out.items[0]).toMatchObject({ task: "r", status: "valid" })
	})

	it("never calls the executor for invented ranges, paths outside the workspace, or failed readers", async () => {
		const runner: AnalysisRunner = { execute: vi.fn(async (r) => valid(r)) }
		const out = await analyzeReaderResults({
			...base,
			workspaceRoot: root,
			runner,
			readers: [
				{ name: "range", result: worker([{ type: "file", reference: "src/a.ts", lines: [1, 99] }]) },
				{ name: "escape", result: worker([{ type: "file", reference: "../outside.ts", lines: [1, 1] }]) },
				{ name: "failed", result: worker([{ type: "file", reference: "src/a.ts", lines: [1, 1] }], "failed") },
			],
		})
		expect(runner.execute).not.toHaveBeenCalled()
		expect(out).toMatchObject({ status: "analyzed" })
		if (out.status === "analyzed") expect(out.items.map((i) => i.status)).toEqual(["no-file-evidence", "no-file-evidence", "no-file-evidence"])
	})

	it("attaches the existing escalation verdict to a low-confidence item and escalates when required", async () => {
		const lowConfidence = (r: AnalysisRequest): AnalysisOutcome => ({
			...(valid(r) as Extract<AnalysisOutcome, { kind: "valid" }>),
			findings: [{ claim: "maybe", anchorIds: [r.evidence[0].anchorId], confidence: 0.1 }],
		})
		const runner: AnalysisRunner = { execute: vi.fn(async (r) => lowConfidence(r)) }
		const readers = [{ name: "r", result: worker([{ type: "file", reference: "src/a.ts", lines: [1, 1] }]) }]
		const optional = await analyzeReaderResults({ ...base, workspaceRoot: root, runner, readers })
		expect(optional.status).toBe("analyzed")
		if (optional.status === "analyzed") expect(optional.items[0].escalation?.triggers).toContain("low-confidence")
		const required = await analyzeReaderResults({ ...base, workspaceRoot: root, runner, readers, required: true })
		expect(required).toMatchObject({ status: "escalate", lane: "reader.deep" })
	})

	it("turns a runner exception into a visible unavailable item instead of throwing", async () => {
		const runner: AnalysisRunner = { execute: vi.fn(async () => Promise.reject(new Error("boom"))) }
		const out = await analyzeReaderResults({
			...base,
			workspaceRoot: root,
			runner,
			readers: [{ name: "r", result: worker([{ type: "file", reference: "src/a.ts", lines: [1, 1] }]) }],
		})
		expect(out).toMatchObject({ status: "analyzed", items: [{ status: "unavailable" }] })
	})

	it("required analysis with no valid result escalates instead of reading as success", async () => {
		const runner: AnalysisRunner = {
			execute: vi.fn(async (r) => ({ kind: "invalid-schema", requestId: r.requestId, reason: "bad" }) as AnalysisOutcome),
		}
		const out = await analyzeReaderResults({
			...base,
			workspaceRoot: root,
			runner,
			required: true,
			readers: [{ name: "r", result: worker([{ type: "file", reference: "src/a.ts", lines: [1, 1] }]) }],
		})
		expect(out).toMatchObject({ status: "escalate", lane: "reader.deep" })
	})
})
