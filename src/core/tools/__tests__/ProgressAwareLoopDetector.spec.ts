// npx vitest run core/tools/__tests__/ProgressAwareLoopDetector.spec.ts

import fc from "fast-check"

import type { ToolName } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"

import {
	ProgressAwareLoopDetector,
	hashArgs,
	deriveBand,
	bandToResult,
	DEFAULT_ABSOLUTE_BOUND,
} from "../ProgressAwareLoopDetector"
import type {
	ToolResultContext,
	ToolRepetitionCheckResult,
	CapturedSignals,
	BandDecision,
	MetricsSink,
} from "../ProgressAwareLoopDetector"

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

	// ===== update_todo_list no-op does not earn progress credit =====
	describe("update_todo_list no-op escalation", () => {
		function todoCall(todos: string): ToolUse {
			return createToolUse("update_todo_list", "update_todo_list", { todos })
		}

		it("escalates when update_todo_list is called repeatedly without a status change", () => {
			const detector = new ProgressAwareLoopDetector()
			const results: ToolRepetitionCheckResult[] = []

			// Each call sends slightly different todo text (reordered / rephrased) so the args
			// and result hashes differ — the pre-fix behavior that was miscredited as
			// query_changed/result_changed progress. With todoChanged omitted (no-op), those
			// signals are suppressed and stagnation accumulates toward a hard stop.
			for (let i = 0; i < 12; i++) {
				const block = todoCall(`[ ] item ${i % 2}\n[ ] another ${i % 3}`)
				const result = detector.check(block)
				results.push(result)
				if (result.askUser) break
				detector.recordResult(
					block,
					{ ok: true, body: `Todo list unchanged (2 items, 0 completed). call ${i}` },
					{ resultText: `Todo list unchanged (2 items, 0 completed). call ${i}` },
				)
			}

			const nudged = results.some((r) => r.allowExecution === false && r.nudge)
			const stopped = results.some((r) => r.askUser)
			expect(nudged).toBe(true)
			expect(stopped).toBe(true)
		})

		it("does NOT escalate when each update_todo_list call reports a real status change", () => {
			const detector = new ProgressAwareLoopDetector()

			for (let i = 0; i < 12; i++) {
				const block = todoCall(`[x] item ${i}\n[ ] next ${i}`)
				const result = detector.check(block)
				expect(result.askUser).toBeUndefined()
				// todoChanged: true credits a todo_changed progress signal that keeps the score low.
				detector.recordResult(
					block,
					{ ok: true, body: `Todo list updated successfully (${i})` },
					{ resultText: `Todo list updated successfully (${i})`, todoChanged: true },
				)
			}
		})
	})

	// ===== Tool-less turns escalate via recordNoToolTurn =====
	describe("empty-response (no tool use) escalation", () => {
		it("escalates repeated tool-less turns through nudge to a hard stop", () => {
			const detector = new ProgressAwareLoopDetector()
			const results: ToolRepetitionCheckResult[] = []

			for (let i = 0; i < 12; i++) {
				const result = detector.recordNoToolTurn()
				results.push(result)
				if (result.askUser) break
			}

			const firstNudge = results.findIndex((r) => r.allowExecution === false && r.nudge)
			const firstStop = results.findIndex((r) => r.askUser)
			expect(firstNudge).toBeGreaterThanOrEqual(0)
			expect(firstStop).toBeGreaterThanOrEqual(0)
			expect(firstNudge).toBeLessThan(firstStop)
		})

		it("does not corrupt the args/result identity used by a following real tool call", () => {
			const detector = new ProgressAwareLoopDetector()
			const readFile: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "a.ts", offset: 0, limit: 2000 },
			}

			// A real tool, then a tool-less turn, then the same real tool advancing: the
			// synthetic no-tool turn must preserve the prior tool's hash bookkeeping so the
			// detector still scores the real tool's progress correctly (no throw, no stop).
			detector.check(readFile)
			detector.recordResult(readFile, { ok: true, body: "chunk 0" }, { resultText: "chunk 0" })
			detector.recordNoToolTurn()
			const next: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: { path: "a.ts", offset: 2000, limit: 2000 },
			}
			const result = detector.check(next)
			expect(result.askUser).toBeUndefined()
			expect(() =>
				detector.recordResult(next, { ok: true, body: "chunk 1" }, { resultText: "chunk 1" }),
			).not.toThrow()
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

// =============================================================================
// Absolute_Backstop property tests (design Correctness Properties 11, 12, 13)
// =============================================================================

/**
 * Builds a `CapturedSignals` for a single completed execution. By default it carries
 * one progress signal (`workspace_changed`) and no stagnation, so the normal scoring
 * path keeps the score in the continue band — isolating the backstop as the only
 * thing that can force a hard stop.
 */
function capturedWithProgress(
	tool: string,
	overrides: Partial<CapturedSignals> = {},
): CapturedSignals {
	return {
		tool,
		normalizedArgsHash: "hash",
		resultHash: "result",
		progress: ["workspace_changed"],
		stagnation: [],
		workspaceChanged: true,
		todoChanged: false,
		resultChanged: false,
		cursorAdvanced: false,
		...overrides,
	}
}

function isHardStopResult(result: ToolRepetitionCheckResult): boolean {
	return (
		result.allowExecution === false &&
		result.askUser?.messageKey === "mistake_limit_reached" &&
		typeof result.askUser?.messageDetail === "string" &&
		result.askUser.messageDetail.length > 0
	)
}

describe("ProgressAwareLoopDetector — Absolute_Backstop", () => {
	// Feature: progress-aware-loop-detection, Property 11: The absolute backstop fires
	// regardless of progress — once a ceiling is reached the decision is a hard stop even
	// when every execution recorded a Progress_Signal and the score never left the continue band.
	// Validates: Requirements 10.1, 10.4, 10.5, 10.6
	describe("Property 11: fires regardless of progress", () => {
		it("turn limb: reaching the Turn_Ceiling forces a hard stop while the score stays in continue", () => {
			fc.assert(
				fc.property(fc.integer({ min: 2, max: 40 }), (turnCeiling) => {
					const detector = new ProgressAwareLoopDetector(3, {
						absoluteBound: { turnCeiling, transcriptWindowFraction: 0.9 },
					})
					const captured = capturedWithProgress("read_file")

					for (let turn = 1; turn <= turnCeiling; turn++) {
						const decision = detector.evaluateProgress("task-A", captured)
						if (turn < turnCeiling) {
							// Below the ceiling: every turn carried a progress signal, so the score
							// never climbs out of the continue band and the backstop does not fire.
							expect(decision.band).toBe("continue")
							expect(decision.noProgressScore).toBeLessThanOrEqual(5)
							expect(decision.result.allowExecution).toBe(true)
						} else {
							// At the ceiling: hard stop, independent of the (still-continue) score.
							expect(decision.band).toBe("hard_stop")
							expect(decision.noProgressScore).toBeLessThanOrEqual(5)
							expect(isHardStopResult(decision.result)).toBe(true)
						}
					}
				}),
				{ numRuns: 200 },
			)
		})

		it("transcript limb: reaching the transcript ceiling forces a hard stop while the score stays in continue", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1000, max: 1_000_000 }),
					fc.integer({ min: 1, max: 100 }),
					(window, fractionPct) => {
						const fraction = fractionPct / 100 // (0, 1]
						// A large turn ceiling so only the transcript limb can fire here.
						const detector = new ProgressAwareLoopDetector(3, {
							absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: fraction },
							servingContextWindow: window,
						})
						const ceiling = Math.floor(window * fraction)

						// One execution comfortably below the transcript ceiling: no backstop.
						const below = detector.evaluateProgress(
							"task-B",
							capturedWithProgress("read_file", { transcriptTokens: Math.max(0, ceiling - 1) }),
						)
						expect(below.noProgressScore).toBeLessThanOrEqual(5)
						// ceiling - 1 is strictly below, so the transcript limb must not fire.
						if (ceiling - 1 < ceiling) {
							expect(below.band).toBe("continue")
						}

						// One execution at the transcript ceiling: hard stop regardless of progress.
						const at = detector.evaluateProgress(
							"task-B",
							capturedWithProgress("read_file", { transcriptTokens: ceiling }),
						)
						expect(at.band).toBe("hard_stop")
						expect(at.noProgressScore).toBeLessThanOrEqual(5)
						expect(isHardStopResult(at.result)).toBe(true)
					},
				),
				{ numRuns: 200 },
			)
		})
	})

	// Feature: progress-aware-loop-detection, Property 12: The transcript ceiling is relative
	// to the serving context window — the firing threshold equals floor(window × fraction),
	// never a fixed literal, and scales with the window.
	// Validates: Requirements 10.3, 10.5
	describe("Property 12: transcript ceiling is relative to the serving window", () => {
		it("fires exactly at floor(window × fraction) and not one token below", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1000, max: 1_000_000 }),
					fc.integer({ min: 1, max: 100 }),
					(window, fractionPct) => {
						const fraction = fractionPct / 100
						const ceiling = Math.floor(window * fraction)
						// turnCeiling large so the turn limb is irrelevant; one execution per detector.
						const makeDetector = () =>
							new ProgressAwareLoopDetector(3, {
								absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: fraction },
								servingContextWindow: window,
							})

						// At the ceiling: fires.
						const atCeiling = makeDetector().evaluateProgress(
							"t",
							capturedWithProgress("read_file", { transcriptTokens: ceiling }),
						)
						expect(atCeiling.band).toBe("hard_stop")

						// One token below the ceiling: does not fire via the transcript limb.
						if (ceiling >= 1) {
							const belowCeiling = makeDetector().evaluateProgress(
								"t",
								capturedWithProgress("read_file", { transcriptTokens: ceiling - 1 }),
							)
							expect(belowCeiling.band).not.toBe("hard_stop")
						}
					},
				),
				{ numRuns: 200 },
			)
		})

		it("scales with the window: doubling the window doubles the firing threshold (no fixed literal)", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1000, max: 500_000 }),
					fc.integer({ min: 1, max: 100 }),
					(window, fractionPct) => {
						const fraction = fractionPct / 100
						const ceiling1 = Math.floor(window * fraction)
						const ceiling2 = Math.floor(2 * window * fraction)

						// The threshold is derived from the window, so a doubled window yields a
						// strictly-larger-or-equal ceiling (and strictly larger whenever the fraction
						// produces a non-degenerate floor). A fixed literal could not scale this way.
						expect(ceiling2).toBeGreaterThanOrEqual(ceiling1)

						// Transcript size at ceiling1 fires on the small window but NOT on the doubled
						// window (whenever the doubled ceiling is strictly larger), proving the threshold
						// tracks the window rather than a constant.
						const small = new ProgressAwareLoopDetector(3, {
							absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: fraction },
							servingContextWindow: window,
						}).evaluateProgress("t", capturedWithProgress("read_file", { transcriptTokens: ceiling1 }))
						expect(small.band).toBe("hard_stop")

						if (ceiling2 > ceiling1) {
							const large = new ProgressAwareLoopDetector(3, {
								absoluteBound: {
									turnCeiling: 1_000_000,
									transcriptWindowFraction: fraction,
								},
								servingContextWindow: 2 * window,
							}).evaluateProgress(
								"t",
								capturedWithProgress("read_file", { transcriptTokens: ceiling1 }),
							)
							expect(large.band).not.toBe("hard_stop")
						}
					},
				),
				{ numRuns: 200 },
			)
		})
	})

	// Feature: progress-aware-loop-detection, Property 13: Below both ceilings the backstop
	// does not alter band evaluation — evaluateProgress returns the same BandDecision as the
	// unmodified score-based scoring path for the same captured signals.
	// Validates: Requirements 10.9
	describe("Property 13: below both ceilings the backstop is inert", () => {
		it("returns the same band/score/result as the pure scoring path for identical signals", () => {
			const progressArb = fc.subarray(
				[
					"cursor_advanced",
					"target_changed",
					"query_changed",
					"result_changed",
					"workspace_changed",
					"todo_changed",
				] as const,
			)
			const stagnationArb = fc.subarray(
				[
					"identical_args_and_result",
					"repeated_error_class",
					"empty_mutation_diff",
					"unverified_success",
				] as const,
			)

			fc.assert(
				fc.property(
					progressArb,
					stagnationArb,
					fc.integer({ min: 1, max: 20 }),
					fc.constantFrom("read_file", "execute_command", "write_to_file", "apply_diff"),
					(progress, stagnation, runs, tool) => {
						// A reference detector whose ceilings can never be reached: effectively-infinite
						// turn ceiling and no serving window (transcript limb disabled). It always takes
						// the pure scoring path.
						const reference = new ProgressAwareLoopDetector(3, {
							absoluteBound: { turnCeiling: Number.MAX_SAFE_INTEGER, transcriptWindowFraction: 0.9 },
						})
						// The detector under test: real small ceilings, but we stay strictly below both.
						const underTest = new ProgressAwareLoopDetector(3, {
							absoluteBound: { turnCeiling: runs + 1, transcriptWindowFraction: 0.9 },
							servingContextWindow: 100_000,
						})

						// Keep transcriptTokens well below floor(100000 × 0.9) = 90000, so the transcript
						// limb never fires, and run strictly fewer executions than turnCeiling so the
						// turn limb never fires either.
						const makeCaptured = (): CapturedSignals => ({
							tool,
							normalizedArgsHash: "h",
							resultHash: "r",
							progress: [...progress],
							stagnation: [...stagnation],
							workspaceChanged: progress.includes("workspace_changed"),
							todoChanged: progress.includes("todo_changed"),
							resultChanged: progress.includes("result_changed"),
							cursorAdvanced: progress.includes("cursor_advanced"),
							transcriptTokens: 10,
						})

						let last: BandDecision | undefined
						for (let i = 0; i < runs; i++) {
							const refDecision = reference.evaluateProgress("ref", makeCaptured())
							const utDecision = underTest.evaluateProgress("ut", makeCaptured())

							// Below both ceilings, the backstop must be completely inert: identical
							// band, score, and surfaced result.
							expect(utDecision.band).toBe(refDecision.band)
							expect(utDecision.noProgressScore).toBe(refDecision.noProgressScore)
							expect(utDecision.result).toStrictEqual(refDecision.result)

							// And both equal the pure deriveBand/bandToResult of the resulting score.
							const expectedResult = bandToResult(
								deriveBand(utDecision.noProgressScore),
								tool,
								i + 1,
							)
							expect(utDecision.band).toBe(deriveBand(utDecision.noProgressScore))
							expect(utDecision.result).toStrictEqual(expectedResult)
							last = utDecision
						}
						expect(last).toBeDefined()
					},
				),
				{ numRuns: 200 },
			)
		})
	})
})

// =============================================================================
// Absolute_Backstop deterministic unit/edge tests (task 12.6)
// Boundary conditions and metric/result-contract parity for the Requirement 10
// backstop. These complement the fast-check properties above with exact,
// non-random boundary and parity assertions. Reuses `capturedWithProgress` and
// `isHardStopResult` from the property-test section.
// =============================================================================

describe("ProgressAwareLoopDetector — Absolute_Backstop unit/edge", () => {
	// --- Turn-ceiling boundary (Req 10.4): off-by-one guard ---
	describe("turn-ceiling boundary (Req 10.4)", () => {
		it("fires at exactly completedExecutions === turnCeiling, not at turnCeiling - 1", () => {
			const turnCeiling = 5
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling, transcriptWindowFraction: 0.9 },
			})
			const captured = capturedWithProgress("read_file")

			// Executions 1..turnCeiling-1 stay in the continue band (progress every turn),
			// and the backstop must not fire a token early.
			for (let turn = 1; turn < turnCeiling; turn++) {
				const decision = detector.evaluateProgress("task", captured)
				expect(decision.band).toBe("continue")
				expect(decision.result.allowExecution).toBe(true)
			}

			// Exactly at the ceiling: the turn limb fires.
			const atCeiling = detector.evaluateProgress("task", captured)
			expect(atCeiling.band).toBe("hard_stop")
			expect(isHardStopResult(atCeiling.result)).toBe(true)
		})
	})

	// --- Transcript-ceiling boundary (Req 10.5) ---
	describe("transcript-ceiling boundary (Req 10.5)", () => {
		it("fires at exactly floor(window × fraction), not one token below", () => {
			const window = 10_000
			const fraction = 0.9
			const ceiling = Math.floor(window * fraction) // 9000

			// Large turn ceiling so only the transcript limb can fire.
			const makeDetector = () =>
				new ProgressAwareLoopDetector(3, {
					absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: fraction },
					servingContextWindow: window,
				})

			const below = makeDetector().evaluateProgress(
				"task",
				capturedWithProgress("read_file", { transcriptTokens: ceiling - 1 }),
			)
			expect(below.band).toBe("continue")
			expect(below.result.allowExecution).toBe(true)

			const at = makeDetector().evaluateProgress(
				"task",
				capturedWithProgress("read_file", { transcriptTokens: ceiling }),
			)
			expect(at.band).toBe("hard_stop")
			expect(isHardStopResult(at.result)).toBe(true)
		})

		it("still hard stops when BOTH limbs could fire on the same execution", () => {
			// turnCeiling === 1 so the turn limb is already satisfied on the first
			// execution, and transcriptTokens is at the transcript ceiling too — the
			// combined case must still resolve to a single hard stop.
			const window = 10_000
			const fraction = 0.9
			const ceiling = Math.floor(window * fraction)
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1, transcriptWindowFraction: fraction },
				servingContextWindow: window,
			})

			const decision = detector.evaluateProgress(
				"task",
				capturedWithProgress("read_file", { transcriptTokens: ceiling }),
			)
			expect(decision.band).toBe("hard_stop")
			expect(isHardStopResult(decision.result)).toBe(true)
		})
	})

	// --- Unresolved serving window: transcript limb disabled, turn limb still applies ---
	// (design Error Handling: an unresolvable serving window disables the transcript limb;
	// the turn limb continues to apply.)
	describe("unresolved serving window (Req 10.5 Error Handling)", () => {
		it("does not fire or throw on a huge transcript when no serving window is supplied", () => {
			// No servingContextWindow and no resolveContextWindow ⇒ transcript limb disabled.
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: 0.9 },
			})

			let decision: BandDecision | undefined
			expect(() => {
				decision = detector.evaluateProgress(
					"task",
					// A transcript far larger than any plausible ceiling: must NOT fire,
					// because the window is unresolvable.
					capturedWithProgress("read_file", { transcriptTokens: 100_000_000 }),
				)
			}).not.toThrow()
			expect(decision?.band).toBe("continue")
			expect(decision?.result.allowExecution).toBe(true)
		})

		it("does not fire the transcript limb when transcriptTokens is undefined, even with a window", () => {
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: 0.9 },
				servingContextWindow: 10_000,
			})

			let decision: BandDecision | undefined
			expect(() => {
				// transcriptTokens omitted ⇒ transcript limb disabled.
				decision = detector.evaluateProgress("task", capturedWithProgress("read_file"))
			}).not.toThrow()
			expect(decision?.band).toBe("continue")
			expect(decision?.result.allowExecution).toBe(true)
		})

		it("the turn limb STILL fires at the turn ceiling when the serving window is unresolvable", () => {
			const turnCeiling = 4
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling, transcriptWindowFraction: 0.9 },
				// no servingContextWindow / resolveContextWindow
			})
			// transcriptTokens undefined throughout: only the turn limb can act.
			const captured = capturedWithProgress("read_file")

			for (let turn = 1; turn < turnCeiling; turn++) {
				expect(detector.evaluateProgress("task", captured).band).toBe("continue")
			}
			const atCeiling = detector.evaluateProgress("task", captured)
			expect(atCeiling.band).toBe("hard_stop")
			expect(isHardStopResult(atCeiling.result)).toBe(true)
		})
	})

	// --- DEFAULT_ABSOLUTE_BOUND wiring (Req 10.2, 10.3) ---
	describe("DEFAULT_ABSOLUTE_BOUND is used when no absoluteBound dep is supplied", () => {
		it("exposes the documented default ceilings for direct assertion", () => {
			expect(DEFAULT_ABSOLUTE_BOUND).toStrictEqual({ turnCeiling: 400, transcriptWindowFraction: 0.9 })
		})

		it("applies the default turn ceiling of 400 when constructed with no deps (fires at exactly 400)", () => {
			// Construct with no deps at all — the detector must fall back to
			// DEFAULT_ABSOLUTE_BOUND. Drive 400 cheap evaluateProgress calls; each is a
			// pure in-memory score update, so this stays fast.
			const detector = new ProgressAwareLoopDetector()
			const captured = capturedWithProgress("read_file")

			// Executions 1..399 stay in the continue band (one progress signal each turn).
			for (let turn = 1; turn < DEFAULT_ABSOLUTE_BOUND.turnCeiling; turn++) {
				const decision = detector.evaluateProgress("task", captured)
				expect(decision.band).toBe("continue")
			}
			// Execution 400 (=== default turnCeiling) fires the turn limb.
			const atCeiling = detector.evaluateProgress("task", captured)
			expect(atCeiling.band).toBe("hard_stop")
			expect(isHardStopResult(atCeiling.result)).toBe(true)
		})

		it("also applies the default when constructed with deps that omit absoluteBound (small injected bound fires)", () => {
			// Deps supplied but without absoluteBound: still defaults. We assert the fire
			// case cheaply via a separately-constructed small-bound detector, and assert
			// the default value is wired via the direct DEFAULT_ABSOLUTE_BOUND assertion above.
			const defaulted = new ProgressAwareLoopDetector(3, { servingContextWindow: 10_000 })
			const captured = capturedWithProgress("read_file")
			// A handful of executions well under 400 must not fire the backstop.
			for (let turn = 1; turn <= 10; turn++) {
				expect(defaulted.evaluateProgress("task", captured).band).toBe("continue")
			}
		})
	})

	// --- Metric parity (Req 10.8): emitStop shape identical to a normal hard stop ---
	describe("metric parity (Req 10.8)", () => {
		it("calls emitStop exactly once with { toolName, noProgressScore } matching the fired backstop decision", () => {
			const emitStop = vitest.fn()
			const emitNudge = vitest.fn()
			const metrics: MetricsSink = { emitStop, emitNudge }
			const turnCeiling = 3
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling, transcriptWindowFraction: 0.9 },
				metrics,
			})
			const captured = capturedWithProgress("read_file")

			// Sub-ceiling executions: emitStop must NOT be called.
			detector.evaluateProgress("task", captured)
			detector.evaluateProgress("task", captured)
			expect(emitStop).not.toHaveBeenCalled()

			// At the ceiling: the backstop fires and emits exactly one stop metric whose
			// payload matches the decision's toolName + noProgressScore.
			const decision = detector.evaluateProgress("task", captured)
			expect(decision.band).toBe("hard_stop")
			expect(emitStop).toHaveBeenCalledTimes(1)
			expect(emitStop).toHaveBeenCalledWith({
				toolName: "read_file",
				noProgressScore: decision.noProgressScore,
			})
		})

		it("emits a backstop stop with the identical { toolName, noProgressScore } shape as a normal score-based hard stop", () => {
			// Normal (score-based) hard stop: capture the emitStop payload shape.
			const normalEmit = vitest.fn()
			const normalDetector = new ProgressAwareLoopDetector(3, {
				metrics: { emitStop: normalEmit, emitNudge: vitest.fn() },
			})
			const tool = createToolUse("repeat", "repeat-tool", { x: "1" })
			driveGenuineLoop(normalDetector, tool)
			expect(normalEmit).toHaveBeenCalled()
			const normalPayload = normalEmit.mock.calls[0][0] as { toolName: string; noProgressScore: number }
			expect(Object.keys(normalPayload).sort()).toStrictEqual(["noProgressScore", "toolName"])
			expect(typeof normalPayload.toolName).toBe("string")
			expect(typeof normalPayload.noProgressScore).toBe("number")

			// Backstop hard stop: payload must have the same key shape and value types.
			const backstopEmit = vitest.fn()
			const backstopDetector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1, transcriptWindowFraction: 0.9 },
				metrics: { emitStop: backstopEmit, emitNudge: vitest.fn() },
			})
			backstopDetector.evaluateProgress("task", capturedWithProgress("read_file"))
			expect(backstopEmit).toHaveBeenCalledTimes(1)
			const backstopPayload = backstopEmit.mock.calls[0][0] as { toolName: string; noProgressScore: number }
			expect(Object.keys(backstopPayload).sort()).toStrictEqual(["noProgressScore", "toolName"])
			expect(typeof backstopPayload.toolName).toBe("string")
			expect(typeof backstopPayload.noProgressScore).toBe("number")
		})

		it("does not call emitStop on sub-ceiling continue decisions", () => {
			const emitStop = vitest.fn()
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1_000_000, transcriptWindowFraction: 0.9 },
				servingContextWindow: 100_000,
				metrics: { emitStop, emitNudge: vitest.fn() },
			})
			const captured = capturedWithProgress("read_file", { transcriptTokens: 10 })
			for (let i = 0; i < 20; i++) {
				const decision = detector.evaluateProgress("task", captured)
				expect(decision.band).toBe("continue")
			}
			expect(emitStop).not.toHaveBeenCalled()
		})

		it("a throwing metrics sink does not break the backstop hard-stop return", () => {
			const metrics: MetricsSink = {
				emitStop: vitest.fn(() => {
					throw new Error("sink exploded")
				}),
				emitNudge: vitest.fn(),
			}
			const detector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1, transcriptWindowFraction: 0.9 },
				metrics,
			})

			let decision: BandDecision | undefined
			expect(() => {
				decision = detector.evaluateProgress("task", capturedWithProgress("read_file"))
			}).not.toThrow()
			expect(decision?.band).toBe("hard_stop")
			expect(isHardStopResult(decision!.result)).toBe(true)
		})
	})

	// --- Result-contract parity (Req 10.7) ---
	describe("result-contract parity (Req 10.7)", () => {
		it("produces the same ToolRepetitionCheckResult shape as a normal hard stop", () => {
			// Backstop hard stop via the turn limb.
			const backstopDetector = new ProgressAwareLoopDetector(3, {
				absoluteBound: { turnCeiling: 1, transcriptWindowFraction: 0.9 },
			})
			const backstop = backstopDetector.evaluateProgress("task", capturedWithProgress("read_file"))
			expect(backstop.band).toBe("hard_stop")
			expect(isHardStopResult(backstop.result)).toBe(true)
			expect(backstop.result.allowExecution).toBe(false)
			expect(backstop.result.askUser?.messageKey).toBe("mistake_limit_reached")
			expect(backstop.result.askUser?.messageDetail.length ?? 0).toBeGreaterThan(0)
			expect(backstop.result.nudge).toBeUndefined()

			// Normal score-based hard stop surfaced through the gate: same contract.
			const normalDetector = new ProgressAwareLoopDetector()
			const tool = createToolUse("repeat", "repeat-tool", { x: "1" })
			const results = driveGenuineLoop(normalDetector, tool)
			const normalStop = results.find((r) => r.askUser)
			expect(normalStop).toBeDefined()
			expect(isHardStopResult(normalStop!)).toBe(true)
			expect(normalStop!.askUser?.messageKey).toBe(backstop.result.askUser?.messageKey)
			expect(normalStop!.allowExecution).toBe(backstop.result.allowExecution)
			expect(normalStop!.nudge).toBeUndefined()
		})
	})
})
