// Feature: retrieval-fabric
//
// Evaluation harness (Requirements 16.1-16.3, 20.1-20.5).
//
// A runnable decision tool — NOT a unit-test gate — that scores a configurable
// retrieval backend over real Menagerie / NerveCenter `EvalCase`s. It compares
// the five retrieval configurations (`vector-only`, `lexical-only`, `hybrid`,
// `hybrid+reranker-0.6b`, `hybrid+reranker-4b`) and sweeps the Matryoshka
// stored dimensions (256 / 512 / 768 / 1024) by retrieval quality rather than
// vector size alone (Req 16.1, 16.2, 20.4).
//
// The harness never requires a live cluster: the retrieval backend is injected
// via a `RetrieverFactory`, so a caller can wire a real OVMS/Qdrant-backed
// retriever on demand, or a fixture retriever for a smoke test. The harness
// itself is pure orchestration over whatever ranked results the injected
// retriever returns.

import type { EvalCase, EvalConfig, EvalResult } from "../sizing-types"

/**
 * A single ranked retrieval result produced by an injected {@link Retriever}.
 *
 * The identity used for scoring is the workspace-relative `file`; the optional
 * `symbol` / `startLine` / `endLine` let the harness credit symbol- and
 * range-level expectations where the backend reports them. `score` is carried
 * through for diagnostics but ranking is positional (results are assumed
 * ordered best-first).
 */
export interface RankedResult {
	/** Workspace-relative file path of the retrieved candidate. */
	file: string
	/** Optional symbol name the candidate resolves to. */
	symbol?: string
	/** Optional 1-based inclusive start line of the candidate range. */
	startLine?: number
	/** Optional 1-based inclusive end line of the candidate range. */
	endLine?: number
	/** Backend relevance score (higher is more relevant); diagnostic only. */
	score?: number
}

/**
 * The Matryoshka stored dimensions the harness sweeps (Req 16.1, 20.4). Narrowed
 * to the union {@link EvalResult.dimension} accepts.
 */
export type EvalDimension = EvalResult["dimension"]

/** The full set of Matryoshka dimensions swept by default (Req 16.1). */
export const EVAL_DIMENSIONS: readonly EvalDimension[] = [256, 512, 768, 1024]

/** The full set of retrieval configurations compared by default (Req 20.4). */
export const EVAL_CONFIGS: readonly EvalConfig[] = [
	"vector-only",
	"lexical-only",
	"hybrid",
	"hybrid+reranker-0.6b",
	"hybrid+reranker-4b",
]

/**
 * A configurable retrieval backend injected into the harness.
 *
 * Each `retrieve` call runs one {@link EvalCase} query under a fixed
 * configuration and stored dimension (the pair the factory was built for) and
 * returns a ranked list of candidates, best-first. Implementations may be
 * backed by a live OVMS/Qdrant fabric or by a fixture; the harness does not
 * care and never selects a node or replica.
 */
export interface Retriever {
	/**
	 * Retrieve ranked candidates for a case's query.
	 *
	 * @param evalCase The case being scored (query plus expectations).
	 * @returns Ranked candidates, best-first. May be empty.
	 */
	retrieve(evalCase: EvalCase): Promise<RankedResult[]>
}

/**
 * Builds a {@link Retriever} bound to a specific `(config, dimension)` pair.
 *
 * Injecting a factory (rather than a single retriever) lets the harness sweep
 * every configuration and dimension against a backend configured for that exact
 * combination, without the harness knowing how the backend is wired.
 */
export type RetrieverFactory = (config: EvalConfig, dimension: EvalDimension) => Retriever

/** Rank cutoffs the harness scores at (Req 20.3). */
const RECALL_AT_30 = 30
const RECALL_AT_10 = 10
const RANK_AT_5 = 5

/**
 * Normalize a path for comparison so expectations and results match regardless
 * of leading `./` or surrounding whitespace. Purely lexical; no filesystem I/O.
 */
function normalizeFile(file: string): string {
	return file.trim().replace(/^\.\//, "")
}

/**
 * Whether a ranked result satisfies an expected symbol/range entry.
 *
 * The file must match. A `symbol` expectation is satisfied when the result
 * reports the same symbol. A line-range expectation is satisfied when the
 * result's range overlaps the expected `[startLine, endLine]`. An expectation
 * carrying only a file is satisfied by any result in that file.
 */
function resultSatisfiesExpectation(
	result: RankedResult,
	expectation: EvalCase["expectedSymbolsOrRanges"][number],
): boolean {
	if (normalizeFile(result.file) !== normalizeFile(expectation.file)) {
		return false
	}

	if (expectation.symbol !== undefined) {
		return result.symbol === expectation.symbol
	}

	if (expectation.startLine !== undefined && expectation.endLine !== undefined) {
		if (result.startLine === undefined || result.endLine === undefined) {
			return false
		}
		// Overlap test between the result range and the expected range.
		return result.startLine <= expectation.endLine && result.endLine >= expectation.startLine
	}

	// File-only expectation: any result in the file satisfies it.
	return true
}

/**
 * Recall@K over expected files: the fraction of distinct expected files that
 * appear among the top-`k` ranked results (Req 20.3).
 *
 * Returns `1` when there are no expected files (vacuously satisfied) so an empty
 * expectation set never drags an average down. Pure function.
 *
 * @param rankedResults Ranked candidates, best-first.
 * @param expectedFiles The files expected to be relevant for the case.
 * @param k The rank cutoff.
 */
export function recallAtK(rankedResults: RankedResult[], expectedFiles: string[], k: number): number {
	const expected = new Set(expectedFiles.map(normalizeFile))
	if (expected.size === 0) {
		return 1
	}

	const topKFiles = new Set(rankedResults.slice(0, k).map((result) => normalizeFile(result.file)))

	let hits = 0
	for (const file of expected) {
		if (topKFiles.has(file)) {
			hits += 1
		}
	}

	return hits / expected.size
}

/**
 * Mean Reciprocal Rank at K: the reciprocal of the 1-based rank of the first
 * ranked result that satisfies any expected symbol/range (falling back to an
 * expected file), considering only the top-`k` results (Req 20.3).
 *
 * Returns `0` when no satisfying result appears within the cutoff, and `1` when
 * there are no expectations to satisfy. Pure function.
 *
 * @param rankedResults Ranked candidates, best-first.
 * @param evalCase The case supplying expected files and symbols/ranges.
 * @param k The rank cutoff.
 */
export function mrrAtK(rankedResults: RankedResult[], evalCase: EvalCase, k: number): number {
	const expectations = evalCase.expectedSymbolsOrRanges
	const expectedFiles = new Set(evalCase.expectedFiles.map(normalizeFile))

	if (expectations.length === 0 && expectedFiles.size === 0) {
		return 1
	}

	const topK = rankedResults.slice(0, k)
	for (let index = 0; index < topK.length; index += 1) {
		const result = topK[index]
		const matchesExpectation = expectations.some((expectation) =>
			resultSatisfiesExpectation(result, expectation),
		)
		const matchesFile = expectations.length === 0 && expectedFiles.has(normalizeFile(result.file))
		if (matchesExpectation || matchesFile) {
			return 1 / (index + 1)
		}
	}

	return 0
}

/**
 * Normalized Discounted Cumulative Gain at K over expected files (Req 20.3).
 *
 * Each top-`k` result scores a binary gain of `1` when its file is expected,
 * discounted by `1 / log2(rank + 1)`. The DCG is normalized by the ideal DCG —
 * the gain of placing as many expected files as possible at the top ranks —
 * yielding a value in `[0, 1]`. Returns `1` when there are no expected files.
 * Pure function.
 *
 * @param rankedResults Ranked candidates, best-first.
 * @param expectedFiles The files expected to be relevant for the case.
 * @param k The rank cutoff.
 */
export function ndcgAtK(rankedResults: RankedResult[], expectedFiles: string[], k: number): number {
	const expected = new Set(expectedFiles.map(normalizeFile))
	if (expected.size === 0) {
		return 1
	}

	const topK = rankedResults.slice(0, k)

	// DCG: credit each expected file at most once, at its best (earliest) rank.
	const creditedFiles = new Set<string>()
	let dcg = 0
	for (let index = 0; index < topK.length; index += 1) {
		const file = normalizeFile(topK[index].file)
		if (expected.has(file) && !creditedFiles.has(file)) {
			creditedFiles.add(file)
			dcg += 1 / Math.log2(index + 2)
		}
	}

	// Ideal DCG: as many expected files as fit in k, packed at ranks 1..n.
	const idealHits = Math.min(expected.size, k)
	let idcg = 0
	for (let index = 0; index < idealHits; index += 1) {
		idcg += 1 / Math.log2(index + 2)
	}

	if (idcg === 0) {
		return 0
	}

	return dcg / idcg
}

/**
 * Top-5 expected-file hit rate for a single case: `1` when at least one expected
 * file appears in the top 5 ranked results, else `0` (Req 20.3). Returns `1`
 * when there are no expected files. Pure function.
 *
 * @param rankedResults Ranked candidates, best-first.
 * @param expectedFiles The files expected to be relevant for the case.
 */
export function top5ExpectedFileHitRate(rankedResults: RankedResult[], expectedFiles: string[]): number {
	const expected = new Set(expectedFiles.map(normalizeFile))
	if (expected.size === 0) {
		return 1
	}

	const top5Files = rankedResults.slice(0, RANK_AT_5).map((result) => normalizeFile(result.file))
	return top5Files.some((file) => expected.has(file)) ? 1 : 0
}

/** Mean of a list of numbers, or `0` for an empty list. */
function mean(values: number[]): number {
	if (values.length === 0) {
		return 0
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Run the evaluation harness over every `(config, dimension)` combination and
 * emit the full {@link EvalResult} set (Req 16.1-16.3, 20.1-20.5).
 *
 * For each configuration and stored dimension, the harness builds a retriever
 * via `retrieverFactory`, runs it over every {@link EvalCase}, and aggregates
 * the per-case metrics into one `EvalResult`:
 *
 * - `recallAt30` / `recallAt10` — mean Recall@30 / Recall@10 over expected files
 * - `mrrAt5` — mean MRR@5 over expected symbols/ranges (file fallback)
 * - `ndcgAt5` — mean NDCG@5 over expected files
 * - `top5ExpectedFileHitRate` — fraction of cases with an expected file in the top 5
 *
 * This is a decision tool run on demand; it is NOT wired into any unit-test
 * gate (Req 20, task 10.1).
 *
 * @param cases The real Menagerie / NerveCenter evaluation cases.
 * @param configs The retrieval configurations to compare; defaults to all five.
 * @param dimensions The Matryoshka dimensions to sweep; defaults to all four.
 * @param retrieverFactory Builds a retriever bound to a `(config, dimension)` pair.
 * @returns One `EvalResult` per `(config, dimension)` combination.
 */
export async function runEval(
	cases: EvalCase[],
	configs: readonly EvalConfig[] = EVAL_CONFIGS,
	dimensions: readonly EvalDimension[] = EVAL_DIMENSIONS,
	retrieverFactory: RetrieverFactory = () => ({ retrieve: async () => [] }),
): Promise<EvalResult[]> {
	const results: EvalResult[] = []

	for (const config of configs) {
		for (const dimension of dimensions) {
			const retriever = retrieverFactory(config, dimension)

			const recallAt30PerCase: number[] = []
			const recallAt10PerCase: number[] = []
			const mrrAt5PerCase: number[] = []
			const ndcgAt5PerCase: number[] = []
			const top5PerCase: number[] = []

			for (const evalCase of cases) {
				const ranked = await retriever.retrieve(evalCase)

				recallAt30PerCase.push(recallAtK(ranked, evalCase.expectedFiles, RECALL_AT_30))
				recallAt10PerCase.push(recallAtK(ranked, evalCase.expectedFiles, RECALL_AT_10))
				mrrAt5PerCase.push(mrrAtK(ranked, evalCase, RANK_AT_5))
				ndcgAt5PerCase.push(ndcgAtK(ranked, evalCase.expectedFiles, RANK_AT_5))
				top5PerCase.push(top5ExpectedFileHitRate(ranked, evalCase.expectedFiles))
			}

			results.push({
				config,
				dimension,
				recallAt30: mean(recallAt30PerCase),
				recallAt10: mean(recallAt10PerCase),
				mrrAt5: mean(mrrAt5PerCase),
				ndcgAt5: mean(ndcgAt5PerCase),
				top5ExpectedFileHitRate: mean(top5PerCase),
			})
		}
	}

	return results
}
