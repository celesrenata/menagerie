import { describe, expect, it } from "vitest"
import { allowNetConnect } from "../../../vitest.setup"
import { completeOnAnalysisRoute } from "../AnalysisService"

const messages = [{ role: "user" as const, content: "hi" }]

describe("completeOnAnalysisRoute", () => {
	it("reports no published route when the environment is not configured", async () => {
		expect(await completeOnAnalysisRoute({ messages, maxTokens: 10, env: {} })).toEqual({ kind: "unavailable", reason: "no analysis route published" })
	})

	it("returns content from an injected client and turns failures into unavailable", async () => {
		const ok = await completeOnAnalysisRoute({ messages, maxTokens: 10, complete: async () => ({ content: "{}", finishReason: "stop" }) })
		expect(ok).toMatchObject({ kind: "ok", content: "{}" })
		const down = await completeOnAnalysisRoute({
			messages,
			maxTokens: 10,
			complete: async () => {
				throw new Error("HTTP 503")
			},
		})
		expect(down).toEqual({ kind: "unavailable", reason: "HTTP 503" })
	})

	it("sends a tool-less non-streaming request to the configured route", async () => {
		allowNetConnect()
		const bodies: Array<Record<string, unknown>> = []
		const server = await import("http").then(
			(http) =>
				new Promise<import("http").Server>((resolve) => {
					const s = http.createServer((req, res) => {
						let raw = ""
						req.on("data", (c) => (raw += c))
						req.on("end", () => {
							bodies.push(JSON.parse(raw))
							res.setHeader("content-type", "application/json")
							res.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }))
						})
					})
					s.listen(0, "127.0.0.1", () => resolve(s))
				}),
		)
		try {
			const port = (server.address() as import("net").AddressInfo).port
			const env = { MENAGERIE_ANALYSIS_BASE_URL: `http://127.0.0.1:${port}/v1`, MENAGERIE_ANALYSIS_MODEL: "granite-test" }
			const done = await completeOnAnalysisRoute({ messages, maxTokens: 16, env })
			expect(done).toMatchObject({ kind: "ok", content: '{"ok":true}', modelId: "granite-test" })
			expect(bodies[0]).toMatchObject({ model: "granite-test", stream: false, max_tokens: 16 })
			expect(bodies[0]).not.toHaveProperty("tools")
			expect(bodies[0]).not.toHaveProperty("tool_choice")
			expect(bodies[0]).not.toHaveProperty("temperature")
		} finally {
			server.close()
		}
	})
})
