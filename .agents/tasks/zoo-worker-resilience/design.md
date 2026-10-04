# Design: Zoo parallel-worker resilience (hung turns, repeated tool calls)

## Overview

On 2026-10-03 a `spec-orchestrator` task (`01a1008e…`) started a `parallel_tasks` batch (`a37b7cdb…`) with three Code workers and one reader. The parent stayed `active` for hours inside `runParallelTasks`'s `Promise.all`. The persisted evidence changes the brief's diagnosis in two places.

1. **Stall 1 (W1, `01a101d5-27a3…`) was not a hung HTTP stream.** The 13:51:08 request finished. `api_conversation_history.json` has an assistant message timestamped 13:51:21 with four `write_to_file` tool calls, and the first one has `content` as a JSON object (`{"name":"web",…}` for `web/package.json`), not a string. There is no tool UI after it and no tool_result. `WriteToFileTool.execute` calls `newContent.startsWith("```")` outside its `try`, so a `TypeError` is thrown. `BaseTool.handle` doesn't catch errors from `execute`. `executeAssistantMessageBlock` and `presentAssistantMessage` let the error propagate (`try/finally` only). `Task.presentAssistantMessageSafe()` logs it to the console and drops it. `userMessageContentReady` is never set, so `await pWaitFor(() => this.userMessageContentReady || this.abort || this.abandoned)` in `recursivelyMakeClineRequests` (Task.ts ~4227) waits forever. The `tokensIn/tokensOut` on `api_req_started` came from the stream's usage chunk, which shows the stream completed.
2. **Stall 2 (W3, `01a101d5-27a6…`) did not hang the parent.** `parallel-tasks/a37b7cdb…/worker-3.json` is `state: "failed"`, `error: "Worker needs input (mistake_limit_reached)…"`. `waitForParallelTask` already rejects on idle asks (`mistake_limit_reached` is in `idleAsks`). The loop itself was self-inflicted. The model sent `update_todo_list.todos` as a JSON array, not the schema's string. `parseMarkdownChecklist` returns `[]` for non-strings. The tool approved and saved an empty list (UI rows show `"todos":[]`), replied "Todo list updated successfully.", and the model re-sent the same list until the repetition detector fired.

The design still covers everything in the brief, because each item is a real gap even where it didn't cause this incident:

- **Turn-settlement guarantees (root cause of stall 1).** A failing tool must produce an error tool_result and settle the turn.
- **Argument coercion** for the two observed shapes: an object for `write_to_file.content`, an array for `update_todo_list.todos`.
- **Stream timeouts.** The bundled OpenAI SDK (5.23.2, `fetchWithTimeout`) clears `apiRequestTimeout` once response headers arrive, so a stalled body can await forever. Today nothing enforces a timeout on the first chunk for non-SDK-timeout providers, and nothing enforces one between chunks for any provider.
- **Bounded, non-interactive retries for parallel workers.** The retry loops are currently unbounded under auto-approval, so a dead provider would pin the parent forever.
- **A softer loop guard.** Nudge first, escalate at 2× the limit. Parallel workers fail instead of asking.

Technology stack (locked): TypeScript in `src/` (the VS Code extension), Vitest (`src/` package), existing i18n (`src/i18n/locales/*`), and VS Code contributed configuration (`src/package.json` + `src/package.nls*.json`). No new dependencies.

## A. Hung requests and unsettled turns

### A1. Tool failures always produce a tool_result (root-cause fix)

**Primary catch:** in `src/core/assistant-message/presentAssistantMessage.ts`, `executeAssistantMessageBlock`.

- In the `tool_use` branch, wrap the whole `switch (block.name)` dispatch, from the repetition check through the end of the switch, in `try/catch`. Hoist `isCustomTool` and the telemetry name (`toTelemetryToolName(block.name, isCustomTool, stateExperiments)`) out of the `if (!block.partial)` validation block so the catch can use them. In the catch, in this order:
    1. If `cline.abort` is set, or the error is an `Error` whose message ends with `"aborted"` (the `[RooCode#say]`/`[RooCode#ask] … aborted` throws in Task.ts ~1488/~2156), rethrow. This keeps cancellation semantics; the backstop already ignores these.
    2. If the error is an `AskIgnoredError`, return (same as `handleError`).
    3. If `block.partial` is true, `console.warn` with the task id and tool name and return without pushing a result. A result pushed for a partial block would be deduped against the finalized block's real result by `pushToolResultToUserContent` (it keys on `tool_use_id`), suppressing it. Partial-handler throws inside `BaseTool.handle` are already caught there (BaseTool.ts ~124); this case only covers throws outside it.
    4. Otherwise: `console.error` with the task id and tool name, `cline.consecutiveMistakeCount++`, `cline.recordToolError(<telemetry name>, message)` (never the raw model-controlled name, matching the validation path), `cline.didToolFailInCurrentTurn = true`, then `await handleError(\`executing ${block.name}\`, error)`.
    - `handleError` already calls `say("error")` and pushes one `formatResponse.toolError` tool_result. The `hasToolResult` guard in `pushToolResult` stops a second result if the tool had already pushed one before throwing. If `say` throws "aborted" here, it propagates to the backstop, which ignores it.
    - Because step 4 increments `consecutiveMistakeCount`, three consecutive crashing tool calls (default limit) reach the mistake-limit site at the top of the next loop iteration. Non-workers get today's ask; workers fail via A4. This is intended: a model that keeps sending crashing arguments should not loop forever.
- Wrap the `mcp_tool_use` branch's dispatch the same way, using its local `handleError`.
- Control then returns to `presentAssistantMessage` normally. The block is non-partial, so the index advances and `userMessageContentReady` is set when it's the last block. No new state is needed.

**Backstop:** in `src/core/task/Task.ts`, `presentAssistantMessageSafe()`. This covers any presenter throw outside a tool dispatch (block cloning, `getState`, the parallel-read batch). In the non-abort branch of its `.catch`, call a new private method `recoverFromPresenterFailure(error)`:

- **Dead-task guard (first step).** If `this.abort || this.abandoned`, return without changing state or calling `say`. `presentAssistantMessageSafe` filters on the error message, so a non-"aborted" error from an already-aborted task (for example a worker that just ran `failParallelWorker`) still reaches here. The turn's `pWaitFor` is already woken by `this.abort`/`this.abandoned`.
- **Locked guard (second step).** If `this.presentAssistantMessageLocked` is true, `console.warn` with the task id and return without changing any state. `presentAssistantMessage` already releases the lock in its `finally` (presentAssistantMessage.ts ~181) before the rejection reaches `.catch`. So a held lock means the streaming loop has started a new presenter in the microtask gap, and that presenter owns the turn. Mutating the index or pushing error results then could pre-empt the running tool's real result through dedupe, or let a third presenter run concurrently. If the new presenter throws as well, the backstop runs again with the lock free. The stream-end guard and the final post-stream `presentAssistantMessageSafe()` cover settlement otherwise.
- For every `tool_use`/`mcp_tool_use` block in `assistantMessageContent` from `currentStreamingContentIndex` onward that has an `id` and no matching tool_result, call `pushToolResultToUserContent({ type: "tool_result", tool_use_id: sanitizeToolUseId(id), is_error: true, content: formatResponse.toolError(\`Tool execution failed unexpectedly: ${message}. Fix the arguments and retry.\`) })`. That method dedupes. This includes blocks that are still `partial` at recovery time.
- Set `currentStreamingContentIndex = assistantMessageContent.length` and `presentAssistantMessageHasPendingUpdates = false`. Do not touch `presentAssistantMessageLocked`, which is already false. A partial block that received an error result above can later be finalized by `tool_call_end`, which replaces it in place at the same index (Task.ts ~3960). The index is already past that block, so it is not re-presented, and it keeps exactly one (error) result. Blocks appended later in the same stream get higher indexes and are presented normally by the next `presentAssistantMessageSafe()` call.
- If `didCompleteReadingStream` is true, set `userMessageContentReady = true`.
- Call `void this.say("error", …).catch(log)` once, so the failure is visible in the chat. The text is `t("common:errors.presenter_failed", { message })`, a new key (see Files changed).
- The method is synchronous apart from the fire-and-forget `say`, so it cannot itself leave the turn unsettled.

**Stream-end guard:** in Task.ts, just before the `pWaitFor` at ~4227. If `!this.presentAssistantMessageLocked && this.currentStreamingContentIndex >= this.assistantMessageContent.length`, set `this.userMessageContentReady = true`. This covers a backstop that ran before `didCompleteReadingStream` flipped, where the existing "present again if index < length" branch never runs. It is safe because the index advances only after a block finishes executing, and the lock is held while one runs. The `pWaitFor` itself stays unbounded on purpose: legitimate tools (approvals, long commands, nested batches) can take hours.

### A2. Argument coercion for observed model shapes

**`write_to_file`:** `src/core/assistant-message/NativeToolCallParser.ts`, both the streaming-partial case (~503) and the finalize case (~953).

- Add a private static helper `coerceFileContent(value: unknown): unknown`:
    - A string is returned unchanged.
    - A plain object or array becomes `JSON.stringify(value, null, 2) + "\n"`.
    - Anything else is returned unchanged.
- Apply it to `args.content` in the `write_to_file` case. When the coerced value is a string, also overwrite `params.content` with it. The generic params loop (~418–423) has already set `params.content` to compact `JSON.stringify(value)`, so without the overwrite the partial diff preview (`handlePartial` reads `block.params.content`) would show compact JSON while the final write used pretty JSON. History records `nativeArgs`, so the persisted tool_use then matches what executed.

**`WriteToFileTool` defense in depth** (`src/core/tools/WriteToFileTool.ts`):

- In `execute`, right after the `undefined` check: if `typeof newContent !== "string"`, then `consecutiveMistakeCount++`, `recordToolError("write_to_file")`, `didToolFailInCurrentTurn = true`, push `formatResponse.toolError("write_to_file content must be a string containing the full file text")`, `await diffViewProvider.reset()`, and return.
- `handlePartial` is not changed. It reads `params.content`, which the parser always sets as a string, so a guard there would be dead code.

**Shared todo coercion.** Add an exported helper `coerceTodosArg(value: unknown): unknown` in `src/core/tools/UpdateTodoListTool.ts`, next to `parseMarkdownChecklist`. The parser and the tool both use it.

- A string is returned unchanged.
- An array where every element is a string becomes `value.join("\n")`, so each element is one checklist line.
- Any other array, or a plain object, becomes `JSON.stringify(value)`.
- Anything else is returned unchanged.

**`update_todo_list` parser:** `NativeToolCallParser.ts` (~586 partial, ~934 final). Set `args.todos = coerceTodosArg(args.todos)`, and set `params.todos` to the result when it's a string. `parseMarkdownChecklist` already parses JSON todo arrays, `{todos:[…]}`, and items with `content`/`text` plus `status`, and fills in md5 ids when they're missing.

**`UpdateTodoListTool.execute` defense:** `src/core/tools/UpdateTodoListTool.ts`.

- Apply `coerceTodosArg(params.todos)`. If the result is still not a string, return the existing "not valid markdown checklist or JSON" tool error.
- `parseMarkdownChecklist`'s `typeof md !== "string"` early `return []` stays, because `ParallelTasksTool` and `ClineProvider` call it with validated strings. The tool no longer reaches that branch with non-strings.

The no-op rules are in B2.

### A3. Stream idle and first-chunk timeouts

**Mechanism.** New module `src/core/task/streamIdleTimeout.ts`:

```ts
export type StreamWaitPhase = "first_chunk" | "between_chunks"
export class StreamIdleTimeoutError extends Error {
	constructor(
		readonly phase: StreamWaitPhase,
		readonly timeoutMs: number,
	) {
		super(/* see below */)
	}
}
export function awaitWithStreamTimeout<T>(
	next: Promise<T>,
	opts: { signal?: AbortSignal; timeoutMs: number; phase: StreamWaitPhase },
): Promise<T>
```

Contract:

- It races `next` against the abort signal and a `setTimeout(timeoutMs)`.
- On abort it rejects with `new Error("Request cancelled by user")`. That's the existing message, and callers classify the failure by `this.abort`, not by the message.
- On timeout it rejects with `StreamIdleTimeoutError`. The message is `No data received from the provider for ${s}s (${phase}); the request was aborted and will be retried.`
- `timeoutMs <= 0` disables the timer.
- If `signal?.aborted` is already true at call time, it rejects immediately with `"Request cancelled by user"`, starts no timer, and adds no listener. Today's first-chunk code behaves the same way.
- It always clears the timer and removes the abort listener when it settles. This also fixes a leak in today's `nextChunkWithAbort`, which adds a `{ once: true }` abort listener per chunk and never removes it.
- It attaches settle handlers to `next` unconditionally (`next.then(onValue, onError)`), and the first settle wins. A rejection of `next` that arrives after a timeout or abort is therefore handled and ignored, and never becomes an unhandled rejection.
- It never calls `iterator.return()`. Callers own cleanup.

**Settings decision.** Two different waits need two limits, so `apiRequestTimeout` is reused for one and a new setting is added for the other.

- **First chunk** (in `Task.attemptApiRequest`, ~5090, the `Promise.race([firstChunkPromise, abortPromise])`): reuse `getApiRequestTimeout()`, the existing `zoo-code.apiRequestTimeout` (user value 2100s). This is the wait that legitimately includes OmniRoute queueing, model load, and long local prefill (the planner-queue-wait work). That is exactly what the user tuned `apiRequestTimeout` for, so a 300s limit here would break local 27B/GLM prefill. Replace the race with `awaitWithStreamTimeout(firstChunkPromise, { signal: abortSignal, timeoutMs: getApiRequestTimeout(), phase: "first_chunk" })`. Read the value per request: `BaseProvider.timeoutMs` is captured at construction.
- **Between chunks** (in `recursivelyMakeClineRequests`, ~3417 `nextChunkWithAbort`): add a new VS Code configuration setting, `zoo-code.apiStreamIdleTimeout`.
    - Integer seconds, default `300`, minimum `0` (0 disables), maximum `3600`.
    - Reusing 2100s here would let a stalled body pin a worker for 35 minutes per attempt, which is why it gets its own setting.

**Applying the between-chunks timeout.** Replace `nextChunkWithAbort` with `nextChunk(phaseTimeoutMs: number)`, which calls `awaitWithStreamTimeout(iterator.next(), { signal: this.currentRequestAbortController?.signal, timeoutMs: phaseTimeoutMs, phase: "between_chunks" })`. The controller is read on every call, as today: `attemptApiRequest` creates it inside the first `next()` (Task.ts ~5071) and a first-chunk retry replaces it, so it cannot be captured up front. When it is `undefined` (its abort listener clears it), no abort race is installed, matching today. The loop at ~3443 calls `nextChunk(0)` once and then `nextChunk(idleMs)` at the top of the `while`. Note that loop awaits chunk k+1 before processing chunk k, so the timer measures pure provider wait. The first call gets no idle timer. That call drives `attemptApiRequest`'s whole first-chunk phase, including first-chunk retries, backoff countdowns up to 600s, and context-window truncation, and it already has its own first-chunk timeout. Every later call uses `awaitWithStreamTimeout(iterator.next(), { signal: this.currentRequestAbortController?.signal, timeoutMs: getApiStreamIdleTimeout(), phase: "between_chunks" })`. Read `getApiStreamIdleTimeout()` once per request, next to `cachedStreamingModel`. The timer only covers the `iterator.next()` wait. Chunk-processing awaits such as `say()` don't count, and tool execution is fire-and-forget through `presentAssistantMessageSafe`, so it doesn't count either.

**On timeout,** in either phase, the code that catches the `StreamIdleTimeoutError` does the steps below. In `attemptApiRequest` this is the first statement of the existing `catch` (~5138), before `this.currentRequestAbortController = undefined` clears the reference. Mid-stream, it is the first statement of the catch at ~3855, guarded by `error instanceof StreamIdleTimeoutError`. "Rethrow" means falling through to the existing handling in that catch, not a new throw:

1. `this.currentRequestAbortController?.abort(error)`. This aborts the signal Task already passes to the provider as `metadata.abortSignal` (Task.ts ~5078). It cancels the HTTP request only for providers that forward that signal to their transport. See "Provider signal wiring" below.
2. `void iterator.return?.(undefined)?.catch(() => {})`, a best-effort cleanup that is not awaited, because a stalled generator's `return()` stays queued until it resumes.
3. Continue into the existing handling for that catch.

**Provider signal wiring (required for the timeout to free backend capacity).** Today `OpenAiHandler`, the handler OmniRoute profiles use (`src/api/providers/omniroute.ts`), never passes `metadata.abortSignal` to the SDK. Aborting the controller settles the turn but leaves the socket open. The backend keeps generating and holds a slot (the 5090 reader has 3) while the retry opens a second request. This design wires the signal in the two shared OpenAI-style paths:

- `src/api/providers/openai.ts`: every `this.client.chat.completions.create(requestOptions, …)` call (streaming ~190 and ~405, non-streaming ~258, ~342, ~440) uses the second argument `{ ...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}), ...(metadata?.abortSignal ? { signal: metadata.abortSignal } : {}) }`. Use the local Azure flag variable at each site (`methodIsAzureAiInference` at ~405). `completePrompt` (~342) has no `metadata`, so it keeps today's argument there.
- `src/api/providers/base-openai-compatible-provider.ts` `createStream` (~107): call `create(params, { ...requestOptions, signal: requestOptions?.signal ?? metadata?.abortSignal })`. When both are undefined, pass `requestOptions` unchanged so existing spec assertions on the second argument still hold. This covers every subclass that reaches `super.createStream`, including `zai` for non-thinking models.

When the SDK sees the abort, it rejects the pending `iterator.next()` with `APIUserAbortError`. `awaitWithStreamTimeout` has already rejected, and its settle handlers absorb that late rejection (see the Contract). The SDK's internal `maxRetries` loop stops too.

Known limitation: providers that build their own requests and ignore `metadata.abortSignal` still leave the socket open after a timeout. That includes Anthropic, Gemini, `zai.createStreamWithThinking`, `friendli.createStream`, and most non-OpenAI handlers. Only bedrock, openai-codex, nanogpt, opencode-go, and `request-config-builder` users already forward it. For those other providers the turn still settles and retries, but the stalled socket is abandoned rather than closed, and the server or OS timeout ends it eventually. Wiring them is backlog.

The error then takes the existing paths:

- **First chunk:** the `attemptApiRequest` catch. Not a context-window error, so `backoffAndAnnounce(retryAttempt)` runs, then the recursive retry, or the `api_req_failed` ask when auto-approval is off (workers: see A4).
- **Between chunks:** the mid-stream catch (~3855). `this.abort` is false, so the cancel reason is `streaming_failed`, the message is `"Provider ended the request: <timeout message>"`, and `abortStream()` updates `api_req_started`. With auto-approval, backoff runs, then `stack.push` with `retryAttempt + 1`. Partial assistant content is discarded exactly as for today's mid-stream failures.

A between-chunk timeout after side-effecting tools already ran is accepted: it takes today's mid-stream-failure path, discards the assistant content and retries, so the retried turn may repeat those tools (e.g. `execute_command`, `write_to_file`).

**Setting plumbing.** This is a VS Code contributed configuration (`vscode.workspace.getConfiguration(Package.name)`), the same kind as `apiRequestTimeout`. It is not a `ContextProxy`/global-settings value, so the AGENTS.md persisted-setting checklist (`global-settings.ts`, `ExtensionState`, `SettingsView` `cachedState`, `getState`, `getStateToPostToWebview`, import/export) does not apply. `apiRequestTimeout` follows the same pattern and appears in none of those files. The full list of changes:

- `src/package.json` `contributes.configuration`: add `"zoo-code.apiStreamIdleTimeout": { "type": "integer", "default": 300, "minimum": 0, "maximum": 3600, "description": "%settings.apiStreamIdleTimeout.description%" }` right after `apiRequestTimeout`.
- `src/package.nls.json`: `"settings.apiStreamIdleTimeout.description": "Abort and retry a streaming API response when no data arrives for this many seconds (default: 300, range: 0–3600, 0 disables). The wait for the first token is governed by API request timeout."`
- Add the same key to all 17 other `src/package.nls.<locale>.json` files, with translations matching each file's existing `apiRequestTimeout` entry style. `node scripts/find-missing-translations.js` must report nothing missing.
- `src/api/providers/utils/timeout-config.ts`: add `getApiStreamIdleTimeout(): number` (ms).
    - Constants: `DEFAULT_STREAM_IDLE_SECONDS = 300`, valid range `0..3600`.
    - Validation: must be a finite number with `0 <= v <= 3600`. A non-number, NaN, or out-of-range value falls back to 300 silently, mirroring `isValidTimeout`. Return `Math.round(v * 1000)`.
- Consumers: only `Task.recursivelyMakeClineRequests`. There's no webview consumer.

### A4. Parallel workers never block on an interactive ask and never retry forever

**New Task API** (`src/core/task/Task.ts`):

```ts
/** Set when a parallel worker terminates itself; read by waitForParallelTask. */
parallelWorkerFailure?: string
public async failParallelWorker(reason: string): Promise<void>
```

`failParallelWorker`:

- Throws a plain `Error` (programming error) if `!this.parallelWorker`.
- Sets `this.parallelWorkerFailure ??= reason` and `this.abortReason ??= "streaming_failed"` for every caller. It takes no reason-kind parameter. `abortReason` is only read to label `api_req_started` and to skip `user_cancelled` rehydration/rejection paths (Task.ts ~2416/~2424/~2718, ClineProvider ~3599), so `"streaming_failed"` is correct for loop-guard failures too: it keeps them from being treated as a user cancel.
- `await this.say("error", t("common:errors.parallel_worker_failed", { reason })).catch(log)`.
- Then `await this.abortTask()`.
- It's idempotent. `abortTask` is already idempotent, and `??=` keeps the first reason.

`abortTask` aborts `lifetimeSignal`. Two small adjustments so a worker self-abort isn't labelled a user cancel:

- Mid-stream catch (~3856): compute `cancelReason` as `this.abort ? (this.abortReason ?? "user_cancelled") : "streaming_failed"`.
- In-loop abort check (~3634–3642, `if (this.abort) { … await abortStream("user_cancelled"); break }`): use `await abortStream(this.abortReason ?? "user_cancelled")`. This site matters because the presenter runs finalized tool calls while the stream is still being read, so a B1 worker escalation or an A1-triggered mistake-limit failure can abort the task mid-stream and land here. A real user cancel leaves `abortReason` as `"user_cancelled"` (ClineProvider ~3599) or unset, so its label is unchanged.

Ordering: `parallelWorkerFailure` is set before any `await`, so it is visible when `abortTask()` aborts `lifetimeSignal` and `waitForParallelTask`'s `stopped` listener runs. `abortTask` does not await the stream loop or the presenter (it fires `dispose()` without awaiting and only awaits `diffReversionPromise`), so calling `failParallelWorker` from inside the presenter (B1) or the request loop cannot deadlock.

**Retry cap.** The cap counts failures on the Task, not through `retryAttempt`. `retryAttempt` doesn't carry over between the two retry layers. First-chunk retries recurse through `attemptApiRequest(retryAttempt + 1)` (~5154/~5174) without updating the stack item. Mid-stream and empty-assistant retries push `(currentItem.retryAttempt ?? 0) + 1` (~3913/~4333). Interleaved failures would therefore reset the effective count. `retryAttempt` stays the backoff exponent only.

New in Task.ts:

```ts
const PARALLEL_WORKER_MAX_API_RETRIES = 8
/** Consecutive failed API attempts for a parallel worker; reset when a request streams assistant content to completion. */
private parallelWorkerApiFailures = 0
private async failWorkerIfRetriesExhausted(error: unknown): Promise<boolean>
```

`failWorkerIfRetriesExhausted`:

- Its first line is `if (!this.parallelWorker || this.abort) return false`: cancellations are not API failures, and non-workers never touch the counter.
- Returns false for non-workers without touching the counter.
- For workers, it increments `parallelWorkerApiFailures`. While the counter is `<= PARALLEL_WORKER_MAX_API_RETRIES`, it returns false.
- Otherwise it calls `failParallelWorker(\`API request failed after ${PARALLEL_WORKER_MAX_API_RETRIES} retries: ${message}\`)` and returns true.

A worker's 9th consecutive failed request fails it, so it makes at most 9 requests (1 original plus 8 retries) between successful responses, across both layers. The counter resets to 0 at Task.ts ~4056, inside `if (hasTextContent || hasToolUses)` next to `this.consecutiveNoAssistantMessagesCount = 0`. That point is reached only after `didCompleteReadingStream = true`. Context-window truncation retries do not call the helper. They stay bounded by `MAX_CONTEXT_WINDOW_RETRIES` on `retryAttempt`.

**Worst-case time before a worker fails (accepted).** The backoff for exponents 0–7 is 5+10+20+40+80+160+320+600 = 1235 s. The time spent waiting on requests depends on how each one fails:

- Fast failures (503, connection refused): about 21 minutes in total, which covers an OmniRoute restart.
- A provider that accepts the connection but never sends a first chunk: each attempt waits the full `apiRequestTimeout`. The worst case is `9 × apiRequestTimeout + 1235 s`, about 5.6 h at the user's 2100 s.
- Mid-stream stalls: each costs up to `apiStreamIdleTimeout` (300 s) plus the time spent streaming.

We accept and document the long first-chunk bound and do not shorten the worker's first-chunk wait. Local 27B/GLM prefill and the planner queue wait need the long wait, and a hung worker no longer pins the parent forever. If shorter is wanted later, the knob is `apiRequestTimeout`.

Call sites:

| Site                                  | Worker behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attemptApiRequest` first-chunk catch | After the context-window branch, call the helper. If exhausted, throw `Error(\`[Task#attemptApiRequest] task … aborted after worker retry cap\`)`. It propagates out of the first `iterator.next()`into the mid-stream catch in`recursivelyMakeClineRequests`(~3853). That catch takes its`this.abort` branch (`abortTask()`is idempotent), and with the`cancelReason`tweak`api_req_started`gets`streaming_failed`. If not exhausted, always take the backoff + recursive-retry branch, even when `autoApprovalEnabled`is false, because nobody can answer`api_req_failed`. |
| Mid-stream catch (~3880 `else`)       | Call the helper before backoff/`stack.push`. If exhausted, `break`. Otherwise back off even without auto-approval, then push.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Mid-stream `OutputTokenLimitError`    | `failParallelWorker("Model output token limit reached; the identical request would truncate again")` instead of the ask, then `break`. It does not use the counter.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Empty-assistant path (~4280–4300)     | Call the helper after `consecutiveNoAssistantMessagesCount++`/the `MODEL_NO_ASSISTANT_MESSAGES` say and **before** the `apiConversationHistory.pop()` block. If exhausted, `return true` without popping, so the saved history keeps the user message and a later explicit resume is consistent. Otherwise continue into the existing pop, and workers take the auto-retry branch regardless of `autoApprovalEnabled`.                                                                                                                                                      |
| Consecutive-mistake limit (~3141)     | Workers: `failParallelWorker(\`Stopped after ${limit} consecutive mistakes\`)`, `return true`, no ask.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tool repetition escalation (B1)       | Workers: `failParallelWorker(t("tools:toolRepetitionLimitReached", …))`, push the tool error result, `break`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Non-worker tasks keep today's behavior in every row except B1's nudge.

**`waitForParallelTask`** (`src/core/task/runParallelTasks.ts`):

- Widen the `child` `Pick` to `"taskId" | "clineMessages" | "lifetimeSignal" | "run" | "parallelWorkerFailure" | "on" | "off"` (`Task` is an `EventEmitter<TaskEvents>`).
- **Completion is settled from the child's own event, not only the provider's.** The provider re-emit is asynchronous: `ClineProvider`'s `onTaskCompleted` forwarder (ClineProvider.ts ~431–446) first does `await this.updateTaskHistory({ ...existing, status: "completed" })`, which always runs for a fresh worker (each worker has its own `ClineProvider` from `createParallelTaskRuntime`), and only then emits on the provider. During that await the worker loop keeps running, so a new `failParallelWorker` site, a lifetime abort, or `run()` resolving could otherwise settle the promise first and report a successful worker as `failed`. `AttemptCompletionTool.emitPublicTaskCompleted` (~327) calls `task.emit(TaskCompleted, …)` synchronously after its persistence wait, so the child event is always first.
    - Add a local `settled = false` and `settle(fn)` that returns if `settled`, otherwise sets it, calls `cleanup()`, then `fn()`. Every path below goes through `settle`.
    - Add `let completedText: string | undefined` and `completionText()` (the existing `completion_result` lookup with the `"Task completed"` fallback).
    - `onChildCompleted = () => { completedText = completionText(); settle(() => resolve(completedText!)) }`, registered with `child.on(RooCodeEventName.TaskCompleted, onChildCompleted)`. The child's own emitter only carries its own task id, so no id check is needed.
    - Keep `provider.on(TaskCompleted, complete)` as a fallback. `complete` keeps its task-id check and resolves via `settle` with `completionText()`.
    - `stopped`, `onLoopEnded`, and `needsInput`: if `completedText !== undefined`, `settle(() => resolve(completedText!))` instead of rejecting. In practice `settled` is already true in that case, so this is a belt-and-braces guard. `cancel` (batch signal) still rejects, because a cancelled batch reports `cancelled` regardless.
    - `cleanup()` also calls `child.off(RooCodeEventName.TaskCompleted, onChildCompleted)`.
- `stopped` rejects with `new Error(child.parallelWorkerFailure ? \`Worker failed: ${child.parallelWorkerFailure}\` : "Worker stopped before completing")`.
- Replace `void child.run().catch(...)` with `void child.run().then(onLoopEnded, onLoopError)`. `onLoopEnded` rejects via `settle` with `parallelWorkerFailure` if set, else `"Worker task loop ended without attempt_completion; inspect its saved chat and patch"`. This covers the silent `return true` in `recursivelyMakeClineRequests`'s outer catch. `onLoopError` rejects via `settle` with the error, as today.
- `runParallelTasks` already maps a rejection to `state: "failed"`, `error: message`, exports the patch, writes `worker-N.json`, and its `finally` runs `cancelCurrentRequest` → `abortTask` → `dispose`. No change there.

**Lifecycle model.** Parallel workers are not part of the persisted delegation graph. The parent is never transitioned to `delegated`, `awaitingChildId` is never set, and results are owned by the waiting `parallel_tasks` tool call (`runParallelTasks`: "children never mutate the parent's message buffers"). Worker failure and abandonment are therefore tool-result outcomes (`ParallelTaskResult.state`), not `HistoryItem` status transitions. This design adds no transition and changes no reducer in `src/core/task-persistence/taskLifecycle.ts`: `delegateTaskToChild`, `interruptDelegatedChild`, `completeDelegatedChild`, and `abandonDelegatedChild` stay untouched, and the parent stays `active` throughout, as the doc's serial-delegation baseline expects. Worker cleanup is the existing `runParallelTasks` `finally`, which the cleanup protocol model abstracts as abort and disposal. `pnpm lifecycle:model-check` must still pass unchanged. Run it because Task.ts abort paths and the parser are touched. Worker `HistoryItem.status` stays `undefined`, as in the incident (see backlog).

### A5. Audit: every post-retry path must settle

| Path                                                                                                                                | After this design                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 503 or other error before the first chunk                                                                                           | Backoff + retry (bounded for workers); first-chunk wait bounded by `apiRequestTimeout`.                                                                |
| Stream stalls after first chunk                                                                                                     | Idle timeout → `streaming_failed` → retry (bounded for workers).                                                                                       |
| Stream ends with no assistant content                                                                                               | Existing grace + backoff retry (bounded for workers).                                                                                                  |
| Stream ends with tool calls whose execution throws                                                                                  | A1 error tool_result → turn settles → model sees error.                                                                                                |
| Presenter throws outside tool dispatch                                                                                              | A1 backstop + stream-end guard.                                                                                                                        |
| Backoff countdown                                                                                                                   | Already finite (`MAX_EXPONENTIAL_BACKOFF_SECONDS`), abort-aware.                                                                                       |
| Interactive asks in a worker                                                                                                        | Replaced by `failParallelWorker` at the sites above; any remaining idle/interactive ask is still caught by `waitForParallelTask`'s existing listeners. |
| Worker loop ends silently                                                                                                           | `onLoopEnded` rejection.                                                                                                                               |
| Parallel-read batch `waitForCurrentAssistantMessagePersistence()` false                                                             | Only on abort/dispose, and `this.abort` wakes the wait. A persistence throw goes to the A1 backstop (V4, verified).                                    |
| Auto-condense summarizer stream stalls (attemptApiRequest/handleContextWindowExceededError → manageContext → summarizeConversation) | First-chunk/idle timeout aborts `condenseController` → `result.error` → sliding-window truncation → request proceeds.                                  |

### Error handling summary (A)

| Operation      | Failure                      | Recoverable?        | Caller receives                                                 | Logging                                     |
| -------------- | ---------------------------- | ------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| Tool dispatch  | Any throw (non-abort)        | Yes (model retries) | `is_error` tool_result + chat `error` row                       | `console.error` with task id/tool           |
| Presenter      | Throw outside dispatch       | Yes                 | `is_error` tool_results for unanswered tools                    | `console.error` (existing) + chat error     |
| First chunk    | Exceeds `apiRequestTimeout`  | Yes (retry)         | `api_req_retry_delayed` countdown                               | existing backoff UI                         |
| Between chunks | Exceeds idle timeout         | Yes (retry)         | `api_req_started` `streaming_failed` + retry                    | `console.error` "Stream failed, will retry" |
| Between chunks | Timeout after tools executed | Yes (retry)         | `streaming_failed` + retry; tools may run again                 | `console.error`                             |
| Worker retries | Cap reached                  | Fatal for worker    | Parent tool result `state:"failed"`, `error:"Worker failed: …"` | chat `error` row in worker                  |
| Setting read   | Invalid value                | Yes                 | Default 300s                                                    | none (mirrors `apiRequestTimeout`)          |

## B. Repeated identical tool calls (loop guard)

### B1. Nudge first, escalate at 2× the limit

**`src/core/tools/ToolRepetitionDetector.ts`:** keep the class and constructor (`limit` = `consecutiveMistakeLimit`, default 3; `0` means unlimited). Extend the result:

```ts
{ allowExecution: true }
| { allowExecution: false; nudge: { toolName: string; repeatCount: number } }
| { allowExecution: false; askUser: { messageKey: "mistake_limit_reached"; messageDetail: string } }
```

Counting is unchanged: `consecutiveIdenticalToolCallCount` counts repeats after the first call.

- When `count >= limit && count < 2 * limit`, return `nudge` and keep the counters. With the default limit of 3, the 4th, 5th, and 6th identical calls are nudged and not executed.
- When `count >= 2 * limit` (the 7th identical call), return `askUser` and reset the counters (today's reset semantics).
- A different call resets the count to 0, as today.

**`presentAssistantMessage.ts`** (~793):

- **Nudge:** no ask, no telemetry exception. Call `cline.recordToolError(telemetryToolName, "repetition_nudge")`, using the `toTelemetryToolName(...)` value hoisted in A1 and never the raw `block.name`. Then call `pushToolResult(formatResponse.toolError(formatResponse.toolRepetitionNudge(block.name, repeatCount)))`, then `break`.
    - New helper in `src/core/prompts/responses.ts` (model-facing English, like the other `formatResponse` strings): `You already called ${toolName} with identical arguments ${n + 1} times in a row; this call was not executed. Do not call it again with the same arguments. Proceed with the next action of your task.` For `update_todo_list` it appends: ` Only call update_todo_list again after an item's status changes.`
    - Do not increment `consecutiveMistakeCount`. The detector owns this escalation, and double-counting would trigger the separate mistake-limit ask early.
- **Escalate, non-worker:** today's code, unchanged (ask `mistake_limit_reached`, telemetry, tool error result).
- **Escalate, worker (`cline.parallelWorker`):** telemetry as today, push the same tool error result, `await cline.failParallelWorker(t("tools:toolRepetitionLimitReached", { toolName: block.name }))`, then `break`. No ask. The parent receives `Worker failed: Zoo appears to be stuck in a loop… (update_todo_list)…`.

### B2. `update_todo_list` no-op for empty or unchanged lists

In `UpdateTodoListTool.execute`, after parsing and validation and before `askApproval`, compare `normalizedTodos` with `task.todoList ?? []` on the ordered `(content, status)` pairs. Ids are md5 of content+status, so they're redundant, and JSON-supplied ids can differ.

Let `trimmed = todosString.trim()`, where `todosString` is the string after any A2 coercion, and `isJsonShaped = trimmed.startsWith("[") || trimmed.startsWith("{")`. The rows are evaluated in this order, and the first match wins:

| #   | Condition                                                                                     | Behavior                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `trimmed !== "" && !isJsonShaped && normalizedTodos.length === 0` (prose, no checklist lines) | Tool error: "No checklist items found. Provide the full list as `[ ] item` lines." Increment mistake count, `recordToolError("update_todo_list")`, set `didToolFailInCurrentTurn = true`.                                       |
| 2   | `normalizedTodos` equals the current list on `(content, status)` pairs, including both empty  | No-op, no ask. Result: `Todo list unchanged (N items, M completed). Do not call update_todo_list again until an item's status changes; proceed with the next action.`                                                           |
| 3   | `normalizedTodos.length === 0` and the current list is non-empty                              | No-op, no ask, list untouched. Result: `Todo list unchanged: an empty list was ignored. Current list has N items (M completed). Proceed with the next item; do not call update_todo_list again until an item's status changes.` |
| 4   | Otherwise                                                                                     | Existing approval/persist flow.                                                                                                                                                                                                 |

Resulting classification for the edge inputs:

- `""`, `"[]"`, `"{\"todos\":[]}"`, and the array param `[]` (coerced to `"[]"`) never match row 1. They give row 2 when the current list is empty, and row 3 otherwise.
- `"just prose"` gives row 1.
- JSON-shaped input that `parseMarkdownChecklist` can't read (for example `"[1,2]"`) parses to `[]` and is treated as empty, not as an error.

Row 1 sets `didToolFailInCurrentTurn = true`. The B1 nudge does not set it, because the call was skipped, not failed, and setting it would block a same-message `attempt_completion`.

No-ops don't increment `consecutiveMistakeCount`; the repetition detector handles persistence. They return through `pushToolResult(formatResponse.toolResult(...))`.

Placement: rows 1–3 are evaluated after `normalizedTodos` is built (~45) and **before** `approvedTodoList = cloneDeep(normalizedTodos)` (~56), so a no-op or row-1 error never overwrites the module-level pending list.

Accepted side effect: `handlePartial` has already posted a partial `task.ask("tool", …, true)` row. Rows 1–3 skip `askApproval`, so that row stays `partial: true`, and if the next tool's partial ask is also `"tool"`, `Task.ask` updates it in place (`isUpdatingPreviousPartial`, Task.ts ~1517). The existing parse-error branches already leave the row this way, so this is accepted rather than adding a new finalize path. The model-facing tool_result is unaffected.

Behavior change: the model can no longer clear the list with an empty `update_todo_list`. That's what the brief asks for, and the tool description already says "Always provide the full list".

### Error handling summary (B)

| Operation          | Failure                        | Recoverable?                    | Caller receives                                   | Logging                |
| ------------------ | ------------------------------ | ------------------------------- | ------------------------------------------------- | ---------------------- |
| Repetition, ≥limit | Identical call                 | Yes                             | Nudge tool error (not executed)                   | `recordToolError` only |
| Repetition, ≥2×    | Identical call                 | Non-worker: user; worker: fatal | Ask, or parent `state:"failed"` with loop message | Telemetry (existing)   |
| `update_todo_list` | Non-string/unparseable `todos` | Yes                             | Existing invalid-checklist tool error             | `recordToolError`      |

## Invariant ownership

- **Each tool_use gets at most one tool_result:** `pushToolResult`'s `hasToolResult` guard plus `Task.pushToolResultToUserContent` dedupe. Unchanged. Both new paths go through them.
- **Every turn's `userMessageContentReady` wait settles:** presenter layer (A1 catch) for tool failures; Task (backstop and stream-end guard) for the rest. Task owns the wait.
- **A parallel worker never waits on a human and never retries forever:** Task call sites (A4), because only they know the failure kind. `waitForParallelTask` stays the second line through its existing idle/interactive-ask and lifetime listeners, plus `onLoopEnded`.
- **Escalation thresholds:** `ToolRepetitionDetector` alone.
- **Lifecycle status:** untouched; `taskLifecycle.ts` remains the sole owner.

## Files changed

- `src/core/assistant-message/presentAssistantMessage.ts`: dispatch catch (tool and MCP branches), nudge and worker escalation.
- `src/core/assistant-message/NativeToolCallParser.ts`: `write_to_file.content` and `update_todo_list.todos` coercion (partial and final).
- `src/core/tools/WriteToFileTool.ts`: string guard in `execute`.
- `src/core/tools/UpdateTodoListTool.ts`: `coerceTodosArg` (re-exported), no-op rules.
- `src/core/tools/todoArgs.ts` (new): import-free leaf holding `coerceTodosArg`, so `NativeToolCallParser.ts` never imports a vscode-dependent module (keeps `parser-scope:model-check` green).
- `src/core/condense/index.ts`: bound the summarizer stream with `awaitWithStreamTimeout` (first-chunk `apiRequestTimeout`, then the idle timeout), aborting `condenseController` on timeout so `result.error` triggers the sliding-window fallback.
- `src/api/providers/openai.ts`: forward `metadata.abortSignal` as `signal` to `chat.completions.create`.
- `src/api/providers/base-openai-compatible-provider.ts`: merge `metadata.abortSignal` into the `createStream` request options.
- `src/core/tools/ToolRepetitionDetector.ts`: nudge/escalate result.
- `src/core/prompts/responses.ts`: `toolRepetitionNudge`.
- `src/core/task/streamIdleTimeout.ts` (new): `awaitWithStreamTimeout`, `StreamIdleTimeoutError`.
- `src/core/task/Task.ts`:
    - `presentAssistantMessageSafe` backstop and `recoverFromPresenterFailure`
    - stream-end guard
    - first-chunk and between-chunk timeouts
    - `parallelWorkerFailure`, `parallelWorkerApiFailures` and its reset, `failParallelWorker`, `failWorkerIfRetriesExhausted`, `PARALLEL_WORKER_MAX_API_RETRIES`
    - worker branches at the retry, mistake, and output-limit sites
    - `cancelReason` tweak (mid-stream catch and in-loop abort check)
    - empty-assistant cap check placed before the history pop
- `src/core/task/runParallelTasks.ts`: `waitForParallelTask` child `TaskCompleted` listener, `settle`/`settled`, failure reason, `onLoopEnded`.
- `src/api/providers/utils/timeout-config.ts`: `getApiStreamIdleTimeout`.
- `src/package.json`, `src/package.nls.json`, and the 17 `src/package.nls.<locale>.json` files: new setting.
- `src/i18n/locales/*/common.json` (18 locales): `errors.parallel_worker_failed` (`"Parallel worker stopped: {{reason}}"`) and `errors.presenter_failed` (`"Tool execution failed unexpectedly: {{message}}. The model was sent an error result for the unanswered tool calls."`). `node scripts/find-missing-translations.js` must report nothing missing.
- `src/core/task-persistence/taskLifecycle.ts`: **no change** (see A4).

## Test plan

Vitest from `src/` (`cd src && npx vitest run <path>`), at the lowest layer that would have caught each bug. No E2E is needed: no extension-host, persistence, or rehydration boundary changes.

**A1–A2 (regression for stall 1):**

- `assistant-message/__tests__/presentAssistantMessage-tool-crash.spec.ts` (new):
    - A `write_to_file` block whose tool `handle` throws a `TypeError` yields exactly one `is_error` tool_result for its id.
    - The index advances, and `userMessageContentReady` becomes true when the stream is complete.
    - A following block in the same message still executes.
    - An abort error is rethrown and pushes no result.
    - An MCP branch throw behaves the same way.
    - A throw on a partial block pushes no result, and the finalized block's own result is then accepted.
    - `recordToolError` receives the telemetry-safe name, not the raw block name.
- `task/__tests__/Task.presenter-backstop.spec.ts` (new):
    - When `presentAssistantMessage` is mocked to reject with a non-abort error, the backstop pushes error results for every unanswered tool_use and sets ready.
    - The stream-end guard sets ready when the index ≥ length and the presenter is unlocked, and leaves it unset when locked.
    - After the backstop runs, a block appended afterwards is presented and executed.
    - A backstop that runs while `presentAssistantMessageLocked` is true changes nothing: no results, no index change, no ready flag, no `say`.
    - A partial tool_use that is unanswered at recovery gets one `is_error` result. When it is finalized in place afterwards, it is not executed and still has exactly one result.
    - An `"…aborted"` rejection triggers no recovery and no `say`.
    - A non-abort rejection after `abortTask()` (and separately with `abandoned = true`) triggers no recovery: no results pushed, no index change, no `say`.
- `NativeToolCallParser.spec.ts`:
    - Object and array `content` becomes pretty JSON plus a newline; string content is unchanged.
    - For object `content`, both `nativeArgs.content` and `params.content` (partial and final) equal the same pretty JSON.
    - An array `todos` of objects becomes a JSON string that `parseMarkdownChecklist` turns into the incident's items.
    - An array `todos` of strings becomes newline-joined lines.
- `writeToFileTool.spec.ts`: non-string content gives a tool error, does not throw, calls `diffViewProvider.reset()`, and never calls `diffViewProvider.open`/`update` (matching the existing missing-param branches, WriteToFileTool.ts ~35–47).

**A3:**

- `task/__tests__/streamIdleTimeout.spec.ts` (new, fake timers):
    - Resolution before the timeout clears the timer.
    - Rejection with `StreamIdleTimeoutError` carrying the phase and ms.
    - Abort rejects with "Request cancelled by user".
    - `timeoutMs` 0 never times out.
    - The abort listener is removed after it settles (assert with a spy on `removeEventListener`).
    - An already-aborted signal rejects immediately, with no timer scheduled (`vi.getTimerCount() === 0`).
    - `next` rejecting after a timeout or abort produces no unhandled rejection (assert with a `process.on("unhandledRejection")` spy).
- `api/providers/__tests__/openai.spec.ts`: for streaming and non-streaming `createMessage`, including the Azure AI Inference path, the second argument to `create` contains `signal: metadata.abortSignal`. Without `abortSignal` it is unchanged (`{}`, or `{ path }` for Azure).
- `api/providers/__tests__/base-openai-compatible-provider.spec.ts`: the second argument to `create` carries `metadata.abortSignal` as `signal`.
- `api/providers/utils/__tests__/timeout-config.spec.ts`: `getApiStreamIdleTimeout` cases: default 300000, 0 → 0, 3600 → 3600000, -1/NaN/"x"/4000 → 300000.
- `task/__tests__/Task.stream-idle-timeout.spec.ts` (new, fake timers, mocked `api.createMessage`):
    - A generator yields one text chunk, then never resolves. After advancing 300s: the request controller is aborted with `StreamIdleTimeoutError`, `api_req_started` gets `cancelReason: "streaming_failed"`, and `createMessage` is called a second time (retry).
    - A first-chunk stall longer than the mocked `apiRequestTimeout` goes through the first-chunk retry.
    - A backoff countdown longer than 300s inside the first `next()` does not trigger the idle timeout.
    - On a first-chunk timeout, the request's controller is aborted (assert `signal.aborted` and `signal.reason instanceof StreamIdleTimeoutError`) before the reference is cleared.

**A4:**

- `waitForParallelTask.spec.ts`:
    - Rejects with `Worker failed: <reason>` when `parallelWorkerFailure` is set and the lifetime aborts.
    - Rejects with "loop ended" when `run()` resolves unsettled.
    - Still resolves on `TaskCompleted` emitted before `run()` resolves.
    - The child emits `TaskCompleted`, then `lifetimeSignal` aborts before the provider re-emits: resolves with the `completion_result` text. A later provider `TaskCompleted` is a no-op.
    - The child emits `TaskCompleted`, then `run()` resolves before the provider re-emits: resolves with the completion text.
    - Only the provider emits `TaskCompleted` (child event never fires): still resolves (fallback path).
    - After settling, both `TaskCompleted` listeners (child and provider) are removed.
    - Existing needs-input cases still pass.
- `task/__tests__/Task.parallel-worker-failure.spec.ts` (new):
    - A worker whose `createMessage` always throws a 503 (backoff mocked to resolve) is called exactly 9 times, then calls `failParallelWorker`. `lifetimeSignal` is aborted, `abortReason` is `"streaming_failed"`, and `api_req_started` has `cancelReason: "streaming_failed"`.
    - Interleaved failures in a worker: 3 first-chunk 503s, then a stream that yields one chunk and stalls (idle timeout), then repeated first-chunk 503s. `createMessage` is called exactly 9 times in total, then `failParallelWorker` runs.
    - After a successful response with content, the counter resets. A later run of 8 failures does not fail the worker.
    - A context-window error on a worker still takes the truncation branch and doesn't consume the cap check.
    - The same setup with auto-approval off never asks `api_req_failed`.
    - A non-worker under auto-approval keeps retrying (no cap).
    - The consecutive-mistake limit on a worker fails without an ask.
    - `failParallelWorker` runs while the stream is still yielding (triggered from a mocked presenter on the first finalized tool call): the in-loop abort check labels `api_req_started` with `cancelReason: "streaming_failed"`. A user cancel (`abortReason = "user_cancelled"`) at the same point keeps `"user_cancelled"`.
    - Empty-assistant exhaustion on a worker: after the 9th failure, `apiConversationHistory` still ends with the iteration's user message.
    - `failParallelWorker` throws on a non-worker and is idempotent on a worker.

**B:**

- `ToolRepetitionDetector.spec.ts` (update existing expectations):
    - The 4th identical call gives a nudge with `repeatCount` 3; the 5th and 6th give nudges; the 7th gives `askUser`, then counters reset.
    - A different call resets the count.
    - Limit 0 never blocks; limit 1 nudges on the 2nd call and escalates on the 3rd.
- `presentAssistantMessage` repetition tests (extend the existing presentAssistantMessage spec setup):
    - A nudge pushes the nudge tool error, makes no ask, and doesn't execute the tool.
    - A nudge on a custom tool records `recordToolError("custom_tool", "repetition_nudge")`.
    - Escalation on a non-worker asks `mistake_limit_reached`.
    - Escalation on a worker calls `failParallelWorker` and makes no ask.
- `updateTodoListTool.spec.ts`:
    - An unchanged list gives a no-op result with no `askApproval` and `todoList` untouched.
    - Each of `""`, `"[]"`, `"{\"todos\":[]}"`, and the array param `[]` gives row 2 ("unchanged") when the current list is empty, and row 3 ("empty list ignored") when it is non-empty. None of them gives a tool error.
    - `"just prose"` gives the row 1 tool error and increments the mistake count.
    - An array-of-objects input (the incident shape) is parsed and persisted.
    - An array-of-strings input (`["[ ] a", "[x] b"]`) gives two items.
    - A changed list follows the existing flow (approval plus user-edit paths).

**Gates:**

- `cd src && npx tsc --noEmit`.
- Focused Vitest suites above, then `pnpm test`.
- `pnpm lifecycle:model-check` (includes `parser-scope:model-check`).
- `node scripts/find-missing-translations.js`.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` for each touched file, confirming no suppression count increases in `src/eslint-suppressions.json`. New code uses no `as any`; the Task.ts `;(finalToolUse as any).id` precedent is not to be copied.

## Assumptions to verify

- **V1. Stall 1 cause.** Inferred from persisted state (object `content`, no tool UI or result, assistant message saved). Not reproduced in an extension host. The `presentAssistantMessage-tool-crash` test should reproduce the hang first (red), then pass. The Extension Host log, if retained, should show `[Task#presentAssistantMessage] task 01a101d5-27a3… failed: TypeError: newContent.startsWith is not a function`.
- **V2. OpenAI SDK timeout ends at headers.** Verified in `src/node_modules/openai/client.js` `fetchWithTimeout` (v5.23.2: `clearTimeout` in `finally` after `fetch`). The stream-level timers settle the turn for every provider. They close the HTTP connection only where `metadata.abortSignal` reaches the transport: `OpenAiHandler` and `BaseOpenAiCompatibleProvider` after this change, plus the providers that already forward it (see the A3 known limitation). Anthropic and other SDK handlers were not checked for header-only timeouts.
- **V3. OmniRoute keeps chunks flowing.** OmniRoute and local backends (ds4/vLLM/llama.cpp) are assumed to emit tokens or SSE chunks at least every 300s once the first token arrives, including during reasoning. If a backend pauses mid-stream (for example a KV swap), raise `apiStreamIdleTimeout`.
- **V4. Persistence-wait early return (verified).** `waitForCurrentAssistantMessagePersistence()` (Task.ts ~1140) returns false only when its cancellation has resolved. `cancelAssistantMessagePersistence()` is called from `resetAssistantMessagePersistence()` (the next request, which can't start while the current turn's `pWaitFor` is pending), `abortTask()`, and `dispose()`. In the latter two, `this.abort`/lifetime abort wakes the `pWaitFor`. A failed retry-save with no cancellation throws `"Failed to persist API conversation history before task completion"`. That throw propagates out of the parallel-read section to `presentAssistantMessageSafe`, where the A1 backstop settles the turn. No extra handling is needed.
- **V5. Ask-to-event mapping.** `TaskIdle`/`TaskInteractive` are assumed to fire on worker providers for all `idleAsks`/`interactiveAsks`. The incident's `worker-3.json` confirms this for `mistake_limit_reached`.
- **V6. Retry cap length (accepted).** Workers fail after 9 consecutive failed requests across all retry layers. Fast failures take about 21 minutes of backoff. A provider that accepts and never sends a first chunk takes up to `9 × apiRequestTimeout + 1235 s`, about 5.6 h at 2100 s. This is accepted, as described in A4. The cap is a constant, not a setting.
- **V7. Upstream cancel on disconnect.** OmniRoute is assumed to cancel the upstream llama.cpp/vLLM/ds4 generation when the client socket closes. Live check: start a long generation on the 5090 reader, abort it from Zoo, and confirm the backend's active-slot count drops. If it doesn't, the timeout still settles the turn, but the retry competes with the zombie generation for one of the 3 slots.

## Out of scope and backlog

- Giving parallel workers a persisted `HistoryItem.status` (`completed` or `interrupted`). Workers are outside the lifecycle graph, and adding them needs fan-out modeling (`check-task-fanout-protocol.ts`) and its own ticket.
- A per-worker no-progress watchdog (no new chat message for N minutes). The 30-minute batch deadline was removed on purpose because it discarded long-running work, and A1–A4 plus the bounded condense stream close every identified indefinite wait on a worker's request path without one.
- Forwarding `metadata.abortSignal` in the remaining providers (Anthropic, Gemini, `zai` thinking path, `friendli`, and others). Today their stalled sockets are abandoned after a timeout rather than closed. OmniRoute uses `OpenAiHandler`, which this design fixes.
- Coercing non-string arguments for other tools (`apply_diff`, `edit`, …). The A1 catch turns any such crash into a recoverable tool error; add per-tool coercion only when a model shape is observed.
- Recovering the live incident. W1 can be stopped manually; the parent then receives `state: "cancelled"` or `"failed"` for W1 and resumes integration.
- CHANGELOG and changesets, per AGENTS.md.

## Revision notes (tightening pass, no review yet)

No `design-review.json` existed, so this pass re-checked the design against the source and resolved these ambiguities:

- **A1 catch abort detection.** It is now anchored to the `[RooCode#say]`/`[RooCode#ask] … aborted` throws. The presenter itself never throws an abort error; it returns early on `cline.abort`.
- **A1 partial-block throws.** These are logged and swallowed, not answered. `pushToolResultToUserContent` dedupes on `tool_use_id`, so an early error result would suppress the finalized block's real result.
- **A1 telemetry key.** It uses `toTelemetryToolName(...)`, hoisted out of the validation block, consistent with the existing "never key on raw tool name" rule.
- **Backstop.** Superseded by review finding 3 (see the review responses below). It clears `presentAssistantMessageHasPendingUpdates`. The visible error uses a new i18n key, `errors.presenter_failed`.
- **Between-chunks wiring.** `nextChunkWithAbort` becomes `nextChunk(timeoutMs)`, which reads the request controller per call, because `attemptApiRequest` creates it during the first `next()`.
- **Timeout catch placement.** In `attemptApiRequest`, the controller is aborted before the existing `currentRequestAbortController = undefined`. "Rethrow" means continuing into the existing catch logic.
- **`abortReason`.** `failParallelWorker` always sets `"streaming_failed"`. The earlier per-caller distinction had no mechanism and no consumer that needs it.
- **Retry cap.** Superseded by review finding 2: the cap is now a Task-level counter.
- **Deadlock.** Verified that calling `failParallelWorker` from the presenter is deadlock-free, because `abortTask` doesn't await the loop or presenter.
- **V4 verified.** A false return only occurs on abort/dispose, and a persistence failure throws into the backstop. The A5 row was updated.
- **Tests.** Added cases covering the points above.

## Review responses (design-review.json, CHANGES_REQUESTED)

All 10 findings are addressed. None are backlogged or ignored.

1. **HIGH, abort doesn't cancel HTTP: addressed.** A3 adds "Provider signal wiring". `OpenAiHandler` (every `create` call that has `metadata`) and `BaseOpenAiCompatibleProvider.createStream` now forward `metadata.abortSignal` as the SDK `signal`. A3 lists the providers that still ignore it as a known limitation, and backlogs them. V2 is corrected. New `openai.spec.ts` and `base-openai-compatible-provider.spec.ts` cases assert the signal is passed.
2. **MEDIUM, retry cap: addressed.** A Task-level `parallelWorkerApiFailures` counter is incremented by `failWorkerIfRetriesExhausted(error)` at the first-chunk, mid-stream, and empty-assistant sites. It resets at the content-success point (~4056). The worker fails on the 9th consecutive failure. `retryAttempt` is used for backoff only. The worst case, `9 × apiRequestTimeout + 1235 s` (about 5.6 h at 2100 s), is documented and accepted in A4 and V6 to preserve local prefill. An interleaved-failure test and a counter-reset test are added.
3. **MEDIUM, backstop unlock: addressed.** The backstop returns without changes when `presentAssistantMessageLocked` is true, and never writes the lock. The wrong premise is removed from A1 and the Revision notes. A "backstop while locked mutates nothing" test is added.
4. **MEDIUM, B2 ambiguity: addressed.** B2 is now an ordered table. Row 1 requires non-empty, non-JSON-shaped input that parses to 0 items. Explicit tests cover `""`, `"[]"`, `"{\"todos\":[]}"`, `[]`, and `"just prose"`.
5. **MEDIUM, B1 telemetry name: addressed.** The nudge uses the hoisted `telemetryToolName`. A custom-tool test asserts `"custom_tool"`.
6. **NIT, "outer catch" wording: addressed.** The A4 table row now names the mid-stream catch (~3853) and its `this.abort` branch. The test asserts `cancelReason: "streaming_failed"`.
7. **NIT, dead `handlePartial` guard: addressed.** The parser also overwrites `params.content` with the coerced string, so the preview matches the write. The `handlePartial` guard is dropped as dead code, and a parser test asserts that `params.content` and `nativeArgs.content` are equal.
8. **NIT, timeout contract edges: addressed.** An already-aborted signal rejects immediately with no timer, and handlers are always attached to `next`. Tests are added for both.
9. **NIT, partial-block wording: addressed.** Partial blocks with an `id` get an error result and are not re-presented after in-place finalize. A test is added.
10. **NIT, array-of-string todos: addressed.** The shared `coerceTodosArg` joins string arrays with `"\n"`. A test is added.

## Review responses, round 2 (design-review.json, CHANGES_REQUESTED, 0 HIGH / 1 MEDIUM / 5 NIT)

All 6 findings are addressed. None are backlogged or ignored.

1. **MEDIUM, `onLoopEnded` ordering: addressed.** The false "ordering-safe" claim is removed. `waitForParallelTask` now also listens on `child.on(TaskCompleted)`, which `emitPublicTaskCompleted` emits synchronously, and records `completedText`. The provider listener stays as a fallback. A shared `settle` helper makes the first settle win, and `stopped`/`onLoopEnded`/`needsInput` resolve with `completedText` when it is set. `cleanup()` removes the child listener. Tests cover completion followed by a lifetime abort, and completion followed by `run()` resolving, both before the provider re-emit, plus provider-only fallback and listener removal.
2. **NIT, in-loop abort label: addressed.** The in-loop abort check (~3642) uses `abortStream(this.abortReason ?? "user_cancelled")`. A test runs `failParallelWorker` mid-stream and asserts `streaming_failed`, and a user cancel at the same point keeps `user_cancelled`.
3. **NIT, empty-assistant pop: addressed.** The cap check runs before the history pop, so exhaustion returns with the user message still in history. A test asserts this.
4. **NIT, WriteToFileTool test wording: addressed.** The test asserts that `reset()` is called and `open`/`update` are not.
5. **NIT, backstop on aborted tasks: addressed.** `recoverFromPresenterFailure` returns first when `this.abort || this.abandoned`, before the locked guard. Tests cover both flags.
6. **NIT, B2 partial row and placement: addressed with option (a).** B2 states that the dangling partial `tool` row is accepted and matches the existing error branches. It also states that rows 1–3 run before `approvedTodoList = cloneDeep(normalizedTodos)`.

Line references were re-checked against the current tree. The in-loop abort site is at ~3634–3642 and the mid-stream `cancelReason` is at ~3856. The provider forwarder is at ClineProvider.ts ~431–446, and `emitPublicTaskCompleted` is at AttemptCompletionTool.ts ~327.

## Review responses, round 3 (design-review.md, CHANGES_REQUESTED, 0 HIGH / 1 MEDIUM / 4 NIT)

All 5 findings are addressed. None are backlogged or ignored.

1. **MEDIUM, auto-condense stream unbounded: addressed with option (a).** `summarizeConversation` bounds its stream with `awaitWithStreamTimeout` (first chunk: `apiRequestTimeout`; later chunks: the idle timeout) and aborts its own `condenseController` on timeout, which yields `result.error` and the existing sliding-window fallback. A5 gains the condense row, "Files changed" lists `src/core/condense/index.ts`, and the backlog's "close every indefinite wait" claim now reads "A1–A4 plus the bounded condense stream close every identified indefinite wait on a worker's request path". `src/core/tools/todoArgs.ts` is also listed: it keeps `coerceTodosArg` import-free so the parser bundle stays vscode-free.
2. **NIT 2, cancellations counted as API failures: addressed.** `failWorkerIfRetriesExhausted` starts with `if (!this.parallelWorker || this.abort) return false` (A4).
3. **NIT 3, upstream slot release unverified: addressed.** Added V7 with a live check against the 5090 reader's active-slot count.
4. **NIT 4, idle timeout after executed tools: addressed (accepted).** A3 "On timeout" states that a between-chunk timeout after side-effecting tools ran retries the whole turn and may repeat them, and the A error table gains the matching row.
5. **NIT 5, `didToolFailInCurrentTurn`: addressed.** B2 row 1 sets it. The B1 nudge does not, because the call was skipped rather than failed and setting it would block a same-message `attempt_completion`.
