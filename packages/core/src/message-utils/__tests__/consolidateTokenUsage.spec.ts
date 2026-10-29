// npx vitest run packages/core/src/message-utils/__tests__/consolidateTokenUsage.spec.ts

import type { ClineMessage } from "@roo-code/types"

import { consolidateTokenUsage, hasTokenUsageChanged, hasToolUsageChanged } from "../consolidateTokenUsage.js"

describe("consolidateTokenUsage", () => {
	// Helper function to create a basic api_req_started message
	const createApiReqMessage = (
		ts: number,
		data: {
			tokensIn?: number
			tokensOut?: number
			cacheWrites?: number
			cacheReads?: number
			cost?: number
		},
	): ClineMessage => ({
		ts,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify(data),
	})

	describe("basic token accumulation", () => {
		it("should accumulate tokens from a single message", () => {
			const messages: ClineMessage[] = [createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cost: 0.01 })]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(100)
			expect(result.totalTokensOut).toBe(50)
			expect(result.totalCost).toBe(0.01)
		})

		it("should accumulate tokens from multiple messages", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cost: 0.01 }),
				createApiReqMessage(1001, { tokensIn: 200, tokensOut: 100, cost: 0.02 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(300)
			expect(result.totalTokensOut).toBe(150)
			expect(result.totalCost).toBeCloseTo(0.03)
		})

		it("should handle cache writes and reads", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cacheWrites: 500, cacheReads: 200 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalCacheWrites).toBe(500)
			expect(result.totalCacheReads).toBe(200)
		})

		it("should handle empty messages array", () => {
			const result = consolidateTokenUsage([])

			expect(result.totalTokensIn).toBe(0)
			expect(result.totalTokensOut).toBe(0)
			expect(result.totalCost).toBe(0)
			expect(result.contextTokens).toBe(0)
		})
	})

	describe("context tokens calculation", () => {
		it("should calculate context tokens from the last API request", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				createApiReqMessage(1001, { tokensIn: 200, tokensOut: 100 }),
			]

			const result = consolidateTokenUsage(messages)

			// Context tokens = tokensIn + tokensOut from last message
			expect(result.contextTokens).toBe(300) // 200 + 100
		})

		it("should handle condense_context messages for context tokens", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				{
					ts: 1001,
					type: "say",
					say: "condense_context",
					contextCondense: { newContextTokens: 5000, cost: 0.05 },
				} as ClineMessage,
			]

			const result = consolidateTokenUsage(messages)

			expect(result.contextTokens).toBe(5000)
			expect(result.totalCost).toBeCloseTo(0.05)
		})

		it("should slide contextTokens to the post-truncation size after a sliding window truncation", () => {
			// Regression: after a sliding window truncation the reported context must reflect the
			// post-truncation size, not the stale pre-truncation size from the last api_req_started.
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 190_000, tokensOut: 5_000 }),
				{
					ts: 1001,
					type: "say",
					say: "sliding_window_truncation",
					contextTruncation: {
						truncationId: "t1",
						messagesRemoved: 12,
						prevContextTokens: 195_000,
						newContextTokens: 120_000,
					},
				} as ClineMessage,
			]

			const result = consolidateTokenUsage(messages)

			expect(result.contextTokens).toBe(120_000)
		})

		it("should prefer the later api_req_started over an earlier sliding window truncation", () => {
			const messages: ClineMessage[] = [
				{
					ts: 1000,
					type: "say",
					say: "sliding_window_truncation",
					contextTruncation: {
						truncationId: "t1",
						messagesRemoved: 4,
						prevContextTokens: 150_000,
						newContextTokens: 90_000,
					},
				} as ClineMessage,
				createApiReqMessage(1001, { tokensIn: 95_000, tokensOut: 2_000 }),
			]

			const result = consolidateTokenUsage(messages)

			// The request after the truncation is the most recent size report.
			expect(result.contextTokens).toBe(97_000)
		})

		it("should fall through a zero-size sliding window truncation to the last real count", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				{
					ts: 1001,
					type: "say",
					say: "sliding_window_truncation",
					contextTruncation: {
						truncationId: "t1",
						messagesRemoved: 0,
						prevContextTokens: 150,
						newContextTokens: 0,
					},
				} as ClineMessage,
			]

			const result = consolidateTokenUsage(messages)

			expect(result.contextTokens).toBe(150)
		})

		it("should fall through a sliding window truncation without context data to the last real count", () => {
			const messages: ClineMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				{ ts: 1001, type: "say", say: "sliding_window_truncation" } as ClineMessage,
			]

			const result = consolidateTokenUsage(messages)

			expect(result.contextTokens).toBe(150)
		})
	})

	describe("invalid data handling", () => {
		it("should handle messages with invalid JSON", () => {
			const messages: ClineMessage[] = [{ ts: 1000, type: "say", say: "api_req_started", text: "invalid json" }]

			// Should not throw
			const result = consolidateTokenUsage(messages)
			expect(result.totalTokensIn).toBe(0)
		})

		it("should skip non-api_req_started messages", () => {
			const messages: ClineMessage[] = [
				{ ts: 1000, type: "say", say: "text", text: "hello" },
				createApiReqMessage(1001, { tokensIn: 100, tokensOut: 50 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(100)
			expect(result.totalTokensOut).toBe(50)
		})

		it("should handle missing token values", () => {
			const messages: ClineMessage[] = [createApiReqMessage(1000, { cost: 0.01 })]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(0)
			expect(result.totalTokensOut).toBe(0)
			expect(result.totalCost).toBe(0.01)
		})
	})
})

describe("hasTokenUsageChanged", () => {
	it("should return true when snapshot is undefined", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, undefined)).toBe(true)
	})

	it("should return false when values are the same", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		const snapshot = { ...current }

		expect(hasTokenUsageChanged(current, snapshot)).toBe(false)
	})

	it("should return true when totalTokensIn changes", () => {
		const current = {
			totalTokensIn: 200,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		const snapshot = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when totalCost changes", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.02,
			contextTokens: 150,
		}
		const snapshot = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, snapshot)).toBe(true)
	})
})

describe("hasToolUsageChanged", () => {
	it("should return true when snapshot is undefined", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, undefined)).toBe(true)
	})

	it("should return false when values are the same", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(false)
	})

	it("should return true when a tool is added", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
			write_to_file: { attempts: 1, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when attempts change", () => {
		const current = {
			read_file: { attempts: 2, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when failures change", () => {
		const current = {
			read_file: { attempts: 1, failures: 1 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})
})
