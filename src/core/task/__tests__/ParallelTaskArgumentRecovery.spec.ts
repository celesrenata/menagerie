import { ParallelTaskArgumentRecovery } from "../ParallelTaskArgumentRecovery"

describe("ParallelTaskArgumentRecovery", () => {
	it("forces exactly one retry after malformed batch arguments", () => {
		const recovery = new ParallelTaskArgumentRecovery()
		expect(recovery.consume(true)).toBe(false)
		recovery.onMalformedCall()
		expect(recovery.consume(true)).toBe(true)
		recovery.onMalformedCall()
		expect(recovery.consume(true)).toBe(false)
	})

	it("clears recovery when the tool is unavailable and resets after a valid call", () => {
		const recovery = new ParallelTaskArgumentRecovery()
		recovery.onMalformedCall()
		expect(recovery.consume(false)).toBe(false)
		expect(recovery.consume(true)).toBe(false)
		recovery.onMalformedCall()
		expect(recovery.consume(true)).toBe(true)
		recovery.onValidCall()
		recovery.onMalformedCall()
		expect(recovery.consume(true)).toBe(true)
	})
})
