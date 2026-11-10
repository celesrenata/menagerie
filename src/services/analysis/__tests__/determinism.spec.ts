import { measureDeterminism } from "../determinism"

const cases = [{ id: "a", messages: [{ role: "user" as const, content: "x" }] }]

describe("measureDeterminism", () => {
	it("reports zero noise for a deterministic completer", async () => {
		const r = await measureDeterminism(async () => "same", cases, 4)
		expect(r).toMatchObject({ sequentialNoise: 0, concurrentNoise: 0, runsPerMode: 4 })
	})

	it("reports 1 when every run differs and compares only the leading characters", async () => {
		let n = 0
		const all = await measureDeterminism(async () => `out-${n++}`, cases, 4)
		expect(all.sequentialNoise).toBe(1)
		expect(all.concurrentNoise).toBe(1)
		const tail = await measureDeterminism(async () => `same${"x".repeat(10)}${n++}`, cases, 4, 14)
		expect(tail.sequentialNoise).toBe(0)
	})

	it("separates sequential from concurrent noise", async () => {
		let inFlight = 0
		const r = await measureDeterminism(
			async () => {
				inFlight++
				const seen = inFlight
				await new Promise((res) => setTimeout(res, 1))
				inFlight--
				return seen > 1 ? `batched-${seen}` : "solo"
			},
			cases,
			4,
		)
		expect(r.sequentialNoise).toBe(0)
		expect(r.concurrentNoise).toBeGreaterThan(0)
	})
})
