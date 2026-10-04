// npx vitest run core/task/__tests__/Task.parallel-worker-failure.spec.ts

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import {
	providerIdentifiers,
	type ClineMessage,
	type GlobalState,
	type ModelInfo,
	type ProviderSettings,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { checkContextWindowExceededError } from "../../context/context-management/context-error-handling"
import { OutputTokenLimitError } from "../../../api/providers/utils/output-token-limit-error"
import type { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"

// Private Task members this suite stubs. Typed so spies keep their signatures.
type TaskTestAccess = {
	getSystemPrompt: (requestState: ProviderState | undefined, requestModelInfo?: ModelInfo) => Promise<string>
	presentAssistantMessageSafe: () => void
	safeEnsureModelFetched: () => Promise<ModelInfo>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	handleContextWindowExceededError: (requestModelInfo: ModelInfo) => Promise<void>
}

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

function getTaskTestAccess(task: Task): TaskTestAccess {
	// Double cast: the private members above exist on Task but are not part of its public type.
	return task as unknown as TaskTestAccess
}

// Real-loop specs use real timers (Task yields via setImmediate, which fake timers would
// stall), so the timeouts are mocked to tiny values instead (plan D6).
vi.mock("../../../api/providers/utils/timeout-config", () => ({
	getApiRequestTimeout: vi.fn(() => 80),
	getApiStreamIdleTimeout: vi.fn(() => 30),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn().mockReturnValue(undefined),
		getAllInstances: vi.fn().mockReturnValue([]),
		disposeAll: vi.fn(),
	},
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../condense", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../condense")>()
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
}))

const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 4096,
	supportsPromptCache: true,
}

const RETRY_CAP_REASON = "API request failed after 8 retries"
const OUTPUT_LIMIT_REASON = "Model output token limit reached; the identical request would truncate again"

type ApiReqInfo = { cancelReason?: string; streamingFailedMessage?: string }

function apiReqStartedRows(task: Task): ApiReqInfo[] {
	return task.clineMessages
		.filter((message: ClineMessage) => message.say === "api_req_started")
		.map((message) => (message.text ? (JSON.parse(message.text) as ApiReqInfo) : {}))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function streamThenThrow(chunks: ApiStreamChunk[], error: unknown): ApiStream {
	return (async function* () {
		yield* chunks
		throw error
	})()
}

// A generator that yields `chunks` and then never produces another value or settles.
function stallingStream(chunks: ApiStreamChunk[]): ApiStream {
	return (async function* () {
		yield* chunks
		await new Promise<never>(() => {})
	})()
}

// Keeps streaming text until the task aborts (bounded so a regression cannot spin forever).
function streamUntilAborted(task: Task): ApiStream {
	return (async function* () {
		for (let i = 0; i < 2_000 && !task.abort; i++) {
			yield { type: "text", text: `chunk ${i} ` }
			await sleep(1)
		}
	})()
}

const http503 = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 })
const fail503 = () => streamThenThrow([], http503())
const textResponse = () => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }])
const emptyResponse = () => asyncStreamFrom<ApiStreamChunk>([])
const times = (count: number, step: () => ApiStream) => Array.from({ length: count }, () => step)

describe("Task parallel worker failure (A4)", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let baseProviderState: ProviderState

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage") },
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel: vscode.OutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		)

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		mockProvider.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)

		baseProviderState = await mockProvider.getState()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function createLoopTask(
		options: { parallelWorker?: boolean; autoApprovalEnabled?: boolean; consecutiveMistakeLimit?: number } = {},
	) {
		const { parallelWorker = true, autoApprovalEnabled = true, consecutiveMistakeLimit } = options
		vi.spyOn(mockProvider, "getState").mockResolvedValue({
			...baseProviderState,
			mcpEnabled: false,
			autoApprovalEnabled,
			requestDelaySeconds: 0,
		})

		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "parallel worker failure test",
			startTask: false,
			parallelWorker,
			consecutiveMistakeLimit,
		})
		await task.getTaskMode()

		const access = getTaskTestAccess(task)
		vi.spyOn(access, "getSystemPrompt").mockResolvedValue("mock system prompt")
		vi.spyOn(access, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		const presentAssistantMessageSafe = vi.spyOn(access, "presentAssistantMessageSafe").mockImplementation(() => {})
		const backoffAndAnnounce = vi.spyOn(access, "backoffAndAnnounce").mockResolvedValue(undefined)
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		vi.spyOn(task, "getTokenUsage").mockReturnValue({
			totalCost: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			contextTokens: 0,
		})
		// abortTask stays real (it aborts lifetimeSignal); only its disposal is kept local.
		vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		// Nobody answers a worker's ask; a regression fails fast instead of hanging.
		const ask = vi.spyOn(task, "ask").mockRejectedValue(new Error("unexpected ask"))
		const failParallelWorker = vi.spyOn(task, "failParallelWorker")

		// Ends the request loop: the next request sees an aborted task.
		const stopLoop = (): ApiStream => {
			task.abort = true
			return streamThenThrow([], new Error("stop: task aborted"))
		}

		// Each request takes the next scripted response; once the script runs out the loop stops.
		const steps: Array<() => ApiStream> = []
		const counterAtCall: number[] = []
		const createMessage = vi.spyOn(task.api, "createMessage").mockImplementation(() => {
			counterAtCall.push(task["parallelWorkerApiFailures"])
			return (steps.shift() ?? stopLoop)()
		})

		const run = () => task.recursivelyMakeClineRequests([{ type: "text", text: "go" }])

		return {
			task,
			access,
			steps,
			counterAtCall,
			createMessage,
			presentAssistantMessageSafe,
			backoffAndAnnounce,
			ask,
			failParallelWorker,
			run,
		}
	}

	it("fails a worker after 9 consecutive first-chunk failures", async () => {
		const { task, steps, createMessage, failParallelWorker, run } = await createLoopTask()
		steps.push(...times(20, fail503))

		await expect(run()).resolves.toBe(true)

		expect(createMessage).toHaveBeenCalledTimes(9)
		expect(failParallelWorker).toHaveBeenCalledOnce()
		expect(task.lifetimeSignal.aborted).toBe(true)
		expect(task.abortReason).toBe("streaming_failed")
		expect(task.parallelWorkerFailure).toContain(RETRY_CAP_REASON)
		expect(task.parallelWorkerFailure).toContain("503 Service Unavailable")
		expect(apiReqStartedRows(task).at(-1)?.cancelReason).toBe("streaming_failed")
	})

	it("counts interleaved first-chunk and mid-stream failures against one cap", async () => {
		const { task, steps, createMessage, run } = await createLoopTask()
		steps.push(
			...times(3, fail503),
			// Yields one chunk, then stalls past the 30 ms idle timeout (a mid-stream failure).
			() => stallingStream([{ type: "text", text: "partial" }]),
			...times(20, fail503),
		)

		await run()

		expect(createMessage).toHaveBeenCalledTimes(9)
		expect(task.parallelWorkerFailure).toContain(RETRY_CAP_REASON)
		const rows = apiReqStartedRows(task)
		expect(rows).toHaveLength(2)
		expect(rows[0]?.cancelReason).toBe("streaming_failed")
		expect(rows[0]?.streamingFailedMessage).toContain("No data received")
		expect(rows[1]?.cancelReason).toBe("streaming_failed")
	})

	it("resets the failure counter after a successful response with content", async () => {
		const { task, steps, counterAtCall, createMessage, failParallelWorker, run } = await createLoopTask()
		steps.push(...times(5, fail503), textResponse, ...times(8, fail503), textResponse)

		await run()

		// 5 failures, success, 8 failures, success, then the stop request.
		expect(createMessage).toHaveBeenCalledTimes(16)
		expect(counterAtCall[5]).toBe(5)
		expect(counterAtCall[6]).toBe(0)
		// The 8th failure after the reset is still within the cap.
		expect(counterAtCall[14]).toBe(8)
		expect(failParallelWorker).not.toHaveBeenCalled()
		expect(task.parallelWorkerFailure).toBeUndefined()
		expect(task["parallelWorkerApiFailures"]).toBe(0)
	})

	it("does not count a context-window truncation retry against the cap", async () => {
		const { task, access, steps, counterAtCall, run } = await createLoopTask()
		const handleContextWindowExceededError = vi
			.spyOn(access, "handleContextWindowExceededError")
			.mockResolvedValue(undefined)
		const contextWindowError = Object.assign(new Error("This model's maximum context length is 8192 tokens"), {
			status: 400,
		})
		expect(checkContextWindowExceededError(contextWindowError)).toBe(true)
		steps.push(() => streamThenThrow([], contextWindowError))

		await run()

		expect(handleContextWindowExceededError).toHaveBeenCalledOnce()
		// The request retried after truncation saw an untouched counter.
		expect(counterAtCall).toEqual([0, 0])
		expect(task["parallelWorkerApiFailures"]).toBe(0)
		expect(task.parallelWorkerFailure).toBeUndefined()
	})

	it("retries without an api_req_failed ask when auto-approval is off, then fails at 9", async () => {
		const { task, steps, createMessage, backoffAndAnnounce, ask, run } = await createLoopTask({
			autoApprovalEnabled: false,
		})
		steps.push(...times(20, fail503))

		await run()

		expect(ask).not.toHaveBeenCalled()
		expect(createMessage).toHaveBeenCalledTimes(9)
		expect(backoffAndAnnounce).toHaveBeenCalledTimes(8)
		expect(task.parallelWorkerFailure).toContain(RETRY_CAP_REASON)
	})

	it("leaves non-worker retries uncapped", async () => {
		const { task, steps, counterAtCall, createMessage, failParallelWorker, run } = await createLoopTask({
			parallelWorker: false,
		})
		steps.push(...times(12, fail503), textResponse)

		await run()

		// 12 failures and the success (13 requests), then the stop request.
		expect(createMessage).toHaveBeenCalledTimes(14)
		expect(failParallelWorker).not.toHaveBeenCalled()
		expect(task.parallelWorkerFailure).toBeUndefined()
		expect(counterAtCall.every((count) => count === 0)).toBe(true)
	})

	it("fails a worker at the consecutive-mistake limit without asking", async () => {
		const { task, createMessage, ask, failParallelWorker, run } = await createLoopTask({
			consecutiveMistakeLimit: 3,
		})
		task.consecutiveMistakeCount = task.consecutiveMistakeLimit

		await expect(run()).resolves.toBe(true)

		expect(failParallelWorker).toHaveBeenCalledWith("Stopped after 3 consecutive mistakes")
		expect(ask).not.toHaveBeenCalled()
		expect(createMessage).not.toHaveBeenCalled()
		expect(task.lifetimeSignal.aborted).toBe(true)
		expect(task.parallelWorkerFailure).toBe("Stopped after 3 consecutive mistakes")
	})

	it("labels a worker self-failure during streaming as streaming_failed", async () => {
		const { task, steps, presentAssistantMessageSafe, run } = await createLoopTask()
		presentAssistantMessageSafe.mockImplementationOnce(() => {
			void task.failParallelWorker("stuck in a loop")
		})
		steps.push(() => streamUntilAborted(task))

		await expect(run()).resolves.toBe(true)

		expect(task.parallelWorkerFailure).toBe("stuck in a loop")
		expect(apiReqStartedRows(task)[0]?.cancelReason).toBe("streaming_failed")
	})

	it("keeps user_cancelled for a user cancel during streaming", async () => {
		const { task, steps, presentAssistantMessageSafe, run } = await createLoopTask()
		presentAssistantMessageSafe.mockImplementationOnce(() => {
			task.abortReason = "user_cancelled"
			void task.abortTask()
		})
		steps.push(() => streamUntilAborted(task))

		await expect(run()).resolves.toBe(true)

		expect(task.parallelWorkerFailure).toBeUndefined()
		expect(apiReqStartedRows(task)[0]?.cancelReason).toBe("user_cancelled")
	})

	it("keeps the user message last in history when empty responses exhaust the cap", async () => {
		const { task, steps, createMessage } = await createLoopTask()
		steps.push(...times(20, emptyResponse))

		await expect(
			task.recursivelyMakeClineRequests([{ type: "text", text: "empty-assistant probe" }]),
		).resolves.toBe(true)

		expect(createMessage).toHaveBeenCalledTimes(9)
		expect(task.parallelWorkerFailure).toContain(`${RETRY_CAP_REASON}: The model returned no assistant messages`)
		const last = task.apiConversationHistory.at(-1)
		expect(last?.role).toBe("user")
		expect(JSON.stringify(last?.content)).toContain("empty-assistant probe")
		// Each retry popped and re-added the same message; the exhausted attempt kept it.
		expect(task.apiConversationHistory.filter((message) => message.role === "user")).toHaveLength(1)
	})

	it("rejects failParallelWorker on a non-worker and is idempotent on a worker", async () => {
		const { task: plainTask } = await createLoopTask({ parallelWorker: false })
		await expect(plainTask.failParallelWorker("nope")).rejects.toThrow(
			"failParallelWorker called on a non-worker task",
		)
		expect(plainTask.abort).toBe(false)

		const { task } = await createLoopTask()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(task.failParallelWorker("first")).resolves.toBeUndefined()
		await expect(task.failParallelWorker("second")).resolves.toBeUndefined()

		expect(task.parallelWorkerFailure).toBe("first")
		expect(task.abortReason).toBe("streaming_failed")
		expect(task.lifetimeSignal.aborted).toBe(true)
		const errorRows = task.clineMessages.filter(
			(message) => message.say === "error" && message.text === "common:errors.parallel_worker_failed",
		)
		expect(errorRows).toHaveLength(1)
		// The second say hits the aborted task; its rejection is swallowed and logged.
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("[Task#failParallelWorker] say failed"),
			expect.any(Error),
		)
	})

	it("does not count a cancel during the first-chunk wait against the cap (round-3 NIT 2)", async () => {
		const { task, steps, createMessage, failParallelWorker, run } = await createLoopTask()
		task["parallelWorkerApiFailures"] = 8
		steps.push(() => {
			setTimeout(() => {
				void task.abortTask()
				task.cancelCurrentRequest()
			}, 5)
			return stallingStream([])
		})

		await run()

		expect(createMessage).toHaveBeenCalledOnce()
		expect(failParallelWorker).not.toHaveBeenCalled()
		expect(task.parallelWorkerFailure).toBeUndefined()
		expect(task["parallelWorkerApiFailures"]).toBe(8)
		expect(apiReqStartedRows(task)[0]?.cancelReason).toBe("user_cancelled")
	})

	it("fails a worker on a mid-stream output token limit without asking", async () => {
		const { task, steps, createMessage, ask, failParallelWorker, run } = await createLoopTask()
		steps.push(() => streamThenThrow([{ type: "text", text: "partial" }], new OutputTokenLimitError()))

		await run()

		expect(failParallelWorker).toHaveBeenCalledWith(OUTPUT_LIMIT_REASON)
		expect(ask).not.toHaveBeenCalled()
		expect(createMessage).toHaveBeenCalledOnce()
		expect(task.parallelWorkerFailure).toBe(OUTPUT_LIMIT_REASON)
		expect(task.lifetimeSignal.aborted).toBe(true)
		expect(task["parallelWorkerApiFailures"]).toBe(0)
	})
})
