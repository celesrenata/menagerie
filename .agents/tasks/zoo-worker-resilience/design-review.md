# Design review (round 3): Zoo parallel-worker resilience

Reviewed: `.agents/tasks/zoo-worker-resilience/design.md` (revision with "Review responses, round 2") against the source on `feat/omniroute-tier-dropdown-feat005` (HEAD `5cf33f0a9`).

Verdict: **CHANGES_REQUESTED** (0 HIGH, 1 MEDIUM, 4 NIT)

All 6 round-2 findings are addressed, and I re-checked each fix against the code. The worker completion race is closed by the child's own `TaskCompleted` listener (`emitPublicTaskCompleted` emits synchronously at AttemptCompletionTool.ts:335, and the worker path at :221–223 reaches it). The in-loop abort label, the empty-assistant pop ordering, the WriteToFileTool test wording, the dead-task backstop guard, and the B2 placement are all specified and tested.

One gap is left. The design claims every indefinite wait on a worker's request path is closed (A5 and "Out of scope"), but the auto-condense LLM stream that `attemptApiRequest` runs before each request has no timeout and no abort signal.

## Findings

### 1. MEDIUM: The auto-condense stream inside `attemptApiRequest` can still hang a worker forever (A3/A5)

`attemptApiRequest` calls `manageContext(...)` (Task.ts ~4909) before it creates the request's `AbortController` (~5070). The same call happens in `handleContextWindowExceededError` (~4648). When auto-condense triggers, `manageContext` calls `summarizeConversation` (context-management/index.ts ~361). That function runs `for await (const chunk of apiHandler.createMessage(...))` (condense/index.ts ~382–384) with no timer. Its `summaryMetadata` also has no `abortSignal`, so even the new OpenAI signal wiring won't apply to it.

This wait happens inside the outer `nextChunk(0)` call, and that call is deliberately exempt from timers. It also happens before the first-chunk timer starts. A stalled summarizer stream (the same OmniRoute/backend stall class this design targets) therefore pins the worker, and with it the parent's `Promise.all`, indefinitely. Several statements don't hold as written:

- A5 has no row for this path.
- The backlog line "A1–A4 close every observed and identified indefinite wait" is not true.
- The A3 error table doesn't cover it.

Fix: pick one. I recommend (a), because it is about 15 lines and reuses the new module. The existing catch already falls back to sliding-window truncation (context-management/index.ts ~374–386).

(a) Bound the condense stream in `summarizeConversation`:

```ts
const condenseController = new AbortController()
const stream = apiHandler.createMessage(
	promptToUse,
	requestMessages,
	summaryMetadata && { ...summaryMetadata, abortSignal: condenseController.signal },
)
const it = stream[Symbol.asyncIterator]()
let phase: StreamWaitPhase = "first_chunk"
try {
	for (;;) {
		const timeoutMs = phase === "first_chunk" ? getApiRequestTimeout() : getApiStreamIdleTimeout()
		const r = await awaitWithStreamTimeout(it.next(), { timeoutMs, phase }).catch((e) => {
			if (e instanceof StreamIdleTimeoutError) {
				condenseController.abort(e)
				void it.return?.(undefined)?.catch(() => {})
			}
			throw e
		})
		if (r.done) break
		phase = "between_chunks"
		/* existing chunk handling */
	}
} catch (error) {
	/* existing catch → result.error → truncation fallback */
}
```

Add `src/core/condense/index.ts` to "Files changed". Add an A5 row: "Auto-condense stream stalls → timeout → condense error → sliding-window truncation → request proceeds". Add a test in the condense spec: a summarizer generator that yields one chunk and then never resolves gives `result.error` after the idle timeout (fake timers), and the handler's `abortSignal` is aborted.

(b) Keep it out of scope. Add an A5 row stating that this path is still unbounded, remove the "close every … indefinite wait" claim, and add a backlog item.

### 2. NIT: `failWorkerIfRetriesExhausted` counts cancellations as API failures (A4)

In the first-chunk catch, the helper runs for every non-context-window error. That includes `"Request cancelled by user"` from a batch cancel or `cancelCurrentRequest()`. If the counter is at 8 when that happens, the helper calls `failParallelWorker` on a task that is already aborting. That sets `parallelWorkerFailure` to a misleading "API request failed after 8 retries: Request cancelled by user" and calls `say` on an aborted task. The outcome doesn't change, because `stopped` has already settled, but the persisted reason is wrong.

Fix: make the helper's first line `if (!this.parallelWorker || this.abort) return false`. Add a test: a worker with the counter at 8 that is aborted during the first-chunk wait gets no `parallelWorkerFailure`.

### 3. NIT: Whether aborting frees an OmniRoute backend slot is unverified (A3, Assumptions)

A3 says the signal wiring is "required for the timeout to free backend capacity (the 5090 reader has 3)". The client-side abort is verified. Whether OmniRoute propagates a client disconnect upstream to llama.cpp/vLLM/ds4, so the slot is actually released, is not verified anywhere.

Fix: add a V7 entry. State that OmniRoute is assumed to cancel the upstream request when the client socket closes. Give a live check: start a long generation on the 5090 reader, abort it from Zoo, and confirm the backend's active-slot count drops. If it doesn't, the timeout still settles the turn, but the retry competes with the zombie generation for one of the 3 slots.

### 4. NIT: An idle timeout after tools have already executed retries the whole turn (A3)

The presenter executes finalized tool calls while the stream is still being read. A backend that sends all content and usage and then never closes the stream will hit the between-chunks timeout. The turn then takes the mid-stream failure path, which discards the assistant content and retries, so tools such as `execute_command` or `write_to_file` can run twice. This is today's mid-stream-failure semantics. Before this design, though, that case hung instead of re-executing, so the design should state it.

Fix: add one sentence to A3 "On timeout" and a row to the A error table. For example: "Between-chunk timeout after side-effecting tools ran: accepted. Same as today's mid-stream failures, and the retried turn may repeat those tools." No code change.

### 5. NIT: `didToolFailInCurrentTurn` is unspecified for B2 row 1 and the B1 nudge

The existing `UpdateTodoListTool` error branches set `task.didToolFailInCurrentTurn = true` (UpdateTodoListTool.ts ~28–41), and A2's WriteToFileTool guard does too. B2 row 1 lists only the mistake count and `recordToolError`. The B1 nudge lists neither.

Fix: B2 row 1 also sets `didToolFailInCurrentTurn = true`, matching the sibling branches. The B1 nudge does not set it: the call was skipped, not failed, and setting it would block a legitimate `attempt_completion` in the same message. Add the row-1 flag to the existing "just prose" test.

## Verified assumptions

- **Round-2 fixes:**
    - `emitPublicTaskCompleted` emits `TaskCompleted` synchronously on the task after `waitForCurrentAssistantMessagePersistence` (AttemptCompletionTool.ts:327–336). Parallel workers reach it via `if (task.parallelWorker) { if (await askFinishSubTaskApproval()) await this.emitPublicTaskCompleted(task); return }` (:221–223).
    - The `ClineProvider` forwarder awaits `updateTaskHistory` before re-emitting (ClineProvider.ts ~431–446).
    - The in-loop abort site hard-codes `"user_cancelled"` at Task.ts:3642. The mid-stream `cancelReason` is at :3856.
    - The empty-assistant pop is at ~4298–4305, after the say at ~4282.
    - The `presentAssistantMessageSafe` filter is message-based (Task.ts:485–498).
- **`waitForParallelTask` changes are feasible:**
    - `run()` returns the `startTask` promise for workers, because `createParallelTaskRuntime` passes `startTask: false` (ClineProvider.ts ~3397) and `run()` checks `_started` (Task.ts:2346).
    - `startTask` awaits `initiateTaskLoop` (:2407), so `onLoopEnded` fires only when the loop really ends.
    - `abortTask()` aborts `lifetimeController` synchronously (:2815), so `stopped` sees `parallelWorkerFailure` set before the `await say`.
    - `startTask` swallows the loop rejection for an aborted task (:2421–2425), so a `streaming_failed` abort doesn't surface as an unhandled rejection.
- **`abortTask` cannot deadlock from the presenter:** `abortTaskOnce` fires `dispose()` without awaiting it and awaits only `flushPostStateToWebviewThrottled`, `diffReversionPromise`, and `saveClineMessages` (:2828–2875).
- **Stream wiring:**
    - `nextChunkWithAbort` reads `this.currentRequestAbortController` per call and leaks a `{ once: true }` listener per chunk (:3417–3440).
    - The loop awaits chunk k+1 before processing chunk k (:3443–3446).
    - The first-chunk race is at :5134, inside a `try` that also contains `yield firstChunk.value`.
    - The controller is created at :5070, after `manageContext` (:4909).
    - The catch clears the controller at :5141 for non-context errors.
    - Auto-approval branches are at :5159 and :3895, and the empty-assistant branch is at :4310.
- **Stream-end guard is sound:** `presentAssistantMessage` takes the lock synchronously on entry (:94–99) and tail-calls itself synchronously after advancing the index (:218–223). So `!locked && index >= length` at the `pWaitFor` (:4227) means every block has finished executing.
- **Provider wiring sites:** `openai.ts` `create` calls are at :190 and :258, `completePrompt` at :342, and :405/:440 (`methodIsAzureAiInference`). `base-openai-compatible-provider.ts` calls `create(params, requestOptions)` at :107.
- **Settings classification:** `apiRequestTimeout` appears only in `src/package.json`, the 18 `package.nls*.json` files, `timeout-config.ts`, and its spec. There is no `global-settings`, `ExtensionState`, webview, or import/export presence, so the AGENTS.md persisted-setting checklist correctly does not apply to `apiStreamIdleTimeout`. There are 18 i18n locale directories, and `scripts/find-missing-translations.js` exists.
- **Loop guard:** `ToolRepetitionDetector` today escalates at `count >= limit` with a reset, and is constructed with `consecutiveMistakeLimit` (Task.ts:696). The repetition check is inside `if (!block.partial)`, after validation and `recordToolUsage`. `isCustomTool` is scoped inside the validation block, so hoisting is required (presentAssistantMessage.ts:730/777/794).
- **B2:** the module-level `approvedTodoList` is assigned at UpdateTodoListTool.ts:56, before `askApproval`. `task.todoList` is the authoritative list (`setTodoListForTask`). The error branches set mistake/telemetry/turn-failure flags.
- **A1:** the `[RooCode#ask]`/`[RooCode#say] … aborted` throws are at Task.ts:1488/2156. `pushToolResultToUserContent` dedupes on `tool_use_id` (:508–521). `WriteToFileTool` calls `startsWith` at :76, before its `try` at :99.
- **Lifecycle:** `task-lifecycle-model.md` keeps fan-out outside baseline and CI, and production delegation is serial with a singular `awaitingChildId`. Parallel workers are outside the reducer graph, so making no `taskLifecycle.ts` change and running `pnpm lifecycle:model-check` (which includes `parser-scope:model-check`) is consistent. The E2E exclusion matches AGENTS.md: no restart, rehydration, or webview-scoping boundary changes.
- **Test files:** all extended spec files exist (`waitForParallelTask`, `ToolRepetitionDetector`, `updateTodoListTool`, `writeToFileTool`, `NativeToolCallParser`, `timeout-config`, `openai`, `base-openai-compatible-provider`, and the presentAssistantMessage family).

## Unverified or wrong assumptions

- **Wrong:** A5 and "Out of scope" say every indefinite wait on the worker request path is closed. The auto-condense summarizer stream is unbounded (finding 1).
- **Unverified:** OmniRoute cancels the upstream generation when the client disconnects (finding 3).
- **Unverified:** V3, that backends emit a chunk at least every 300 s after the first token. The setting is the mitigation.
- **Unverified:** V1, the Extension Host `TypeError` log. The persisted state is consistent with it, but it wasn't reproduced.
- **Unverified:** V5, that `TaskIdle`/`TaskInteractive` fire for every `idleAsks`/`interactiveAsks` entry on worker providers. Only `mistake_limit_reached` is confirmed.
- **Unverified:** the user's `apiRequestTimeout` value of 2100 s. This is user state, and it only affects the documented worst-case bound.
