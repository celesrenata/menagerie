# Implementation Plan — User-adjustable parallel per-capability capacity map

Make the parallel-task per-capability capacity map a persisted, user-adjustable setting (`parallelCapacityMap`) that overrides the hardcoded `STATIC_ROUTE_CAPACITY` at batch start, preserving every deadlock-freedom / floor-of-1 invariant. Default (unset/empty) behavior is a byte-for-byte no-op: today's `STATIC_ROUTE_CAPACITY`.

## Design decisions (made here, grounded in the codebase)

- **Setting name & shape:** `parallelCapacityMap: Partial<Record<RouteCapability, number>>`, a **global** setting (not provider-settings). Rationale: capacity describes the user's whole backend fleet, not a single OpenAI/OmniRoute profile, so it belongs beside `parallelismMode`/`omniRouteTier` in `packages/types/src/global-settings.ts` — the closest analog is `parallelismMode` (a global, schema-validated, defaulted parallelism setting that already round-trips to the webview via `ExtensionState`). The per-custom-route `capability` field (openai.ts) is the *checklist* worked example; `parallelismMode` is the *location/shape* worked example. We follow both.
- **Zod schema:** `z.record(routeCapabilitySchema, z.number().int().positive())` keyed by the five capabilities, `.optional()`. Reuse the existing `routeCapabilitySchema` enum exported from `packages/types/src/provider-settings/openai.ts` (it already mirrors `ROUTE_CAPABILITIES`) so the key set stays in lockstep with the `RouteCapability` union. `z.record` with a key enum rejects unknown-capability keys; `.int().positive()` rejects 0/negative/non-integer — this is the fail-safe at the schema boundary. Rationale: using the shipped enum avoids a second drift point; `positive()` mirrors the existing `slotCountSchema` in routeCapacityMap.ts.
- **Merge semantics:** add a `mergeRouteCapacityMap(userMap)` helper in `routeCapacityMap.ts` that returns a full `Record<RouteCapability, number>` where `effective[cap] = userMap[cap]` (only when a valid positive integer) else `STATIC_ROUTE_CAPACITY[cap]`. Pass the merged map to the existing `createStaticRouteCapacityProvider(mergedMap)`, which already floors each value `>= 1` and falls through to `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` for absent/invalid entries. Rationale: this keeps the floor-of-1 and bounded-unknown-default invariants entirely inside the already-tested provider; the user map can only *replace a value*, never remove the floor. `computeCapacityBounds` is unchanged and operates on the merged provider.
- **Default constant:** no new default value is needed — "unset/empty" merges to exactly `STATIC_ROUTE_CAPACITY`, so the runtime consumer treats `undefined`/`{}` as "use static". We still export a shared validation function so every reader agrees.
- **Persistence/round-trip:** generic. `webviewMessageHandler`'s `updateSettings` loop persists any key via `contextProxy.setValue(key, newValue)` with no special case; import/export (`importExport.ts`) validates per-key against `globalSettingsSchema.shape` and round-trips through `contextProxy.export()/setValues()`. No special handling required.
- **UI home:** a new per-capability numeric grid inside `OmniRouteSettings.tsx` (where e6dc45210's per-route capability field lives and where parallelism/OmniRoute config is surfaced), bound to `cachedState` via `setCachedStateField`. Because `OmniRouteSettings` currently only receives `apiConfiguration`/`setApiConfigurationField`, and this is a *global* setting, pass `parallelCapacityMap` + `setCachedStateField` into it as new props from `SettingsView`.

> Gap/assumption: `OmniRouteSettings` renders its body only when `openAiIsOmniRoute` is true. The capacity map is fleet-wide, so render the new control *outside* the `isOmniRoute` guard (always visible in the OmniRoute section) — assumption recorded; if a reviewer prefers it gated, it is a one-line move.

Verification commands (discovered): `pnpm --dir src check-types`; `pnpm --dir src exec vitest run <path>`; `pnpm --dir packages/types exec vitest run`; `pnpm --dir webview-ui exec vitest run`; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>`; `pnpm --dir src bundle`.

---

- [ ] 1. Define the `parallelCapacityMap` setting + shared validation in `packages/types`.
      Add `export const parallelCapacityMapSchema = z.record(routeCapabilitySchema, z.number().int().positive())` (import `routeCapabilitySchema` from `./provider-settings/openai.js`, or re-export it). Add `parallelCapacityMap: parallelCapacityMapSchema.optional()` to `globalSettingsSchema` (near `parallelismMode`), with a doc comment stating: Partial per-capability slot map; unset/empty = `STATIC_ROUTE_CAPACITY`; values floored `>=1` downstream; invalid/unknown-capability entries rejected at the schema boundary.
      Files: `packages/types/src/global-settings.ts` (and `packages/types/src/provider-settings/openai.ts` only if `routeCapabilitySchema` needs an export tweak — it is already exported).
      Verify: `pnpm --dir packages/types exec vitest run` passes; `pnpm --dir packages/types exec tsc --noEmit` (or the package's check-types) is clean. `parallelCapacityMap` now appears in `GLOBAL_SETTINGS_KEYS` automatically (derived from `globalSettingsSchema.keyof()`).

- [ ] 2. Add `parallelCapacityMap` to `ExtensionState` so the webview can read the persisted value.
      Add `| "parallelCapacityMap"` to the `Pick<GlobalSettings, ...>` union in `ExtensionState` (next to `"parallelismMode"`).
      Files: `packages/types/src/vscode-extension-host.ts`.
      Verify: `pnpm --dir packages/types exec vitest run` and the package type-check pass. No message-type change is needed — the control saves through the existing `updateSettings` message whose `updatedSettings` is typed from settings keys.

- [ ] 3. Add the merge helper to `routeCapacityMap.ts` (pure, floor-preserving).
      Add `export function mergeRouteCapacityMap(userMap: Partial<Record<RouteCapability, number>> | undefined): Record<RouteCapability, number>` that, for each `cap` in `ROUTE_CAPABILITIES`, uses `userMap?.[cap]` when it is a positive integer, else `STATIC_ROUTE_CAPACITY[cap]`. Keep `validateRouteCapacityMap`, `createStaticRouteCapacityProvider`, `computeCapacityBounds`, `DEFAULT_UNKNOWN_CAPABILITY_SLOTS`, `SMALL_FLOOR` unchanged. Document that the floor-of-1 / bounded-unknown-default still live in `createStaticRouteCapacityProvider`, so a user value can only replace a slot count, never defeat the fail-safe.
      Files: `src/core/task/routeCapacityMap.ts`.
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/routeCapacityMap.spec.ts` passes (existing tests untouched); add new cases in step 9. `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/routeCapacityMap.ts` count not increased.

- [ ] 4. Read the setting in `runParallelTasks` and feed the merged map to the provider.
      In `runParallelTasks`, before constructing `routeCapacity`, read the persisted map: `const { parallelCapacityMap } = await provider.getState()` and build `createStaticRouteCapacityProvider(mergeRouteCapacityMap(parallelCapacityMap))`. Import `mergeRouteCapacityMap` from `./routeCapacityMap`. `computeCapacityBounds(routeCapacity)` and the scheduler construction stay exactly as-is (bounds operate on the merged provider). Unset/empty → `mergeRouteCapacityMap` returns `STATIC_ROUTE_CAPACITY` (no-op).
      Files: `src/core/task/runParallelTasks.ts`.
      Verify: `pnpm --dir src check-types` clean; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/runParallelTasks.ts` count not increased. (`provider.getState()` is the established ClineProvider accessor returning the defaulted state.)

- [ ] 5. Add the setting to `ClineProvider.getState()` (default) and `getStateToPostToWebview()` (both destructure + return).
      In `getStateToPostToWebview()`: add `parallelCapacityMap` to the destructuring of the state values and to the returned object (next to `parallelismMode`). In `getState()`: return `parallelCapacityMap: stateValues.parallelCapacityMap` (default `undefined` — unset means static; do NOT default to a concrete map, so the no-op semantics hold). Mirror exactly how `parallelismMode` is handled, except the default is left `undefined`.
      Files: `src/core/webview/ClineProvider.ts`.
      Verify: `pnpm --dir src check-types` clean; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/webview/ClineProvider.ts` count not increased. The storage→webview round trip is now closed (a saved map re-renders instead of reverting).

- [ ] 6. Confirm `webviewMessageHandler` persists the new key with no special case, and add normalization only if needed.
      The `updateSettings` loop ends in `contextProxy.setValue(key, newValue)` for any key — `parallelCapacityMap` persists generically. No new branch is required; the Zod schema in step 1 is the normalization/validation boundary (invalid maps are rejected on import and should be prevented by the UI control in step 8). Add no code unless a reviewer wants defensive re-validation here.
      Files: `src/core/webview/webviewMessageHandler.ts` (read-only confirmation; edit only if adding optional normalization).
      Verify: `pnpm --dir src check-types` clean. (Trace confirmed in exploration: generic `setValue` path at the end of the `for (const [key, value] of Object.entries(message.updatedSettings))` loop.)

- [ ] 7. Thread `parallelCapacityMap` through `SettingsView` cachedState + handleSubmit payload.
      Destructure `parallelCapacityMap` from `cachedState` (near `parallelismMode`). Add `parallelCapacityMap: parallelCapacityMap ?? {}` (or `?? undefined`) to the `updatedSettings` object in `handleSubmit()`. Pass `parallelCapacityMap={parallelCapacityMap}` and the existing `setCachedStateField` into `<OmniRouteSettings ...>` where it is rendered. Do NOT bind the control to live `useExtensionState()` — only `cachedState` (per the Settings View Pattern rule).
      Files: `webview-ui/src/components/settings/SettingsView.tsx`.
      Verify: `pnpm --dir webview-ui exec vitest run` passes (existing SettingsView tests still green); type-check clean.

- [ ] 8. Add the per-capability numeric control to `OmniRouteSettings.tsx`, bound to cachedState.
      Extend `OmniRouteSettingsProps` with `parallelCapacityMap?: Partial<Record<RouteCapability, number>>` and `setCachedStateField: SetCachedStateField<...>` (import the type used by sibling settings components). Render a labeled grid "Parallel backend capacity (slots per capability)" with one numeric input per capability in `ROUTE_CAPABILITY_OPTIONS` (reader/reasoner/long-context/general/vision). Each input: value from `parallelCapacityMap?.[cap] ?? ""` (empty = use default); on change, write back via `setCachedStateField("parallelCapacityMap", nextMap)` where an empty/blank/non-positive entry DELETES that key (so it falls back to default) and a valid positive integer sets it. Help text: an unset capability uses the default and values are floored to `>= 1`. Accessibility: associate a `<label htmlFor>`/`aria-label` per input, `type="number"` `min="1"` `step="1"`, and a `data-testid` per capability (e.g. `parallel-capacity-<cap>`). Render outside the `isOmniRoute` guard (fleet-wide; see Design decisions gap note).
      Files: `webview-ui/src/components/settings/OmniRouteSettings.tsx`.
      Verify: `pnpm --dir webview-ui exec vitest run` passes; new component test from step 9 green.

- [ ] 9. Add focused tests at the lowest layer for each behavior (set + unset/empty cases).
      (a) packages/types schema round-trip: assert `parallelCapacityMapSchema` accepts a valid partial map, rejects 0/negative/non-integer and unknown keys, and `globalSettingsSchema` round-trips `parallelCapacityMap` (include an empty-object and an unset case). File: `packages/types/src/__tests__/global-settings.spec.ts` (or the existing global-settings test file — follow its layout).
      (b) routeCapacityMap merge/floor: extend `routeCapacityMap.spec.ts` — `mergeRouteCapacityMap(undefined)` and `mergeRouteCapacityMap({})` both deep-equal `STATIC_ROUTE_CAPACITY`; a user override replaces one value; an invalid user value (0/negative/non-integer) is ignored and falls back to the static value; the merged map fed to `createStaticRouteCapacityProvider` still floors `>= 1`. File: `src/core/task/__tests__/routeCapacityMap.spec.ts`.
      (c) no-deadlock-under-small-user-capacity: a test that `computeCapacityBounds(createStaticRouteCapacityProvider(mergeRouteCapacityMap({ reasoner: 1 })))` yields `maxInferenceLeases >= 1` and `maxDispatched >= 1` (floor + SMALL_FLOOR invariants hold under a tiny user map), and that a hypothetical `{ reasoner: 0 }` user map still floors to a positive provider slot. File: same spec as (b).
      (d) webview-ui binding/save: a `*.test.tsx` that renders `OmniRouteSettings` (or SettingsView) with a seeded `parallelCapacityMap`, types a value into the reader input, and asserts `setCachedStateField("parallelCapacityMap", ...)` is called with the merged object; and that clearing an input deletes the key. Follow `renderWithExtensionState`/`makeExtensionState` from `@/utils/test-utils`. File: `webview-ui/src/components/settings/__tests__/OmniRouteSettings.test.tsx` (or SettingsView test).
      Files: as listed above.
      Verify: `pnpm --dir packages/types exec vitest run`; `pnpm --dir src exec vitest run src/core/task/__tests__/routeCapacityMap.spec.ts`; `pnpm --dir webview-ui exec vitest run` — all pass.

- [ ] 10. Full verification sweep and lint-count confirmation.
      Run the type-check, the three Vitest suites touched, the bundle, and eslint on every edited `src/` file.
      Files: none (verification only).
      Verify: `pnpm --dir src check-types` clean; `pnpm --dir packages/types exec vitest run` green; `pnpm --dir src exec vitest run src/core/task/__tests__/routeCapacityMap.spec.ts` green; `pnpm --dir webview-ui exec vitest run` green; `pnpm --dir src bundle` succeeds; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/routeCapacityMap.ts src/core/task/runParallelTasks.ts src/core/webview/ClineProvider.ts` — suppression counts not increased.

## Guardrails honored
- No `.changeset`/`CHANGELOG.md` edits.
- `src/api/providers/utils/timeout-config.ts` untouched.
- Deadlock-freedom and floor-of-1 invariants live entirely in the unchanged `createStaticRouteCapacityProvider`; the user map can replace a slot count but never remove the `>= 1` floor or the bounded-unknown default. `computeCapacityBounds` is unchanged.
- Lifecycle #1469/#1021 witnesses are not touched (no change under `taskLifecycle.ts` or the lifecycle model).

## Checklist trace (AGENTS.md "Persisted Setting Checklist")
1. Define + validation + optionality — step 1 (`global-settings.ts`, schema reuses `routeCapabilitySchema`).
2. `ExtensionState` + message types — step 2 (`vscode-extension-host.ts`; existing `updateSettings` message suffices).
3. SettingsView control from `cachedState` not live state — steps 7–8.
4. cachedState update + `updateSettings` payload in `handleSubmit()` — step 7.
5. `webviewMessageHandler` persist via `contextProxy.setValue()` — step 6 (generic path).
6. `ClineProvider.getState()` default — step 5 (default `undefined` = static no-op).
7. BOTH destructure + returned object in `getStateToPostToWebview()` — step 5.
8. Runtime consumer `runParallelTasks` reads setting, passes merged map — step 4.
9. Import/export round-trip — generic via `globalSettingsSchema` shape (confirmed in `importExport.ts`); covered by step 9(a).
10. Tests at the lowest layer (webview binding/save, types schema round-trip, routeCapacityMap merge/floor + no-deadlock, set & unset cases) — step 9.
11. Vitest suites per package — steps 9–10 (`packages/types`, `src`, `webview-ui`).
