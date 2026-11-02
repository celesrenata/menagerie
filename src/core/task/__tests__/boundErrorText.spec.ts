import { boundErrorText, MAX_RECORDED_ERROR_CHARS } from "../boundErrorText"

describe("boundErrorText", () => {
	it("returns short text unchanged", () => {
		expect(boundErrorText("Worker failed")).toBe("Worker failed")
		const atLimit = "x".repeat(MAX_RECORDED_ERROR_CHARS)
		expect(boundErrorText(atLimit)).toBe(atLimit)
	})

	it("truncates oversized text and records how much was dropped", () => {
		const huge = "Command's stdout was larger than 67108864 characters\n" + "diff --git a/f b/f\n".repeat(5_000_000)
		const bounded = boundErrorText(huge)
		expect(bounded.length).toBeLessThan(MAX_RECORDED_ERROR_CHARS + 100)
		expect(bounded.startsWith("Command's stdout was larger")).toBe(true)
		expect(bounded).toContain(`[truncated ${huge.length - MAX_RECORDED_ERROR_CHARS} characters]`)
	})

	it("honours an explicit limit", () => {
		expect(boundErrorText("abcdef", 3)).toBe("abc… [truncated 3 characters]")
	})
})
