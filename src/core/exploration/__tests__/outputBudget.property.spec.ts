// Feature: semantic-first-retrieval, Property 5: The consumed packet is bounded and the parent context never receives the full candidate set

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { createRetrievalOutputBudget } from "../retrievalOutputBudget"
import { MAX_EVIDENCE_PACKET_ITEMS } from "../types"
import { evidencePacketArb, overBoundEvidencePacketArb } from "./arbitraries"

const SURFACED_KEYS = ["endLine", "file", "reason", "score", "startLine"] as const

describe("RetrievalOutputBudget.surfaceToParent — Property 5", () => {
	// Validates: Requirements 6.1, 6.2, 6.3, 8.2, 10.2
	it("bounds surfaced items and exposes only compact fields, never snippets or the full set", () => {
		fc.assert(
			fc.property(evidencePacketArb, (packet) => {
				const budget = createRetrievalOutputBudget()
				const surfaced = budget.surfaceToParent(packet)

				// Bounded to the max (Req 8.2) and never larger than the source set.
				expect(surfaced.length).toBeLessThanOrEqual(MAX_EVIDENCE_PACKET_ITEMS)
				expect(surfaced.length).toBeLessThanOrEqual(packet.items.length)

				for (const entry of surfaced) {
					// Only compact fields leak to the parent — no snippet/large chunk (Req 6.2, 6.3).
					expect(Object.keys(entry).sort()).toEqual([...SURFACED_KEYS])
					// Reason is a single line (Req 6.1, 10.2).
					expect(entry.reason.includes("\n")).toBe(false)
				}
			}),
			{ numRuns: 200 },
		)
	})

	// Validates: Requirements 6.2, 8.2
	it("truncates to exactly MAX_EVIDENCE_PACKET_ITEMS when the packet exceeds the bound", () => {
		fc.assert(
			fc.property(overBoundEvidencePacketArb, (packet) => {
				const budget = createRetrievalOutputBudget()
				const surfaced = budget.surfaceToParent(packet)

				expect(surfaced.length).toBe(MAX_EVIDENCE_PACKET_ITEMS)

				for (const entry of surfaced) {
					expect(Object.keys(entry).sort()).toEqual([...SURFACED_KEYS])
					expect(entry.reason.includes("\n")).toBe(false)
				}
			}),
			{ numRuns: 200 },
		)
	})
})
