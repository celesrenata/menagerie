import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { ClineMessage, TodoItem } from "@roo-code/types"
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

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}
		return entities[character] ?? character
	})
}

function getActivityLabel(message: ClineMessage): string {
	if (message.type === "ask") return `Zoo · ${message.ask ?? "request"}`
	if (message.say === "user_feedback" || message.say === "user_feedback_diff") return "You"
	return `Zoo · ${message.say ?? "update"}`
}

function renderTaskDetailsHtml(row: TaskBoardRow, messages: ClineMessage[]): string {
	const activity = messages
		.filter(
			(message) =>
				message.say !== "reasoning" &&
				(Boolean(message.text?.trim()) || Boolean(message.progressStatus?.text?.trim())),
		)
		.slice(-12)
		.map((message) => {
			const content = message.progressStatus?.text?.trim() || message.text?.trim() || ""
			const time = new Date(message.ts).toLocaleTimeString()
			return `<article><header><strong>${escapeHtml(getActivityLabel(message))}</strong><time>${escapeHtml(time)}</time></header><pre>${escapeHtml(content)}</pre></article>`
		})
		.join("")
	const todos = row.todos.length
		? row.todos
				.map((todo) => {
					const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"
					return `<li><span aria-hidden="true">${icon}</span> ${escapeHtml(todo.content)}</li>`
				})
				.join("")
		: "<li>No checklist recorded.</li>"
	const route = `${row.profile ?? "default"} · ${row.model}`
	const capturedAt = new Date().toLocaleString()
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${escapeHtml(row.title)}</title>
		<style>
			body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); padding: 20px; }
			main { max-width: 980px; margin: 0 auto; }
			h1 { font-size: 1.35em; margin: 0 0 8px; }
			.muted, time { color: var(--vscode-descriptionForeground); }
			.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 18px 0; }
			.card, article { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
			.card span { display: block; color: var(--vscode-descriptionForeground); font-size: .9em; margin-bottom: 4px; }
			section { margin-top: 24px; }
			h2 { font-size: 1.05em; }
			article { margin: 10px 0; }
			article header { display: flex; justify-content: space-between; gap: 16px; }
			pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 8px 0 0; }
			ul { padding-left: 22px; }
			li { margin: 8px 0; }
		</style>
	</head>
	<body>
		<main>
			<h1>${escapeHtml(row.title)}</h1>
			<p class="muted">Read-only snapshot captured ${escapeHtml(capturedAt)} · click the task again to refresh</p>
			<div class="grid">
				<div class="card"><span>Status</span>${escapeHtml(row.status)}</div>
				<div class="card"><span>Mode and route</span>${escapeHtml(row.mode)} · ${escapeHtml(route)}</div>
				<div class="card"><span>Workspace</span>${escapeHtml(row.workspace)}</div>
				<div class="card"><span>Chat ID</span>${escapeHtml(row.id)}</div>
				${row.parentTaskId ? `<div class="card"><span>Parent chat</span>${escapeHtml(row.parentTaskId)}</div>` : ""}
			</div>
			<section><h2>Recent activity</h2>${activity || '<p class="muted">No task messages yet.</p>'}</section>
			<section><h2>Checklist</h2><ul>${todos}</ul></section>
		</main>
	</body>
</html>`
}

export function registerTaskBoard(context: vscode.ExtensionContext): void {
	const events = new vscode.EventEmitter<Node | undefined>()
	let rows: TaskBoardRow[] = []
	let refreshing = false
	const detailPanels = new Map<string, vscode.WebviewPanel>()
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
	// Register immediately so expanding the contributed view works after a reload.
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
					: [{ text: "No checklist yet — ask Zoo to use update_todo_list." }]),
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
			// Keep task rows as leaves so VS Code runs their command on click.
			// Expandable rows only toggle their checklist children, which made
			// double-clicking appear to do nothing.
			const item = new vscode.TreeItem(row.title.split("\n")[0], vscode.TreeItemCollapsibleState.None)
			item.id = row.id
			const completedTodos = row.todos.filter((todo) => todo.status === "completed").length
			item.description = `${row.mode} · ${row.status} · ${completedTodos}/${row.todos.length}`
			item.tooltip = `${row.title}\nStatus: ${row.status}\nChecklist: ${completedTodos}/${row.todos.length} complete\nClick to open read-only task details.`
			item.command = {
				command: "zoo-code.taskBoardShowDetails",
				title: "Show read-only task details",
				arguments: [row.id],
			}
			return item
		},
	}
	const view = vscode.window.createTreeView("zoo-code.taskBoard", {
		treeDataProvider: dataProvider,
		showCollapseAll: true,
	})
	context.subscriptions.push(view, events)
	const timer = setInterval(() => {
		void refresh()
	}, 5_000)
	void refresh()
	const showTaskDetails = (id: string) => {
		const row = rows.find((candidate) => candidate.id === id)
		const task = ClineProvider.getAllInstances()
			.find((provider) => provider.getCurrentTask()?.taskId === id)
			?.getCurrentTask()
		if (!row || !task) return

		let panel = detailPanels.get(id)
		if (!panel) {
			panel = vscode.window.createWebviewPanel(
				"zoo-code.taskBoardTaskDetails",
				`Zoo Task · ${row.title.slice(0, 60)}`,
				vscode.ViewColumn.Beside,
				{ enableScripts: false, retainContextWhenHidden: true, enableFindWidget: true },
			)
			detailPanels.set(id, panel)
			panel.onDidDispose(() => {
				if (detailPanels.get(id) === panel) detailPanels.delete(id)
			})
		} else {
			panel.reveal(vscode.ViewColumn.Beside, true)
		}
		panel.webview.html = renderTaskDetailsHtml(row, task.clineMessages)
	}
	context.subscriptions.push(
		vscode.commands.registerCommand("zoo-code.getTaskBoard", snapshot),
		vscode.commands.registerCommand("zoo-code.taskBoardShowDetails", showTaskDetails),
		vscode.commands.registerCommand("zoo-code.showTaskBoard", async () => {
			await refresh()
			await vscode.commands.executeCommand("zoo-code.taskBoard.focus")
		}),
		vscode.commands.registerCommand("zoo-code.exportTaskBoard", async () => {
			await refresh()
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(snapshotPath)))
		}),
		{
			dispose: () => {
				if (timer) clearInterval(timer)
			},
		},
	)
	// Handle row selection too: some tree view activation gestures do not run
	// TreeItem.command reliably. Keep the command for repeat clicks on the
	// already-selected row.
	context.subscriptions.push(
		view.onDidChangeSelection(({ selection }) => {
			const selectedTask = selection.find((node) => "row" in node)
			if (selectedTask && "row" in selectedTask) showTaskDetails(selectedTask.row.id)
		}),
	)
}
