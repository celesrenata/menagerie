import { DEFAULT_PARALLELISM_POLICY_TABLE, type ParallelismPolicy } from "@roo-code/types"
import { toUserParallelismPolicy } from "../resolveUserParallelismPolicy"

describe("toUserParallelismPolicy", () => {
	it("returns an empty policy when the source is absent", () => {
		expect(toUserParallelismPolicy(undefined)).toEqual({})
	})

	it("maps conservative numeric ceilings", () => {
		expect(toUserParallelismPolicy(DEFAULT_PARALLELISM_POLICY_TABLE.conservative)).toEqual({
			maxLive: 3,
			maxDispatched: 2,
			maxReaderSwarm: 2,
		})
	})

	it("maps balanced numeric ceilings", () => {
		expect(toUserParallelismPolicy(DEFAULT_PARALLELISM_POLICY_TABLE.balanced)).toEqual({
			maxLive: 6,
			maxDispatched: 4,
			maxReaderSwarm: 4,
		})
	})

	it("maps aggressive numeric ceilings", () => {
		expect(toUserParallelismPolicy(DEFAULT_PARALLELISM_POLICY_TABLE.aggressive)).toEqual({
			maxLive: 10,
			maxDispatched: 8,
			maxReaderSwarm: 4,
		})
	})

	it("leaves auto unconstrained for dynamic runnable and reader swarm", () => {
		expect(toUserParallelismPolicy(DEFAULT_PARALLELISM_POLICY_TABLE.auto)).toEqual({
			maxLive: 12,
		})
	})

	it("leaves max unconstrained for saturate reader swarm", () => {
		expect(toUserParallelismPolicy(DEFAULT_PARALLELISM_POLICY_TABLE.max)).toEqual({
			maxLive: 12,
			maxDispatched: 12,
		})
	})

	it("drops non-finite, zero, and negative numeric ceilings", () => {
		const garbage = {
			maxLive: 0,
			maxRunnable: Number.NaN,
			readerSwarm: -4,
			speculation: "disabled",
			workStealing: false,
			dynamicFanOut: false,
		} as unknown as ParallelismPolicy
		expect(toUserParallelismPolicy(garbage)).toEqual({})
	})

	it("floors fractional numeric ceilings", () => {
		const fractional = {
			maxLive: 3.9,
			maxRunnable: 2.1,
			readerSwarm: 4.8,
			speculation: "disabled",
			workStealing: false,
			dynamicFanOut: false,
		} as ParallelismPolicy
		expect(toUserParallelismPolicy(fractional)).toEqual({
			maxLive: 3,
			maxDispatched: 2,
			maxReaderSwarm: 4,
		})
	})
})
