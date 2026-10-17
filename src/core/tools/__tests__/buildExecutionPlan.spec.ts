import { buildExecutionPlan, parallelTaskSpecSchema } from "../ParallelTasksTool"

const spec = (over: Record<string, unknown>) => ({
	name: "w",
	mode: "code",
	message: "do the work",
	...over,
})

describe("buildExecutionPlan DAG threading (lift C4)", () => {
	it("returns a flat plan (no dependencies key) for specs without dependsOn", () => {
		const plan = buildExecutionPlan([spec({ name: "a" }), spec({ name: "b" })])
		expect(plan.tasks).toHaveLength(2)
		expect(plan.dependencies).toBeUndefined()
	})

	it("collects per-spec dependsOn into plan.dependencies edges", () => {
		const plan = buildExecutionPlan([
			spec({ name: "build" }),
			spec({ name: "test", dependsOn: ["build"] }),
			spec({ name: "docs" }),
		])
		expect(plan.dependencies).toEqual([{ dependent: "test", dependsOn: ["build"] }])
	})

	it("the additive fields survive validation", () => {
		const validated = parallelTaskSpecSchema.parse(
			spec({
				dependsOn: ["build"],
				filesWrite: ["src/a.ts"],
				filesRead: ["src/b.ts"],
				expectedOutput: "a passing build artifact",
				deadlineMs: 123_456,
				priority: "high",
			}),
		)
		expect(validated.dependsOn).toEqual(["build"])
		expect(validated.filesWrite).toEqual(["src/a.ts"])
		expect(validated.filesRead).toEqual(["src/b.ts"])
		expect(validated.expectedOutput).toBe("a passing build artifact")
		expect(validated.deadlineMs).toBe(123_456)
		expect(validated.priority).toBe("high")
	})

	it("rejects an invalid priority value", () => {
		expect(() => parallelTaskSpecSchema.parse(spec({ priority: "urgent" }))).toThrow()
	})

	it("stays legacy-tolerant: absent additive fields leave them undefined", () => {
		const validated = parallelTaskSpecSchema.parse(spec({ name: "legacy" }))
		expect(validated.dependsOn).toBeUndefined()
		expect(validated.priority).toBeUndefined()
		expect(validated.filesWrite).toBeUndefined()
	})
})
