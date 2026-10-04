// npx vitest run src/core/tools/__tests__/ToolRepetitionDetector.spec.ts

import type { ToolName } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"

import { ToolRepetitionDetector } from "../ToolRepetitionDetector"

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

/** Calls check() `times` times with the same block and returns the last result. */
function checkRepeatedly(detector: ToolRepetitionDetector, block: ToolUse, times: number) {
	let result = detector.check(block)
	for (let i = 1; i < times; i++) {
		result = detector.check(block)
	}
	return result
}

describe("ToolRepetitionDetector", () => {
	// ===== Initialization tests =====
	describe("initialization", () => {
		it("should default to a limit of 3 if no argument provided", () => {
			const detector = new ToolRepetitionDetector()
			const tool = createToolUse("test", "test-tool")

			// Calls 1-3 (counter 0-2) are allowed
			for (let i = 0; i < 3; i++) {
				expect(detector.check(tool).allowExecution).toBe(true)
			}

			// Fourth identical call (counter = 3) reaches the default limit and is nudged
			const result4 = detector.check(tool)
			expect(result4.allowExecution).toBe(false)
			expect(result4.nudge).toEqual({ toolName: "test-tool", repeatCount: 3 })
			expect(result4.askUser).toBeUndefined()
		})

		it("should use the custom limit when provided", () => {
			const detector = new ToolRepetitionDetector(2)
			const tool = createToolUse("test", "test-tool")

			expect(detector.check(tool).allowExecution).toBe(true)
			expect(detector.check(tool).allowExecution).toBe(true)

			// Third identical call (counter = 2) reaches the custom limit and is nudged
			const result3 = detector.check(tool)
			expect(result3.allowExecution).toBe(false)
			expect(result3.nudge?.repeatCount).toBe(2)
		})
	})

	// ===== No Repetition tests =====
	describe("no repetition", () => {
		it("should allow execution for different tool calls", () => {
			const detector = new ToolRepetitionDetector()

			for (const name of ["first-tool", "second-tool", "third-tool"]) {
				const result = detector.check(createToolUse(name, name))
				expect(result.allowExecution).toBe(true)
				expect(result.nudge).toBeUndefined()
				expect(result.askUser).toBeUndefined()
			}
		})

		it("should reset the counter when different tool calls are made", () => {
			const detector = new ToolRepetitionDetector(2)

			detector.check(createToolUse("same", "same-tool"))
			detector.check(createToolUse("same", "same-tool"))

			// A different call resets the count
			detector.check(createToolUse("different", "different-tool"))

			// Back to the first tool: allowed twice before a nudge
			expect(detector.check(createToolUse("same", "same-tool")).allowExecution).toBe(true)
			expect(detector.check(createToolUse("same", "same-tool")).allowExecution).toBe(true)
			expect(detector.check(createToolUse("same", "same-tool")).nudge).toBeDefined()
		})

		it("should reset the count when a different call interrupts a nudge streak", () => {
			const detector = new ToolRepetitionDetector(1)
			const tool = createToolUse("tool", "tool-name")

			detector.check(tool)
			expect(detector.check(tool).nudge?.repeatCount).toBe(1)

			detector.check(createToolUse("other", "other-tool"))

			// The streak restarts: allowed, then nudged again (not escalated)
			expect(detector.check(tool).allowExecution).toBe(true)
			const result = detector.check(tool)
			expect(result.nudge?.repeatCount).toBe(1)
			expect(result.askUser).toBeUndefined()
		})
	})

	// ===== Nudge then escalate (limit 3) =====
	describe("nudge then escalate with the default limit", () => {
		it("nudges the 4th, 5th and 6th identical calls and escalates on the 7th", () => {
			const detector = new ToolRepetitionDetector(3)
			const tool = createToolUse("repeat", "repeat-tool")

			// Calls 1-3 are allowed
			for (let i = 0; i < 3; i++) {
				expect(detector.check(tool)).toEqual({ allowExecution: true })
			}

			// Calls 4-6 are nudged with the current repeat count
			for (const repeatCount of [3, 4, 5]) {
				const result = detector.check(tool)
				expect(result.allowExecution).toBe(false)
				expect(result.nudge).toEqual({ toolName: "repeat-tool", repeatCount })
				expect(result.askUser).toBeUndefined()
			}

			// Call 7 (counter = 6 = 2 * limit) escalates
			const result7 = detector.check(tool)
			expect(result7.allowExecution).toBe(false)
			expect(result7.nudge).toBeUndefined()
			expect(result7.askUser?.messageKey).toBe("mistake_limit_reached")
			expect(result7.askUser?.messageDetail).toContain("repeat-tool")
		})

		it("resets the counters after escalating, so the 8th call is allowed", () => {
			const detector = new ToolRepetitionDetector(3)
			const tool = createToolUse("repeat", "repeat-tool")

			expect(checkRepeatedly(detector, tool, 7).askUser).toBeDefined()

			// The 8th call starts a fresh streak
			expect(detector.check(tool).allowExecution).toBe(true)
		})

		it("requires a full nudge-then-escalate cycle again after a reset", () => {
			const detector = new ToolRepetitionDetector(3)
			const tool = createToolUse("repeat", "repeat-tool")

			expect(checkRepeatedly(detector, tool, 7).askUser).toBeDefined()

			// Calls 8-10 allowed, 11 nudged, 14 escalated
			expect(checkRepeatedly(detector, tool, 3).allowExecution).toBe(true)
			expect(detector.check(tool).nudge?.repeatCount).toBe(3)
			expect(checkRepeatedly(detector, tool, 3).askUser).toBeDefined()
		})

		it("allows a new tool call after escalation", () => {
			const detector = new ToolRepetitionDetector(3)

			expect(checkRepeatedly(detector, createToolUse("repeat", "repeat-tool"), 7).askUser).toBeDefined()
			expect(detector.check(createToolUse("new", "new-tool")).allowExecution).toBe(true)
		})
	})

	// ===== Tool Name Interpolation tests =====
	describe("tool name interpolation", () => {
		it("should include tool name in the nudge and the escalation message", () => {
			const detector = new ToolRepetitionDetector(2)
			const toolName = "special-tool-name"
			const tool = createToolUse("test", toolName)

			const nudge = checkRepeatedly(detector, tool, 3)
			expect(nudge.nudge?.toolName).toBe(toolName)

			// Calls 4 (nudge) and 5 (escalation)
			const result = checkRepeatedly(detector, tool, 2)
			expect(result.allowExecution).toBe(false)
			expect(result.askUser?.messageDetail).toContain(toolName)
		})
	})

	// ===== Edge Cases =====
	describe("edge cases", () => {
		it("should handle empty tool call", () => {
			const detector = new ToolRepetitionDetector(2)

			const result = checkRepeatedly(detector, createToolUse("empty-tool", "empty-tool"), 3)

			expect(result.allowExecution).toBe(false)
			expect(result.nudge).toBeDefined()
		})

		it("should handle different tool names with identical serialized JSON", () => {
			const detector = new ToolRepetitionDetector(2)

			// First, call with tool-name-1 to set up the counter
			const toolUse1 = createToolUse("tool-name-1", "tool-name-1", { param: "value" })
			detector.check(toolUse1)

			// Create a tool that will serialize to the same JSON as toolUse1
			const toolUse2 = createToolUse("tool-name-2", "tool-name-2", { param: "value" })

			// Override the private method to force identical serialization
			const originalSerialize = detector["serializeToolUse"]
			detector["serializeToolUse"] = (tool: ToolUse) => {
				// Use string comparison for the name since it's technically an enum
				if (String(tool.name) === "tool-name-2") {
					return originalSerialize.call(detector, toolUse1) // Return the same JSON as toolUse1
				}
				return originalSerialize.call(detector, tool)
			}

			// Second call - this should be considered identical due to our mock
			const result2 = detector.check(toolUse2)
			expect(result2.allowExecution).toBe(true) // Still allowed (counter = 1)

			// Third call - should be nudged (limit is 2)
			const result3 = detector.check(toolUse2)

			// Restore the original method
			detector["serializeToolUse"] = originalSerialize

			// Since we're directly manipulating the internal state for testing,
			// we expect it to consider this a repetition
			expect(result3.allowExecution).toBe(false)
			expect(result3.nudge).toBeDefined()
		})

		it("should treat tools with same parameters in different order as identical", () => {
			const detector = new ToolRepetitionDetector(2)

			detector.check(createToolUse("same-tool", "same-tool", { a: "1", b: "2", c: "3" }))
			detector.check(createToolUse("same-tool", "same-tool", { c: "3", a: "1", b: "2" }))
			const result = detector.check(createToolUse("same-tool", "same-tool", { b: "2", c: "3", a: "1" }))

			// Since parameters are sorted alphabetically in the serialized JSON,
			// these should be considered identical
			expect(result.allowExecution).toBe(false)
			expect(result.nudge).toBeDefined()
		})
	})

	// ===== Explicit Nth Call tests =====
	describe("explicit Nth call behavior", () => {
		it("limit 1: allows the 1st call, nudges the 2nd and escalates on the 3rd", () => {
			const detector = new ToolRepetitionDetector(1)
			const tool = createToolUse("tool", "tool-name")

			const result1 = detector.check(tool)
			expect(result1.allowExecution).toBe(true)
			expect(result1.askUser).toBeUndefined()

			const result2 = detector.check(tool)
			expect(result2.allowExecution).toBe(false)
			expect(result2.nudge).toEqual({ toolName: "tool-name", repeatCount: 1 })
			expect(result2.askUser).toBeUndefined()

			const result3 = detector.check(tool)
			expect(result3.allowExecution).toBe(false)
			expect(result3.nudge).toBeUndefined()
			expect(result3.askUser?.messageKey).toBe("mistake_limit_reached")
		})

		it("limit 2: allows 2 calls, nudges the 3rd and 4th and escalates on the 5th", () => {
			const detector = new ToolRepetitionDetector(2)
			const tool = createToolUse("tool", "tool-name")

			expect(detector.check(tool).allowExecution).toBe(true)
			expect(detector.check(tool).allowExecution).toBe(true)

			expect(detector.check(tool).nudge?.repeatCount).toBe(2)
			expect(detector.check(tool).nudge?.repeatCount).toBe(3)

			const result5 = detector.check(tool)
			expect(result5.allowExecution).toBe(false)
			expect(result5.askUser?.messageKey).toBe("mistake_limit_reached")

			// After escalating, the counter resets and allows new attempts
			expect(detector.check(tool).allowExecution).toBe(true)
		})

		it("limit 5: allows 5 calls, nudges calls 6-10 and escalates on the 11th", () => {
			const detector = new ToolRepetitionDetector(5)
			const tool = createToolUse("tool", "tool-name")

			for (let i = 0; i < 5; i++) {
				const result = detector.check(tool)
				expect(result.allowExecution).toBe(true)
				expect(result.askUser).toBeUndefined()
			}

			for (let i = 0; i < 5; i++) {
				const result = detector.check(tool)
				expect(result.allowExecution).toBe(false)
				expect(result.nudge?.repeatCount).toBe(5 + i)
			}

			const result11 = detector.check(tool)
			expect(result11.allowExecution).toBe(false)
			expect(result11.askUser?.messageKey).toBe("mistake_limit_reached")
		})

		it("should never block when limit is 0 (unlimited)", () => {
			const detector = new ToolRepetitionDetector(0)

			for (let i = 0; i < 10; i++) {
				const result = detector.check(createToolUse("tool", "tool-name"))
				expect(result.allowExecution).toBe(true)
				expect(result.nudge).toBeUndefined()
				expect(result.askUser).toBeUndefined()
			}
		})

		it("should handle negative limits as 0 (unlimited)", () => {
			const detector = new ToolRepetitionDetector(-1)

			for (let i = 0; i < 10; i++) {
				const result = detector.check(createToolUse("tool", "tool-name"))
				expect(result.allowExecution).toBe(true)
				expect(result.nudge).toBeUndefined()
				expect(result.askUser).toBeUndefined()
			}
		})
	})

	// ===== Native Protocol (nativeArgs) tests =====
	describe("native protocol with nativeArgs", () => {
		it("should differentiate read_file calls with different files in nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2)

			// Create read_file tool use with nativeArgs (like native protocol does)
			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "file1.ts",
				},
			}

			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "file2.ts",
				},
			}

			// First call with file1
			expect(detector.check(readFile1).allowExecution).toBe(true)

			// Second call with file2 - should be treated as different
			expect(detector.check(readFile2).allowExecution).toBe(true)

			// Third call with file1 again - should reset counter
			expect(detector.check(readFile1).allowExecution).toBe(true)
		})

		it("should detect repetition when same files are read multiple times with nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2)

			// Create identical read_file tool uses
			const readFile: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "same-file.ts",
				},
			}

			// First call allowed
			expect(detector.check(readFile).allowExecution).toBe(true)

			// Second call allowed
			expect(detector.check(readFile).allowExecution).toBe(true)

			// Third identical call should be nudged (limit is 2)
			const result = detector.check(readFile)
			expect(result.allowExecution).toBe(false)
			expect(result.nudge).toEqual({ toolName: "read_file", repeatCount: 2 })
		})

		it("should treat different slice offsets as distinct read_file calls", () => {
			const detector = new ToolRepetitionDetector(2)

			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: {
					path: "a.ts",
					offset: 1,
					limit: 2000,
				},
			}

			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: {
					path: "a.ts",
					offset: 2001,
					limit: 2000,
				},
			}

			// Different offsets should be treated as different calls
			expect(detector.check(readFile1).allowExecution).toBe(true)
			expect(detector.check(readFile2).allowExecution).toBe(true)
		})

		it("should handle tools with both params and nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2)

			const tool1: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: {
					command: "ls",
					cwd: "/home/user",
				},
			}

			const tool2: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: {
					command: "ls",
					cwd: "/home/admin",
				},
			}

			// Different cwd in nativeArgs should make these different
			expect(detector.check(tool1).allowExecution).toBe(true)
			expect(detector.check(tool2).allowExecution).toBe(true)
		})

		it("should handle tools with only params (no nativeArgs)", () => {
			const detector = new ToolRepetitionDetector(2)

			const legacyTool = createToolUse("read_file", "read_file", { path: "test.txt" })

			// Should work the same as before
			expect(detector.check(legacyTool).allowExecution).toBe(true)
			expect(detector.check(legacyTool).allowExecution).toBe(true)

			const result = detector.check(legacyTool)
			expect(result.allowExecution).toBe(false)
			expect(result.nudge).toBeDefined()
		})
	})
})
