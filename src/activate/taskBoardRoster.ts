import type { TodoItem } from "@roo-code/types"

/**
 * Per-workspace record of the tasks shown on the Task Board, persisted so the board can
 * offer them again after a window reload (which restarts the extension host and drops
 * every in-memory task). Pure functions only; the vscode glue lives in taskBoard.ts.
 */

export const TASK_BOARD_ROSTER_KEY = "menagerie.taskBoard.roster.v1"
export const MAX_ROSTER_ENTRIES = 50

export interface RosterEntry {
	id: string
	title: string
	summary: string
	mode: string
	workspace: string
	workspaceUri: string
	parentTaskId?: string
	parallelWorker: boolean
	todos: TodoItem[]
	updatedAt: number
	/** Set when the user cancels; cancelled tasks are not offered again after a reload. */
	cancelled?: boolean
}

export interface LiveRowLike {
	id: string
	title: string
	summary: string
	mode: string
	status: string
	workspace: string
	workspaceUri: string
	parentTaskId?: string
	parallelWorker: boolean
	todos: TodoItem[]
	updatedAt?: number
}

/** Read and validate a persisted roster; anything malformed is dropped. */
export function parseRoster(value: unknown): RosterEntry[] {
	if (!Array.isArray(value)) return []
	return value.filter(
		(entry): entry is RosterEntry =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as RosterEntry).id === "string" &&
			typeof (entry as RosterEntry).title === "string" &&
			Array.isArray((entry as RosterEntry).todos),
	)
}

/**
 * Activation-time cleanup: drop cancelled tasks and tasks whose history says they
 * completed or no longer exist.
 */
export function pruneOnActivation(
	roster: RosterEntry[],
	historyStatus: (taskId: string) => string | undefined | null,
): RosterEntry[] {
	return roster.filter((entry) => {
		if (entry.cancelled) return false
		const status = historyStatus(entry.id)
		return status !== null && status !== "completed"
	})
}

/**
 * Merge the live board into the roster. Live unfinished tasks are upserted, live
 * completed tasks are removed, and entries with no live owner are kept so they can
 * be recovered.
 */
export function syncRoster(roster: RosterEntry[], live: LiveRowLike[], now = Date.now()): RosterEntry[] {
	const byId = new Map(roster.map((entry) => [entry.id, entry]))
	for (const row of live) {
		if (row.status === "completed") {
			byId.delete(row.id)
			continue
		}
		const previous = byId.get(row.id)
		byId.set(row.id, {
			id: row.id,
			title: row.title,
			summary: row.summary,
			mode: row.mode,
			workspace: row.workspace,
			workspaceUri: row.workspaceUri,
			parentTaskId: row.parentTaskId,
			parallelWorker: row.parallelWorker,
			todos: row.todos,
			updatedAt: row.updatedAt ?? previous?.updatedAt ?? now,
			cancelled: previous?.cancelled,
		})
	}
	return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ROSTER_ENTRIES)
}

/** Roster entries that have no live owner in this window. */
export function recoverableEntries(roster: RosterEntry[], liveIds: ReadonlySet<string>): RosterEntry[] {
	return roster.filter((entry) => !entry.cancelled && !liveIds.has(entry.id))
}

export function markCancelled(roster: RosterEntry[], taskId: string): RosterEntry[] {
	return roster.map((entry) => (entry.id === taskId ? { ...entry, cancelled: true } : entry))
}

export function removeEntry(roster: RosterEntry[], taskId: string): RosterEntry[] {
	return roster.filter((entry) => entry.id !== taskId)
}

export function rostersEqual(a: RosterEntry[], b: RosterEntry[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}
