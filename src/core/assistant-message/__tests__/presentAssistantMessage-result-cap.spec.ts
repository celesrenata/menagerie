// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-result-cap.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Task } from "../../task/Task"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { MAX_DISCOVERY_RESULT_CHARS } from "../../tools/helpers/toolResultCap"

const BIG_RESULT = "x".repeat(MAX_DISCOVERY_RESULT_CHARS * 2)

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) => ["list_files", "update_todo_list"].includes(toolName)),
}))
vi.mock("../../tools/ListFilesTool", () => ({
	listFilesTool: {
		handle: vi.fn(async (_task: unknown, _block: unknown, callbacks: { pushToolResult: (c: string) => void }) => {
			callbacks.pushToolResult(BIG_RESULT)
		}),
	},
}))
vi.mock("../../tools/UpdateTodoListTool", () => ({
	updateTodoListTool: {
		handle: vi.fn(async (_task: unknown, _block: unknown, callbacks: { pushToolResult: (c: string) => void }) => {
			callbacks.pushToolResult(BIG_RESULT)
		}),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

interface ToolResultBlock {
	type: string
	tool_use_id?: string
	content?: string
}

interface MockTask {
	userMessageContent: ToolResultBlock[]
	assistantMessageContent: unknown[]
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
	[key: string]: unknown
}

// The mock Task implements only what presentAssistantMessage touches; a structural cast is unavoidable.
const asTask = (task: MockTask): Task => task as unknown as Task

describe("presentAssistantMessage - discovery tool result cap", () => {
	let mockTask: MockTask

	beforeEach(() => {
		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 0 }),
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
				recordResult: vi.fn(),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn().mockImplementation((toolResult: ToolResultBlock) => {
				mockTask.userMessageContent.push(toolResult)
				return true
			}),
		}
	})

	const findResult = (id: string): ToolResultBlock | undefined =>
		mockTask.userMessageContent.find((b) => b.type === "tool_result" && b.tool_use_id === id)

	it("caps an oversized list_files result", async () => {
		mockTask.assistantMessageContent = [
			{ type: "tool_use", id: "call_list", name: "list_files", params: { path: "." }, nativeArgs: { path: "." } },
		]

		await presentAssistantMessage(asTask(mockTask))

		const result = findResult("call_list")
		expect(result).toBeDefined()
		expect(result!.content!.length).toBeLessThan(BIG_RESULT.length)
		expect(result!.content).toContain("Result truncated")
	})

	it("leaves a non-discovery tool result of the same size unchanged", async () => {
		mockTask.assistantMessageContent = [
			{ type: "tool_use", id: "call_todo", name: "update_todo_list", params: {}, nativeArgs: { todos: "" } },
		]

		await presentAssistantMessage(asTask(mockTask))

		const result = findResult("call_todo")
		expect(result).toBeDefined()
		expect(result!.content).toBe(BIG_RESULT)
	})
})
