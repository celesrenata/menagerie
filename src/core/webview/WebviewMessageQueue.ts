import type { ExtensionMessage } from "@roo-code/types"

/** Coalesce growing streaming text; enqueue control/final messages immediately in order. */
export class WebviewMessageQueue {
	private readonly partials = new Map<string, ExtensionMessage>()
	private timer?: ReturnType<typeof setTimeout>

	constructor(private readonly send: (message: ExtensionMessage) => void) {}

	post(message: ExtensionMessage, taskId?: string): void {
		const update = message.type === "messageUpdated" ? message.clineMessage : undefined
		const key = update ? `${taskId ?? ""}:${update.messageId ?? update.ts}` : undefined
		if (key && update?.partial === true) {
			this.partials.set(key, message)
			this.timer ??= setTimeout(() => this.flush(), 200)
			return
		}
		if (key) this.partials.delete(key)
		this.flush()
		this.send(message)
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		const messages = [...this.partials.values()]
		this.partials.clear()
		for (const message of messages) this.send(message)
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		this.partials.clear()
	}
}
