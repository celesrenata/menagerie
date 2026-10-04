// npx vitest run core/task/__tests__/Task.condensing-handler.spec.ts

import type { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { buildApiHandler } from "../../../api"
import type { ApiHandler } from "../../../api"

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

// Mock buildApiHandler so each call returns a distinct, identifiable handler.
// The Task constructor builds `this.api` from the first call; subsequent calls
// (condensing resolution) must yield a different object to prove the branch taken.
vi.mock("../../../api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../api")>()
	let counter = 0
	return {
		...actual,
		buildApiHandler: vi.fn((config: ProviderSettings) => ({
			__id: `handler-${counter++}`,
			__config: config,
		})),
	}
})

const mockBuildApiHandler = vi.mocked(buildApiHandler)

const baseApiConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

type MutableState = {
	condensingApiConfigId?: string
	listApiConfigMeta: Array<{ id: string; name?: string }>
	omniRouteTier?: number
}

function createTask(state: MutableState, getProfile: ReturnType<typeof vi.fn>, logFn = vi.fn()) {
	const mockProvider = {
		context: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn().mockImplementation(async () => state),
		providerSettingsManager: { getProfile },
		log: logFn,
		on: vi.fn(),
		off: vi.fn(),
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

	return { task, mockProvider }
}

// Access the private helper without an `as any` double assertion.
function resolveCondensingHandler(task: Task): Promise<ApiHandler> {
	return (task as unknown as { getCondensingApiHandler(): Promise<ApiHandler> }).getCondensingApiHandler()
}

describe("Task.getCondensingApiHandler", () => {
	beforeEach(() => {
		mockBuildApiHandler.mockClear()
	})

	it("(a) returns the task's own this.api when condensingApiConfigId is unset", async () => {
		const getProfile = vi.fn()
		const { task } = createTask({ condensingApiConfigId: undefined, listApiConfigMeta: [] }, getProfile)

		const handler = await resolveCondensingHandler(task)

		expect(handler).toBe(task.api)
		expect(getProfile).not.toHaveBeenCalled()
	})

	it("(b) returns this.api and never calls getProfile when the id is absent from listApiConfigMeta", async () => {
		const getProfile = vi.fn()
		const { task } = createTask(
			{ condensingApiConfigId: "missing-id", listApiConfigMeta: [{ id: "other-id", name: "Other" }] },
			getProfile,
		)

		const handler = await resolveCondensingHandler(task)

		expect(handler).toBe(task.api)
		expect(getProfile).not.toHaveBeenCalled()
	})

	it("(c) returns a handler built from the chosen profile when valid", async () => {
		const profileSettings = {
			apiProvider: providerIdentifiers.openai,
			apiModelId: "reader-model",
		}
		const getProfile = vi.fn().mockResolvedValue({ name: "Reader", ...profileSettings })
		const { task } = createTask(
			{ condensingApiConfigId: "reader-id", listApiConfigMeta: [{ id: "reader-id", name: "Reader" }] },
			getProfile,
		)

		const builtBefore = mockBuildApiHandler.mock.calls.length
		const handler = await resolveCondensingHandler(task)

		expect(getProfile).toHaveBeenCalledWith({ id: "reader-id" })
		expect(mockBuildApiHandler.mock.calls.length).toBe(builtBefore + 1)
		// Built from the resolved provider settings (name stripped).
		expect(mockBuildApiHandler).toHaveBeenLastCalledWith(profileSettings)
		expect(handler).not.toBe(task.api)
	})

	it("(d) returns this.api when the resolved profile has no apiProvider", async () => {
		const getProfile = vi.fn().mockResolvedValue({ name: "NoProvider", apiModelId: "x" })
		const { task } = createTask(
			{ condensingApiConfigId: "no-provider-id", listApiConfigMeta: [{ id: "no-provider-id" }] },
			getProfile,
		)

		const handler = await resolveCondensingHandler(task)

		expect(getProfile).toHaveBeenCalledWith({ id: "no-provider-id" })
		expect(handler).toBe(task.api)
	})

	it("(e) returns this.api and logs when getProfile throws", async () => {
		const logFn = vi.fn()
		const getProfile = vi.fn().mockRejectedValue(new Error("boom"))
		const { task } = createTask(
			{ condensingApiConfigId: "bad-id", listApiConfigMeta: [{ id: "bad-id" }] },
			getProfile,
			logFn,
		)

		const handler = await resolveCondensingHandler(task)

		expect(handler).toBe(task.api)
		expect(logFn).toHaveBeenCalled()
		expect(logFn.mock.calls[0][0]).toContain("bad-id")
	})

	it("(f) rebuilds on a mid-task config change and falls back to this.api when cleared", async () => {
		const profileA = { apiProvider: providerIdentifiers.openai, apiModelId: "model-a" }
		const profileB = { apiProvider: providerIdentifiers.openai, apiModelId: "model-b" }
		const getProfile = vi
			.fn()
			.mockImplementation(async ({ id }: { id: string }) =>
				id === "id-a" ? { name: "A", ...profileA } : { name: "B", ...profileB },
			)
		const state: MutableState = {
			condensingApiConfigId: "id-a",
			listApiConfigMeta: [{ id: "id-a" }, { id: "id-b" }],
		}
		const { task } = createTask(state, getProfile)

		const handlerA1 = await resolveCondensingHandler(task)
		const buildsAfterA1 = mockBuildApiHandler.mock.calls.length
		// Same id again reuses the cached built handler (no rebuild, no getProfile).
		getProfile.mockClear()
		const handlerA2 = await resolveCondensingHandler(task)
		expect(handlerA2).toBe(handlerA1)
		expect(mockBuildApiHandler.mock.calls.length).toBe(buildsAfterA1)
		expect(getProfile).not.toHaveBeenCalled()

		// Change the id -> rebuild.
		state.condensingApiConfigId = "id-b"
		const handlerB = await resolveCondensingHandler(task)
		expect(handlerB).not.toBe(handlerA1)
		expect(mockBuildApiHandler.mock.calls.length).toBe(buildsAfterA1 + 1)
		expect(mockBuildApiHandler).toHaveBeenLastCalledWith(profileB)

		// Clear -> back to this.api.
		state.condensingApiConfigId = ""
		const handlerUnset = await resolveCondensingHandler(task)
		expect(handlerUnset).toBe(task.api)
	})

	describe("OmniRoute tier", () => {
		const omniRouteProfile = {
			apiProvider: providerIdentifiers.openai,
			openAiIsOmniRoute: true,
			openAiModelId: "hybrid/reader",
		}
		const meta = [{ id: "omni-id", name: "Omni" }]

		it("applies the live global tier to an OmniRoute condensing profile", async () => {
			const getProfile = vi.fn().mockResolvedValue({ name: "Omni", ...omniRouteProfile })
			const { task } = createTask(
				{ condensingApiConfigId: "omni-id", listApiConfigMeta: meta, omniRouteTier: 1 },
				getProfile,
			)

			await resolveCondensingHandler(task)

			expect(mockBuildApiHandler).toHaveBeenLastCalledWith(expect.objectContaining({ omniRouteTier: 1 }))
		})

		it("drops a stale snapshot when the global tier is unset", async () => {
			const getProfile = vi.fn().mockResolvedValue({ name: "Omni", ...omniRouteProfile, omniRouteTier: 5 })
			const { task } = createTask({ condensingApiConfigId: "omni-id", listApiConfigMeta: meta }, getProfile)

			await resolveCondensingHandler(task)

			expect(mockBuildApiHandler).toHaveBeenLastCalledWith(omniRouteProfile)
		})

		it("never applies the tier to a non-OmniRoute condensing profile", async () => {
			const profile = { apiProvider: providerIdentifiers.openai, apiModelId: "reader-model" }
			const getProfile = vi.fn().mockResolvedValue({ name: "Omni", ...profile })
			const { task } = createTask(
				{ condensingApiConfigId: "omni-id", listApiConfigMeta: meta, omniRouteTier: 1 },
				getProfile,
			)

			await resolveCondensingHandler(task)

			expect(mockBuildApiHandler).toHaveBeenLastCalledWith(profile)
		})
	})

	it("returns this.api when the provider reference is dead", async () => {
		const getProfile = vi.fn()
		const { task } = createTask({ condensingApiConfigId: "reader-id", listApiConfigMeta: [] }, getProfile)

		// Simulate teardown: the WeakRef no longer resolves a provider.
		;(task as unknown as { providerRef: { deref(): undefined } }).providerRef = { deref: () => undefined }

		const handler = await resolveCondensingHandler(task)

		expect(handler).toBe(task.api)
		expect(getProfile).not.toHaveBeenCalled()
	})
})
