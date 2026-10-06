import { TaskDag } from "../TaskDag"
import type { ExecutionPlan } from "../elasticTypes"
import type { ParallelTaskSpec } from "../../tools/ParallelTasksTool"
import { ParallelTasksArgumentError } from "../../tools/parallelTasksErrors"

// Minimal spec builder: TaskDag only reads `name`, but a valid spec needs mode/message.
const spec = (name: string): ParallelTaskSpec => ({ name, mode: "code", message: `work ${name}`, todos: null })

const plan = (
	names: string[],
	dependencies?: Array<{ dependent: string; dependsOn: string[] }>,
): ExecutionPlan => ({ tasks: names.map(spec), dependencies })

describe("TaskDag", () => {
	describe("isRunnable", () => {
		it("treats a node with no dependencies as runnable immediately", () => {
			const dag = new TaskDag(plan(["a", "b"]))
			expect(dag.isRunnable("a")).toBe(true)
			expect(dag.isRunnable("b")).toBe(true)
		})

		it("is not runnable until every dependency completes, then runnable", () => {
			const dag = new TaskDag(plan(["a", "b", "c"], [{ dependent: "c", dependsOn: ["a", "b"] }]))
			expect(dag.isRunnable("c")).toBe(false)
			dag.unlockedBy("a")
			expect(dag.isRunnable("c")).toBe(false)
			dag.unlockedBy("b")
			expect(dag.isRunnable("c")).toBe(true)
		})

		it("returns false for an unknown node", () => {
			const dag = new TaskDag(plan(["a"]))
			expect(dag.isRunnable("missing")).toBe(false)
		})
	})

	describe("unlockedBy", () => {
		it("unlocks a dependent only when its last dependency completes", () => {
			const dag = new TaskDag(plan(["a", "b", "c"], [{ dependent: "c", dependsOn: ["a", "b"] }]))
			expect(dag.unlockedBy("a")).toEqual([])
			expect(dag.unlockedBy("b")).toEqual(["c"])
		})

		it("does not unlock unrelated siblings", () => {
			// b and c both depend only on a; d is independent.
			const dag = new TaskDag(
				plan(
					["a", "b", "c", "d"],
					[
						{ dependent: "b", dependsOn: ["a"] },
						{ dependent: "c", dependsOn: ["a"] },
					],
				),
			)
			expect(dag.unlockedBy("a").slice().sort()).toEqual(["b", "c"])
			expect(dag.isRunnable("d")).toBe(true) // independent, always runnable
		})

		it("is idempotent: re-completing a node unlocks nothing further", () => {
			const dag = new TaskDag(plan(["a", "b"], [{ dependent: "b", dependsOn: ["a"] }]))
			expect(dag.unlockedBy("a")).toEqual(["b"])
			expect(dag.unlockedBy("a")).toEqual([])
		})
	})

	describe("criticalPath", () => {
		it("returns the longest dependency chain in dependency → dependent order", () => {
			// a → b → d is length 3; c is a short branch off a.
			const dag = new TaskDag(
				plan(
					["a", "b", "c", "d"],
					[
						{ dependent: "b", dependsOn: ["a"] },
						{ dependent: "c", dependsOn: ["a"] },
						{ dependent: "d", dependsOn: ["b"] },
					],
				),
			)
			expect(dag.criticalPath()).toEqual(["a", "b", "d"])
		})

		it("returns a single node for an all-independent plan", () => {
			const dag = new TaskDag(plan(["a", "b", "c"]))
			expect(dag.criticalPath()).toEqual(["a"])
		})

		it("returns an empty array for an empty plan", () => {
			const dag = new TaskDag(plan([]))
			expect(dag.criticalPath()).toEqual([])
		})
	})

	describe("construction rejects malformed plans", () => {
		it("rejects a dependency cycle as a recoverable argument error", () => {
			expect(
				() =>
					new TaskDag(
						plan(
							["a", "b", "c"],
							[
								{ dependent: "b", dependsOn: ["a"] },
								{ dependent: "c", dependsOn: ["b"] },
								{ dependent: "a", dependsOn: ["c"] },
							],
						),
					),
			).toThrow(ParallelTasksArgumentError)
		})

		it("rejects a self-dependency", () => {
			expect(() => new TaskDag(plan(["a"], [{ dependent: "a", dependsOn: ["a"] }]))).toThrow(
				ParallelTasksArgumentError,
			)
		})

		it("rejects duplicate task names as a recoverable argument error", () => {
			expect(() => new TaskDag(plan(["a", "a"]))).toThrow(ParallelTasksArgumentError)
		})

		it("rejects a dependency on an unknown task", () => {
			expect(() => new TaskDag(plan(["a"], [{ dependent: "a", dependsOn: ["ghost"] }]))).toThrow(
				ParallelTasksArgumentError,
			)
		})
	})
})
