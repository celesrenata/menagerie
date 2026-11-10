import { QuestionMemory } from "./QuestionMemory"
import { conversationDocs, gatherDocs, rankPassages, type ConversationMessageLike } from "./QuestionSources"
import { decideQuestion, formatConsult, formatReuse, type QuestionDecision } from "./questionGate"
import { normalizeQuestion } from "./questionText"

/**
 * The pieces `ask_followup_question` needs, kept out of the tool so they are testable without a Task.
 *
 * Per-task state is a set of question identities already consulted/answered from memory; a repeat
 * of the same question always reaches the user, so the model can never be trapped in a loop.
 */
export interface AssistInput {
	workspaceRoot: string
	messages: readonly ConversationMessageLike[]
	question: string
	suggestions: readonly string[]
	handled: Set<string>
	memory?: QuestionMemory
}

export type AssistResult =
	| { action: "answer"; text: string; entryId: string }
	| { action: "consult"; text: string }
	| { action: "ask" }

export async function assistQuestion(input: AssistInput): Promise<AssistResult> {
	const normalized = normalizeQuestion(input.question)
	if (!normalized) return { action: "ask" }
	try {
		const memory = input.memory ?? new QuestionMemory(input.workspaceRoot)
		const remembered = await memory.find(input.question)
		const docs = [...conversationDocs(input.messages), ...(await gatherDocs(input.workspaceRoot))]
		const passages = rankPassages(input.question, input.suggestions, docs)
		const decision: QuestionDecision = decideQuestion({ question: input.question, suggestions: input.suggestions, remembered, passages, alreadyHandled: input.handled, normalized })
		if (decision.action === "reuse") {
			input.handled.add(normalized)
			await memory.markUsed(decision.entry.id)
			return { action: "answer", text: formatReuse(decision.entry), entryId: decision.entry.id }
		}
		if (decision.action === "consult") {
			input.handled.add(normalized)
			return { action: "consult", text: formatConsult(decision.passages) }
		}
	} catch {
		// Helping is best-effort. Any failure here must fall back to simply asking the user.
	}
	return { action: "ask" }
}

/** Remember what the user said. Never throws; returns whether anything was stored. */
export async function rememberAnswer(workspaceRoot: string, question: string, answer: string, taskId: string | undefined, memory?: QuestionMemory): Promise<boolean> {
	try {
		const result = await (memory ?? new QuestionMemory(workspaceRoot)).record(question, answer, taskId)
		return result.recorded
	} catch {
		return false
	}
}
