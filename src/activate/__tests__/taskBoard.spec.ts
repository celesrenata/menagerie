import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import { collectTaskBoard, registerTaskBoard, summarizeTaskTitle, type TaskBoardRecoveryDeps } from "../taskBoard"

const mockProviders = vi.hoisted(() => ({
	all: [] as unknown[],
	commandHandlers: new Map<string, (...args: string[]) => unknown>(),
	visibilityHandlers: [] as ((event: { visible: boolean }) => unknown)[],
}))

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	Disposable: class {
		dispose: () => unknown
		constructor(callOnDispose: () => unknown) {
			this.dispose = callOnDispose
		}
	},
	window: {
		createTreeView: vi.fn(() => ({
			visible: true,
			onDidChangeVisibility: vi.fn((handler: (event: { visible: boolean }) => unknown) => {
				mockProviders.visibilityHandlers.push(handler)
				return { dispose: vi.fn() }
			}),
			dispose: vi.fn(),
		})),
		showTextDocument: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		openTextDocument: vi.fn(),
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })),
	},
	Uri: {
		file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
	},
	commands: {
		registerCommand: vi.fn((command: string, handler: (...args: string[]) => unknown) => {
			mockProviders.commandHandlers.set(command, handler)
			return { dispose: vi.fn() }
		}),
		executeCommand: vi.fn(),
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	MarkdownString: class {
		isTrusted = false
		constructor(public value: string) {}
	},
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
vi.mock("../registerCommands", () => ({
	openTaskInNewTab: vi.fn(),
	createHeadlessTaskProvider: vi.fn(),
}))

describe("Task Board registration", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		mockProviders.all = []
		mockProviders.commandHandlers.clear()
		mockProviders.visibilityHandlers = []
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

	it("returns one row per provider and keeps a popout task after its view detaches", async () => {
		const makeTaskStub = (id: string, parallelWorker: boolean) => ({
			taskId: id,
			clineMessages: [{ ts: 1, type: "say", say: "text", text: `Task ${id}` }],
			getTaskMode: async () => "code",
			getTaskApiConfigName: async () => "local-code",
			api: { getModel: () => ({ id: "model" }) },
			cwd: "/repo",
			todoList: [],
			parallelWorker,
			isStreaming: true,
			abort: false,
		})
		const providerFor = (task: ReturnType<typeof makeTaskStub>) => ({
			getCurrentTask: () => task,
			taskHistoryStore: { get: () => ({ task: `History ${task.taskId}`, status: "active" }) },
		})

		const popoutA = makeTaskStub("popout-A", false)
		const popoutB = makeTaskStub("popout-B", false)
		const worker = makeTaskStub("worker-1", true)

		// Sidebar provider owns no task (returns undefined) + two popouts + one worker.
		mockProviders.all = [
			{ getCurrentTask: () => undefined, taskHistoryStore: { get: () => undefined } },
			providerFor(popoutA),
			providerFor(popoutB),
			providerFor(worker),
		]

		const before = await collectTaskBoard()
		// Three task-owning providers → three rows (the sidebar provider contributes none).
		expect(before.map((row) => row.id).sort()).toEqual(["popout-A", "popout-B", "worker-1"])
		const popoutARowBefore = before.find((row) => row.id === "popout-A")
		expect(popoutARowBefore?.status).toBe("streaming")

		// Detaching popoutA's view does NOT remove its owning provider from activeInstances, and
		// the provider still enumerates the (still-running) task. Modeled here by the provider
		// staying in the list and still returning the task.
		const after = await collectTaskBoard()
		const popoutARowAfter = after.find((row) => row.id === "popout-A")
		expect(after.map((row) => row.id).sort()).toEqual(["popout-A", "popout-B", "worker-1"])
		expect(popoutARowAfter).toBeDefined()
		expect(popoutARowAfter?.status).toBe(popoutARowBefore?.status)
	})

	it("provides the contributed view, writes an initial snapshot, and polls only while visible", async () => {
		vi.useFakeTimers()
		const subscriptions: { dispose(): unknown }[] = []
		const context = {
			subscriptions,
			globalStorageUri: { fsPath: "/mock/zoo" },
			globalState: { get: vi.fn(() => "host-test"), update: vi.fn() },
		} as unknown as vscode.ExtensionContext

		registerTaskBoard(context)
		expect(vscode.window.createTreeView).toHaveBeenCalledWith(
			"menagerie.taskBoard",
			expect.objectContaining({ treeDataProvider: expect.any(Object) }),
		)
		await vi.advanceTimersByTimeAsync(0)
		expect(fs.rename).toHaveBeenCalledTimes(1)
		// Visible on activation, so the board polls every 5 seconds to stay current.
		await vi.advanceTimersByTimeAsync(5_000)
		expect(fs.rename).toHaveBeenCalledTimes(2)

		// Hiding the board stops polling.
		for (const handler of mockProviders.visibilityHandlers) await handler({ visible: false })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(fs.rename).toHaveBeenCalledTimes(2)

		// Re-showing the board refreshes immediately and resumes polling.
		for (const handler of mockProviders.visibilityHandlers) await handler({ visible: true })
		await vi.advanceTimersByTimeAsync(0)
		expect(fs.rename).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(fs.rename).toHaveBeenCalledTimes(4)

		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		for (const subscription of subscriptions) subscription.dispose()
	})

	it("retains compat commands and wires click-to-open by TaskRef", async () => {
		vi.useFakeTimers()
		const task = {
			taskId: "active-task",
			clineMessages: [{ ts: 1_000, type: "say", say: "text", text: "Implement the requested feature" }],
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
		const persist = vi.fn()
		const context = {
			subscriptions,
			globalStorageUri: { fsPath: "/mock/zoo" },
			globalState: { get: vi.fn(() => "host-test"), update: persist },
		} as unknown as vscode.ExtensionContext

		registerTaskBoard(context)
		await vi.advanceTimersByTimeAsync(0)

		expect(mockProviders.commandHandlers.has("menagerie.getTaskBoard")).toBe(true)
		expect(mockProviders.commandHandlers.has("menagerie.taskBoardShowDetails")).toBe(true)
		expect(mockProviders.commandHandlers.has("menagerie.showTaskBoard")).toBe(true)
		expect(mockProviders.commandHandlers.has("menagerie.exportTaskBoard")).toBe(true)
		expect(mockProviders.commandHandlers.has("menagerie.openTask")).toBe(true)

		const treeViewCall = vi.mocked(vscode.window.createTreeView).mock.calls[0]
		if (!treeViewCall) throw new Error("Task Board view was not created")
		const children = await treeViewCall[1].treeDataProvider.getChildren()
		const firstTask = children?.[0]
		if (!firstTask) throw new Error("Active task was not added to the Task Board")
		const item = await Promise.resolve(treeViewCall[1].treeDataProvider.getTreeItem(firstTask))
		expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed)
		expect(item.command).toEqual({
			command: "menagerie.openTask",
			title: "Open Task",
			arguments: [
				{
					kind: "open",
					ref: { hostId: "host-test", workspaceUri: "file:///repo", taskId: "active-task" },
					destination: "task-hub",
				},
			],
		})
		const tooltip = item.tooltip
		expect(typeof tooltip === "string" ? tooltip : tooltip?.value).toContain("Click to open")

		const revealChat = vi.fn()
		const postMessageToWebview = vi.fn()
		const createTask = vi.fn()
		const evictCurrentTask = vi.fn()
		mockProviders.all = [
			{
				getCurrentTask: vi.fn(() => task),
				taskHistoryStore: { get: () => ({ task: "Task title", status: "active" }) },
				hasView: true,
				revealChat,
				postMessageToWebview,
				createTask,
				evictCurrentTask,
			},
		]
		const taskIdArg = item.command?.arguments?.[0]
		await mockProviders.commandHandlers.get("menagerie.openTask")?.(taskIdArg)
		expect(revealChat).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
		expect(createTask).not.toHaveBeenCalled()
		expect(evictCurrentTask).not.toHaveBeenCalled()
		expect(persist).toHaveBeenCalledWith("menagerie.lastSelectedTaskId", "active-task")

		for (const subscription of subscriptions) subscription.dispose()
	})
})

describe("summarizeTaskTitle", () => {
	it("drops the parallel-worker handoff and keeps the first sentence", () => {
		const text =
			"Review the auth module. Then list findings.\n\nYou are an independent parallel worker for task abc. Work only in /x"
		expect(summarizeTaskTitle(text)).toBe("Review the auth module.")
	})

	it("truncates long single-line prompts to one short line", () => {
		const summary = summarizeTaskTitle("word ".repeat(80))
		expect(summary.length).toBeLessThanOrEqual(56)
		expect(summary.endsWith("…")).toBe(true)
	})

	it("falls back when there is no text", () => {
		expect(summarizeTaskTitle("  \n ")).toBe("Starting task")
	})
})

describe("Task Board recovery after reload", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockProviders.commandHandlers.clear()
		vi.mocked(vscode.window.createTreeView).mockClear()
	})
	afterEach(() => vi.useRealTimers())

	it("lists roster tasks with no live owner and rehydrates one on resume", async () => {
		mockProviders.all = []
		const rosterEntry = {
			id: "lost-task",
			title: "Fix the build. Then report.",
			summary: "Fix the build.",
			mode: "code",
			workspace: "/repo",
			workspaceUri: "file:///repo",
			parallelWorker: false,
			todos: [],
			updatedAt: 10,
		}
		const workspaceState = new Map<string, unknown>([["menagerie.taskBoard.roster.v1", [rosterEntry]]])
		const historyItem = { id: "lost-task", task: rosterEntry.title, status: "active" }
		const context = {
			subscriptions: [] as { dispose(): unknown }[],
			globalStorageUri: { fsPath: "/mock/zoo" },
			globalState: { get: vi.fn(() => "host-test"), update: vi.fn() },
			workspaceState: {
				get: (key: string) => workspaceState.get(key),
				update: vi.fn((key: string, value: unknown) => workspaceState.set(key, value)),
			},
		} as unknown as vscode.ExtensionContext
		const historyProvider = {
			taskHistoryStore: {
				initialized: Promise.resolve(),
				get: (id: string) => (id === "lost-task" ? historyItem : undefined),
			},
		} as unknown as TaskBoardRecoveryDeps["historyProvider"]
		const headless = {
			createTaskWithHistoryItem: vi.fn(),
			resumeCurrentTask: vi.fn(() => true),
			dispose: vi.fn(),
		}
		const { createHeadlessTaskProvider } = await import("../registerCommands")
		vi.mocked(createHeadlessTaskProvider).mockResolvedValue(headless as never)

		registerTaskBoard(context, { outputChannel: {} as vscode.OutputChannel, historyProvider })
		await vi.advanceTimersByTimeAsync(0)

		const treeViewCall = vi.mocked(vscode.window.createTreeView).mock.calls[0]
		if (!treeViewCall) throw new Error("Task Board view was not created")
		const children = (await treeViewCall[1].treeDataProvider.getChildren()) as
			| { row?: { recovered?: boolean } }[]
			| undefined
		const recovered = children?.[0]
		if (!recovered?.row) throw new Error("Recovered task was not listed")
		expect(recovered.row.recovered).toBe(true)
		const item = await Promise.resolve(treeViewCall[1].treeDataProvider.getTreeItem(recovered))
		expect(item.contextValue).toBe("menagerieTask.recovered")

		await mockProviders.commandHandlers.get("menagerie.taskBoard.resume")?.(recovered as never)
		expect(headless.createTaskWithHistoryItem).toHaveBeenCalledWith(historyItem)
		expect(headless.resumeCurrentTask).toHaveBeenCalled()

		for (const subscription of context.subscriptions) subscription.dispose()
	})
})
