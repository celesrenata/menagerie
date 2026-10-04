import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import { collectTaskBoard, registerTaskBoard } from "../taskBoard"

const mockProviders = vi.hoisted(() => ({
	all: [] as unknown[],
	commandHandlers: new Map<string, (...args: string[]) => unknown>(),
	selectionHandlers: [] as ((event: { selection: unknown[] }) => void)[],
	detailPanels: [] as {
		title: string
		webview: { html: string }
		reveal: (...args: unknown[]) => void
		onDidDispose: (listener: () => void) => void
	}[],
}))

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	window: {
		createTreeView: vi.fn(() => ({
			dispose: vi.fn(),
		onDidChangeSelection: (listener: (event: { selection: unknown[] }) => void) => {
			mockProviders.selectionHandlers.push(listener)
			return { dispose: vi.fn() }
		},
	})),
		createWebviewPanel: vi.fn(() => {
			const panel = {
				title: "",
				webview: { html: "" },
				reveal: vi.fn(),
				onDidDispose: vi.fn(),
			}
			mockProviders.detailPanels.push(panel)
			return panel
		}),
	},
	commands: {
		registerCommand: vi.fn((command: string, handler: (...args: string[]) => unknown) => {
			mockProviders.commandHandlers.set(command, handler)
			return { dispose: vi.fn() }
		}),
		executeCommand: vi.fn(),
	},
	ViewColumn: { Beside: -2 },
	TreeItemCollapsibleState: { None: 0, Expanded: 2 },
	TreeItem: class {
		label: string
		collapsibleState: number
		constructor(label: string, collapsibleState: number) {
			this.label = label
			this.collapsibleState = collapsibleState
		}
	},
	ThemeIcon: class {},
}))
vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
}))
vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { getAllInstances: () => mockProviders.all },
}))

describe("Task Board registration", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		mockProviders.all = []
		mockProviders.commandHandlers.clear()
		mockProviders.selectionHandlers = []
		mockProviders.detailPanels = []
	})

	it("shows a completed child as completed even when its history status is stale", async () => {
		mockProviders.all = [
			{
				getCurrentTask: () => ({
					taskId: "child",
					clineMessages: [
						{ ts: 1, type: "say", say: "text", text: "Work" },
						{ ts: 2, type: "say", say: "completion_result", text: "Done" },
					],
					getTaskMode: async () => "code",
					getTaskApiConfigName: async () => "local-code",
					api: { getModel: () => ({ id: "model" }) },
					cwd: "/repo",
					todoList: [],
					parallelWorker: false,
				}),
				taskHistoryStore: { get: () => ({ task: "Child task", status: "interrupted" }) },
			},
		]
		const rows = await collectTaskBoard()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.status).toBe("completed")
	})

	it("provides the contributed view and snapshots on activation without stealing focus", async () => {
		vi.useFakeTimers()
		const subscriptions: { dispose(): unknown }[] = []
		const context = {
			subscriptions,
			globalStorageUri: { fsPath: "/mock/zoo" },
		} as unknown as vscode.ExtensionContext

		registerTaskBoard(context)
		expect(vscode.window.createTreeView).toHaveBeenCalledWith(
			"zoo-code.taskBoard",
			expect.objectContaining({ treeDataProvider: expect.any(Object) }),
		)
		await vi.advanceTimersByTimeAsync(0)
		expect(fs.rename).toHaveBeenCalledTimes(1)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(fs.rename).toHaveBeenCalledTimes(2)
		for (const subscription of subscriptions) subscription.dispose()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("opens the clicked active task as a read-only snapshot without switching or mutating it", async () => {
		vi.useFakeTimers()
		const task = {
			taskId: "active-task",
			clineMessages: [
				{ ts: 1_000, type: "say", say: "text", text: "Implement the requested feature" },
				{ ts: 2_000, type: "say", say: "reasoning", text: "private reasoning text" },
				{ ts: 3_000, type: "say", say: "tool", text: "Reading the task source" },
			],
			getTaskMode: async () => "code",
			getTaskApiConfigName: async () => "hybrid/code",
			api: { getModel: () => ({ id: "model" }) },
			cwd: "/repo",
			todoList: [{ content: "Inspect the task source", status: "in_progress" }],
			parallelWorker: true,
			isStreaming: true,
			abort: false,
		}
		const provider = {
			getCurrentTask: vi.fn(() => task),
			taskHistoryStore: { get: () => ({ task: "Inspect Task Board popup", status: "active" }) },
			revealChat: vi.fn(),
		}
		mockProviders.all = [provider]
		const subscriptions: { dispose(): unknown }[] = []
		const context = {
			subscriptions,
			globalStorageUri: { fsPath: "/mock/zoo" },
		} as unknown as vscode.ExtensionContext

		registerTaskBoard(context)
		await vi.advanceTimersByTimeAsync(0)

		const treeViewCall = vi.mocked(vscode.window.createTreeView).mock.calls[0]
		if (!treeViewCall) throw new Error("Task Board view was not created")
		const children = await treeViewCall[1].treeDataProvider.getChildren()
		const firstTask = children?.[0]
		if (!firstTask) throw new Error("Active task was not added to the Task Board")
		const item = await Promise.resolve(treeViewCall[1].treeDataProvider.getTreeItem(firstTask))
		expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None)
		expect(item.command).toEqual(
			expect.objectContaining({ command: "zoo-code.taskBoardShowDetails", arguments: ["active-task"] }),
		)
		expect(item.tooltip).toContain("Checklist: 0/1 complete")

		const selectionHandler = mockProviders.selectionHandlers[0]
		if (!selectionHandler) throw new Error("Task Board selection handler was not registered")
		selectionHandler({ selection: [firstTask] })
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)

		const showDetails = mockProviders.commandHandlers.get("zoo-code.taskBoardShowDetails")
		if (!showDetails) throw new Error("Task details command was not registered")
		showDetails("active-task")

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"zoo-code.taskBoardTaskDetails",
			expect.any(String),
			vscode.ViewColumn.Beside,
			expect.objectContaining({ enableScripts: false }),
		)
		const html = mockProviders.detailPanels[0]?.webview.html ?? ""
		expect(html).toContain("Inspect Task Board popup")
		expect(html).toContain("Reading the task source")
		expect(html).toContain("Inspect the task source")
		expect(html).not.toContain("private reasoning text")
		expect(provider.revealChat).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(mockProviders.commandHandlers.has("zoo-code.taskBoardFocusChat")).toBe(false)
		for (const subscription of subscriptions) subscription.dispose()
	})
})
