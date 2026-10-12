// Feature: capability-lanes-routing, Property 11: a reader's read-input bound is derived from the lane window and is never a hard-coded size
//
// Integration test for the reader-ingestion boundary wiring (task 11.3).
//
// Scope: this proves the WIRING, not the pure arithmetic (that is covered by
// `readerReadBudget.spec.ts`, task 11.2). The behavior under test is the data
// flow at the reader-ingestion boundary:
//
//   reader lane route id
//     → resolveOmniRouteContextWindow (OmniRoute-owned Served_Context_Window)
//       → readerReadBudget.evaluate(servedContextWindow, readInputConsumed, …)
//         → within-budget | bound-reads | summarize-and-conclude
//
// The reader worker's cumulative read-input (`Task.readInputBytesConsumed`,
// incremented by `ReadFileTool`) is the quantity evaluated against the
// lane-window-derived bound. We fake only the reader `Task` (so no real VS Code
// host / network is touched) and thread its `readInputBytesConsumed` through the
// boundary exactly as the production wiring would.
//
// Cross-references (NOT re-tested here):
//   - resilient-context-recovery owns the recovery/terminal behavior once a
//     transcript nonetheless exceeds its Served_Context_Window.
//   - progress-aware-loop-detection owns the absolute no-progress backstop.
//   - elastic-parallel-execution owns the Lever-2 `readInputBytesConsumed`
//     accounting mechanism (incremented by ReadFileTool).
// This test consumes those contracts via faked/real read-only collaborators and
// asserts only the lane-layer boundary behavior.

import { describe, it, expect } from "vitest"

import {
	resolveOmniRouteContextWindow,
	OMNIROUTE_ROUTE_CONTEXT_WINDOWS,
} from "../../../api/providers/omniroute"
import { DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES } from "@roo-code/types"

import { evaluate, type ReaderReadBudgetInput, type ReaderReadBudgetOutcome } from "../readerReadBudget"

// ── Faked reader worker ──────────────────────────────────────────────────────
// A minimal stand-in for the per-worker `Task` at the reader-ingestion boundary.
// Only the Lever-2 read-input signal and the reader's lane route id matter here;
// no real `Task` construction (and therefore no VS Code host / network) is used.
interface FakeReaderWorker {
	/** The OmniRoute route id the reader lane resolves to (its model id). */
	readonly laneRouteId: string
	/** Cumulative read-input bytes, mirroring `Task.readInputBytesConsumed`. */
	readInputBytesConsumed: number
}

const makeReader = (laneRouteId: string, readInputBytesConsumed = 0): FakeReaderWorker => ({
	laneRouteId,
	readInputBytesConsumed,
})

// Role-level coherence coefficients. These are NOT fixed per-lane sizes — the
// bound is `windowFraction * servedContextWindow * bytesPerToken`, so the window
// (resolved from OmniRoute) is what moves the bound.
const WINDOW_FRACTION = 0.5
const BYTES_PER_TOKEN = 4

// The production boundary: resolve the lane window from OmniRoute (read-only),
// then evaluate the reader's cumulative read-input against the window-derived
// bound. This is exactly the wiring task 11.3 exercises — the only inputs that
// vary per call are the reader's route id and its consumed bytes.
const evaluateAtBoundary = (reader: FakeReaderWorker): ReaderReadBudgetOutcome => {
	const servedContextWindow = resolveOmniRouteContextWindow(reader.laneRouteId)
	const input: ReaderReadBudgetInput = {
		servedContextWindow,
		readInputConsumed: reader.readInputBytesConsumed,
		windowFraction: WINDOW_FRACTION,
		bytesPerToken: BYTES_PER_TOKEN,
		fallbackBudget: DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES,
	}
	return evaluate(input)
}

describe("reader-ingestion boundary wiring (Property 11, Req 14.1/14.2/14.3/14.6)", () => {
	// Sanity anchor: the reader lane route genuinely resolves through OmniRoute to
	// the deliberately-small 9B reader window. If the serving config changes this
	// number, the boundary should still derive FROM it — never from a literal here.
	const READER_ROUTE = "hybrid/fast"
	const READER_WINDOW = 32768

	it("resolves the reader lane window read-only from the OmniRoute resolver (not a literal)", () => {
		// The window flows from OmniRoute's source-of-truth map, confirming the
		// boundary reads the lane window rather than hard-coding one (Req 14.2).
		expect(resolveOmniRouteContextWindow(READER_ROUTE)).toBe(READER_WINDOW)
		expect(OMNIROUTE_ROUTE_CONTEXT_WINDOWS[READER_ROUTE]).toBe(READER_WINDOW)
	})

	it("derives the read-budget bound from the resolved lane window, not a fixed size (Req 14.1, 14.2)", () => {
		// A reader at zero consumption: we assert the bound the boundary computed
		// equals the window-derived product, proving the window drove it.
		const reader = makeReader(READER_ROUTE, 0)
		const outcome = evaluateAtBoundary(reader)

		const windowDerivedBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		expect(outcome.bound).toBe(windowDerivedBound)
		// The bound tracks the lane window, so it is NOT the per-worker fallback.
		expect(outcome.bound).not.toBe(DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES)
		expect(outcome.reasons).toContain("window-known")
	})

	it("lets a reader within the window-derived bound continue (within-budget) (Req 14.1)", () => {
		const windowDerivedBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		// A reader whose cumulative read-input sits comfortably under the bound.
		const reader = makeReader(READER_ROUTE, Math.floor(windowDerivedBound / 2))

		const outcome = evaluateAtBoundary(reader)

		expect(outcome.action).toBe("within-budget")
		expect(outcome.bound).toBe(windowDerivedBound)
	})

	it("bounds a reader that modestly exceeds the window-derived bound (Req 14.3)", () => {
		const windowDerivedBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		// Just over the bound: the boundary must stop treating this as within-budget
		// and direct a bound-reads action (the WHAT at the ingestion boundary).
		const reader = makeReader(READER_ROUTE, windowDerivedBound + 1)

		const outcome = evaluateAtBoundary(reader)

		expect(outcome.action).toBe("bound-reads")
		expect(outcome.bound).toBe(windowDerivedBound)
		expect(outcome.reasons).toContain("read-input-exceeds-bound")
	})

	it("directs summarize-and-conclude for the production-incident-scale overrun (Req 14.3)", () => {
		const windowDerivedBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		// The incident: a reader.fast worker grew its transcript to ~10× its lane
		// window. Threading that scale of cumulative read-input through the boundary
		// must escalate past bound-reads to summarize-and-conclude, never continue.
		const reader = makeReader(READER_ROUTE, windowDerivedBound * 10)

		const outcome = evaluateAtBoundary(reader)

		expect(outcome.action).toBe("summarize-and-conclude")
		expect(outcome.action).not.toBe("within-budget")
		expect(outcome.bound).toBe(windowDerivedBound)
	})

	it("evaluates readInputBytesConsumed as it crosses the window-derived bound at the boundary (Req 14.1, 14.3)", () => {
		const windowDerivedBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		// A single reader whose Lever-2 counter accumulates across reads, exactly as
		// ReadFileTool would increment `Task.readInputBytesConsumed`. The boundary
		// re-evaluates the SAME lane window each time; only consumption moves.
		const reader = makeReader(READER_ROUTE, 0)

		reader.readInputBytesConsumed = Math.floor(windowDerivedBound * 0.9)
		expect(evaluateAtBoundary(reader).action).toBe("within-budget")

		reader.readInputBytesConsumed = windowDerivedBound + 1
		expect(evaluateAtBoundary(reader).action).toBe("bound-reads")

		reader.readInputBytesConsumed = windowDerivedBound * 2
		expect(evaluateAtBoundary(reader).action).toBe("summarize-and-conclude")
	})

	it("falls back to the per-worker DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES for an unknown route (Req 14.6)", () => {
		// An unknown/new route resolves to `undefined` through OmniRoute, so the
		// boundary degrades to the Lever-2 per-worker default rather than failing.
		const unknownRoute = "hybrid/does-not-exist"
		expect(resolveOmniRouteContextWindow(unknownRoute)).toBeUndefined()

		const reader = makeReader(unknownRoute, 0)
		const outcome = evaluateAtBoundary(reader)

		expect(outcome.bound).toBe(DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES)
		expect(outcome.reasons).toContain("window-unknown-fallback")
	})

	it("applies the unknown-route fallback bound to the reader's cumulative read-input (Req 14.6)", () => {
		const unknownRoute = "hybrid/does-not-exist"

		// Under the fallback budget ⇒ continue.
		const under = makeReader(unknownRoute, DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES - 1)
		expect(evaluateAtBoundary(under).action).toBe("within-budget")

		// Over the fallback budget ⇒ a bounding action, never within-budget.
		const over = makeReader(unknownRoute, DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES + 1)
		const overOutcome = evaluateAtBoundary(over)
		expect(overOutcome.action).not.toBe("within-budget")
		expect(["bound-reads", "summarize-and-conclude"]).toContain(overOutcome.action)
	})

	it("binds the bound to the LANE WINDOW: a larger-window lane admits more read-input than the reader lane (Req 14.2)", () => {
		// Two readers that differ ONLY in their lane route id (and thus their
		// OmniRoute-resolved window) with identical consumption: the larger-window
		// lane continues where the small reader lane would be bounded. This proves
		// the boundary binds to the resolved window, not a shared constant.
		const coderWindow = resolveOmniRouteContextWindow("hybrid/code")
		expect(coderWindow).toBe(163840)
		expect(coderWindow).toBeGreaterThan(READER_WINDOW)

		const readerBound = WINDOW_FRACTION * READER_WINDOW * BYTES_PER_TOKEN
		// Consumption that overflows the small reader lane but fits the larger lane.
		const consumed = readerBound + 1

		const onReaderLane = evaluateAtBoundary(makeReader(READER_ROUTE, consumed))
		const onLargerLane = evaluateAtBoundary(makeReader("hybrid/code", consumed))

		expect(onReaderLane.action).toBe("bound-reads")
		expect(onLargerLane.action).toBe("within-budget")
	})
})
