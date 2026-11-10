import type { AnalysisEvidenceItem } from "@roo-code/types"

/**
 * Input budgeting for the analysis executor (MEN-GRANITE-SDD-001 R2.4, R2.5).
 *
 * The live service does NOT enforce its served window (a ~40K-token prompt was accepted
 * and produced degenerate output), so the client must refuse or split oversize input.
 * No tokenizer is available client-side, so the estimate is deliberately conservative.
 * It over-counts rather than under-counts, and a model-reported `usage` is only ever
 * used to learn after the fact.
 */

/** Served window for the analysis route. The checkpoint's 131072 is NOT served. */
export const GRANITE_SERVED_CONTEXT_TOKENS = 32_768

export interface AnalysisBudgetConfig {
	servedContextTokens: number
	/** Fraction of the served window kept free as safety margin. */
	safetyMarginFraction: number
	/**
	 * Preferred ceiling for one request's INPUT. Quality, latency and prefill cost degrade long
	 * before the served cap, so the working ceiling is far below it (design §4: 1K-3K tokens).
	 */
	maxInputTokens: number
	/** Conservative chars-per-token for ASCII text. Code tokenizes worse than prose. */
	charsPerToken: number
}

export const DEFAULT_ANALYSIS_BUDGET: AnalysisBudgetConfig = {
	servedContextTokens: GRANITE_SERVED_CONTEXT_TOKENS,
	safetyMarginFraction: 0.1,
	maxInputTokens: 3_000,
	charsPerToken: 2.5,
}

export function estimateTokens(text: string, charsPerToken = DEFAULT_ANALYSIS_BUDGET.charsPerToken): number {
	let ascii = 0
	let other = 0
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 128) ascii++
		else other++
	}
	// Non-ASCII code units can cost a full token each, so they are counted 1:1.
	return Math.ceil(ascii / charsPerToken) + other
}

export type PreflightResult =
	| { ok: true; estimatedInputTokens: number; limit: number }
	| { ok: false; estimatedInputTokens: number; limit: number; reason: string }

/** The hard input limit: the lesser of the working ceiling and the served window less output and margin. */
export function inputLimit(maxOutputTokens: number, config: AnalysisBudgetConfig = DEFAULT_ANALYSIS_BUDGET): number {
	const margin = Math.ceil(config.servedContextTokens * config.safetyMarginFraction)
	const windowLimit = config.servedContextTokens - maxOutputTokens - margin
	return Math.max(0, Math.min(config.maxInputTokens, windowLimit))
}

export function preflight(
	promptText: string,
	maxOutputTokens: number,
	config: AnalysisBudgetConfig = DEFAULT_ANALYSIS_BUDGET,
): PreflightResult {
	const limit = inputLimit(maxOutputTokens, config)
	const estimatedInputTokens = estimateTokens(promptText, config.charsPerToken)
	if (limit === 0) {
		return {
			ok: false,
			estimatedInputTokens,
			limit,
			reason: "output reserve and safety margin leave no input budget",
		}
	}
	if (estimatedInputTokens > limit) {
		return {
			ok: false,
			estimatedInputTokens,
			limit,
			reason: `estimated ${estimatedInputTokens} input tokens exceeds the ${limit}-token budget`,
		}
	}
	return { ok: true, estimatedInputTokens, limit }
}

export type ChunkResult =
	| { ok: true; batches: AnalysisEvidenceItem[][] }
	| { ok: false; oversizeAnchorId: string; reason: string }

/**
 * Split evidence into batches that each fit `budgetTokens`, on item boundaries only.
 * An item that alone exceeds the budget is reported, never truncated: dropping part of a
 * requirement could silently change its meaning (R2.5). The caller escalates instead.
 */
export function chunkEvidence(
	items: readonly AnalysisEvidenceItem[],
	budgetTokens: number,
	config: AnalysisBudgetConfig = DEFAULT_ANALYSIS_BUDGET,
): ChunkResult {
	const batches: AnalysisEvidenceItem[][] = []
	let current: AnalysisEvidenceItem[] = []
	let used = 0
	for (const item of items) {
		const cost = estimateTokens(item.excerpt, config.charsPerToken)
		if (cost > budgetTokens) {
			return {
				ok: false,
				oversizeAnchorId: item.anchorId,
				reason: `evidence ${item.anchorId} alone is ~${cost} tokens, above the ${budgetTokens}-token batch budget`,
			}
		}
		if (used + cost > budgetTokens && current.length > 0) {
			batches.push(current)
			current = []
			used = 0
		}
		current.push(item)
		used += cost
	}
	if (current.length > 0) batches.push(current)
	return { ok: true, batches }
}
