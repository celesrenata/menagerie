import { describe, it, expect } from "vitest"
import { createRetrievalMetricsRecorder } from "../retrievalMetricsRecorder"

/**
 * Example-based tests for the per-task `createRetrievalMetricsRecorder`.
 *
 * Asserts counters are monotonic and derived ratios stay in [0,1], including
 * the zero-query edge (no division by zero).
 *
 * Requirements traced: 7.2, 7.9
 */
describe("createRetrievalMetricsRecorder", () => {
	it("keeps counters monotonic across repeated recording (Req 7.2, 7.9)", () => {
		const recorder = createRetrievalMetricsRecorder()

		recorder.recordSemanticQuery()
		recorder.recordSemanticQuery()
		recorder.recordFileOpened()
		recorder.recordRawRead(false)
		recorder.recordRawRead(true)
		recorder.recordRawRead(false)
		recorder.recordQueriesReused()
		recorder.recordIndexUnavailable()
		recorder.recordGatewayUnavailable()
		recorder.recordGatewayUnavailable()
		recorder.recordIndexFreshnessMiss()

		const first = recorder.snapshot()
		expect(first.semanticQueries).toBe(2)
		expect(first.filesOpened).toBe(1)
		expect(first.rawReads).toBe(3)
		expect(first.queriesReused).toBe(1)
		expect(first.indexUnavailableEvents).toBe(1)
		expect(first.gatewayUnavailableEvents).toBe(2)
		expect(first.indexFreshnessMisses).toBe(1)

		// Record again; every counter may only increase.
		recorder.recordSemanticQuery()
		recorder.recordFileOpened()
		recorder.recordRawRead(false)
		recorder.recordQueriesReused()
		recorder.recordIndexUnavailable()
		recorder.recordGatewayUnavailable()
		recorder.recordIndexFreshnessMiss()

		const second = recorder.snapshot()
		expect(second.semanticQueries).toBeGreaterThan(first.semanticQueries)
		expect(second.filesOpened).toBeGreaterThan(first.filesOpened)
		expect(second.rawReads).toBeGreaterThan(first.rawReads)
		expect(second.queriesReused).toBeGreaterThan(first.queriesReused)
		expect(second.indexUnavailableEvents).toBeGreaterThan(first.indexUnavailableEvents)
		expect(second.gatewayUnavailableEvents).toBeGreaterThan(first.gatewayUnavailableEvents)
		expect(second.indexFreshnessMisses).toBeGreaterThan(first.indexFreshnessMisses)
	})

	it("computes semanticHitRate and pctRawReadsPrecededByUsefulHit within [0,1] (Req 7.2, 7.9)", () => {
		const recorder = createRetrievalMetricsRecorder()

		// 4 semantic queries, 2 useful hits => hit rate 0.5.
		recorder.recordSemanticQuery()
		recorder.recordSemanticQuery()
		recorder.recordSemanticQuery()
		recorder.recordSemanticQuery()
		recorder.recordUsefulHit()
		recorder.recordUsefulHit()

		// 5 raw reads, 3 preceded by a useful hit => 0.6.
		recorder.recordRawRead(true)
		recorder.recordRawRead(true)
		recorder.recordRawRead(true)
		recorder.recordRawRead(false)
		recorder.recordRawRead(false)

		const snapshot = recorder.snapshot()
		expect(snapshot.semanticHitRate).toBe(0.5)
		expect(snapshot.semanticHitRate).toBeGreaterThanOrEqual(0)
		expect(snapshot.semanticHitRate).toBeLessThanOrEqual(1)

		expect(snapshot.pctRawReadsPrecededByUsefulHit).toBeCloseTo(0.6, 10)
		expect(snapshot.pctRawReadsPrecededByUsefulHit).toBeGreaterThanOrEqual(0)
		expect(snapshot.pctRawReadsPrecededByUsefulHit).toBeLessThanOrEqual(1)
	})

	it("returns 0 for both ratios on a fresh recorder with no division by zero (Req 7.2, 7.9)", () => {
		const snapshot = createRetrievalMetricsRecorder().snapshot()
		expect(snapshot.semanticHitRate).toBe(0)
		expect(snapshot.pctRawReadsPrecededByUsefulHit).toBe(0)
	})

	it("accumulates recordFilesReturned and treats negative/NaN as 0", () => {
		const recorder = createRetrievalMetricsRecorder()

		recorder.recordFilesReturned(3)
		recorder.recordFilesReturned(5)
		expect(recorder.snapshot().filesReturned).toBe(8)

		recorder.recordFilesReturned(-4)
		recorder.recordFilesReturned(Number.NaN)
		expect(recorder.snapshot().filesReturned).toBe(8)
	})

	it("honors only the first markFirstUsefulEvidence call", () => {
		const createdAt = 1_000_000
		const recorder = createRetrievalMetricsRecorder(createdAt)

		recorder.markFirstUsefulEvidence(createdAt + 100)
		recorder.markFirstUsefulEvidence(createdAt + 999)

		expect(recorder.snapshot().timeToFirstUsefulEvidenceMs).toBe(100)
	})

	it("leaves timeToFirstUsefulEvidenceMs undefined until marked", () => {
		const snapshot = createRetrievalMetricsRecorder().snapshot()
		expect(snapshot.timeToFirstUsefulEvidenceMs).toBeUndefined()
	})
})
