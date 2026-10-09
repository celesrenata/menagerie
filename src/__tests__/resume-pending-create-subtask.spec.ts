// npx vitest run __tests__/resume-pending-create-subtask.spec.ts
//
// Regression coverage for the `interrupted → delegated` fan-out loop (design Change 2).
// When a subtask is reopened from history, its rehydrated task could still carry a stale
// `create_subtask` pending action. Replaying it against a parent whose own persisted status
// is `interrupted`/`completed` drove `delegateParentAndOpenChild` → the reducer throw
// `interrupted → delegated` → rollback re-resume → the same action again, forever (one parent
// id, hundreds of generated child ids). These tests pin the short-circuit at the lowest layer
// that reproduces the bug: a `Task` double driving `resumePendingTaskAction` directly. The
// reducer model (check-task-lifecycle.ts) never generates an interrupted-parent delegate
// transition, so it could not have failed for this defect — the bug lives in the caller wiring.

import { describe, it, expect, vi } from "vitest"
import { Task } from "../core/task/Task"

type PendingCreateSubtask = {
	kind: "create_subtask"
	actionId: string
	approvalText: string
	mode: string
	message: string
	todos: unknown[]
}

const makePendingAction = (): PendingCreateSubtask => ({
	kind: "create_subtask",
	actionId: "stale-action",
	approvalText: "{}",
	mode: "code",
	message: "Do something",
	todos: [],
})

function makeTaskDouble(parentStatus: string | undefined) {
	const delegateParentAndOpenChild = vi.fn().mockResolvedValue({ taskId: "child-1" })
	const provider = {
		delegateParentAndOpenChild,
		taskHistoryStore: { get: vi.fn().mockReturnValue(parentStatus ? { status: parentStatus } : undefined) },
	}
	const task = Object.create(Task.prototype) as Task
	Object.assign(task as unknown as Record<string, unknown>, {
		taskId: "parent-1",
		providerRef: { deref: () => provider },
		pendingAction: undefined,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		clearPendingActionAfterDurableResult: vi.fn().mockResolvedValue(undefined),
		initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
		say: vi.fn().mockResolvedValue(undefined),
		persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
	})
	return { task, provider, delegateParentAndOpenChild }
}

describe("Task.resumePendingTaskAction() stale create_subtask short-circuit", () => {
	it.each([{ parentStatus: "interrupted" }, { parentStatus: "completed" }])(
		"clears the stale pending action and does NOT delegate when the parent is $parentStatus",
		async ({ parentStatus }) => {
			const { task, delegateParentAndOpenChild } = makeTaskDouble(parentStatus)
			const action = makePendingAction()

			await (Task.prototype as unknown as { resumePendingTaskAction: (a: unknown) => Promise<void> })
				.resumePendingTaskAction.call(task, action)

			expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
			expect(
				(task as unknown as { clearPendingActionAfterDurableResult: ReturnType<typeof vi.fn> })
					.clearPendingActionAfterDurableResult,
			).toHaveBeenCalledWith("stale-action")
			// Falls through to the normal resume path instead of looping into delegation.
			expect(
				(task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop,
			).toHaveBeenCalledTimes(1)
		},
	)

	it("delegates exactly once for an active parent and never re-enters resume", async () => {
		const { task, delegateParentAndOpenChild } = makeTaskDouble("active")
		const action = makePendingAction()

		await (Task.prototype as unknown as { resumePendingTaskAction: (a: unknown) => Promise<void> })
			.resumePendingTaskAction.call(task, action)

		// A single delegation attempt — the fan-out is gone.
		expect(delegateParentAndOpenChild).toHaveBeenCalledTimes(1)
		expect(delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			pendingActionId: "stale-action",
		})
	})

	it("surfaces a delegation failure once without re-entering resume (no retry loop)", async () => {
		const { task, delegateParentAndOpenChild } = makeTaskDouble("active")
		delegateParentAndOpenChild.mockRejectedValueOnce(
			new Error("Invalid task status transition: interrupted → delegated"),
		)
		const action = makePendingAction()

		await expect(
			(Task.prototype as unknown as { resumePendingTaskAction: (a: unknown) => Promise<void> })
				.resumePendingTaskAction.call(task, action),
		).rejects.toThrow(/interrupted → delegated/)

		// Invoked at most once: the thrown error is not caught-and-retried into resume.
		expect(delegateParentAndOpenChild).toHaveBeenCalledTimes(1)
	})
})
