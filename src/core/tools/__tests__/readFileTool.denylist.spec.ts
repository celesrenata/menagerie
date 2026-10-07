/**
 * Integration tests for ReadFileTool's parallel-worker read-input controls
 * (parallel-input-bloat FEAT-002):
 *
 *   - Lever 1 (read-scope junk exclusion): a vendored path is denied with a
 *     one-line category notice and no content enters the result (AC-1); a
 *     first-party source read is allowed (AC-4).
 *   - Lever 2 (per-worker read-input budget): once the budget is crossed, a
 *     default-limit read is tightened to BUDGET_TIGHTENED_LINE_LIMIT — including
 *     the batched-read clamp (AC-9a) — while an explicit `limit` read is honored
 *     (AC-9).
 *   - FR-6 / AC-10: a per-worker log line records denied bytes and cumulative
 *     ingested bytes.
 */

import type { Stats } from "fs"

import { isBinaryFile } from "isbinaryfile"

import { BUDGET_TIGHTENED_LINE_LIMIT, DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES } from "@roo-code/types"
import type { ReadFileToolParams } from "@roo-code/types"

import type { Task } from "../../task/Task"
import { readFileTool } from "../ReadFileTool"
import { readWithIndentation, readWithSlice } from "../../../integrations/misc/indentation-reader"

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		default: originalPath,
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => args.join("/")),
	}
})

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	stat: vi.fn(),
}))

vi.mock("isbinaryfile")

vi.mock("../../../integrations/misc/indentation-reader", () => ({
	readWithIndentation: vi.fn(),
	readWithSlice: vi.fn(),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: vi.fn(() => "The user denied this operation."),
		toolDeniedWithFeedback: vi.fn((feedback?: string) => `denied: ${feedback}`),
		toolApprovedWithFeedback: vi.fn((feedback?: string) => `approved: ${feedback}`),
		rooIgnoreError: vi.fn((filePath: string) => `blocked by .rooignore: ${filePath}`),
		toolResult: vi.fn((text: string) => text),
		imageBlocks: vi.fn(() => []),
	},
}))

const fsPromises = await import("fs/promises")
const mockedFsReadFile = vi.mocked(fsPromises.readFile)
const mockedFsStat = vi.mocked(fsPromises.stat)
const mockedIsBinaryFile = vi.mocked(isBinaryFile)
const mockedReadWithSlice = vi.mocked(readWithSlice)
const mockedReadWithIndentation = vi.mocked(readWithIndentation)

// ─── Test helpers ───────────────────────────────────────────────────────────

interface MockTaskOptions {
	/** Paths named verbatim in the worker task text (Known_Target override). */
	knownTargetPaths?: string[]
	/** Pre-seed the cumulative read-input byte counter. */
	readInputBytesConsumed?: number
}

function createMockTask(options: MockTaskOptions = {}) {
	const { knownTargetPaths = [], readInputBytesConsumed = 0 } = options
	const known = new Set(knownTargetPaths)

	return {
		cwd: "/test/workspace",
		parallelWorker: true,
		knownTargetPaths: known,
		readInputBytesConsumed,
		isKnownTargetPath(relPath: string) {
			const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
			return known.has(normalized)
		},
		api: {
			getModel: vi.fn().mockReturnValue({ info: { supportsImages: false } }),
		},
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didRejectTool: false,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
		say: vi.fn().mockResolvedValue(undefined),
		recordToolError: vi.fn(),
		rooIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(true),
		},
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		},
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({}),
			}),
		},
	}
}

type MockTask = ReturnType<typeof createMockTask>

// The mock task implements only the surface ReadFileTool touches; the real Task
// has ~100 members we deliberately do not mock, so a double assertion is the
// only way to pass it as a Task (there is no structural subtype).
const asTask = (mockTask: MockTask): Task => mockTask as unknown as Task

function createMockCallbacks() {
	return {
		pushToolResult: vi.fn(),
		askApproval: vi.fn(),
		handleError: vi.fn(),
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReadFileTool parallel-worker read controls", () => {
	let infoSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		mockedFsStat.mockResolvedValue({ isDirectory: () => false } as Stats)
		mockedIsBinaryFile.mockResolvedValue(false)
		mockedFsReadFile.mockResolvedValue(Buffer.from("line one\nline two\nline three"))
		mockedReadWithSlice.mockReturnValue({
			content: "1 | line one",
			returnedLines: 1,
			totalLines: 1,
			wasTruncated: false,
			includedRanges: [[1, 1]],
		})
		mockedReadWithIndentation.mockReturnValue({
			content: "1 | line one",
			totalLines: 1,
			wasTruncated: false,
			includedRanges: [[1, 1]],
		})
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
	})

	afterEach(() => {
		infoSpy.mockRestore()
	})

	describe("Lever 1 — read-scope junk exclusion", () => {
		it("denies a vendored path with a one-line category notice and no content (AC-1)", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "node_modules/@types/react/index.d.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Skipped vendored/generated path")
			expect(output).toContain("To read it anyway")
			// No file body was read for the denied path.
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it.each([
			["typescript/lib/lib.dom.d.ts"],
			["package-lock.json"],
			["pnpm-lock.yaml"],
			["app.min.js"],
		])("denies the vendored/generated path %s (AC-2, AC-3)", async (deniedPath) => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: deniedPath } as ReadFileToolParams, asTask(mockTask), callbacks)

			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Skipped vendored/generated path")
			expect(mockedFsReadFile).not.toHaveBeenCalled()
		})

		it("allows a first-party source read and returns content (AC-4)", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "src/core/task/Task.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).toContain("File: src/core/task/Task.ts")
			expect(output).not.toContain("Skipped vendored/generated path")
			expect(mockedFsReadFile).toHaveBeenCalled()
		})

		it("allows a vendored path named verbatim in the task text (Known_Target override, AC-5)", async () => {
			const mockTask = createMockTask({ knownTargetPaths: ["node_modules/@types/react/index.d.ts"] })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "node_modules/@types/react/index.d.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).not.toContain("Skipped vendored/generated path")
			expect(mockedFsReadFile).toHaveBeenCalled()
		})
	})

	describe("Lever 2 — per-worker read-input budget", () => {
		it("tightens a default-limit read to BUDGET_TIGHTENED_LINE_LIMIT after crossing the budget (AC-9)", async () => {
			const mockTask = createMockTask({ readInputBytesConsumed: DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES + 1 })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "src/core/task/Task.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			// Slice mode: readWithSlice is called with the tightened limit.
			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 0, BUDGET_TIGHTENED_LINE_LIMIT)
			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Read-input budget reached")
		})

		it("honors an explicit limit read after crossing the budget (no silent truncation, AC-9)", async () => {
			const mockTask = createMockTask({ readInputBytesConsumed: DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES + 1 })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "src/core/task/Task.ts", limit: 1200 } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 0, 1200)
			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).not.toContain("Read-input budget reached")
		})

		it("tightens a budget-crossed batched read whose defaultBatchLimit would exceed 500 (AC-9a)", async () => {
			// A 2-path batch yields defaultBatchLimit = min(2000, floor(4000/2)) = 2000 > 500.
			const mockTask = createMockTask({ readInputBytesConsumed: DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES + 1 })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: ["src/a.ts", "src/b.ts"] } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			// Every batched read uses the clamped limit, not 2000.
			const sliceLimits = mockedReadWithSlice.mock.calls.map((call) => call[2])
			expect(sliceLimits.length).toBeGreaterThan(0)
			for (const limit of sliceLimits) {
				expect(limit).toBe(BUDGET_TIGHTENED_LINE_LIMIT)
			}
			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Read-input budget reached")
		})

		it("does not tighten a default-limit read below the budget", async () => {
			const mockTask = createMockTask({ readInputBytesConsumed: 0 })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "src/core/task/Task.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 0, 2000)
			const output = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(output).not.toContain("Read-input budget reached")
		})
	})

	describe("FR-6 / AC-10 — measurability log", () => {
		it("emits a per-worker log recording denied bytes and cumulative ingested bytes", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "node_modules/@types/react/index.d.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			const logged = infoSpy.mock.calls.map((call) => String(call[0]))
			const accounting = logged.find((line) => line.includes("read-input accounting"))
			expect(accounting).toBeDefined()
			expect(accounting).toContain("deniedBytes=")
			expect(accounting).toContain("ingestedBytesCumulative=")
		})

		it("accumulates ingested bytes on an allowed read", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{ path: "src/core/task/Task.ts" } as ReadFileToolParams,
				asTask(mockTask),
				callbacks,
			)

			expect(mockTask.readInputBytesConsumed).toBeGreaterThan(0)
		})
	})
})
