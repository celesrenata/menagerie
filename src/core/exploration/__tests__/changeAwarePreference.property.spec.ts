// Feature: semantic-first-retrieval, Property 6: A current changed file is not silently outranked by a stale index result

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { applyChangeAwarePreference } from "../changeAwarePreference"
import { createRetrievalMetricsRecorder } from "../retrievalMetricsRecorder"
import type { EvidenceItem } from "../types"
import { evidencePacketArb } from "./arbitraries"

/**
 * Arbitrary set of currently-changed files. Built from a mix of:
 * - a subset of the packet's own item files (exercises present-and-changed), and
 * - extra files that never appear in the packet (exercises changed-but-absent).
 */
const changedFilesArb = (itemFiles: ReadonlyArray<string>): fc.Arbitrary<ReadonlySet<string>> => {
	const fromPacket =
		itemFiles.length === 0
			? fc.constant<string[]>([])
			: fc.subarray([...itemFiles], { minLength: 0, maxLength: itemFiles.length })
	// Extra files are suffixed with ".absent" so they can never collide with a
	// packet file produced by the arbitraries' path pattern.
	const extraFiles = fc.array(
		fc.stringMatching(/^[a-zA-Z0-9_/.-]{1,80}$/).map((s) => `${s}.absent`),
		{ minLength: 0, maxLength: 5 },
	)
	return fc.tuple(fromPacket, extraFiles).map(([present, absent]) => new Set<string>([...present, ...absent]))
}

type Classification = "current" | "neutral" | "stale"

/** Classify an item exactly as the task spec describes. */
function classify(item: EvidenceItem, changedFiles: ReadonlySet<string>): Classification {
	if (item.fresh === true || changedFiles.has(item.file)) {
		return "current"
	}
	if (item.fresh === false && !changedFiles.has(item.file)) {
		return "stale"
	}
	return "neutral"
}

describe("applyChangeAwarePreference — Property 6", () => {
	// Validates: Requirements 12.1, 12.2, 12.4
	it("never ranks a stale item above a current/changed item, honors fresh, and records freshness misses", () => {
		fc.assert(
			fc.property(
				evidencePacketArb.chain((packet) =>
					changedFilesArb(packet.items.map((i) => i.file)).map((changedFiles) => ({ packet, changedFiles })),
				),
				({ packet, changedFiles }) => {
					const metrics = createRetrievalMetricsRecorder()
					const result = applyChangeAwarePreference({ packet, changedFiles }, metrics)

					const ordered = result.orderedItems
					const classes = ordered.map((item) => classify(item, changedFiles))

					// Assertion 1 + 2: no stale item appears before any current item.
					// `fresh === true` is classified current, so honoring the gateway
					// `fresh` signal is covered by this same ordering invariant.
					for (let i = 0; i < classes.length; i++) {
						if (classes[i] !== "stale") {
							continue
						}
						for (let j = i + 1; j < classes.length; j++) {
							expect(classes[j]).not.toBe("current")
						}
					}

					// Ordering must be a permutation of the original items (no loss/dup).
					expect(ordered.length).toBe(packet.items.length)

					// Assertion 3: freshness misses == changed files absent from the packet.
					const filesInPacket = new Set(packet.items.map((i) => i.file))
					let expectedMisses = 0
					for (const file of changedFiles) {
						if (!filesInPacket.has(file)) {
							expectedMisses++
						}
					}

					expect(result.freshnessMisses).toBe(expectedMisses)
					expect(metrics.snapshot().indexFreshnessMisses).toBe(expectedMisses)
				},
			),
			{ numRuns: 200 },
		)
	})
})
