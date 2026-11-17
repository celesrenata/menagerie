import { computeServableInputBudget } from "../task/servableBudget"

/**
 * Mirrors TOKEN_BUFFER_PERCENTAGE in context-management. Defined locally because
 * context-management imports from this directory (circular import otherwise).
 */
export const CONDENSE_TOKEN_BUFFER_PERCENTAGE = 0.1

/** Max output tokens requested from the summarizer for each summary call. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 6144

export interface CondenseInputBudgetInput {
	/** Context window of the condensing handler, in tokens. */
	contextWindow: number
	/** Tokens reserved for the summarizer's output. */
	outputReserve: number
	/** Tokens taken by the summarizer prompt and condense instructions. */
	promptTokens: number
}

/**
 * Input tokens (conversation content) a single summarizer request may carry:
 * the window minus a safety buffer, minus the output reserve and the prompt.
 */
export function computeCondenseInputBudget(input: CondenseInputBudgetInput): number {
	return computeServableInputBudget({
		servedContextWindow: Math.floor(input.contextWindow * (1 - CONDENSE_TOKEN_BUFFER_PERCENTAGE)),
		outputReserve: input.outputReserve + input.promptTokens,
	})
}

/**
 * Greedily splits messages into consecutive chunks whose token counts each stay
 * within `budgetTokens`. Chunks always break on message boundaries; a single
 * message larger than the budget becomes its own chunk.
 */
export async function splitMessagesIntoChunks<T>(
	messages: T[],
	budgetTokens: number,
	countMessageTokens: (message: T) => Promise<number>,
): Promise<T[][]> {
	const chunks: T[][] = []
	let current: T[] = []
	let currentTokens = 0

	for (const message of messages) {
		const tokens = await countMessageTokens(message)
		if (current.length > 0 && currentTokens + tokens > budgetTokens) {
			chunks.push(current)
			current = []
			currentTokens = 0
		}
		current.push(message)
		currentTokens += tokens
	}

	if (current.length > 0) {
		chunks.push(current)
	}
	return chunks
}
