# Implementation Plan: Zoo parallel-worker resilience

Repo `/Users/celes/sources/celesrenata/menagerie`, branch `feat/omniroute-tier-dropdown-feat005` (HEAD `5cf33f0a9`, no worktree). Every path below is absolute or relative to `/Users/celes/sources/celesrenata/menagerie/src` when it starts with `core/`, `api/`, `i18n/`, `package`. Always pass an absolute `cwd`; relative paths otherwise land in the workspace root.

Sources: approved design `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/zoo-worker-resilience/design.md`, round-3 review `.../zoo-worker-resilience/design-review.md` (0 HIGH, 1 MEDIUM, 4 NIT; all handled below), `AGENTS.md`, `docs/architecture/task-lifecycle-model.md`.

## Planning decisions (grounded in code read during planning)

- **D1. `coerceTodosArg` lives in a new import-free leaf module** `src/core/tools/todoArgs.ts` and is re-exported from `UpdateTodoListTool.ts` (so the design's API location still holds). Reason: if `NativeToolCallParser.ts` imported `UpdateTodoListTool.ts`, the chain `responses.ts → RooIgnoreController.ts → import * as vscode` would put `require("vscode")` into the esbuild bundle built by `pnpm parser-scope:model-check` (`scripts/run-native-tool-call-parser-scoping.mjs`, `external: ["vscode"]`). Verified with a probe bundle: today's parser bundle has 0 `require("vscode")`; a bundle importing `UpdateTodoListTool` has 1 and crashes under plain node.
- **D2. `attemptApiRequest` keeps the request controller in a local** (`const requestAbortController = new AbortController(); this.currentRequestAbortController = requestAbortController`) and aborts that local on timeout. Same behavior as the design's `this.currentRequestAbortController?.abort(error)` in the normal case, and still correct if the field was cleared or replaced.
- **D3. Mid-stream timeout cleanup calls `void stream.return(undefined).catch(() => {})`.** `iterator` is declared inside the `try` (Task.ts ~3415), so it is out of scope in the catch. `stream[Symbol.asyncIterator]()` returns the same generator, so this is equivalent.
- **D4. Condense signal linking.** `summarizeConversation` creates `condenseController`. It links the incoming `metadata.abortSignal` to that controller (abort-forwarding listener, removed in `finally`), so an outer cancel still cancels the summarizer request the way it does today. It passes `abortSignal: condenseController.signal` inside `summaryMetadata` only when `metadata` is defined, which keeps the existing "metadata undefined → createMessage third arg `undefined`" assertion. Production callers (Task.ts ~2086 manual condense, context-management ~361 auto) always pass metadata.
- **D5. `ToolRepetitionDetector.check` returns a union** whose non-matching members declare `nudge?: undefined; askUser?: undefined`. Existing `result.askUser` accesses in specs and the presenter keep typechecking.
- **D6. Task-level specs that run the real request loop use real timers**, with `api/providers/utils/timeout-config` mocked to tiny values (30–80 ms). Fake timers would stall the loop's `setImmediate` yields and the fs mocks. Pure-unit specs (`streamIdleTimeout.spec.ts`, condense) use fake timers, as the design says.
- **D7. B1 presenter repetition tests go in a new any-free file** `core/assistant-message/__tests__/presentAssistantMessage-repetition.spec.ts`. It copies the `vi.mock` preamble from `presentAssistantMessage-custom-tool.spec.ts` (the design's "extend the existing presentAssistantMessage spec setup"). New spec files have zero `no-explicit-any` suppression budget. Mock tasks are typed objects cast once with `as unknown as Task` and a comment, following the `Task.abort-reason-race.spec.ts` precedent.
- **D8. `UpdateTodoListTool.execute` coerces `params.todos ?? ""`.** An undefined value keeps today's empty-string handling and lands on B2 rows 2/3. The parser never builds `nativeArgs.todos` as undefined anyway. A non-coercible value (number or boolean) still gets the "not valid markdown checklist or JSON" error.
- **D9. Round-3 documentation items** (MEDIUM A5 row and Files-changed entry, the "close every indefinite wait" claim, NIT 2, NIT 3 V7, NIT 4, NIT 5) are written into `design.md` as inline edits plus a "Review responses, round 3" section (item 1). Two code comments carry the runtime-relevant ones: NIT 4 at the between-chunks catch and the V7 assumption at the provider signal wiring.

## Confirmations made during planning

- **Settings classification.** `apiRequestTimeout` appears only in `src/package.json`, the 18 `src/package.nls*.json` files, `api/providers/utils/timeout-config.ts`, and its spec. It does not appear anywhere in `webview-ui/`, `packages/`, or `apps/`, and it is absent from `global-settings`, `ExtensionState`, `SettingsView`, `ClineProvider.getState*`, and import/export. `zoo-code.apiStreamIdleTimeout` follows the same VS Code contributed-configuration pattern. So the AGENTS.md **Persisted Setting Checklist does not apply**, and **no webview-ui change or webview-ui test is needed**. The new i18n keys are backend `common.json` keys with no webview consumer.
- **Lifecycle.** Parallel workers are outside the persisted delegation graph. The parent stays `active` and `awaitingChildId` is never set. Fan-out is excluded from the baseline per the lifecycle doc. So **`src/core/task-persistence/taskLifecycle.ts` gets no change**. `pnpm lifecycle:model-check` passes on HEAD (run during planning). It includes `parser-scope:model-check`, which is why D1 matters. No E2E is added, because no restart, rehydration, or webview-scoping boundary changes.
- **Baselines on HEAD:**
    - `cd /Users/celes/sources/celesrenata/menagerie/src && npx tsc --noEmit` is clean.
    - The 21 existing spec files this work touches pass (648 tests).
    - `node scripts/find-missing-translations.js` reports nothing missing.
- **Incident shapes (read-only check of globalStorage):**
    - W1 `01a101d5-27a3…`: the last assistant message (13:51:21Z) has 4 `write_to_file` calls, and the first (`web/package.json`) has `content` as an object.
    - W3 `01a101d5-27a6…`: 7 of 11 `update_todo_list` calls send `todos` as an array of `{content,status}` objects.
    - `parallel-tasks/a37b7cdb…/worker-3.json` is `failed`, "Worker needs input (mistake_limit_reached)…".
    - Use these shapes as test fixtures.
- **ESLint ratchet churn (verified).** Running `--prune-suppressions` on one file rewrites `src/eslint-suppressions.json` with about 1711/1711 lines of formatting-only churn. HEAD's format is exactly `jq -S --tab .`.

## Verification commands (used by every item)

```sh
# focused tests (paths relative to src/)
cd /Users/celes/sources/celesrenata/menagerie/src && npx vitest run <paths>
# typecheck
cd /Users/celes/sources/celesrenata/menagerie/src && npx tsc --noEmit
# lint ratchet: run on EVERY touched src file (prod + spec), paths relative to src/
cd /Users/celes/sources/celesrenata/menagerie && pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <files>
# then recover from formatting-only churn:
git show HEAD:src/eslint-suppressions.json | jq -S . > /tmp/supp-head.json
jq -S . src/eslint-suppressions.json > /tmp/supp-now.json
diff /tmp/supp-head.json /tmp/supp-now.json || true
#   empty diff            -> git checkout -- src/eslint-suppressions.json
#   only count DECREASES  -> jq -S --tab . src/eslint-suppressions.json > /tmp/supp.json && mv /tmp/supp.json src/eslint-suppressions.json  (stage it)
#   any INCREASE / new key -> fix the code (no `any`), never keep the increase
rm -f /tmp/supp-head.json /tmp/supp-now.json
# lifecycle + parser-scope model checks
cd /Users/celes/sources/celesrenata/menagerie && pnpm lifecycle:model-check
# i18n completeness (BACKEND + PACKAGE.NLS sections must list nothing missing)
cd /Users/celes/sources/celesrenata/menagerie && node scripts/find-missing-translations.js
```

Constraints for every item (AGENTS.md):

- No `as any`, and no `any` at all in new files. Use bracket notation for private members (`task["recoverFromPresenterFailure"]`), `unknown` plus a type guard, or a single commented `as unknown as T` as a last resort.
- No floating promises (use `void`, `await`, or `.catch`).
- No `.changeset` files, and no `CHANGELOG.md` or `src/CHANGELOG.md` edits.
- Commits stage explicit paths only. Never stage anything under `.agents/`, and never use `git add -A` or `git add .`.
- The pre-commit hook runs `lint-staged` and `pnpm lint`. Allow at least 15 minutes. Never use `--no-verify`. If the hook fails, fix the problem and make a new commit.
- Never push.

---

## FEAT-001: Turn settlement and argument coercion (A1, A2)

- [ ]   1. **Record the round-3 responses in the design doc (D9).**
       Edit `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/zoo-worker-resilience/design.md`:
        - (a) A3 "On timeout": add the sentence "A between-chunk timeout after side-effecting tools already ran is accepted: it takes today's mid-stream-failure path, discards the assistant content and retries, so the retried turn may repeat those tools (e.g. `execute_command`, `write_to_file`)."
        - (b) Add the matching row to "Error handling summary (A)": `Between chunks | Timeout after tools executed | Yes (retry) | streaming_failed + retry; tools may run again | console.error`.
        - (c) A4: `failWorkerIfRetriesExhausted`'s first line is `if (!this.parallelWorker || this.abort) return false` (cancellations are not API failures).
        - (d) B2 row 1 also sets `didToolFailInCurrentTurn = true`. The B1 nudge does not set it, because the call was skipped, not failed, and setting it would block a same-message `attempt_completion`.
        - (e) Add V7: "OmniRoute is assumed to cancel the upstream llama.cpp/vLLM/ds4 generation when the client socket closes. Live check: start a long generation on the 5090 reader, abort it from Zoo, and confirm the backend's active-slot count drops. If it doesn't, the timeout still settles the turn, but the retry competes with the zombie generation for one of the 3 slots."
        - (f) Add an A5 row: "Auto-condense summarizer stream stalls (attemptApiRequest/handleContextWindowExceededError → manageContext → summarizeConversation) → first-chunk/idle timeout aborts `condenseController` → `result.error` → sliding-window truncation → request proceeds."
        - (g) Add `src/core/condense/index.ts` and `src/core/tools/todoArgs.ts` (D1) to "Files changed".
        - (h) Replace "A1–A4 close every observed and identified indefinite wait" with "A1–A4 plus the bounded condense stream close every identified indefinite wait on a worker's request path".
        - (i) Add a "Review responses, round 3" section listing the five findings and these edits.
          Files: design.md only.
          Verify: doc-only. The final reviewer checks it against design-review.md.

- [ ]   2. **A1 presenter dispatch catch** in `core/assistant-message/presentAssistantMessage.ts`.
        - In the `tool_use` case, right after `const taskMode = await cline.getTaskMode()` (~466), hoist:
            - `const isCustomTool = Boolean(stateExperiments?.customTools && customToolRegistry.has(block.name))`
            - `const telemetryToolName = toTelemetryToolName(block.name, isCustomTool, stateExperiments)`

            Delete the inner `const isCustomTool` (~730). Use `telemetryToolName` for the validation-catch `recordToolError` (~766) and as `recordName` (~777).

        - Wrap everything from `// Check for identical consecutive tool calls.` (~791) through the closing brace of `switch (block.name)` (~1092) in `try { … } catch (error) { … }`. The catch runs, in order:
            1. `if (cline.abort || (error instanceof Error && error.message.endsWith("aborted"))) throw error`
            2. `if (error instanceof AskIgnoredError) return`
            3. `if (block.partial) { console.warn(\`[presentAssistantMessage] task ${cline.taskId}: ${block.name} threw while partial\`, error); return }`
            4. `const err = error instanceof Error ? error : new Error(String(error))`, then `console.error` with the task id and tool name, `cline.consecutiveMistakeCount++`, `cline.recordToolError(telemetryToolName, err.message)`, `cline.didToolFailInCurrentTurn = true`, and `await handleError(\`executing ${block.name}\`, err)`.
        - In the `mcp_tool_use` case, wrap the server-name resolution plus `await useMcpToolTool.handle(…)` (~385–429) the same way. Use `mcpBlock.partial` and that case's local `handleError`. The telemetry name is the constant `"use_mcp_tool"`.
        - `break` statements inside the try keep their current meaning (they leave the `switch (block.type)` case).
          Files: core/assistant-message/presentAssistantMessage.ts
          Verify: `npx vitest run core/assistant-message` passes (the existing custom-tool, unknown-tool, images, and attribution specs are unchanged). Lint ratchet on the file: `no-explicit-any` count stays ≤ 2.

- [ ]   3. **A1 Task backstop, stream-end guard, and `errors.presenter_failed` i18n.**
        - `core/task/Task.ts` `presentAssistantMessageSafe()` (~485): after the existing `console.error`, call `this.recoverFromPresenterFailure(error)`.
        - Add `private recoverFromPresenterFailure(error: unknown): void`, which does the following in order:
            1. `if (this.abort || this.abandoned) return`
            2. `if (this.presentAssistantMessageLocked) { console.warn(…taskId…); return }`
            3. Let `message = error instanceof Error ? error.message : String(error)`.
            4. For each block in `this.assistantMessageContent.slice(this.currentStreamingContentIndex)` with `type === "tool_use" || type === "mcp_tool_use"` and an `id` (including partial blocks): if `this.userMessageContent` has no `tool_result` whose `tool_use_id === sanitizeToolUseId(id)`, call `this.pushToolResultToUserContent({ type: "tool_result", tool_use_id: sanitizeToolUseId(id), is_error: true, content: formatResponse.toolError(\`Tool execution failed unexpectedly: ${message}. Fix the arguments and retry.\`) })`.
            5. Set `this.currentStreamingContentIndex = this.assistantMessageContent.length` and `this.presentAssistantMessageHasPendingUpdates = false`.
            6. `if (this.didCompleteReadingStream) this.userMessageContentReady = true`
            7. `void this.say("error", t("common:errors.presenter_failed", { message })).catch((e) => console.error(…))`

            Never write `presentAssistantMessageLocked`.

        - Stream-end guard: immediately before `await pWaitFor(() => this.userMessageContentReady || this.abort || this.abandoned)` (~4227), add `if (!this.presentAssistantMessageLocked && this.currentStreamingContentIndex >= this.assistantMessageContent.length) this.userMessageContentReady = true`. The `pWaitFor` stays unbounded.
        - i18n: add `"presenter_failed": "Tool execution failed unexpectedly: {{message}}. The model was sent an error result for the unanswered tool calls."` under `errors` in `src/i18n/locales/en/common.json`, and real translations in the other 17 `src/i18n/locales/<ca,de,es,fr,hi,id,it,ja,ko,nl,pl,pt-BR,ru,tr,vi,zh-CN,zh-TW>/common.json`. Keep `{{message}}` verbatim.
          Files: core/task/Task.ts, src/i18n/locales/\*/common.json (18)
          Verify:
        - `npx tsc --noEmit` is clean.
        - `npx vitest run core/task/__tests__/Task.spec.ts` passes.
        - `node scripts/find-missing-translations.js` reports nothing missing.

- [ ]   4. **A2 coercion in the parser and the todo tool.**
        - New `core/tools/todoArgs.ts` (no imports) exporting `coerceTodosArg(value: unknown): unknown`:
            - A string is returned unchanged.
            - A non-empty array whose elements are all strings becomes `value.join("\n")`.
            - Any other array, including `[]` (the design's B2 table says `[]` coerces to `"[]"`), or a plain object (`typeof value === "object" && value !== null`), becomes `JSON.stringify(value)`.
            - Anything else is returned unchanged.
        - `core/tools/UpdateTodoListTool.ts`:
            - Add `export { coerceTodosArg } from "./todoArgs"`.
            - In `execute`, replace `parseMarkdownChecklist(todosRaw || "")` with `const todosString = coerceTodosArg(params.todos ?? "")` (D8). If `typeof todosString !== "string"`, run the existing invalid-checklist branch (mistake++, `recordToolError`, `didToolFailInCurrentTurn = true`, `toolError("The todos parameter is not valid markdown checklist or JSON")`, return). Otherwise call `parseMarkdownChecklist(todosString)`.
            - `parseMarkdownChecklist` stays unchanged.
        - `core/assistant-message/NativeToolCallParser.ts`:
            - Add `private static coerceFileContent(value: unknown): unknown`. A string is returned unchanged. An object or array (`typeof value === "object" && value !== null`) becomes `JSON.stringify(value, null, 2) + "\n"`. Anything else is returned unchanged.
            - Import `coerceTodosArg` from `"../tools/todoArgs"`.
            - Partial `createPartialToolUse`:
                - `write_to_file` case (~503): compute `const content = NativeToolCallParser.coerceFileContent(partialArgs.content)`, use it in `nativeArgs.content`, and `if (typeof content === "string") params.content = content`.
                - `update_todo_list` case (~586): `const todos = coerceTodosArg(partialArgs.todos)`, put it in `nativeArgs`, and `if (typeof todos === "string") params.todos = todos`.
            - Final `parseToolCall`: make the same changes in `update_todo_list` (~934) and `write_to_file` (~953), after the generic params loop has run.
              Files: core/tools/todoArgs.ts (new), core/tools/UpdateTodoListTool.ts, core/assistant-message/NativeToolCallParser.ts
              Verify:
        - `npx vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts core/tools/__tests__/updateTodoListTool.spec.ts` passes.
        - `pnpm parser-scope:model-check` (from the repo root) passes, which proves D1 kept vscode out of the bundle.

- [ ]   5. **A2 `WriteToFileTool` string guard.**
       In `execute`, directly after the `newContent === undefined` branch (~45), add `if (typeof newContent !== "string")`. That branch does `task.consecutiveMistakeCount++`, `task.recordToolError("write_to_file")`, `task.didToolFailInCurrentTurn = true`, `pushToolResult(formatResponse.toolError("write_to_file content must be a string containing the full file text"))`, `await task.diffViewProvider.reset()`, and returns. `handlePartial` is unchanged.
       Files: core/tools/WriteToFileTool.ts
       Verify: `npx vitest run core/tools/__tests__/writeToFileTool.spec.ts` passes.

- [ ]   6. **FEAT-001 tests.** Each file must be `any`-free if new. Existing files must not gain `any`.
        - `core/assistant-message/__tests__/presentAssistantMessage-tool-crash.spec.ts` (new). Copy the custom-tool spec's `vi.mock` preamble, and also mock `../../tools/WriteToFileTool` and `../../tools/UseMcpToolTool` with `handle: vi.fn()`. The task double needs `checkpointSave: vi.fn()`, `didToolFailInCurrentTurn`, `currentStreamingDidCheckpoint`, and `pushToolResultToUserContent` with the same dedupe implementation. Cases:
            1. A `write_to_file` block whose `handle` rejects with `TypeError("newContent.startsWith is not a function")` yields exactly one `is_error`-shaped tool_result for its id: the content is a `toolError` JSON containing "executing write_to_file". Also assert `say("error", …)` is called.
            2. With `didCompleteReadingStream = true`, `currentStreamingContentIndex` advances to `length` and `userMessageContentReady` is true.
            3. In a message with two blocks, the second (a mocked `read_file` or a text block) still executes.
            4. A rejection `new Error("[RooCode#say] task t.i aborted")` is rethrown (`await expect(presentAssistantMessage(task)).rejects.toThrow("aborted")`) and pushes no result. Same when `task.abort = true`.
            5. An MCP block (`type: "mcp_tool_use"`, name `mcp--srv--tool`) whose `useMcpToolTool.handle` rejects gives one error result, and `recordToolError` is called with `"use_mcp_tool"` (never the raw name).
            6. A throw on a `partial: true` block pushes no result. The finalized block, whose `handle` then calls `pushToolResult("ok")`, gets exactly one result with content "ok".
            7. In the write_to_file crash, `recordToolError` is called with `"write_to_file"` (the `toTelemetryToolName` value). With `isValidToolName` mocked to return false for that test, it is called with `"invalid_tool_call"`, never the raw `block.name`.
            8. `consecutiveMistakeCount` is incremented, and `didToolFailInCurrentTurn` becomes true.
        - `core/task/__tests__/Task.presenter-backstop.spec.ts` (new). Use the lightweight `makeMockProvider()` preamble from `Task.abort-reason-race.spec.ts`. Mock `../../assistant-message` as `{ ...actual, presentAssistantMessage: vi.fn(actual.presentAssistantMessage) }`, and mock `p-wait-for` with an implementation that records `task.userMessageContentReady` at call time. Drive the backstop with `vi.mocked(presentAssistantMessage).mockRejectedValueOnce(new Error("boom"))` + `task["presentAssistantMessageSafe"]()` + `await new Promise((r) => setImmediate(r))`. Cases:
            1. Every unanswered `tool_use`/`mcp_tool_use` from the index onward gets one `is_error` result. Index = length, ready = true (stream complete), and `say("error", …presenter_failed…)` is called once.
            2. Stream-end guard (through `recursivelyMakeClineRequests` with `task["attemptApiRequest"]` replaced by a generator yielding one text chunk, and the mocked presenter setting `currentStreamingContentIndex = length`): ready is true when pWaitFor is called. With the presenter also setting `presentAssistantMessageLocked = true`, it is false. Set `task.abort = true` inside the pWaitFor mock to end the loop.
            3. After a backstop, a text block appended later and presented with the real presenter runs (`say("text", …)` is called).
            4. A backstop while `presentAssistantMessageLocked = true` changes nothing: no results, no index change, no ready flag, no `say`.
            5. A partial tool_use that is unanswered at recovery gets one error result. After it is finalized in place (`partial: false`) and presented again, the tool handler is not called and the block still has exactly one result.
            6. A `"…aborted"` rejection triggers no recovery and no `say`.
            7. A non-abort rejection after `abortTask()` (with `dispose` stubbed), and separately with `abandoned = true`, triggers no recovery, no result, no index change, and no `say`.
        - `core/assistant-message/__tests__/NativeToolCallParser.spec.ts`, add a `describe("argument coercion")`:
            1. An object `content` (the incident `{"name":"web",…}`) and an array `content` become `JSON.stringify(v, null, 2) + "\n"`. String content is unchanged.
            2. For object `content`, `nativeArgs.content === params.content` for both the final `parseToolCall` and the streaming partial (`startStreamingToolCall` / `processStreamingChunk`) result.
            3. An array of `{content,status}` objects for `todos` (the W3 shape) becomes a JSON string, and `parseMarkdownChecklist` on it yields the items.
            4. `["[ ] a", "[x] b"]` for `todos` becomes `"[ ] a\n[x] b"`.
        - `core/tools/__tests__/writeToFileTool.spec.ts`: build a `ToolUse` whose `nativeArgs.content` is `{ name: "web" } as unknown as string` (declare `const objectContent: unknown = { name: "web" }` and cast it). Assert:
            - a tool error mentioning "must be a string"
            - no throw
            - `diffViewProvider.reset` called
            - `diffViewProvider.open` and `diffViewProvider.update` never called
            - `consecutiveMistakeCount` incremented
        - `core/tools/__tests__/updateTodoListTool.spec.ts`, A2 execute cases:
            - The incident array-of-objects passed as `todos` (cast through `unknown`) is parsed and persisted to `task.todoList`, with "Todo list updated successfully".
            - `["[ ] a", "[x] b"]` gives two items.
            - `coerceTodosArg` unit cases: string, string array, `[]` → `"[]"`, mixed array, object, number.
              Verify:
        - `npx vitest run core/assistant-message core/tools/__tests__/writeToFileTool.spec.ts core/tools/__tests__/updateTodoListTool.spec.ts core/task/__tests__/Task.presenter-backstop.spec.ts core/task/__tests__/Task.spec.ts` passes.
        - `npx tsc --noEmit` is clean.
        - Lint ratchet on all FEAT-001 files shows no increase.
        - `pnpm lifecycle:model-check` passes.
        - `node scripts/find-missing-translations.js` is clean.

## FEAT-002: Stream timeouts, provider abort wiring, setting, and bounded condense (A3 + round-3 MEDIUM)

- [ ]   7. **New module `core/task/streamIdleTimeout.ts`.**
        - Exports `type StreamWaitPhase = "first_chunk" | "between_chunks"`.
        - Exports `class StreamIdleTimeoutError extends Error` with `readonly phase` and `readonly timeoutMs`. Set `name = "StreamIdleTimeoutError"`. The message is `` `No data received from the provider for ${Math.round(timeoutMs / 1000)}s (${phase}); the request was aborted and will be retried.` ``
        - Exports `awaitWithStreamTimeout<T>(next: Promise<T>, opts: { signal?: AbortSignal; timeoutMs: number; phase: StreamWaitPhase }): Promise<T>`. Contract:
            - Attach `next.then(onValue, onError)` unconditionally, and let the first settle win.
            - If `signal?.aborted` is already true, reject at once with `new Error("Request cancelled by user")`, with no timer and no listener.
            - Add an abort listener that rejects with the same message.
            - `timeoutMs > 0` starts a `setTimeout` that rejects with `StreamIdleTimeoutError`. `timeoutMs <= 0` starts no timer.
            - On every settle, clear the timer and `removeEventListener("abort", …)`.
            - Never call `iterator.return()`.
              Files: core/task/streamIdleTimeout.ts (new), core/task/**tests**/streamIdleTimeout.spec.ts (new, fake timers)
              Verify: `npx vitest run core/task/__tests__/streamIdleTimeout.spec.ts` passes. Cases:
        - Resolution before the timeout clears the timer (`vi.getTimerCount() === 0`).
        - A timeout rejects with `StreamIdleTimeoutError` carrying `phase` and `timeoutMs`.
        - An abort rejects with "Request cancelled by user".
        - `timeoutMs: 0` never times out.
        - `removeEventListener` is called after settling (spy on `signal.removeEventListener`).
        - An already-aborted signal rejects immediately with `vi.getTimerCount() === 0`.
        - `next` rejecting after a timeout or abort produces no unhandled rejection (a `process.on("unhandledRejection")` spy is not called after flushing).

- [ ]   8. **Setting `zoo-code.apiStreamIdleTimeout`.**
        - `api/providers/utils/timeout-config.ts`: add `DEFAULT_STREAM_IDLE_SECONDS = 300`, `MAX_STREAM_IDLE_SECONDS = 3600`, and `export function getApiStreamIdleTimeout(): number`. It reads `.get<number>("apiStreamIdleTimeout", 300)`. A valid value is `typeof v === "number" && !isNaN(v) && v >= 0 && v <= 3600`; anything else falls back to 300. It returns `Math.round(seconds * 1000)`.
        - `src/package.json`: right after the `zoo-code.apiRequestTimeout` block (~394–400), add `"zoo-code.apiStreamIdleTimeout": { "type": "integer", "default": 300, "minimum": 0, "maximum": 3600, "description": "%settings.apiStreamIdleTimeout.description%" }`.
        - `src/package.nls.json` line after 42: `"settings.apiStreamIdleTimeout.description": "Abort and retry a streaming API response when no data arrives for this many seconds (default: 300, range: 0–3600, 0 disables). The wait for the first token is governed by API request timeout."`
        - The 17 `src/package.nls.<locale>.json` files get translations in each file's existing `apiRequestTimeout` style. Keep the numbers and the range.
          Files: api/providers/utils/timeout-config.ts, src/package.json, src/package.nls.json, src/package.nls.{ca,de,es,fr,hi,id,it,ja,ko,nl,pl,pt-BR,ru,tr,vi,zh-CN,zh-TW}.json
          Verify:
        - `npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts` passes, with a new `describe("getApiStreamIdleTimeout")`: unset → 300000, 0 → 0, 3600 → 3600000, and -1, NaN, "x", 4000 → 300000. Assert `get` is called with `("apiStreamIdleTimeout", 300)`. Reuse the existing `mockGetConfig` and add no new `any`.
        - `node scripts/find-missing-translations.js` shows nothing under PACKAGE.NLS.

- [ ]   9. **Provider signal wiring (V7 comment).**
        - `api/providers/openai.ts`: add `private requestOptions(isAzureAiInference: boolean, signal?: AbortSignal): OpenAI.RequestOptions` returning `{ ...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}), ...(signal ? { signal } : {}) }`.
        - Use it as the second `create` argument at:
            - ~190: `isAzureAiInference`, `metadata?.abortSignal`
            - ~258: `this._isAzureAiInference(modelUrl)`, `metadata?.abortSignal`
            - ~405 and ~440: `methodIsAzureAiInference`, `metadata?.abortSignal`
        - `completePrompt` (~342) keeps its current argument.
        - Add a one-line comment that the signal lets a stream timeout close the socket, and that OmniRoute is assumed to cancel upstream on disconnect (design V7).
        - `api/providers/base-openai-compatible-provider.ts` `createStream` (~107):
            - `const signal = requestOptions?.signal ?? metadata?.abortSignal`
            - `return this.client.chat.completions.create(params, signal ? { ...requestOptions, signal } : requestOptions)`
            - This keeps `undefined` when neither is present.
              Files: api/providers/openai.ts, api/providers/base-openai-compatible-provider.ts, plus both specs
              Verify: `npx vitest run api/providers` passes (every subclass spec included). New cases:
        - `openai.spec.ts`:
            - streaming and non-streaming `createMessage` with `metadata.abortSignal` → `mockCreate.mock.calls[0][1]` equals `{ signal }`
            - Azure AI Inference streaming and non-streaming → `{ path: "/models/chat/completions", signal }`
            - O3 family streaming → contains `signal`
            - without `abortSignal` → `{}` / `{ path }`, unchanged
        - `base-openai-compatible-provider.spec.ts`: with `abortSignal` the second arg is `{ signal }`. The existing `undefined` assertion still passes.

- [ ]   10. **Task first-chunk and between-chunk timeouts** in `core/task/Task.ts`.
        - Imports: `import { awaitWithStreamTimeout, StreamIdleTimeoutError } from "./streamIdleTimeout"` and `import { getApiRequestTimeout, getApiStreamIdleTimeout } from "../../api/providers/utils/timeout-config"`.
        - `recursivelyMakeClineRequests`:
            - After `const cachedModelId = …` (~3399), add `const streamIdleTimeoutMs = getApiStreamIdleTimeout()`.
            - Replace `nextChunkWithAbort` (~3417–3440) with `const nextChunk = (timeoutMs: number) => awaitWithStreamTimeout(iterator.next(), { signal: this.currentRequestAbortController?.signal, timeoutMs, phase: "between_chunks" })`. Keep the evaluation order: `iterator.next()` first, then the controller read.
            - `let item = await nextChunk(0)`, and in the loop `item = await nextChunk(streamIdleTimeoutMs)`.
            - First statement of the mid-stream `catch (error)` (~3853): `if (error instanceof StreamIdleTimeoutError) { this.currentRequestAbortController?.abort(error); void stream.return(undefined).catch(() => {}) }` (D3), with a NIT-4 comment ("tools already executed this turn may run again on retry; accepted, same as other mid-stream failures").
        - `attemptApiRequest` (~5070):
            - D2: `const requestAbortController = new AbortController(); this.currentRequestAbortController = requestAbortController; const abortSignal = requestAbortController.signal`.
            - Delete the `abortPromise` and `Promise.race` (~5120–5134). Use `const firstChunk = await awaitWithStreamTimeout(firstChunkPromise, { signal: abortSignal, timeoutMs: getApiRequestTimeout(), phase: "first_chunk" })`.
            - First statement of its `catch (error)` (~5138, before `this.isWaitingForFirstChunk = false`): `if (error instanceof StreamIdleTimeoutError) { requestAbortController.abort(error); void iterator.return?.(undefined)?.catch(() => {}) }`. Then fall through to the existing handling (not a context-window error → backoff + retry, or `api_req_failed`).
              Files: core/task/Task.ts, core/task/**tests**/Task.stream-idle-timeout.spec.ts (new)
              Verify:
        - `npx vitest run core/task/__tests__/Task.stream-idle-timeout.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__` passes.
        - `npx tsc --noEmit` is clean.
          The new spec copies Task.spec.ts's preamble (lines 1–~445: typed `TaskTestAccess`/`getTaskTestAccess`, the `vi.mock` block, real `ClineProvider` setup, `stubModelInfo`). It also adds `vi.mock("../../../api/providers/utils/timeout-config", () => ({ getApiRequestTimeout: vi.fn(() => 80), getApiStreamIdleTimeout: vi.fn(() => 30) }))` (D6), stubs `getSystemPrompt`, `backoffAndAnnounce`, and `presentAssistantMessageSafe`, and spies on `task.api.createMessage`. Cases:
        1. A generator yields one text chunk, then never resolves. After about 30 ms:
            - the captured `metadata.abortSignal` is aborted with `reason instanceof StreamIdleTimeoutError`
            - `api_req_started`'s JSON has `cancelReason: "streaming_failed"` and a `streamingFailedMessage` containing "No data received"
            - `createMessage` is called a second time (retry)
              End the loop by aborting the task on the third call.
        2. A first-chunk stall longer than the mocked 80 ms `apiRequestTimeout` (auto-approval on) goes through the first-chunk retry: `backoffAndAnnounce` is called with a `StreamIdleTimeoutError`, and `createMessage` is called again.
        3. A backoff stub that takes 4× the idle timeout inside the first `next()` (first call 503, then success) does not trigger the idle timeout: no `streaming_failed`, and exactly 2 request calls before the stop.
        4. On a first-chunk timeout, the first request's signal is aborted with `reason instanceof StreamIdleTimeoutError` (captured from `createMessage`'s metadata) before `currentRequestAbortController` is cleared.

- [ ]   11. **Bound the auto-condense stream** (round-3 MEDIUM, D4) in `core/condense/index.ts` `summarizeConversation` (~371–392).
        - Imports: `awaitWithStreamTimeout`, `StreamIdleTimeoutError`, `type StreamWaitPhase` from `"../task/streamIdleTimeout"`; `getApiRequestTimeout`, `getApiStreamIdleTimeout` from `"../../api/providers/utils/timeout-config"`.
        - Inside the existing `try`:
            - Create `const condenseController = new AbortController()`.
            - Link the outer signal. If `metadata?.abortSignal` exists: when it is already aborted, call `condenseController.abort(metadata.abortSignal.reason)`; otherwise add a `{ once: true }` listener `forwardAbort` that does the same.
            - Build `summaryMetadata` exactly as today, but with `abortSignal: condenseController.signal` in the object (still `undefined` when `metadata` is undefined).
            - `const it = apiHandler.createMessage(promptToUse, requestMessages, summaryMetadata)[Symbol.asyncIterator]()` and `let phase: StreamWaitPhase = "first_chunk"`.
            - Loop `for (;;)`:
                - `const timeoutMs = phase === "first_chunk" ? getApiRequestTimeout() : getApiStreamIdleTimeout()`
                - `const r = await awaitWithStreamTimeout(it.next(), { signal: condenseController.signal, timeoutMs, phase }).catch((e: unknown) => { if (e instanceof StreamIdleTimeoutError) { condenseController.abort(e); void it.return?.(undefined)?.catch(() => {}) } throw e })`
                - `if (r.done) break`, then `phase = "between_chunks"`, then the existing chunk handling on `r.value`.
            - Add `finally { metadata?.abortSignal?.removeEventListener("abort", forwardAbort) }`. Hoist `forwardAbort` so the finally can see it.
        - The existing `catch` produces `result.error` (`condense_api_failed`), and `manageContext` falls back to `truncateConversation`. This covers both production callers: attemptApiRequest ~4909 and handleContextWindowExceededError ~4648.
          Files: core/condense/index.ts, core/condense/**tests**/index.spec.ts
          Verify:
        - `npx vitest run core/condense core/context-management` passes.
        - Lint ratchet on `core/condense/index.ts` stays at 0 entries.
          New and updated condense cases (fake timers):
        - (a) Idle timeout: the summarizer yields one text chunk, then `await new Promise(() => {})`. After `vi.advanceTimersByTimeAsync(300_000)`, `result.error` is set (contains "Condensing API call failed"), `result.messages` is the input, and the `abortSignal` captured from `createMessage`'s metadata is aborted with a `StreamIdleTimeoutError` reason.
        - (b) First-chunk stall: after `advanceTimersByTimeAsync(600_000)` (the vscode mock defaults to 600 s), `result.error` is set.
        - (c) Update the existing "summarizes without executable tools while retaining cancellation…" assertion to `abortSignal: expect.any(AbortSignal)`, and add an assertion that aborting the outer `abortSignal` aborts the signal passed to `createMessage`.
        - The "metadata undefined" test still expects `undefined`.

- [ ]   12. **FEAT-002 gates.**
        - `npx vitest run core/task/__tests__ core/condense core/context-management api/providers` passes.
        - `npx tsc --noEmit` is clean.
        - Lint ratchet on every FEAT-002 file (streamIdleTimeout.ts and spec, timeout-config.ts and spec, openai.ts and spec, base-openai-compatible-provider.ts and spec, Task.ts, Task.stream-idle-timeout.spec.ts, condense/index.ts and spec) shows no increase.
        - `pnpm lifecycle:model-check` passes.
        - `node scripts/find-missing-translations.js` is clean.

## FEAT-003: Parallel workers never block on an ask and never retry forever (A4)

- [ ]   13. **Worker failure API and call sites** in `core/task/Task.ts`.
        - Module constant: `const PARALLEL_WORKER_MAX_API_RETRIES = 8`.
        - Fields:
            - `parallelWorkerFailure?: string` (public, with a JSDoc)
            - `private parallelWorkerApiFailures = 0`
        - `public async failParallelWorker(reason: string): Promise<void>`:
            - Throws `new Error("failParallelWorker called on a non-worker task")` if `!this.parallelWorker`.
            - `this.parallelWorkerFailure ??= reason` and `this.abortReason ??= "streaming_failed"`, both before any await.
            - `await this.say("error", t("common:errors.parallel_worker_failed", { reason })).catch((e) => console.error(…))`
            - `await this.abortTask()`
        - `private async failWorkerIfRetriesExhausted(error: unknown): Promise<boolean>`:
            - First line: `if (!this.parallelWorker || this.abort) return false` (NIT 2).
            - `this.parallelWorkerApiFailures++`. While the counter is `<= PARALLEL_WORKER_MAX_API_RETRIES`, return false.
            - Otherwise `await this.failParallelWorker(\`API request failed after ${PARALLEL_WORKER_MAX_API_RETRIES} retries: ${message}\`)` and return true.
        - Counter reset: `this.parallelWorkerApiFailures = 0` next to `this.consecutiveNoAssistantMessagesCount = 0` (~4058).
        - `cancelReason` tweaks:
            - In-loop abort (~3642): `await abortStream(this.abortReason ?? "user_cancelled")`.
            - Mid-stream catch (~3856): `const cancelReason = this.abort ? (this.abortReason ?? "user_cancelled") : "streaming_failed"`.
        - Sites:
            - (a) Mistake limit (~3141): after the two telemetry calls and before `this.ask("mistake_limit_reached"…)`: `if (this.parallelWorker) { await this.failParallelWorker(\`Stopped after ${this.consecutiveMistakeLimit} consecutive mistakes\`); return true }`.
            - (b) Mid-stream `OutputTokenLimitError` branch (~3870): `if (this.parallelWorker) { await this.failParallelWorker("Model output token limit reached; the identical request would truncate again"); break }` before the ask.
            - (c) Mid-stream `else` (~3880), after the `console.error`: `if (await this.failWorkerIfRetriesExhausted(error)) break`. Then change the backoff condition to `if (stateForBackoff?.autoApprovalEnabled || this.parallelWorker)`.
            - (d) Empty-assistant path: after the `MODEL_NO_ASSISTANT_MESSAGES` say block (~4287) and before `const state = …`/the pop: `if (await this.failWorkerIfRetriesExhausted(new Error("The model returned no assistant messages"))) return true`. Then change the branch at ~4310 to `if (state?.autoApprovalEnabled || this.parallelWorker)`.
            - (e) `attemptApiRequest` first-chunk catch, after the context-window branch (~5157): `if (await this.failWorkerIfRetriesExhausted(error)) throw new Error(\`[Task#attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted after worker retry cap\`)`. Then `if (autoApprovalEnabled || this.parallelWorker) {` for the backoff + recursive retry branch.
        - i18n: `"parallel_worker_failed": "Parallel worker stopped: {{reason}}"` under `errors` in all 18 `src/i18n/locales/*/common.json` (translated, keeping `{{reason}}`).
          Files: core/task/Task.ts, src/i18n/locales/\*/common.json (18)
          Verify:
        - `npx tsc --noEmit` is clean.
        - `npx vitest run core/task/__tests__` passes.
        - `node scripts/find-missing-translations.js` is clean.

- [ ]   14. **`waitForParallelTask`** in `core/task/runParallelTasks.ts` (~159–207).
        - Widen the child to `Pick<Task, "taskId" | "clineMessages" | "lifetimeSignal" | "run" | "parallelWorkerFailure" | "on" | "off">`.
        - Inside the promise:
            - `let settled = false`, plus `const settle = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn() }`.
            - `let completedText: string | undefined`.
            - `const completionText = () => [...child.clineMessages].reverse().find((m) => m.say === "completion_result")?.text ?? "Task completed"`.
            - `const onChildCompleted = () => { completedText = completionText(); settle(() => resolve(completedText!)) }`, registered with `child.on(RooCodeEventName.TaskCompleted, onChildCompleted)`.
            - The provider `complete` keeps its task-id check and calls `settle(() => resolve(completionText()))`.
            - `cancel` calls `settle(() => reject(signal.reason ?? new Error("Batch cancelled")))`. This always rejects.
            - `stopped`: `if (completedText !== undefined) return settle(() => resolve(completedText!))`, else `settle(() => reject(new Error(child.parallelWorkerFailure ? \`Worker failed: ${child.parallelWorkerFailure}\` : "Worker stopped before completing")))`.
            - `needsInput`: same `completedText` guard, then the existing logic via `settle`.
            - `onLoopEnded = () => { if (completedText !== undefined) return settle(() => resolve(completedText!)); settle(() => reject(new Error(child.parallelWorkerFailure ? \`Worker failed: ${child.parallelWorkerFailure}\` : "Worker task loop ended without attempt_completion; inspect its saved chat and patch"))) }`
            - `onLoopError = (error: unknown) => settle(() => reject(error))`
            - `cleanup()` also calls `child.off(RooCodeEventName.TaskCompleted, onChildCompleted)`.
            - Replace `void child.run().catch(…)` with `void child.run().then(onLoopEnded, onLoopError)`.
            - Avoid non-null assertions if lint flags them: capture `const text = completionText()` in a local.
        - `runParallelTasks` is unchanged.
          Files: core/task/runParallelTasks.ts, core/task/**tests**/waitForParallelTask.spec.ts
          Verify: `npx vitest run core/task/__tests__/waitForParallelTask.spec.ts core/task/__tests__/ParallelTask*.spec.ts core/task/__tests__/parallel*.spec.ts` passes.

- [ ]   15. **FEAT-003 tests.**
        - `core/task/__tests__/waitForParallelTask.spec.ts`. Update `fixture()`:
            - `run` returns a deferred the test controls (`let endLoop!: () => void; run: vi.fn(() => new Promise<void>((r) => { endLoop = r }))`), because an immediately-resolving `run` would now trip `onLoopEnded`.
            - The child gets `on`/`off` from a second `EventEmitter`, cast once with a comment like the provider.
            - The child gets `parallelWorkerFailure: undefined`.

            Keep all 6 existing cases passing. Add:
            1. `parallelWorkerFailure = "boom"`, then the lifetime aborts → rejects `Worker failed: boom`.
            2. `run()` resolves unsettled → rejects "loop ended without attempt_completion".
            3. The child emits `TaskCompleted`, then the lifetime aborts before the provider re-emits → resolves with the `completion_result` text. A later provider `TaskCompleted` is a no-op.
            4. The child emits `TaskCompleted`, then `run()` resolves before the provider → resolves with the text.
            5. Only the provider emits `TaskCompleted` → resolves (fallback).
            6. After settling, `listenerCount(TaskCompleted)` is 0 on both emitters.
            7. `TaskCompleted` emitted before `run()` resolves still resolves.

        - `core/task/__tests__/Task.parallel-worker-failure.spec.ts` (new). Use the same Task.spec.ts preamble as item 10, plus the `timeout-config` mock (D6). Tasks are built with `parallelWorker: true` (except the non-worker case). Stub `backoffAndAnnounce` (resolves), `getSystemPrompt`, and `presentAssistantMessageSafe`, and stub `dispose` so `abortTask` stays local. Read private state via bracket notation (`task["parallelWorkerApiFailures"]`). Cases:
            1. `createMessage` always throws a 503 on the first chunk → called exactly 9 times. `failParallelWorker` runs, `lifetimeSignal.aborted`, `abortReason === "streaming_failed"`, `api_req_started` `cancelReason === "streaming_failed"`, and `parallelWorkerFailure` contains "API request failed after 8 retries".
            2. Interleaved: 3 first-chunk 503s, then a stream that yields one chunk and stalls (30 ms idle timeout), then 503s → 9 `createMessage` calls in total, then failure.
            3. A successful response with content resets the counter. A following run of 8 failures then a success does not fail the worker.
            4. A context-window error (stub `handleContextWindowExceededError`; throw an error that `checkContextWindowExceededError` recognizes) takes the truncation branch, and `parallelWorkerApiFailures` stays 0.
            5. With `autoApprovalEnabled: false`, `ask("api_req_failed", …)` is never called, and the worker still retries and fails at 9.
            6. A non-worker with auto-approval: 12 failures then success → 13 calls, no failure (`failParallelWorker` is never called).
            7. Mistake limit: `consecutiveMistakeCount = consecutiveMistakeLimit` → `failParallelWorker("Stopped after 3 consecutive mistakes")`, no `mistake_limit_reached` ask, and `recursivelyMakeClineRequests` returns true.
            8. `failParallelWorker` triggered from the stubbed `presentAssistantMessageSafe` while the stream keeps yielding → `api_req_started` `cancelReason === "streaming_failed"`. The same setup with `abortReason = "user_cancelled"` and `abortTask()` instead keeps `"user_cancelled"`.
            9. Empty-assistant exhaustion: empty streams → after the 9th, `apiConversationHistory.at(-1)` is the iteration's user message, and the function returns true.
            10. `failParallelWorker` rejects on a non-worker. On a worker, calling it twice resolves both times without throwing, keeps the first `parallelWorkerFailure`, and leaves `abortReason === "streaming_failed"`. The second `say` on the aborted task is swallowed by its `.catch`.
            11. NIT 2: with `task["parallelWorkerApiFailures"] = 8` and a first chunk that never resolves, calling `abortTask()` plus `cancelCurrentRequest()` during the wait leaves `parallelWorkerFailure` undefined and the counter at 8.
            12. Mid-stream `OutputTokenLimitError` on a worker → `failParallelWorker` with the token-limit reason, and no `api_req_failed` ask.
                Verify:
        - `npx vitest run core/task/__tests__` passes.
        - `npx tsc --noEmit` is clean.
        - Lint ratchet on Task.ts, runParallelTasks.ts, and both specs: Task.ts stays ≤ 17, and the specs have no entries.
        - `pnpm lifecycle:model-check` passes unchanged.
        - `node scripts/find-missing-translations.js` is clean.

## FEAT-004: Loop guard (B1, B2)

- [ ]   16. **`ToolRepetitionDetector` nudge, then escalate** (D5).
        - Export `type ToolRepetitionCheckResult`:
            - `{ allowExecution: true; nudge?: undefined; askUser?: undefined }`
            - `| { allowExecution: false; nudge: { toolName: string; repeatCount: number }; askUser?: undefined }`
            - `| { allowExecution: false; nudge?: undefined; askUser: { messageKey: "mistake_limit_reached"; messageDetail: string } }`
        - Counting is unchanged.
        - When `limit > 0 && count >= 2 * limit`, reset the counters and return `askUser` (today's message).
        - Else when `limit > 0 && count >= limit`, return `nudge` with `repeatCount: count`, keeping the counters.
        - Else return `{ allowExecution: true }`.
          Files: core/tools/ToolRepetitionDetector.ts, core/tools/**tests**/ToolRepetitionDetector.spec.ts
          Verify: `npx vitest run core/tools/__tests__/ToolRepetitionDetector.spec.ts` passes. Update the existing expectations:
        - Limit 3: the 4th identical call → `nudge.repeatCount === 3`. The 5th and 6th → nudges. The 7th → `askUser`, then the counters reset (the 8th is allowed).
        - Limit 1: the 2nd → nudge, the 3rd → askUser.
        - Limit 2: the 3rd → nudge, the 5th → askUser.
        - A different call resets the count.
        - Limit 0 and negative limits never block.
        - Rewrite the "explicit Nth call", "reaches the limit", "reset after limit", and "different limits" cases accordingly, adding no new `any`.

- [ ]   17. **B1 presenter wiring and `toolRepetitionNudge`.**
        - `core/prompts/responses.ts`: add `toolRepetitionNudge: (toolName: string, repeatCount: number) => string`. It returns `` `You already called ${toolName} with identical arguments ${repeatCount + 1} times in a row; this call was not executed. Do not call it again with the same arguments. Proceed with the next action of your task.` `` and appends `` ` Only call update_todo_list again after an item's status changes.` `` when `toolName === "update_todo_list"`.
        - `core/assistant-message/presentAssistantMessage.ts` repetition block (inside FEAT-001's try):
            - `if (repetitionCheck.nudge) { cline.recordToolError(telemetryToolName, "repetition_nudge"); pushToolResult(formatResponse.toolError(formatResponse.toolRepetitionNudge(block.name, repetitionCheck.nudge.repeatCount))); break }`. No ask, no `consecutiveMistakeCount++`, and no `didToolFailInCurrentTurn`.
            - `if (repetitionCheck.askUser) { if (cline.parallelWorker) { <the existing two telemetry calls>; pushToolResult(formatResponse.toolError(\`Tool call repetition limit reached for ${block.name}. Please try a different approach.\`)); await cline.failParallelWorker(t("tools:toolRepetitionLimitReached", { toolName: block.name })); break } <existing non-worker code unchanged> }`Files: core/prompts/responses.ts, core/assistant-message/presentAssistantMessage.ts, core/assistant-message/__tests__/presentAssistantMessage-repetition.spec.ts (new, D7)
Verify:`npx vitest run core/assistant-message`passes. New spec cases (detector`check` mocked per case):
        1. A nudge pushes one tool_result containing "this call was not executed", no `ask`, the tool `handle` is not called, and `didToolFailInCurrentTurn` stays false.
        2. A nudge on a custom tool (`customTools` experiment on, `customToolRegistry.has` → true) records `recordToolError("custom_tool", "repetition_nudge")`.
        3. Escalation on a non-worker calls `ask("mistake_limit_reached", …)`.
        4. Escalation on a worker (`parallelWorker: true`, `failParallelWorker: vi.fn()`) calls `failParallelWorker` with the loop message, makes no `ask`, and pushes one error result.

- [ ]   18. **B2 `update_todo_list` no-op table** in `core/tools/UpdateTodoListTool.ts` `execute`.
        After `validateTodos` and building `normalizedTodos`, and before `approvalMsg`/`approvedTodoList = cloneDeep(…)` (~45–56):
        - Let `trimmed = todosString.trim()`, `isJsonShaped = trimmed.startsWith("[") || trimmed.startsWith("{")`, and `current = task.todoList ?? []`.
        - Let `samePairs` be true when lengths match and every index has equal `content` and `status`.
        - Let `n = current.length` and `m = current.filter((t) => t.status === "completed").length`.
        - Rows, first match wins:
            1. `trimmed !== "" && !isJsonShaped && normalizedTodos.length === 0` → `consecutiveMistakeCount++`, `recordToolError("update_todo_list")`, `didToolFailInCurrentTurn = true` (NIT 5), `pushToolResult(formatResponse.toolError("No checklist items found. Provide the full list as `[ ] item` lines."))`, return.
            2. `samePairs` (including both empty) → `pushToolResult(formatResponse.toolResult(\`Todo list unchanged (${n} items, ${m} completed). Do not call update_todo_list again until an item's status changes; proceed with the next action.\`))`, return.
            3. `normalizedTodos.length === 0 && n > 0` → `pushToolResult(formatResponse.toolResult(\`Todo list unchanged: an empty list was ignored. Current list has ${n} items (${m} completed). Proceed with the next item; do not call update_todo_list again until an item's status changes.\`))`, return.
            4. Otherwise, the existing approval and persist flow.
        - No-op rows never touch `consecutiveMistakeCount`, `todoList`, or `approvedTodoList`.
          Files: core/tools/UpdateTodoListTool.ts, core/tools/**tests**/updateTodoListTool.spec.ts
          Verify: `npx vitest run core/tools` passes. New cases:
        - An unchanged list → "Todo list unchanged (2 items, 1 completed)", `askApproval` not called, `todoList` is the same reference/content.
        - `""`, `"[]"`, `'{"todos":[]}'`, and the array param `[]` → row 2 with an empty current list and row 3 with a non-empty one. None of them increments `consecutiveMistakeCount` or sets `didToolFailInCurrentTurn`.
        - `"just prose"` → row 1 tool error, `consecutiveMistakeCount === 1`, `didToolFailInCurrentTurn === true`, `recordToolError("update_todo_list")`.
        - A changed list follows the approval flow (the existing two cases still pass, including the user-edit path).
        - `"[1,2]"` is JSON-shaped for B2. `parseMarkdownChecklist` takes the Markdown path for it (none of its JSON regexes match) and returns `[]`, so it lands on row 2 or 3, not an error.

- [ ]   19. **FEAT-004 gates.**
        - `npx vitest run core/tools core/assistant-message core/prompts` passes.
        - `npx tsc --noEmit` is clean.
        - Lint ratchet on ToolRepetitionDetector.ts and spec, responses.ts, presentAssistantMessage.ts, presentAssistantMessage-repetition.spec.ts, UpdateTodoListTool.ts, and updateTodoListTool.spec.ts shows no increase.
        - `pnpm lifecycle:model-check` passes.

## Integration (after all FEATs)

- [ ]   20. **Cross-feature verification**, recorded in `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/zoo-worker-resilience-impl/verification.md`.
        - `cd src && npx tsc --noEmit`
        - The full src suite: `cd src && npx vitest run`
        - `pnpm test` from the repo root (turbo, all packages). Use a long timeout.
        - The lint ratchet over the union of all touched src files, with churn recovery.
        - `pnpm lifecycle:model-check`
        - `node scripts/find-missing-translations.js`
        - `git diff --stat HEAD~N` to confirm `src/core/task-persistence/taskLifecycle.ts`, `webview-ui/`, `packages/types/src/global-settings.ts`, CHANGELOGs, and `.changeset/` are untouched.
          Fix any seam failures between FEATs, such as a presenter test double lacking `failParallelWorker`, or a timeout-config mock missing in a suite that now imports it.

## Test-plan mapping (design Test plan → files)

| Design item                                  | File                                                                              | Plan item         |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| A1 tool crash (7 bullets)                    | core/assistant-message/**tests**/presentAssistantMessage-tool-crash.spec.ts (new) | 6                 |
| A1 backstop and stream-end guard (7 bullets) | core/task/**tests**/Task.presenter-backstop.spec.ts (new)                         | 6                 |
| A2 parser coercion (4 bullets)               | core/assistant-message/**tests**/NativeToolCallParser.spec.ts                     | 6                 |
| A2 WriteToFileTool guard                     | core/tools/**tests**/writeToFileTool.spec.ts                                      | 6                 |
| A2 array todos (objects, strings)            | core/tools/**tests**/updateTodoListTool.spec.ts                                   | 6                 |
| A3 awaitWithStreamTimeout (7 bullets)        | core/task/**tests**/streamIdleTimeout.spec.ts (new)                               | 7                 |
| A3 getApiStreamIdleTimeout                   | api/providers/utils/**tests**/timeout-config.spec.ts                              | 8                 |
| A3 provider signal                           | api/providers/**tests**/openai.spec.ts, base-openai-compatible-provider.spec.ts   | 9                 |
| A3 Task timeouts (4 bullets)                 | core/task/**tests**/Task.stream-idle-timeout.spec.ts (new)                        | 10                |
| Round-3 MEDIUM condense idle timeout         | core/condense/**tests**/index.spec.ts                                             | 11                |
| A4 waitForParallelTask (8 bullets)           | core/task/**tests**/waitForParallelTask.spec.ts                                   | 15                |
| A4 worker failure (10 bullets + NIT 2)       | core/task/**tests**/Task.parallel-worker-failure.spec.ts (new)                    | 15                |
| B1 detector                                  | core/tools/**tests**/ToolRepetitionDetector.spec.ts                               | 16                |
| B1 presenter (4 bullets)                     | core/assistant-message/**tests**/presentAssistantMessage-repetition.spec.ts (new) | 17                |
| B2 no-op table + NIT 5 "just prose" flag     | core/tools/**tests**/updateTodoListTool.spec.ts                                   | 18                |
| Lifecycle                                    | `pnpm lifecycle:model-check` (no taskLifecycle.ts change)                         | 6, 12, 15, 19, 20 |

The NIT-driven test adjustments are covered as follows:

- NIT 2: the counter at 8 plus an aborted task gives no failure (item 15, case 11).
- NIT 5: the "just prose" case asserts `didToolFailInCurrentTurn` (item 18), and the nudge case asserts the flag stays false (item 17, case 1).
- MEDIUM: the condense idle-timeout and abort-signal cases (item 11).
- NIT 3 and NIT 4 are documentation-only (item 1, plus the code comments in items 9 and 10).
