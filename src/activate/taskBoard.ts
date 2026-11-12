import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { TodoItem } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { openTaskInNewTab } from "./registerCommands"
import { HOST_ID_KEY, LAST_SELECTED_TASK_ID_KEY, TaskCommandRouter, type TaskOwnerHandle } from "./taskCommandRouter"
import type { TaskCommand, TaskRef } from "../core/task/session/types"

const OPEN_TASK_COMMAND = "zoo-code.openTask"

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
			vscode.workspace.getConfiguration("zoo-code").get<boolean>("rememberTaskNavigation") !== false,
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

function stateOf(row: TaskBoardRow): "running" | "paused" | "stopped" | "completed" {
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
export function registerTaskBoard(context: vscode.ExtensionContext): void {
	const hostId = resolveHostId(context)
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
			const data = await snapshot()
			// Re-rendering the tree dismisses an open hover and resets expansion, so only
			// notify when something the tree displays actually changed.
			const signature = JSON.stringify(data.tasks.map(({ updatedAt: _updatedAt, ...row }) => row))
			const changed = signature !== lastSignature
			lastSignature = signature
			rows = data.tasks
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
				detail("route", `Route: ${row.profile ?? "default"} · ${row.model}`, "server-process"),
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
					`${escapeMarkdown(row.profile ?? "default")} · ${escapeMarkdown(row.model)}`,
					"",
					"_Click to open and expand. Right-click for restart, resume, pause or cancel._",
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
	const view = vscode.window.createTreeView("zoo-code.taskBoard", {
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
	context.subscriptions.push(
		vscode.commands.registerCommand("zoo-code.getTaskBoard", snapshot),
		vscode.commands.registerCommand("zoo-code.taskBoardShowDetails", () => {
			// Compat/debug stub: the Menagerie Task Observatory webview is the primary
			// inspection surface. This command refreshes the on-disk snapshot only.
			void refresh()
		}),
		vscode.commands.registerCommand("zoo-code.showTaskBoard", async () => {
			await refresh()
			await vscode.commands.executeCommand("zoo-code.taskBoard.focus")
		}),
		vscode.commands.registerCommand("zoo-code.exportTaskBoard", async () => {
			await refresh()
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(snapshotPath)))
		}),
		...registerTaskActionCommands(router, hostId, refresh),
		vscode.commands.registerCommand(OPEN_TASK_COMMAND, async (command?: TaskCommand) => {
			if (!command || command.kind !== "open") return
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

/** Right-click actions on a Task Board row. Cancel and restart ask first; nothing else cancels a task. */
function registerTaskActionCommands(
	router: TaskCommandRouter,
	hostId: string,
	refresh: () => Promise<void>,
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
						kind === "cancel"
							? "The task stops. You can resume it later."
							: "The task stops and starts again from its original prompt.",
				},
				verb,
			)
			if (choice !== verb) return
		}
		const command: TaskCommand =
			kind === "cancel" || kind === "restart" ? { kind, ref, confirmed: true } : { kind, ref }
		const result = await router.execute(command)
		if (!result.ok) void vscode.window.showInformationMessage(result.error)
		await refresh()
	}
	return (["resume", "pause", "restart", "cancel"] as const).map((kind) =>
		vscode.commands.registerCommand(`zoo-code.taskBoard.${kind}`, (node?: Node) => run(kind, node)),
	)
}
