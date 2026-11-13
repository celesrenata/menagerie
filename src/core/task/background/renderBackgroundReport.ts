import { compactParallelTasksResultForParent } from "../../tools/ParallelTasksTool"
import type { BackgroundTurnReport } from "./BackgroundBatchService"

/** The `# Background Tasks` section shown to the top-level model on its next turn. */
export function renderBackgroundTasksSection(report: BackgroundTurnReport): string {
	const lines: string[] = ["# Background Tasks"]
	for (const batch of report.batches) {
		if (batch.results.length > 0) {
			const compact = compactParallelTasksResultForParent({
				batchId: batch.batchId,
				manifestPath: batch.manifestPath,
				tasks: batch.results,
			})
			lines.push(`Newly finished in batch ${batch.batchId}:`, JSON.stringify(compact))
		}
		if (batch.postProcessing !== undefined) {
			lines.push(`Batch ${batch.batchId} finished. Gate and analysis:`, JSON.stringify(batch.postProcessing))
		}
	}
	if (report.running.length > 0) {
		lines.push("Still running (use background_tasks to steer, cancel or wait):")
		for (const worker of report.running) {
			const pending =
				worker.pendingSteering > 0 ? `, ${worker.pendingSteering} steering message(s) not read yet` : ""
			lines.push(`- ${worker.name} (batch ${worker.batchId})${pending}`)
		}
	}
	return lines.join("\n")
}

/** The `# Steering from parent` section a background worker sees on its next request. */
export function renderSteeringSection(items: readonly string[]): string {
	return [
		"# Steering from parent",
		"Your parent task sent new instructions while you were working. Apply them to the remaining work:",
		...items.map((item, index) => `${index + 1}. ${item}`),
	].join("\n")
}
