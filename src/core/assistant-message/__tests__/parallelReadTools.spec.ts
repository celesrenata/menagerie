import type { ToolUse } from "../../../shared/tools"
import { collectParallelReadBatch, isParallelRead, runReadBatch } from "../parallelReadTools"

const read = (id: string): ToolUse => ({
	type: "tool_use",
	id,
	name: "read_file",
	params: {},
	nativeArgs: { path: id },
	partial: false,
})

describe("read tool batches", () => {
	it("overlaps reads up to the cap and collects failures without abandoning other results", async () => {
		let active = 0
		let peak = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const complete: string[] = []
		const failed: string[] = []
		const batch = runReadBatch(
			Array.from({ length: 11 }, (_, i) => read(String(i))),
			async (tool) => {
				active++
				peak = Math.max(peak, active)
				await gate
				active--
				if (tool.id === "2") throw new Error("missing file")
				complete.push(tool.id!)
			},
			(tool) => failed.push(tool.id!),
			() => false,
		)
		await vi.waitFor(() => expect(peak).toBe(8))
		release()
		await batch
		expect(complete).toHaveLength(10)
		expect(failed).toEqual(["2"])
		expect(peak).toBe(8)
	})

	it("finishes in-flight reads and returns cancellation results for queued calls after rejection", async () => {
		let rejected = false
		const ran: string[] = []
		const failures: string[] = []
		await runReadBatch(
			Array.from({ length: 10 }, (_, i) => read(String(i))),
			async (tool) => {
				ran.push(tool.id!)
				rejected = true
			},
			(tool) => failures.push(tool.id!),
			() => rejected,
		)
		expect(new Set([...ran, ...failures]).size).toBe(10)
		expect(failures.length).toBeGreaterThan(0)
	})

	it("treats commands, edits, delegation and MCP tools as barriers", () => {
		for (const name of [
			"execute_command",
			"write_to_file",
			"new_task",
			"parallel_tasks",
			"use_mcp_tool",
		] as const) {
			expect(isParallelRead({ ...read("x"), name })).toBe(false)
		}
		expect(isParallelRead(read("x"))).toBe(true)
	})

	it("collects reads across narration, but stops before side effects and partial blocks", () => {
		const narration = (content: string) => ({ type: "text" as const, content, partial: false })
		const command: ToolUse = {
			type: "tool_use",
			id: "command",
			name: "execute_command",
			params: {},
			partial: false,
		}
		const plan = collectParallelReadBatch(
			[read("one"), narration("checking the next file"), read("two"), command, read("three")],
		)

		expect(plan.tools.map((tool) => tool.id)).toEqual(["one", "two"])
		expect(plan.text.map((block) => block.content)).toEqual(["checking the next file"])
		expect(plan.consumed).toBe(3)

		const partial = collectParallelReadBatch([read("one"), { ...read("two"), partial: true }, read("three")])
		expect(partial.tools.map((tool) => tool.id)).toEqual(["one"])
		expect(partial.consumed).toBe(1)
	})

	it("caps each batch at eight reads without consuming the ninth", () => {
		const plan = collectParallelReadBatch(Array.from({ length: 9 }, (_, index) => read(String(index))))
		expect(plan.tools).toHaveLength(8)
		expect(plan.consumed).toBe(8)
	})

	it("executes repeated IDs only once", async () => {
		const execute = vi.fn(async () => {})
		await runReadBatch([read("same"), read("same")], execute, vi.fn(), () => false)
		expect(execute).toHaveBeenCalledTimes(1)
	})
})
