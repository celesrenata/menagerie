import type { AnalysisValidOutcome } from "@roo-code/types"

type Risk = NonNullable<AnalysisValidOutcome["risk"]>

const RANK: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 }

interface Rule {
	level: "medium" | "high"
	reason: string
	test: (text: string) => boolean
}

const near = (a: RegExp, b: RegExp) => (t: string) => a.test(t) && b.test(t)

const RULES: Rule[] = [
	{ level: "high", reason: "destructive data change", test: near(/\b(drops?|deletes?|truncates?|removes?)\b/i, /\b(columns?|tables?|database|rows|records)\b/i) },
	{ level: "high", reason: "access-control or validation removed", test: near(/\b(remov\w+|delet\w+|disabl\w+|bypass\w*|skip\w*)\b/i, /\b(auth\w*|permissions?|isAdmin|admin check|csrf|signature|encrypt\w*|sanitiz\w*|validation)\b/i) },
	{ level: "high", reason: "money or billing behaviour changed", test: near(/\b(payments?|billing|charge\w*|invoice\w*|currency|refund\w*)\b/i, /\b(chang\w+|switch\w*|remov\w+|delet\w+|no longer|instead of)\b/i) },
	{ level: "high", reason: "secret handling", test: near(/\b(secrets?|credentials?|tokens?|passwords?|api keys?)\b/i, /\b(logg?\w*|expos\w+|return\w*|commit\w*|print\w*)\b/i) },
	{ level: "high", reason: "error recovery removed", test: near(/\b(retry|backoff|fallback|circuit breaker)\b/i, /\b(remov\w+|delet\w+|drop\w*)\b/i) },
	{ level: "high", reason: "production migration", test: near(/\bmigration\b/i, /\b(production|prod|rows|backfill)\b/i) },
	{ level: "high", reason: "widely used contract changed", test: (t) => /\b(\d+)\s+(call sites?|callers?|usages?)\b/i.test(t) && Number(/\b(\d+)\s+(call sites?|callers?|usages?)\b/i.exec(t)![1]) >= 10 },
	{ level: "medium", reason: "several callers affected", test: (t) => /\b(\d+)\s+(call sites?|callers?|usages?)\b/i.test(t) && Number(/\b(\d+)\s+(call sites?|callers?|usages?)\b/i.exec(t)![1]) >= 3 },
	{ level: "medium", reason: "public interface change", test: near(/\b(public|exported|api|signature)\b/i, /\b(chang\w+|renam\w+|remov\w+)\b/i) },
]

/**
 * Deterministic risk FLOOR for `classify-change-risk`. The final risk is max(model, floor): the
 * floor can raise a model's answer (or replace "unknown"), and can never lower it. It never
 * produces "low": nothing deterministic here may declare a change safe. A raise is reported
 * so a reader can see the model did not say it.
 */
export function applyRiskFloor(modelRisk: Risk | undefined, evidenceTexts: readonly string[]): { risk: Risk | undefined; raisedBy?: string } {
	const text = evidenceTexts.join("\n")
	let floor: { level: "medium" | "high"; reason: string } | undefined
	for (const rule of RULES) {
		if (!rule.test(text)) continue
		if (!floor || RANK[rule.level] > RANK[floor.level]) floor = { level: rule.level, reason: rule.reason }
	}
	if (!floor) return { risk: modelRisk }
	const known = modelRisk === "low" || modelRisk === "medium" || modelRisk === "high"
	if (known && RANK[modelRisk] >= RANK[floor.level]) return { risk: modelRisk }
	return { risk: floor.level, raisedBy: `${floor.reason} (model said ${modelRisk ?? "nothing"})` }
}
