# Verification: worker X-OmniRoute-Tier + single-task parallel_tasks

Iteration: first (no review.json existed). Branch `feat/omniroute-tier-dropdown-feat005`, base `e89164411`.
Commits:

- `a24a57c7e` fix(omniroute): send live X-OmniRoute-Tier on worker, child and mode-switch handlers
- `bb49024cb` fix(parallel_tasks): accept 1-4 tasks and return recoverable argument errors

All commands were run from `/Users/celes/sources/celesrenata/menagerie/src` unless noted.

## Focused suites

| Command                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run api/providers/__tests__/omniroute.spec.ts core/config/__tests__/ContextProxy.spec.ts core/config/__tests__/ProviderSettingsManager.spec.ts`                                                                      | 3 files, 115 tests passed (before the PSM test was added); PSM file alone after the addition: 56/56 passed                                                                                                                                         |
| `npx vitest run core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts __tests__/ClineProvider.delegation.spec.ts` | 4 files, 238/238 passed (after item 4, before the new tests)                                                                                                                                                                                       |
| `npx vitest run core/webview/__tests__/ClineProvider.taskHistory.spec.ts core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`                                                                                         | 2 files, 50/50 passed (includes 9 new FIX A tests)                                                                                                                                                                                                 |
| Same two files with `ClineProvider.ts` temporarily restored to `HEAD` (pre-fix), then restored                                                                                                                                   | 6 failed / 44 passed. All 6 expected failures are new FIX A tests: worker set, stale-unset, openai-non-OmniRoute stale, new_task child, parent fallback, mode-switch. The openrouter and anthropic-switch cases pass either way, which is correct. |
| `npx vitest run core/task/__tests__/Task.condensing-handler.spec.ts core/task/__tests__/Task.spec.ts`                                                                                                                            | 2 files, 169/169 passed                                                                                                                                                                                                                            |
| `npx vitest run core/tools/__tests__/ParallelTasksTool.spec.ts --reporter=verbose`                                                                                                                                               | 14/14 passed: 1 task runs; 0 tasks, 5 tasks, missing `message` and duplicate names each give a recoverable error; invalid mode gives a recoverable error; a disabled experiment still goes through `handleError`                                   |
| `npx vitest run core/tools/__tests__/ParallelTasksTool.spec.ts core/prompts/tools/native-tools/__tests__/parallel_tasks.spec.ts`                                                                                                 | 2 files passed                                                                                                                                                                                                                                     |
| `npx vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts`                                                                                                                                                   | 32/32 passed. The stringified 2-element array parses to 2 tasks through `parallelTasksSchema`, and a stringified 1-element array passes the schema.                                                                                                |

## Cross-fix run (plan item 10)

`npx vitest run api/providers/__tests__/omniroute.spec.ts api/providers/__tests__/openai.spec.ts core/config/__tests__ core/webview/__tests__ __tests__/ClineProvider.delegation.spec.ts core/task/__tests__ core/tools/__tests__ core/prompts core/assistant-message/__tests__`

- Files: 136 passed, 3 failed (139). Tests: 2582 passed, 8 failed (2590).
- The 8 failures are already on the base and are not caused by this change. They are snapshot/fragment mismatches in the rules section (`core/prompts/sections/rules.ts` was not touched) in `add-custom-instructions.spec.ts` (3), `system-prompt.spec.ts` (4) and `generateSystemPrompt.spec.ts` (1). To prove this, I temporarily restored all 8 touched source files to `e89164411` and stashed the FIX B edits. The same 3 files still had 8 failures and 49 passes. I then restored the files.

Full suite: `npx vitest run`

- Tests: 9573 passed, 28 failed, 39 skipped (9640).
- 28 failures = the same 8 above + 20 in `__tests__/extension.spec.ts` (`No "EventEmitter" export is defined on the "vscode" mock`). With every touched source file restored to `e89164411`, `extension.spec.ts` still fails 20/20, so these are already on the base.

## Typecheck

`npx tsc --noEmit` (this is `src/package.json` `check-types` = `tsc --noEmit`): exit 0, no errors. Run after FIX A and again after FIX B.

## ESLint ratchet

FIX A: `pnpm exec eslint --prune-suppressions --max-warnings=0 api/providers/omniroute.ts api/providers/__tests__/omniroute.spec.ts core/config/ContextProxy.ts core/config/__tests__/ContextProxy.spec.ts core/config/ProviderSettingsManager.ts core/config/__tests__/ProviderSettingsManager.spec.ts core/webview/ClineProvider.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts core/task/Task.ts core/task/__tests__/Task.condensing-handler.spec.ts` gave exit 0.

FIX B: `pnpm exec eslint --prune-suppressions --max-warnings=0 core/tools/ParallelTasksTool.ts core/tools/__tests__/ParallelTasksTool.spec.ts core/prompts/tools/native-tools/parallel_tasks.ts core/prompts/tools/native-tools/__tests__/parallel_tasks.spec.ts core/assistant-message/presentAssistantMessage.ts core/assistant-message/__tests__/NativeToolCallParser.spec.ts` gave exit 0, with 0 errors and 0 warnings.

`--prune-suppressions` rewrites `src/eslint-suppressions.json` with spaces instead of tabs. I compared the rewritten file to `HEAD` count by count with a node script: 0 counts changed. I reverted the whitespace-only rewrite (`git checkout -- src/eslint-suppressions.json`), so the file is not part of either commit.

Per-file `no-explicit-any` suppression counts (before → after):

- core/webview/ClineProvider.ts: 7 → 7
- core/config/ContextProxy.ts: 1 → 1
- core/config/ProviderSettingsManager.ts: 3 → 3
- core/task/Task.ts: 17 → 17
- core/assistant-message/presentAssistantMessage.ts: 2 → 2
- api/providers/omniroute.ts, core/tools/ParallelTasksTool.ts, core/prompts/tools/native-tools/parallel_tasks.ts: none → none
- No new `as any`. The new tests use `as unknown as Task` for the minimal task/parent doubles, each with a comment explaining why. A single `as { tasks: ParallelTaskSpec[] }` from `unknown` feeds raw model arguments.

## Hygiene

- No `.changeset/*`, `CHANGELOG.md` or `src/CHANGELOG.md` changes (`git status --short src` was clean after the commits).
- Temporary files `/tmp/ClineProvider.fixed.ts`, `/tmp/eslint-b.log` and `/tmp/commit.log` were removed. `/tmp/supp-head.json` (a copy of HEAD's suppressions file used for the count diff) was removed too.
- The pre-commit hook (prettier + turbo lint) passed on both commits.

## Persisted Setting Checklist (FIX A)

- Schema (`global-settings.ts`, `provider-settings/openai.ts`): unchanged. The provider field is now a runtime-only carrier.
- `ExtensionState`: unchanged. SettingsView/cachedState: not involved (the existing immediate-save `OmniRouteTierDropdown` flow is untouched).
- ContextProxy persistence: `setProviderSettings` no longer clears or writes `omniRouteTier`, so activating or upserting a profile cannot clobber the global (tested).
- `ProviderSettingsManager.saveConfig`: no longer persists the snapshot (tested). Snapshots already stored are inert because `withOmniRouteTier` overwrites or deletes them.
- `getState()`: same behavior through `withOmniRouteTier`. The existing FEAT-005 getState tests pass.
- `getStateToPostToWebview()`: unchanged.
- Runtime consumers on one rule (`withOmniRouteTier`): getState, the `createTask` handoff (new_task children and parallel workers), `updateTaskApiHandlerIfNeeded` (mode/profile switch) and the `Task.getCondensingApiHandler` condensing profile.
- Import/export: no code change. After the ContextProxy fix, the imported global tier is no longer overwritten by the `setProviderSettings(currentProvider)` that follows.

## Out of scope / known gaps

- The prompt-enhancement call (`messageEnhancer.ts`, `enhancementApiConfigId`) is user-triggered and not part of a task, so it is not injected.
- A live task's handler is not rebuilt when the user changes the tier mid-task (unchanged existing behavior).
- `getTaskHandoffContext` itself is unchanged; `createTask` is the single injection point for children and workers.
