import { describe, it, expect } from "vitest"
import { createSemanticExplorationState } from "../semanticExplorationState"
import type { SemanticFinding } from "../types"

/**
 * Example-based tests for `createSemanticExplorationState` and its per-task
 * `cache` + cross-worker `sharedMemory`.
 *
 * Requirements traced: 5.3, 11.1, 11.2, 11.3
 */
describe("createSemanticExplorationState", () => {
	const finding = (overrides: Partial<SemanticFinding> = {}): SemanticFinding => ({
		query: "find auth logic",
		file: "src/auth/login.ts",
		startLine: 10,
		endLine: 42,
		score: 0.91,
		...overrides,
	})

	it("does not share cache entries across independent task states (Req 5.3)", () => {
		const stateA = createSemanticExplorationState()
		const stateB = createSemanticExplorationState()

		stateA.cache.store("find auth logic", [finding()])

		expect(stateA.cache.lookup("find auth logic")).toEqual([finding()])
		expect(stateB.cache.lookup("find auth logic")).toBeUndefined()
	})

	it("looks up cached findings under a normalized query (case + whitespace)", () => {
		const state = createSemanticExplorationState()
		const stored = [finding()]

		state.cache.store("Find Auth Logic", stored)

		expect(state.cache.lookup("find auth logic")).toBe(stored)
		expect(state.cache.lookup("  find   auth   logic  ")).toBe(stored)
		expect(state.cache.lookup("FIND AUTH LOGIC")).toBe(stored)
	})

	it("makes findings published by one worker readable by a sibling in the same state (Req 11.2)", () => {
		const state = createSemanticExplorationState()
		const published = finding()

		// Worker A publishes into shared memory.
		state.sharedMemory.publish([published])

		// A sibling worker (or the mastermind) looks the concept up.
		const seen = state.sharedMemory.lookup("find auth logic")
		expect(seen).toEqual([published])
	})

	it("carries only SemanticFinding fields through shared memory (Req 11.3)", () => {
		const state = createSemanticExplorationState()

		// Build an input with the five SemanticFinding fields plus extras that
		// must never leak (e.g. a worker's chat transcript). Typing the extras
		// via an intersection keeps us off `as any` per AGENTS.md.
		const withExtras: SemanticFinding & { chatTranscript: string; secret: number } = {
			...finding(),
			chatTranscript: "worker private conversation",
			secret: 1234,
		}

		state.sharedMemory.publish([withExtras])

		const seen = state.sharedMemory.lookup("find auth logic")
		expect(seen).toBeDefined()
		expect(seen).toHaveLength(1)
		expect(Object.keys(seen![0]).sort()).toEqual(["endLine", "file", "query", "score", "startLine"])
		expect(seen![0]).toEqual(finding())
	})

	it("groups published findings by their own normalized query field (Req 11.1)", () => {
		const state = createSemanticExplorationState()
		const first = finding({ file: "src/auth/login.ts" })
		const second = finding({ query: "Find Auth Logic", file: "src/auth/session.ts" })

		state.sharedMemory.publish([first, second])

		const seen = state.sharedMemory.lookup("find auth logic")
		expect(seen).toEqual([
			finding({ file: "src/auth/login.ts" }),
			finding({ query: "Find Auth Logic", file: "src/auth/session.ts" }),
		])
	})
})
