# Verification — User-adjustable parallel per-capability capacity map (`parallelCapacityMap`)

## Status

- Review verdict: **APPROVED** (`review.json`, no findings).
- Feature commit: `f69d3037c` on `main` (ahead of `origin/main`).
- This document records the **final full verification pass** (post-approval). All
  commands below were re-run fresh against the current tree; every command exited 0
  with no fixes required and no suppression-count increase.

## Setting name + schema

- Setting key: **`parallelCapacityMap`**
- Schema (`packages/types/src/global-settings.ts:81`):

  ```ts
  export const parallelCapacityMapSchema = z.record(routeCapabilitySchema, z.number().int().positive())
  ```

  - Record key is the five-capability enum `routeCapabilitySchema`, so unknown-capability
    keys (e.g. `{nope: 4}`) are rejected at the schema boundary.
  - Values are positive integers only (`z.number().int().positive()`), so `0`, negative,
    and non-integer values are rejected at persist/import time.
- Attached optional on `globalSettingsSchema` (`global-settings.ts:216`):
  `parallelCapacityMap: parallelCapacityMapSchema.optional()`.
  Because `GLOBAL_SETTINGS_KEYS` is derived from the schema `keyof()`, the key is
  auto-registered for storage and import/export with no separate list edit.

## Persisted Setting Checklist — each step traced to file/line

| # | Checklist step | Where satisfied (file:line) |
|---|----------------|------------------------------|
| 1 | Define setting, validation, optionality | `packages/types/src/global-settings.ts:81` (`parallelCapacityMapSchema`), `:216` (`parallelCapacityMap: parallelCapacityMapSchema.optional()`) |
| 2 | Include in `ExtensionState` | `packages/types/src/vscode-extension-host.ts:341` (`\| "parallelCapacityMap"` in the `Pick` union) |
| 3 | `SettingsView` reads from local `cachedState`, NOT live state | `webview-ui/src/components/settings/SettingsView.tsx:229` (`parallelCapacityMap` destructured from `cachedState`); passed to the control at `:835` with `setCachedStateField` |
| 4 | Update `cachedState` from control + include in `updateSettings` payload | `webview-ui/src/components/settings/SettingsView.tsx:462` (`parallelCapacityMap: parallelCapacityMap ?? {}` in `handleSubmit`); control writes via `setCachedStateField` in `OmniRouteSettings.tsx` |
| 5 | `webviewMessageHandler` persists via `ContextProxy` | generic `updateSettings` → `contextProxy.setValue(key, newValue)` loop; `parallelCapacityMap` needs no special-case branch (confirmed by review; generic path handles it) |
| 6 | `ClineProvider.getState()` with intended default | `src/core/webview/ClineProvider.ts:3198` (`parallelCapacityMap: stateValues.parallelCapacityMap`) — deliberately NO concrete default (`undefined` when unset), because `mergeRouteCapacityMap(undefined)` deep-equals `STATIC_ROUTE_CAPACITY` |
| 7 | `getStateToPostToWebview()` destructure + return | `src/core/webview/ClineProvider.ts:2784` (destructure) and `:2954` (return) — closes the storage→webview round trip so a saved control re-renders instead of reverting |
| 8 | Runtime consumers | `src/core/task/routeCapacityMap.ts:104` (`mergeRouteCapacityMap`); `src/core/task/runParallelTasks.ts:303-304` (reads `provider.getState()`, feeds `createStaticRouteCapacityProvider(mergeRouteCapacityMap(parallelCapacityMap))` to the scheduler) |
| 9 | Import/export round-trip | Covered by `globalSettingsSchema.shape` membership (schema is optional, no special handling needed — not a secret/non-exportable value); asserted in `packages/types/src/__tests__/global-settings.test.ts` |
| 10 | Focused tests (UI binding/save, persistence/normalization, `getStateToPostToWebview`) | `packages/types/src/__tests__/global-settings.test.ts` (schema accept/reject + round-trip set/empty/unset + `GLOBAL_SETTINGS_KEYS`); `src/core/task/__tests__/routeCapacityMap.spec.ts` (merge/floor + no-deadlock); `webview-ui/src/components/settings/__tests__/OmniRouteSettings.spec.tsx` (binding/save, clear-deletes-key, invalid-deletes-key) |

## Merge + floor + fail-safe semantics (invariant proof)

Three independent layers each keep every per-capability slot count `>= 1`; none is
load-bearing alone, so a user map can tune a slot count but can never reintroduce the
0-lease deadlock:

```
user input ──► schema  z.number().int().positive()   ──► rejects 0 / -1 / 1.5 / unknown-key at persist/import
            └► mergeRouteCapacityMap()                ──► ignores any non-positive-int override, uses STATIC value
            └► createStaticRouteCapacityProvider()    ──► Math.max(1, resolved) + bounded unknown-capability default
```

`mergeRouteCapacityMap` body (`src/core/task/routeCapacityMap.ts:104`):

```ts
for (const capability of ROUTE_CAPABILITIES) {
  const override = userMap?.[capability]
  merged[capability] =
    override !== undefined && Number.isInteger(override) && override > 0
      ? override
      : STATIC_ROUTE_CAPACITY[capability]
}
```

- A hostile `{reasoner: 0}` (or `-1`, `1.5`, `NaN`) falls back to the static value.
- `createStaticRouteCapacityProvider` and `computeCapacityBounds` are byte-for-byte
  unchanged in `f69d3037c`, so the floor-of-1 (`Math.max(1, …)`) and bounded
  unknown-capability default (`DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2`) still apply, and
  the deadlock-freedom reasoning carries over directly.

## "Unset = today's behavior" no-op proof

- `getState()` returns `parallelCapacityMap: stateValues.parallelCapacityMap` with **no
  concrete default** (`ClineProvider.ts:3198`) — stays `undefined` when the user never
  touches the control.
- `runParallelTasks` reads it and calls
  `createStaticRouteCapacityProvider(mergeRouteCapacityMap(parallelCapacityMap))`
  (`runParallelTasks.ts:303-304`).
- `mergeRouteCapacityMap(undefined)` and `mergeRouteCapacityMap({})` both deep-equal
  `STATIC_ROUTE_CAPACITY` (unit-tested in `routeCapacityMap.spec.ts`), so the provider,
  `computeCapacityBounds`, and the scheduler see **exactly today's capacity** for any
  user who never sets the control. The change is a true no-op absent user input.

## Commands run and results (final pass)

Node engine warning (`wanted node 22.23.1, current v24.21.0`) is pre-existing and
non-fatal; it appears on pnpm-script invocations and does not affect any exit code.

### 1. Typechecks

| Command | Exit | Result |
|---------|------|--------|
| `pnpm --dir src check-types` (`tsc --noEmit`) | 0 | clean |
| `pnpm --dir packages/types check-types` (`tsc --noEmit`) | 0 | clean |
| `pnpm --dir webview-ui check-types` (`tsc`) | 0 | clean |

### 2. Focused Vitest

| Command (from package dir) | Exit | Result |
|----------------------------|------|--------|
| `pnpm exec vitest run src/__tests__/global-settings.test.ts` (packages/types — settings schema round-trip) | 0 | 1 file, **9 passed** |
| `pnpm exec vitest run core/task/__tests__/routeCapacityMap.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts` (src — merge/floor + no-deadlock capacity) | 0 | 2 files, **33 passed** (routeCapacityMap merge/floor 24 + runParallelTasks.capacity no-deadlock 9) |
| `pnpm exec vitest run src/components/settings/__tests__/OmniRouteSettings.spec.tsx` (webview-ui — settings control binding/save) | 0 | 1 file, **15 passed** |

### 3. ESLint prune-suppressions (every edited file) — NO suppression count increased

| Command | Exit | Suppression file delta |
|---------|------|------------------------|
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/routeCapacityMap.ts core/task/runParallelTasks.ts core/webview/ClineProvider.ts core/task/__tests__/routeCapacityMap.spec.ts` | 0 | `src/eslint-suppressions.json` — **NO CHANGE** (ClineProvider `no-explicit-any: 7` unchanged; routeCapacityMap/runParallelTasks: none) |
| `pnpm --dir webview-ui exec eslint --prune-suppressions --max-warnings=0 src/components/settings/OmniRouteSettings.tsx src/components/settings/SettingsView.tsx src/components/settings/__tests__/OmniRouteSettings.spec.tsx` | 0 | `webview-ui/eslint-suppressions.json` — **NO CHANGE** |
| `pnpm --dir packages/types exec eslint --prune-suppressions --max-warnings=0 src/global-settings.ts src/vscode-extension-host.ts src/__tests__/global-settings.test.ts` | 0 | `packages/types/eslint-suppressions.json` (`{}`) — **NO CHANGE** |

### 4. Bundle + compiled-output key presence

| Command | Exit | Result |
|---------|------|--------|
| `pnpm --dir src bundle` (`node esbuild.mjs`) | 0 | success — dist rebuilt (`src/dist/extension.js`) |
| `grep -o "parallelCapacityMap" src/dist/extension.js \| wc -l` | 0 | **10 occurrences** — key present in compiled bundle |
| `grep -o "mergeRouteCapacityMap" src/dist/extension.js` | 0 | present — merge helper compiled in |
| context: `grep -o '…parallelCapacityMap…' src/dist/extension.js` | 0 | `parallelismModeSchema, parallelCapacityMapSchema, DEFAULT_AUTO…` — schema compiled into the extension bundle |

## Guardrails honored

- No `.changeset` / `CHANGELOG.md` edits in the feature commit.
- `src/api/providers/utils/timeout-config.ts` untouched.
- Deadlock-freedom / floor-of-1 invariants live entirely in the unchanged
  `createStaticRouteCapacityProvider`; `computeCapacityBounds` unchanged.
- No `as any`; no floating promises added. Settings View Pattern honored (control bound
  to `cachedState`, not live `useExtensionState()`).
- No temporary files left behind (lint-baseline snapshots written only to `/tmp`).

## Conclusion

All four verification categories pass with exit code 0 and no fixes required. The
setting is defined, validated, persisted, round-tripped to the webview, consumed by the
scheduler, compiled into the shipped bundle, and fully covered by focused tests at the
schema, merge/floor/no-deadlock, and UI-binding layers. Unset remains a byte-for-byte
no-op. Verification is **finalized — PASS**.
