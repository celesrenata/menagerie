// npx vitest run core/task/__tests__/Task.condensing-threading.spec.ts

import type { ProviderSettings, ModelInfo } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import type { ApiHandler } from "../../../api"
import { summarizeConversation } from "../../condense"
import { manageContext } from "../../context-management"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				captureTaskCreated: vi.fn(),
				captureTaskRestarted: vi.fn(),
				captureModeSwitch: vi.fn(),
				captureConversationMessage: vi.fn(),
				captureLlmCompletion: vi.fn(),
				captureConsecutiveMistakeError: vi.fn(),
				captureCodeActionUsed: vi.fn(),
				setProvider: vi.fn(),
			}
		},
	},
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }

	return {
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: {
				all: [],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: unknown) => d })),
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: { from: vi.fn() },
		TabInputText: vi.fn(),
		TabInputTextDiff: vi.fn(),
		version: "1.85.0",
	}
})

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../condense", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../condense")>()
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [],
			summary: "",
			cost: 0,
			newContextTokens: 0,
		}),
	}
})

vi.mock("../../context-management", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../context-management")>()
	return {
		...actual,
		manageContext: vi.fn().mockResolvedValue({ messages: [], summary: "", cost: 0, prevContextTokens: 0 }),
	}
})

vi.mock("../build-tools", () => ({
	buildNativeToolsArrayWithRestrictions: vi.fn().mockResolvedValue({ tools: [] }),
}))

const mockSummarizeConversation = vi.mocked(summarizeConversation)
const mockManageContext = vi.mocked(manageContext)

const baseApiConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

const modelInfo: ModelInfo = {
	contextWindow: 200000,
	supportsPromptCache: false,
	maxTokens: 8192,
} as ModelInfo

function createTask(): { task: Task } {
	const mockProvider = {
		context: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn().mockResolvedValue({ listApiConfigMeta: [], customSupportPrompts: {} }),
		providerSettingsManager: { getProfile: vi.fn() },
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
	} as unknown as ClineProvider

	const task = new Task({
		provider: mockProvider,
		apiConfiguration: baseApiConfig,
		task: "test task",
		startTask: false,
	})

	// Stub the model-dependent helpers the condensing sites touch, so the test
	// isolates the apiHandler threading rather than model/prompt plumbing.
	task.api = {
		getModel: () => ({ id: "task-model", info: modelInfo }),
		getCondenseContextWindow: undefined,
	} as unknown as ApiHandler

	const t = task as unknown as Record<string, unknown>
	t.getSystemPrompt = vi.fn().mockResolvedValue("system")
	t.getTaskMode = vi.fn().mockResolvedValue("code")
	t.getCurrentProfileId = vi.fn().mockReturnValue("default")
	t.getDisabledTools = vi.fn().mockReturnValue([])
	t.getFilesReadByRooSafely = vi.fn().mockResolvedValue(undefined)
	t.flushPendingToolResultsToHistory = vi.fn().mockResolvedValue(undefined)
	t.safeEnsureModelFetched = vi.fn().mockResolvedValue(modelInfo)
	t.getTokenUsage = vi.fn().mockReturnValue({ contextTokens: 1000 })

	return { task }
}

/** Spy the private resolver to return a chosen handler sentinel. */
function spyCondensingResolver(task: Task, handler: ApiHandler) {
	const spy = vi.fn().mockResolvedValue(handler)
	;(task as unknown as { getCondensingApiHandler: () => Promise<ApiHandler> }).getCondensingApiHandler = spy
	return spy
}

async function callHandleContextWindowExceeded(task: Task) {
	await (
		task as unknown as { handleContextWindowExceededError(info: ModelInfo): Promise<void> }
	).handleContextWindowExceededError(modelInfo)
}

describe("Task condensing-handler threading", () => {
	beforeEach(() => {
		mockSummarizeConversation.mockClear()
		mockManageContext.mockClear()
	})

	it("condenseContext() passes the resolved condensing handler to summarizeConversation (set case)", async () => {
		const { task } = createTask()
		const built = { getModel: () => ({ id: "reader" }) } as unknown as ApiHandler
		const resolverSpy = spyCondensingResolver(task, built)

		await task.condenseContext()

		expect(resolverSpy).toHaveBeenCalled()
		expect(mockSummarizeConversation).toHaveBeenCalledTimes(1)
		expect(mockSummarizeConversation.mock.calls[0][0].apiHandler).toBe(built)
	})

	it("condenseContext() passes this.api to summarizeConversation (unset case)", async () => {
		const { task } = createTask()
		spyCondensingResolver(task, task.api)

		await task.condenseContext()

		expect(mockSummarizeConversation).toHaveBeenCalledTimes(1)
		expect(mockSummarizeConversation.mock.calls[0][0].apiHandler).toBe(task.api)
	})

	it("handleContextWindowExceededError() passes the resolved condensing handler to manageContext (set case)", async () => {
		const { task } = createTask()
		const built = { getModel: () => ({ id: "reader" }) } as unknown as ApiHandler
		const resolverSpy = spyCondensingResolver(task, built)

		await callHandleContextWindowExceeded(task)

		expect(resolverSpy).toHaveBeenCalled()
		expect(mockManageContext).toHaveBeenCalledTimes(1)
		expect(mockManageContext.mock.calls[0][0].apiHandler).toBe(built)
	})

	it("handleContextWindowExceededError() passes this.api to manageContext (unset case)", async () => {
		const { task } = createTask()
		spyCondensingResolver(task, task.api)

		await callHandleContextWindowExceeded(task)

		expect(mockManageContext).toHaveBeenCalledTimes(1)
		expect(mockManageContext.mock.calls[0][0].apiHandler).toBe(task.api)
	})
})
