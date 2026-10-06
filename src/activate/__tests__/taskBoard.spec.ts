import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import { collectTaskBoard, registerTaskBoard } from "../taskBoard"

const mockProviders = vi.hoisted(() => ({
	all: [] as unknown[],
	commandHandlers: new Map<string, (...args: string[]) => unknown>(),
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
		})),
		showTextDocument: vi.fn(),
	},
	workspace: {
		openTextDocument: vi.fn(),
	},
	commands: {
		registerCommand: vi.fn((command: string, handler: (...args: string[]) => unknown) => {
			mockProviders.commandHandlers.set(command, handler)
			return { dispose: vi.fn() }
		}),
		executeCommand: vi.fn(),
	},
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

	it("provides the contributed view and writes one initial snapshot without polling", async () => {
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
		// No 5-second polling: advancing 10 seconds should NOT trigger a second snapshot
		await vi.advanceTimersByTimeAsync(10_000)
		expect(fs.rename).toHaveBeenCalledTimes(1)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		for (const subscription of subscriptions) subscription.dispose()
	})

	it("retains the four compat/debug commands and tree item has no command property", async () => {
		vi.useFakeTimers()
		const task = {
			taskId: "active-task",
			clineMessages: [
				{ ts: 1_000, type: "say", say: "text", text: "Implement the requested feature" },
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
		mockProviders.all = [
			{
				getCurrentTask: vi.fn(() => task),
				taskHistoryStore: { get: () => ({ task: "Task title", status: "active" }) },
			},
		]
		const subscriptions: { dispose(): unknown }[] = []
		const context = {
			subscriptions,
			globalStorageUri: { fsPath: "/mock/zoo" },
		} as unknown as vscode.ExtensionContext

		registerTaskBoard(context)
		await vi.advanceTimersByTimeAsync(0)

		// All four compat commands should be registered
		expect(mockProviders.commandHandlers.has("zoo-code.getTaskBoard")).toBe(true)
		expect(mockProviders.commandHandlers.has("zoo-code.taskBoardShowDetails")).toBe(true)
		expect(mockProviders.commandHandlers.has("zoo-code.showTaskBoard")).toBe(true)
		expect(mockProviders.commandHandlers.has("zoo-code.exportTaskBoard")).toBe(true)

		// Tree item should NOT have a command property (no focus-on-selection)
		const treeViewCall = vi.mocked(vscode.window.createTreeView).mock.calls[0]
		if (!treeViewCall) throw new Error("Task Board view was not created")
		const children = await treeViewCall[1].treeDataProvider.getChildren()
		const firstTask = children?.[0]
		if (!firstTask) throw new Error("Active task was not added to the Task Board")
		const item = await Promise.resolve(treeViewCall[1].treeDataProvider.getTreeItem(firstTask))
		expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None)
		expect(item.command).toBeUndefined()
		expect(item.tooltip).toContain("Menagerie Task Observatory")

		for (const subscription of subscriptions) subscription.dispose()
	})
})
