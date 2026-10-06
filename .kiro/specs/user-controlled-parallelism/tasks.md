# Implementation Plan: User-Controlled Parallelism (FEAT-011)

## Overview

Implement the user-facing parallelism appetite control bottom-up and test-first. The pure resolution logic in `packages/types` lands first (enum, schema, policy table, resolvers) with fast-check property tests, then the additive request-envelope field and `ExtensionState` carry, then host wiring in `webviewMessageHandler`, then the webview `Parallelism_Control`, then `ChatView` submit-time capture, and finally the optional `SettingsView` mirror. Each step builds on the previous one and ends wired into the chat submit path. Numeric ceiling enforcement is owned by `elastic-parallel-execution` and is explicitly not implemented here — this feature only resolves ceilings and hands the policy to the `BoundedElasticScheduler`.

## Tasks

- [x] 1. Define `ParallelismMode` enum, default, and schema in `packages/types`
  - [x] 1.1 Add `PARALLELISM_MODES`, `ParallelismMode`, `DEFAULT_PARALLELISM_MODE`, and `parallelismModeSchema` in `packages/types/src/global-settings.ts`
    - Add `PARALLELISM_MODES = ["conservative","balanced","auto","aggressive","max"] as const` and `type ParallelismMode = (typeof PARALLELISM_MODES)[number]`
    - Add `DEFAULT_PARALLELISM_MODE: ParallelismMode = "auto"`
    - Add `parallelismModeSchema = z.enum(PARALLELISM_MODES)` and add `parallelismMode: parallelismModeSchema.optional()` to the global settings schema (default `"auto"` semantics when unset)
    - Export all symbols from the package index so webview and host can import them
    - _Requirements: 2.1, 2.4, 4.1, 9.1, 9.3_
    - _Properties: 1_

  - [ ]* 1.2 Write schema unit tests for `parallelismModeSchema`
    - Assert the schema accepts exactly the five members and rejects non-members
    - Assert the intended default resolves to `"auto"` when unset
    - _Requirements: 2.1, 2.4, 4.1, 9.1_

- [x] 2. Implement the parallelism policy types and pure resolvers in `packages/types`
  - [x] 2.1 Add `ParallelismPolicy`, `Ceiling`, `DEFAULT_PARALLELISM_POLICY_TABLE`, and `resolveParallelismPolicy` in `packages/types/src/parallelism-policy.ts`
    - Define `type Ceiling = number | "dynamic" | "saturate"` and the `ParallelismPolicy` interface (`maxLive`, `maxRunnable`, `readerSwarm`, `speculation`, `workStealing`, `dynamicFanOut`)
    - Define `DEFAULT_PARALLELISM_POLICY_TABLE` with the exact per-mode values from the design table (conservative `3/2/2` off/off; balanced `6/4/4` limited/on; auto `12/dynamic/dynamic` mastermind-controlled/on + dynamicFanOut; aggressive `10/8/4` enabled/on + dynamicFanOut; max `12/12/saturate` enabled/on + dynamicFanOut)
    - Implement `resolveParallelismPolicy(mode): ParallelismPolicy` returning the table entry (total over the enum)
    - Export the new symbols from the package index
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_
    - _Properties: 1_

  - [x] 2.2 Add `normalizeParallelismMode` and `resolveEffectiveParallelismMode` in `packages/types/src/parallelism-policy.ts`
    - `normalizeParallelismMode(value: unknown): ParallelismMode` returns the mode when it is a member, otherwise `"auto"` (handles `undefined`, numbers, arbitrary strings; no throw)
    - `resolveEffectiveParallelismMode(envelope, savedDefault): ParallelismMode` applies precedence envelope → saved → `"auto"`, normalizing both inputs
    - _Requirements: 2.5, 3.6, 8.5_
    - _Properties: 1, 6_

  - [ ]* 2.3 Write fast-check property test for policy resolution totality (Property 1)
    - **Property 1: Policy resolution totality**
    - **Validates: Requirements 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 4.1, 9.1**
    - Tag: `// Feature: user-controlled-parallelism, Property 1: resolveParallelismPolicy over normalize(x) is total and returns the exact Default_Policy_Table entry; MAXIMUM CHAOS => "max"; invalid => "auto"`
    - fast-check (>=100 iters) over arbitrary values: `resolveParallelismPolicy(normalizeParallelismMode(x))` deep-equals the table entry for the normalized mode; pin the five concrete entries and the `"max"`/invalid→`"auto"` cases as examples
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 4.1, 9.1_

  - [ ]* 2.4 Write fast-check property test for scheduler hand-off equality (Property 6)
    - **Property 6: Scheduler hand-off equality**
    - **Validates: Requirements 3.6, 8.5**
    - Tag: `// Feature: user-controlled-parallelism, Property 6: supplied policy == resolveParallelismPolicy(effective mode)`
    - fast-check (>=100 iters) over `(envelope, savedDefault)` including invalid inputs: resolved policy equals `resolveParallelismPolicy(resolveEffectiveParallelismMode(envelope, savedDefault))` with precedence envelope → saved → `"auto"`
    - _Requirements: 3.6, 8.5_

  - [ ]* 2.5 Write fast-check property tests for ceiling-not-target and Auto scaling (Properties 4 and 5)
    - **Property 4: Ceiling, not target (no filler)** and **Property 5: Auto dynamic scaling by useful decomposition**
    - **Validates: Requirements 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.6, 8.2**
    - Tag P4: `// Feature: user-controlled-parallelism, Property 4: resolved policy is an upper bound; worker count = min(useful, ceiling); no filler for any mode`
    - Tag P5: `// Feature: user-controlled-parallelism, Property 5: Auto worker count tracks useful decomposition bounded by route capacity`
    - P4: over `(mode, u)` assert allowed worker count `= min(u, ceiling(mode))`, never `> u`, no filler for any mode incl. `"max"`; example `u=2` under `"max"` yields 2
    - P5: over `(u, c)` assert Auto worker count `= min(u, c)`, equals `u` when `u <= c`; examples 2→2 and (4 readers+1 reasoner+1 verifier)→6
    - Implement the small pure `min(useful, ceiling)` helper under test in `packages/types/src/parallelism-policy.ts` and export it
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.6, 8.2_

- [x] 3. Checkpoint - pure resolution layer
  - Ensure all `packages/types` tests pass, ask the user if questions arise.

- [x] 4. Add the additive `parallelism` envelope field and `ExtensionState` carry
  - [x] 4.1 Add `parallelism?: ParallelismMode` to the `newTask` and `messageResponse` `askResponse` `WebviewMessage` variants in `packages/types/src/vscode-extension-host.ts`
    - Add only the `parallelism?: ParallelismMode` field; do NOT redefine `omniRouteTier`/`requestTier`
    - Add `parallelismMode` to `ExtensionState` (`Pick<GlobalSettings, ...>`) so the webview can read the saved default
    - _Requirements: 6.1, 9.2, 9.6_

  - [ ]* 4.2 Write unit tests for the envelope shape and `ExtensionState` carry
    - Assert `newTask`/`messageResponse` accept `{ text, images?, omniRouteTier?, parallelism? }` and reject invalid `parallelism`
    - Assert `ExtensionState` includes `parallelismMode` and that `omniRouteTier` typing is unaffected (backward compat)
    - _Requirements: 6.1, 9.2, 9.6_

- [x] 5. Wire host resolution and persistence in `webviewMessageHandler`
  - [x] 5.1 Resolve the effective mode and hand the policy to the scheduler
    - On `newTask`/`messageResponse`, compute `resolveEffectiveParallelismMode(envelope.parallelism, saved)` then `resolveParallelismPolicy(...)` and supply the result to the `BoundedElasticScheduler` as its `User_Parallelism_Policy` (hand-off only; no enforcement here)
    - _Requirements: 3.6, 8.2, 8.5_
    - _Properties: 6_

  - [x] 5.2 Persist the parallelism default on `updateSettings`
    - When an `updateSettings` payload carries `parallelismMode`, persist it via `contextProxy.setValue("parallelismMode", mode)` (generic setting path)
    - Add `parallelismMode` to `ClineProvider.getState()` default (`"auto"`) and to both the destructuring and returned object in `getStateToPostToWebview()` so the saved default round-trips to the webview
    - _Requirements: 9.1, 9.3, 9.5_

  - [ ]* 5.3 Write unit tests for host resolution and persistence
    - Assert the policy supplied to the scheduler equals `resolveParallelismPolicy(resolveEffectiveParallelismMode(...))` (mocked scheduler), covering envelope-present, saved-default-only, and unset cases
    - Assert `updateSettings` persists via `contextProxy.setValue` (mocked) and that `getStateToPostToWebview()` returns the saved value and default `"auto"` when unset
    - _Requirements: 3.6, 8.5, 9.1, 9.3, 9.5_

- [x] 6. Checkpoint - host wiring
  - Ensure all host-side tests pass, ask the user if questions arise.

- [x] 7. Implement the `Parallelism_Control` composer component
  - [x] 7.1 Create `Parallelism_Control` in `webview-ui/src/components/chat/ParallelismControl.tsx`
    - Popover selector mirroring `OmniRouteTierDropdown`, rendered beside it in the composer toolbar
    - Props `{ selectedParallelismMode, onSelect, disabled?, triggerClassName? }`; `onSelect` is a synchronous composer-local update
    - Define `PARALLELISM_MODE_LABELS` (Conservative/Balanced/Auto/Aggressive/MAXIMUM CHAOS); MAXIMUM CHAOS selects internal `"max"`
    - Offer exactly five options; trigger label derives from local state (appetite label, never a GPU/worker count); unset presents Auto as active
    - MAY post `updateSettings({ parallelismMode })` asynchronously as a separate action; label and per-request value do not await it
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.2, 2.3, 4.2_

  - [ ]* 7.2 Write JSDOM rendering tests for the control
    - Assert it renders beside `OmniRouteTierDropdown`; exactly five options; correct labels; MAXIMUM CHAOS yields `"max"`; trigger label derives from local state (appetite label, not a count); unset presents Auto as active
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.2, 2.3, 4.2_

- [x] 8. Wire `ChatView` composer-local state and submit-time capture
  - [x] 8.1 Add composer-local `selectedParallelismMode` state and render the control
    - Initialize `useState<ParallelismMode | undefined>(savedDefaultParallelismMode from ExtensionState)` (undefined presents Auto)
    - Render `Parallelism_Control` beside the tier selector, wiring `onSelect` to the synchronous local setter (independent of tier and reasoning state)
    - _Requirements: 1.1, 1.5, 4.2, 7.1, 7.2, 7.3_
    - _Properties: 3_

  - [x] 8.2 Attach `parallelism` at submit time on `newTask` and `messageResponse` `askResponse`
    - Read `selectedParallelismMode` synchronously at submit; spread `...(selectedParallelismMode ? { parallelism: selectedParallelismMode } : {})` onto both outbound messages
    - Omit the field when unset; do not mutate an already-sent payload; never derive from async persistence or `cachedState`
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.5_
    - _Properties: 2_

  - [ ]* 8.3 Write JSDOM test for request-scoped atomic capture (Property 2)
    - **Property 2: Request-scoped atomic capture**
    - **Validates: Requirements 1.5, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.5**
    - Select a mode then submit synchronously; assert the outbound `newTask` carries the just-selected `parallelism` without awaiting persistence; repeat for the `messageResponse` `askResponse` branch
    - Race-is-gone test: select a new mode and submit in the same tick, assert the new value rides even though `updateSettings` has not resolved
    - Omit-when-unset test: no `parallelism` field when local state is undefined
    - Post-submit mutation test: change the control after submit, assert the captured payload is unchanged
    - _Requirements: 1.5, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.5_

  - [ ]* 8.4 Write JSDOM test for orthogonality (Property 3)
    - **Property 3: Orthogonality of the three dimensions**
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - Tag: `// Feature: user-controlled-parallelism, Property 3: changing one dimension leaves the other two unchanged`
    - Assert changing the parallelism mode leaves selected tier and reasoning effort unchanged, and changing the tier leaves parallelism and reasoning unchanged
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 8.5 Write backward-compatibility regression test
    - Assert `omniRouteTier` behavior and the existing composer are unaffected by adding the parallelism control (field omitted leaves existing paths intact)
    - _Requirements: 9.6_

- [x] 9. Checkpoint - webview wiring
  - Ensure all `webview-ui` tests pass, ask the user if questions arise.

- [x] 10. Add the optional `SettingsView` mirror
  - [x] 10.1 Add a parallelism-default control to `SettingsView` bound to `cachedState`
    - Bind the control to local `cachedState` (NOT live `useExtensionState()`), include `parallelismMode` in the `updateSettings` payload sent by `handleSubmit()` on Save, and ensure it round-trips via `getStateToPostToWebview()`
    - The per-request value must remain sourced from composer-local state only; the mirror must not become a per-request source
    - _Requirements: 9.4, 9.5_

  - [ ]* 10.2 Write JSDOM tests for the SettingsView mirror
    - Assert the control binds to `cachedState`, Save includes `parallelismMode` in `updateSettings`, and the value round-trips; add a test asserting the per-request value does not depend on `cachedState`
    - _Requirements: 9.4, 9.5_

- [x] 11. Final checkpoint - run narrowest suites and lint
  - Run the narrowest Vitest suites from `packages/types`, the host package, and `webview-ui`; run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <edited-files>` and confirm suppression counts did not increase. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses, and property-test tasks reference the design's correctness property by number.
- Numeric ceiling **enforcement** is owned by `elastic-parallel-execution`; this feature only resolves ceilings and hands the `User_Parallelism_Policy` to the `BoundedElasticScheduler`. No e2e is required.
- `omniRouteTier`/`requestTier` are owned by `immediate-tier-semantics` and must not be redefined; this feature adds only the `parallelism` field.
- The `SettingsView` mirror (task 10) is optional per the design; if added, follow the AGENTS.md cached-state rule so it cannot reintroduce an async-settings race.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "4.1"] },
    { "id": 4, "tasks": ["4.2", "5.1", "5.2", "7.1"] },
    { "id": 5, "tasks": ["5.3", "7.2", "8.1"] },
    { "id": 6, "tasks": ["8.2"] },
    { "id": 7, "tasks": ["8.3", "8.4", "8.5", "10.1"] },
    { "id": 8, "tasks": ["10.2"] }
  ]
}
```
