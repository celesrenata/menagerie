import * as fs from "fs/promises"

import { describe, expect, it } from "vitest"

import { allowNetConnect } from "../../../vitest.setup"
import { AnalysisQueue } from "../AnalysisQueue"
import { GraniteAnalysisClient, OMNIROUTE_ANALYSIS_HEADERS } from "../GraniteAnalysisClient"

/**
 * Optional live scaling measurement of Menagerie's own admission path (client + 2-slot queue)
 * against a real route. Skipped unless MENAGERIE_ANALYSIS_BASE_URL and MENAGERIE_ANALYSIS_MODEL are
 * set. Writes raw numbers to MENAGERIE_SCALING_OUT when given. Prompts are unique per request so no
 * prefix reuse helps, and contain only synthetic filler.
 */
const live = process.env.MENAGERIE_ANALYSIS_BASE_URL && process.env.MENAGERIE_ANALYSIS_MODEL ? describe : describe.skip

const filler = (tokens: number, nonce: string): string => {
	const lines: string[] = [`[run ${nonce}]`]
	let chars = 0
	for (let i = 0; chars < tokens / 0.294; i++) {
		const line = `Agent log ${i}: module ${(i * 7919) % 900 + 100} reported load ${(i * 31) % 99} percent.`
		lines.push(line)
		chars += line.length + 1
	}
	return lines.join("\n")
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

live("analysis admission scaling (live)", () => {
	it("never exceeds 2 active generations and queues the third", async () => {
		allowNetConnect()
		const client = new GraniteAnalysisClient({
			baseUrl: process.env.MENAGERIE_ANALYSIS_BASE_URL!,
			model: process.env.MENAGERIE_ANALYSIS_MODEL!,
			apiKey: process.env.MENAGERIE_ANALYSIS_API_KEY,
			timeoutMs: 300_000,
			extraHeaders: OMNIROUTE_ANALYSIS_HEADERS,
		})
		const results: unknown[] = []
		let peakActive = 0
		let peakWaiting = 0

		const round = async (clients: number, promptTokens: number, label: string) => {
			const queue = new AnalysisQueue({ maxActive: 2, maxQueued: 16 })
			const started = performance.now()
			const timings = await Promise.all(
				Array.from({ length: clients }, async (_, i) => {
					const submitted = performance.now()
					let admittedAt = 0
					await queue.run(
						async (signal) => {
							admittedAt = performance.now()
							peakActive = Math.max(peakActive, queue.active)
							peakWaiting = Math.max(peakWaiting, queue.waiting)
							const text = filler(promptTokens, `${label}-${clients}-${i}-${Date.now()}`)
							return client.complete(
								[
									{ role: "system", content: "Return one JSON object only." },
									{ role: "user", content: `${text}\nReturn {"ok":true}` },
								],
								64,
								signal,
							)
						},
						{ deadlineMs: 300_000 },
					)
					const done = performance.now()
					return { queueWaitMs: admittedAt - submitted, totalMs: done - submitted }
				}),
			)
			results.push({
				label,
				clients,
				promptTokens,
				wallMs: Math.round(performance.now() - started),
				queueWaitMsMax: Math.round(Math.max(...timings.map((t) => t.queueWaitMs))),
				totalMsMedian: Math.round(median(timings.map((t) => t.totalMs))),
				totalMsMax: Math.round(Math.max(...timings.map((t) => t.totalMs))),
			})
		}

		for (const clients of [1, 2, 3]) await round(clients, 1_500, "short")
		for (const clients of [1, 2, 3]) await round(clients, 8_000, "medium")
		await round(1, 27_000, "near-cap")
		await round(3, 27_000, "near-cap")

		if (process.env.MENAGERIE_SCALING_OUT) {
			await fs.writeFile(process.env.MENAGERIE_SCALING_OUT, JSON.stringify({ peakActive, peakWaiting, results }, null, 2))
		}
		expect(peakActive).toBeLessThanOrEqual(2)
		expect(peakWaiting).toBeGreaterThanOrEqual(1) // the third client had to wait
	}, 1_500_000)
})
