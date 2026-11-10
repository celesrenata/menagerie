import * as fs from "fs/promises"
import * as path from "path"

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

/**
 * Persisted copy of the last gate summary per parent task, so the Observatory can still show it after
 * a restart. Still display-only: the authoritative state is the revision store plus evidence, and a
 * stale file is replaced by the next gate run. Stored under `.kiro/specs/.status/` (a dot directory,
 * never mistaken for a spec id).
 */
const STATUS_DIR = path.join(".kiro", "specs", ".status")
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)

export async function persistSpecStatus(workspaceRoot: string, parentTaskId: string, status: readonly SpecStatusSummary[]): Promise<void> {
	try {
		const dir = path.join(workspaceRoot, STATUS_DIR)
		await fs.mkdir(dir, { recursive: true })
		const file = path.join(dir, `${safeId(parentTaskId)}.json`)
		const tmp = `${file}.${process.pid}.tmp`
		await fs.writeFile(tmp, JSON.stringify(status), "utf8")
		await fs.rename(tmp, file)
	} catch {
		// Display persistence must never affect the gate result.
	}
}

export async function loadPersistedSpecStatus(workspaceRoot: string, parentTaskId: string): Promise<readonly SpecStatusSummary[] | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path.join(workspaceRoot, STATUS_DIR, `${safeId(parentTaskId)}.json`), "utf8"))
		if (!Array.isArray(parsed)) return undefined
		return parsed.filter((s): s is SpecStatusSummary => !!s && typeof s.specId === "string" && typeof s.revisionId === "string" && typeof s.phase === "string")
	} catch {
		return undefined
	}
}
