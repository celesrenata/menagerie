import { isSplittableEmbeddingError, planEmbeddingRequests } from "../embedding-batches"

describe("planEmbeddingRequests", () => {
	it("returns no requests for no texts", () => {
		expect(planEmbeddingRequests([])).toEqual([])
	})

	it("groups by length (stable) and covers every index exactly once", () => {
		const texts = ["x".repeat(400), "a", "x".repeat(40), "b"]
		const requests = planEmbeddingRequests(texts, { maxItems: 2, maxPaddedTokens: 1000 })
		expect(requests).toEqual([
			[1, 3],
			[2, 0],
		])
	})

	it("starts a new request when items x longest exceeds the padded budget", () => {
		// 25, 25, 100 estimated tokens: 2 x 25 fits in 100, adding the 100-token item would pad to 300.
		const texts = ["x".repeat(100), "x".repeat(100), "x".repeat(400)]
		expect(planEmbeddingRequests(texts, { maxItems: 32, maxPaddedTokens: 100 })).toEqual([[0, 1], [2]])
	})

	it("always sends an item on its own even if it alone exceeds the budget", () => {
		expect(planEmbeddingRequests(["x".repeat(4000)], { maxItems: 32, maxPaddedTokens: 10 })).toEqual([[0]])
	})
})

describe("isSplittableEmbeddingError", () => {
	it.each([
		[Object.assign(new Error("boom"), { status: 500 }), true],
		[Object.assign(new Error("boom"), { status: 503 }), true],
		[new Error("HTTP 502: Bad Gateway"), true],
		[Object.assign(new Error("Connection error."), {}), true],
		[new Error("Request timed out."), true],
		[new TypeError("fetch failed"), true],
		[Object.assign(new Error("read"), { code: "ECONNRESET" }), true],
		[Object.assign(new Error("Connection error."), { status: 429 }), false],
		[Object.assign(new Error("bad"), { status: 400 }), false],
		[new Error("Batch processing failed"), false],
		[null, false],
		["string error", false],
	])("%s -> %s", (error, expected) => {
		expect(isSplittableEmbeddingError(error)).toBe(expected)
	})
})
