import { describe, it, expect } from "vitest"

import { DISCOVERY_RESULT_TOOLS, MAX_DISCOVERY_RESULT_CHARS, capToolResultText } from "../helpers/toolResultCap"

describe("capToolResultText", () => {
	it("returns text unchanged when under the cap", () => {
		expect(capToolResultText("short", 100)).toBe("short")
	})

	it("returns text unchanged at the exact boundary", () => {
		const text = "a".repeat(100)
		expect(capToolResultText(text, 100)).toBe(text)
	})

	it("truncates one char over the boundary", () => {
		const text = "a".repeat(101)
		const result = capToolResultText(text, 100)
		expect(result).not.toBe(text)
		expect(result).toContain("Result truncated")
	})

	it("preserves head (2/3) and tail (1/3) and reports the omitted count", () => {
		const text = "H".repeat(1000) + "M".repeat(5000) + "T".repeat(1000)
		const result = capToolResultText(text, 300)
		const headEnd = 200
		const tailStart = text.length - 100
		expect(result.startsWith("H".repeat(headEnd))).toBe(true)
		expect(result.endsWith("T".repeat(100))).toBe(true)
		expect(result).toContain(`${tailStart - headEnd} characters omitted`)
		expect(result).toContain("offset/limit")
		expect(result).toContain("regex")
	})

	it("does not split surrogate pairs at the boundaries", () => {
		const text = "😀".repeat(200)
		const result = capToolResultText(text, 101)
		// A lone surrogate would not survive a UTF-8 round trip.
		expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result)
		expect(result).not.toContain("\uFFFD")
	})

	it("uses 120_000 as the default cap", () => {
		expect(MAX_DISCOVERY_RESULT_CHARS).toBe(120_000)
		const under = "x".repeat(120_000)
		expect(capToolResultText(under)).toBe(under)
		expect(capToolResultText(under + "x")).toContain("Result truncated")
	})

	it("lists the discovery tools", () => {
		expect([...DISCOVERY_RESULT_TOOLS]).toEqual(["list_files", "search_files", "read_file", "codebase_search"])
	})
})
