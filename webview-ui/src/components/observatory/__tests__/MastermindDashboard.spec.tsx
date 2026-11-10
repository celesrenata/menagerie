import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { MastermindSummary, SpecStatusSummary } from "@roo-code/types"

import { MastermindDashboard } from "../MastermindDashboard"

const summary = (spec?: SpecStatusSummary[]): MastermindSummary => ({
	parentTaskId: "parent-123456",
	workerCounts: { queued: 0, working: 1, streaming: 0, waiting: 0, completed: 2, failed: 0, cancelled: 0 },
	laneStatus: [],
	contextPercent: null,
	tierCeiling: null,
	artifacts: [],
	blockers: [],
	...(spec ? { spec } : {}),
})

const spec: SpecStatusSummary = {
	specId: "demo",
	revisionId: `sha256:${"ab".repeat(32)}`,
	phase: "not-verified",
	verdict: "not-verified",
	requirementsCovered: "2/3",
	reasons: ["A3: missing (no evidence recorded for this criterion)"],
	criteria: [
		{ acceptanceId: "A1", required: true, state: "pass", reason: "fresh passing artifact" },
		{ acceptanceId: "A3", required: true, state: "stale", reason: "evidence predates the current source" },
	],
	fixer: { attempt: 1, maxAttempts: 2, exhausted: false, links: [{ acceptanceId: "A3", requirementIds: ["R3"], priorCheckRunIds: [] }] },
	updatedAt: 1,
	analysis: {
		requests: 4,
		cacheHits: 1,
		retries: 1,
		outcomes: { valid: 3 },
		promptTokens: 100,
		completionTokens: 20,
		escalations: 1,
		queueActive: 2,
		queueWaiting: 3,
		queueWaitMsAvg: 120,
		queueWaitMsMax: 900,
		latencyMsAvg: 700,
		latencyMsMax: 2100,
	},
}

describe("MastermindDashboard spec status", () => {
	it("renders nothing spec-related when the summary has no spec block (legacy behaviour)", () => {
		const { queryByTestId } = render(<MastermindDashboard summary={summary()} />)
		expect(queryByTestId("observatory-spec-status")).toBeNull()
	})

	it("shows revision, phase, requirements covered, blocked criteria and analysis queue pressure", () => {
		const { getByTestId, getByText } = render(<MastermindDashboard summary={summary([spec])} />)
		expect(getByTestId("observatory-spec-phase").textContent).toBe("not-verified")
		expect(getByTestId("observatory-spec-coverage").textContent).toBe("2/3")
		expect(getByText(/A3: missing/)).toBeTruthy()
		expect(getByTestId("observatory-analysis-metrics").textContent).toContain("queue 2 active / 3 waiting")
		expect(getByTestId("observatory-spec-status").textContent).toContain("rev abababab")
	})

	it("lists each criterion's state, fixer advice and queue timing", () => {
		const { getByTestId } = render(<MastermindDashboard summary={summary([spec])} />)
		expect(getByTestId("observatory-criterion-A1").textContent).toBe("A1: pass")
		expect(getByTestId("observatory-criterion-A3").textContent).toBe("A3: stale")
		expect(getByTestId("observatory-spec-fixer").textContent).toContain("attempt 1/2 for A3")
		expect(getByTestId("observatory-analysis-metrics").textContent).toContain("wait avg 120ms (max 900)")
	})

	it("says so when fixer attempts are exhausted", () => {
		const exhausted = { ...spec, fixer: { ...spec.fixer!, exhausted: true } }
		const { getByTestId } = render(<MastermindDashboard summary={summary([exhausted])} />)
		expect(getByTestId("observatory-spec-fixer").textContent).toContain("exhausted")
	})

	it("is read-only: it renders no buttons or interactive controls", () => {
		const { container } = render(<MastermindDashboard summary={summary([spec])} />)
		expect(container.querySelectorAll("button, input, select, a").length).toBe(0)
	})
})
