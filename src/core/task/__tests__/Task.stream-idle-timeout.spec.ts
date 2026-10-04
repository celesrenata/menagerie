// npx vitest run core/task/__tests__/Task.stream-idle-timeout.spec.ts

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	providerIdentifiers,
	type ClineMessage,
	type GlobalState,
	type ModelInfo,
	type ProviderSettings,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { StreamIdleTimeoutError } from "../streamIdleTimeout"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"

// Private Task members this suite stubs. Typed so spies keep their signatures.
type TaskTestAccess = {
	getSystemPrompt: (requestState: ProviderState | undefined, requestModelInfo?: ModelInfo) => Promise<string>
	presentAssistantMessageSafe: () => void
	safeEnsureModelFetched: () => Promise<ModelInfo>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
}

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

function getTaskTestAccess(task: Task): TaskTestAccess {
	// Double cast: the private members above exist on Task but are not part of its public type.
	return task as unknown as TaskTestAccess
}

// Real-loop specs use real timers (Task yields via setImmediate, which fake timers would
// stall), so the timeouts are mocked to tiny values instead (plan D6).
const REQUEST_TIMEOUT_MS = 80
const STREAM_IDLE_TIMEOUT_MS = 30

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

type ApiReqInfo = { cancelReason?: string; streamingFailedMessage?: string }

function apiReqStartedRows(task: Task): ApiReqInfo[] {
	return task.clineMessages
		.filter((message: ClineMessage) => message.say === "api_req_started")
		.map((message) => (message.text ? (JSON.parse(message.text) as ApiReqInfo) : {}))
}

// A generator that yields `chunks` and then never produces another value or settles.
function stallingStream(chunks: ApiStreamChunk[], onStall?: () => void): ApiStream {
	return (async function* () {
		yield* chunks
		onStall?.()
		await new Promise<never>(() => {})
	})()
}

function failingStream(error: unknown): ApiStream {
	return (async function* () {
		yield* []
		throw error
	})()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("Task stream first-chunk and idle timeouts", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings

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

		const baseProviderState = await mockProvider.getState()
		vi.spyOn(mockProvider, "getState").mockResolvedValue({
			...baseProviderState,
			mcpEnabled: false,
			autoApprovalEnabled: true,
			requestDelaySeconds: 0,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function createLoopTask() {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "stream timeout test",
			startTask: false,
		})
		await task.getTaskMode()

		const access = getTaskTestAccess(task)
		vi.spyOn(access, "getSystemPrompt").mockResolvedValue("mock system prompt")
		vi.spyOn(access, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		vi.spyOn(access, "presentAssistantMessageSafe").mockImplementation(() => {})
		const backoffAndAnnounce = vi.spyOn(access, "backoffAndAnnounce").mockResolvedValue(undefined)
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		vi.spyOn(task, "getTokenUsage").mockReturnValue({
			totalCost: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			contextTokens: 0,
		})
		// The loop's abort path calls abortTask; keep teardown out of this suite.
		vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		const signals: Array<AbortSignal | undefined> = []
		const createMessage = vi.spyOn(task.api, "createMessage")

		// Ends the request loop: the next request sees an aborted task.
		const stopLoop = (): ApiStream => {
			task.abort = true
			return failingStream(new Error("stop: task aborted"))
		}

		const run = () => task.recursivelyMakeClineRequests([{ type: "text", text: "go" }])

		return { task, createMessage, signals, backoffAndAnnounce, stopLoop, run }
	}

	const recordSignal =
		(signals: Array<AbortSignal | undefined>) =>
		(_system: string, _messages: Anthropic.Messages.MessageParam[], metadata?: ApiHandlerCreateMessageMetadata) => {
			signals.push(metadata?.abortSignal)
		}

	it("aborts a stalled mid-stream request with StreamIdleTimeoutError and retries it", async () => {
		const { task, createMessage, signals, stopLoop, run } = await createLoopTask()
		const record = recordSignal(signals)
		createMessage
			.mockImplementationOnce((system, messages, metadata) => {
				record(system, messages, metadata)
				return stallingStream([{ type: "text", text: "partial" }])
			})
			.mockImplementationOnce(() => stopLoop())

		await run()

		const firstSignal = signals[0]
		expect(firstSignal?.aborted).toBe(true)
		expect(firstSignal?.reason).toBeInstanceOf(StreamIdleTimeoutError)
		expect(firstSignal?.reason).toMatchObject({ phase: "between_chunks", timeoutMs: STREAM_IDLE_TIMEOUT_MS })

		const [firstRow] = apiReqStartedRows(task)
		expect(firstRow?.cancelReason).toBe("streaming_failed")
		expect(firstRow?.streamingFailedMessage).toContain("No data received")

		// The retry issued a second request.
		expect(createMessage).toHaveBeenCalledTimes(2)
	})

	it("retries a first-chunk stall through the first-chunk retry path", async () => {
		const { task, createMessage, signals, backoffAndAnnounce, stopLoop, run } = await createLoopTask()
		const record = recordSignal(signals)
		createMessage
			.mockImplementationOnce((system, messages, metadata) => {
				record(system, messages, metadata)
				return stallingStream([])
			})
			.mockImplementationOnce(() => stopLoop())

		await run()

		expect(backoffAndAnnounce).toHaveBeenCalled()
		const [retryAttempt, error] = backoffAndAnnounce.mock.calls[0] ?? []
		expect(retryAttempt).toBe(0)
		expect(error).toBeInstanceOf(StreamIdleTimeoutError)
		expect(error).toMatchObject({ phase: "first_chunk", timeoutMs: REQUEST_TIMEOUT_MS })
		expect(createMessage).toHaveBeenCalledTimes(2)
		// The first-chunk retry happens inside attemptApiRequest, so it is not a streaming failure.
		expect(apiReqStartedRows(task)[0]?.cancelReason).not.toBe("streaming_failed")
	})

	it("does not apply the idle timeout to a long backoff inside the first next()", async () => {
		const { task, createMessage, backoffAndAnnounce, stopLoop, run } = await createLoopTask()
		backoffAndAnnounce.mockImplementation(() => sleep(STREAM_IDLE_TIMEOUT_MS * 4))
		createMessage
			.mockImplementationOnce(() => failingStream({ status: 503, message: "service unavailable" }))
			.mockImplementationOnce(() => asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]))
			.mockImplementationOnce(() => stopLoop())

		await run()

		// Two real requests (503 + success) before the stop request.
		expect(createMessage).toHaveBeenCalledTimes(3)
		expect(backoffAndAnnounce.mock.calls[0]?.[1]).not.toBeInstanceOf(StreamIdleTimeoutError)
		expect(apiReqStartedRows(task)[0]?.cancelReason).toBeUndefined()
		expect(apiReqStartedRows(task).some((row) => row.cancelReason === "streaming_failed")).toBe(false)
	})

	it("aborts the first request's signal on a first-chunk timeout before the controller is cleared", async () => {
		const { task, createMessage, stopLoop, run } = await createLoopTask()
		let fieldStillSetAtAbort: boolean | undefined
		let reasonAtAbort: unknown
		createMessage
			.mockImplementationOnce((_system, _messages, metadata) => {
				const signal = metadata?.abortSignal
				// Registered before attemptApiRequest's own cleanup listener, so it observes the
				// controller field as it was at the moment of the abort.
				signal?.addEventListener("abort", () => {
					fieldStillSetAtAbort = task.currentRequestAbortController?.signal === signal
					reasonAtAbort = signal.reason
				})
				return stallingStream([])
			})
			.mockImplementationOnce(() => stopLoop())

		await run()

		expect(reasonAtAbort).toBeInstanceOf(StreamIdleTimeoutError)
		expect(fieldStillSetAtAbort).toBe(true)
		expect(task.currentRequestAbortController).toBeUndefined()
	})

	it("aborts the first request's signal on a first-chunk timeout even if the controller field was cleared", async () => {
		const { task, createMessage, signals, stopLoop, run } = await createLoopTask()
		const record = recordSignal(signals)
		createMessage
			.mockImplementationOnce((system, messages, metadata) => {
				record(system, messages, metadata)
				return stallingStream([], () => {
					task.currentRequestAbortController = undefined
				})
			})
			.mockImplementationOnce(() => stopLoop())

		await run()

		expect(signals[0]?.aborted).toBe(true)
		expect(signals[0]?.reason).toBeInstanceOf(StreamIdleTimeoutError)
	})
})
