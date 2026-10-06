import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@roo-code/telemetry"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@roo-code/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate.
 * Used by Context Management to determine when to trigger condensation or (fallback) sliding window truncation.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * After emergency truncation, aim below the hard safe-input boundary rather
 * than landing directly on it. This gives the next model turn room to emit
 * tools/results without immediately re-entering context management.
 */
export const TRUNCATION_TARGET_PERCENTAGE = 0.8

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Computes the percentage of the context budget consumed by the prior context.
 *
 * Default: divide by the full context window. Opt-in (vscode-lm) divides by available input
 * (window minus reserved output); an unknown/unlimited reserve (maxTokens -1) falls back to the
 * full window. Shared by `willManageContext` and `manageContext` so the two stay in lockstep.
 */
function computeContextPercent({
	prevContextTokens,
	contextWindow,
	maxTokens,
	useAvailableInputForContextPercent,
}: {
	prevContextTokens: number
	contextWindow: number
	maxTokens?: number | null
	useAvailableInputForContextPercent?: boolean
}): number {
	if (!useAvailableInputForContextPercent) {
		return (100 * prevContextTokens) / contextWindow
	}
	const reservedForOutput = maxTokens && maxTokens > 0 ? maxTokens : 0
	const availableInputTokens = contextWindow - reservedForOutput
	return availableInputTokens > 0 ? (100 * prevContextTokens) / availableInputTokens : 100
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

function getVisibleMessageIndices(messages: ApiMessage[]): number[] {
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})
	return visibleIndices
}

async function estimateMessageTokens(message: ApiMessage, apiHandler: ApiHandler): Promise<number> {
	const content = message.content
	if (Array.isArray(content)) return estimateTokenCount(content, apiHandler)
	if (typeof content === "string") {
		return estimateTokenCount([{ type: "text", text: content }], apiHandler)
	}
	return 0
}

function applyTruncation(messages: ApiMessage[], messagesToRemove: number, taskId: string): TruncationResult {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)

	const truncationId = crypto.randomUUID()
	const visibleIndices = getVisibleMessageIndices(messages)
	const maxRemovable = Math.max(0, visibleIndices.length - 1)
	const boundedCount = Math.min(Math.max(0, messagesToRemove), maxRemovable)
	const evenCount = boundedCount - (boundedCount % 2)

	if (evenCount <= 0) {
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	const indicesToTruncate = new Set(visibleIndices.slice(1, evenCount + 1))
	const taggedMessages = messages.map((msg, index) =>
		indicesToTruncate.has(index) ? { ...msg, truncationParent: truncationId } : msg,
	)

	const firstKeptVisibleIndex = visibleIndices[evenCount + 1] ?? taggedMessages.length
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${evenCount} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	return {
		messages: [
			...taggedMessages.slice(0, firstKeptVisibleIndex),
			truncationMarker,
			...taggedMessages.slice(firstKeptVisibleIndex),
		],
		truncationId,
		messagesRemoved: evenCount,
	}
}

/**
 * Calculate the smallest oldest-history cut that should return the parent to a
 * comfortable point below its safe input budget.
 *
 * Unlike the old blind 50% fallback, this counts actual message tokens and
 * removes complete historical pairs until enough pressure has been relieved.
 * The original task message and the two newest visible messages are never
 * selected by this emergency fallback.
 */
export async function getAdaptiveTruncationMessageCount(
	messages: ApiMessage[],
	prevContextTokens: number,
	allowedTokens: number,
	apiHandler: ApiHandler,
): Promise<number> {
	if (prevContextTokens <= allowedTokens) return 0

	const visibleIndices = getVisibleMessageIndices(messages)
	// Preserve the first task message plus the latest two visible messages.
	const removable = Math.max(0, visibleIndices.length - 3)
	const maxEvenRemovable = removable - (removable % 2)
	if (maxEvenRemovable < 2) return 0

	const targetTokens = Math.max(0, allowedTokens * TRUNCATION_TARGET_PERCENTAGE)
	const tokensToRemove = Math.max(0, prevContextTokens - targetTokens)
	let removedTokens = 0

	for (let count = 2; count <= maxEvenRemovable; count += 2) {
		const firstIndex = visibleIndices[count - 1]
		const secondIndex = visibleIndices[count]
		if (firstIndex === undefined || secondIndex === undefined) break

		removedTokens += await estimateMessageTokens(messages[firstIndex]!, apiHandler)
		removedTokens += await estimateMessageTokens(messages[secondIndex]!, apiHandler)

		if (removedTokens >= tokensToRemove) return count
	}

	return maxEvenRemovable
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	const visibleIndices = getVisibleMessageIndices(messages)
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)
	return applyTruncation(messages, messagesToRemove, taskId)
}

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
	/**
	 * Opt-in (vscode-lm): measure the condense percentage against available input space
	 * (contextWindow - reserved output) instead of the full window. Others leave it undefined.
	 */
	useAvailableInputForContextPercent?: boolean
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
	useAvailableInputForContextPercent,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
		const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
		return prevContextTokens > allowedTokens
	}

	// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
	const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = computeContextPercent({
		prevContextTokens,
		contextWindow,
		maxTokens,
		useAvailableInputForContextPercent,
	})
	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Roo during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
	/**
	 * Opt-in (vscode-lm): measure the condense percentage against available input space
	 * (contextWindow - reserved output) instead of the full window. Others leave it undefined.
	 */
	useAvailableInputForContextPercent?: boolean
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
	useAvailableInputForContextPercent,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	// Calculate the maximum tokens reserved for response
	// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
	const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage.content
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold
		} else {
			// Invalid threshold value, fall back to global setting
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	if (autoCondenseContext) {
		const contextPercent = computeContextPercent({
			prevContextTokens,
			contextWindow,
			maxTokens,
			useAvailableInputForContextPercent,
		})
		if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the context
			const summarizeOptions = {
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd,
				rooIgnoreController,
			}
			let result = await summarizeConversation(summarizeOptions)

			// A single transient network/timeout/rate-limit/server failure should not
			// immediately amputate history. Retry exactly once; deterministic/no-op
			// condense failures fall through without retrying.
			if (result.error && result.retryable && !metadata?.abortSignal?.aborted) {
				console.warn(
					`[ContextManagement#${taskId}] Automatic condense failed transiently; retrying once before fallback truncation.`,
				)
				const firstFailure = result
				const retry = await summarizeConversation(summarizeOptions)
				result = {
					...retry,
					cost: firstFailure.cost + retry.cost,
					...(firstFailure.errorDetails && retry.errorDetails
						? {
								errorDetails: `First attempt:\n${firstFailure.errorDetails}\n\nRetry:\n${retry.errorDetails}`,
							}
						: {}),
				}
			}

			if (result.error) {
				error = result.error
				errorDetails = result.errorDetails
				cost = result.cost
			} else {
				return { ...result, prevContextTokens }
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		const messagesToRemove = await getAdaptiveTruncationMessageCount(
			messages,
			prevContextTokens,
			allowedTokens,
			apiHandler,
		)
		const truncationResult = applyTruncation(messages, messagesToRemove, taskId)

		// Calculate new context tokens after truncation by counting non-truncated messages
		// Messages with truncationParent are hidden, so we count only those without it
		const effectiveMessages = truncationResult.messages.filter(
			(msg) => !msg.truncationParent && !msg.isTruncationMarker,
		)

		// Include system prompt tokens so this value matches what we send to the API.
		// Note: `prevContextTokens` is computed locally here (totalTokens + lastMessageTokens).
		let newContextTokensAfterTruncation = await estimateTokenCount(
			[{ type: "text", text: systemPrompt }],
			apiHandler,
		)

		for (const msg of effectiveMessages) {
			const content = msg.content
			if (Array.isArray(content)) {
				newContextTokensAfterTruncation += await estimateTokenCount(content, apiHandler)
			} else if (typeof content === "string") {
				newContextTokensAfterTruncation += await estimateTokenCount(
					[{ type: "text", text: content }],
					apiHandler,
				)
			}
		}

		return {
			messages: truncationResult.messages,
			prevContextTokens,
			summary: "",
			cost,
			error,
			errorDetails,
			truncationId: truncationResult.truncationId,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
		}
	}
	// No truncation or condensation needed
	return { messages, summary: "", cost, prevContextTokens, error, errorDetails }
}
