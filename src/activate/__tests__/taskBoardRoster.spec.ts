import {
	MAX_ROSTER_ENTRIES,
	markCancelled,
	parseRoster,
	pruneOnActivation,
	recoverableEntries,
	syncRoster,
	type LiveRowLike,
	type RosterEntry,
} from "../taskBoardRoster"

const live = (id: string, status = "working", updatedAt = 1): LiveRowLike => ({
	id,
	title: `Task ${id}`,
	summary: `Task ${id}`,
	mode: "code",
	status,
	workspace: "/repo",
	workspaceUri: "file:///repo",
	parallelWorker: false,
	todos: [],
	updatedAt,
})

const entry = (id: string, extra: Partial<RosterEntry> = {}): RosterEntry => ({
	id,
	title: `Task ${id}`,
	summary: `Task ${id}`,
	mode: "code",
	workspace: "/repo",
	workspaceUri: "file:///repo",
	parallelWorker: false,
	todos: [],
	updatedAt: 1,
	...extra,
})

describe("task board roster", () => {
	it("drops malformed persisted values", () => {
		expect(parseRoster(undefined)).toEqual([])
		expect(parseRoster([{ id: 1 }, null, entry("a")])).toEqual([entry("a")])
	})

	it("upserts unfinished live tasks and removes completed ones", () => {
		const next = syncRoster([entry("done"), entry("old")], [live("new", "working", 5), live("done", "completed")])
		expect(next.map((e) => e.id)).toEqual(["new", "old"])
	})

	it("keeps tasks that are no longer live so they can be recovered", () => {
		const roster = syncRoster([], [live("a")])
		const afterReload = syncRoster(roster, [])
		expect(recoverableEntries(afterReload, new Set()).map((e) => e.id)).toEqual(["a"])
		expect(recoverableEntries(afterReload, new Set(["a"]))).toEqual([])
	})

	it("preserves the cancelled flag across syncs and hides cancelled tasks from recovery", () => {
		const roster = markCancelled(syncRoster([], [live("a")]), "a")
		const synced = syncRoster(roster, [live("a")])
		expect(synced[0]?.cancelled).toBe(true)
		expect(recoverableEntries(synced, new Set())).toEqual([])
	})

	it("prunes cancelled, completed and missing tasks on activation", () => {
		const roster = [entry("keep"), entry("cancelled", { cancelled: true }), entry("done"), entry("gone")]
		const status: Record<string, string | null> = {
			keep: "active",
			cancelled: "active",
			done: "completed",
			gone: null,
		}
		expect(pruneOnActivation(roster, (id) => status[id]).map((e) => e.id)).toEqual(["keep"])
	})

	it("caps the roster, keeping the most recently updated tasks", () => {
		const rows = Array.from({ length: MAX_ROSTER_ENTRIES + 5 }, (_, i) => live(`t${i}`, "working", i))
		const next = syncRoster([], rows)
		expect(next).toHaveLength(MAX_ROSTER_ENTRIES)
		expect(next[0]?.id).toBe(`t${MAX_ROSTER_ENTRIES + 4}`)
	})
})
