import { QuestionMemory } from "./QuestionMemory"
import { conversationDocs, gatherDocs, rankPassages, type ConversationMessageLike } from "./QuestionSources"
import { decideQuestion, formatConsult, formatReuse, type QuestionDecision } from "./questionGate"
import { normalizeQuestion } from "./questionText"
import {
	READER_MAX_OUTPUT_TOKENS,
	buildDeepReaderMessage,
	buildReaderExcerpts,
	buildReaderMessages,
	formatDeepAnswer,
	formatReaderAnswer,
	judgeReaderAnswer,
	validateReaderReply,
	verifyDeepAnswer,
	type ReaderExcerpt,
} from "./readerAnswer"

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

/** Outcome of one bounded model call on the low reader lane. `unavailable` covers every transport failure. */
export type ReaderCompletion = { kind: "ok"; content: string } | { kind: "unavailable"; reason: string }
export interface ReaderAssistDeps {
	/** Low lane: bounded, tool-less JSON completion (Granite). Omit when no analysis route is configured. */
	complete?: (messages: ReturnType<typeof buildReaderMessages>, maxTokens: number) => Promise<ReaderCompletion>
	/** High lane: a tool-capable reader subtask. Returns its final text, or undefined on failure. */
	deep?: (message: string) => Promise<string | undefined>
}
export type ReaderAssistResult = { action: "answer"; text: string; lane: "low" | "high" } | { action: "ask"; reason: string }
export interface ReaderAssistInput {
	workspaceRoot: string
	messages: readonly ConversationMessageLike[]
	question: string
	suggestions: readonly string[]
	/** Same per-task set `assistQuestion` uses. A question already in it goes straight to the user. */
	handled: Set<string>
}
/**
 * Last stop before interrupting the user. Low lane first (Granite answers only from host-selected
 * excerpts), then the high lane on failure or low confidence (the existing `readerEscalationDecision`),
 * then `ask`. The question is recorded in `handled` before any model runs, so a repeat of it always
 * reaches the user. Reader output is never written to question memory. Never throws.
 */
export async function assistWithReader(input: ReaderAssistInput, deps: ReaderAssistDeps): Promise<ReaderAssistResult> {
	const normalized = normalizeQuestion(input.question)
	if (!normalized) return { action: "ask", reason: "empty-question" }
	if (input.handled.has(normalized)) return { action: "ask", reason: "repeat-question" }
	input.handled.add(normalized)
	let excerpts: ReaderExcerpt[] = []
	try {
		excerpts = await buildReaderExcerpts(input)
	} catch {
		// Excerpts are best-effort; the high lane can still search on its own.
	}
	try {
		if (deps.complete && excerpts.length > 0) {
			const done = await deps.complete(buildReaderMessages(input.question, input.suggestions, excerpts), READER_MAX_OUTPUT_TOKENS)
			if (done.kind === "ok") {
				const answer = validateReaderReply(done.content, excerpts)
				if (answer && judgeReaderAnswer(answer).accept) return { action: "answer", text: formatReaderAnswer(answer, "low"), lane: "low" }
			}
		}
		if (deps.deep) {
			const text = await deps.deep(buildDeepReaderMessage(input.question, input.suggestions, excerpts))
			if (text?.trim()) {
				const files = await verifyDeepAnswer(text, input.workspaceRoot)
				if (files.length > 0) return { action: "answer", text: formatDeepAnswer(text, files), lane: "high" }
			}
		}
	} catch {
		// Any reader failure falls back to asking the user.
	}
	return { action: "ask", reason: "reader-found-nothing" }
}
