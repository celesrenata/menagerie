import { computeCondenseInputBudget, splitMessagesIntoChunks } from "../chunkedSummary"

describe("computeCondenseInputBudget", () => {
	it("subtracts the 10% buffer, output reserve and prompt tokens from the window", () => {
		expect(computeCondenseInputBudget({ contextWindow: 100_000, outputReserve: 6_144, promptTokens: 856 })).toBe(
			83_000,
		)
	})

	it("never goes negative", () => {
		expect(computeCondenseInputBudget({ contextWindow: 1_000, outputReserve: 6_144, promptTokens: 10 })).toBe(0)
	})
})

describe("splitMessagesIntoChunks", () => {
	const count = (n: number) => Promise.resolve(n)

	it("returns no chunks for no messages", async () => {
		expect(await splitMessagesIntoChunks([], 10, count)).toEqual([])
	})

	it("packs greedily on message boundaries", async () => {
		expect(await splitMessagesIntoChunks([4, 4, 4, 4, 4], 10, count)).toEqual([[4, 4], [4, 4], [4]])
	})

	it("keeps an oversized message alone in its own chunk", async () => {
		expect(await splitMessagesIntoChunks([2, 50, 2], 10, count)).toEqual([[2], [50], [2]])
	})

	it("keeps everything in one chunk when it fits", async () => {
		expect(await splitMessagesIntoChunks([3, 3, 3], 10, count)).toEqual([[3, 3, 3]])
	})
})
