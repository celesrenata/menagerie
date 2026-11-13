import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { TodoItem } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { Package } from "../shared/package"
import { createHeadlessTaskProvider, openTaskInNewTab } from "./registerCommands"
import {
	TASK_BOARD_ROSTER_KEY,
	markCancelled,
	parseRoster,
	pruneOnActivation,
	recoverableEntries,
	removeEntry,
	rostersEqual,
	syncRoster,
	type RosterEntry,
} from "./taskBoardRoster"
import { HOST_ID_KEY, LAST_SELECTED_TASK_ID_KEY, TaskCommandRouter, type TaskOwnerHandle } from "./taskCommandRouter"
import type { TaskCommand, TaskRef } from "../core/task/session/types"

const OPEN_TASK_COMMAND = `${Package.name}.openTask`

export function resolveHostId(context: vscode.ExtensionContext): string {
	const existing = context.globalState.get<string>(HOST_ID_KEY)
	if (existing) return existing
	const created = crypto.randomUUID()
	void context.globalState.update(HOST_ID_KEY, created)
	return created
}

export function workspaceUriFromCwd(cwd: string): string {
	return vscode.Uri.file(cwd).toString()
}

export function listLiveTaskOwners(hostId: string, context: vscode.ExtensionContext): TaskOwnerHandle[] {
	return ClineProvider.getAllInstances().flatMap((provider) => {
		const task = provider.getCurrentTask()
		if (!task) return []
		const ref: TaskRef = {
			hostId,
			workspaceUri: workspaceUriFromCwd(task.cwd),
			taskId: task.taskId,
		}
		return [
			{
				ref,
				revealChat: () => {
					if (!provider.hasView) return false
					provider.revealChat()
					return true
				},
				showInHub: async () => {
					// Headless workers and detached popouts have no view: attach an editor tab on demand.
					// Closing that tab only detaches it again; it never cancels the task.
					if (!provider.hasView) {
						await openTaskInNewTab(task.taskId, { context })
						return
					}
					await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
				},
				openInEditor: async () => {
					await openTaskInNewTab(task.taskId, { context })
				},
				pause: () => provider.pauseCurrentTask(),
				resume: () => provider.resumeCurrentTask(),
				restart: () => provider.restartCurrentTask(),
				cancel: () => provider.cancelTask(),
			} satisfies TaskOwnerHandle,
		]
	})
}

export function createTaskCommandRouter(context: vscode.ExtensionContext, hostId: string): TaskCommandRouter {
	return new TaskCommandRouter({
		hostId,
		listOwners: () => listLiveTaskOwners(hostId, context),
		rememberNavigation: () =>
			vscode.workspace.getConfiguration(Package.name).get<boolean>("rememberTaskNavigation") !== false,
		persistSelection: (taskId) => {
			void context.globalState.update(LAST_SELECTED_TASK_ID_KEY, taskId)
		},
		restoreSelection: () => context.globalState.get<string>(LAST_SELECTED_TASK_ID_KEY),
		notifyForeignHost: (ref) => {
			void vscode.window.showInformationMessage(
				`That task is running in another window (${ref.workspaceUri || ref.taskId})`,
			)
		},
	})
}

/**
 * Short, single-line label for a task. Parallel workers get a long handoff appended to
 * their prompt; only the part the user cares about is shown.
 */
export function summarizeTaskTitle(text: string | undefined, max = 56): string {
	const raw = (text ?? "").split(/\n\s*\nYou are an independent parallel worker/)[0] ?? ""
	const line = raw
		.split("\n")
		.map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
		.find((part) => part.length > 0)
	if (!line) return "Starting task"
	const sentence = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line
	const chosen = sentence.length >= 8 ? sentence : line
	return chosen.length > max ? `${chosen.slice(0, max - 1).trimEnd()}…` : chosen
}

export interface TaskBoardRow {
	id: string
	title: string
	/** Short label shown in the tree; `title` keeps the full prompt for details. */
	summary: string
	mode: string
	profile?: string
	model: string
	status: string
	workspace: string
	workspaceUri: string
	updatedAt?: number
	todos: TodoItem[]
	parentTaskId?: string
	parallelWorker: boolean
	/** Restored from the persisted roster after a reload; no live task owns it yet. */
	recovered?: boolean
}

export const RECOVERED_STATUS = "not running"

export function rowFromRosterEntry(entry: RosterEntry): TaskBoardRow {
	return {
		id: entry.id,
		title: entry.title,
		summary: entry.summary,
		mode: entry.mode,
		model: "",
		status: RECOVERED_STATUS,
		workspace: entry.workspace,
		workspaceUri: entry.workspaceUri,
		updatedAt: entry.updatedAt,
		todos: entry.todos,
		parentTaskId: entry.parentTaskId,
		parallelWorker: entry.parallelWorker,
		recovered: true,
	}
}

/** Read task-local state across all chats in this extension host, without focusing any chat. */
export async function collectTaskBoard(): Promise<TaskBoardRow[]> {
	const rows = await Promise.all(
		ClineProvider.getAllInstances().map(async (provider) => {
			const task = provider.getCurrentTask()
			if (!task) return undefined
			const history = provider.taskHistoryStore.get(task.taskId)
			const last = task.clineMessages.at(-1)
			const waiting = last?.type === "ask" && !last.isAnswered && !last.partial
			const interrupted = waiting && (last.ask === "resume_task" || last.ask === "resume_completed_task")
			const fullTitle = (history?.task ?? task.clineMessages[0]?.text ?? "Starting task").slice(0, 2000)
			return {
				id: task.taskId,
				title: fullTitle,
				summary: summarizeTaskTitle(fullTitle),
				mode: await task.getTaskMode(),
				profile: await task.getTaskApiConfigName(),
				model: task.api.getModel().id,
				status:
					history?.status === "completed" || last?.say === "completion_result"
						? "completed"
						: task.abort || interrupted
							? "stopped"
							: task.userPaused
								? "paused"
								: waiting
									? "waiting for input"
									: task.isStreaming
										? "streaming"
										: "working",
				workspace: task.cwd,
				workspaceUri: workspaceUriFromCwd(task.cwd),
				updatedAt: last?.ts,
				todos: structuredClone(task.todoList ?? []),
				parentTaskId: task.parallelParentTaskId ?? task.parentTaskId,
				parallelWorker: task.parallelWorker,
			} satisfies TaskBoardRow
		}),
	)
	return rows.filter((row): row is NonNullable<typeof row> => row !== undefined)
}

type Node = { row: TaskBoardRow } | { text: string; status?: string; id: string; icon?: string }

type RowState = "running" | "paused" | "stopped" | "completed" | "recovered" | "recoveredWorker"

function stateOf(row: TaskBoardRow): RowState {
	if (row.recovered) return row.parallelWorker ? "recoveredWorker" : "recovered"
	if (row.status === "completed") return "completed"
	if (row.status === "paused") return "paused"
	if (row.status === "stopped") return "stopped"
	return "running"
}

function statusIcon(row: TaskBoardRow): string {
	switch (stateOf(row)) {
		case "completed":
			return "pass"
		case "paused":
			return "debug-pause"
		case "stopped":
			return "debug-stop"
		case "recovered":
		case "recoveredWorker":
			return "history"
		default:
			return row.status === "waiting for input" ? "bell" : "sync"
	}
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}\[\]()#+!|<>]/g, "\\$&")
}

/**
 * Registers the legacy Task Board tree view and its compat/debug commands.
 *
 * The Menagerie Task Observatory webview is the primary inspection surface.
 * This tree remains for backward compatibility and the on-disk snapshot writer
 * (`task-boards/<id>.json`). The 5-second polling loop, the
 * `onDidChangeSelection` focus-on-selection handler, and the `ViewColumn.Beside`
 * detail panel have been removed.
 */
export interface TaskBoardRecoveryDeps {
	outputChannel: vscode.OutputChannel
	/** Any provider whose history store can look up tasks from earlier sessions. */
	historyProvider: Pick<ClineProvider, "taskHistoryStore">
}

export function registerTaskBoard(context: vscode.ExtensionContext, recovery?: TaskBoardRecoveryDeps): void {
	const hostId = resolveHostId(context)
	// Tasks on the board when the window last closed. Kept per workspace so a reload can offer them again.
	let roster = parseRoster(context.workspaceState?.get(TASK_BOARD_ROSTER_KEY))
	let rosterReady: Promise<void> = Promise.resolve()
	const saveRoster = (next: RosterEntry[]) => {
		if (rostersEqual(roster, next)) return
		roster = next
		void context.workspaceState?.update(TASK_BOARD_ROSTER_KEY, next)
	}
	if (recovery) {
		const store = recovery.historyProvider.taskHistoryStore
		rosterReady = store.initialized.then(
			() => saveRoster(pruneOnActivation(roster, (id) => store.get(id)?.status ?? (store.get(id) ? "" : null))),
			() => {},
		)
	}
	const recovering = new Set<string>()
	const router = createTaskCommandRouter(context, hostId)
	const events = new vscode.EventEmitter<Node | undefined>()
	let rows: TaskBoardRow[] = []
	let refreshing = false
	let lastSignature = ""
	const boardId = crypto.randomUUID()
	const directory = path.join(context.globalStorageUri.fsPath, "task-boards")
	const snapshotPath = path.join(directory, `${boardId}.json`)
	const snapshot = async () => ({
		schemaVersion: 1,
		boardId,
		pid: process.pid,
		updatedAt: Date.now(),
		tasks: await collectTaskBoard(),
	})
	const refresh = async () => {
		if (refreshing) return
		refreshing = true
		try {
			await rosterReady
			const data = await snapshot()
			saveRoster(syncRoster(roster, data.tasks))
			const liveIds = new Set(data.tasks.map((task) => task.id))
			const boardRows = recovery
				? [...data.tasks, ...recoverableEntries(roster, liveIds).map(rowFromRosterEntry)]
				: data.tasks
			// Re-rendering the tree dismisses an open hover and resets expansion, so only
			// notify when something the tree displays actually changed.
			const signature = JSON.stringify(boardRows.map(({ updatedAt: _updatedAt, ...row }) => row))
			const changed = signature !== lastSignature
			lastSignature = signature
			rows = boardRows
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(snapshotPath + ".tmp", JSON.stringify(data, null, 2), { mode: 0o600 })
			await fs.rename(snapshotPath + ".tmp", snapshotPath)
			if (changed) events?.fire(undefined)
		} catch (error) {
			console.error("[TaskBoard] Refresh failed", error)
		} finally {
			refreshing = false
		}
	}
	const dataProvider: vscode.TreeDataProvider<Node> = {
		onDidChangeTreeData: events.event,
		getChildren: (node) => {
			if (!node) return rows.map((row) => ({ row }))
			if (!("row" in node)) return []
			const { row } = node
			const detail = (key: string, text: string, icon?: string): Node => ({
				id: `${row.id}:${key}`,
				text,
				icon,
			})
			return [
				detail("status", `Status: ${row.status}`, statusIcon(row)),
				detail("mode", `Mode: ${row.mode}`, "symbol-misc"),
				...(row.recovered
					? []
					: [detail("route", `Route: ${row.profile ?? "default"} · ${row.model}`, "server-process")]),
				detail("workspace", `Workspace: ${row.workspace}`, "folder"),
				detail("chat", `Chat ID: ${row.id}`, "comment-discussion"),
				...(row.parentTaskId ? [detail("parent", `Parent chat: ${row.parentTaskId}`, "type-hierarchy")] : []),
				detail("prompt", `Prompt: ${row.title.split("\n")[0]!.slice(0, 200)}`, "quote"),
				...(row.todos.length
					? row.todos.map((todo, index) => ({
							id: `${row.id}:todo:${index}`,
							text: todo.content,
							status: todo.status,
						}))
					: [
							detail(
								"no-todos",
								"No checklist yet — ask Menagerie to use update_todo_list.",
								"circle-slash",
							),
						]),
			]
		},
		getTreeItem: (node) => {
			if (!("row" in node)) {
				const item = new vscode.TreeItem(node.text)
				item.id = node.id
				item.iconPath = new vscode.ThemeIcon(
					node.icon ??
						(node.status === "completed"
							? "pass"
							: node.status === "in_progress"
								? "sync"
								: "circle-outline"),
				)
				return item
			}
			const row = node.row
			// Collapsed (not None) so clicking a task expands its details while also opening it.
			const item = new vscode.TreeItem(row.summary, vscode.TreeItemCollapsibleState.Collapsed)
			item.id = row.id
			item.contextValue = `menagerieTask.${stateOf(row)}`
			item.iconPath = new vscode.ThemeIcon(statusIcon(row))
			const completedTodos = row.todos.filter((todo) => todo.status === "completed").length
			// Progress sits on the right; the status is in the icon and tooltip.
			item.description = row.todos.length ? `${completedTodos}/${row.todos.length}` : row.status
			const tooltip = new vscode.MarkdownString(
				[
					`**${escapeMarkdown(row.summary)}**`,
					"",
					`${escapeMarkdown(row.mode)} · ${escapeMarkdown(row.status)}` +
						(row.todos.length ? ` · ${completedTodos}/${row.todos.length} steps` : ""),
					"",
					row.recovered
						? row.parallelWorker
							? "Not running in this window. Resume its parent task to continue it."
							: "Not running in this window (reloaded, replaced or closed). Click to reopen, or right-click to resume."
						: `${escapeMarkdown(row.profile ?? "default")} · ${escapeMarkdown(row.model)}`,
					"",
					row.recovered
						? "_Right-click for resume, restart or cancel (removes it from the board)._"
						: "_Click to open and expand. Right-click for restart, resume, pause or cancel._",
				].join("\n"),
			)
			tooltip.isTrusted = false
			item.tooltip = tooltip
			const command: TaskCommand = {
				kind: "open",
				ref: { hostId, workspaceUri: row.workspaceUri, taskId: row.id },
				destination: "task-hub",
			}
			item.command = { command: OPEN_TASK_COMMAND, title: "Open Task", arguments: [command] }
			return item
		},
	}
	const view = vscode.window.createTreeView(`${Package.name}.taskBoard`, {
		treeDataProvider: dataProvider,
		showCollapseAll: true,
	})
	context.subscriptions.push(view, events)
	// Write one initial snapshot. While the board is visible, refresh on a modest interval
	// so an open board stays current; stop polling when it is hidden. The Observatory uses
	// its own reconciliation, so the tree only needs to track the live task set when shown.
	let pollTimer: ReturnType<typeof setInterval> | undefined
	const stopPolling = () => {
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = undefined
		}
	}
	const startPolling = () => {
		if (pollTimer) return
		pollTimer = setInterval(() => void refresh(), 5000)
	}
	view.onDidChangeVisibility(
		(event) => {
			if (event.visible) {
				void refresh()
				startPolling()
			} else {
				stopPolling()
			}
		},
		undefined,
		context.subscriptions,
	)
	context.subscriptions.push(new vscode.Disposable(stopPolling))
	void refresh()
	if (view.visible) startPolling()
	void router.restoreLastSelection()
	/**
	 * Restore a roster task from history into a headless provider. The task comes back
	 * waiting at its resume prompt; `autoResume` answers it so work continues.
	 */
	const recoverTask = async (taskId: string, autoResume: boolean): Promise<ClineProvider | undefined> => {
		if (!recovery) return undefined
		const entry = roster.find((candidate) => candidate.id === taskId)
		if (!entry) return undefined
		if (entry.parallelWorker) {
			void vscode.window.showInformationMessage(
				"Parallel workers continue with their parent task. Resume the parent instead.",
			)
			return undefined
		}
		if (recovering.has(taskId)) return undefined
		const historyItem = recovery.historyProvider.taskHistoryStore.get(taskId)
		if (!historyItem) {
			saveRoster(removeEntry(roster, taskId))
			void vscode.window.showInformationMessage("That task's history is gone, so it was removed from the board.")
			await refresh()
			return undefined
		}
		recovering.add(taskId)
		const provider = await createHeadlessTaskProvider(context, recovery.outputChannel)
		try {
			await provider.createTaskWithHistoryItem(historyItem)
			if (autoResume) {
				const deadline = Date.now() + 15_000
				while (!provider.resumeCurrentTask() && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200))
				}
			}
			return provider
		} catch (error) {
			await provider.dispose()
			void vscode.window.showErrorMessage(
				`Could not recover task: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		} finally {
			recovering.delete(taskId)
			await refresh()
		}
	}
	const recoveredActions: RecoveredActions = {
		isRecovered: (taskId) => rows.some((row) => row.id === taskId && row.recovered),
		resume: async (taskId) => {
			await recoverTask(taskId, true)
		},
		restart: async (taskId) => {
			if (!recovery) return
			const entry = roster.find((candidate) => candidate.id === taskId)
			if (!entry || entry.parallelWorker) return
			saveRoster(removeEntry(roster, taskId))
			const provider = await createHeadlessTaskProvider(context, recovery.outputChannel)
			try {
				await provider.createTask(entry.title)
			} catch (error) {
				await provider.dispose()
				void vscode.window.showErrorMessage(
					`Could not restart task: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			await refresh()
		},
		dismiss: async (taskId) => {
			saveRoster(removeEntry(roster, taskId))
			await refresh()
		},
		markCancelled: (taskId) => saveRoster(markCancelled(roster, taskId)),
	}
	context.subscriptions.push(
		vscode.commands.registerCommand(`${Package.name}.getTaskBoard`, snapshot),
		vscode.commands.registerCommand(`${Package.name}.taskBoardShowDetails`, () => {
			// Compat/debug stub: the Menagerie Task Observatory webview is the primary
			// inspection surface. This command refreshes the on-disk snapshot only.
			void refresh()
		}),
		vscode.commands.registerCommand(`${Package.name}.showTaskBoard`, async () => {
			await refresh()
			await vscode.commands.executeCommand(`${Package.name}.taskBoard.focus`)
		}),
		vscode.commands.registerCommand(`${Package.name}.exportTaskBoard`, async () => {
			await refresh()
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(snapshotPath)))
		}),
		...registerTaskActionCommands(router, hostId, refresh, recoveredActions),
		vscode.commands.registerCommand(OPEN_TASK_COMMAND, async (command?: TaskCommand) => {
			if (!command || command.kind !== "open") return
			if (recoveredActions.isRecovered(command.ref.taskId)) {
				const provider = await recoverTask(command.ref.taskId, false)
				if (provider) await openTaskInNewTab(command.ref.taskId, { context })
				return
			}
			const result = await router.execute(command)
			if (!result.ok) {
				void vscode.window.showInformationMessage(
					result.foreignHost
						? `That task is running in another window (${result.workspaceUri ?? command.ref.taskId})`
						: result.error,
				)
			}
		}),
	)
}

type TaskActionKind = "resume" | "pause" | "restart" | "cancel"

interface RecoveredActions {
	isRecovered: (taskId: string) => boolean
	resume: (taskId: string) => Promise<void>
	restart: (taskId: string) => Promise<void>
	dismiss: (taskId: string) => Promise<void>
	markCancelled: (taskId: string) => void
}

/** Right-click actions on a Task Board row. Cancel and restart ask first; nothing else cancels a task. */
function registerTaskActionCommands(
	router: TaskCommandRouter,
	hostId: string,
	refresh: () => Promise<void>,
	recovered: RecoveredActions,
): vscode.Disposable[] {
	const run = async (kind: TaskActionKind, node?: Node) => {
		const row = node && "row" in node ? node.row : undefined
		if (!row) return
		const ref: TaskRef = { hostId, workspaceUri: row.workspaceUri, taskId: row.id }
		if (kind === "cancel" || kind === "restart") {
			const verb = kind === "cancel" ? "Cancel" : "Restart"
			const choice = await vscode.window.showWarningMessage(
				`${verb} "${row.summary}"?`,
				{
					modal: true,
					detail:
						kind === "restart"
							? "The task stops and starts again from its original prompt."
							: row.recovered
								? "It is removed from the board. Its history stays available."
								: "The task stops and will not be offered again after a reload.",
				},
				verb,
			)
			if (choice !== verb) return
		}
		if (row.recovered) {
			if (kind === "resume") await recovered.resume(row.id)
			else if (kind === "restart") await recovered.restart(row.id)
			else if (kind === "cancel") await recovered.dismiss(row.id)
			return
		}
		const command: TaskCommand =
			kind === "cancel" || kind === "restart" ? { kind, ref, confirmed: true } : { kind, ref }
		const result = await router.execute(command)
		if (!result.ok) void vscode.window.showInformationMessage(result.error)
		else if (kind === "cancel") recovered.markCancelled(row.id)
		// Restart starts a new task id; the old entry would otherwise linger as "not running".
		else if (kind === "restart") await recovered.dismiss(row.id)
		await refresh()
	}
	return (["resume", "pause", "restart", "cancel"] as const).map((kind) =>
		vscode.commands.registerCommand(`${Package.name}.taskBoard.${kind}`, (node?: Node) => run(kind, node)),
	)
}
