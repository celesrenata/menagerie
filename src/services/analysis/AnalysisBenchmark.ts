import type { AnalysisOutcome, AnalysisRequest } from "@roo-code/types"

import type { GoldenCase } from "./__fixtures__/goldenSet"
import { sha256Hex, canonicalJson } from "./analysisDigest"
import type { AnalysisEvent } from "./AnalysisExecutor"

/**
 * Offline golden-set scoring harness (design §5 AnalysisBenchmark, tasks 0.3 / 1.7 / 5.1).
 *
 * It measures output QUALITY against hand labels. It is not a parity check of the serving
 * kernels (R3.3) and says nothing about correctness beyond the labeled cases.
 */

export interface BenchmarkRunner {
	execute(request: AnalysisRequest): Promise<AnalysisOutcome>
}

export interface CaseResult {
	caseId: string
	class: GoldenCase["class"]
	outcomeKind: AnalysisOutcome["kind"]
	retried: boolean
	latencyMs: number
	findingCount: number
	citedExpected: number
	groupsSatisfied: number
	groupsTotal: number
	falsePass: number
	suppressedUngrounded: number
	/** Findings fingerprint, for rerun variance. */
	fingerprint: string
	riskCorrect?: boolean
	/** Model's own answer before the deterministic floor ("unknown" when it abstained). */
	riskRawCorrect?: boolean
	riskAbstained?: boolean
	/** Known risk strictly below the labeled risk: the unsafe direction. */
	riskUnderrated?: boolean
	contradictionFlagged?: boolean
	hasContradiction?: boolean
}

export interface BenchmarkReport {
	cases: number
	repeats: number
	schemaValidRate: number
	retryRate: number
	/** Findings that cite at least one expected anchor / all findings from valid outcomes. */
	citationPrecision: number | null
	/** Satisfied keyword groups / total groups, counting failed outcomes as 0. */
	requirementCoverageRecall: number | null
	/** Of find-contradictions cases that returned findings, share that truly had a contradiction. */
	contradictionPrecision: number | null
	/** Of runs on cases that truly contain a contradiction, share that reported one. */
	contradictionRecall: number | null
	/** Of runs on cases with no contradiction, share that reported one anyway. */
	contradictionFalsePositiveRate: number | null
	falsePassCount: number
	/** Share of cases whose findings differ across repeats. 0 when repeats = 1. */
	rerunVariance: number
	riskAccuracy: number | null
	/** Same, but scoring the model alone (floor removed). */
	riskAccuracyRaw: number | null
	riskAbstainRate: number | null
	/** Share of risk calls that rated a change LOWER than the label. */
	riskUnderrateRate: number | null
	latencyP50Ms: number
	latencyP95Ms: number
	promptTokens: number
	completionTokens: number
	perCase: CaseResult[]
}

/** A complete answer is ~100-250 tokens; a smaller cap shortens the post-JSON ramble (a complete object is still accepted). */
export const BENCHMARK_MAX_OUTPUT_TOKENS = 400

export function toRequest(testCase: GoldenCase, runId: string): AnalysisRequest {
	return {
		requestId: `${testCase.id}-${runId}`,
		operation: testCase.operation,
		evidence: testCase.evidence.map((e) => ({
			anchorId: e.id,
			anchor: {
				workspaceUri: "file:///golden",
				path: e.path,
				fileDigest: sha256Hex(e.text),
				startLine: 1,
				endLine: Math.max(1, e.text.split("\n").length),
			},
			excerpt: e.text,
		})),
		instructionsVersion: "golden-1",
		schemaVersion: 1,
		maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
	}
}

function ratio(rows: CaseResult[], inSet: (r: CaseResult) => boolean, hit: (r: CaseResult) => boolean): number | null {
	const set = rows.filter(inSet)
	return set.length ? set.filter(hit).length / set.length : null
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }

function rawRiskOf(outcome: Extract<AnalysisOutcome, { kind: "valid" }>): string | undefined {
	const note = outcome.unknowns.find((u) => u.startsWith("risk raised by deterministic floor"))
	const said = note ? /model said (\w+)\)/.exec(note)?.[1] : undefined
	return note ? said : outcome.risk
}

export function scoreCase(testCase: GoldenCase, outcome: AnalysisOutcome, latencyMs: number): CaseResult {
	const groups = testCase.expect.keywordGroups
	const base: CaseResult = {
		caseId: testCase.id,
		class: testCase.class,
		outcomeKind: outcome.kind,
		retried: outcome.kind === "valid" && outcome.retried,
		latencyMs,
		findingCount: 0,
		citedExpected: 0,
		groupsSatisfied: 0,
		groupsTotal: groups.length,
		falsePass: 0,
		suppressedUngrounded: 0,
		fingerprint: outcome.kind,
	}
	if (outcome.kind !== "valid") return base

	const claims = outcome.findings.map((f) => f.claim.toLowerCase())
	const expected = new Set(testCase.expect.citeAny)
	const forbid = testCase.expect.forbidClaims ?? []
	return {
		...base,
		findingCount: outcome.findings.length,
		citedExpected: outcome.findings.filter((f) => f.anchorIds.some((id) => expected.has(id))).length,
		groupsSatisfied: groups.filter((g) => claims.some((c) => g.some((w) => c.includes(w.toLowerCase())))).length,
		falsePass: outcome.findings.filter((f) => forbid.some((re) => re.test(f.claim.trim()))).length,
		suppressedUngrounded: outcome.unknowns.filter((u) => u.startsWith("ungrounded claim suppressed")).length,
		fingerprint: sha256Hex(canonicalJson(outcome.findings.map((f) => [f.claim, f.anchorIds]))),
		riskCorrect: testCase.expect.risk === undefined ? undefined : outcome.risk === testCase.expect.risk,
		riskRawCorrect: testCase.expect.risk === undefined ? undefined : rawRiskOf(outcome) === testCase.expect.risk,
		riskAbstained: testCase.expect.risk === undefined ? undefined : !(outcome.risk && outcome.risk in RISK_RANK),
		riskUnderrated:
			testCase.expect.risk === undefined
				? undefined
				: outcome.risk !== undefined && outcome.risk in RISK_RANK && RISK_RANK[outcome.risk] < RISK_RANK[testCase.expect.risk],
		contradictionFlagged: testCase.operation === "find-contradictions" ? outcome.findings.length > 0 : undefined,
		hasContradiction: testCase.expect.hasContradiction,
	}
}

export async function runGoldenSet(
	runner: BenchmarkRunner,
	cases: readonly GoldenCase[],
	options: { repeats?: number; events?: AnalysisEvent[] } = {},
): Promise<BenchmarkReport> {
	const repeats = Math.max(1, options.repeats ?? 1)
	const perCase: CaseResult[] = []
	const fingerprints = new Map<string, Set<string>>()

	for (const testCase of cases) {
		for (let run = 0; run < repeats; run++) {
			const started = Date.now()
			const outcome = await runner.execute(toRequest(testCase, `run${run}`))
			const result = scoreCase(testCase, outcome, Date.now() - started)
			perCase.push(result)
			const set = fingerprints.get(testCase.id) ?? new Set<string>()
			set.add(result.fingerprint)
			fingerprints.set(testCase.id, set)
		}
	}

	const valid = perCase.filter((r) => r.outcomeKind === "valid")
	const findings = valid.reduce((n, r) => n + r.findingCount, 0)
	const groupsTotal = perCase.reduce((n, r) => n + r.groupsTotal, 0)
	const contradictionRuns = perCase.filter((r) => r.contradictionFlagged === true)
	const riskRuns = perCase.filter((r) => r.riskCorrect !== undefined)
	const latencies = perCase.map((r) => r.latencyMs).sort((a, b) => a - b)
	const events = options.events ?? []

	return {
		cases: cases.length,
		repeats,
		schemaValidRate: perCase.length ? valid.length / perCase.length : 0,
		retryRate: perCase.length ? perCase.filter((r) => r.retried).length / perCase.length : 0,
		citationPrecision: findings ? valid.reduce((n, r) => n + r.citedExpected, 0) / findings : null,
		requirementCoverageRecall: groupsTotal ? perCase.reduce((n, r) => n + r.groupsSatisfied, 0) / groupsTotal : null,
		contradictionPrecision: contradictionRuns.length
			? contradictionRuns.filter((r) => r.hasContradiction === true).length / contradictionRuns.length
			: null,
		contradictionRecall: ratio(perCase, (r) => r.hasContradiction === true, (r) => r.findingCount > 0),
		contradictionFalsePositiveRate: ratio(perCase, (r) => r.hasContradiction === false, (r) => r.findingCount > 0),
		falsePassCount: perCase.reduce((n, r) => n + r.falsePass, 0),
		rerunVariance: repeats > 1 ? [...fingerprints.values()].filter((s) => s.size > 1).length / cases.length : 0,
		riskAccuracy: riskRuns.length ? riskRuns.filter((r) => r.riskCorrect).length / riskRuns.length : null,
		riskAccuracyRaw: riskRuns.length ? riskRuns.filter((r) => r.riskRawCorrect).length / riskRuns.length : null,
		riskAbstainRate: riskRuns.length ? riskRuns.filter((r) => r.riskAbstained).length / riskRuns.length : null,
		riskUnderrateRate: riskRuns.length ? riskRuns.filter((r) => r.riskUnderrated).length / riskRuns.length : null,
		latencyP50Ms: percentile(latencies, 0.5),
		latencyP95Ms: percentile(latencies, 0.95),
		promptTokens: events.reduce((n, e) => n + (e.type === "completed" ? (e.promptTokens ?? 0) : 0), 0),
		completionTokens: events.reduce((n, e) => n + (e.type === "completed" ? (e.completionTokens ?? 0) : 0), 0),
		perCase,
	}
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`)

/**
 * Side-by-side markdown of two reports run on the SAME cases through the SAME executor,
 * prompt and validator (task 5.1). Only the model behind the client differs.
 */
export function formatComparison(a: { label: string; report: BenchmarkReport }, b: { label: string; report: BenchmarkReport }): string {
	const rows: Array<[string, (r: BenchmarkReport) => string]> = [
		["Schema-valid after <=1 retry", (r) => pct(r.schemaValidRate)],
		["Retry rate", (r) => pct(r.retryRate)],
		["Citation precision", (r) => pct(r.citationPrecision)],
		["Requirement-coverage recall", (r) => pct(r.requirementCoverageRecall)],
		["Contradiction recall", (r) => pct(r.contradictionRecall)],
		["Contradiction false-positive rate", (r) => pct(r.contradictionFalsePositiveRate)],
		["Risk accuracy (effective)", (r) => pct(r.riskAccuracy)],
		["Risk accuracy (model alone)", (r) => pct(r.riskAccuracyRaw)],
		["Risk rated lower than label", (r) => pct(r.riskUnderrateRate)],
		["False PASS (count)", (r) => String(r.falsePassCount)],
		["Rerun variance", (r) => pct(r.rerunVariance)],
		["Latency p50 / p95 (ms)", (r) => `${r.latencyP50Ms} / ${r.latencyP95Ms}`],
		["Tokens prompt / completion", (r) => (r.promptTokens + r.completionTokens === 0 ? "n/a" : `${r.promptTokens} / ${r.completionTokens}`)],
	]
	const lines = [`| Metric | ${a.label} | ${b.label} |`, "| --- | ---: | ---: |"]
	for (const [name, fn] of rows) lines.push(`| ${name} | ${fn(a.report)} | ${fn(b.report)} |`)
	return lines.join("\n")
}
