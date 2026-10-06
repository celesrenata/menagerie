// npx vitest run core/tools/__tests__/ProgressAwareLoopDetector.spec.ts

import type { ToolName } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"

import { ProgressAwareLoopDetector, hashArgs } from "../ProgressAwareLoopDetector"
import type { ToolResultContext, ToolRepetitionCheckResult } from "../ProgressAwareLoopDetector"

vitest.mock("../../../i18n", () => ({
	t: vitest.fn(function (key, options) {
		// For toolRepetitionLimitReached key, return a message with the tool name.
		if (key === "tools:toolRepetitionLimitReached" && options?.toolName) {
			return `Roo appears to be stuck in a loop, attempting the same action (${options.toolName}) repeatedly. This might indicate a problem with its current strategy.`
		}
		return key
	}),
}))

function createToolUse(name: string, displayName?: string, params: Record<string, string> = {}): ToolUse {
	return {
		type: "tool_use",
		name: (displayName || name) as ToolName,
		params,
		partial: false,
	}
}

/**
 * Drives a genuine infinite loop: identical args, identical result, no workspace
 * change. Each completed execution adds the `identical_args_and_result` stagnation
 * signal (+4), so the score climbs through nudge → replanning → hard stop. Collects
 * the sequence of pre-execution gate results so tests can assert on the escalation path.
 */
function driveGenuineLoop(detector: ProgressAwareLoopDetector, block: ToolUse, maxIterations = 12) {
	const results: ToolRepetitionCheckResult[] = []
	const context: ToolResultContext = { resultText: "same result" }
	for (let i = 0; i < maxIterations; i++) {
		const result = detector.check(block)
		results.push(result)
		if (result.askUser) break
		detector.recordResult(block, { ok: true, body: "same result" }, context)
	}
	return results
}

describe("ProgressAwareLoopDetector", () => {
	// ===== Order-insensitive argument comparison =====
	describe("order-insensitive argument comparison", () => {
		it("produces the same hash for params in different key orders", () => {
			const a = createToolUse("same-tool", "same-tool", { a: "1", b: "2", c: "3" })
			const b = createToolUse("same-tool", "same-tool", { c: "3", a: "1", b: "2" })
			const c = createToolUse("same-tool", "same-tool", { b: "2", c: "3", a: "1" })

			expect(hashArgs(a)).toBe(hashArgs(b))
			expect(hashArgs(b)).toBe(hashArgs(c))
		})

		it("produces the same hash regardless of whether args arrive via params or nativeArgs", () => {
			const viaParams = createToolUse("read_file", "read_file", { path: "x.ts" })
			const viaNative: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "x.ts" },
			}

			expect(hashArgs(viaParams)).toBe(hashArgs(viaNative))
		})
	})

	// ===== Differentiation by nativeArgs =====
	describe("differentiation by nativeArgs", () => {
		it("differs for different file paths", () => {
			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "file1.ts" },
			}
			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "file2.ts" },
			}

			expect(hashArgs(readFile1)).not.toBe(hashArgs(readFile2))
		})

		it("differs for different offsets on the same file", () => {
			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "a.ts", offset: 1, limit: 2000 },
			}
			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "a.ts", offset: 2001, limit: 2000 },
			}

			expect(hashArgs(readFile1)).not.toBe(hashArgs(readFile2))
		})

		it("differs for different cwd on an otherwise identical command", () => {
			const tool1: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: { command: "ls", cwd: "/home/user" },
			}
			const tool2: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: { command: "ls", cwd: "/home/admin" },
			}

			expect(hashArgs(tool1)).not.toBe(hashArgs(tool2))
		})

		it("is identical for the same nativeArgs", () => {
			const readFileA: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "same-file.ts" },
			}
			const readFileB: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "same-file.ts" },
			}

			expect(hashArgs(readFileA)).toBe(hashArgs(readFileB))
		})
	})

	// ===== Empty tool call =====
	describe("edge cases", () => {
		it("handles an empty tool call without throwing", () => {
			const detector = new ProgressAwareLoopDetector()
			const emptyTool = createToolUse("empty-tool", "empty-tool")

			expect(hashArgs(emptyTool)).toEqual(expect.any(String))
			expect(() => {
				for (let i = 0; i < 4; i++) {
					const result = detector.check(emptyTool)
					detector.recordResult(emptyTool, { ok: true, body: "" }, { resultText: "" })
					void result
				}
			}).not.toThrow()
		})
	})

	// ===== Hard-stop messageKey and tool-name interpolation =====
	describe("hard stop", () => {
		it("surfaces a mistake_limit_reached ask that names the repeated tool", () => {
			const detector = new ProgressAwareLoopDetector()
			const tool = createToolUse("repeat", "repeat-tool", { x: "1" })

			const results = driveGenuineLoop(detector, tool)
			const stop = results.find((r) => r.askUser)

			expect(stop).toBeDefined()
			expect(stop?.askUser?.messageKey).toBe("mistake_limit_reached")
			expect(stop?.askUser?.messageDetail).toContain("repeat-tool")
		})
	})

	// ===== Genuine loop reaches a nudge before a hard stop =====
	describe("genuine loop escalation path", () => {
		it("nudges before it hard stops", () => {
			const detector = new ProgressAwareLoopDetector()
			const tool = createToolUse("repeat", "repeat-tool", { x: "1" })

			const results = driveGenuineLoop(detector, tool)

			const firstNudgeIndex = results.findIndex((r) => r.allowExecution === false && r.nudge)
			const firstStopIndex = results.findIndex((r) => r.askUser)

			expect(firstNudgeIndex).toBeGreaterThanOrEqual(0)
			expect(firstStopIndex).toBeGreaterThanOrEqual(0)
			expect(firstNudgeIndex).toBeLessThan(firstStopIndex)
		})
	})

	// ===== Progress prevents escalation (core feature) =====
	describe("progress prevents escalation", () => {
		it("never nudges or stops an iterative-capable tool that keeps advancing", () => {
			const detector = new ProgressAwareLoopDetector()

			for (let i = 0; i < 10; i++) {
				const offset = i * 2000
				const readFile: ToolUse = {
					type: "tool_use",
					name: "read_file" as ToolName,
					params: {},
					partial: false,
					nativeArgs: { path: "big.ts", offset, limit: 2000 },
				}

				const result = detector.check(readFile)
				expect(result.allowExecution).toBe(true)
				expect(result.nudge).toBeUndefined()
				expect(result.askUser).toBeUndefined()

				// Each execution reads a fresh slice: advancing cursor + workspace unchanged
				// but a changing result body — observable forward progress.
				detector.recordResult(
					readFile,
					{ ok: true, body: `chunk ${i}` },
					{ resultText: `chunk ${i}`, workspaceChanged: false },
				)
			}
		})
	})
})
