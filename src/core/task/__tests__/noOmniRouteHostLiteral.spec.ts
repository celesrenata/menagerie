import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"

/**
 * Acceptance guard (design §8, criterion (a)): no hardcoded OmniRoute host literal
 * remains in production source. OmniRoute detection is flag-based; there must be no
 * such string in shipped source. Docs/plan artifacts and tests (which reference the
 * old host only to prove the flag ignores it) are excluded from the scan.
 * `git grep` operates on the whole repository regardless of the working directory.
 */
describe("no hardcoded OmniRoute host literal in production source", () => {
	it("finds zero occurrences of the old host literal", () => {
		const literal = ["omniroute", "celestium", "life"].join(".")

		let output = ""
		try {
			// Scan tracked production source only: exclude docs, task-planning artifacts,
			// and test files that legitimately quote the literal to assert it is ignored.
			output = execFileSync(
				"git",
				[
					"grep",
					"-l",
					"-F",
					literal,
					"--",
					":!docs/**",
					":!.agents/**",
					":!**/__tests__/**",
					":!**/*.spec.ts",
					":!**/*.spec.tsx",
					":!**/*.test.ts",
					":!**/*.test.tsx",
				],
				{ encoding: "utf8" },
			)
		} catch (error: unknown) {
			// git grep exits 1 with no output when there are no matches — the success case.
			const status = (error as { status?: number }).status
			const stdout = (error as { stdout?: string }).stdout ?? ""
			if (status === 1 && stdout.trim() === "") {
				output = ""
			} else {
				throw error
			}
		}

		expect(output.trim()).toBe("")
	})
})
