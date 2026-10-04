import type { ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"
import { ParallelTaskArgumentRecovery } from "../../task/ParallelTaskArgumentRecovery"
import { runParallelTasks } from "../../task/runParallelTasks"
import {
	parallelTaskSpecSchema,
	parallelTasksSchema,
	parallelTasksTool,
	type ParallelTaskSpec,
} from "../ParallelTasksTool"

vi.mock("../../task/runParallelTasks", () => ({
	runParallelTasks: vi.fn().mockResolvedValue({ batchId: "b", tasks: [] }),
}))

const worker = (index: number) => ({
	name: `worker-${index}`,
	mode: index === 4 ? "project-reader" : "code",
	message: `Independent scope ${index}`,
	todos: null,
})

describe("parallelTasksSchema", () => {
	it("allows one to four tasks, including three Code workers and an independent M5 reader", () => {
		expect(parallelTasksSchema.safeParse({ tasks: [worker(1)] }).success).toBe(true)
		expect(parallelTasksSchema.safeParse({ tasks: [1, 2, 3, 4].map(worker) }).success).toBe(true)
		expect(parallelTasksSchema.safeParse({ tasks: [] }).success).toBe(false)
		expect(parallelTasksSchema.safeParse({ tasks: [1, 2, 3, 4, 5].map(worker) }).success).toBe(false)
	})

	// Cap-edge guard: parallelTasksSchema.parse runs on the requested tasks before
	// addSharedDocumentReader appends its reader, so the input is already capped at 4. The reader's
	// own `specs.length >= 4` early-return keeps a 4-worker request from being pushed to 5; this
	// test documents that the schema has no slack for the append path to exceed the cap.
	it("caps requested tasks at four before any reader append", () => {
		expect(parallelTasksSchema.safeParse({ tasks: [1, 2, 3].map(worker) }).success).toBe(true)
		expect(parallelTasksSchema.safeParse({ tasks: [1, 2, 3, 4, 5].map(worker) }).success).toBe(false)
	})
})

describe("parallelTaskSpecSchema route field", () => {
	it("accepts an optional non-empty route id", () => {
		const result = parallelTaskSpecSchema.safeParse({ ...worker(1), route: "qwen3-27b-fast" })
		expect(result.success).toBe(true)
		if (result.success) expect(result.data.route).toBe("qwen3-27b-fast")
	})

	it("accepts a null route", () => {
		expect(parallelTaskSpecSchema.safeParse({ ...worker(1), route: null }).success).toBe(true)
	})

	it("rejects an empty-string route", () => {
		expect(parallelTaskSpecSchema.safeParse({ ...worker(1), route: "" }).success).toBe(false)
	})

	it("rejects an over-long route (>200 chars)", () => {
		expect(parallelTaskSpecSchema.safeParse({ ...worker(1), route: "x".repeat(201) }).success).toBe(false)
	})
})

describe("parallelTaskSpecSchema transitional tolerance", () => {
	it("drops a stray legacy routing_tier/routing_reason instead of rejecting (.strip)", () => {
		const result = parallelTaskSpecSchema.safeParse({
			...worker(1),
			routing_tier: 4,
			routing_reason: "legacy",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect((result.data as Record<string, unknown>).routing_tier).toBeUndefined()
			expect((result.data as Record<string, unknown>).routing_reason).toBeUndefined()
		}
	})
})

describe("ParallelTasksTool.execute", () => {
	const makeTask = (parallelTasksEnabled = true) => {
		const provider = {
			getState: async () => ({ experiments: { parallelTasks: parallelTasksEnabled }, customModes: [] }),
		}
		const double = {
			providerRef: { deref: () => provider },
			parallelWorker: false,
			cwd: "/test/workspace",
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			parallelTaskArgumentRecovery: new ParallelTaskArgumentRecovery(),
		}
		// execute() only touches these members; a full Task needs a provider, API handler and
		// filesystem, so the double is asserted through unknown.
		return { double, provider, task: double as unknown as Task }
	}

	const makeCallbacks = () => {
		const askApproval = vi.fn().mockResolvedValue(true)
		const handleError = vi.fn().mockResolvedValue(undefined)
		const pushToolResult = vi.fn()
		const callbacks: ToolCallbacks = { askApproval, handleError, pushToolResult }
		return { askApproval, handleError, pushToolResult, callbacks }
	}

	// Model-supplied arguments are untyped at runtime; execute() must validate them itself.
	const run = (input: unknown, task: Task, callbacks: ToolCallbacks) =>
		parallelTasksTool.execute(input as { tasks: ParallelTaskSpec[] }, task, callbacks)

	beforeEach(() => {
		vi.mocked(runParallelTasks).mockClear()
	})

	it("runs a single task as one worker through the normal path", async () => {
		const { task, provider } = makeTask()
		const { askApproval, handleError, pushToolResult, callbacks } = makeCallbacks()

		await expect(run({ tasks: [worker(1)] }, task, callbacks)).resolves.toBeUndefined()

		expect(askApproval).toHaveBeenCalledOnce()
		expect(runParallelTasks).toHaveBeenCalledWith(task, provider, [worker(1)])
		expect(pushToolResult).toHaveBeenCalledWith(JSON.stringify({ batchId: "b", tasks: [] }))
		expect(handleError).not.toHaveBeenCalled()
	})

	it.each([
		{ label: "0 tasks", input: { tasks: [] } },
		{ label: "5 tasks", input: { tasks: [1, 2, 3, 5, 6].map(worker) } },
		{ label: "a spec missing message", input: { tasks: [{ name: "a", mode: "code", todos: null }] } },
		{ label: "duplicate names", input: { tasks: [worker(1), worker(1)] } },
	])("returns a recoverable tool error for $label", async ({ input }) => {
		const { double, task } = makeTask()
		const { askApproval, handleError, pushToolResult, callbacks } = makeCallbacks()

		await expect(run(input, task, callbacks)).resolves.toBeUndefined()

		expect(pushToolResult).toHaveBeenCalledOnce()
		const result: string = pushToolResult.mock.calls[0][0]
		expect(JSON.parse(result)).toMatchObject({ status: "error" })
		expect(result).toContain("1-4 tasks")
		expect(handleError).not.toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
		expect(runParallelTasks).not.toHaveBeenCalled()
		expect(double.didToolFailInCurrentTurn).toBe(true)
		expect(double.consecutiveMistakeCount).toBe(1)
		expect(double.recordToolError).toHaveBeenCalledWith("parallel_tasks")
		// Malformed schema calls keep the one forced retry.
		expect(double.parallelTaskArgumentRecovery.consume(true)).toBe(true)
	})

	it("returns a recoverable tool error for an invalid mode slug", async () => {
		const { double, task } = makeTask()
		const { handleError, pushToolResult, callbacks } = makeCallbacks()

		await run({ tasks: [{ ...worker(1), mode: "no-such-mode" }] }, task, callbacks)

		const result: string = pushToolResult.mock.calls[0][0]
		expect(JSON.parse(result)).toMatchObject({ status: "error" })
		expect(result).toContain("Invalid mode: no-such-mode")
		expect(result).toContain("1-4 tasks")
		expect(handleError).not.toHaveBeenCalled()
		expect(runParallelTasks).not.toHaveBeenCalled()
		expect(double.recordToolError).toHaveBeenCalledWith("parallel_tasks")
	})

	it("still reports a disabled experiment through handleError", async () => {
		const { task } = makeTask(false)
		const { handleError, pushToolResult, callbacks } = makeCallbacks()

		await run({ tasks: [worker(1)] }, task, callbacks)

		expect(handleError).toHaveBeenCalledWith("running parallel tasks", expect.any(Error))
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(runParallelTasks).not.toHaveBeenCalled()
	})
})
