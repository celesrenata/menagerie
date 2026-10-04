import type { ExtensionMessage } from "@roo-code/types"
import { WebviewMessageQueue } from "../WebviewMessageQueue"

const partial = (text: string, ts = 1): ExtensionMessage => ({
	type: "messageUpdated",
	clineMessage: { ts, type: "say", say: "text", text, partial: true },
})

describe("WebviewMessageQueue", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("collapses a token burst to the latest text without waiting for silence", async () => {
		const send = vi.fn()
		const queue = new WebviewMessageQueue(send)
		for (let index = 0; index < 1000; index++) queue.post(partial(String(index)), "task-a")
		expect(send).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(200)
		expect(send).toHaveBeenCalledExactlyOnceWith(partial("999"))
	})

	it("sends a final message immediately and never overwrites it with an older partial", async () => {
		const send = vi.fn()
		const queue = new WebviewMessageQueue(send)
		queue.post(partial("old"), "task-a")
		const final: ExtensionMessage = {
			type: "messageUpdated",
			clineMessage: { ...partial("done").clineMessage!, partial: false },
		}
		queue.post(final, "task-a")
		expect(send).toHaveBeenCalledExactlyOnceWith(final)
		await vi.advanceTimersByTimeAsync(500)
		expect(send).toHaveBeenCalledOnce()
	})

	it("flushes text before control messages and keeps task identities separate", () => {
		const send = vi.fn()
		const queue = new WebviewMessageQueue(send)
		queue.post(partial("first"), "task-a")
		queue.post(partial("second"), "task-b")
		const control: ExtensionMessage = { type: "action", action: "chatButtonClicked" }
		queue.post(control)
		expect(send.mock.calls.map(([message]) => message)).toEqual([partial("first"), partial("second"), control])
	})

	it("drops scheduled messages when a view is disposed", async () => {
		const send = vi.fn()
		const queue = new WebviewMessageQueue(send)
		queue.post(partial("old"))
		queue.dispose()
		await vi.advanceTimersByTimeAsync(500)
		expect(send).not.toHaveBeenCalled()
	})
})
