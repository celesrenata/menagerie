import { describe, it, expect } from "vitest"

import { detectKnownTarget } from "../knownTargetDetector"

describe("detectKnownTarget", () => {
	it("treats a worker-held path as a Known_Target (highest precedence)", () => {
		const result = detectKnownTarget({ workerHeldPath: "src/core/task/Task.ts" })

		expect(result).toEqual({
			present: true,
			path: "src/core/task/Task.ts",
			source: "worker_held",
		})
	})

	it("parses a path:line diagnostic into a Known_Target with its line", () => {
		const result = detectKnownTarget({
			diagnostics: [{ message: "Error in src/core/task/Task.ts:918" }],
		})

		expect(result).toEqual({
			present: true,
			path: "src/core/task/Task.ts",
			line: 918,
			source: "diagnostic",
		})
	})

	it("parses a path:line:column diagnostic, capturing path and line", () => {
		const result = detectKnownTarget({
			diagnostics: [{ message: "src/main.ts:42:10 - error" }],
		})

		expect(result.present).toBe(true)
		expect(result.path).toBe("src/main.ts")
		expect(result.line).toBe(42)
		expect(result.source).toBe("diagnostic")
	})

	it("treats a single exact path named in a user instruction as a Known_Target", () => {
		const result = detectKnownTarget({ userInstruction: "Fix the bug in src/utils.ts" })

		expect(result).toEqual({
			present: true,
			path: "src/utils.ts",
			source: "user_instruction",
		})
	})

	it("treats a bare filename with a recognized extension as a Known_Target", () => {
		const result = detectKnownTarget({ userInstruction: "Check package.json" })

		expect(result).toEqual({
			present: true,
			path: "package.json",
			source: "user_instruction",
		})
	})

	it("degrades to absent when the user instruction names two distinct paths", () => {
		const result = detectKnownTarget({ userInstruction: "Compare src/a.ts and src/b.ts" })

		expect(result).toEqual({ present: false })
	})

	it("is absent when the user instruction names no path", () => {
		const result = detectKnownTarget({ userInstruction: "Please investigate the issue" })

		expect(result).toEqual({ present: false })
	})

	it("is absent on empty inputs", () => {
		const result = detectKnownTarget({})

		expect(result).toEqual({ present: false })
	})

	it("prefers the worker-held path over a diagnostic when both are present", () => {
		const result = detectKnownTarget({
			workerHeldPath: "src/core/task/Task.ts",
			diagnostics: [{ message: "Error in src/other/File.ts:12" }],
		})

		expect(result).toEqual({
			present: true,
			path: "src/core/task/Task.ts",
			source: "worker_held",
		})
	})
})
