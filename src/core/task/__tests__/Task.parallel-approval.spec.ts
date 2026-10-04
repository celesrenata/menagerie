import { Mutex } from "async-mutex"
import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

describe("parallel read approval ownership", () => {
	it("keeps concurrent asks and status messages from consuming each other's responses", async () => {
		// Exercise real ask/say methods with their I/O boundaries stubbed.
		const task = Object.create(Task.prototype) as Task
		Object.assign(task, {
			abort: false,
			parallelToolBatch: true,
			toolUiMutex: new Mutex(),
			clineMessages: [],
			messageQueueService: new MessageQueueService(),
			providerRef: {
				deref: () => ({
					getState: async () => ({ autoApprovalEnabled: false }),
					postStateToWebview: vi.fn(),
					postMessageToWebview: vi.fn(),
				}),
			},
			saveClineMessages: vi.fn(),
			updateClineMessage: vi.fn(),
			cancelAutoApprovalTimeout: vi.fn(),
			emit: vi.fn(),
		})
		task["addToClineMessages"] = vi.fn(async (message) => {
			task.clineMessages.push(message)
		})
		const first = task.ask("tool", "Read A")
		const second = task.ask("tool", "Read B")
		const status = task.say("text", "Read status")
		await vi.waitFor(() => expect(task.clineMessages.map((message) => message.text)).toEqual(["Read A"]))
		task["askResponse"] = "yesButtonClicked"
		await expect(first).resolves.toMatchObject({ response: "yesButtonClicked" })
		await vi.waitFor(() => expect(task.clineMessages.map((message) => message.text)).toEqual(["Read A", "Read B"]))
		task["askResponse"] = "noButtonClicked"
		await expect(second).resolves.toMatchObject({ response: "noButtonClicked" })
		await status
		expect(task.clineMessages.map((message) => message.text)).toEqual(["Read A", "Read B", "Read status"])
		expect(task.didRejectTool).toBe(true)
		await expect(task.ask("tool", "Read C")).resolves.toEqual({ response: "noButtonClicked" })
		expect(task.clineMessages).toHaveLength(3)
	})
})
