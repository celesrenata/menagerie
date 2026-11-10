import { describe, expect, it } from "vitest"

import { findPolicyViolations } from "../workflowPolicyGuard"
import { resolveWorkflowPolicy } from "../SpecWorkflowPolicy"

const canWrite = (m: string) => m === "code"
const tasks = [
	{ name: "read", mode: "project-reader" },
	{ name: "edit", mode: "code" },
	{ name: "declared", mode: "project-reader", filesWrite: ["src/a.ts"] },
]

describe("findPolicyViolations", () => {
	it("returns nothing when the feature is disabled, for every policy", () => {
		for (const policy of ["explore", "build", "strict"] as const) {
			expect(findPolicyViolations(tasks, resolveWorkflowPolicy({ enabled: false, policy }), canWrite)).toEqual([])
		}
	})
	it("returns nothing for build and strict", () => {
		for (const policy of ["build", "strict"] as const) {
			expect(findPolicyViolations(tasks, resolveWorkflowPolicy({ enabled: true, policy }), canWrite)).toEqual([])
		}
	})
	it("explore rejects write-capable modes and declared write targets, not readers", () => {
		const v = findPolicyViolations(tasks, resolveWorkflowPolicy({ enabled: true, policy: "explore" }), canWrite)
		expect(v).toHaveLength(2)
		expect(v.join("\n")).toContain("Task edit")
		expect(v.join("\n")).toContain("Task declared")
		expect(v.join("\n")).not.toContain("Task read")
	})
})
