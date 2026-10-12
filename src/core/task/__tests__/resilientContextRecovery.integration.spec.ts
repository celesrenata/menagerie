// npx vitest run core/task/__tests__/resilientContextRecovery.integration.spec.ts
//
// Feature: resilient-context-recovery — integration coverage for the recovery
// decision layer threaded through Task.handleContextWindowExceededError /
// manageContext, using faked collaborators (no real VS Code host, no network).
//
// This file asserts the recovery THREADING behavior at the Task boundary:
//   1. The budget-derived target (computeServableInputBudget = window − output
//      reserve) replaces the fixed FORCED_CONTEXT_REDUCTION_PERCENT = 75 in the
//      manageContext call (Req 2.1, 2.2).
//   2. When a window-sufficient condensing profile exists, the RESOLVED recovery
//      handler — not the failing handler — carries the summarize/condense call
//      (Req 1.1, 1.2).
//   3. When no profile is window-sufficient, the deterministic convergentReduction
//      path runs and converges to the Servable_Input_Budget without a summarize
//      call on the too-small handler (Req 1.2, 2.5).
//
// The OmniRoute route→window mapping is owned by omniroute.ts /
// capability-lanes-routing and is cross-referenced, NOT re-tested here: the tests
// pass concrete window/reserve values directly, standing in for whatever
// resolveOmniRouteContextWindow would have produced for a lane.
//
// NOTE: task 9.2 appends additional describe blocks (terminal → failParallelWorker
// self-fail) to this same file; the harness below is shared so new blocks can be
// added cleanly without restructuring.

import type { ProviderSettings, ModelInfo } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
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

// summarizeConversation is the LLM call manageContext would make on the resolved
// recovery handler. Faked so the test observes WHICH handler threads through
// without a real model/stream; manageContext itself is faked separately below.
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

// manageContext is the condense-then-truncate seam. Faked so the test observes
// the apiHandler and autoCondenseContextPercent it receives (the budget-derived
// target). It returns a result whose newContextTokens is already under the budget
// so the post-summary deterministic floor converges without further truncation.
vi.mock("../../context-management", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../context-management")>()
	return {
		...actual,
		manageContext: vi.fn(),
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

// Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Builds a ModelInfo with an explicit window/output reserve. `maxTokens` is the
 * Output_Reserve getModelMaxOutputTokens derives, so the Servable_Input_Budget is
 * `contextWindow − maxTokens`. These values stand in for whatever OmniRoute's
 * resolveOmniRouteContextWindow would expose for a lane — the mapping itself lives
 * in omniroute.ts / capability-lanes-routing and is not re-tested here.
 */
function modelWith(contextWindow: number, maxTokens: number): ModelInfo {
	return { contextWindow, supportsPromptCache: false, maxTokens } as ModelInfo
}

/**
 * A faked ApiHandler. `countTokens` sums a per-block token weight read from each
 * block's text length so the deterministic convergentReduction floor shrinks a
 * real transcript deterministically. The handler is identity-distinct so tests
 * can assert which handler threaded through manageContext.
 */
function fakeApiHandler(id: string, info: ModelInfo, tokensPerChar = 1): ApiHandler {
	return {
		getModel: () => ({ id, info }),
		getCondenseContextWindow: undefined,
		countTokens: vi.fn(async (content: Array<{ type: string; text?: string }>) => {
			let total = 0
			for (const block of content) {
				total += (block.text?.length ?? 0) * tokensPerChar
			}
			return total
		}),
	} as unknown as ApiHandler
}

/** A text ApiMessage; `chars` controls its counted size via the fake countTokens. */
function textMessage(role: "user" | "assistant", chars: number): ApiMessage {
	return { role, content: [{ type: "text", text: "x".repeat(chars) }] } as ApiMessage
}

interface HarnessOptions {
	/** The failing task's own handler model info (the lane that overflowed). */
	taskModel: ModelInfo
	/** Reported current transcript token count (getTokenUsage().contextTokens). */
	contextTokens: number
	/** Conversation history convergentReduction operates on in the deterministic path. */
	history?: ApiMessage[]
	/** Resolved condensing handler; defaults to the task's own handler (unset case). */
	condensingHandler?: (task: Task) => ApiHandler
	/** Whether the task is a parallel worker (used by 9.2's terminal self-fail block). */
	parallelWorker?: boolean
}

interface Harness {
	task: Task
	taskApi: ApiHandler
	resolverSpy: ReturnType<typeof vi.fn>
	failParallelWorkerSpy: ReturnType<typeof vi.fn>
	saySpy: ReturnType<typeof vi.fn>
	overwriteSpy: ReturnType<typeof vi.fn>
}

function createHarness(options: HarnessOptions): Harness {
	const mockProvider = {
		context: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn().mockResolvedValue({ listApiConfigMeta: [], customSupportPrompts: {}, profileThresholds: {} }),
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

	// The failing task's own handler (`this.api`) — the lane that overflowed.
	const taskApi = fakeApiHandler("task-model", options.taskModel)
	task.api = taskApi

	const t = task as unknown as Record<string, unknown>
	t.getSystemPrompt = vi.fn().mockResolvedValue("system")
	t.getTaskMode = vi.fn().mockResolvedValue("code")
	t.getCurrentProfileId = vi.fn().mockReturnValue("default")
	t.getDisabledTools = vi.fn().mockReturnValue([])
	t.getTokenUsage = vi.fn().mockReturnValue({ contextTokens: options.contextTokens })

	// Seed the conversation history the deterministic reduction operates on.
	;(task as unknown as { apiConversationHistory: ApiMessage[] }).apiConversationHistory = options.history ?? []

	// Observe history overwrites and say() reporting without touching disk/UI.
	const overwriteSpy = vi.fn(async (newHistory: ApiMessage[]) => {
		;(task as unknown as { apiConversationHistory: ApiMessage[] }).apiConversationHistory = newHistory
	})
	t.overwriteApiConversationHistory = overwriteSpy
	const saySpy = vi.fn().mockResolvedValue(undefined)
	t.say = saySpy

	// Resolve the condensing handler to the configured profile (or this.api).
	const resolved = options.condensingHandler ? options.condensingHandler(task) : task.api
	const resolverSpy = vi.fn().mockResolvedValue(resolved)
	t.getCondensingApiHandler = resolverSpy

	// Parallel-worker self-fail seam (consumed by 9.2); spied so no real abort runs.
	const failParallelWorkerSpy = vi.fn().mockResolvedValue(undefined)
	t.failParallelWorker = failParallelWorkerSpy
	;(task as unknown as { parallelWorker: boolean }).parallelWorker = options.parallelWorker ?? false

	return { task, taskApi, resolverSpy, failParallelWorkerSpy, saySpy, overwriteSpy }
}

function callHandleContextWindowExceeded(task: Task, requestModelInfo: ModelInfo) {
	return (
		task as unknown as {
			handleContextWindowExceededError(info: ModelInfo): Promise<{ retry: boolean; terminalError?: unknown }>
		}
	).handleContextWindowExceededError(requestModelInfo)
}

/** A manageContext fake that reports a post-condense size already under `postTokens`. */
function manageContextReturns(postTokens: number) {
	mockManageContext.mockImplementation(async ({ messages }) => ({
		messages,
		summary: "condensed",
		cost: 0,
		prevContextTokens: 0,
		newContextTokens: postTokens,
	}))
}

beforeEach(() => {
	mockSummarizeConversation.mockClear()
	mockManageContext.mockReset()
})

// ── Recovery threading through handleContextWindowExceededError / manageContext ──
// (Task 9.1 — Requirements 1.1, 1.2, 2.1, 2.2, 2.5)

describe("resilient context recovery — recovery threading (9.1)", () => {
	describe("budget-derived reduction target (Req 2.1, 2.2)", () => {
		it("replaces the fixed 75% with the Servable_Input_Budget-derived percent in the manageContext call", async () => {
			// Large-context recovery profile (window-sufficient) so manageContext is reached.
			// Failing lane window 100000, reserve 20000 ⇒ Servable_Input_Budget 80000.
			// useAvailableInputForContextPercent is false (no getCondenseContextWindow), so the
			// effective target percent = 100 * budget / window = 100 * 80000 / 100000 = 80 — NOT 75.
			const failingModel = modelWith(100_000, 20_000)
			const bigProfileModel = modelWith(262_144, 20_000)
			const { task } = createHarness({
				taskModel: failingModel,
				contextTokens: 150_000, // over the failing window, within the big profile's bound
				condensingHandler: (t) => {
					void t
					return fakeApiHandler("big-reader", bigProfileModel)
				},
			})
			manageContextReturns(70_000)

			await callHandleContextWindowExceeded(task, failingModel)

			expect(mockManageContext).toHaveBeenCalledTimes(1)
			const percent = mockManageContext.mock.calls[0][0].autoCondenseContextPercent
			// Budget-derived (80), distinct from the former FORCED_CONTEXT_REDUCTION_PERCENT = 75.
			expect(percent).toBeCloseTo(80, 5)
			expect(percent).not.toBe(75)
		})

		it("derives a different target when only the failing window differs (no hard-coded size)", async () => {
			// Same transcript + reserve, different served windows ⇒ proportionally different targets,
			// confirming the target tracks the OmniRoute-exposed window rather than a literal.
			const bigProfileModel = modelWith(262_144, 10_000)

			const runWithWindow = async (window: number) => {
				mockManageContext.mockReset()
				manageContextReturns(window - 60_000)
				const { task } = createHarness({
					taskModel: modelWith(window, 10_000),
					contextTokens: 200_000,
					condensingHandler: () => fakeApiHandler("big-reader", bigProfileModel),
				})
				await callHandleContextWindowExceeded(task, modelWith(window, 10_000))
				return mockManageContext.mock.calls[0][0].autoCondenseContextPercent
			}

			const percentA = await runWithWindow(100_000) // 100 * 90000/100000 = 90
			const percentB = await runWithWindow(120_000) // 100 * 110000/120000 ≈ 91.67
			expect(percentA).toBeCloseTo(90, 5)
			expect(percentB).toBeCloseTo((100 * 110_000) / 120_000, 5)
			expect(percentA).not.toBeCloseTo(percentB, 2)
		})
	})

	describe("large-context recovery handler carries the summarize call (Req 1.1, 1.2)", () => {
		it("threads the window-sufficient condensing profile — not the failing handler — into manageContext", async () => {
			// Failing lane too small (32768 served window, incident-scale). The configured condensing
			// profile has a 262144 window, so the resolver picks IT as the Large_Context_Recovery_Handler.
			const failingModel = modelWith(32_768, 8_192)
			const bigProfileModel = modelWith(262_144, 16_384)
			let bigHandler: ApiHandler | undefined
			const { task, taskApi } = createHarness({
				taskModel: failingModel,
				contextTokens: 60_000, // > failing bound (24576), < big profile bound (245760)
				condensingHandler: () => {
					bigHandler = fakeApiHandler("big-reader", bigProfileModel)
					return bigHandler
				},
			})
			manageContextReturns(20_000)

			await callHandleContextWindowExceeded(task, failingModel)

			expect(mockManageContext).toHaveBeenCalledTimes(1)
			// The resolved recovery handler carries the call — the failing handler does NOT.
			expect(mockManageContext.mock.calls[0][0].apiHandler).toBe(bigHandler)
			expect(mockManageContext.mock.calls[0][0].apiHandler).not.toBe(taskApi)
		})

		it("recovery-handler selection is independent of the failing lane window (Req 1.2)", async () => {
			// Two failing lanes differing only in their served window resolve to the SAME recovery
			// handler for the same transcript, because the resolver never consults the failing window.
			const bigProfileModel = modelWith(262_144, 16_384)
			const run = async (failingWindow: number) => {
				mockManageContext.mockReset()
				manageContextReturns(20_000)
				let handler: ApiHandler | undefined
				const { task } = createHarness({
					taskModel: modelWith(failingWindow, 8_192),
					contextTokens: 60_000,
					condensingHandler: () => {
						handler = fakeApiHandler("big-reader", bigProfileModel)
						return handler
					},
				})
				await callHandleContextWindowExceeded(task, modelWith(failingWindow, 8_192))
				return { threaded: mockManageContext.mock.calls[0][0].apiHandler, handler }
			}

			const a = await run(32_768)
			const b = await run(16_384)
			// Each run threaded its own resolved big-reader handler (not the failing handler),
			// proving selection depends on required input vs. candidate windows, not the lane.
			expect(a.threaded).toBe(a.handler)
			expect(b.threaded).toBe(b.handler)
		})
	})

	describe("deterministic convergentReduction path when no profile is window-sufficient (Req 1.2, 2.5)", () => {
		it("runs model-free reduction to the Servable_Input_Budget and issues no summarize call", async () => {
			// Only this.api (too small): failing window 32768, reserve 8192 ⇒ budget 24576.
			// No distinct condensing profile ⇒ resolver returns the deterministic path.
			const failingModel = modelWith(32_768, 8_192)
			const budget = 32_768 - 8_192 // 24576

			// History: first task message + several oldest removable messages + two newest visible.
			// countTokens weights each char as 1 token. Oldest messages are large so removing them
			// brings the surviving transcript under the budget in one bounded pass; the irreducible
			// core (first + two newest) is small enough to fit.
			const history: ApiMessage[] = [
				textMessage("user", 5_000), // first task message (preserved)
				textMessage("assistant", 40_000), // removable
				textMessage("user", 40_000), // removable
				textMessage("assistant", 3_000), // newest-1 (preserved)
				textMessage("user", 2_000), // newest (preserved)
			]

			const { task, taskApi, saySpy, overwriteSpy } = createHarness({
				taskModel: failingModel,
				contextTokens: 90_000, // well over the budget (incident-scale over-size ratio)
				history,
				// No condensingHandler ⇒ resolver returns this.api ⇒ only too-small candidate.
			})

			const decision = await callHandleContextWindowExceeded(task, failingModel)

			// No summarize/condense call on the too-small lane.
			expect(mockManageContext).not.toHaveBeenCalled()
			expect(mockSummarizeConversation).not.toHaveBeenCalled()

			// The transcript was overwritten by the deterministic reduction and converged.
			expect(overwriteSpy).toHaveBeenCalledTimes(1)
			const reducedHistory = overwriteSpy.mock.calls[0][0] as ApiMessage[]
			expect(reducedHistory.length).toBeLessThan(history.length)

			// Converged ⇒ retry (resume once under budget), no terminal error.
			expect(decision.retry).toBe(true)
			expect(decision.terminalError).toBeUndefined()

			// Reported as sliding_window_truncation (the deterministic reduction say-type), and the
			// surviving transcript counts at or below the Servable_Input_Budget via the task handler.
			const sayTypes = saySpy.mock.calls.map((c) => c[0])
			expect(sayTypes).toContain("sliding_window_truncation")
			const survivingTokens = await (
				taskApi.countTokens as unknown as (c: Array<{ type: string; text?: string }>) => Promise<number>
			)(reducedHistory.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as never)
			expect(survivingTokens).toBeLessThanOrEqual(budget)
		})
	})
})

// ── Terminal → failParallelWorker self-fail short-circuit (9.2) ──────────────
// (Task 9.2 — Requirements 5.2, 5.3, 5.5)
//
// Scenario: the transcript's IRREDUCIBLE CORE (first task message + the two
// newest visible messages, which truncation never removes) exceeds the
// Servable_Input_Budget, so convergentReduction returns converged:false and
// classifyRecoveryOutcome yields a TERMINAL RetryDecision
// ({ retry:false, terminalError } with the non-recoverable context-overflow tag).
//
// Two boundaries are exercised against the SAME terminal condition:
//   1. The decision boundary: handleContextWindowExceededError surfaces the
//      terminal decision (retry:false + classified terminalError).
//   2. The attemptApiRequest context-window branch (task 8.1 wiring) consumes
//      that decision — the branch is driven through the REAL generator with a
//      createMessage that throws a context-window error (mirroring the throwing-
//      stream pattern in Task.parallel-worker-failure.spec.ts):
//        - a PARALLEL WORKER self-fails via failParallelWorker(reason) exactly
//          once with the context-overflow reason, and does NOT recurse/idle
//          against PARALLEL_WORKER_MAX_API_RETRIES;
//        - a NON-WORKER task THROWS the classified TerminalContextError and does
//          NOT call failParallelWorker.
//
// The parallel-worker self-fail/abort mechanics are owned by
// elastic-parallel-execution and are cross-referenced here (failParallelWorker is
// spied) rather than re-tested.

import { checkContextWindowExceededError } from "../../context/context-management/context-error-handling"
import { CONTEXT_OVERFLOW_NON_RECOVERABLE } from "../contextRecoveryClassifier"

/**
 * A terminal transcript: the irreducible core (first + two newest visible) counts
 * to `coreChars` total, which must exceed the Servable_Input_Budget. The two
 * removable middle messages are large enough that even dropping them cannot bring
 * the surviving transcript under budget, so convergentReduction converges to the
 * irreducible core and reports converged:false.
 */
function terminalHistory(firstChars: number, newestOneChars: number, newestChars: number): ApiMessage[] {
	return [
		textMessage("user", firstChars), // first task message (preserved)
		textMessage("assistant", 50_000), // removable
		textMessage("user", 50_000), // removable
		textMessage("assistant", newestOneChars), // newest-1 (preserved)
		textMessage("user", newestChars), // newest (preserved)
	]
}

/** A context-window error shaped so checkContextWindowExceededError recognizes it. */
function contextWindowError(): Error {
	return Object.assign(new Error("This model's maximum context length is 40000 tokens"), { status: 400 })
}

/**
 * An ApiStream that yields nothing then throws on the first chunk, mirroring the
 * `streamThenThrow([], error)` pattern in Task.parallel-worker-failure.spec.ts. The
 * first-chunk catch in attemptApiRequest runs the context-window retry branch.
 */
function streamThenThrow(error: unknown): () => AsyncGenerator<unknown> {
	return async function* () {
		yield* []
		throw error
	}
}

/**
 * Fully drive the REAL attemptApiRequest generator through its context-window
 * retry branch. `createMessage` throws a context-window error on the first chunk;
 * the branch then runs handleContextWindowExceededError (real, terminal here) and
 * routes the terminal decision to failParallelWorker (worker) or a throw
 * (non-worker). Returns the collected chunks (empty on the worker self-fail path).
 *
 * Stubs the few request-construction collaborators the lightweight harness leaves
 * real but that are irrelevant to the terminal branch (model fetch, file-context
 * read), passing the request model info so no catalog fetch runs.
 */
async function driveAttemptApiRequest(
	task: Task,
	requestModelInfo: ModelInfo,
	stream: () => AsyncGenerator<unknown>,
) {
	const t = task as unknown as Record<string, unknown>
	t.safeEnsureModelFetched = vi.fn().mockResolvedValue(requestModelInfo)
	t.getFilesReadByRooSafely = vi.fn().mockResolvedValue(undefined)
	// The PRE-request manageContext seam in attemptApiRequest (distinct from the recovery one in
	// handleContextWindowExceededError) runs because contextTokens is over threshold. It is irrelevant
	// to the terminal branch under test, so return the history unchanged (same reference ⇒ no overwrite)
	// and let the request proceed to createMessage, which throws the context-window error.
	mockManageContext.mockImplementation(async ({ messages }) => ({
		messages,
		summary: "",
		cost: 0,
		prevContextTokens: 0,
	}))
	// createMessage throws the context-window error on first chunk, triggering the branch.
	;(task.api as unknown as { createMessage: unknown }).createMessage = vi.fn(() => stream())

	const generator = (
		task as unknown as {
			attemptApiRequest(
				retryAttempt: number,
				options: { requestModelInfo?: ModelInfo },
			): AsyncGenerator<unknown>
		}
	).attemptApiRequest(0, { requestModelInfo })

	const chunks: unknown[] = []
	for await (const chunk of generator) {
		chunks.push(chunk)
	}
	return chunks
}

describe("resilient context recovery — terminal self-fail short-circuit (9.2)", () => {
	// Failing lane window 40000, reserve 8000 ⇒ Servable_Input_Budget 32000.
	// Irreducible core 20000 + 15000 + 15000 = 50000 > 32000 ⇒ non-recoverable.
	const failingModel = modelWith(40_000, 8_000)
	const budget = 40_000 - 8_000 // 32000
	const history = () => terminalHistory(20_000, 15_000, 15_000)

	describe("decision boundary (Req 5.2, 5.4)", () => {
		it("handleContextWindowExceededError returns a terminal RetryDecision carrying the non-recoverable tag", async () => {
			// Deterministic path (no distinct condensing profile): convergentReduction operates on the
			// transcript and cannot bring the irreducible core under the budget ⇒ converged:false.
			const { task } = createHarness({
				taskModel: failingModel,
				contextTokens: 150_000, // incident-scale over-size ratio, well above the budget
				history: history(),
			})

			const decision = await callHandleContextWindowExceeded(task, failingModel)

			// Terminal: no retry, classified non-recoverable context-window overflow (distinct from a
			// transient API failure), with the irreducible size and budget it exceeded.
			expect(decision.retry).toBe(false)
			expect(decision.terminalError).toBeDefined()
			const terminalError = decision.terminalError as {
				classification: string
				irreducibleTokens: number
				budget: number
			}
			expect(terminalError.classification).toBe(CONTEXT_OVERFLOW_NON_RECOVERABLE)
			expect(terminalError.budget).toBe(budget)
			expect(terminalError.irreducibleTokens).toBeGreaterThan(budget)
			// No summarize/condense LLM call on the too-small failing lane.
			expect(mockManageContext).not.toHaveBeenCalled()
			expect(mockSummarizeConversation).not.toHaveBeenCalled()
		})
	})

	describe("parallel worker: self-fails via failParallelWorker, does not recurse (Req 5.3, 5.5)", () => {
		it("drives the attemptApiRequest branch to call failParallelWorker exactly once with the context-overflow reason", async () => {
			const { task, taskApi, failParallelWorkerSpy } = createHarness({
				taskModel: failingModel,
				contextTokens: 150_000,
				history: history(),
				parallelWorker: true,
			})

			// Sanity: the error the faked stream throws IS a context-window error, so the branch runs.
			expect(checkContextWindowExceededError(contextWindowError())).toBe(true)

			const chunks = await driveAttemptApiRequest(task, failingModel, streamThenThrow(contextWindowError()))

			// The worker self-failed cleanly: failParallelWorker called exactly once with the
			// context-overflow reason (the terminalError.message), and the generator returned WITHOUT
			// yielding — it did not recurse into another attemptApiRequest pass against
			// PARALLEL_WORKER_MAX_API_RETRIES.
			expect(failParallelWorkerSpy).toHaveBeenCalledTimes(1)
			const reason = failParallelWorkerSpy.mock.calls[0][0] as string
			expect(reason).toContain("non-recoverable")
			expect(reason).toContain("servable input budget")
			expect(chunks).toEqual([])
			// Exactly one API attempt was made — no retry recursion.
			expect((taskApi as unknown as { createMessage: ReturnType<typeof vi.fn> }).createMessage).toHaveBeenCalledTimes(1)
		})
	})

	describe("non-worker task: throws the classified terminal error, no self-fail (Req 5.2)", () => {
		it("drives the attemptApiRequest branch to throw the TerminalContextError without calling failParallelWorker", async () => {
			const { task, taskApi, failParallelWorkerSpy } = createHarness({
				taskModel: failingModel,
				contextTokens: 150_000,
				history: history(),
				parallelWorker: false,
			})

			// The non-worker path throws the classified terminal error (auto-retry stops recursing).
			await expect(
				driveAttemptApiRequest(task, failingModel, streamThenThrow(contextWindowError())),
			).rejects.toMatchObject({
				classification: CONTEXT_OVERFLOW_NON_RECOVERABLE,
				budget,
			})

			// A non-worker never self-fails, and only one API attempt was made (no retry recursion).
			expect(failParallelWorkerSpy).not.toHaveBeenCalled()
			expect(
				(taskApi as unknown as { createMessage: ReturnType<typeof vi.fn> }).createMessage,
			).toHaveBeenCalledTimes(1)
		})
	})
})
