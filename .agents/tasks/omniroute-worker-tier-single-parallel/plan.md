# Implementation Plan: worker X-OmniRoute-Tier + single-task parallel_tasks

Branch: `feat/omniroute-tier-dropdown-feat005` (already checked out, no worktree). Repo root: `/Users/celes/sources/celesrenata/menagerie`.
Rules (AGENTS.md): no changesets, no CHANGELOG edits, no `as any`, ESLint suppression counts must not increase. Prefer typed doubles; a double assertion (`as unknown as Task`) is allowed only with a one-line comment explaining why.

Commands (run from repo root unless noted):

- Tests: `pnpm --dir src exec vitest run <path relative to src>`
- Types: `pnpm --dir src check-types`
- Lint per touched file: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <path relative to src>`. Then confirm the file's count in `src/eslint-suppressions.json` did not go up. Current baselines: ClineProvider.ts no-explicit-any 7, ContextProxy.ts 1, ProviderSettingsManager.ts 3, Task.ts 17, presentAssistantMessage.ts 2. omniroute.ts, ParallelTasksTool.ts and parallel_tasks.ts have none.

FIX A and FIX B are independent. Do A (items 1-6), then B (items 7-9), then item 10.

---

## Design decisions (FIX A)

D1. The global `omniRouteTier` is the only source of truth, and nothing stores a per-profile value. The schema comment in `packages/types/src/provider-settings/openai.ts:108-112` already describes the profile field as a runtime carrier: getState() copies the global onto the profile. Nothing in the design calls for per-profile overrides. Keep the schema field, because `omniRouteRequestHeaders()` and `OpenAiHandler` read it from `ProviderSettings`/`ApiHandlerOptions` and removing it would mean changing the types package. Just stop persisting it and stop ContextProxy from copying profile values into it.

D2. Investigation found that `omniRouteTier` is in both `GLOBAL_SETTINGS_KEYS` and `PROVIDER_SETTINGS_KEYS`. I confirmed this by computing the intersection from `packages/types/dist`: it is `['rateLimitSeconds','omniRouteTier']`. Both entries map to one globalState key. `ContextProxy.setProviderSettings()` (src/core/config/ContextProxy.ts:510-532) clears every provider key that is not supplied, then writes `...values`. As a result, every profile activation either wipes the user's global tier (when the profile has no snapshot) or overwrites it with the stale snapshot. If we only stopped persisting the snapshot in `saveConfig`, every mode switch would reset the tier to unset, which is a regression. So `setProviderSettings` must stop touching `omniRouteTier`. This is the precondition for D1. Do not touch `rateLimitSeconds`; it is upstream per-profile behavior and out of scope.

D3. A single pure helper `withOmniRouteTier(configuration, tier)` in `src/api/providers/omniroute.ts` owns the tier rule:

- It returns a shallow copy.
- When `isOmniRoute(configuration)` and `tier` passes `omniRouteTierSchema`, it sets `omniRouteTier = tier`.
- In every other case it deletes `omniRouteTier`: non-OmniRoute profiles, an unset global, or an invalid value.

Because it deletes, a stale snapshot already stored in a saved profile can never leak or override the global, so no cleanup migration is needed. `ClineProvider` wraps the helper as a private `withLiveOmniRouteTier(configuration)` that reads `this.contextProxy.getValue("omniRouteTier")`.

D4. The injection chokepoint is `ClineProvider.createTask()`, not `getTaskHandoffContext()`. Every child (new_task via `delegateParentAndOpenChild`, ClineProvider.ts:3941/4007) and every parallel worker (`runParallelTasks` → `createParallelTaskRuntime` → a new `ClineProvider` sharing the same `contextProxy` → `createTask`, ClineProvider.ts:3366-3398) goes through `createTask(…, { handoffExecutionContext })`. The `Task` constructor then builds its handler from `handoffExecutionContext.apiConfiguration` (Task.ts:635-636). Normalizing the handoff context inside `createTask`, then passing the normalized object to `new Task` after `...options`, covers both callers and any future caller that builds a context some other way. It also runs after `runParallelTasks` mutates `openAiModelId` (runParallelTasks.ts:44-51). `apiConfiguration` from `getState()` is already injected.

D5. Two more task paths build a handler from a raw saved profile, and the same chokepoint idea must cover them:

- `ClineProvider.updateTaskApiHandlerIfNeeded()` (ClineProvider.ts:1840-1868) is called by `activateProviderProfileUnlocked` and `upsertProviderProfile` with the raw profile. This is the parent orchestrator switching modes onto a saved profile. Without the fix, the parent's own handler loses the header after D1 and D2.
- `Task.getCondensingApiHandler()` (Task.ts:1876-1928) builds from the `condensingApiConfigId` profile. It already has `state` from `provider.getState()`, so use `withOmniRouteTier(providerSettings, state.omniRouteTier)` there. Do not read contextProxy inside Task, because 16 Task test files construct Task with mock providers.

Out of scope, mention in the final report only:

- The `enhancementApiConfigId` prompt-enhancement call (src/core/webview/messageEnhancer.ts:80) is user-triggered and not part of a task.
- A live task's handler is not rebuilt when the user changes the tier mid-task. That is today's behavior and was not asked for.

---

- [ ]   1. Add the pure tier helper `withOmniRouteTier` with unit tests.
       Export `withOmniRouteTier(configuration: ProviderSettings, tier: number | undefined): ProviderSettings` beside `isOmniRoute`/`omniRouteRequestHeaders`. Import `omniRouteTierSchema` from `@roo-code/types`; it is already exported from `packages/types/src/global-settings.ts:32`, so no types change is needed. Behavior follows D3, and the input is never mutated.
       Files: `src/api/providers/omniroute.ts`, `src/api/providers/__tests__/omniroute.spec.ts`
       Tests (unit): OmniRoute + tier 1 → `omniRouteTier: 1` and `omniRouteRequestHeaders(result)` equals `{ "X-OmniRoute-Tier": "1" }`. OmniRoute + `undefined` with a stale `omniRouteTier: 4` on the input → key removed, headers `{}`. Non-OmniRoute openai (`openAiIsOmniRoute: false`) and anthropic, each with a stale value and tier 1 → key removed, headers `{}`. Invalid tiers 0, 6, 2.5 → key removed. The input object is unchanged.
       Verify: `pnpm --dir src exec vitest run api/providers/__tests__/omniroute.spec.ts` passes. Lint `api/providers/omniroute.ts` is clean.

- [ ]   2. Stop `ContextProxy.setProviderSettings` from clearing or writing the global `omniRouteTier` (D2).
       Drop `"omniRouteTier"` from the clear-list reduce, and strip it from `values` before `setValues`. For example, `const { omniRouteTier: _omniRouteTier, ...profileValues } = values`, following the `id: _id` pattern used in ClineProvider. Add a short comment: the key is a global setting that shares a name with the provider schema, and a profile write must never clobber it. `getProviderSettings()` stays as is, because `getState()` normalizes it.
       Files: `src/core/config/ContextProxy.ts`, `src/core/config/__tests__/ContextProxy.spec.ts`
       Tests (unit, extend the existing setProviderSettings describe):
        - With global tier 2, `setProviderSettings({ apiProvider: "openai", openAiIsOmniRoute: true })` leaves `getValue("omniRouteTier") === 2`.
        - With global 2, a profile carrying a stale `omniRouteTier: 5` still leaves it at 2.
        - With the global unset, a profile carrying 5 leaves it `undefined`.
        - Other provider keys are still cleared and written as before. The existing tests continue to pass.
          Verify: `pnpm --dir src exec vitest run core/config/__tests__/ContextProxy.spec.ts` passes. Lint `core/config/ContextProxy.ts`; the count stays at 1 or lower.

- [ ]   3. Stop persisting the frozen `omniRouteTier` snapshot in `ProviderSettingsManager.saveConfig` (D1). Depends on item 2.
       In `saveConfig` (ProviderSettingsManager.ts:428-447), destructure `omniRouteTier` out of the `downgradeLegacyRooConfig(...).config` result before the schema parse. That type is the flat `ProviderSettingsWithId`, so the destructure type-checks. Comment that the global is the source of truth and is injected at handler-build time. Leave existing stored snapshots alone, since D3 makes them inert. The non-active-profile token refresh at ClineProvider.ts:2193 also calls `saveConfig`, so it is covered automatically.
       Files: `src/core/config/ProviderSettingsManager.ts`, `src/core/config/__tests__/ProviderSettingsManager.spec.ts`
       Tests (unit): saving `{ apiProvider: "openai", openAiIsOmniRoute: true, openAiModelId: "hybrid/reader", omniRouteTier: 3 }` stores a config with no `omniRouteTier` that keeps the other fields and the id. Saving a non-OmniRoute profile is unchanged.
       Verify: `pnpm --dir src exec vitest run core/config/__tests__/ProviderSettingsManager.spec.ts` passes. Lint `core/config/ProviderSettingsManager.ts`; the count stays at 3 or lower.

- [ ]   4. Inject the live global at the task chokepoints in `ClineProvider` (D3, D4, D5). Depends on item 1.
       Add a private `withLiveOmniRouteTier(configuration: ProviderSettings): ProviderSettings` that returns `withOmniRouteTier(configuration, this.contextProxy.getValue("omniRouteTier"))`.
       a) `getState()` (~2942-2952): replace the inline if/delete block with the helper, keeping the apiProvider-default assignment first. Behavior must be identical.
       b) `createTask()` (~3509-3544): compute `const handoffExecutionContext = options.handoffExecutionContext && { ...options.handoffExecutionContext, apiConfiguration: this.withLiveOmniRouteTier(options.handoffExecutionContext.apiConfiguration) }`. Use it in `getEffectiveTaskApiConfiguration(...)`, and pass it explicitly to `new Task({ ..., ...options, handoffExecutionContext, rateLimitClock })` so it overrides the spread.
       c) `updateTaskApiHandlerIfNeeded()` (~1840): normalize `providerSettings` with the helper at the top, before the rebuild comparison.
       Files: `src/core/webview/ClineProvider.ts`
       Verify:
        - `pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts __tests__/ClineProvider.delegation.spec.ts` passes. The three existing FEAT-005 getState tests at ClineProvider.spec.ts:1535-1585 are the regression guard for (a).
        - `pnpm --dir src check-types` passes.
        - Lint `core/webview/ClineProvider.ts`; the count stays at 7 or lower.

- [ ]   5. Add the required FIX A integration tests for worker, child and mode-switch handlers. Depends on items 1-4.
       Placement: `src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts`. This is integration-level. It already mocks `Task` and drives the real `createTask` with `handoffExecutionContext` (see ~713-756), and no extension host is needed. Add a `describe("OmniRoute tier on handoff profiles")`.
       Stub `provider["providerSettingsManager"].getModeConfigId` and `.getProfile` with `vi.spyOn` (typed, no `as any`). Use a minimal parent double that provides `taskId`, `workspacePath`, `apiConfiguration`, `getTaskApiConfigName()` and `getTaskMode()`; a double assertion with a comment is acceptable here. Exercise the exact worker sequence: `const ctx = await provider.getTaskHandoffContext(parent, "omni-hybrid-reader", true)`, then `provider.createTask("w", undefined, parent, { handoffExecutionContext: ctx, parallelWorker: true, startTask: false })`. Read the captured `vi.mocked(Task).mock.calls.at(-1)[0].handoffExecutionContext.apiConfiguration`, and assert both `omniRouteTier` and `omniRouteRequestHeaders(captured)`. `omniRouteRequestHeaders` is exactly what `OpenAiHandler` spreads into its client `defaultHeaders`; `openai.spec.ts:140-185` already proves handler construction.
       Cases:
        - Saved OmniRoute profile without a snapshot, global `omniRouteTier` set to 1 → header `"1"`.
        - Saved OmniRoute profile with a stale snapshot of 4 and the global unset → no `omniRouteTier` and headers `{}`.
        - Saved non-OmniRoute profile (openrouter, and openai with `openAiIsOmniRoute: false` and a stale 3), global set to 1 → no key and headers `{}`.
        - new_task child path: mode differs from the parent, `preferSavedModeProfile` false → header present.
        - Parent-fallback path: no saved profile for the mode → the context comes from the parent and still carries the live global, even when the parent config had a different stale value.
          In `src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`, add a mode-switch test: `activateProviderProfile` with a saved OmniRoute profile that has no snapshot, global 2 → `mockTask.updateApiConfiguration` called with `expect.objectContaining({ omniRouteTier: 2 })`. Add the non-OmniRoute counterpart, which is called without the key.
          Verify: `pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.taskHistory.spec.ts core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts` passes, and the new tests fail when item 4b/4c is reverted (check locally, then restore).

- [ ]   6. Inject the tier into the condensing handler (D5). Depends on item 1.
       In `Task.getCondensingApiHandler()`, build with `buildApiHandler(withOmniRouteTier(providerSettings, state.omniRouteTier))`.
       Files: `src/core/task/Task.ts`, `src/core/task/__tests__/Task.condensing-handler.spec.ts`
       Tests (unit, the spec already mocks `buildApiHandler` and `getState`, see ~87-120):
        - OmniRoute condensing profile + `state.omniRouteTier: 1` → `mockBuildApiHandler` called with `objectContaining({ omniRouteTier: 1 })`.
        - The same profile with the state tier unset and a stale snapshot of 5 → called with a config that has no `omniRouteTier`.
        - Non-OmniRoute profile + tier 1 → no key.
          Verify: `pnpm --dir src exec vitest run core/task/__tests__/Task.condensing-handler.spec.ts core/task/__tests__/Task.spec.ts` passes. Lint `core/task/Task.ts`; the count stays at 17 or lower.

### Persisted Setting Checklist triggered by FIX A

The setting already exists, so this only changes the round trip and the consumers. Record each line in the final report.

- [x] Schema (`global-settings.ts:143`, `provider-settings/openai.ts:112`): unchanged. The provider field stays as a runtime-only carrier (D1).
- [x] `ExtensionState` (`vscode-extension-host.ts:277`): unchanged.
- [x] SettingsView / cachedState: not involved. The tier uses the existing deliberate immediate-save flow (`OmniRouteTierDropdown` → `updateSettings`). Do not touch it.
- [ ] Persistence through ContextProxy: item 2. A profile activate or upsert must no longer clobber the global.
- [ ] `ClineProvider.getState()` default (unset → no header): item 4a, behavior unchanged.
- [x] `getStateToPostToWebview()` destructure/return (2614, 2779): unchanged. The existing FEAT-005 tests guard it.
- [ ] Every runtime consumer uses the same default semantics through `withOmniRouteTier`: getState, createTask handoff, updateTaskApiHandlerIfNeeded, condensing (items 4 and 6).
- [ ] Import/export: `importExport.ts:230-242` imports globals and then calls `setProviderSettings(currentProvider)`. After item 2 the imported global wins instead of being clobbered by the profile. Imported profiles with a snapshot are inert (D3). No code change; mention in the report.
- [ ] Tests cover the set, unset and non-OmniRoute cases (items 1, 2, 3, 5, 6).

---

## Design decisions (FIX B)

D6. Relax the schema to `.min(1).max(4)`. A one-task call goes through the same `ParallelTasksTool.execute` → `runParallelTasks` path. `addSharedDocumentReader` already returns the specs untouched when `specs.length < 2` (ParallelTaskReader.ts:59), so one task stays one worker.

D7. The live error came from `callbacks.handleError(...)`. In presentAssistantMessage.ts:702-716 that calls `cline.say("error", …)`, which shows the red user-facing "Error running parallel tasks: [zod JSON]", and then pushes a toolError. The fix is to send argument-validation failures down the recoverable path that `UpdateTodoListTool.ts:28-43` and `NewTaskTool.ts:39-90` use: `consecutiveMistakeCount++`, `recordToolError("parallel_tasks")`, `didToolFailInCurrentTurn = true`, `pushToolResult(formatResponse.toolError(msg))`, then return. Do not call `handleError` and do not throw.

Argument failures are:

- any `ZodError`: count, malformed spec, or duplicate names
- `Invalid mode: …`
- `Task X requires todos`
- an unparsable `todos` checklist

Add a module-local `class ParallelTasksArgumentError extends Error` for the non-zod checks, and wrap `parseMarkdownChecklist` so its error becomes one. Keep `task.parallelTaskArgumentRecovery.onMalformedCall()` for ZodError, preserving today's one forced retry. Runtime failures still use `handleError`: provider lost, experiment disabled, a worker spawning workers, and runParallelTasks/git errors.

The message is built by an exported `formatParallelTasksArgumentError(error)`. It always contains the literal `1-4 tasks` and the zod issue paths and messages. Example: `Invalid parallel_tasks arguments: provide 1-4 tasks, each with a unique name, mode, message, todos (string or null) and route (string or null). Problems: tasks: Array must contain at least 1 element(s)`.

---

- [ ]   7. Relax the schema and make argument errors recoverable in ParallelTasksTool (D6, D7).
       Change `tasks: z.array(parallelTaskSpecSchema).min(2).max(4)` to `.min(1).max(4)`. Replace `parallelTasksSchema.parse(input)` with `safeParse`; on failure, follow the recoverable path. Add `ParallelTasksArgumentError` and `formatParallelTasksArgumentError`. Route the mode, todos and checklist checks through it. In `catch`, handle `ZodError` and `ParallelTasksArgumentError` recoverably; everything else goes to `handleError` as today. Import `formatResponse` from `../prompts/responses`.
       Files: `src/core/tools/ParallelTasksTool.ts`, `src/core/tools/__tests__/ParallelTasksTool.spec.ts`
       Tests (unit, `core/tools/__tests__/ParallelTasksTool.spec.ts`; follow the mock style of `newTaskTool.spec.ts` but without `as any`):
        - Use `vi.mock("vscode")` with `workspace.getConfiguration().get` returning false, `vi.mock("../../task/runParallelTasks")` resolving `{ batchId: "b", tasks: [] }`, and the real built-in modes.
        - The task double provides `providerRef.deref()` → `{ getState: async () => ({ experiments: { parallelTasks: true }, customModes: [] }) }`, `parallelWorker: false`, `cwd`, `consecutiveMistakeCount`, `recordToolError: vi.fn()`, `didToolFailInCurrentTurn`, and `parallelTaskArgumentRecovery: new ParallelTaskArgumentRecovery()` with spies. A double assertion to `Task` is acceptable with a comment.
          Cases:
        - Schema: 1 task accepted; 0 and 5 rejected. Update the existing "allows three Code workers…" assertions as needed.
        - 1 task: `execute` resolves, `askApproval` is called, `runParallelTasks` is called with exactly 1 spec, `pushToolResult` gets the JSON result, and `handleError` is not called.
        - 0 tasks and 5 tasks: `await expect(execute(...)).resolves.toBeUndefined()`. `pushToolResult` is called once with a string that parses as `{ status: "error" }` and contains `1-4 tasks`. `handleError`, `askApproval` and `runParallelTasks` are not called. `didToolFailInCurrentTurn` is true and `recordToolError` was called with `"parallel_tasks"`.
        - Malformed (a spec missing `message`; duplicate names): same recoverable assertions.
        - Invalid mode slug: recoverable `toolError` containing `Invalid mode`, and `handleError` is not called.
        - Experiment disabled: still goes through `handleError`, so the runtime path is unchanged.
          Verify: `pnpm --dir src exec vitest run core/tools/__tests__/ParallelTasksTool.spec.ts` passes. Lint `core/tools/ParallelTasksTool.ts` with 0 suppressions.

- [ ]   8. Update the native tool schema, the description and the missing-nativeArgs retry hint to 1–4.
        - In `src/core/prompts/tools/native-tools/parallel_tasks.ts`, set `minItems: 1` and keep `maxItems: 4`.
        - Change the description opening to "Run 1–4 independent full Zoo tasks, each in its own tab and Git worktree… Use 2–4 to run independent scopes concurrently; a single task runs as one isolated worker." Use an en dash to match the existing style.
        - Keep "Never call with {} or an empty tasks array". Change the trailing failure sentence to say a failed call returns a tool error and should be retried with 1–4 tasks.
        - In `src/core/assistant-message/presentAssistantMessage.ts:571`, change "Retry parallel_tasks alone with 2–4 independent tasks" to "1–4".
        - Leave `src/core/prompts/sections/rules.ts:171` as is. It is guidance on when to fan out (2–4 workers for independent parts), not the argument contract.
          Files: `src/core/prompts/tools/native-tools/parallel_tasks.ts`, `src/core/prompts/tools/native-tools/__tests__/parallel_tasks.spec.ts`, `src/core/assistant-message/presentAssistantMessage.ts`
          Tests (unit): extend `parallel_tasks.spec.ts` to assert `properties.tasks` matches `{ minItems: 1, maxItems: 4 }`, the description contains `1–4` and does not contain `Run 2–4`, and the existing assertions still hold.
          Verify: `pnpm --dir src exec vitest run core/prompts/tools/native-tools/__tests__/parallel_tasks.spec.ts core/assistant-message/__tests__ api/providers/__tests__/base-provider.spec.ts core/prompts/__tests__` passes, with no snapshot changes expected because the tool description is not in the prompt snapshots (checked with grep). Lint both source files; the count for presentAssistantMessage.ts stays at 2 or lower.

- [ ]   9. Lock the stringified-array path from commit 5f0341ba1 against the schema.
       In `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts`, extend the existing "decodes a parallel_tasks tasks array sent as a JSON-encoded string" test (~395). Also assert that `parallelTasksSchema.parse(result.nativeArgs).tasks` has length 2. Add a sibling case where a stringified 1-element array decodes to `{ tasks: [one] }` and passes `parallelTasksSchema`. No parser source change is expected: `NativeToolCallParser.ts` ~1027-1042 already accepts any array, including an empty one, which then reaches the recoverable path from item 7.
       Files: `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts`
       Verify: `pnpm --dir src exec vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts` passes.

---

- [ ]   10. Run final cross-fix verification.
        Steps:
        - `pnpm --dir src check-types`
        - Run every suite touched above in one invocation: `pnpm --dir src exec vitest run api/providers/__tests__/omniroute.spec.ts api/providers/__tests__/openai.spec.ts core/config/__tests__ core/webview/__tests__ __tests__/ClineProvider.delegation.spec.ts core/task/__tests__ core/tools/__tests__ core/prompts core/assistant-message/__tests__`
        - Run ESLint with `--prune-suppressions --max-warnings=0` on every touched source file and confirm no suppression count increased (`git diff src/eslint-suppressions.json` shows only decreases or nothing).
        - `pnpm --dir src test` as the full regression suite.
        - Confirm with `git status` that no `.changeset/*`, `CHANGELOG.md` or `src/CHANGELOG.md` changes exist.

        Do not add e2e. Per AGENTS.md Test Placement, the reducer/unit and ClineProvider integration layers fully represent both bugs, because no real extension host behavior is involved. The existing `apps/vscode-e2e/src/suite/parallel-tasks.test.ts` is left untouched. No lifecycle reducer changes, so `pnpm lifecycle:model-check` is not required.
        Commit locally in two commits (`fix(omniroute): send live X-OmniRoute-Tier on worker, child and mode-switch handlers`, `fix(parallel_tasks): accept 1-4 tasks and return recoverable argument errors`). Do not push.

## Assumptions and gaps

- The user's stored worker profiles may or may not hold a stale snapshot; it lives in VS Code secret storage and could not be checked. D3 makes that irrelevant.
- `getTaskHandoffContext` itself is left unchanged, so `createTask` is the single injection point. If a future path builds a `Task` with `handoffExecutionContext` without going through `createTask`, it would miss the injection. Today none does (grep: `new Task(` only at ClineProvider.ts:1361, which uses getState and is already injected, and 3525).
