import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { TodoItem } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"

export interface TaskBoardRow {
	id: string
	title: string
	mode: string
	profile?: string
	model: string
	status: string
	workspace: string
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
			return {
				id: task.taskId,
				title: (history?.task ?? task.clineMessages[0]?.text ?? "Starting task").slice(0, 300),
				mode: await task.getTaskMode(),
				profile: await task.getTaskApiConfigName(),
				model: task.api.getModel().id,
				status:
					history?.status === "completed" || last?.say === "completion_result"
						? "completed"
						: task.abort
							? "stopped"
							: waiting
								? "waiting for input"
								: task.isStreaming
									? "streaming"
									: "working",
				workspace: task.cwd,
				updatedAt: last?.ts,
				todos: structuredClone(task.todoList ?? []),
				parentTaskId: task.parallelParentTaskId ?? task.parentTaskId,
				parallelWorker: task.parallelWorker,
			} satisfies TaskBoardRow
		}),
	)
	return rows.filter((row): row is NonNullable<typeof row> => row !== undefined)
}

type Node = { row: TaskBoardRow } | { text: string; status?: string }

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
	const events = new vscode.EventEmitter<Node | undefined>()
	let rows: TaskBoardRow[] = []
	let refreshing = false
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
			rows = data.tasks
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(snapshotPath + ".tmp", JSON.stringify(data, null, 2), { mode: 0o600 })
			await fs.rename(snapshotPath + ".tmp", snapshotPath)
			events?.fire(undefined)
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
			return [
				{ text: `Route: ${node.row.profile ?? "default"} · ${node.row.model}` },
				{ text: `Workspace: ${node.row.workspace}` },
				{ text: `Chat ID: ${node.row.id}` },
				...(node.row.parentTaskId ? [{ text: `Parent chat: ${node.row.parentTaskId}` }] : []),
				...(node.row.todos.length
					? node.row.todos.map((todo) => ({ text: todo.content, status: todo.status }))
					: [{ text: "No checklist yet — ask Menagerie to use update_todo_list." }]),
			]
		},
		getTreeItem: (node) => {
			if (!("row" in node)) {
				const item = new vscode.TreeItem(node.text)
				item.iconPath = new vscode.ThemeIcon(
					node.status === "completed" ? "pass" : node.status === "in_progress" ? "sync" : "circle-outline",
				)
				return item
			}
			const row = node.row
			const item = new vscode.TreeItem(row.title.split("\n")[0], vscode.TreeItemCollapsibleState.None)
			item.id = row.id
			const completedTodos = row.todos.filter((todo) => todo.status === "completed").length
			item.description = `${row.mode} · ${row.status} · ${completedTodos}/${row.todos.length}`
			item.tooltip = `${row.title}\nStatus: ${row.status}\nChecklist: ${completedTodos}/${row.todos.length} complete\nInspect tasks in the Menagerie Task Observatory.`
			return item
		},
	}
	const view = vscode.window.createTreeView("zoo-code.taskBoard", {
		treeDataProvider: dataProvider,
		showCollapseAll: true,
	})
	context.subscriptions.push(view, events)
	// Write one initial snapshot; no periodic polling — the Observatory uses its own reconciliation.
	void refresh()
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
	)
}
