import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"

import type { ToolName, ClineAsk, ToolProgressStatus } from "@roo-code/types"
import { ConsecutiveMistakeError, TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { customToolRegistry } from "@roo-code/core"

import { t } from "../../i18n"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse, ToolUse, McpToolUse, TextContent } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import { Task } from "../task/Task"

import { listFilesTool } from "../tools/ListFilesTool"
import { readFileTool } from "../tools/ReadFileTool"
import { readCommandOutputTool } from "../tools/ReadCommandOutputTool"
import { writeToFileTool } from "../tools/WriteToFileTool"
import { editTool } from "../tools/EditTool"
import { searchReplaceTool } from "../tools/SearchReplaceTool"
import { editFileTool } from "../tools/EditFileTool"
import { applyPatchTool } from "../tools/ApplyPatchTool"
import { searchFilesTool } from "../tools/SearchFilesTool"
import { executeCommandTool } from "../tools/ExecuteCommandTool"
import { useMcpToolTool } from "../tools/UseMcpToolTool"
import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { askFollowupQuestionTool } from "../tools/AskFollowupQuestionTool"
import { switchModeTool } from "../tools/SwitchModeTool"
import { attemptCompletionTool, AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import { newTaskTool } from "../tools/NewTaskTool"
import { parallelTasksTool } from "../tools/ParallelTasksTool"
import { updateTodoListTool } from "../tools/UpdateTodoListTool"
import { runSlashCommandTool } from "../tools/RunSlashCommandTool"
import { skillTool } from "../tools/SkillTool"
import { generateImageTool } from "../tools/GenerateImageTool"
import { applyDiffTool as applyDiffToolClass } from "../tools/ApplyDiffTool"
import { isValidToolName, validateToolUse } from "../tools/validateToolUse"
import { buildToolRequirements } from "../prompts/tools/effective-tool-policy"
import { codebaseSearchTool } from "../tools/CodebaseSearchTool"
import type { ToolResultContext } from "../tools/ProgressAwareLoopDetector"

import { decide as explorationDecide } from "../exploration/explorationPolicy"
import { deriveIndexAvailability, type IndexManagerLike } from "../exploration/indexAvailability"
import { detectKnownTarget } from "../exploration/knownTargetDetector"
import { getRetrievalGatewayClient } from "../exploration/gatewayClientProvider"
import { createRetrievalOutputBudget } from "../exploration/retrievalOutputBudget"
import {
	MAX_EVIDENCE_PACKET_ITEMS,
	type ExplorationPolicyInputs,
	type IndexAvailabilitySnapshot,
	type SemanticFinding,
} from "../exploration/types"
import { CodeIndexManagerRegistry } from "../../services/code-index/code-index-manager-registry"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { collectParallelReadBatch, isParallelRead, runReadBatch } from "./parallelReadTools"

/**
 * Broad-exploration tools that signal the model is surveying an unseen area of
 * the codebase (rather than acting on a known target). Used only to derive the
 * advisory `exploringUnseenArea` input for the ExplorationPolicy.
 */
const EXPLORATION_TOOLS: ReadonlySet<string> = new Set(["list_files", "search_files", "codebase_search"])

/**
 * Availability snapshot with all getters false, so `available` derives false.
 * Used when no live CodeIndexManager can be obtained for the workspace.
 */
const INDEX_UNAVAILABLE_SNAPSHOT: IndexAvailabilitySnapshot = {
	isConfigurationLoaded: false,
	isFeatureEnabled: false,
	isFeatureConfigured: false,
	isInitialized: false,
	state: "Standby",
	available: false,
}

/**
 * A resolved `read_file` target used only for advisory useful-hit detection:
 * the opened file path and, when the model supplied one, the 1-based inclusive
 * line range it requested. An absent range means a whole-file read.
 */
interface ReadFileTarget {
	path: string
	startLine?: number
	endLine?: number
}

/**
 * Defensively extract the opened file path and (optional) line range from a
 * `read_file` tool block. Prefers native typed args, falling back to the
 * string-shaped legacy params. Returns `undefined` when a single path cannot be
 * cleanly resolved (e.g. a batch/legacy multi-file read), so advisory metric
 * recording degrades gracefully rather than guessing.
 */
function extractReadFileTarget(block: ToolUse<"read_file">): ReadFileTarget | undefined {
	// Native protocol: typed args. Resolve only the single-path shapes; a
	// multi-file batch or legacy array read is skipped (returns undefined) so
	// advisory recording never guesses which of several files was useful.
	const native = block.nativeArgs
	if (native) {
		// The single-file shape carries a string `path`; the batch shape uses an
		// array and the legacy shape uses `files`. Only the first is resolvable here.
		if ("path" in native && typeof native.path === "string") {
			// `offset` is a 1-based start line; `limit` is a line count (slice mode).
			const startLine = typeof native.offset === "number" ? native.offset : undefined
			const endLine =
				startLine !== undefined && typeof native.limit === "number"
					? startLine + Math.max(0, native.limit - 1)
					: undefined
			return { path: native.path, startLine, endLine }
		}
		return undefined
	}

	// Legacy/string params: path plus optional numeric string line bounds.
	const path = block.params?.path
	if (typeof path !== "string" || path.length === 0) {
		return undefined
	}
	const parse = (value: string | undefined): number | undefined => {
		if (typeof value !== "string") {
			return undefined
		}
		const n = Number.parseInt(value, 10)
		return Number.isFinite(n) ? n : undefined
	}
	return {
		path,
		startLine: parse(block.params.start_line),
		endLine: parse(block.params.end_line),
	}
}

/**
 * Decide whether a `read_file` of `target` is a Useful_Semantic_Hit against a
 * prior semantic `finding` (Req 7, "Useful_Semantic_Hit"): the same file and,
 * when both sides supply a line range, an overlapping range. A whole-file read
 * (no requested range) counts as overlapping any finding in that file.
 */
function isUsefulReadOverlap(target: ReadFileTarget, finding: SemanticFinding): boolean {
	if (target.path !== finding.file) {
		return false
	}
	// Whole-file read, or no usable requested bounds → treat as overlapping.
	if (target.startLine === undefined || target.endLine === undefined) {
		return true
	}
	// Standard inclusive-range overlap test.
	return target.startLine <= finding.endLine && finding.startLine <= target.endLine
}

/**
 * Maps a raw, potentially model-controlled tool name to a safe analytics key.
 * Never returns the raw name unless it is a known static tool, so an
 * arbitrary model-supplied string can never become a `toolsUsed` property key.
 */
export function toTelemetryToolName(
	toolName: string,
	isCustomTool: boolean,
	experiments?: Record<string, boolean>,
): ToolName {
	if (isCustomTool) {
		return "custom_tool"
	}

	if (toolName.startsWith("mcp_")) {
		return "use_mcp_tool"
	}

	if (isValidToolName(toolName, experiments)) {
		return toolName
	}

	return "invalid_tool_call"
}

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		return
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false

	if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}

		cline.presentAssistantMessageLocked = false
		return
	}

	let block: ToolUse | McpToolUse | TextContent
	try {
		// Performance optimization: Use shallow copy instead of deep clone.
		// The block is used read-only throughout this function - we never mutate its properties.
		// We only need to protect against the reference changing during streaming, not nested mutations.
		// This provides 80-90% reduction in cloning overhead (5-100ms saved per block).
		block = { ...cline.assistantMessageContent[cline.currentStreamingContentIndex] }
	} catch (error) {
		console.error(`ERROR cloning block:`, error)
		console.error(
			`Block content:`,
			JSON.stringify(cline.assistantMessageContent[cline.currentStreamingContentIndex], null, 2),
		)
		cline.presentAssistantMessageLocked = false
		return
	}

	let consumed = 1
	try {
		const state = await cline.providerRef.deref()?.getState()
		if (state?.experiments?.parallelToolExecution && isParallelRead(block)) {
			// Wait for the complete response so later calls are visible and the assistant
			// history is durable before a concurrent batch can publish tool results.
			if (!cline.didCompleteReadingStream) return
			if (!(await cline.waitForCurrentAssistantMessagePersistence())) return
			const plan = collectParallelReadBatch(
				cline.assistantMessageContent.slice(cline.currentStreamingContentIndex),
			)
			if (!plan.tools.length) return
			consumed = plan.consumed
			for (const text of plan.text) {
				await executeAssistantMessageBlock(cline, text)
			}
			cline.parallelToolBatch = true
			try {
				await runReadBatch(
					plan.tools,
					async (item) => {
						await executeAssistantMessageBlock(cline, item)
						if (
							item.id &&
							!cline.userMessageContent.some(
								(result) =>
									result.type === "tool_result" && result.tool_use_id === sanitizeToolUseId(item.id!),
							)
						) {
							throw new Error("Read tool returned without a result")
						}
					},
					(item, error) => {
						if (item.id)
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(item.id),
								is_error: true,
								content: `Read tool failed: ${String(error)}`,
							})
					},
					() => cline.abort || cline.didRejectTool,
				)
			} finally {
				cline.parallelToolBatch = false
			}
		} else {
			await executeAssistantMessageBlock(cline, block)
		}
	} finally {
		cline.presentAssistantMessageLocked = false
	}

	// Seeing out of bounds is fine, it means that the next too call is being
	// built up and ready to add to assistantMessageContent to present.
	// When you see the UI inactive during this, it means that a tool is
	// breaking without presenting any UI. For example the write_to_file tool
	// was breaking when relpath was undefined, and for invalid relpath it never
	// presented UI.
	// This needs to be placed here, if not then calling
	// cline.presentAssistantMessage below would fail (sometimes) since it's
	// locked.
	cline.presentAssistantMessageLocked = false

	// NOTE: When tool is rejected, iterator stream is interrupted and it waits
	// for `userMessageContentReady` to be true. Future calls to present will
	// skip execution since `didRejectTool` and iterate until `contentIndex` is
	// set to message length and it sets userMessageContentReady to true itself
	// (instead of preemptively doing it in iterator).
	if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
		// Block is finished streaming and executing.
		if (cline.currentStreamingContentIndex + consumed >= cline.assistantMessageContent.length) {
			// It's okay that we increment if !didCompleteReadingStream, it'll
			// just return because out of bounds and as streaming continues it
			// will call `presentAssitantMessage` if a new block is ready. If
			// streaming is finished then we set `userMessageContentReady` to
			// true when out of bounds. This gracefully allows the stream to
			// continue on and all potential content blocks be presented.
			// Last block is complete and it is finished executing
			cline.userMessageContentReady = true // Will allow `pWaitFor` to continue.
		}

		// Call next block if it exists (if not then read stream will call it
		// when it's ready).
		// Need to increment regardless, so when read stream calls this function
		// again it will be streaming the next block.
		cline.currentStreamingContentIndex += consumed

		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			// There are already more content blocks to stream, so we'll call
			// this function ourselves.
			return presentAssistantMessage(cline)
		} else {
			// CRITICAL FIX: If we're out of bounds and the stream is complete, set userMessageContentReady
			// This handles the case where assistantMessageContent is empty or becomes empty after processing
			if (cline.didCompleteReadingStream) {
				cline.userMessageContentReady = true
			}
		}
	}

	// Block is partial, but the read stream may have finished.
	if (cline.presentAssistantMessageHasPendingUpdates) {
		return presentAssistantMessage(cline)
	}
}

export async function executeAssistantMessageBlock(
	cline: Task,
	block: ToolUse | McpToolUse | TextContent,
): Promise<void> {
	switch (block.type) {
		case "mcp_tool_use": {
			// Handle native MCP tool calls (from mcp_serverName_toolName dynamic tools)
			// These are converted to the same execution path as use_mcp_tool but preserve
			// their original name in API history
			const mcpBlock = block as McpToolUse

			if (cline.didRejectTool) {
				// For native protocol, we must send a tool_result for every tool_use to avoid API errors
				const toolCallId = mcpBlock.id
				const errorMessage = !mcpBlock.partial
					? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
					: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

				if (toolCallId) {
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: errorMessage,
						is_error: true,
					})
				}
				break
			}

			// Track if we've already pushed a tool result
			let hasToolResult = false
			const toolCallId = mcpBlock.id

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse, feedbackImages?: string[]) => {
				if (hasToolResult) {
					console.warn(
						`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`

					// Add feedback images to the image blocks
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				if (toolCallId) {
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: resultContent,
					})

					if (imageBlocks.length > 0) {
						cline.userMessageContent.push(...imageBlocks)
					}
				}

				hasToolResult = true
			}

			const toolDescription = () => `[mcp_tool: ${mcpBlock.serverName}/${mcpBlock.toolName}]`

			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images } = await cline.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					if (text) {
						await cline.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					cline.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (text) {
					await cline.say("user_feedback", text, images)
					approvalFeedback = { text, images }
				}

				return true
			}

			const handleError = async (action: string, error: Error) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
				await cline.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)
				pushToolResult(formatResponse.toolError(errorString))
			}

			// Any throw from dispatch must still answer this tool_use, or the turn never settles.
			try {
				// Resolve sanitized server name back to original server name
				// The serverName from parsing is sanitized (e.g., "my_server" from "my server")
				// We need the original name to find the actual MCP connection
				const mcpHub = cline.providerRef.deref()?.getMcpHub()
				let resolvedServerName = mcpBlock.serverName
				if (mcpHub) {
					const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
					if (originalName) {
						resolvedServerName = originalName
					}
				}

				// Execute the MCP tool using the same handler as use_mcp_tool
				// Create a synthetic ToolUse block that the useMcpToolTool can handle
				const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
					type: "tool_use",
					id: mcpBlock.id,
					name: "use_mcp_tool",
					params: {
						server_name: resolvedServerName,
						tool_name: mcpBlock.toolName,
						arguments: JSON.stringify(mcpBlock.arguments),
					},
					partial: mcpBlock.partial,
					nativeArgs: {
						server_name: resolvedServerName,
						tool_name: mcpBlock.toolName,
						arguments: mcpBlock.arguments,
					},
				}

				await useMcpToolTool.handle(cline, syntheticToolUse, {
					askApproval,
					handleError,
					pushToolResult,
					onValidated: mcpBlock.partial
						? undefined
						: () => {
								cline.recordToolUsage("use_mcp_tool")
								TelemetryService.instance.captureToolUsage(cline.taskId, "use_mcp_tool")
							},
				})
			} catch (error) {
				// Abort signals ("[RooCode#say] … aborted") must keep propagating.
				if (cline.abort || (error instanceof Error && error.message.endsWith("aborted"))) {
					throw error
				}
				if (error instanceof AskIgnoredError) {
					return
				}
				// The finalized block is re-presented and answers its own tool_use_id.
				if (mcpBlock.partial) {
					console.warn(
						`[presentAssistantMessage] task ${cline.taskId}: ${mcpBlock.name} threw while partial`,
						error,
					)
					return
				}
				const err = error instanceof Error ? error : new Error(String(error))
				console.error(`[presentAssistantMessage] task ${cline.taskId}: ${mcpBlock.name} threw`, err)
				cline.consecutiveMistakeCount++
				cline.recordToolError("use_mcp_tool", err.message)
				cline.didToolFailInCurrentTurn = true
				await handleError(`executing ${mcpBlock.name}`, err)
			}
			break
		}
		case "text": {
			if (cline.didRejectTool || cline.didAlreadyUseTool) {
				break
			}

			let content = block.content

			if (content) {
				// Have to do this for partial and complete since sending
				// content in thinking tags to markdown renderer will
				// automatically be removed.
				// Strip any streamed <thinking> tags from text output.
				content = content.replace(/<thinking>\s?/g, "")
				content = content.replace(/\s?<\/thinking>/g, "")
			}

			await cline.say("text", content, undefined, block.partial)
			break
		}
		case "tool_use": {
			// Native tool calling is the only supported tool calling mechanism.
			// A tool_use block without an id is invalid and cannot be executed.
			const toolCallId = (block as any).id as string | undefined
			if (!toolCallId) {
				const errorMessage =
					"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
				// Record a safe, static analytics key. Never key telemetry on the
				// model-reported tool name, which is untrusted here.
				try {
					cline.recordToolError("invalid_tool_call", errorMessage)
				} catch {
					// Best-effort only
				}
				cline.consecutiveMistakeCount++
				await cline.say("error", errorMessage)
				cline.userMessageContent.push({ type: "text", text: errorMessage })
				cline.didAlreadyUseTool = true
				break
			}

			// Shared provider state supplies global settings; mode is owned by the task.
			const state = await cline.providerRef.deref()?.getState()
			const { customModes, experiments: stateExperiments } = state ?? {}
			const disabledTools = cline.parallelWorker
				? [...(state?.disabledTools ?? []), "new_task", "parallel_tasks"]
				: state?.disabledTools
			// Read the task-local mode, not the shared provider mode.
			// A delegated child task may run in a different mode than its parent.
			const taskMode = await cline.getTaskMode()

			// Safe analytics key for this call. Never key telemetry on the raw,
			// model-controlled tool name.
			const isCustomTool = Boolean(stateExperiments?.customTools && customToolRegistry.has(block.name))
			const telemetryToolName = toTelemetryToolName(block.name, isCustomTool, stateExperiments)

			const toolDescription = (): string => {
				switch (block.name) {
					case "execute_command":
						return `[${block.name} for '${block.params.command}']`
					case "read_file":
						// Prefer native typed args when available; fall back to legacy params
						// Check if nativeArgs exists (native protocol)
						if (block.nativeArgs) {
							return readFileTool.getReadFileToolDescription(
								block.name,
								"path" in block.nativeArgs ? { path: block.nativeArgs.path } : {},
							)
						}
						return readFileTool.getReadFileToolDescription(block.name, block.params)
					case "write_to_file":
						return `[${block.name} for '${block.params.path}']`
					case "apply_diff":
						// Native-only: tool args are structured (no XML payloads).
						return block.params?.path ? `[${block.name} for '${block.params.path}']` : `[${block.name}]`
					case "search_files":
						return `[${block.name} for '${block.params.regex}'${
							block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
						}]`
					case "edit":
					case "search_and_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "search_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "edit_file":
						return `[${block.name} for '${block.params.file_path}']`
					case "apply_patch":
						return `[${block.name}]`
					case "list_files":
						return `[${block.name} for '${block.params.path}']`
					case "use_mcp_tool":
						return `[${block.name} for '${block.params.server_name}']`
					case "access_mcp_resource":
						return `[${block.name} for '${block.params.server_name}']`
					case "ask_followup_question":
						return `[${block.name} for '${block.params.question}']`
					case "attempt_completion":
						return `[${block.name}]`
					case "switch_mode":
						return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
					case "codebase_search":
						return `[${block.name} for '${block.params.query}']`
					case "read_command_output":
						return `[${block.name} for '${block.params.artifact_id}']`
					case "update_todo_list":
						return `[${block.name}]`
					case "new_task": {
						const mode = block.params.mode ?? defaultModeSlug
						const message = block.params.message ?? "(no message)"
						const modeName = getModeBySlug(mode, customModes)?.name ?? mode
						return `[${block.name} in ${modeName} mode: '${message}']`
					}
					case "run_slash_command":
						return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "skill":
						return `[${block.name} for '${block.params.skill}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "generate_image":
						return `[${block.name} for '${block.params.path}']`
					default:
						return `[${block.name}]`
				}
			}

			if (cline.didRejectTool) {
				// Ignore any tool content after user has rejected tool once.
				// For native tool calling, we must send a tool_result for every tool_use to avoid API errors
				const errorMessage = !block.partial
					? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
					: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

				cline.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(toolCallId),
					content: errorMessage,
					is_error: true,
				})

				break
			}

			// Track if we've already pushed a tool result for this tool call (native tool calling only)
			let hasToolResult = false

			// If this is a native tool call but the parser couldn't construct nativeArgs
			// (e.g., malformed/unfinished JSON in a streaming tool call), we must NOT attempt to
			// execute the tool. Instead, emit exactly one structured tool_result so the provider
			// receives a matching tool_result for the tool_use_id.
			//
			// This avoids executing an invalid tool_use block and prevents duplicate/fragmented
			// error reporting.
			if (!block.partial) {
				const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
				const isKnownTool = isValidToolName(String(block.name), stateExperiments)
				if (isKnownTool && !block.nativeArgs && !customTool) {
					if (block.name === "parallel_tasks") cline.parallelTaskArgumentRecovery.onMalformedCall()
					const errorMessage =
						`Invalid tool call for '${block.name}': missing nativeArgs. ` +
						(block.name === "parallel_tasks"
							? `The call had no valid tasks array. Retry parallel_tasks alone with 1–4 independent tasks, each with name, mode, message, and todos (use null if no checklist is needed). Example: {"tasks":[{"name":"first","mode":"code","message":"Implement the first independent scope and report changed files.","todos":null},{"name":"second","mode":"architect","message":"Review the second independent scope and report findings.","todos":null}]}. Do not fall back to one new_task merely because this call was malformed.`
							: `This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`)

					cline.consecutiveMistakeCount++
					try {
						cline.recordToolError(toTelemetryToolName(block.name, false, stateExperiments), errorMessage)
					} catch {
						// Best-effort only
					}

					// Push tool_result directly without setting didAlreadyUseTool so streaming can
					// continue gracefully.
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: formatResponse.toolError(errorMessage),
						is_error: true,
					})

					break
				}
			}

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse) => {
				// Native tool calling: only allow ONE tool_result per tool call
				if (hasToolResult) {
					console.warn(
						`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				cline.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(toolCallId),
					content: resultContent,
				})

				if (imageBlocks.length > 0) {
					cline.userMessageContent.push(...imageBlocks)
				}

				// Post-execution signal capture for progress-aware loop detection (two-call protocol).
				// The pre-execution gate already ran via check(block); this supplies the observable
				// result so the detector can score progress/stagnation for the next gate. `block` is
				// in scope from the enclosing per-tool iteration.
				try {
					const detectorContext: ToolResultContext = {
						resultText: resultContent,
						workspaceChanged: cline.didEditFile === true || undefined,
					}
					cline.toolRepetitionDetector.recordResult(
						block,
						{ ok: true, body: resultContent },
						detectorContext,
					)
				} catch {
					// Signal capture must never break tool dispatch.
				}

				hasToolResult = true
			}

			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images, queuedMessageId } = await cline.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					// Handle both messageResponse and noButtonClicked with text.
					if (queuedMessageId) {
						const persisted = await cline.persistQueuedFeedbackAndAcknowledge(queuedMessageId, text, images)
						if (!persisted) {
							throw new Error(`Failed to persist queued approval feedback ${queuedMessageId}`)
						}
					} else if (text || images?.length) {
						await cline.say("user_feedback", text ?? "", images)
					}
					if (text || images?.length) {
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					cline.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (queuedMessageId) {
					const persisted = await cline.persistQueuedFeedbackAndAcknowledge(queuedMessageId, text, images)
					if (!persisted) {
						throw new Error(`Failed to persist queued approval feedback ${queuedMessageId}`)
					}
				} else if (text || images?.length) {
					await cline.say("user_feedback", text ?? "", images)
				}
				if (text || images?.length) {
					approvalFeedback = { text: text ?? "", images }
				}

				return true
			}

			const askFinishSubTaskApproval = async () => {
				// Ask the user to approve this task has completed, and he has
				// reviewed it, and we can declare task is finished and return
				// control to the parent task to continue running the rest of
				// the sub-tasks.
				const toolMessage = JSON.stringify({ tool: "finishTask" })
				return await askApproval("tool", toolMessage)
			}

			const handleError = async (action: string, error: Error) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

				await cline.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)

				pushToolResult(formatResponse.toolError(errorString))
			}

			// Validate tool use before execution - ONLY for complete (non-partial) blocks.
			// Validating partial blocks would cause validation errors to be thrown repeatedly
			// during streaming, pushing multiple tool_results for the same tool_use_id and
			// potentially causing the stream to appear frozen.
			if (!block.partial) {
				const modelInfo = cline.api.getModel()
				// Resolve aliases in includedTools before validation
				// e.g., "edit_file" should resolve to "apply_diff"
				const rawIncludedTools = modelInfo?.info?.includedTools
				const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
				const includedTools = rawIncludedTools?.map((tool) => resolveToolAlias(tool))

				try {
					// Build requirements through the shared policy module so every suppressed
					// entry — disabled tools, and an excluded or disabled protocol tool — reaches
					// the validator, which checks them before the always-available class. See
					// `buildToolRequirements` in effective-tool-policy.ts.
					const toolRequirements = buildToolRequirements(disabledTools, modelInfo?.info)

					validateToolUse(
						block.name as ToolName,
						taskMode,
						customModes ?? [],
						toolRequirements,
						block.params,
						stateExperiments,
						includedTools,
					)
				} catch (error) {
					cline.consecutiveMistakeCount++
					// For validation errors (unknown tool, tool not allowed for mode), we need to:
					// 1. Send a tool_result with the error (required for native tool calling)
					// 2. NOT set didAlreadyUseTool = true (the tool was never executed, just failed validation)
					// This prevents the stream from being interrupted with "Response interrupted by tool use result"
					// which would cause the extension to appear to hang
					const errorContent = formatResponse.toolError(error.message)
					// Push tool_result directly without setting didAlreadyUseTool
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: typeof errorContent === "string" ? errorContent : "(validation error)",
						is_error: true,
					})

					// Record a safe failure key. Never key telemetry on the raw,
					// model-controlled tool name.
					cline.recordToolError(telemetryToolName, error.message)

					break
				}

				// Validation passed: record exactly one attempt at this single
				// central point. Individual tool handlers must not also record
				// usage, or the attempt would be double-counted.
				const recordName = telemetryToolName
				cline.recordToolUsage(recordName)
				TelemetryService.instance.captureToolUsage(cline.taskId, recordName)

				// Track legacy format usage for read_file tool (for migration monitoring)
				if (block.name === "read_file" && block.usedLegacyFormat) {
					TelemetryService.instance.captureEvent(TelemetryEventName.READ_FILE_LEGACY_FORMAT_USED, {
						taskId: cline.taskId,
						model: modelInfo?.id,
					})
				}

				// Advisory ExplorationPolicy hook. The decision is ADVISORY ONLY: dispatch
				// always proceeds with the model's chosen tool below and is NEVER blocked.
				// The whole hook is wrapped so any error is swallowed and never reaches the
				// dispatch path (the policy must never block or throw into dispatch).
				try {
					// Live index availability: derive from the workspace's CodeIndexManager,
					// or fall back to an all-false snapshot (available: false) when none exists.
					let indexAvailability: IndexAvailabilitySnapshot = INDEX_UNAVAILABLE_SNAPSHOT
					const context = cline.providerRef.deref()?.context
					if (context) {
						const manager = CodeIndexManagerRegistry.getOrCreate(context, cline.workspacePath)
						if (manager) {
							// CodeIndexManager structurally satisfies IndexManagerLike
							// (four getters + state).
							indexAvailability = deriveIndexAvailability(manager as IndexManagerLike)
						}
					}

					// Gateway health: an injected RetrievalGatewayClient drives
					// `gatewayAvailable`. No client wired → `false` (safe default that
					// never forces PreferSemantic). `isAvailable()` never throws.
					const gatewayClient = getRetrievalGatewayClient()
					const gatewayAvailable = gatewayClient ? await gatewayClient.isAvailable() : false

					const inputs: ExplorationPolicyInputs = {
						indexAvailability,
						gatewayAvailable,
						knownTarget: detectKnownTarget({ userInstruction: cline.metadata?.task }),
						exploringUnseenArea: EXPLORATION_TOOLS.has(block.name),
					}

					const explorationDecision = explorationDecide(inputs)

					// Record the dominant unavailability metric advisorily. This never
					// affects dispatch; the recorder is best-effort and swallows errors.
					const metrics = cline.semanticExplorationState.metrics
					if (explorationDecision.metricEvent === "index-unavailable") {
						metrics.recordIndexUnavailable()
					} else if (explorationDecision.metricEvent === "gateway-unavailable") {
						metrics.recordGatewayUnavailable()
					}

					// On a PreferSemantic decision with a wired gateway, obtain evidence
					// through the gateway and surface it COMPACTLY via the output budget
					// (file/line-range/score/one-line-reason only). This is additive and
					// advisory: it never blocks dispatch and never touches the
					// CodebaseSearchTool output contract (Req 6.5, 8.1, 8.2, 8.4). Large
					// snippets are retained worker-local, never injected into the parent.
					if (explorationDecision.outcome === "PreferSemantic" && gatewayClient) {
						// Prefer the model's own semantic query when it issued one; else
						// fall back to the task description.
						const query =
							(block.name === "codebase_search" ? block.params.query : undefined) ??
							cline.metadata?.task ??
							""
						const packet = await gatewayClient.retrieve(
							query,
							cline.workspacePath,
							"exploration",
							MAX_EVIDENCE_PACKET_ITEMS,
						)
						const budget = createRetrievalOutputBudget()
						const surfaced = budget.surfaceToParent(packet)
						budget.retainWorkerLocal(packet)
						metrics.recordSemanticQuery()
						metrics.recordFilesReturned(surfaced.length)
					}
				} catch {
					// Advisory only — any failure here must never affect dispatch.
				}

				// Advisory read-file metric recording (Req 7.3–7.5, 7.9, 7.11). Purely
				// additive and wrapped so a recorder error never affects dispatch. On a
				// targeted `read_file`, record a file-open and a raw read, flagging the
				// raw read as preceded by a useful hit when the opened file+range overlaps
				// a prior semantic finding for this task (cache or shared memory). The
				// first such overlap also marks the time-to-first-useful-evidence.
				//
				// Token accounting (Req 7.6) is intentionally out of scope at this layer:
				// the dispatch layer does not have a cheap, accurate token count for the
				// bytes a `read_file` will consume (that is known downstream inside the
				// read tool). It is left to the consuming layer rather than fabricated here.
				//
				// Index-freshness-miss recording (Req 7, 12.4) is driven by the
				// change-aware consumer (`applyChangeAwarePreference`) against a known
				// changed-files set, which is not readily available at this dispatch layer;
				// it is covered by that consumer and its own tests.
				if (block.name === "read_file") {
					try {
						const metrics = cline.semanticExplorationState.metrics
						metrics.recordFileOpened()

						const read = extractReadFileTarget(block as ToolUse<"read_file">)
						const findings = [
							...cline.semanticExplorationState.cache.allFindings(),
							...cline.semanticExplorationState.sharedMemory.allFindings(),
						]
						const precededByUsefulHit =
							read !== undefined && findings.some((f) => isUsefulReadOverlap(read, f))

						metrics.recordRawRead(precededByUsefulHit)
						if (precededByUsefulHit) {
							metrics.recordUsefulHit()
							metrics.markFirstUsefulEvidence(Date.now())
						}
					} catch {
						// Advisory only — any failure here must never affect dispatch.
					}
				}
			}

			// Any throw from dispatch must still answer this tool_use, or the turn never settles.
			try {
				// Check for identical consecutive tool calls.
				if (!block.partial) {
					// Use the detector to check for repetition, passing the ToolUse
					// block directly.
					const repetitionCheck = cline.toolRepetitionDetector.check(block)

					// First repeats past the limit are skipped with an error result, so the model can
					// move on without a user ask. This is not a tool failure or a mistake.
					if (repetitionCheck.nudge) {
						cline.recordToolError(telemetryToolName, "repetition_nudge")
						pushToolResult(
							formatResponse.toolError(
								formatResponse.toolRepetitionNudge(block.name, repetitionCheck.nudge.repeatCount),
							),
						)
						break
					}

					// If the model kept repeating after the nudges, escalate and break.
					if (repetitionCheck.askUser) {
						// Track tool repetition in telemetry via PostHog exception tracking and event.
						const captureRepetitionTelemetry = () => {
							TelemetryService.instance.captureConsecutiveMistakeError(cline.taskId)
							TelemetryService.instance.captureException(
								new ConsecutiveMistakeError(
									`Tool repetition limit reached for ${block.name}`,
									cline.taskId,
									cline.consecutiveMistakeCount,
									cline.consecutiveMistakeLimit,
									"tool_repetition",
									cline.apiConfiguration.apiProvider,
									cline.api.getModel().id,
								),
							)
						}
						const repetitionLimitError = formatResponse.toolError(
							`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
						)

						// Nobody answers a parallel worker's ask: fail the worker instead.
						// Answer the tool_use first; failParallelWorker aborts the task.
						if (cline.parallelWorker) {
							captureRepetitionTelemetry()
							pushToolResult(repetitionLimitError)
							await cline.failParallelWorker(
								t("tools:toolRepetitionLimitReached", { toolName: block.name }),
							)
							break
						}

						// Handle repetition similar to mistake_limit_reached pattern.
						const { response, text, images } = await cline.ask(
							repetitionCheck.askUser.messageKey as ClineAsk,
							repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
						)

						if (response === "messageResponse") {
							// Add user feedback to userContent.
							cline.userMessageContent.push(
								{
									type: "text" as const,
									text: `Tool repetition limit reached. User feedback: ${text}`,
								},
								...formatResponse.imageBlocks(images),
							)

							// Add user feedback to chat.
							await cline.say("user_feedback", text, images)
						}

						captureRepetitionTelemetry()

						// Return tool result message about the repetition
						pushToolResult(repetitionLimitError)
						break
					}
				}

				switch (block.name) {
					case "parallel_tasks":
						await parallelTasksTool.handle(cline, block as ToolUse<"parallel_tasks">, {
							askApproval,
							handleError,
							pushToolResult,
							toolCallId,
						})
						break
					case "write_to_file":
						await checkpointSaveAndMark(cline)
						await writeToFileTool.handle(cline, block as ToolUse<"write_to_file">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "update_todo_list":
						await updateTodoListTool.handle(cline, block as ToolUse<"update_todo_list">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "apply_diff":
						await checkpointSaveAndMark(cline)
						await applyDiffToolClass.handle(cline, block as ToolUse<"apply_diff">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "edit":
					case "search_and_replace":
						await checkpointSaveAndMark(cline)
						await editTool.handle(cline, block as ToolUse<"edit">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "search_replace":
						await checkpointSaveAndMark(cline)
						await searchReplaceTool.handle(cline, block as ToolUse<"search_replace">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "edit_file":
						await checkpointSaveAndMark(cline)
						await editFileTool.handle(cline, block as ToolUse<"edit_file">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "apply_patch":
						await checkpointSaveAndMark(cline)
						await applyPatchTool.handle(cline, block as ToolUse<"apply_patch">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "read_file":
						// Type assertion is safe here because we're in the "read_file" case
						await readFileTool.handle(cline, block as ToolUse<"read_file">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "list_files":
						await listFilesTool.handle(cline, block as ToolUse<"list_files">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "codebase_search":
						await codebaseSearchTool.handle(cline, block as ToolUse<"codebase_search">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "search_files":
						await searchFilesTool.handle(cline, block as ToolUse<"search_files">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "execute_command":
						await executeCommandTool.handle(cline, block as ToolUse<"execute_command">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "read_command_output":
						await readCommandOutputTool.handle(cline, block as ToolUse<"read_command_output">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "use_mcp_tool":
						await useMcpToolTool.handle(cline, block as ToolUse<"use_mcp_tool">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "access_mcp_resource":
						await accessMcpResourceTool.handle(cline, block as ToolUse<"access_mcp_resource">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "ask_followup_question":
						await askFollowupQuestionTool.handle(cline, block as ToolUse<"ask_followup_question">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "switch_mode":
						await switchModeTool.handle(cline, block as ToolUse<"switch_mode">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "new_task":
						await checkpointSaveAndMark(cline)
						await newTaskTool.handle(cline, block as ToolUse<"new_task">, {
							askApproval,
							handleError,
							pushToolResult,
							toolCallId: block.id,
						})
						break
					case "attempt_completion": {
						const completionCallbacks: AttemptCompletionCallbacks = {
							askApproval,
							handleError,
							pushToolResult,
							askFinishSubTaskApproval,
							toolDescription,
							toolCallId: block.id,
						}
						await attemptCompletionTool.handle(
							cline,
							block as ToolUse<"attempt_completion">,
							completionCallbacks,
						)
						break
					}
					case "run_slash_command":
						await runSlashCommandTool.handle(cline, block as ToolUse<"run_slash_command">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "skill":
						await skillTool.handle(cline, block as ToolUse<"skill">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					case "generate_image":
						await checkpointSaveAndMark(cline)
						await generateImageTool.handle(cline, block as ToolUse<"generate_image">, {
							askApproval,
							handleError,
							pushToolResult,
						})
						break
					default: {
						// Handle unknown/invalid tool names OR custom tools
						// This is critical for native tool calling where every tool_use MUST have a tool_result

						// CRITICAL: Don't process partial blocks for unknown tools - just let them stream in.
						// If we try to show errors for partial blocks, we'd show the error on every streaming chunk,
						// creating a loop that appears to freeze the extension. Only handle complete blocks.
						if (block.partial) {
							break
						}

						const customTool = stateExperiments?.customTools
							? customToolRegistry.get(block.name)
							: undefined

						if (customTool) {
							try {
								let customToolArgs

								if (customTool.parameters) {
									try {
										customToolArgs = customTool.parameters.parse(
											block.nativeArgs || block.params || {},
										)
									} catch (parseParamsError) {
										const message = `Custom tool "${block.name}" argument validation failed: ${parseParamsError.message}`
										console.error(message)
										cline.consecutiveMistakeCount++
										await cline.say("error", message)
										pushToolResult(formatResponse.toolError(message))
										break
									}
								}

								const result = await customTool.execute(customToolArgs, {
									mode: taskMode,
									task: cline,
								})

								console.log(
									`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`,
								)

								pushToolResult(result)
								cline.consecutiveMistakeCount = 0
							} catch (executionError: any) {
								cline.consecutiveMistakeCount++
								// Record custom tool error with static name
								cline.recordToolError("custom_tool", executionError.message)
								await handleError(`executing custom tool "${block.name}"`, executionError)
							}

							break
						}

						// Not a custom tool - handle as unknown tool error
						const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
						cline.consecutiveMistakeCount++
						cline.recordToolError("invalid_tool_call", errorMessage)
						await cline.say("error", t("tools:unknownToolError", { toolName: block.name }))
						// Push tool_result directly WITHOUT setting didAlreadyUseTool
						// This prevents the stream from being interrupted with "Response interrupted by tool use result"
						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: formatResponse.toolError(errorMessage),
							is_error: true,
						})
						break
					}
				}
			} catch (error) {
				// Abort signals ("[RooCode#say] … aborted") must keep propagating.
				if (cline.abort || (error instanceof Error && error.message.endsWith("aborted"))) {
					throw error
				}
				if (error instanceof AskIgnoredError) {
					return
				}
				// A partial block is re-presented when finalized; answering it now would
				// let the tool_use_id dedupe drop the finalized block's real result.
				if (block.partial) {
					console.warn(
						`[presentAssistantMessage] task ${cline.taskId}: ${block.name} threw while partial`,
						error,
					)
					return
				}
				const err = error instanceof Error ? error : new Error(String(error))
				console.error(`[presentAssistantMessage] task ${cline.taskId}: ${block.name} threw`, err)
				cline.consecutiveMistakeCount++
				cline.recordToolError(telemetryToolName, err.message)
				cline.didToolFailInCurrentTurn = true
				await handleError(`executing ${block.name}`, err)
			}

			break
		}
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	}
}
