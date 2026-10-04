# Verification: Zoo parallel-worker resilience

## FEAT-001

Turn settlement + argument coercion (design A1/A2, plan items 1-6). Run on branch `feat/omniroute-tier-dropdown-feat005`, base HEAD `5cf33f0a9`.

| Command                                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd src && npx vitest run core/assistant-message core/tools/__tests__/writeToFileTool.spec.ts core/tools/__tests__/updateTodoListTool.spec.ts core/task/__tests__/Task.presenter-backstop.spec.ts core/task/__tests__/Task.spec.ts` | PASS: 12 files, 336 tests                                                                                                                                                                                                                                                                                        |
| `cd src && npx tsc --noEmit`                                                                                                                                                                                                        | PASS: 0 errors                                                                                                                                                                                                                                                                                                   |
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <12 files>` + jq -S churn recovery                                                                                                                                | PASS: exit 0; `jq -S` of HEAD vs working copy identical (formatting-only churn), so `git checkout -- src/eslint-suppressions.json`                                                                                                                                                                               |
| `pnpm lifecycle:model-check`                                                                                                                                                                                                        | PASS (all sub-checks, including `parser-scope:model-check`: 924/924 interleavings, 6/6 actions, 8/8 landmarks)                                                                                                                                                                                                   |
| `node scripts/find-missing-translations.js`                                                                                                                                                                                         | BACKEND: "No missing translations" for all 17 locales. PACKAGE.NLS: nothing listed. FRONTEND lists pre-existing webview-ui gaps (`autoApprove.yolo`, `forceParallel.*`, `omniRouteTier.*`, `omniroute.*`, …); `webview-ui/` is untouched by FEAT-001, so the script's exit 1 comes from those existing keys only |

Per-spec pass counts (focused run):

| Spec                                                                                                           | Tests |
| -------------------------------------------------------------------------------------------------------------- | ----- |
| core/assistant-message/**tests**/presentAssistantMessage-tool-crash.spec.ts (new)                              | 9     |
| core/task/**tests**/Task.presenter-backstop.spec.ts (new)                                                      | 10    |
| core/assistant-message/**tests**/NativeToolCallParser.spec.ts (+7 "argument coercion")                         | 39    |
| core/tools/**tests**/writeToFileTool.spec.ts (+1 non-string content)                                           | 25    |
| core/tools/**tests**/updateTodoListTool.spec.ts (+3 execute, +6 coerceTodosArg)                                | 33    |
| core/assistant-message/**tests**/presentAssistantMessage-unknown-tool.spec.ts (2 cases updated, see deviation) | 15    |
| core/assistant-message/**tests**/presentAssistantMessage-custom-tool.spec.ts                                   | 13    |
| core/assistant-message/**tests**/presentAssistantMessage-images.spec.ts                                        | 7     |
| core/assistant-message/**tests**/presentAssistantMessage-tool-usage-attribution.spec.ts                        | 12    |
| core/assistant-message/**tests**/toTelemetryToolName.spec.ts                                                   | 7     |
| core/assistant-message/**tests**/parallelReadTools.spec.ts                                                     | 6     |
| core/task/**tests**/Task.spec.ts                                                                               | 160   |

Red/green check: with HEAD's `presentAssistantMessage.ts`, the tool-crash spec fails 7/9. With HEAD's `Task.ts`, the backstop spec fails 4/10 (the 6 that pass are the "changes nothing" cases).

ESLint suppression counts (`src/eslint-suppressions.json`, before → after):

| File                                                                              | no-explicit-any |
| --------------------------------------------------------------------------------- | --------------- |
| core/assistant-message/presentAssistantMessage.ts                                 | 2 → 2           |
| core/assistant-message/NativeToolCallParser.ts                                    | 2 → 2           |
| core/tools/WriteToFileTool.ts                                                     | none → none     |
| core/tools/UpdateTodoListTool.ts                                                  | 1 → 1           |
| core/tools/todoArgs.ts (new)                                                      | none → none     |
| core/task/Task.ts                                                                 | 17 → 17         |
| core/assistant-message/**tests**/presentAssistantMessage-tool-crash.spec.ts (new) | none → none     |
| core/task/**tests**/Task.presenter-backstop.spec.ts (new)                         | none → none     |
| core/assistant-message/**tests**/NativeToolCallParser.spec.ts                     | none → none     |
| core/tools/**tests**/writeToFileTool.spec.ts                                      | 5 → 5           |
| core/tools/**tests**/updateTodoListTool.spec.ts                                   | 2 → 2           |
| core/assistant-message/**tests**/presentAssistantMessage-unknown-tool.spec.ts     | 8 → 8           |

Extra check: the full `cd src && npx vitest run` gives 519 passed / 4 failed files (28 tests) in `__tests__/extension.spec.ts`, `core/prompts/__tests__/add-custom-instructions.spec.ts`, `core/prompts/__tests__/system-prompt.spec.ts`, and `core/webview/__tests__/generateSystemPrompt.spec.ts`. The same 28 fail with every FEAT-001 change stashed (`git stash push -u -- src`), so they are pre-existing and unrelated.

Committed as `af4569b03` (`fix(zoo): settle turns when tool dispatch throws and coerce object tool args`, 30 files). The pre-commit hook (lint-staged + `pnpm lint`, 11/11 turbo tasks) passed. Nothing under `.agents/` was staged.

## FEAT-002

Stream first-chunk/idle timeouts, provider abort-signal wiring, `zoo-code.apiStreamIdleTimeout`, and the bounded condense stream (design A3 + round-3 MEDIUM, plan items 7-12). Base HEAD `af4569b03`.

| Command                                                                                              | Result                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd src && npx vitest run core/task/__tests__ core/condense core/context-management api/providers`   | PASS: 132 files, 2958 passed, 1 skipped. Re-run after the commit's prettier pass: same                                                                                                                                |
| `cd src && npx tsc --noEmit`                                                                         | PASS: exit 0                                                                                                                                                                                                          |
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <12 files>` + jq -S churn recovery | PASS: exit 0. `jq -S` diff of HEAD vs working copy is empty (formatting-only churn), so `git checkout -- src/eslint-suppressions.json`                                                                                |
| `pnpm lifecycle:model-check`                                                                         | PASS (all sub-checks, including `parser-scope:model-check`: 924/924 interleavings)                                                                                                                                    |
| `node scripts/find-missing-translations.js`                                                          | BACKEND: "No missing translations" for all 17 locales. PACKAGE.NLS: 51 base keys, nothing listed. Exit 1 comes only from the pre-existing FRONTEND (webview-ui) gaps noted under FEAT-001; `webview-ui/` is untouched |

Per-spec pass counts (focused run):

| Spec                                                                                            | Tests |
| ----------------------------------------------------------------------------------------------- | ----- |
| core/task/**tests**/streamIdleTimeout.spec.ts (new, fake timers)                                | 7     |
| core/task/**tests**/Task.stream-idle-timeout.spec.ts (new, real timers + mocked timeout-config) | 5     |
| api/providers/utils/**tests**/timeout-config.spec.ts (+7 getApiStreamIdleTimeout)               | 21    |
| api/providers/**tests**/openai.spec.ts (+6 abort signal forwarding)                             | 165   |
| api/providers/**tests**/base-openai-compatible-provider.spec.ts (+1 signal)                     | 17    |
| core/condense/**tests**/index.spec.ts (+3 stream bounds, 1 assertion updated)                   | 73    |
| core/task/**tests**/Task.spec.ts (unchanged)                                                    | 160   |

Red/green check on Task.ts: with the between-chunk timer disabled (`nextChunk(0)` in the loop) and the first-chunk timer disabled, 4/5 Task.stream-idle-timeout cases fail. With the idle timer wrongly applied to the first `next()`, 3/5 fail, including the long-backoff case.

ESLint suppression counts (`src/eslint-suppressions.json`, before → after):

| File                                                            | no-explicit-any |
| --------------------------------------------------------------- | --------------- |
| core/task/streamIdleTimeout.ts (new)                            | none → none     |
| core/task/**tests**/streamIdleTimeout.spec.ts (new)             | none → none     |
| core/task/**tests**/Task.stream-idle-timeout.spec.ts (new)      | none → none     |
| api/providers/utils/timeout-config.ts                           | none → none     |
| api/providers/utils/**tests**/timeout-config.spec.ts            | 2 → 2           |
| api/providers/openai.ts                                         | 3 → 3           |
| api/providers/**tests**/openai.spec.ts                          | 4 → 4           |
| api/providers/base-openai-compatible-provider.ts                | 6 → 6           |
| api/providers/**tests**/base-openai-compatible-provider.spec.ts | 1 → 1           |
| core/task/Task.ts                                               | 17 → 17         |
| core/condense/index.ts                                          | none → none     |
| core/condense/**tests**/index.spec.ts                           | 24 → 24         |

Extra check: the full `cd src && npx vitest run` gives 521 passed / 4 failed files (28 tests), the same pre-existing files and count as FEAT-001.

Committed as `f406a6829` (`fix(zoo): bound stream first-chunk/idle waits and forward abort signals`, 31 files). The pre-commit hook (lint-staged + `pnpm lint`, 11/11 turbo tasks) passed. Nothing under `.agents/` was staged.

## FEAT-003

Parallel workers never block on an ask and never retry forever (design A4, plan items 13-15). Base HEAD `f406a6829`.

| Command                                                                                                                                                                                                                                            | Result                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cd src && npx vitest run core/task/__tests__`                                                                                                                                                                                                     | PASS: 46 files, 557 tests. Re-run after the prettier fix: same                                                                                                                                                                                                                             |
| `cd src && npx tsc --noEmit`                                                                                                                                                                                                                       | PASS: exit 0                                                                                                                                                                                                                                                                               |
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/Task.ts core/task/runParallelTasks.ts core/task/__tests__/waitForParallelTask.spec.ts core/task/__tests__/Task.parallel-worker-failure.spec.ts` + jq -S churn recovery | PASS: exit 0. The `jq -S` diff of HEAD vs the working copy is empty (1711/1711 lines of formatting-only churn), so `git checkout -- src/eslint-suppressions.json`                                                                                                                          |
| `pnpm lifecycle:model-check`                                                                                                                                                                                                                       | PASS (all sub-checks, including cleanup protocol 57366 states and `parser-scope:model-check` 924/924 interleavings). `git diff HEAD --quiet -- src/core/task-persistence/taskLifecycle.ts` exits 0 (unchanged)                                                                             |
| `node scripts/find-missing-translations.js`                                                                                                                                                                                                        | BACKEND: "No missing translations" for all 17 locales (the new `errors.parallel_worker_failed` is in all 18 `common.json`). PACKAGE.NLS: 51 base keys, nothing listed. Exit 1 comes only from the pre-existing FRONTEND (webview-ui) gaps noted under FEAT-001; `webview-ui/` is untouched |
| `npx prettier --check` on the 4 TS files + 18 `common.json`                                                                                                                                                                                        | PASS (after re-wrapping two Task.ts lines)                                                                                                                                                                                                                                                 |

Per-spec pass counts:

| Spec                                                                                                | Tests                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| core/task/**tests**/waitForParallelTask.spec.ts (fixture updated; 6 existing + 7 new)               | 13                                                           |
| core/task/**tests**/Task.parallel-worker-failure.spec.ts (new, real timers + mocked timeout-config) | 13 (plan case 8 split into self-failure and user-cancel its) |
| core/task/**tests**/Task.spec.ts (unchanged)                                                        | 160                                                          |
| core/task/**tests**/Task.stream-idle-timeout.spec.ts (unchanged)                                    | 5                                                            |

Red/green check on Task.ts: with the NIT 2 `|| this.abort` removed from `failWorkerIfRetriesExhausted`, and the empty-assistant cap check moved after the history pop, 4/13 Task.parallel-worker-failure cases fail: the NIT 2 case, the empty-assistant history case, and the counter-reset and context-window cases (whose stop request is then counted as a failure). Both mutations were reverted.

ESLint suppression counts (`src/eslint-suppressions.json`, before → after):

| File                                                           | no-explicit-any |
| -------------------------------------------------------------- | --------------- |
| core/task/Task.ts                                              | 17 → 17         |
| core/task/runParallelTasks.ts                                  | none → none     |
| core/task/**tests**/waitForParallelTask.spec.ts                | none → none     |
| core/task/**tests**/Task.parallel-worker-failure.spec.ts (new) | none → none     |

Extra check: the full `cd src && npx vitest run` gives 522 passed / 4 failed files (28 tests): the same pre-existing files (extension.spec.ts 20, add-custom-instructions.spec.ts 3, system-prompt.spec.ts 4, generateSystemPrompt.spec.ts 1) and count as FEAT-001/002.

Committed as `a28255745` (`fix(zoo): fail parallel workers non-interactively with a bounded retry cap`, 22 files). The pre-commit hook (lint-staged + `pnpm lint`, 11/11 turbo tasks) passed. Nothing under `.agents/` was staged.

## FEAT-004

Loop guard (B1 nudge-then-escalate, B2 update_todo_list no-op table). Commit `de6d8a7d1`.

| Command                                                                                                                  | Result                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd src && npx vitest run core/tools core/assistant-message core/prompts`                                                | PASS for every FEAT-004 spec: 58/60 files, 1115/1122 tests. The 7 failures are pre-existing in core/prompts/**tests**/add-custom-instructions.spec.ts (3) and system-prompt.spec.ts (4); they fail identically with all FEAT-004 changes stashed (7 failed / 30 passed in those 2 files on HEAD a28255745). |
| `cd src && npx tsc --noEmit`                                                                                             | PASS (exit 0)                                                                                                                                                                                                                                                                                               |
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on the 7 touched files                                | PASS (exit 0) after replacing a raw `"openai"` apiProvider in the new spec with `"test-provider"` (zoo/no-raw-provider-identifiers)                                                                                                                                                                         |
| jq -S churn recovery (`git show HEAD:src/eslint-suppressions.json \| jq -S .` vs `jq -S . src/eslint-suppressions.json`) | Only a decrease: the `core/tools/__tests__/ToolRepetitionDetector.spec.ts` entry (no-explicit-any 3) is gone. Normalized with `jq -S --tab .` and committed (5-line deletion)                                                                                                                               |
| `pnpm lifecycle:model-check`                                                                                             | PASS (task cleanup, parser scope 924/924, completion persistence, delegated mode reader)                                                                                                                                                                                                                    |
| `npx prettier --check` on the 7 files                                                                                    | PASS after `--write` on presentAssistantMessage.ts and updateTodoListTool.spec.ts                                                                                                                                                                                                                           |
| pre-commit hook (lint-staged + `pnpm lint`)                                                                              | PASS, 11/11 turbo tasks                                                                                                                                                                                                                                                                                     |

Per-spec pass counts:

| Spec                                                                                                                                                                                                                                      | Tests    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| core/tools/**tests**/ToolRepetitionDetector.spec.ts (rewritten: limit 3 nudges 4-6 / escalates 7 / 8th allowed; limit 1: 2 nudge, 3 escalate; limit 2: 3-4 nudge, 5 escalate; limit 5; 0/negative never block; reset on a different call) | 23       |
| core/assistant-message/**tests**/presentAssistantMessage-repetition.spec.ts (new, no `any`)                                                                                                                                               | 4        |
| core/tools/**tests**/updateTodoListTool.spec.ts (+13 B2 cases: unchanged, 5 empty-ish inputs x empty/non-empty current, just prose, changed list)                                                                                         | 46 total |

ESLint suppression counts (no-explicit-any, before → after):

| File                                                                              | Count                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| core/tools/ToolRepetitionDetector.ts                                              | 1 → 1                                                        |
| core/tools/**tests**/ToolRepetitionDetector.spec.ts                               | 3 → none (bracket notation for the private serializeToolUse) |
| core/prompts/responses.ts                                                         | none → none                                                  |
| core/assistant-message/presentAssistantMessage.ts                                 | 2 → 2                                                        |
| core/assistant-message/**tests**/presentAssistantMessage-repetition.spec.ts (new) | none → none                                                  |
| core/tools/UpdateTodoListTool.ts                                                  | 1 → 1                                                        |
| core/tools/**tests**/updateTodoListTool.spec.ts                                   | 2 → 2                                                        |

Nothing under `.agents/` was staged.

## Integration (iteration 1)

Branch `feat/omniroute-tier-dropdown-feat005`, HEAD `de6d8a7d1` (4 commits over base `5cf33f0a9`: af4569b03, f406a6829, a28255745, de6d8a7d1). No review.json existed, so this is the first pass of plan item 20. No seam failures turned up and no code changes were needed, so there is no new commit.

| #   | Command                                                                                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cd src && npx tsc --noEmit`                                                                                                                                                           | PASS (exit 0, no diagnostics)                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | `cd src && npx vitest run` (full src suite)                                                                                                                                            | 531 files: 523 passed, 4 failed, 4 skipped. 9773 tests: 9706 passed, 28 failed, 39 skipped. All 28 failures are pre-existing (see baseline below).                                                                                                                                                                                                                                                    |
| 2b  | Baseline check: reverse-applied `git diff 5cf33f0a9 HEAD -- src` to the working tree, ran the 4 failing files, then restored with `git checkout HEAD -- src` (status clean afterwards) | Base: 4 files failed, 28 failed / 49 passed (77). This is identical to HEAD, so none of the 28 failures comes from this work. Files: `__tests__/extension.spec.ts` (20, registerTaskBoard/activate), `core/prompts/__tests__/system-prompt.spec.ts` (4), `core/prompts/__tests__/add-custom-instructions.spec.ts` (3), `core/webview/__tests__/generateSystemPrompt.spec.ts` (1).                     |
| 2c  | Focused: `npx vitest run` over all 16 spec files changed since 5cf33f0a9                                                                                                               | PASS: 16 files, 485 tests                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | `pnpm test` (turbo, repo root)                                                                                                                                                         | 12/13 tasks successful. The only failure is `zoo-code#test`, with the same 28 pre-existing failures in the same 4 files as #2. vscode-shim 407/407, cloud 247/247, telemetry 49/49, types 436/436, cli 565 passed + 1 skipped, vscode-webview 1892/1892, core 149/149, config-eslint ok.                                                                                                              |
| 4   | `git diff --name-only 5cf33f0a9..HEAD -- src \| grep '\.ts$' \| sed 's#^src/##' \| xargs pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` (30 .ts files, prod + spec) | PASS (exit 0, 0 warnings). Churn recovery: `jq -S` of the rewritten src/eslint-suppressions.json is identical to HEAD, so the file was restored with `git checkout`. Against base 5cf33f0a9, the only difference is the removed `core/tools/__tests__/ToolRepetitionDetector.spec.ts` no-explicit-any entry (count 3 → 0, a decrease committed in FEAT-004). No count increased and no key was added. |
| 5   | `pnpm lifecycle:model-check`                                                                                                                                                           | PASS (exit 0). Task lifecycle (53 states), shared-store (625), provider handoff/scheduler (104), task cleanup protocol (57366), native tool-call parser scope (924/924 interleavings), completion persistence (88), and delegated mode reader all pass.                                                                                                                                               |
| 6   | `node scripts/find-missing-translations.js`                                                                                                                                            | BACKEND: "No missing translations" for all 17 locales. PACKAGE.NLS (51 base keys): nothing listed. The script exits 1 only because of pre-existing FRONTEND (webview-ui) gaps. webview-ui is unchanged since base (#7) and must stay so, so these gaps are outside this work.                                                                                                                         |
| 7   | `git diff --stat 5cf33f0a9..HEAD -- src/core/task-persistence/taskLifecycle.ts webview-ui packages/types/src/global-settings.ts CHANGELOG.md src/CHANGELOG.md .changeset`              | Empty: all protected paths are unchanged.                                                                                                                                                                                                                                                                                                                                                             |

Seam review:

- Every Task- or condense-importing suite that mocks `api/providers/utils/timeout-config` exports both `getApiRequestTimeout` and `getApiStreamIdleTimeout`: Task.stream-idle-timeout and Task.parallel-worker-failure. The 8 provider specs that mock only `getApiRequestTimeout` import neither Task nor condense.
- The presenter test doubles in the repetition spec carry `parallelWorker` and `failParallelWorker`. The full suite shows no missing-member failures.
- No fixes were needed. Nothing was staged or committed, and nothing under `.agents/` was staged.
