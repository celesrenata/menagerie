import { TaskCommandRouter, type TaskOwnerHandle } from "../taskCommandRouter"
import type { TaskRef } from "../../core/task/session/types"

const hostId = "host-local"

function ref(taskId: string, workspaceUri = "file:///repo", hid = hostId): TaskRef {
	return { hostId: hid, workspaceUri, taskId }
}

function owner(taskId: string, workspaceUri = "file:///repo", extra: Partial<TaskOwnerHandle> = {}): TaskOwnerHandle {
	return {
		ref: ref(taskId, workspaceUri),
		revealChat: vi.fn(() => true),
		showInHub: vi.fn(),
		openInEditor: vi.fn(),
		inspectDiff: vi.fn(),
		resume: vi.fn(),
		cancel: vi.fn(),
		...extra,
	}
}

describe("TaskCommandRouter", () => {
	it("resolves the owning session by TaskRef, never by array position", () => {
		const first = owner("task-a")
		const second = owner("task-b")
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [first, second],
			rememberNavigation: () => false,
		})
		expect(router.resolve(ref("task-b"))).toBe(second)
		expect(router.resolve(ref("task-a"))).toBe(first)
		expect(router.resolve(ref("missing"))).toBeNull()
	})

	it("does not silently select an identically-numbered task in another workspace", () => {
		const local = owner("same-id", "file:///repo-a")
		const other = owner("same-id", "file:///repo-b")
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [local, other],
			rememberNavigation: () => false,
		})
		expect(router.resolve(ref("same-id", "file:///repo-b"))).toBe(other)
		expect(router.resolve(ref("same-id", "file:///repo-a"))).toBe(local)
		expect(router.resolve(ref("same-id", "file:///elsewhere"))).toBeNull()
	})

	it("refuses a foreign host and reports the workspace path", async () => {
		const notifyForeignHost = vi.fn()
		const local = owner("task-a")
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [local],
			rememberNavigation: () => false,
			notifyForeignHost,
		})
		const foreign = ref("task-a", "file:///other-window", "host-remote")
		const result = await router.execute({ kind: "open", ref: foreign })
		expect(result).toEqual({
			ok: false,
			error: "Task belongs to another VS Code window",
			foreignHost: true,
			workspaceUri: "file:///other-window",
		})
		expect(notifyForeignHost).toHaveBeenCalledWith(foreign)
		expect(local.revealChat).not.toHaveBeenCalled()
		expect(local.showInHub).not.toHaveBeenCalled()
	})

	it("opens the hub, reveals the owning chat, and persists selection", async () => {
		const target = owner("live")
		const other = owner("other")
		const persistSelection = vi.fn()
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [other, target],
			rememberNavigation: () => true,
			persistSelection,
		})
		const result = await router.execute({ kind: "open", ref: ref("live"), destination: "task-hub" })
		expect(result).toEqual({ ok: true, action: "opened" })
		expect(target.revealChat).toHaveBeenCalledOnce()
		expect(target.showInHub).toHaveBeenCalledOnce()
		expect(other.revealChat).not.toHaveBeenCalled()
		expect(other.showInHub).not.toHaveBeenCalled()
		expect(persistSelection).toHaveBeenCalledWith("live")
	})

	it("does not focus a different chat when the owner has no live view", async () => {
		const headless = owner("worker", "file:///repo", { revealChat: vi.fn(() => false) })
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [headless],
			rememberNavigation: () => true,
			persistSelection: vi.fn(),
		})
		const result = await router.execute({ kind: "open", ref: ref("worker") })
		expect(result).toEqual({ ok: true, action: "opened" })
		expect(headless.revealChat).toHaveBeenCalledOnce()
		expect(headless.showInHub).toHaveBeenCalledOnce()
	})

	it("opens in an editor without creating or evicting a task", async () => {
		const target = owner("live")
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [target],
			rememberNavigation: () => false,
		})
		const result = await router.execute({ kind: "open", ref: ref("live"), destination: "editor" })
		expect(result).toEqual({ ok: true, action: "opened" })
		expect(target.openInEditor).toHaveBeenCalledOnce()
		expect(target.revealChat).not.toHaveBeenCalled()
		expect(target.showInHub).not.toHaveBeenCalled()
	})

	it("restores the last selected live task across reload", async () => {
		const target = owner("remembered")
		const persistSelection = vi.fn()
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [owner("other"), target],
			rememberNavigation: () => true,
			persistSelection,
			restoreSelection: () => "remembered",
		})
		const result = await router.restoreLastSelection()
		expect(result).toEqual({ ok: true, action: "opened" })
		expect(target.revealChat).toHaveBeenCalledOnce()
		expect(persistSelection).toHaveBeenCalledWith("remembered")
	})

	it("skips restore when rememberTaskNavigation is false or the task is gone", async () => {
		const live = owner("live")
		const disabled = new TaskCommandRouter({
			hostId,
			listOwners: () => [live],
			rememberNavigation: () => false,
			restoreSelection: () => "live",
		})
		expect(await disabled.restoreLastSelection()).toBeNull()
		expect(live.revealChat).not.toHaveBeenCalled()

		const missing = new TaskCommandRouter({
			hostId,
			listOwners: () => [live],
			rememberNavigation: () => true,
			restoreSelection: () => "gone",
		})
		expect(await missing.restoreLastSelection()).toBeNull()
	})

	it("requires confirmation before cancel and refuses unknown local tasks", async () => {
		const target = owner("live")
		const router = new TaskCommandRouter({
			hostId,
			listOwners: () => [target],
			rememberNavigation: () => false,
		})
		expect(await router.execute({ kind: "cancel", ref: ref("live"), confirmed: true })).toEqual({
			ok: true,
			action: "cancelled",
		})
		expect(target.cancel).toHaveBeenCalledOnce()
		expect(await router.execute({ kind: "open", ref: ref("ghost") })).toEqual({
			ok: false,
			error: "Task is not running in this window",
			workspaceUri: "file:///repo",
		})
	})
})
