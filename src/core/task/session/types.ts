/**
 * Stable task identity and command/summary types for the Menagerie lift.
 * Source of truth is task state/history/worktree, not a view.
 */

export interface TaskRef {
	/** Extension-host owner id (window-scoped); persisted and revalidated on activation. */
	hostId: string
	/** Workspace root URI (file:// or virtual scheme), string form for portability. */
	workspaceUri: string
	/** Existing task id (uuid). Reused; never regenerated on navigation. */
	taskId: string
}

export type TaskStatus =
	| "queued"
	| "running"
	| "waiting-input"
	| "review"
	| "completed"
	| "failed"
	| "cancelled"

export interface TaskSummary {
	ref: TaskRef
	parentTaskId?: string
	/** Worker mode slug, e.g. "code", "project-reader". */
	role: string
	/** OmniRoute route id if pinned (e.g. "hybrid/code"); undefined otherwise. */
	route?: string
	status: TaskStatus
	/** Truncated task title (first line of the first message), ≤ 120 chars. */
	title: string
	changedFileCount: number
	pendingApprovalCount: number
	lastMeaningfulEventAt: number
	/** Monotonic per-task revision; board reconciles on gaps. */
	revision: number
}

export type TaskCommand =
	| { kind: "open"; ref: TaskRef; destination?: "task-hub" | "editor" }
	| { kind: "inspect-diff"; ref: TaskRef; path?: string }
	| { kind: "resume"; ref: TaskRef }
	| { kind: "cancel"; ref: TaskRef; confirmed: true }

export function taskRefKey(ref: TaskRef): string {
	return `${ref.hostId}\0${ref.workspaceUri}\0${ref.taskId}`
}

export function sameTaskRef(a: TaskRef, b: TaskRef): boolean {
	return a.hostId === b.hostId && a.workspaceUri === b.workspaceUri && a.taskId === b.taskId
}
