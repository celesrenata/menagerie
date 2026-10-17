import type { TaskCommand, TaskRef } from "../core/task/session/types"
import { sameTaskRef } from "../core/task/session/types"

export const LAST_SELECTED_TASK_ID_KEY = "menagerie.lastSelectedTaskId"
export const HOST_ID_KEY = "menagerie.hostId"

export type TaskCommandResult =
	| { ok: true; action: "opened" | "inspected" | "resumed" | "cancelled" | "persisted" }
	| { ok: false; error: string; foreignHost?: boolean; workspaceUri?: string }

export interface TaskOwnerHandle {
	ref: TaskRef
	/** Reveal the owning chat view. Return true when a live view was focused. */
	revealChat: () => boolean | void
	showInHub: () => Promise<void> | void
	openInEditor?: () => Promise<void> | void
	inspectDiff?: (path?: string) => Promise<void> | void
	resume?: () => Promise<void> | void
	cancel?: () => Promise<void> | void
}

export interface TaskCommandRouterDeps {
	hostId: string
	/** Live local owners. Resolution is by TaskRef, never array position. */
	listOwners: () => TaskOwnerHandle[]
	rememberNavigation: () => boolean
	persistSelection?: (taskId: string) => void
	restoreSelection?: () => string | undefined
	notifyForeignHost?: (ref: TaskRef) => void
}

export class TaskCommandRouter {
	constructor(private readonly deps: TaskCommandRouterDeps) {}

	resolve(ref: TaskRef): TaskOwnerHandle | null {
		if (ref.hostId && ref.hostId !== this.deps.hostId) return null
		const matches = this.deps.listOwners().filter(
			(owner) =>
				owner.ref.taskId === ref.taskId &&
				(ref.workspaceUri === "" || owner.ref.workspaceUri === ref.workspaceUri),
		)
		if (matches.length !== 1) return null
		const owner = matches[0]!
		if (owner.ref.hostId && owner.ref.hostId !== this.deps.hostId) return null
		return owner
	}

	async execute(command: TaskCommand): Promise<TaskCommandResult> {
		if (command.ref.hostId && command.ref.hostId !== this.deps.hostId) {
			this.deps.notifyForeignHost?.(command.ref)
			return {
				ok: false,
				error: "Task belongs to another VS Code window",
				foreignHost: true,
				workspaceUri: command.ref.workspaceUri,
			}
		}

		const owner = this.resolve(command.ref)
		if (!owner) {
			return { ok: false, error: "Task is not running in this window", workspaceUri: command.ref.workspaceUri }
		}

		switch (command.kind) {
			case "open":
				return this.open(owner, command.destination)
			case "inspect-diff":
				await owner.inspectDiff?.(command.path)
				return { ok: true, action: "inspected" }
			case "resume":
				await owner.resume?.()
				return { ok: true, action: "resumed" }
			case "cancel":
				if (!command.confirmed) return { ok: false, error: "Cancel requires confirmation" }
				await owner.cancel?.()
				return { ok: true, action: "cancelled" }
		}
	}

	async restoreLastSelection(): Promise<TaskCommandResult | null> {
		if (!this.deps.rememberNavigation()) return null
		const taskId = this.deps.restoreSelection?.()
		if (!taskId) return null
		const owner = this.deps.listOwners().find((candidate) => candidate.ref.taskId === taskId)
		if (!owner) return null
		return this.open(owner, "task-hub")
	}

	private async open(
		owner: TaskOwnerHandle,
		destination: "task-hub" | "editor" = "task-hub",
	): Promise<TaskCommandResult> {
		if (this.deps.rememberNavigation()) this.deps.persistSelection?.(owner.ref.taskId)
		if (destination === "editor") {
			if (!owner.openInEditor) return { ok: false, error: "Editor destination is unavailable" }
			await owner.openInEditor()
			return { ok: true, action: "opened" }
		}
		// Reveal the owning view only. Never focus a different chat (P2: no create/evict
		// and no silent same-numbered selection). Headless owners still get showInHub.
		owner.revealChat()
		await owner.showInHub()
		return { ok: true, action: "opened" }
	}
}

export function ownerMatchesRef(owner: TaskRef, ref: TaskRef): boolean {
	return sameTaskRef(owner, ref)
}
