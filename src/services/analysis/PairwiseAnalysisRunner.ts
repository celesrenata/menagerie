import type { AnalysisFinding, AnalysisOutcome, AnalysisRequest, AnalysisValidOutcome } from "@roo-code/types"

import { analysisDigest } from "./analysisDigest"

/**
 * Contradiction detection by pairs and votes (MEN-GRANITE-SDD-001 R4, quality work).
 *
 * "Scan everything and list conflicts" is the weakest thing an 8B model is asked to do. This
 * runner instead asks a narrow, normalized question about each pair of evidence items and
 * takes a majority of independent votes, so one bad sample cannot decide a pair. Every
 * individual vote goes through the normal executor (schema, citations, freshness, queue,
 * quarantine); this class only schedules pairs and counts. Other operations pass straight through.
 */
export interface AnalysisRunner {
	execute(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisOutcome>
}

export interface PairwiseOptions {
	/** Independent votes per pair. */
	votes: number
	/**
	 * Positive votes needed to report a pair. Defaults to 1 ("any vote"), a deliberately
	 * recall-oriented setting: a missed contradiction is silent, while a reported one only
	 * escalates to a stronger model. Measured on the golden set (see quality doc), single votes
	 * flag real conflicts ~45% of the time and non-conflicts 0 of 36, so a majority threshold
	 * discards real conflicts. At least a majority of votes must still be VALID.
	 */
	minPositive?: number
	/** Hard cap on evidence items considered in pair mode (pairs grow quadratically). */
	maxItems: number
	/** Digest runtime, to keep the aggregate digest Menagerie-derived. */
	modelId: string
	templateVersion: string
}

export const DEFAULT_PAIRWISE_OPTIONS = { votes: 3, maxItems: 6, minPositive: 1 } as const

export class PairwiseAnalysisRunner implements AnalysisRunner {
	constructor(
		private readonly inner: AnalysisRunner,
		private readonly options: PairwiseOptions,
	) {}

	async execute(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisOutcome> {
		if (request.operation !== "find-contradictions" || request.evidence.length < 2) {
			return this.inner.execute(request, signal)
		}
		if (request.evidence.length > this.options.maxItems) {
			return { kind: "oversize", requestId: request.requestId, reason: `pair mode supports at most ${this.options.maxItems} evidence items` }
		}

		const pairs: Array<[number, number]> = []
		for (let i = 0; i < request.evidence.length; i++) for (let j = i + 1; j < request.evidence.length; j++) pairs.push([i, j])

		const results = await Promise.all(
			pairs.map(async ([i, j]) => {
				const evidence = [request.evidence[i], request.evidence[j]]
				const votes = await Promise.all(
					Array.from({ length: this.options.votes }, (_, sample) =>
						this.inner.execute({ ...request, requestId: `${request.requestId}:p${i}-${j}:v${sample}`, sample, evidence }, signal),
					),
				)
				return { evidence, votes }
			}),
		)

		// A pair that failed for an INFRASTRUCTURE reason on every vote fails the whole call: do not guess.
		const allFailed = results.flatMap((r) => r.votes).every((v) => v.kind !== "valid")
		if (allFailed) return results[0].votes[0]
		const cancelled = results.flatMap((r) => r.votes).find((v) => v.kind === "cancelled" || v.kind === "timeout")
		if (cancelled && cancelled.kind !== "valid") return { ...cancelled, requestId: request.requestId }

		const need = Math.floor(this.options.votes / 2) + 1
		const findings: AnalysisFinding[] = []
		const unknowns: string[] = []
		let retried = false
		for (const { evidence, votes } of results) {
			const valid = votes.filter((v): v is AnalysisValidOutcome => v.kind === "valid")
			retried ||= valid.some((v) => v.retried)
			const positive = valid.filter((v) => v.findings.length > 0)
			const ids = evidence.map((e) => e.anchorId)
			if (valid.length < need) {
				unknowns.push(`pair ${ids.join("/")} undecided: only ${valid.length} of ${this.options.votes} votes were valid`)
			} else if (positive.length >= Math.max(1, this.options.minPositive ?? 1)) {
				const first = positive[0].findings[0]
				findings.push({ claim: first.claim, anchorIds: ids, confidence: positive.length / valid.length })
			}
		}

		return {
			kind: "valid",
			requestId: request.requestId,
			operation: "find-contradictions",
			findings,
			unknowns: unknowns.slice(0, 16),
			digest: analysisDigest(request, { modelId: this.options.modelId, templateVersion: this.options.templateVersion }),
			modelId: this.options.modelId,
			retried,
		}
	}
}
