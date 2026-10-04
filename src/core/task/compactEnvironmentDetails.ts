import type { ApiMessage } from "../task-persistence"

const SUPERSEDED_ENVIRONMENT = "[Earlier environment snapshot superseded by the latest one.]"

function isEnvironmentDetails(block: unknown): boolean {
	if (!block || typeof block !== "object" || !("type" in block) || !("text" in block)) return false
	if (block.type !== "text" || typeof block.text !== "string") return false
	const text = block.text.trim()
	return text.startsWith("<environment_details>") && text.endsWith("</environment_details>")
}

/**
 * Drop superseded environment snapshots (optionally keeping the newest).
 *
 * Only for condense-time input. Do NOT apply this to the per-request history:
 * rewriting already-sent messages breaks prefix/KV-cache reuse on the server.
 */
export function compactHistoricalEnvironmentDetails(messages: ApiMessage[], keepLatest = true): ApiMessage[] {
	let latestSnapshotIndex = -1
	if (keepLatest) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(isEnvironmentDetails)
			) {
				latestSnapshotIndex = index
				break
			}
		}
	}

	return messages.map((message, index) => {
		if (message.role !== "user" || !Array.isArray(message.content) || index === latestSnapshotIndex) return message
		const content = message.content.filter((block) => !isEnvironmentDetails(block))
		if (content.length === message.content.length) return message
		return {
			...message,
			content: content.length > 0 ? content : [{ type: "text", text: SUPERSEDED_ENVIRONMENT }],
		}
	})
}
