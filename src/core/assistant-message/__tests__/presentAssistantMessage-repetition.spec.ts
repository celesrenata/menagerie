// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-repetition.spec.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { readFileTool } from "../../tools/ReadFileTool"
import type { ToolRepetitionCheckResult } from "../../tools/ToolRepetitionDetector"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import { t } from "../../../i18n"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		["read_file", "write_to_file", "ask_followup_question", "attempt_completion", "use_mcp_tool"].includes(
			toolName,
		),
	),
}))

// Mock custom tool registry - must be done inline without external variable references
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
}))

// presentAssistantMessage records tool usage and repetition escalations through TelemetryService.instance.
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: { handle: vi.fn(), getReadFileToolDescription: vi.fn(() => "[read_file]") },
}))

import { customToolRegistry } from "@roo-code/core"
import { TelemetryService } from "@roo-code/telemetry"

type UserContent = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam

/** The subset of Task that presentAssistantMessage touches on the repetition paths. */
interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: ToolUse[]
	userMessageContent: UserContent[]
	didCompleteReadingStream: boolean
	userMessageContentReady: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	didToolFailInCurrentTurn: boolean
	consecutiveMistakeCount: number
	consecutiveMistakeLimit: number
	parallelWorker: boolean
	apiConfiguration: { apiProvider: string }
	getTaskMode: ReturnType<typeof vi.fn>
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn<(block: ToolUse) => ToolRepetitionCheckResult>> }
	providerRef: { deref: () => { getState: () => Promise<unknown> } }
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	failParallelWorker: ReturnType<typeof vi.fn<(reason: string) => Promise<void>>>
	pushToolResultToUserContent: (toolResult: Anthropic.ToolResultBlockParam) => boolean
}

function makeTask(experiments: Record<string, boolean> = {}): MockTask {
	const task: MockTask = {
		taskId: "t",
		instanceId: "i",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: true,
		userMessageContentReady: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		didToolFailInCurrentTurn: false,
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 3,
		parallelWorker: false,
		apiConfiguration: { apiProvider: "test-provider" },
		getTaskMode: vi.fn().mockResolvedValue("code"),
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn<(block: ToolUse) => ToolRepetitionCheckResult>() },
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], experiments }),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		// Mirrors the real post-condition: a failed worker is aborted.
		failParallelWorker: vi.fn(async (_reason: string) => {
			task.abort = true
		}),
		pushToolResultToUserContent: (toolResult) => {
			const exists = task.userMessageContent.some(
				(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (exists) return false
			task.userMessageContent.push(toolResult)
			return true
		},
	}
	return task
}

// Double cast: the mock satisfies only the members presentAssistantMessage reads on these paths.
const asTask = (task: MockTask): Task => task as unknown as Task

const readBlock = (id: string): ToolUse<"read_file"> => ({
	type: "tool_use",
	id,
	name: "read_file",
	params: { path: "a.ts" },
	nativeArgs: { path: "a.ts" },
	partial: false,
})

const nudge = (toolName: string, repeatCount: number): ToolRepetitionCheckResult => ({
	allowExecution: false,
	nudge: { toolName, repeatCount },
})

const escalation: ToolRepetitionCheckResult = {
	allowExecution: false,
	askUser: { messageKey: "mistake_limit_reached", messageDetail: "stuck on read_file" },
}

function toolResults(task: MockTask, id: string): Anthropic.ToolResultBlockParam[] {
	return task.userMessageContent.filter(
		(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result" && block.tool_use_id === id,
	)
}

describe("presentAssistantMessage - tool repetition nudge and escalation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(customToolRegistry.has).mockReturnValue(false)
	})

	it("answers a nudge with one not-executed error, without an ask, a mistake or a turn failure", async () => {
		const task = makeTask()
		task.assistantMessageContent = [readBlock("call_r1")]
		task.toolRepetitionDetector.check.mockReturnValue(nudge("read_file", 3))

		await presentAssistantMessage(asTask(task))

		const results = toolResults(task, "call_r1")
		expect(results).toHaveLength(1)
		expect(String(results[0].content)).toContain("this call was not executed")
		expect(String(results[0].content)).toContain("identical arguments 4 times in a row")
		expect(task.ask).not.toHaveBeenCalled()
		expect(readFileTool.handle).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.recordToolError).toHaveBeenCalledWith("read_file", "repetition_nudge")
		expect(task.failParallelWorker).not.toHaveBeenCalled()
		expect(task.userMessageContentReady).toBe(true)
	})

	it("records a custom tool nudge under the telemetry-safe custom_tool name", async () => {
		const task = makeTask({ customTools: true })
		const execute = vi.fn().mockResolvedValue("custom result")
		vi.mocked(customToolRegistry.has).mockReturnValue(true)
		vi.mocked(customToolRegistry.get).mockReturnValue({
			name: "my_custom_tool",
			description: "A custom tool",
			execute,
		})
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_c1",
				// Custom tool names are not in the ToolName union; the presenter receives them as-is.
				name: "my_custom_tool" as ToolUse["name"],
				params: {},
				partial: false,
			},
		]
		task.toolRepetitionDetector.check.mockReturnValue(nudge("my_custom_tool", 3))

		await presentAssistantMessage(asTask(task))

		expect(task.recordToolError).toHaveBeenCalledWith("custom_tool", "repetition_nudge")
		expect(task.recordToolError).not.toHaveBeenCalledWith("my_custom_tool", expect.anything())
		expect(execute).not.toHaveBeenCalled()
		expect(toolResults(task, "call_c1")).toHaveLength(1)
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("asks mistake_limit_reached when a non-worker escalates", async () => {
		const task = makeTask()
		task.assistantMessageContent = [readBlock("call_r1")]
		task.toolRepetitionDetector.check.mockReturnValue(escalation)

		await presentAssistantMessage(asTask(task))

		expect(task.ask).toHaveBeenCalledWith("mistake_limit_reached", "stuck on read_file")
		expect(task.failParallelWorker).not.toHaveBeenCalled()
		expect(readFileTool.handle).not.toHaveBeenCalled()
		const results = toolResults(task, "call_r1")
		expect(results).toHaveLength(1)
		expect(String(results[0].content)).toContain("Tool call repetition limit reached for read_file")
		expect(TelemetryService.instance.captureConsecutiveMistakeError).toHaveBeenCalledWith("t")
		expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(1)
	})

	it("fails a parallel worker on escalation without an ask and answers the call once", async () => {
		const task = makeTask()
		task.parallelWorker = true
		task.assistantMessageContent = [readBlock("call_r1")]
		task.toolRepetitionDetector.check.mockReturnValue(escalation)

		await presentAssistantMessage(asTask(task))

		expect(task.failParallelWorker).toHaveBeenCalledTimes(1)
		expect(task.failParallelWorker).toHaveBeenCalledWith(
			t("tools:toolRepetitionLimitReached", { toolName: "read_file" }),
		)
		expect(task.ask).not.toHaveBeenCalled()
		expect(readFileTool.handle).not.toHaveBeenCalled()
		const results = toolResults(task, "call_r1")
		expect(results).toHaveLength(1)
		expect(JSON.parse(String(results[0].content))).toMatchObject({ status: "error" })
		expect(String(results[0].content)).toContain("Tool call repetition limit reached for read_file")
		expect(TelemetryService.instance.captureConsecutiveMistakeError).toHaveBeenCalledWith("t")
		expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(1)
	})
})
