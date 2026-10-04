# Design — Workstream A: Condensing API configuration port (`condensingApiConfigId`)

## Scope

This document designs **Workstream A ONLY**: adding a `condensingApiConfigId` global setting that routes context condensing/summarization to a separately chosen model instead of the task's own `this.api`. This moves the heavy summarize load off the GLM mastermind globally, with **no LLM decision** — it is a static config value.

**Out of scope for this design (handled directly by the planner/coder):**

- **B-i** — role/route tier alignment (`READER_MODES` membership in `parallelWorkerRouting.ts`).
- **B-ii** — relaxing `addSharedDocumentReader` auto-reader guards in `ParallelTaskReader.ts`.

Both B-i and B-ii are small, well-understood, localized changes documented in `scope.md`; the planner implements them directly without a design doc. They touch different files than Workstream A and have no ordering dependency on it.

## Overview

The fork already contains a fully wired "pick a different profile for a subtask" feature: `enhancementApiConfigId`. It defines a schema field, surfaces it in `ExtensionState`, persists it, round-trips it through `ClineProvider`, and consumes it by building an `ApiHandler` from `providerSettingsManager.getProfile({ id })`. Workstream A **clones that entire round trip** under a new name, `condensingApiConfigId`, and wires the resulting handler into the three condensing call sites in `Task.ts`.

The design is deliberately a near-mechanical clone because the condensing plumbing already accepts an injected handler: both `manageContext` (`src/core/context-management/index.ts:291`) and `summarizeConversation` (`src/core/condense/index.ts:315`) take `apiHandler: ApiHandler` as a required parameter today. The three call sites currently pass `apiHandler: this.api`. The only new logic is a `Task` helper that resolves which handler to pass, plus its cache-invalidation on mid-task config change.

**Default `undefined` MUST be byte-identical to today's behavior**: the helper returns `this.api` when `condensingApiConfigId` is unset, empty, or references a missing profile. The only new runtime branch is "config set and valid."

## Technology stack (locked)

- **Language:** TypeScript, matching the existing fork. No new dependencies.
- **Schema/validation:** Zod via `globalSettingsSchema` in `packages/types/src/global-settings.ts`.
- **Handler construction:** `buildApiHandler` (already imported in `Task.ts:64`) + `ProviderSettingsManager.getProfile({ id })`.
- **Persistence:** `ContextProxy` through the existing generic `updateSettings` path (see decision below).
- **UI:** React in `webview-ui`, following the `SettingsView` `cachedState` pattern.
- **Tests:** Vitest for `src`, `packages/types`, and `webview-ui`.

## Change-by-change design

### 1. Schema + ExtensionState (`packages/types`)

Add the field to `globalSettingsSchema` in `packages/types/src/global-settings.ts`, immediately after `enhancementApiConfigId` (`global-settings.ts:271`):

```ts
condensingApiConfigId: z.string().optional(),
```

Because `GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options` (`global-settings.ts:315`), adding the field automatically makes `condensingApiConfigId` a valid key for `contextProxy.getValue`/`setValue`, for the generic `updateSettings` persistence loop, and for the import/export schema. No manual key-list edits are needed.

Add the field to the `ExtensionState` `Pick<GlobalSettings, ...>` union in `packages/types/src/vscode-extension-host.ts` beside `enhancementApiConfigId` (the `ExtensionState` block begins at `:268`; `enhancementApiConfigId` appears at `:320`):

```ts
	| "enhancementApiConfigId"
	| "condensingApiConfigId"
```

**Dedicated webview-message type decision:** `enhancementApiConfigId` also appears a second time, at `:546`, inside the `WebviewMessage.type` union (interface begins `:467`). That entry exists because the Prompts tab saves the enhancement profile _immediately_ via a dedicated `{ type: "enhancementApiConfigId", text }` message. Workstream A does **not** replicate that — it uses the batched `updateSettings` save (decision in §2 and §6), so **do NOT add a `condensingApiConfigId` entry to the `WebviewMessage.type` union** and do **NOT** add a dedicated case to `webviewMessageHandler`. Adding one would be dead code and would create a second, un-cached save path that violates the `SettingsView` `cachedState` rule in AGENTS.md.

_Verify:_ `pnpm --dir packages/types exec tsc --noEmit`.

### 2. Persistence (`webviewMessageHandler.ts`) — generic `updateSettings`, NOT a dedicated message

**Decision: route persistence through the existing generic `updateSettings` handler; add no new `case`.** Rationale, after reading the `WebviewMessage` union and the `updateSettings` loop:

- The `updateSettings` handler (`webviewMessageHandler.ts:732`) iterates `Object.entries(message.updatedSettings)` and, for any key without special-case logic, calls `await provider.contextProxy.setValue(key as keyof RooCodeSettings, newValue)` (`:875`), then `postStateToWebview()`. `condensingApiConfigId` is a plain string requiring no normalization or side effects, so it falls through the generic branch and persists for free once it is in the `updateSettings` payload (§6).
- `enhancementApiConfigId` uses a dedicated message (`:2105-2108`) **only because** its UI control (Prompts tab) saves on change rather than on an explicit Save button. That immediate-save pattern is exactly what the AGENTS.md `SettingsView` rule warns against for `cachedState`-bound controls. We deliberately diverge from the enhancement reference here and bind to `cachedState` + batched save instead. This is the one intentional deviation from a pure clone, and it is the AGENTS.md-sanctioned pattern.

So §2 requires **no code change in `webviewMessageHandler.ts`** beyond what §6 already sends. The persistence test in §7 asserts the generic path stores the value.

_Verify:_ `pnpm --dir src exec vitest run src/core/webview/__tests__/webviewMessageHandler.spec.ts`.

### 3. `ClineProvider` round trip — all three `enhancementApiConfigId` locations

`enhancementApiConfigId` appears at exactly three places in `ClineProvider.ts`; add `condensingApiConfigId` adjacent to each:

- **`:2649`** — destructuring of state inside `getStateToPostToWebview()`. Add `condensingApiConfigId,` to the destructured list.
- **`:2824`** — the object returned by `getStateToPostToWebview()`. Add `condensingApiConfigId,` (shorthand, mirroring `enhancementApiConfigId,`).
- **`:3061`** — the object returned by `getState()`, which reads from `stateValues`. Add `condensingApiConfigId: stateValues.condensingApiConfigId,`.

Default semantics: all three pass the value through untouched, so when nothing is stored the value is `undefined`. Per §1/§4, `undefined` means "use the task's own model," preserving today's behavior. Do **not** apply a `?? ""` default in `getState()` — keep it `undefined` so the Task helper's "unset" branch is unambiguous (empty string is also treated as unset in the helper, but `undefined` is the canonical stored form).

This completes the storage→webview round trip so a saved control does not revert visually (the AGENTS.md checklist item that prevents the "saved but reverts" bug).

_Verify:_ `pnpm --dir src exec vitest run src/core/webview/__tests__/ClineProvider.spec.ts`.

### 4. `Task.getCondensingApiHandler()` helper + mid-task cache invalidation

Add a private helper and a cache field to `Task`. The helper resolves the handler to use for condensing: the configured profile's handler when valid, else `this.api`.

**Resolution logic (mirrors the resolution block in `MessageEnhancer.enhanceMessage`, `src/core/webview/messageEnhancer.ts`: the `enhancementApiConfigId && listApiConfigMeta.find(({ id }) => id === enhancementApiConfigId)` guard followed by the `if (providerSettings.apiProvider)` check):**

1. Read provider state via `const provider = this.providerRef.deref()`. If no provider, return `this.api`.
2. Read `const state = await provider.getState()`; take `condensingApiConfigId` and `listApiConfigMeta` from it.
3. If `condensingApiConfigId` is falsy (`undefined`/`""`) → return `this.api`.
4. If `listApiConfigMeta.find(({ id }) => id === condensingApiConfigId)` is **not** found → return `this.api`. **This guard is mandatory**: `ProviderSettingsManager.getProfile({ id })` _throws_ when the id is missing (the `throw new Error(`Config with ID '${id}' not found`)` at `ProviderSettingsManager.ts:480`, guarded by the `if (!entry)` at `:479`), and `getProfile` additionally re-wraps any inner error as `Failed to get profile: ...`. Calling it without first confirming the id is in `listApiConfigMeta` would surface an exception at a condensing site, which is also why the defensive `try/catch` below is appropriate. The reference impl guards the same way.
5. Otherwise `const { name: _name, ...providerSettings } = await provider.providerSettingsManager.getProfile({ id: condensingApiConfigId })`. If `providerSettings.apiProvider` is falsy, treat it as the own-model case and return live `this.api`. (Structurally, `MessageEnhancer.enhanceMessage` does **not** early-return here: it seeds `configToUse` to the base `apiConfiguration` and only overwrites it when `apiProvider` is set, so a coder should not expect to find an explicit `return` in the reference. We achieve the identical net behavior by returning `this.api`.) Else `return buildApiHandler(providerSettings)`.

`providerSettingsManager` is reachable as `provider.providerSettingsManager` — it is `public readonly` on `ClineProvider` (`:354`). `buildApiHandler` is already imported in `Task.ts` (`:64`).

**Stale-handler bug — the single likeliest defect; call it out explicitly.** If the helper builds a handler on first call and caches it unconditionally, then the user switches `condensingApiConfigId` mid-task, subsequent condensing calls would keep using the _old_ model. The design prevents this with a cache keyed by the resolved config id, under **one precise rule** (stated once, no alternatives):

**The single caching rule.** Add two private fields:

```ts
private condensingApiHandler?: ApiHandler          // the BUILT handler only; never this.api
private condensingApiHandlerConfigId?: string      // the id the built handler was built from
```

On every call:

1. Read the current `condensingApiConfigId` from fresh provider state (one `await provider.getState()` — unavoidable, this is how a mid-task change is detected). Call this `currentId`.
2. **If `currentId` equals `this.condensingApiHandlerConfigId` AND `this.condensingApiHandler` is set** → return the cached **built** handler. (The id matched and we previously built one; no re-resolution, no `getProfile`, no `buildApiHandler`.)
3. **Otherwise re-resolve** (steps 3–5 of the resolution logic above):
    - Record `this.condensingApiHandlerConfigId = currentId` so the next call can detect a change.
    - If the outcome is **"use own model"** (unset/empty, id not in `listApiConfigMeta`, no `apiProvider`, dead provider ref, or a caught error) → set `this.condensingApiHandler = undefined` and **return the live `this.api`** (never store it).
    - If the outcome is **"built handler"** → set `this.condensingApiHandler = buildApiHandler(providerSettings)` and return it.

**Why `this.api` is never cached.** `this.api` is rebuilt by the existing `updateApiConfiguration()` (`Task.ts:1851-1856`, invoked from the mid-task profile-change path at `:1887`). The own-model branch therefore must return the _current_ `this.api` at call time, not a captured reference. Returning `this.api` directly (never storing it) keeps the own-model path always current and only caches the comparatively expensive _built_ handler.

**Cost on the default/unset path (honest accounting).** With this rule, the common default-unset path does **one** `await provider.getState()` per call for change detection, then takes the `currentId === this.condensingApiHandlerConfigId` branch (both are `undefined` after the first call) and returns live `this.api` — it does **not** re-run `getProfile` or `buildApiHandler` after the first call, because step 2's equality check also covers the own-model case: once `this.condensingApiHandlerConfigId` is set to `undefined`/`""`, a repeat call with the same unset id matches `this.condensingApiHandlerConfigId` and the built-handler slot is `undefined`, so we skip rebuilding and fall straight to returning `this.api`. (To make step 2 cover the own-model case cleanly, treat it as: _if `currentId` is unchanged, reuse the prior decision — return the cached built handler if present, else live `this.api`_; only a changed id triggers re-resolution.) The sole unavoidable per-call cost on the default path is the single `getState()`. This is a bounded, intentional cost of supporting mid-task change detection; it does not alter condensing output, which remains byte-identical to today (the task's own `this.api`).

Final helper contract:

- **Returns live `this.api`** when unset, empty, missing from `listApiConfigMeta`, profile lookup yields no `apiProvider`, provider ref is dead, or resolution throws — read fresh each call, never a cached reference.
- **Returns a freshly built handler** for the configured profile otherwise, cached until `condensingApiConfigId` changes.
- **Never throws** at the call site: the `listApiConfigMeta` guard prevents the `getProfile` throw; wrap the `getProfile`/`buildApiHandler` in a defensive `try/catch` that logs the fallback reason via the existing provider log (`provider.log(...)`) and falls back to `this.api` on any error, so a malformed profile degrades to today's behavior rather than breaking condensing. Logging is per-call (not deduped); condensing is infrequent, so a persistently malformed profile logging on each condense is acceptable and no last-logged-id dedup state is introduced.

Signature: `private async getCondensingApiHandler(): Promise<ApiHandler>` (async because `getState()` and `getProfile()` are async).

### 5. Thread the resolved handler into the three condensing call sites

No signature changes to `manageContext` or `summarizeConversation` — both already accept `apiHandler`. At each site, replace `apiHandler: this.api` with the resolved handler obtained immediately before the call:

- **`Task.ts:~2011`** — `condenseContext()` → `summarizeConversation({ ... })`. Before the call: `const condensingApiHandler = await this.getCondensingApiHandler()`, then pass `apiHandler: condensingApiHandler`.
- **`Task.ts:~4575`** — `handleContextWindowExceededError()` → `manageContext({ ... })`. Same: resolve, then pass `apiHandler: condensingApiHandler`.
- **`Task.ts:~4834`** — `attemptApiRequest()` → `manageContext({ ... })`. Same.

Resolve the handler **per call site invocation** (not once at construction) so a mid-task config change is picked up. Per §4, repeated resolution costs one `await provider.getState()` per call for change detection, with **no rebuild unless the id changed** — `getProfile`/`buildApiHandler` run only on the first call for a given id and again whenever the id changes.

**Token-counting consistency note (edge case to honor, not change):** `manageContext` uses the _same_ `apiHandler` for `estimateTokenCount` (`context-management/index.ts:322-323, 398, 404-409`) as for summarization. When a separate condensing model is configured, token estimation during condensing will use the condensing model's `countTokens`. This is acceptable and intentional — condensing-time estimates feed the summarization decision, which is the condensing model's concern — and it matches how the enhancement path already uses the chosen profile wholesale. The _main_ request loop's token accounting is unaffected because it uses `this.api` directly (`Task.ts:3320` `this.api.getModel()` etc.), not the condensing handler. Do not try to split token-counting handler from summarization handler; that would be a signature change and is explicitly not wanted.

**Tools-less `createMessage` edge case:** `summarizeConversation` strips tools from its `createMessage` metadata (the summary call does not pass the tool array). Any chosen reader model must accept a tools-less completion. GLM already does, and this is a precondition on the user's chosen reader profile, not something the code enforces — no new validation. Note it as an operator responsibility.

_Verify:_ `pnpm --dir src exec vitest run src/core/condense src/core/context-management src/core/task/__tests__`.

### 6. `SettingsView` control — bound to `cachedState`, included in `handleSubmit()` payload

Follow the AGENTS.md Persisted Setting Checklist and `SettingsView` `cachedState` rule.

- **Context plumbing (`webview-ui/src/context/ExtensionStateContext.tsx`):** add `condensingApiConfigId?: string` to the context type and a default `condensingApiConfigId: ""` in the initial state object, mirroring the `enhancementApiConfigId` entries (`:110, :228`). A dedicated `setCondensingApiConfigId` is **not** required for the `SettingsView` path (that setter exists for enhancement only because of its immediate-save Prompts control); the `SettingsView` control uses `setCachedStateField` instead. Add the field to the context type so `cachedState` carries it.
- **Control placement:** add a profile picker in the `ContextManagementSettings` component (`webview-ui/src/components/settings/ContextManagementSettings.tsx`), alongside `autoCondenseContext` / `autoCondenseContextPercent` — this is the Context/Condensing section, and those sibling fields already flow into `handleSubmit`'s payload (`SettingsView.tsx:409-410`). `ContextManagementSettings` already receives `listApiConfigMeta` and `setCachedStateField` as props (`ContextManagementSettings.tsx:31, :76`), so the picker can list profiles and update cached state through the existing prop surface. Add `"condensingApiConfigId"` to the `SetCachedStateField<...>` key union on the props type (`ContextManagementSettings.tsx:48-51`, where `"autoCondenseContext"` et al. are listed), and bind the new field as a prop too, mirroring how `SettingsView` passes `autoCondenseContext` down. Reuse the `Select`/`SelectItem` pattern from the enhancement picker in `PromptsSettings.tsx:166-190`, listing `listApiConfigMeta` with a `"-"` "use current configuration" option that maps to `""`. **Lint note:** `listApiConfigMeta` is typed `any[]` on the props (`ContextManagementSettings.tsx:31`), so annotate the new `.map` callback parameter explicitly as `(config: { id: string; name?: string }) => ...` rather than inheriting the `any[]` element type. This keeps the new code free of an implicit-any lint hit per AGENTS.md ("fix lint in new code; avoid `as any`"), even though the existing threshold-profile `.map` at `:540` leans on the loose element type.
- **Binding:** the control reads from the destructured `cachedState` value (`condensingApiConfigId`), and `onValueChange` calls `setCachedStateField("condensingApiConfigId", value === "-" ? "" : value)`. It MUST NOT call `vscode.postMessage` on change and MUST NOT read from live `useExtensionState()`. This is the AGENTS.md-mandated buffer-until-save behavior and avoids the race the enhancement Prompts control is exempt from only because it is a deliberate immediate-save flow.
- **Save payload (single rule):** add `condensingApiConfigId: condensingApiConfigId ?? ""` to the `updatedSettings` object in `handleSubmit()` (the object starting at `SettingsView.tsx:390`). Use `""`, not `?? undefined`: `""` lets the user reset to "use current configuration" and survives serialization, matching the `terminalProfile: terminalProfile ?? ""` clear precedent at `SettingsView.tsx:428`; `undefined` would be dropped by `JSON.stringify` in the message pipeline and could not clear a previously-saved value. This is what triggers persistence via the generic `updateSettings` loop (§2).

_Verify:_ `pnpm --dir webview-ui exec vitest run` on the relevant `SettingsView` test; see §7 for cases.

### 7. Import/export round-trip

No new code. `condensingApiConfigId` is a plain string in `globalSettingsSchema` and is **not** in the `globalSettingsExportSchema.omit({...})` list (`ContextProxy.ts:35`), so `contextProxy.export()` includes it and `importSettingsFromPath` restores it via the `contextProxy.setValues(sanitizedGlobalSettings)` call in `importSettingsFromPath` (`importExport.ts:231`) — identical to `enhancementApiConfigId`. It is not a secret, so no special handling. Add a round-trip assertion only (§7 tests), no production change.

## Error handling (concrete, per operation)

- **`getProfile({ id })` throws (id absent, lock/load failure, malformed profile):** Guarded by the mandatory `listApiConfigMeta` membership check _before_ the call, plus a defensive `try/catch` wrapping `getProfile`+`buildApiHandler`. On any thrown error: log the fallback reason via the provider log (`provider.log(...)`) — per-call, not deduped — set the built-handler slot to `undefined` (so a later valid config retries resolution), and fall back to `this.api`. Recoverable; condensing proceeds on the task's own model. Not fatal to the task.
- **Provider ref dead (`this.providerRef.deref()` is undefined):** return `this.api`. Recoverable, not logged (expected during teardown).
- **`buildApiHandler(providerSettings)` throws (invalid provider settings):** same as the `getProfile` catch — log the fallback reason (per-call), fall back to `this.api`.
- **Chosen model rejects a tools-less `createMessage` at summarize time:** surfaces inside `summarizeConversation`'s existing error path, which already returns `{ error }` in its `SummarizeResponse` and is handled by callers today. No new handling; the failure is the operator's model choice, not a code defect. The existing condensing-failure UX applies unchanged.
- **Config changed mid-task:** handled by cache invalidation in §4; not an error.
- **Persistence failure in `contextProxy.setValue`:** existing `updateSettings` behavior; not changed by this feature.

## Validation rules (external input)

The only external input is `condensingApiConfigId`:

- **Type:** `string`, **optional**. Enforced by `z.string().optional()` in the schema.
- **Semantics:** must be an existing profile `id` in `listApiConfigMeta` to take effect. **Not** validated at write time (the webview sends whatever profile the user picked); validated at **read/use time** in `getCondensingApiHandler()` via the `listApiConfigMeta` membership guard. An id that no longer exists (profile deleted after being chosen) silently falls back to `this.api` — the correct, non-breaking behavior.
- **Empty string / undefined:** both mean "use the task's own model." Canonical stored form is `undefined` (unset) or `""` (explicitly cleared via the picker); the helper treats both as unset.
- **Limits:** none beyond "is a known profile id."
- **Behavior on failure:** fall back to `this.api`; never throw at a condensing site.

## Invariant ownership

- **"Default/unset behavior is identical to today (`this.api`)":** owned by `Task.getCondensingApiHandler()` (§4). It is the single resolution point; all three call sites delegate to it, so the invariant is enforced in one place rather than replicated at each site.
- **"Handler reflects the current config, never stale":** owned by the id-keyed cache in `getCondensingApiHandler()` (§4), under the single caching rule stated there — only the _built_ handler is cached, keyed by config id; it is re-resolved on any id change, and the own-model branch always returns live `this.api` (never a stored reference), so an `updateApiConfiguration()` mid-task is always reflected.
- **"Round-trip persistence (saved value survives reload and is re-shown)":** owned jointly by the schema (§1), the generic `updateSettings` loop (§2), and all three `ClineProvider` locations (§3). Missing any one of the three ClineProvider edits reintroduces the "saved but reverts" bug — this is why §3 enumerates all three.
- **"Edits buffer until Save":** owned by `SettingsView` `cachedState` (§6). The control must not post on change.

## Testability

**Unit-testable (preferred layer — most coverage here):**

1. **Helper selection logic (`Task.getCondensingApiHandler`)** — unit test in `src/core/task/__tests__`. Cases: (a) unset → returns `this.api` (identity assertion); (b) set but id absent from `listApiConfigMeta` → returns `this.api`, and asserts `getProfile` is **not** called; (c) set and valid → returns a handler built from the chosen profile (assert `buildApiHandler` called with the resolved `providerSettings`, and the returned handler is not `this.api`); (d) profile lookup yields no `apiProvider` → returns `this.api`; (e) `getProfile` throws → returns `this.api` and logs; (f) **mid-task change**: first call with id A caches a built handler, change state to id B → second call rebuilds (asserts a second `buildApiHandler`), change to unset → returns `this.api`. Mock the provider, `getState`, `providerSettingsManager.getProfile`, and `buildApiHandler`.
2. **Three-site threading** — unit test asserting each of `condenseContext`, `handleContextWindowExceededError`, and `attemptApiRequest` passes the handler returned by `getCondensingApiHandler()` (spy it) into `summarizeConversation`/`manageContext` as `apiHandler`. With config unset, assert the passed handler is `this.api` (proves default parity at all three sites). With config set, assert it is the built handler.
3. **Persistence** — `webviewMessageHandler.spec.ts`: send `updateSettings` with `condensingApiConfigId` and assert `contextProxy.setValue("condensingApiConfigId", <value>)` was called and `postStateToWebview` ran (proves the generic path, confirming no dedicated case is needed).
4. **`ClineProvider.getStateToPostToWebview`** — `ClineProvider.spec.ts`: set `condensingApiConfigId` in stored state, assert the posted state object includes it (round-trip, prevents the revert bug). Include both set and unset cases.
5. **Import/export** — `importExport.spec.ts`: export includes `condensingApiConfigId`; import restores it via `setValues`. Assert it is not stripped (not in the omit list).

**Webview-layer tests (`webview-ui`, Vitest + JSDOM):** 6. **`SettingsView` binding/save** — using `renderWithExtensionState`/`makeExtensionState` per `webview-ui/AGENTS.md`. The condensing picker renders inside `ContextManagementSettings` (where `autoCondenseContext`/`autoCondenseContextPercent` live), so split the coverage across the two existing harnesses the fork already uses for comparable controls:

- **(a) set case** — in `ContextManagementSettings.spec.tsx`, render with a non-empty `listApiConfigMeta`, select a profile in the picker, and assert `setCachedStateField("condensingApiConfigId", <id>)` was called. This mirrors the existing `expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContext", false)` assertion in that file. Then, in `SettingsView.spec.tsx`, drive the control and click Save and assert a `vscode.postMessage` with `{ type: "updateSettings" }` whose `updatedSettings.condensingApiConfigId` equals the chosen id.
- **(b) unset case** — with no selection (the `"-"` "use current configuration" option), assert the picker's `onValueChange` maps `"-"` to `""` via `setCachedStateField("condensingApiConfigId", "")`, and that a Save with no condensing selection carries `condensingApiConfigId: ""` in the `updateSettings` payload (not dropped). This exercises the clear-to-empty semantics and the AGENTS.md "both set/unset" requirement.
- **(c) cachedState binding (revert-on-discard) — the key AGENTS.md assertion, specified concretely.** Cases (a)/(b) pass identically whether the control is bound to `cachedState` or live state, so (c) is what actually proves the buffer-until-save rule. Mirror the existing `"discards NanoGPT cached edits and restores the extension values"` test in `SettingsView.unsaved-changes.spec.tsx:736-762`, which is the fork's established revert-on-discard pattern:
    1.  Mock `useExtensionState()` to return a `condensingApiConfigId: ""` (and a `listApiConfigMeta` containing at least one profile) as the live/extension value.
    2.  Render `SettingsView`, select a profile in the condensing picker so `cachedState.condensingApiConfigId` becomes the chosen id. Assert **no** `vscode.postMessage` was emitted on change (proves it is NOT an immediate-save control — distinguishing it from the enhancement Prompts control).
    3.  Click `settings:common.done`, then click `settings:unsavedChangesDialog.discardButton` (the discard affordance the harness exposes).
    4.  `await waitFor(...)` and assert the condensing picker now shows the live/extension value (`""`, "use current configuration"), NOT the discarded edit. This proves the edit lived only in `cachedState` and the control re-initializes from live state on discard. Also assert `postMessage` was never called with `{ type: "updateSettings" }` carrying the discarded id.

Together these satisfy the AGENTS.md Persisted Setting Checklist "UI binding/save behavior" item with both set and unset cases, and specifically prove the `cachedState` (not live `useExtensionState()`) binding via the concrete discard-and-revert flow rather than an abstract assertion.

**Integration vs e2e:** No `apps/vscode-e2e` test is needed. This feature does not depend on the real extension host, activation, file watchers, or cross-process messaging beyond what the unit/webview layers prove. Per AGENTS.md Test Placement Guidance, the regression (condensing routed to the wrong model, or saved-but-reverts) is fully representable at the unit/webview layer, so no e2e is added. **Task Lifecycle gate does not apply** — no file under `src/core/task-persistence/taskLifecycle.ts` is touched; `pnpm lifecycle:model-check` is not required (confirm during implementation).

## Build / verify commands (per AGENTS.md)

- Types: `pnpm --dir packages/types exec tsc --noEmit`, then `pnpm --dir src exec tsc --noEmit`.
- Lint each edited file: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` (suppression counts must not increase).
- Narrow Vitest suites listed in each §.Verify above, run from the package directory that declares Vitest (`src`, `packages/types`, `webview-ui`).

## Summary of files touched

| File                                                                                                                             | Change                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/global-settings.ts`                                                                                          | add `condensingApiConfigId: z.string().optional()`                                                                                                |
| `packages/types/src/vscode-extension-host.ts`                                                                                    | add `condensingApiConfigId` to `ExtensionState` `Pick` (NOT to `WebviewMessage.type`)                                                             |
| `src/core/webview/ClineProvider.ts`                                                                                              | add at all 3 `enhancementApiConfigId` sites (`:2649`, `:2824`, `:3061`)                                                                           |
| `src/core/task/Task.ts`                                                                                                          | add `getCondensingApiHandler()` + cache fields; thread into 3 condensing sites (`:~2011`, `:~4575`, `:~4834`)                                     |
| `webview-ui/src/context/ExtensionStateContext.tsx`                                                                               | add field to context type + default                                                                                                               |
| `webview-ui/src/components/settings/ContextManagementSettings.tsx`                                                               | add `cachedState`-bound condensing profile picker; extend `SetCachedStateField` key union + props                                                 |
| `webview-ui/src/components/settings/SettingsView.tsx`                                                                            | pass the field/prop down to `ContextManagementSettings`; include `condensingApiConfigId: condensingApiConfigId ?? ""` in `handleSubmit()` payload |
| (no change) `webviewMessageHandler.ts`, `importExport.ts`, `ContextProxy.ts`, `condense/index.ts`, `context-management/index.ts` | persist/round-trip/thread for free via existing generic paths                                                                                     |

## Responses to design review findings

### Iteration 2 (current review: 3 MEDIUM + 4 NIT, 0 HIGH — all addressed)

This revision responds to the latest `design-review.md` / `design-review.json` (verdict `CHANGES_REQUESTED`). All three MEDIUM findings were factual drift (a wrong file path and two off-by-one/one-off line numbers) plus one under-specified reference shape; all four NITs are confirmations or small clarity notes. Every finding is **addressed** (none backlogged or ignored), and each fix was re-verified against the live code before applying.

- **Finding 1 (MEDIUM — wrong file path / method name for the resolution reference).** Addressed. §4 now cites "the resolution block in `MessageEnhancer.enhanceMessage` (`src/core/webview/messageEnhancer.ts`): the `enhancementApiConfigId && listApiConfigMeta.find(({ id }) => id === enhancementApiConfigId)` guard followed by the `if (providerSettings.apiProvider)` check." Verified the file exists only at `src/core/webview/messageEnhancer.ts` (not `src/core/prompts/`) and that the logic is the static method `MessageEnhancer.enhanceMessage`.

- **Finding 2 (MEDIUM — `getProfile` throw line `:477-479` → `:480`).** Addressed. §4 step 4 now cites the `throw new Error(`Config with ID '${id}' not found`)` at `ProviderSettingsManager.ts:480`, guarded by `if (!entry)` at `:479`, and notes `getProfile` re-wraps inner errors as `Failed to get profile: ...` (justifying the defensive `try/catch`). Verified the throw is on line 480.

- **Finding 3 (MEDIUM — no-`apiProvider` fallback shape must match the reference).** Addressed. §4 step 5 now states that `MessageEnhancer.enhanceMessage` does **not** early-return when `apiProvider` is falsy — it seeds `configToUse` to the base `apiConfiguration` and only overwrites when `apiProvider` is set — and that we achieve the identical net behavior by returning `this.api`. This prevents a coder from hunting for a nonexistent explicit `return` in the reference. Test case (d) is unchanged, as the reviewer directed. Verified the reference's seed-and-overwrite shape in `messageEnhancer.ts`.

- **Finding 4 (NIT — insertion point ambiguity).** Addressed. §1 now says "immediately after `enhancementApiConfigId` (`global-settings.ts:271`)," removing above/below ambiguity. Verified `enhancementApiConfigId: z.string().optional()` is at `:271`.

- **Finding 5 (NIT — optional type + `""` default for the context entry).** Confirmation only; no change needed. §6 already specifies `condensingApiConfigId?: string` on the context type plus a `condensingApiConfigId: ""` default, matching the verified `enhancementApiConfigId?: string` (`:110`) / `enhancementApiConfigId: ""` (`:228`) reference.

- **Finding 6 (NIT — annotate the new picker's `.map` callback).** Addressed. §6 now instructs annotating the `listApiConfigMeta.map` callback parameter as `{ id: string; name?: string }` so the new code does not inherit the `any[]` element type (`ContextManagementSettings.tsx:31`), satisfying the AGENTS.md fix-lint-in-new-code rule.

- **Finding 7 (NIT — bare `getState()` pass-through, no `?? ""`).** Confirmation only; no change needed. §3 already keeps all three `ClineProvider` locations (`:2649`, `:2824`, `:3061`) as bare pass-through with no `?? ""` default, matching the reference.

### Iteration 1 (prior review: 2 MEDIUM + 4 NIT, 0 HIGH — all addressed)

This design was first revised in response to an earlier `design-review` round (verdict `CHANGES_REQUESTED`, 2 MEDIUM + 4 NIT, 0 HIGH). Every finding was **addressed** (none backlogged or ignored); each resolution stays within the original Workstream A requirements (clone the `enhancementApiConfigId` round trip, default-unset == today's `this.api` behavior).

- **Finding 1 (MEDIUM — self-contradictory cache rule in §4; unstated per-call `getState()` cost on the default path).** Addressed. §4 now states a **single** caching rule with no alternatives: cache only the _built_ handler keyed by config id (`condensingApiHandlerConfigId` + `condensingApiHandler`); on an unchanged id reuse the prior decision (cached built handler, or live `this.api` for the own-model case) without re-running `getProfile`/`buildApiHandler`; re-resolve only on id change. The contradicting "cache `this.api` under the id key" sentence was deleted. Added an explicit, honest cost accounting: the default/unset path does exactly one `await provider.getState()` per call for change detection and nothing more after the first call. The §5 "cheap repeated resolution" wording was corrected to "one `getState()` per call for change detection; no rebuild unless the id changed," and the Invariant-ownership bullet was aligned to the single rule.

- **Finding 2 (MEDIUM — §7 webview test case (c) underspecified; cannot prove the `cachedState` rule).** Addressed. §7 case 6(c) is now concrete, mirroring the fork's existing revert-on-discard test `"discards NanoGPT cached edits and restores the extension values"` (`SettingsView.unsaved-changes.spec.tsx:736-762`): render with live `condensingApiConfigId: ""`, select a profile, assert **no** `postMessage` on change, click Done → discard, then assert the picker reverts to the live value and no `updateSettings` carried the discarded id. (a)/(b) were also split across `ContextManagementSettings.spec.tsx` (where the picker renders and `setCachedStateField` is asserted, mirroring the existing `autoCondenseContext` assertion) and `SettingsView.spec.tsx` (the Save payload).

- **Finding 3 (NIT — `importExport.ts:232` → `:231`).** Addressed. §7 now references "the `contextProxy.setValues(sanitizedGlobalSettings)` call in `importSettingsFromPath` (`importExport.ts:231`)"; verified the actual line is 231.

- **Finding 4 (NIT — `messageEnhancer.ts:51-55` undershoots the `apiProvider` guard).** Addressed. §4 now cites "the `enhanceMessage` resolution block in `messageEnhancer.ts` (the `enhancementApiConfigId && listApiConfigMeta.find(...)` guard and its `providerSettings.apiProvider` check)" with no pinned line range.

- **Finding 5 (NIT — "log once" implies dedup state not specified).** Addressed. §4 and Error handling now say "log the fallback reason via `provider.log(...)` — per-call, not deduped," explicitly accepting per-call logging given condensing's low frequency, and introducing no last-logged-id state.

- **Finding 6 (NIT — Save payload "or ?? undefined / ?? \"\"" ambiguity).** Addressed. §6 now states a single rule: `condensingApiConfigId: condensingApiConfigId ?? ""`, with the rationale (clears to "use current," survives serialization, matches `terminalProfile` precedent at `SettingsView.tsx:428`; `undefined` would be dropped by `JSON.stringify`). The alternative was deleted.

All 19 verified assumptions in the review stand; the two line-number corrections (findings 3 and the `updateApiConfiguration` reference, now `:1851-1856`/`:1887`) were applied. No finding required deviating from the requirements or the enhancement-clone approach.
