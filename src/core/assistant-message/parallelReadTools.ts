import type { ToolUse, McpToolUse, TextContent } from "../../shared/tools"
import { ParallelTaskPool } from "../task/ParallelTaskPool"

// Unknown tools, edits, commands and MCP calls are barriers. Adding an entry here
// requires checking its side effects and its UI interactions, not a model hint.
const READ_TOOLS = new Set(["read_file", "list_files", "search_files", "codebase_search", "read_command_output"])

export function isParallelRead(block: ToolUse | McpToolUse | TextContent): block is ToolUse {
	return block.type === "tool_use" && READ_TOOLS.has(block.name)
}

export interface ParallelReadBatchPlan {
	tools: ToolUse[]
	text: TextContent[]
	consumed: number
}

/**
 * Collect independent reads across assistant narration, stopping at the first
 * partial block, side-effecting tool, or read cap. The caller presents the
 * collected narration and advances by `consumed` after the reads finish.
 */
export function collectParallelReadBatch(
	content: Array<ToolUse | McpToolUse | TextContent>,
	maxReads = 8,
): ParallelReadBatchPlan {
	const plan: ParallelReadBatchPlan = { tools: [], text: [], consumed: 0 }

	for (const block of content) {
		if (block.partial) break

		if (isParallelRead(block)) {
			if (plan.tools.length >= maxReads) break
			plan.tools.push({ ...block })
			plan.consumed++
			continue
		}

		if (block.type === "text" && plan.tools.length > 0) {
			plan.text.push({ ...block })
			plan.consumed++
			continue
		}

		break
	}

	return plan
}

export async function runReadBatch(
	batch: ToolUse[],
	execute: (block: ToolUse) => Promise<void>,
	failure: (block: ToolUse, error: unknown) => void,
	cancelled: () => boolean,
): Promise<void> {
	const pool = new ParallelTaskPool(8)
	const signal = new AbortController().signal
	const seen = new Set<string>()
	await Promise.allSettled(
		batch.map(async (block) => {
			// Never execute a repeated tool call ID twice, even if a provider repeats it.
			if (block.id && seen.has(block.id)) return
			if (block.id) seen.add(block.id)
			try {
				await pool.run(signal, async () => {
					if (cancelled()) throw new Error("Cancelled before execution")
					await execute(block)
				})
			} catch (error) {
				failure(block, error)
			}
		}),
	)
}
