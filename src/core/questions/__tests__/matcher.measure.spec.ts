import { describe, expect, it } from "vitest"

import { QUESTION_PAIRS } from "../__fixtures__/questionPairs"
import { MEMORY_MATCH_THRESHOLD } from "../QuestionMemory"
import { questionSimilarity, tokenSet } from "../questionText"

const score = (a: string, b: string) => questionSimilarity(tokenSet(a), tokenSet(b))

describe("question matcher measured on labeled pairs", () => {
	const positives = QUESTION_PAIRS.filter((p) => p.same)
	const negatives = QUESTION_PAIRS.filter((p) => !p.same)
	const hits = positives.filter((p) => score(p.a, p.b) >= MEMORY_MATCH_THRESHOLD)
	const falseMatches = negatives.filter((p) => score(p.a, p.b) >= MEMORY_MATCH_THRESHOLD)

	it("never reuses an answer for a near-miss question (false-match rate 0)", () => {
		expect(falseMatches.map((p) => `${p.a} <> ${p.b}`)).toEqual([])
	})

	it("keeps a safety margin below the reuse threshold on the worst near-miss", () => {
		expect(Math.max(...negatives.map((p) => score(p.a, p.b)))).toBeLessThan(MEMORY_MATCH_THRESHOLD)
	})

	it("recognizes most genuine paraphrases", () => {
		const missed = positives.filter((p) => !hits.includes(p)).map((p) => `${p.a} <> ${p.b} (${score(p.a, p.b).toFixed(2)})`)
		// Report what is missed so a regression is visible, then hold the recall floor.
		expect(hits.length / positives.length, `missed:\n${missed.join("\n")}`).toBeGreaterThanOrEqual(0.65)
	})
})
