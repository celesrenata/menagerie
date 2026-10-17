import { TaskSessionRegistry, migrateSummary } from "../TaskSessionRegistry"
import type { TaskRef, TaskSummary } from "../types"

const ref = (taskId: string, workspaceUri = "file:///ws"): TaskRef => ({
	hostId: "host-1",
	workspaceUri,
	taskId,
})

const summary = (taskId: string, workspaceUri = "file:///ws"): TaskSummary => ({
	ref: ref(taskId, workspaceUri),
	role: "code",
	status: "running",
	title: `Task ${taskId}`,
	changedFileCount: 0,
	pendingApprovalCount: 0,
	lastMeaningfulEventAt: 1,
	revision: 0,
})

describe("TaskSessionRegistry", () => {
	it("resolves by stable TaskRef, not array position", () => {
		const registry = new TaskSessionRegistry()
		registry.register({ ref: ref("b"), summary: summary("b") })
		registry.register({ ref: ref("a"), summary: summary("a") })
		expect(registry.get(ref("a"))?.ref.taskId).toBe("a")
		expect(registry.get(ref("missing"))).toBeNull()
		expect(registry.summaries().map((row) => row.ref.taskId)).toEqual(["a", "b"])
	})

	it("keeps order stable by workspace then task id", () => {
		const registry = new TaskSessionRegistry()
		registry.register({ ref: ref("2", "file:///z"), summary: summary("2", "file:///z") })
		registry.register({ ref: ref("1", "file:///a"), summary: summary("1", "file:///a") })
		expect(registry.summaries().map((row) => row.ref.taskId)).toEqual(["1", "2"])
	})

	it("attach/detach never cancels the task", () => {
		const registry = new TaskSessionRegistry()
		const cancel = vi.fn()
		const handle = { ref: ref("live"), summary: summary("live"), cancel }
		registry.register(handle)
		registry.attachView(handle.ref, { id: "view-1" })
		registry.detachView(handle.ref, { id: "view-1" })
		expect(cancel).not.toHaveBeenCalled()
		expect(registry.get(handle.ref)).toBe(handle)
		expect(registry.viewCount(handle.ref)).toBe(0)
	})

	it("persists and restores an index, preferring live handles", () => {
		const store = new Map<string, unknown>()
		const storage = {
			get: (key: string) => store.get(key),
			update: (key: string, value: unknown) => {
				store.set(key, value)
			},
		}
		const first = new TaskSessionRegistry()
		first.bindStorage(storage)
		first.register({ ref: ref("persisted"), summary: summary("persisted") })

		const second = new TaskSessionRegistry()
		second.bindStorage(storage)
		const live = { ref: ref("persisted"), summary: { ...summary("persisted"), title: "live" } }
		second.register(live)
		const restored = second.restorePersisted()
		expect(restored).toHaveLength(1)
		expect(second.get(ref("persisted"))?.summary.title).toBe("live")
	})

	it("snapshotIfGap returns current summaries when sequence advanced", () => {
		const registry = new TaskSessionRegistry()
		expect(registry.snapshotIfGap(0)).toBeNull()
		registry.register({ ref: ref("one"), summary: summary("one") })
		expect(registry.snapshotIfGap(0)?.map((row) => row.ref.taskId)).toEqual(["one"])
		expect(registry.snapshotIfGap(1)).toBeNull()
	})

	it("migrates older { id, workspace } records without dropping them", () => {
		const migrated = migrateSummary({
			id: "old-1",
			workspace: "file:///legacy",
			title: "Legacy task",
			status: "completed",
			updatedAt: 42,
			mode: "code",
		})
		expect(migrated).toMatchObject({
			ref: { hostId: "unknown", workspaceUri: "file:///legacy", taskId: "old-1" },
			title: "Legacy task",
			status: "completed",
			lastMeaningfulEventAt: 42,
		})
	})
})
