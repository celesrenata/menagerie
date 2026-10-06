import type { ObservedTaskStatus } from "@roo-code/types"

/**
 * Read-only task fields consumed by {@link deriveStatus}.
 *
 * This is a plain input interface deliberately decoupled from `Task`: `deriveStatus`
 * invokes no `Task` method and holds no reference to a `Task` instance, so it stays
 * pure and side-effect-free (see the Zero-Lifecycle-Side-Effect invariant). Each field
 * is a read-only snapshot of a single `Task`/history/manifest value.
 */
export interface DeriveStatusFields {
	readonly historyStatus?: string | undefined
	readonly lastMessageType?: "ask" | "say" | undefined
	readonly lastMessageSay?: string | undefined
	readonly lastMessageIsAnswered?: boolean | undefined
	readonly lastMessagePartial?: boolean | undefined
	readonly abort?: boolean | undefined
	readonly isStreaming?: boolean | undefined
	readonly isAdmittedWorker?: boolean | undefined
	readonly hasActivity?: boolean | undefined
	readonly parallelWorkerFailure?: string | undefined
	readonly workerFailureOutcome?: boolean | undefined
}

/**
 * Derives the observed task status from raw task fields, mirroring the precedence chain
 * of `collectTaskBoard()` exactly (completed → cancelled → waiting → streaming → working)
 * and extending it with `failed` (terminal failure markers) and `queued` (admitted worker
 * with no activity yet).
 *
 * The function is total, pure, and side-effect-free: it never throws, invokes no `Task`
 * method, and always resolves to exactly one value of the `ObservedTaskStatus` union.
 *
 * Precedence (top to bottom):
 * 1. failed    — terminal failure markers (`parallelWorkerFailure` or `workerFailureOutcome`)
 *                take precedence even over a recorded abort: a failed worker is terminal even
 *                if it was aborted.
 * 2. completed — recorded completion (`history.status === "completed"`) or a
 *                `completion_result` message.
 * 3. cancelled — task aborted without a recorded completion (completion already ruled out above).
 * 4. waiting   — an un-answered, non-partial `ask` message (waiting for user input).
 * 5. streaming — actively streaming a response.
 * 6. queued    — an admitted parallel worker that has not produced any activity yet.
 * 7. working   — everything else (the default).
 *
 * `failed` derives from the terminal failure markers per Requirements 2.3, 2.4, 2.5, 2.6
 * (Property 4).
 */
export function deriveStatus(fields: DeriveStatusFields): ObservedTaskStatus {
	const { parallelWorkerFailure, workerFailureOutcome } = fields

	// 1. failed: terminal failure markers take precedence over everything, including a
	// recorded abort (a failed worker is a terminal failure).
	if ((parallelWorkerFailure !== undefined && parallelWorkerFailure !== "") || workerFailureOutcome === true) {
		return "failed"
	}

	const { historyStatus, lastMessageSay, lastMessageType, lastMessageIsAnswered, lastMessagePartial } = fields

	// 2. completed: recorded completion or a completion_result message.
	if (historyStatus === "completed" || lastMessageSay === "completion_result") {
		return "completed"
	}

	// 3. cancelled: aborted without a recorded completion (ruled out by the completed branch above).
	if (fields.abort === true) {
		return "cancelled"
	}

	// 4. waiting: un-answered, non-partial ask message.
	if (lastMessageType === "ask" && lastMessageIsAnswered !== true && lastMessagePartial !== true) {
		return "waiting"
	}

	// 5. streaming: actively streaming a response.
	if (fields.isStreaming === true) {
		return "streaming"
	}

	// 6. queued: admitted worker with no activity yet.
	if (fields.isAdmittedWorker === true && fields.hasActivity !== true) {
		return "queued"
	}

	// 7. working: the default.
	return "working"
}
