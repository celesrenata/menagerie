// npx vitest run core/task/__tests__/Task.presenter-backstop.spec.ts

import * as os from "os"
import * as path from "path"

import type { MockInstance } from "vitest"
import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { type AssistantMessageContent, presentAssistantMessage } from "../../assistant-message"
import { writeToFileTool } from "../../tools/WriteToFileTool"

const { mockSaveTaskMessages, mockSaveApiMessages, pWaitForHook } = vi.hoisted(() => ({
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	pWaitForHook: { onCall: undefined as undefined | (() => void) },
}))

// vscode is globally aliased to __mocks__/vscode.js by vitest.config.ts.
vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("execa", () => ({ execa: vi.fn() }))
// Lets a test observe task state at the moment the turn waits for userMessageContentReady.
vi.mock("p-wait-for", () => ({
	default: vi.fn(async () => {
		pWaitForHook.onCall?.()
	}),
}))

vi.mock("../../assistant-message", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../assistant-message")>()
	return { ...actual, presentAssistantMessage: vi.fn(actual.presentAssistantMessage) }
})

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: mockSaveApiMessages,
		saveTaskMessages: mockSaveTaskMessages,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				reconcile: vi.fn().mockResolvedValue(undefined),
				initialized: Promise.resolve(),
			}
		}),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi
		.fn()
		.mockImplementation((text) =>
			Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] }),
		),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn().mockImplementation(async ({ userContent }: { userContent: unknown[] }) => ({
		content: userContent,
		mode: undefined,
	})),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((base: string, id: string) => Promise.resolve(`${base}/tasks/${id}`)),
	getSettingsDirectoryPath: vi.fn().mockImplementation((base: string) => Promise.resolve(`${base}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

const actualAssistantMessage =
	await vi.importActual<typeof import("../../assistant-message")>("../../assistant-message")

function makeMockProvider() {
	return {
		log: vi.fn(),
		taskHistoryStore: { get: () => undefined },
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		getState: vi.fn().mockResolvedValue({}),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		context: {
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage-presenter-backstop") },
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			workspaceState: {
				get: vi.fn().mockImplementation(() => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension" },
			extension: { packageJSON: { version: "1.0.0" } },
		},
	}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function toolUse(id: string, partial = false): AssistantMessageContent {
	return {
		type: "tool_use",
		id,
		name: "write_to_file",
		params: { path: "a.txt" },
		nativeArgs: { path: "a.txt", content: "x" },
		partial,
	}
}

function resultsFor(task: Task, id: string) {
	return task.userMessageContent.filter((block) => block.type === "tool_result" && block.tool_use_id === id)
}

describe("Task presenter backstop", () => {
	let mockApiConfig: ProviderSettings
	let task: Task
	let sayMock: MockInstance<Task["say"]>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(presentAssistantMessage).mockImplementation(actualAssistantMessage.presentAssistantMessage)
		pWaitForHook.onCall = undefined
		mockSaveTaskMessages.mockResolvedValue(undefined)
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		// Double cast: plain object satisfies only the methods called by this code path.
		task = new Task({
			provider: makeMockProvider() as unknown as ClineProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})
		sayMock = vi.spyOn(task, "say").mockResolvedValue(undefined)
	})

	async function rejectPresenter(error: Error) {
		vi.mocked(presentAssistantMessage).mockRejectedValueOnce(error)
		task["presentAssistantMessageSafe"]()
		await flush()
	}

	it("answers every unanswered tool call from the index onward and settles the turn", async () => {
		task.assistantMessageContent = [
			toolUse("call_done_before_index"),
			toolUse("call_answered"),
			toolUse("call_a"),
			{
				type: "mcp_tool_use",
				id: "call_mcp",
				name: "mcp--srv--tool",
				serverName: "srv",
				toolName: "tool",
				arguments: {},
				partial: false,
			},
			{ type: "text", content: "trailing text", partial: false },
		]
		task.currentStreamingContentIndex = 1
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "call_answered", content: "ok" }]
		task.didCompleteReadingStream = true
		task.userMessageContentReady = false

		await rejectPresenter(new Error("boom"))

		expect(resultsFor(task, "call_done_before_index")).toHaveLength(0)
		expect(resultsFor(task, "call_answered")).toEqual([
			{ type: "tool_result", tool_use_id: "call_answered", content: "ok" },
		])
		for (const id of ["call_a", "call_mcp"]) {
			const results = resultsFor(task, id)
			expect(results).toHaveLength(1)
			expect(results[0]).toMatchObject({ is_error: true })
			expect(String(results[0].type === "tool_result" ? results[0].content : "")).toContain(
				"Tool execution failed unexpectedly: boom. Fix the arguments and retry.",
			)
		}
		expect(task.currentStreamingContentIndex).toBe(task.assistantMessageContent.length)
		expect(task.presentAssistantMessageHasPendingUpdates).toBe(false)
		expect(task.userMessageContentReady).toBe(true)
		expect(sayMock).toHaveBeenCalledTimes(1)
		expect(sayMock).toHaveBeenCalledWith("error", "common:errors.presenter_failed")
	})

	it("leaves the ready flag alone while the stream is still being read", async () => {
		task.assistantMessageContent = [toolUse("call_a")]
		task.didCompleteReadingStream = false
		task.userMessageContentReady = false

		await rejectPresenter(new Error("boom"))

		expect(resultsFor(task, "call_a")).toHaveLength(1)
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.userMessageContentReady).toBe(false)
	})

	describe("stream-end guard", () => {
		async function runOneTextTurn(lockPresenter: boolean): Promise<boolean[]> {
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task, "dispose").mockResolvedValue(undefined)
			// The request loop needs the real say() to create its api_req_started row.
			sayMock.mockRestore()
			task["attemptApiRequest"] = async function* () {
				yield { type: "text" as const, text: "hello" }
			}
			vi.mocked(presentAssistantMessage).mockImplementation(async (cline: Task) => {
				cline.currentStreamingContentIndex = cline.assistantMessageContent.length
				if (lockPresenter) cline.presentAssistantMessageLocked = true
			})
			const readyAtWait: boolean[] = []
			pWaitForHook.onCall = () => {
				readyAtWait.push(task.userMessageContentReady)
				// End the loop right after the observed wait.
				task["abort"] = true
			}

			// The abort set in the wait hook makes the loop exit through its abort path.
			await task.recursivelyMakeClineRequests([{ type: "text", text: "help me" }])
			return readyAtWait
		}

		it("sets ready before the wait when every block was presented and the presenter is unlocked", async () => {
			expect(await runOneTextTurn(false)).toEqual([true])
		})

		it("leaves ready unset when the presenter is still locked", async () => {
			expect(await runOneTextTurn(true)).toEqual([false])
		})
	})

	it("presents a block appended after the backstop", async () => {
		task.assistantMessageContent = [toolUse("call_a")]
		task.didCompleteReadingStream = false

		await rejectPresenter(new Error("boom"))
		sayMock.mockClear()

		task.assistantMessageContent.push({ type: "text", content: "after recovery", partial: false })
		task.didCompleteReadingStream = true
		await presentAssistantMessage(task)

		expect(sayMock).toHaveBeenCalledWith("text", "after recovery", undefined, false)
		expect(task.currentStreamingContentIndex).toBe(2)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("changes nothing while the presenter is locked", async () => {
		task.assistantMessageContent = [toolUse("call_a")]
		task.presentAssistantMessageLocked = true
		task.presentAssistantMessageHasPendingUpdates = true
		task.didCompleteReadingStream = true
		task.userMessageContentReady = false

		await rejectPresenter(new Error("boom"))

		expect(task.userMessageContent).toEqual([])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageHasPendingUpdates).toBe(true)
		expect(task.userMessageContentReady).toBe(false)
		expect(task.presentAssistantMessageLocked).toBe(true)
		expect(sayMock).not.toHaveBeenCalled()
	})

	it("answers an unanswered partial tool call once and never executes it after finalization", async () => {
		const handleSpy = vi.spyOn(writeToFileTool, "handle")
		const block = toolUse("call_partial", true)
		task.assistantMessageContent = [block]
		task.didCompleteReadingStream = false

		await rejectPresenter(new Error("boom"))
		expect(resultsFor(task, "call_partial")).toHaveLength(1)

		// Finalize in place, as the stream parser does, and present again.
		block.partial = false
		task.didCompleteReadingStream = true
		await presentAssistantMessage(task)

		expect(handleSpy).not.toHaveBeenCalled()
		expect(resultsFor(task, "call_partial")).toHaveLength(1)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("does not recover from an abort rejection", async () => {
		task.assistantMessageContent = [toolUse("call_a")]
		task.didCompleteReadingStream = true

		await rejectPresenter(new Error("[RooCode#say] task t.i aborted"))

		expect(task.userMessageContent).toEqual([])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.userMessageContentReady).toBe(false)
		expect(sayMock).not.toHaveBeenCalled()
	})

	it("does not recover once the task was aborted", async () => {
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		task.assistantMessageContent = [toolUse("call_a")]
		task.didCompleteReadingStream = true
		await task.abortTask()
		sayMock.mockClear()

		await rejectPresenter(new Error("boom"))

		expect(task.userMessageContent).toEqual([])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(sayMock).not.toHaveBeenCalled()
	})

	it("does not recover once the task was abandoned", async () => {
		task.assistantMessageContent = [toolUse("call_a")]
		task.didCompleteReadingStream = true
		task.abandoned = true

		await rejectPresenter(new Error("boom"))

		expect(task.userMessageContent).toEqual([])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.userMessageContentReady).toBe(false)
		expect(sayMock).not.toHaveBeenCalled()
	})
})
