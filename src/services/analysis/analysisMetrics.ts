import type { AnalysisMetricsSnapshot } from "@roo-code/types"

import type { AnalysisEvent } from "./AnalysisExecutor"

/**
 * Process-wide counters for the analysis executor (MEN-GRANITE-SDD-001 R9.3). Fed only from
 * {@link AnalysisEvent}s, which carry no source text, and read as a plain snapshot.
 */
const counters = { requests: 0, cacheHits: 0, retries: 0, promptTokens: 0, completionTokens: 0, escalations: 0 }
const outcomes = new Map<string, number>()

export function recordAnalysisEvent(event: AnalysisEvent): void {
	if (event.type === "cache-hit") counters.cacheHits++
	else if (event.type === "attempt-failed") counters.retries++
	else {
		counters.requests++
		counters.promptTokens += event.promptTokens ?? 0
		counters.completionTokens += event.completionTokens ?? 0
		outcomes.set(event.kind, (outcomes.get(event.kind) ?? 0) + 1)
	}
}

export function recordAnalysisEscalation(): void {
	counters.escalations++
}

export function analysisMetricsSnapshot(queue: { active: number; waiting: number }): AnalysisMetricsSnapshot {
	return { ...counters, outcomes: Object.fromEntries(outcomes), queueActive: queue.active, queueWaiting: queue.waiting }
}

export function resetAnalysisMetricsForTests(): void {
	Object.assign(counters, { requests: 0, cacheHits: 0, retries: 0, promptTokens: 0, completionTokens: 0, escalations: 0 })
	outcomes.clear()
}
