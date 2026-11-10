import type { AnsweredQuestion } from "./QuestionMemory"
import type { Passage } from "./QuestionSources"
import { tokenSet, coverage } from "./questionText"

/**
 * Decides what to do with a follow-up question BEFORE the user is interrupted.
 *
 *  - `reuse`   a previous answer from this project matches: answer from memory, don't ask.
 *  - `consult` the conversation or project docs cover the question: hand those passages back to
 *              the model once and let it decide. A repeat of the same question goes through.
 *  - `ask`     nothing relevant: ask the user.
 *
 * Pure: all evidence is passed in, and the only state is the caller's "already consulted" set.
 */
export type QuestionDecision =
	| { action: "reuse"; entry: AnsweredQuestion }
	| { action: "consult"; passages: Passage[] }
	| { action: "ask" }

export interface GateInput {
	question: string
	suggestions: readonly string[]
	remembered: AnsweredQuestion | undefined
	passages: readonly Passage[]
	/** Identities (normalized questions) already bounced or answered from memory in this task. */
	alreadyHandled: ReadonlySet<string>
	normalized: string
}

export function decideQuestion(input: GateInput): QuestionDecision {
	// A repeat in the same task means the earlier consult/memory answer did not satisfy the model: let the user answer.
	if (input.alreadyHandled.has(input.normalized)) return { action: "ask" }

	const entry = input.remembered
	if (entry && answerFitsSuggestions(entry.answer, input.suggestions)) return { action: "reuse", entry }

	if (input.passages.length > 0) return { action: "consult", passages: [...input.passages] }
	return { action: "ask" }
}

/** With suggested options, a stored free-text answer is only reusable if it still matches one of them. */
function answerFitsSuggestions(answer: string, suggestions: readonly string[]): boolean {
	if (suggestions.length === 0) return true
	const a = tokenSet(answer)
	if (a.size === 0) return true
	return suggestions.some((s) => coverage(a, tokenSet(s)).ratio >= 0.6 || coverage(tokenSet(s), a).ratio >= 0.6)
}

/** Text returned to the model when memory answers the question. Attributed, and says how to override. */
export function formatReuse(entry: AnsweredQuestion): string {
	const when = new Date(entry.answeredAt).toISOString().slice(0, 10)
	return [
		`The user already answered this question in this project (${when}), so they were not asked again:`,
		`<previous_answer>`,
		entry.answer,
		`</previous_answer>`,
		`Proceed with that answer. If it is clearly outdated for this task, call ask_followup_question again with the same question and the user will be asked.`,
	].join("\n")
}

/** Text returned to the model when sources may answer the question. */
export function formatConsult(passages: readonly Passage[]): string {
	const body = passages.map((p) => `<source name="${p.label}" lines="${p.startLine}-${p.endLine}">\n${p.text}\n</source>`).join("\n")
	return [
		`The user was NOT asked yet. These passages from the conversation and project docs overlap with your question:`,
		body,
		`If they answer it, proceed without asking. If they do not, call ask_followup_question again with the same question and the user will be asked.`,
	].join("\n")
}
