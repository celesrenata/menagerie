// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-mode-rejection.spec.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Task } from "../../task/Task"
import { presentAssistantMessage } from "../presentAssistantMessage"

vi.mock("../../task/Task")

// Stand-in mirroring the real tool's approval-card behavior: partial and complete calls both ask("command").
vi.mock("../../tools/ExecuteCommandTool", () => ({
	executeCommandTool: {
		handle: vi.fn(
			async (
				task: { ask: (...args: unknown[]) => unknown },
				block: { params: { command?: string }; partial: boolean },
			) => {
				await task.ask("command", block.params.command ?? "", block.partial)
			},
		),
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

interface TestToolResult {
	type: string
	tool_use_id: string
	content: string
	is_error?: boolean
}

interface TestBlock {
	type: "tool_use"
	id: string
	name: string
	params: Record<string, string>
	nativeArgs: Record<string, string>
	partial: boolean
}

function buildTask(getState: () => Record<string, unknown>) {
	const task = {
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		parallelWorker: true,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as TestBlock[],
		userMessageContent: [] as TestToolResult[],
		didCompleteReadingStream: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		consecutiveModeRejections: 0,
		clineMessages: [],
		getTaskMode: vi.fn().mockResolvedValue("architect"),
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: { deref: () => ({ getState: vi.fn().mockImplementation(async () => getState()) }) },
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: (toolResult: TestToolResult): boolean => {
			if (task.userMessageContent.some((b) => b.tool_use_id === toolResult.tool_use_id)) {
				return false
			}
			task.userMessageContent.push(toolResult)
			return true
		},
	}
	return task
}

describe("presentAssistantMessage - mode permission rejection", () => {
	let mockTask: ReturnType<typeof buildTask>
	let state: Record<string, unknown>

	const run = () => presentAssistantMessage(mockTask as unknown as Task)

	const setBlock = (partial: boolean, id = "call_1") => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id,
				name: "execute_command",
				params: { command: "ls -la" },
				nativeArgs: { command: "ls -la" },
				partial,
			},
		]
		mockTask.currentStreamingContentIndex = 0
		mockTask.presentAssistantMessageLocked = false
	}

	const toolResults = (): TestToolResult[] => mockTask.userMessageContent.filter((i) => i.type === "tool_result")

	beforeEach(() => {
		state = { mode: "architect", customModes: [], experiments: {} }
		mockTask = buildTask(() => state)
	})

	it("renders no command card for a partial execute_command the mode forbids", async () => {
		setBlock(true)
		await run()

		expect(mockTask.ask).not.toHaveBeenCalled()
	})

	it("returns guidance without ask('command') or a mistake for a complete rejected call", async () => {
		setBlock(true)
		await run()
		setBlock(false)
		await run()

		expect(mockTask.ask).not.toHaveBeenCalledWith("command", expect.anything(), expect.anything())
		expect(mockTask.ask).not.toHaveBeenCalled()
		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.say).not.toHaveBeenCalledWith("error", expect.anything())

		const [result] = toolResults()
		expect(result).toBeDefined()
		expect(result.tool_use_id).toBe("call_1")
		expect(result.content).toContain("execute_command")
		expect(result.content).toContain("architect")
		expect(result.content).toContain("attempt_completion")
		expect(result.content).toContain("code")
		expect(mockTask.recordToolError).toHaveBeenCalledWith("mode_not_allowed", expect.any(String))
	})

	it("counts mode rejections as mistakes only from the fourth consecutive one", async () => {
		for (let i = 1; i <= 3; i++) {
			setBlock(false, `call_${i}`)
			await run()
			expect(mockTask.consecutiveMistakeCount).toBe(0)
		}

		setBlock(false, "call_4")
		await run()
		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	it("lets a worker run execute_command in architect mode when yolo and yoloWorkersAnyTool are on", async () => {
		state = { ...state, yoloModeEnabled: true, yoloWorkersAnyTool: true }
		setBlock(false)
		await run()

		expect(mockTask.ask).toHaveBeenCalledWith("command", expect.anything(), expect.anything())
		expect(mockTask.recordToolError).not.toHaveBeenCalledWith("mode_not_allowed", expect.anything())
	})

	it("still rejects with guidance when yoloWorkersAnyTool is on but yolo is off", async () => {
		state = { ...state, yoloModeEnabled: false, yoloWorkersAnyTool: true }
		setBlock(false)
		await run()

		expect(mockTask.ask).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("mode_not_allowed", expect.any(String))
	})
})
