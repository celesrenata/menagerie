import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ObservedTask, SpecStatusSummary } from "@roo-code/types"
import { beforeEach, describe, expect, it } from "vitest"

import { computeMastermindSummary } from "../aggregation"
import { ObservatoryMessageRouter } from "../ObservatoryMessageRouter"
import { clearSpecStatusForTests, getSpecStatus, loadPersistedSpecStatus, persistSpecStatus, setSpecStatus } from "../specStatusRegistry"
import { analysisMetricsSnapshot, recordAnalysisEscalation, recordAnalysisEvent, resetAnalysisMetricsForTests } from "../../analysis/analysisMetrics"

const status = (specId: string): SpecStatusSummary => ({
	specId,
	revisionId: `sha256:${"0".repeat(64)}`,
	phase: "verified",
	verdict: "pass",
	requirementsCovered: "1/1",
	reasons: [],
	updatedAt: 1,
})

describe("spec status in the Mastermind summary", () => {
	beforeEach(() => {
		clearSpecStatusForTests()
		resetAnalysisMetricsForTests()
	})

	it("leaves the summary byte-identical when there is no spec status", () => {
		const workers: ObservedTask[] = []
		expect(computeMastermindSummary("p", workers)).toEqual(computeMastermindSummary("p", workers, undefined))
		expect(computeMastermindSummary("p", workers, [])).not.toHaveProperty("spec")
	})

	it("adds spec status when present, per parent task", () => {
		setSpecStatus("p1", [status("a")])
		expect(computeMastermindSummary("p1", [], getSpecStatus("p1")).spec?.[0].specId).toBe("a")
		expect(getSpecStatus("p2")).toBeUndefined()
	})

	it("bounds the registry and evicts the oldest parent", () => {
		for (let i = 0; i < 70; i++) setSpecStatus(`p${i}`, [status("s")])
		expect(getSpecStatus("p0")).toBeUndefined()
		expect(getSpecStatus("p69")).toBeDefined()
	})
})

describe("analysis metrics", () => {
	beforeEach(() => resetAnalysisMetricsForTests())
	it("counts requests, cache hits, retries, tokens and outcomes from events only", () => {
		recordAnalysisEvent({ type: "cache-hit", requestId: "a" })
		recordAnalysisEvent({ type: "attempt-failed", requestId: "b", attempt: 1, kind: "non-json", reason: "x" })
		recordAnalysisEvent({ type: "completed", requestId: "b", kind: "valid", attempts: 2, promptTokens: 10, completionTokens: 5, suppressedFindings: 0 })
		recordAnalysisEvent({ type: "completed", requestId: "c", kind: "timeout", attempts: 1, suppressedFindings: 0 })
		recordAnalysisEscalation()
		expect(analysisMetricsSnapshot({ active: 2, waiting: 1 })).toEqual({
			requests: 2,
			cacheHits: 1,
			retries: 1,
			outcomes: { valid: 1, timeout: 1 },
			promptTokens: 10,
			completionTokens: 5,
			escalations: 1,
			queueActive: 2,
			queueWaiting: 1,
			queueWaitMsAvg: 0,
			queueWaitMsMax: 0,
			latencyMsAvg: 0,
			latencyMsMax: 0,
		})
		recordAnalysisEvent({ type: "completed", requestId: "d", kind: "valid", attempts: 1, suppressedFindings: 0, queueWaitMs: 100, latencyMs: 400 })
		recordAnalysisEvent({ type: "completed", requestId: "e", kind: "valid", attempts: 1, suppressedFindings: 0, queueWaitMs: 300, latencyMs: 800 })
		expect(analysisMetricsSnapshot({ active: 0, waiting: 0 })).toMatchObject({ queueWaitMsAvg: 200, queueWaitMsMax: 300, latencyMsAvg: 600, latencyMsMax: 800 })
	})
})

describe("spec status survives a restart", () => {
	it("persists the last gate summary and reads it back without the in-memory cache", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spec-status-"))
		try {
			await persistSpecStatus(root, "parent/../1", [status("a")])
			clearSpecStatusForTests() // a new process
			expect((await loadPersistedSpecStatus(root, "parent/../1"))?.[0].specId).toBe("a")
			expect(await loadPersistedSpecStatus(root, "other")).toBeUndefined()
			// the file lives in a dot directory that can never be mistaken for a spec id
			expect(await fs.readdir(path.join(root, ".kiro/specs/.status"))).toHaveLength(1)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("ignores a corrupt status file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spec-status-"))
		try {
			await fs.mkdir(path.join(root, ".kiro/specs/.status"), { recursive: true })
			await fs.writeFile(path.join(root, ".kiro/specs/.status/p.json"), "{nope")
			expect(await loadPersistedSpecStatus(root, "p")).toBeUndefined()
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("the Observatory shows the persisted status for a parent task after a restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spec-status-"))
		try {
			clearSpecStatusForTests()
			await persistSpecStatus(root, "parent-1", [status("restored")])
			const posted: Array<{ type: string; observatory?: { summary?: { spec?: SpecStatusSummary[] } } }> = []
			const parent = { taskId: "parent-1", cwd: root, parallelParentTaskId: undefined, parentTaskId: undefined, clineMessages: [] }
			const router = new ObservatoryMessageRouter({
				service: { reconcile: vi.fn(), getEventWindow: vi.fn() } as never,
				provider: { postMessageToWebview: async (m: never) => void posted.push(m) } as never,
				getAllInstances: () => [{ getCurrentTask: () => parent, taskHistoryStore: { get: () => undefined } }] as never,
				parallelTasksDir: root,
			})
			await router.handle({ type: "observatoryRequestMastermind", observatory: { kind: "requestMastermind", parentTaskId: "parent-1" } } as never)
			expect(posted.at(-1)?.observatory?.summary?.spec?.[0].specId).toBe("restored")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
