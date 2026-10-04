import type { ApiMessage } from "../../task-persistence"
import { compactHistoricalEnvironmentDetails } from "../compactEnvironmentDetails"

describe("compactHistoricalEnvironmentDetails", () => {
	const oldEnvironment = { type: "text" as const, text: "<environment_details>old tabs</environment_details>" }
	const latestEnvironment = { type: "text" as const, text: "<environment_details>current files</environment_details>" }

	it("keeps only the latest snapshot for API requests without changing saved messages", () => {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "Start work" }, oldEnvironment] },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "Working" }] },
			{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "tool-1", content: "done" }, latestEnvironment] },
		] as ApiMessage[]

		const compacted = compactHistoricalEnvironmentDetails(messages)

		expect(compacted[0].content).toEqual([{ type: "text", text: "Start work" }])
		expect(compacted[2]).toBe(messages[2])
		expect(messages[0].content).toContainEqual(oldEnvironment)
	})

	it("keeps an earlier environment-only user turn valid and removes snapshots from summary prompts", () => {
		const messages = [
			{ role: "user" as const, content: [oldEnvironment] },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "Working" }] },
			{ role: "user" as const, content: [latestEnvironment] },
		] as ApiMessage[]

		const compacted = compactHistoricalEnvironmentDetails(messages, false)

		expect(compacted[0].content).toEqual([
			{ type: "text", text: "[Earlier environment snapshot superseded by the latest one.]" },
		])
		expect(compacted[2].content).toEqual(compacted[0].content)
		expect(messages[2].content).toContainEqual(latestEnvironment)
	})
})
