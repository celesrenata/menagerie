// Feature: resilient-context-recovery, Property 4: Convergent reduction reaches the budget in one bounded pass regardless of over-size ratio

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { convergentReduction } from "../convergentReduction"

// ---------------------------------------------------------------------------
// Deterministic per-message token model
//
// Each generated message carries a stable token count in a WeakMap keyed by the
// message object reference. `convergentReduction` only ever filters the original
// array (preserving object identity), so a reference-keyed count makes the faked
// `countTokens` consistent and deterministic: the token total of any subset is the
// sum of its members' per-message counts, and the full set always equals
// `currentTokens`.
// ---------------------------------------------------------------------------

type TokenModel = WeakMap<ApiMessage, number>

function makeCountTokens(model: TokenModel): (messages: ApiMessage[]) => Promise<number> {
	return async (messages: ApiMessage[]) =>
		messages.reduce((total, msg) => total + (model.get(msg) ?? 0), 0)
}

function sumTokens(messages: ApiMessage[], model: TokenModel): number {
	return messages.reduce((total, msg) => total + (model.get(msg) ?? 0), 0)
}

/**
 * Mirror of the implementation's visibility rule: a message is visible to the model
 * when it is neither hidden behind a truncation (`truncationParent`) nor itself a
 * truncation boundary marker (`isTruncationMarker`).
 */
function visibleIndices(messages: ApiMessage[]): number[] {
	const out: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			out.push(index)
		}
	})
	return out
}

interface TranscriptKind {
	kind: "user" | "assistant"
	/** When set, the message is hidden behind a prior truncation. */
	hidden?: boolean
	/** When set, the message is a truncation boundary marker. */
	marker?: boolean
}

/**
 * Build an `ApiMessage[]` plus a reference-keyed token model from a shape spec and a
 * per-message token array. The two arrays are the same length; the token model is
 * seeded as each message is created so the counter is fully deterministic.
 */
function buildTranscript(
	shapes: readonly TranscriptKind[],
	tokens: readonly number[],
): { messages: ApiMessage[]; model: TokenModel } {
	const model: TokenModel = new WeakMap()
	const messages: ApiMessage[] = shapes.map((shape, index) => {
		const msg: ApiMessage = {
			role: shape.kind === "user" ? "user" : "assistant",
			content: `m${index}`,
		}
		if (shape.hidden) {
			msg.truncationParent = "trunc-1"
		}
		if (shape.marker) {
			msg.isTruncationMarker = true
			msg.truncationId = "trunc-1"
		}
		model.set(msg, tokens[index])
		return msg
	})
	return { messages, model }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates an over-budget transcript whose IRREDUCIBLE CORE (first visible message +
 * the two newest visible messages, plus any interleaved hidden/marker messages) is at
 * or below the target. This is the universe Property 4 quantifies over.
 *
 * Strategy: pick a target budget, assign the three preserved visible messages small
 * token counts whose sum is ≤ target, and give the removable middle visible messages
 * large token counts so the full transcript is over budget by an arbitrary (often
 * incident-scale) ratio. Hidden/marker messages contribute zero tokens and so never
 * threaten the core-fits invariant.
 */
const convergeableTranscriptArb = fc
	.record({
		// Servable_Input_Budget / Recovery_Input_Bound the reduction targets.
		targetTokens: fc.integer({ min: 32_768, max: 200_000 }),
		// Number of removable visible messages in the middle (drives the over-size ratio).
		// Kept EVEN so the implementation's pair-wise removal can drop every large middle
		// message, leaving the true reachable floor equal to the preserved core (which fits
		// the target). An odd leftover large message would stay by design (pairs only),
		// which is a separate, non-convergeable shape excluded from Property 4's universe.
		middleCount: fc.integer({ min: 1, max: 12 }).map((n) => n * 2),
		// Hidden/marker messages interleaved among the visible ones.
		extraHidden: fc.integer({ min: 0, max: 4 }),
		extraMarkers: fc.integer({ min: 0, max: 2 }),
		// A huge per-removable-message token count so the ratio can reach ~360K→32K.
		middleTokens: fc.integer({ min: 10_000, max: 60_000 }),
	})
	.chain((base) =>
		fc
			.record({
				// Three preserved-visible token counts whose sum stays within target.
				firstTok: fc.integer({ min: 1, max: Math.floor(base.targetTokens / 6) }),
				newest1Tok: fc.integer({ min: 1, max: Math.floor(base.targetTokens / 6) }),
				newest2Tok: fc.integer({ min: 1, max: Math.floor(base.targetTokens / 6) }),
			})
			.map((pres) => ({ ...base, ...pres })),
	)
	.map((cfg) => {
		const shapes: TranscriptKind[] = []
		const tokens: number[] = []

		// First visible (task) message — preserved.
		shapes.push({ kind: "user" })
		tokens.push(cfg.firstTok)

		// Interleave some hidden/marker messages right after the first message. These are
		// never "visible" so they are never counted toward the removable set, and they
		// carry zero tokens so they never break the core-fits invariant.
		for (let i = 0; i < cfg.extraHidden; i++) {
			shapes.push({ kind: "assistant", hidden: true })
			tokens.push(0)
		}
		for (let i = 0; i < cfg.extraMarkers; i++) {
			shapes.push({ kind: "assistant", marker: true })
			tokens.push(0)
		}

		// Removable middle visible messages — large, drive the over-size ratio.
		for (let i = 0; i < cfg.middleCount; i++) {
			shapes.push({ kind: i % 2 === 0 ? "assistant" : "user" })
			tokens.push(cfg.middleTokens)
		}

		// Two newest visible messages — preserved.
		shapes.push({ kind: "assistant" })
		tokens.push(cfg.newest1Tok)
		shapes.push({ kind: "user" })
		tokens.push(cfg.newest2Tok)

		const { messages, model } = buildTranscript(shapes, tokens)
		const currentTokens = sumTokens(messages, model)
		return { messages, model, currentTokens, targetTokens: cfg.targetTokens }
	})
	// Keep only genuinely over-budget transcripts; the arbitrary almost always
	// produces them, so this filter rarely rejects.
	.filter((t) => t.currentTokens > t.targetTokens)

/**
 * Generates a transcript whose MINIMAL irreducible core (first visible + two newest
 * visible) already EXCEEDS the target — the Req 5.1 terminal condition. The three
 * preserved messages alone sum to more than the budget, so no single bounded pass can
 * reach it.
 */
const irreducibleTranscriptArb = fc
	.record({
		targetTokens: fc.integer({ min: 1_000, max: 50_000 }),
		middleCount: fc.integer({ min: 0, max: 10 }),
		middleTokens: fc.integer({ min: 0, max: 20_000 }),
		// Each of the three preserved messages is at least the full target, so their
		// sum strictly exceeds it.
		coreTok: fc.integer({ min: 1 }),
	})
	.map((cfg) => {
		const coreEach = cfg.targetTokens + cfg.coreTok
		const shapes: TranscriptKind[] = []
		const tokens: number[] = []

		shapes.push({ kind: "user" })
		tokens.push(coreEach)

		for (let i = 0; i < cfg.middleCount; i++) {
			shapes.push({ kind: i % 2 === 0 ? "assistant" : "user" })
			tokens.push(cfg.middleTokens)
		}

		shapes.push({ kind: "assistant" })
		tokens.push(coreEach)
		shapes.push({ kind: "user" })
		tokens.push(coreEach)

		const { messages, model } = buildTranscript(shapes, tokens)
		const currentTokens = sumTokens(messages, model)
		return { messages, model, currentTokens, targetTokens: cfg.targetTokens }
	})

describe("convergentReduction — Property 4", () => {
	// Validates: Requirements 2.2, 2.3, 2.5, 3.1, 3.3, 3.4
	it("reaches the budget in one bounded pass for any over-size ratio, independent of a modeled summarize success/failure", async () => {
		await fc.assert(
			fc.asyncProperty(convergeableTranscriptArb, fc.boolean(), async (t, priorSummarizeSucceeded) => {
				// A prior summarization is modeled as succeeding or failing by whether the
				// deterministic reduction runs after a summarize step. convergentReduction is
				// model-free, so its result must not depend on that flag — we simply assert the
				// same guarantee holds in both branches (the flag never feeds the function).
				void priorSummarizeSucceeded

				const result = await convergentReduction({
					messages: t.messages,
					currentTokens: t.currentTokens,
					targetTokens: t.targetTokens,
					countTokens: makeCountTokens(t.model),
				})

				// Single bounded pass lands at or below the target.
				expect(result.converged).toBe(true)
				expect(result.resultTokens).toBeLessThanOrEqual(t.targetTokens)

				// resultTokens is the true counted size of the returned transcript.
				expect(result.resultTokens).toBe(sumTokens(result.messages, t.model))

				// prevTokens records the pre-reduction size for telemetry (Req 6.3 feed).
				expect(result.prevTokens).toBe(t.currentTokens)

				// The reduction never grows the transcript.
				expect(result.messages.length).toBeLessThanOrEqual(t.messages.length)

				// The preserve-first + two-newest-visible discipline is honored: the first
				// visible (task) message and the two newest visible messages survive.
				const vis = visibleIndices(t.messages)
				const firstVisible = t.messages[vis[0]]
				const newestTwo = vis.slice(-2).map((i) => t.messages[i])
				expect(result.messages).toContain(firstVisible)
				for (const msg of newestTwo) {
					expect(result.messages).toContain(msg)
				}
			}),
			{ numRuns: 150 },
		)
	})

	// Validates: Requirements 2.2, 3.1, 3.3 — incident-scale ratio (~360K → 32K) converges in one pass.
	it("converges a 360K transcript to a 32K budget in a single bounded pass", async () => {
		const target = 32_768
		const shapes: TranscriptKind[] = [{ kind: "user" }]
		const tokens: number[] = [500]
		// ~360K of removable middle history: 11 messages × ~30K ≈ 330K + core.
		for (let i = 0; i < 11; i++) {
			shapes.push({ kind: i % 2 === 0 ? "assistant" : "user" })
			tokens.push(30_000)
		}
		shapes.push({ kind: "assistant" }, { kind: "user" })
		tokens.push(500, 500)

		const { messages, model } = buildTranscript(shapes, tokens)
		const currentTokens = sumTokens(messages, model)
		expect(currentTokens).toBeGreaterThan(300_000)

		const result = await convergentReduction({
			messages,
			currentTokens,
			targetTokens: target,
			countTokens: makeCountTokens(model),
		})

		expect(result.converged).toBe(true)
		expect(result.resultTokens).toBeLessThanOrEqual(target)
		expect(result.prevTokens).toBe(currentTokens)
	})

	// Validates: Requirement 5.1 — irreducible-core terminal condition (feeds Properties 6 and 7).
	it("reports converged:false when the minimal irreducible core exceeds the target", async () => {
		await fc.assert(
			fc.asyncProperty(irreducibleTranscriptArb, async (t) => {
				const result = await convergentReduction({
					messages: t.messages,
					currentTokens: t.currentTokens,
					targetTokens: t.targetTokens,
					countTokens: makeCountTokens(t.model),
				})

				// The irreducible core still exceeds the budget — no bounded pass can satisfy it.
				expect(result.converged).toBe(false)
				expect(result.resultTokens).toBeGreaterThan(t.targetTokens)
				expect(result.resultTokens).toBe(sumTokens(result.messages, t.model))
				expect(result.prevTokens).toBe(t.currentTokens)

				// Even in the terminal case, the preserved core survives.
				const vis = visibleIndices(t.messages)
				expect(result.messages).toContain(t.messages[vis[0]])
				for (const msg of vis.slice(-2).map((i) => t.messages[i])) {
					expect(result.messages).toContain(msg)
				}
			}),
			{ numRuns: 150 },
		)
	})

	// Validates: Requirement 2.2 — an already-within-budget transcript is returned unchanged, converged.
	it("returns the transcript unchanged and converged when already within budget", async () => {
		const { messages, model } = buildTranscript(
			[{ kind: "user" }, { kind: "assistant" }, { kind: "user" }],
			[10, 10, 10],
		)
		const currentTokens = sumTokens(messages, model)

		const result = await convergentReduction({
			messages,
			currentTokens,
			targetTokens: 1_000,
			countTokens: makeCountTokens(model),
		})

		expect(result.converged).toBe(true)
		expect(result.messages).toBe(messages)
		expect(result.resultTokens).toBe(currentTokens)
		expect(result.prevTokens).toBe(currentTokens)
	})
})
