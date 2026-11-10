import type { AnalysisOutcome } from "@roo-code/types"

/**
 * Per-operation parent-visible budget (R5.2). Initial target 2-4 KiB. This is intentionally
 * independent of `MAX_READER_PARENT_RESULT_CHARS` (64,000, a legacy curated-backlog cap that
 * is NOT changed here): analysis results never flow through that path.
 */
export const DEFAULT_PARENT_SUMMARY_CHARS = 3_072

/**
 * Bounded text for the coordinator. Contains claims and citation ids only, never excerpts or
 * raw model output. Full outcomes stay with the caller (manifest / index).
 */
export function summarizeOutcomeForParent(outcome: AnalysisOutcome, maxChars = DEFAULT_PARENT_SUMMARY_CHARS): string {
	if (outcome.kind !== "valid") {
		return `[analysis ${outcome.kind}] ${outcome.reason}`.slice(0, maxChars)
	}
	const lines: string[] = [`[analysis ${outcome.operation} digest=${outcome.digest.slice(0, 12)}]`]
	if (outcome.risk) lines.push(`risk: ${outcome.risk}`)
	outcome.findings.forEach((f, i) => lines.push(`${i + 1}. ${f.claim} [${f.anchorIds.join(", ")}]`))
	if (outcome.unknowns.length > 0) lines.push(`unknowns: ${outcome.unknowns.join(" | ")}`)

	let text = ""
	let omitted = 0
	for (let i = 0; i < lines.length; i++) {
		const next = text ? `${text}\n${lines[i]}` : lines[i]
		if (next.length > maxChars - 40) {
			omitted = lines.length - i
			break
		}
		text = next
	}
	return omitted > 0 ? `${text}\n[+${omitted} more lines omitted; full result retained]` : text
}
