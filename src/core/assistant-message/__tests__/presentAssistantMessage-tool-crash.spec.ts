// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-tool-crash.spec.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { isValidToolName } from "../../tools/validateToolUse"
import { writeToFileTool } from "../../tools/WriteToFileTool"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { readFileTool } from "../../tools/ReadFileTool"
import type { ToolCallbacks } from "../../tools/BaseTool"
import type { Task } from "../../task/Task"
import type { McpToolUse, TextContent, ToolUse } from "../../../shared/tools"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) => ["read_file", "write_to_file", "use_mcp_tool"].includes(toolName)),
}))
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))
vi.mock("../../tools/WriteToFileTool", () => ({
	writeToFileTool: { handle: vi.fn() },
}))
vi.mock("../../tools/UseMcpToolTool", () => ({
	useMcpToolTool: { handle: vi.fn() },
}))
vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: { handle: vi.fn(), getReadFileToolDescription: vi.fn(() => "[read_file]") },
}))

type UserContent = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam
type Block = ToolUse | McpToolUse | TextContent

/** The subset of Task that presentAssistantMessage touches on these paths. */
interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	currentStreamingDidCheckpoint: boolean
	assistantMessageContent: Block[]
	userMessageContent: UserContent[]
	didCompleteReadingStream: boolean
	userMessageContentReady: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	didToolFailInCurrentTurn: boolean
	consecutiveMistakeCount: number
	parallelWorker: boolean
	getTaskMode: ReturnType<typeof vi.fn>
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	checkpointSave: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: { deref: () => { getState: () => Promise<unknown>; getMcpHub: () => undefined } }
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: (toolResult: Anthropic.ToolResultBlockParam) => boolean
}

const INCIDENT_ERROR = "newContent.startsWith is not a function"

function makeTask(): MockTask {
	const task: MockTask = {
		taskId: "t",
		instanceId: "i",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		currentStreamingDidCheckpoint: false,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: false,
		userMessageContentReady: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		didToolFailInCurrentTurn: false,
		consecutiveMistakeCount: 0,
		parallelWorker: false,
		getTaskMode: vi.fn().mockResolvedValue("code"),
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		checkpointSave: vi.fn().mockResolvedValue(undefined),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				getMcpHub: () => undefined,
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
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

function writeBlock(id: string, partial = false): ToolUse<"write_to_file"> {
	return {
		type: "tool_use",
		id,
		name: "write_to_file",
		params: { path: "web/package.json" },
		nativeArgs: { path: "web/package.json", content: "{}" },
		partial,
	}
}

function toolResults(task: MockTask, id: string): Anthropic.ToolResultBlockParam[] {
	return task.userMessageContent.filter(
		(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result" && block.tool_use_id === id,
	)
}

describe("presentAssistantMessage - tool dispatch crash", () => {
	let task: MockTask

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isValidToolName).mockImplementation((toolName: string) =>
			["read_file", "write_to_file", "use_mcp_tool"].includes(toolName),
		)
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
		task = makeTask()
	})

	it("answers a crashing write_to_file with exactly one error tool_result and reports it", async () => {
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))

		await presentAssistantMessage(asTask(task))

		const results = toolResults(task, "call_w1")
		expect(results).toHaveLength(1)
		expect(typeof results[0].content).toBe("string")
		const parsed: unknown = JSON.parse(String(results[0].content))
		expect(parsed).toMatchObject({ status: "error" })
		expect(String(results[0].content)).toContain("executing write_to_file")
		expect(String(results[0].content)).toContain(INCIDENT_ERROR)
		expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining(INCIDENT_ERROR))
	})

	it("advances the index and settles the turn when the stream is complete", async () => {
		task.didCompleteReadingStream = true
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))

		await presentAssistantMessage(asTask(task))

		expect(task.currentStreamingContentIndex).toBe(task.assistantMessageContent.length)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("still executes the following block in the same message", async () => {
		task.didCompleteReadingStream = true
		task.assistantMessageContent = [
			writeBlock("call_w1"),
			{
				type: "tool_use",
				id: "call_r1",
				name: "read_file",
				params: { path: "a.ts" },
				nativeArgs: { path: "a.ts" },
				partial: false,
			},
		]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))
		vi.mocked(readFileTool.handle).mockImplementationOnce(
			async (_task: Task, _block: ToolUse<"read_file">, callbacks: ToolCallbacks) => {
				callbacks.pushToolResult("read ok")
			},
		)

		await presentAssistantMessage(asTask(task))

		expect(readFileTool.handle).toHaveBeenCalledTimes(1)
		expect(toolResults(task, "call_w1")).toHaveLength(1)
		expect(toolResults(task, "call_r1")).toEqual([
			{ type: "tool_result", tool_use_id: "call_r1", content: "read ok" },
		])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("rethrows an abort error and pushes no result", async () => {
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new Error("[RooCode#say] task t.i aborted"))

		await expect(presentAssistantMessage(asTask(task))).rejects.toThrow("aborted")
		expect(task.userMessageContent).toEqual([])
		expect(task.recordToolError).not.toHaveBeenCalled()
	})

	it("rethrows any error once the task is aborted and pushes no result", async () => {
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockImplementationOnce(async () => {
			task.abort = true
			throw new Error("disk went away")
		})

		await expect(presentAssistantMessage(asTask(task))).rejects.toThrow("disk went away")
		expect(task.userMessageContent).toEqual([])
	})

	it("answers a crashing MCP tool once and records the static use_mcp_tool name", async () => {
		const mcpBlock: McpToolUse = {
			type: "mcp_tool_use",
			id: "call_mcp1",
			name: "mcp--srv--tool",
			serverName: "srv",
			toolName: "tool",
			arguments: { q: 1 },
			partial: false,
		}
		task.assistantMessageContent = [mcpBlock]
		vi.mocked(useMcpToolTool.handle).mockRejectedValueOnce(new Error("mcp exploded"))

		await presentAssistantMessage(asTask(task))

		const results = toolResults(task, "call_mcp1")
		expect(results).toHaveLength(1)
		expect(String(results[0].content)).toContain("mcp exploded")
		expect(task.recordToolError).toHaveBeenCalledWith("use_mcp_tool", "mcp exploded")
		expect(task.recordToolError).not.toHaveBeenCalledWith("mcp--srv--tool", expect.anything())
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("ignores a throw on a partial block and accepts the finalized block's own result", async () => {
		const block = writeBlock("call_w1", true)
		task.assistantMessageContent = [block]
		vi.mocked(writeToFileTool.handle)
			.mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))
			.mockImplementationOnce(async (_task: Task, _block: ToolUse<"write_to_file">, callbacks: ToolCallbacks) => {
				callbacks.pushToolResult("ok")
			})

		await presentAssistantMessage(asTask(task))
		expect(task.userMessageContent).toEqual([])
		expect(task.recordToolError).not.toHaveBeenCalled()

		block.partial = false
		await presentAssistantMessage(asTask(task))

		expect(toolResults(task, "call_w1")).toEqual([{ type: "tool_result", tool_use_id: "call_w1", content: "ok" }])
	})

	it("records the telemetry-safe tool name, never the raw block name", async () => {
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))

		await presentAssistantMessage(asTask(task))
		expect(task.recordToolError).toHaveBeenCalledWith("write_to_file", INCIDENT_ERROR)

		vi.mocked(task.recordToolError).mockClear()
		vi.mocked(isValidToolName).mockReturnValue(false)
		task.userMessageContent = []
		task.currentStreamingContentIndex = 0
		task.assistantMessageContent = [writeBlock("call_w2")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))

		await presentAssistantMessage(asTask(task))

		expect(task.recordToolError).toHaveBeenCalledWith("invalid_tool_call", INCIDENT_ERROR)
		for (const call of vi.mocked(task.recordToolError).mock.calls) {
			expect(call[0]).toBe("invalid_tool_call")
		}
	})

	it("counts the crash as a mistake and marks the turn as failed", async () => {
		task.assistantMessageContent = [writeBlock("call_w1")]
		vi.mocked(writeToFileTool.handle).mockRejectedValueOnce(new TypeError(INCIDENT_ERROR))

		await presentAssistantMessage(asTask(task))

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})
})
