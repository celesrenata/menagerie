import type { SpecStatusSummary } from "@roo-code/types"

/**
 * In-memory, display-only registry of spec status per parent task (MEN-GRANITE-SDD-001 R9.1, R9.2).
 *
 * It is written by the strict workflow after the deterministic gate has decided and read by the
 * Observatory when it builds the Mastermind summary. It is NOT a source of truth: the authoritative
 * state is the revision store plus recorded evidence, and a restart simply empties this cache until
 * the next gate run. It has no lifecycle side effects, and closing a view never touches it.
 */
const MAX_PARENTS = 64
const registry = new Map<string, SpecStatusSummary[]>()

export function setSpecStatus(parentTaskId: string, status: readonly SpecStatusSummary[]): void {
	registry.delete(parentTaskId) // refresh insertion order so the oldest parent is evicted first
	registry.set(parentTaskId, [...status])
	while (registry.size > MAX_PARENTS) {
		const oldest = registry.keys().next().value
		if (oldest === undefined) break
		registry.delete(oldest)
	}
}

export function getSpecStatus(parentTaskId: string): readonly SpecStatusSummary[] | undefined {
	return registry.get(parentTaskId)
}

export function clearSpecStatusForTests(): void {
	registry.clear()
}
