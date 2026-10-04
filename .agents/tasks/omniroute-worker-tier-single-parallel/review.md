# Live OmniRoute tier on child/worker handlers, and 1–4 task parallel_tasks with recoverable argument errors

Two commits on `feat/omniroute-tier-dropdown-feat005` (`a24a57c7e`, `bb49024cb`, base `e89164411`). The working tree has no uncommitted source changes; the only uncommitted tracked change is `.agents/tasks/omniroute-integration/plan.md`, which is unrelated. FIX A stops treating `omniRouteTier` as per-profile data. Profile writes (`ContextProxy.setProviderSettings`, `ProviderSettingsManager.saveConfig`) no longer persist or clobber it, and a new pure helper `withOmniRouteTier(config, globalTier)` stamps the live global onto OmniRoute profiles (and deletes it everywhere else) at each place a task handler config is assembled. FIX B relaxes `parallel_tasks` to 1–4 tasks in the zod schema and the native JSON schema. It also turns schema and argument failures (count, duplicate names, bad mode, missing or invalid todos) into a `formatResponse.toolError` tool result instead of the fatal `handleError` path that produced the user's "Error running parallel tasks: too_small" report.

Watch for: injection happens at four call sites through one helper rather than one chokepoint. Every task-handler path traced is covered, but a future `buildApiHandler` site can silently skip it (likely, non-blocking). The prompt-enhancement profile path loses the tier it used to get from the persisted snapshot (likely, non-blocking).

**Verdict**: APPROVED

## High-level view

The global `omniRouteTier` is now the only source of truth. `withOmniRouteTier` is the single rule: set the tier only when `isOmniRoute(config)` is true and the tier passes `omniRouteTierSchema`, otherwise delete it. `omniRouteRequestHeaders` then emits `X-OmniRoute-Tier` only for a valid tier, so an unset global sends no header and non-OmniRoute profiles never carry one. Stale snapshots already sitting in saved profiles are neutralized rather than migrated, because every injection overwrites or deletes them.

The helper is applied in `getState()` (parent/top-level and history rehydration), in `createTask` on `handoffExecutionContext.apiConfiguration` (new_task children and parallel workers, which both build their `Task` through `createTask`), in `updateTaskApiHandlerIfNeeded` (mode/profile switch), and in `Task.getCondensingApiHandler`. In practice this covers every request-issuing task handler. Structurally it is four sites, not one.

For FIX B, `ParallelTasksTool` separates argument errors (`ZodError` or the new private `ParallelTasksArgumentError`) from runtime errors. The first kind increments the mistake count, records a tool error and pushes a recoverable "provide 1-4 tasks" tool result. Runtime failures (experiment disabled, worker spawning workers, lost provider) still go through `handleError`. The JSON-string `tasks` decode in `NativeToolCallParser` hands any array, including `[]`, to the tool, where it gets the recoverable error. Unparseable strings fall to the `missing nativeArgs` path in `presentAssistantMessage`, which was already recoverable and now says 1–4.

<details>
<summary>Issues (3)</summary>

1. **Per-site injection instead of one chokepoint**: the tier is injected at four call sites, so a new handler-construction path can omit it with no test failing. Consider a guard test asserting that every `buildApiHandler` in `src/core` receives a `withOmniRouteTier` config, or move the injection into a single provider-level builder. Non-blocking.
2. **Enhancement profile drops the tier**: `messageEnhancer` builds from `providerSettingsManager.getProfile(enhancementApiConfigId)`, which no longer contains a tier now that `saveConfig` strips it. A dedicated OmniRoute enhancement profile now sends no `X-OmniRoute-Tier`. Wrap `configToUse` in `withOmniRouteTier(..., globalTier)` if enhancement should honor the ceiling. Non-blocking: user-triggered and outside the task scope.
3. **Mid-task tier change not applied**: a running task keeps the tier it was built with until a mode or profile switch rebuilds the handler. This is pre-existing, but it is relevant to the user's "set to tier 1 but still hits paid providers" report. Note it to the user, or rebuild the current handler when the global tier changes. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Global tier as source of truth, and where it is applied

Before this change, `getState()` copied the global onto the live provider settings, and `saveConfig` persisted that copy into each profile. `setProviderSettings` then cleared or overwrote the global whenever a profile was activated, because the global and provider-schema keys share the name `omniRouteTier`. The fix removes the key from both write paths. `setProviderSettings` filters it from the clear-list and the spread, and `saveConfig` destructures it away. This means activating an old profile with a stale snapshot can no longer reset the user's tier (confirmed, `ContextProxy.ts`, `ProviderSettingsManager.ts`). Both behaviors have tests.

```
global omniRouteTier ──┐
                       ├─ getState()                     → parent / history-restored Task
withOmniRouteTier() ───┼─ createTask(handoffExecCtx)     → new_task child, parallel worker
                       ├─ updateTaskApiHandlerIfNeeded() → mode/profile switch rebuild
                       └─ Task.getCondensingApiHandler() → condensing profile
                                         │
                              omniRouteRequestHeaders() → X-OmniRoute-Tier or nothing
```

In `createTask`, the rewritten `handoffExecutionContext` is placed after `...options` when constructing the `Task`. This ordering is required, because `Task`'s constructor prefers `handoffExecutionContext.apiConfiguration` over `apiConfiguration`. Parallel workers run on a fresh `ClineProvider` that shares the same `contextProxy`, so `this.contextProxy.getValue("omniRouteTier")` in the worker's provider reads the same global (confirmed, `createParallelTaskRuntime`).

The other `buildApiHandler` calls in `src/core` are `ProviderSettingsManager` (model-info probe) and `generateSystemPrompt` (temporary handler for metadata). Neither issues a chat request. The gap risk is therefore forward-looking: nothing structurally forces a new site through the helper (likely).

### Enhancement path after the snapshot removal

`messageEnhancer.enhancePrompt` uses the saved enhancement profile as-is. Before, that profile could contain a persisted (possibly stale) tier. After this change it never does, so enhancement on a separate OmniRoute profile sends no tier header and OmniRoute applies its default routing (likely). The coder documented this as out of scope. It is a small behavioral regression for that one path rather than a new gap.

### parallel_tasks: recoverable vs fatal

Only `ZodError` and `ParallelTasksArgumentError` become tool errors, and `onMalformedCall()` still fires only for schema failures, so the argument-recovery counter semantics are unchanged for mode/todo errors. `addSharedDocumentReader` returns early for fewer than 2 or at least 4 specs, so a 1-task call is not padded with a reader and a 4-task call cannot overflow to 5. The `rules.ts` system-prompt rule still recommends fanning out into 2–4 workers. This is consistent with the new description ("Use 2–4 tasks to run independent scopes concurrently; a single task runs as one isolated worker") and is not a contradiction.

### Verification evidence

`verification.md` records focused suites for both fixes. It includes a pre-fix revert proving that 6 of the new FIX A tests fail without the `ClineProvider.ts` change. It also records 14 ParallelTasksTool cases (1 task runs; 0, 5, missing `message`, duplicate names and invalid mode are recoverable; disabled experiment stays fatal), a passing `tsc --noEmit`, and the eslint ratchet with unchanged per-file suppression counts. The 28 full-suite failures were shown to pre-exist on `e89164411` (rules-section snapshots, `extension.spec.ts` vscode mock). No changesets or CHANGELOG edits, and no new `as any`; test doubles use commented `as unknown as Task`. Not re-run here.

Not tested: a guard that every handler-construction path applies the tier, and the enhancement-profile path.

</details>

<details>
<summary>File map</summary>

- `src/api/providers/omniroute.ts`: new `withOmniRouteTier` helper.
- `src/core/webview/ClineProvider.ts`: `getState`, `createTask` handoff and `updateTaskApiHandlerIfNeeded` use the helper; new private `withLiveOmniRouteTier`.
- `src/core/task/Task.ts`: condensing handler applies the live tier.
- `src/core/config/ContextProxy.ts`: profile writes no longer touch the global `omniRouteTier`.
- `src/core/config/ProviderSettingsManager.ts`: `saveConfig` strips `omniRouteTier`.
- `src/core/tools/ParallelTasksTool.ts`: schema min 1; recoverable argument errors via `formatResponse.toolError`.
- `src/core/prompts/tools/native-tools/parallel_tasks.ts`: `minItems: 1`, description updated to 1–4.
- `src/core/assistant-message/presentAssistantMessage.ts`: missing-nativeArgs hint says 1–4.
- Tests: omniroute, ContextProxy, ProviderSettingsManager, ClineProvider taskHistory/apiHandlerRebuild, Task condensing, ParallelTasksTool, parallel_tasks prompt, NativeToolCallParser.

Full diff: `git diff e89164411..bb49024cb -- src`

</details>
