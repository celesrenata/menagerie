# Zoo parallel-worker resilience: turn settlement, bounded stream waits, worker retry cap, and a softer loop guard

Reviewed `git diff 5cf33f0a9..HEAD` (4 commits: af4569b03, f406a6829, a28255745, de6d8a7d1) on `feat/omniroute-tier-dropdown-feat005` against the approved design (with its round-3 responses), the round-3 design review, and plan decisions D1–D9. Review date 2026-10-03.

The branch implements the design for the hung `parallel_tasks` batch of 2026-10-03. A throw from tool dispatch now always answers the tool_use with one error result and settles the turn. The parser coerces the two observed bad argument shapes (object `write_to_file.content`, array `update_todo_list.todos`). Stream waits are bounded: the first chunk by `apiRequestTimeout`, later chunks by the new `zoo-code.apiStreamIdleTimeout`, and the auto-condense summarizer by both. The task's abort signal now reaches the OpenAI SDK, so a timeout closes the socket. Parallel workers fail without asking anyone, and stop after 9 consecutive failed requests. The repetition guard nudges the model before it escalates, and `update_todo_list` treats unchanged or empty lists as no-ops. Every item on the reviewer checklist matches the code, and the verification evidence is complete.

Watch for: two NITs. The timeout error text promises a retry on paths that don't retry automatically (confirmed). One new block in `updateTodoListTool.spec.ts` has double casts with no comment (confirmed). There is also one accepted behavior change: a queued-approval persistence failure inside a tool now gives the model an error tool_result and counts as a mistake. It used to reject the presenter and hang the turn.

**Verdict**: APPROVED

## High-level view

Turn settlement has three layers. The presenter's catch wraps both the native and the MCP dispatch. It rethrows on abort, ignores `AskIgnoredError`, and only logs a partial-block throw. Any other throw is answered once through `handleError`, which is protected by both the `hasToolResult` guard and Task's `tool_use_id` dedupe, and it records the telemetry-safe name. If a presenter throw escapes the dispatch, the Task backstop handles it, but only when the task is alive and the presenter is unlocked. The stream-end guard covers a backstop that ran before the stream finished. Because the catch is general, it also turns queued-approval persistence failures into error results. Two existing tests were updated for that.

The parser coerces arguments in both the partial and final cases. It writes the same string into `params` and `nativeArgs`, so the diff preview, the persisted tool_use, and the executed write all agree. `coerceTodosArg` lives in the import-free `todoArgs.ts` (D1).

The first-chunk wait reads `apiRequestTimeout` on every request. The between-chunk wait reads the new setting once per request, and the first `next()` is exempt. On a timeout the controller is aborted before anything clears it, and `attemptApiRequest` uses its own local reference for this (D2). The error text that is shown says "will be retried", even on paths where nothing retries automatically.

The condense stream has its own controller. It is linked to the caller's signal and unlinked in `finally`. A timeout aborts that controller, so the call returns `result.error` and `manageContext` falls back to truncation.

The worker changes cover every site in the A4 table. `failParallelWorker` records the failure reason before its first await. The retry helper ignores cancellations (NIT 2). The empty-assistant cap check runs before the history pop. `waitForParallelTask` lets the first outcome win, and the child's own `TaskCompleted` counts as an outcome.

The setting is VS Code contributed configuration only. The i18n and nls keys are complete in all 18 locales. `taskLifecycle.ts` is untouched, and the only suppression change is a decrease.

<details>
<summary>Issues (2)</summary>

1. **Timeout message promises a retry** (NIT, confirmed): `StreamIdleTimeoutError` always says "the request was aborted and will be retried". That text reaches the user through `condense_api_failed`, where the actual fallback is truncation, and through the non-auto-approval `api_req_failed` ask, where the user has to click Retry. Shorten the message to "...; the request was aborted." and let callers add the retry wording.
2. **Uncommented double casts in the A2 spec block** (NIT, confirmed): `updateTodoListTool.spec.ts`, describe "non-string todos (A2 coercion)", has `makeTask`/`makeCallbacks` using `as unknown as Task` and `as unknown as ToolCallbacks` with no explaining comment. AGENTS.md requires one, and the B2 helpers in the same file have one. Add the same one-line comment.

</details>

<details>
<summary>Details</summary>

### Dispatch catch and the queued-approval persistence change

```
tool throw ──► presenter catch (tool / MCP) ──► one is_error result ──► index++ ──► ready
                    │ abort → rethrow
presenter throw ────┴──► presentAssistantMessageSafe ──► recoverFromPresenterFailure
                                                          (skips if aborted/abandoned or locked)
stream end, presenter idle, index ≥ length ──► stream-end guard sets ready
```

B1's worker escalation sits inside the dispatch `try`. It pushes its tool error before it calls `failParallelWorker`. After that call the task is aborted, so anything that throws later is rethrown by the catch's abort rule, and the backstop's dead-task guard then ignores it.

The general catch also changes an existing contract. `presentAssistantMessage-unknown-tool.spec.ts` used to assert that a failure in `persistQueuedFeedbackAndAcknowledge` made the presenter reject and left `userMessageContent` empty. In production, `presentAssistantMessageSafe` logged and dropped that rejection, so the turn hung. Now the model gets `Error executing new_task: Failed to persist queued approval feedback …`, and the mistake count goes up. The user's queued denial reaches the model as a generic tool error, not as a denial. Repeated persistence failures reach the mistake-limit ask, and for a worker they fail it. This matches the design's "Tool dispatch, any non-abort throw" row and is recorded as a deviation in FEAT-001. `AttemptCompletionTool`'s "Failed to persist queued completion feedback" throw follows the same path.

### Timeout wording and how far the abort reaches

Three consumers share `StreamIdleTimeoutError`'s message, but only the worker and auto-approval retry paths actually retry. Condense shows it as `Condensing API call failed: No data received … will be retried.`, but the fallback is truncation, or nothing when context is under the limit. A non-worker with auto-approval off sees the same "will be retried" text in an ask that waits for a Retry click. The design specified this text before condense reused it.

Forwarding the signal and adding the first-chunk timer change two behaviors outside the incident:

- `abortTask`/`cancelCurrentRequest` now actually cancel `OpenAiHandler` and `BaseOpenAiCompatibleProvider` HTTP requests. Before, they only detached Task's race.
- The first-chunk timer limits the SDK's internal `maxRetries` loop to a single `apiRequestTimeout` window, and Zoo's own backoff takes over the retries.

For providers that ignore `metadata.abortSignal`, the `iterator.return()` call stays queued on a generator that never resumes. That is the documented known limitation. Whether OmniRoute actually frees the backend slot (V7) has not been verified.

### Test coverage

The design's full test plan is present, along with the round-3 additions:

- condense idle and first-chunk timeouts, with the summarizer signal aborted
- the NIT 2 cancellation case
- the B2 "just prose" case, which asserts `didToolFailInCurrentTurn`

Beyond the plan, there are cases for the D2 cleared-field first-chunk timeout, the mid-stream `OutputTokenLimitError` worker failure, and listener cleanup across all six `waitForParallelTask` settle paths. The fixer's red/green mutations show that the tool-crash, backstop, stream-timeout, and worker-failure specs fail without the fix.

Not tested:

- Real upstream slot release on OmniRoute (V7). This needs a live check.
- The queued `return()` on providers that don't forward the signal.
- The full chain from a condense timeout to `manageContext` truncation. Two tests cover it in halves: the new `result.error` assertion, and the existing context-management test "should fall back to truncateConversation when … summarization fails".

### Reviewer checklist

- A1: confirmed in `presentAssistantMessage.ts` (both catches), `Task.recoverFromPresenterFailure`, and the stream-end guard just before the turn `pWaitFor`. Tool results are deduped by `hasToolResult` plus `pushToolResultToUserContent`. Abort errors are rethrown. Telemetry uses `telemetryToolName` or `"use_mcp_tool"`, never `block.name`.
- A2: confirmed. The parser coerces in both the partial and final cases, and `params` matches `nativeArgs`. The `WriteToFileTool` guard runs before `startsWith`. `todoArgs.ts` has no imports and is re-exported from `UpdateTodoListTool.ts`. `parser-scope:model-check` passes (verification #5).
- A3: confirmed. The contract tests are in `streamIdleTimeout.spec.ts`. The first-chunk wait uses `getApiRequestTimeout()` per request, and later chunks use `getApiStreamIdleTimeout()` once per request. The controller is aborted before it is cleared, through the local `requestAbortController` and as the first statement of the mid-stream catch. The signal is forwarded at all 4 `openai.ts` create sites and in `base-openai-compatible-provider.ts`, and `completePrompt` is unchanged. NIT 4 appears in a code comment and in the design's A3 text and error table.
- Round-3 MEDIUM: confirmed in `condense/index.ts`. The condense spec has "stream bounds" tests for the idle timeout, the first-chunk timeout, and outer-signal forwarding.
- A4: confirmed.
    - `failParallelWorker` and `PARALLEL_WORKER_MAX_API_RETRIES = 8` are present.
    - The helper returns early on `|| this.abort`, and that case has a test.
    - All six sites are wired, and both `cancelReason` tweaks are in.
    - The empty-assistant check runs before the pop.
    - `waitForParallelTask` has `settle`, `completedText`, and a listener on the child's `TaskCompleted`, and calls `run().then(onLoopEnded, onLoopError)`.
- B1: confirmed. The detector nudges at `>= limit`, and at `>= 2 * limit` it escalates and resets the counters. The nudge sets neither the mistake count nor the turn-failure flag. A worker escalation answers the call, then fails without an ask.
- B2: confirmed. The rows run in order, before `approvedTodoList = cloneDeep(...)`. Row 1 sets the turn-failure flag, and the test asserts it.
- Setting: confirmed. The changes are only in `package.json` and the 18 `package.nls*.json` files, with no ContextProxy, global-settings, or webview change. Both i18n keys are in all 18 `common.json` files.
- Hygiene: confirmed.
    - The diff touches nothing under `taskLifecycle.ts`, `webview-ui`, `packages`, CHANGELOG, `.changeset`, or `.agents`.
    - The new files contain no `any`.
    - The `any` usages moved in `timeout-config.spec.ts` and the re-indented `executionError: any` are pre-existing, and their counts are unchanged.
    - `eslint-suppressions.json` changes only by removing the `ToolRepetitionDetector.spec.ts` entry (3 → 0).
- design.md: confirmed. It has V7, the NIT 4 sentence and table row, the A5 condense row, the `todoArgs.ts` and `condense/index.ts` Files-changed entries, and "Review responses, round 3".
- Verification evidence: complete. `verification.md` covers each FEAT plus integration:
    - `tsc` is clean.
    - The full src suite has 28 failures, identical on the base. `pnpm test` fails only on those.
    - The lint ratchet ran over all 30 `.ts` files.
    - `lifecycle:model-check` passes.
    - The BACKEND and PACKAGE.NLS translation checks are clean.

    No spot-check was needed.

</details>

<details>
<summary>File map</summary>

- `src/core/assistant-message/presentAssistantMessage.ts`: dispatch catch (tool + MCP), hoisted telemetry name, B1 nudge and worker escalation.
- `src/core/assistant-message/NativeToolCallParser.ts`: `coerceFileContent`, todo coercion, partial and final.
- `src/core/tools/todoArgs.ts` (new): import-free `coerceTodosArg`.
- `src/core/tools/UpdateTodoListTool.ts`: coercion, re-export, B2 no-op table.
- `src/core/tools/WriteToFileTool.ts`: non-string content guard.
- `src/core/tools/ToolRepetitionDetector.ts`: nudge/escalate union result.
- `src/core/prompts/responses.ts`: `toolRepetitionNudge`.
- `src/core/task/streamIdleTimeout.ts` (new): `awaitWithStreamTimeout`, `StreamIdleTimeoutError`.
- `src/core/task/Task.ts`: backstop, stream-end guard, first-chunk/idle timeouts, worker failure API, retry cap and sites, `cancelReason` tweaks.
- `src/core/task/runParallelTasks.ts`: `waitForParallelTask` settle, child completion listener, failure reason, `onLoopEnded`.
- `src/core/condense/index.ts`: bounded summarizer stream with a linked controller.
- `src/api/providers/openai.ts`, `src/api/providers/base-openai-compatible-provider.ts`: abort signal forwarding.
- `src/api/providers/utils/timeout-config.ts`: `getApiStreamIdleTimeout`.
- `src/package.json`, `src/package.nls*.json` (18): `zoo-code.apiStreamIdleTimeout`.
- `src/i18n/locales/*/common.json` (18): `errors.presenter_failed`, `errors.parallel_worker_failed`.
- `src/eslint-suppressions.json`: removed `ToolRepetitionDetector.spec.ts` entry.
- Specs: 6 new (`presentAssistantMessage-tool-crash`, `presentAssistantMessage-repetition`, `Task.presenter-backstop`, `Task.stream-idle-timeout`, `Task.parallel-worker-failure`, `streamIdleTimeout`), 10 extended or updated.

Full diff: `git -C /Users/celes/sources/celesrenata/menagerie diff 5cf33f0a9..HEAD`.

</details>
