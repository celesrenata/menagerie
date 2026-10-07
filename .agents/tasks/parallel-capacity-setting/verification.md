# Verification — User-adjustable parallel per-capability capacity map (`parallelCapacityMap`)

First iteration (no `review.json` present). Implemented from `plan.md`.

## Summary of change

Made the parallel-task per-capability capacity map a persisted, user-adjustable
setting (`parallelCapacityMap`) that overrides the hardcoded `STATIC_ROUTE_CAPACITY`
at batch start. Unset/empty is a byte-for-byte no-op (today's static map). Every
deadlock-freedom / floor-of-1 invariant is preserved: the merge helper can only
replace a slot count, never defeat the `>= 1` floor or the bounded unknown-capability
default, both of which still live entirely inside the unchanged
`createStaticRouteCapacityProvider`. `computeCapacityBounds` is unchanged.

## Merge + floor semantics (the invariant proof)

- `mergeRouteCapacityMap(userMap)` returns a full `Record<RouteCapability, number>`:
  for each capability, `effective[cap] = userMap[cap]` only when it is a positive
  integer, else `STATIC_ROUTE_CAPACITY[cap]`. An omitted / `undefined` / invalid
  (0 / negative / non-integer) user entry falls back to the static value.
- The merged map is passed to the existing `createStaticRouteCapacityProvider`, which
  still floors each value with `Math.max(1, resolved)` and falls through to
  `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` for absent/invalid entries. A user value can
  therefore only tune capacity, never reintroduce the 0-lease deadlock.
- Schema boundary (`parallelCapacityMapSchema = z.record(routeCapabilitySchema, z.number().int().positive())`)
  rejects 0 / negative / non-integer values and unknown-capability keys at persistence
  and import time. Verified empirically (zod 3.25.76): `{}` and partial subsets accepted;
  `{reader:0}`, `{reader:-1}`, `{reader:1.5}`, `{nope:4}` rejected.

## "Unset = today's behavior" proof

- `getState()` returns `parallelCapacityMap: stateValues.parallelCapacityMap` with NO
  concrete default (stays `undefined` when unset).
- `runParallelTasks` reads it and calls
  `createStaticRouteCapacityProvider(mergeRouteCapacityMap(parallelCapacityMap))`.
- `mergeRouteCapacityMap(undefined)` and `mergeRouteCapacityMap({})` both deep-equal
  `STATIC_ROUTE_CAPACITY` (unit-tested), so the provider — and therefore
  `computeCapacityBounds` and the scheduler — see exactly today's capacity for any user
  who never sets the control.

## Files touched (with the AGENTS.md Persisted-Setting-Checklist step each satisfies)

| File | Change | Checklist step |
|------|--------|----------------|
| `packages/types/src/global-settings.ts` | `parallelCapacityMapSchema` + `parallelCapacityMap: ...optional()` on `globalSettingsSchema` (reuses `routeCapabilitySchema`) | 1 (define + validation + optionality); 9 (import/export via `globalSettingsSchema.shape`) |
| `packages/types/src/vscode-extension-host.ts` | `\| "parallelCapacityMap"` added to the `ExtensionState` `Pick` union | 2 (ExtensionState) |
| `src/core/task/routeCapacityMap.ts` | `mergeRouteCapacityMap()` added; `createStaticRouteCapacityProvider`/`computeCapacityBounds`/floors unchanged | 8 (runtime consumer helper) |
| `src/core/task/runParallelTasks.ts` | reads `parallelCapacityMap` from `provider.getState()`, feeds `mergeRouteCapacityMap(...)` to the provider | 8 (runtime consumer) |
| `src/core/webview/ClineProvider.ts` | `getState()` default (`undefined`); `getStateToPostToWebview()` destructure + return | 6 (default); 7 (both destructure + return) |
| `src/core/webview/webviewMessageHandler.ts` | (read-only confirmation) generic `contextProxy.setValue(key, newValue)` path persists it; no special case | 5 (persist via ContextProxy) |
| `webview-ui/src/components/settings/SettingsView.tsx` | destructure from `cachedState`; `parallelCapacityMap ?? {}` in `handleSubmit` payload; pass props to `OmniRouteSettings` | 3, 4 (cachedState binding + updateSettings payload) |
| `webview-ui/src/components/settings/OmniRouteSettings.tsx` | per-capability numeric grid bound to `cachedState` via `setCachedStateField`; empty/invalid entry deletes the key; rendered outside the `isOmniRoute` guard (fleet-wide) | 3, 10 (UI control) |
| `webview-ui/src/i18n/locales/en/settings.json` | `omniroute.parallelCapacity.*` strings (en only, matching the existing en-only omniroute section) | UI copy |
| `packages/types/src/__tests__/global-settings.test.ts` | schema accept/reject + round-trip tests (set, empty, unset) | 10 (persistence/normalization tests) |
| `src/core/task/__tests__/routeCapacityMap.spec.ts` | `mergeRouteCapacityMap` merge/floor + no-deadlock-under-small-user-capacity tests | 10 (merge/floor + no-deadlock) |
| `webview-ui/src/components/settings/__tests__/OmniRouteSettings.spec.tsx` | UI binding/save tests (seed, write, clear-deletes-key, invalid-deletes-key) | 10 (UI binding/save) |

## Commands run and results

| Command | Exit | Result |
|---------|------|--------|
| `pnpm --dir packages/types exec tsc --noEmit` | 0 | clean |
| `pnpm --dir packages/types exec vitest run src/__tests__/global-settings.test.ts` | 0 | 9 passed |
| `pnpm --dir src exec vitest run core/task/__tests__/routeCapacityMap.spec.ts` (from `src/`) | 0 | 24 passed |
| `pnpm --dir src exec vitest run core/task/__tests__/runParallelTasks.capacity.spec.ts` (from `src/`) | 0 | 9 passed (unchanged, still green) |
| `pnpm --dir webview-ui exec vitest run src/components/settings/__tests__/OmniRouteSettings.spec.tsx` | 0 | 15 passed |
| `pnpm --dir webview-ui exec vitest run SettingsView.spec/.unsaved-changes/.change-detection` | 0 | 39 passed |
| `pnpm --dir webview-ui exec tsc --noEmit` | 0 | clean |
| `pnpm --dir src check-types` | 0 | clean |
| `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/routeCapacityMap.ts core/task/runParallelTasks.ts core/webview/ClineProvider.ts` | 0 | clean; `src/eslint-suppressions.json` unchanged (counts NOT increased: routeCapacityMap=none, runParallelTasks=none, ClineProvider no-explicit-any=7 unchanged) |
| `pnpm --dir webview-ui exec eslint --prune-suppressions --max-warnings=0 OmniRouteSettings.tsx SettingsView.tsx OmniRouteSettings.spec.tsx` | 0 | clean; `webview-ui/eslint-suppressions.json` unchanged |
| `pnpm --dir packages/types exec eslint --max-warnings=0 global-settings.ts vscode-extension-host.ts global-settings.test.ts` | 0 | clean |
| `pnpm --dir src bundle` | 0 | success |

## Guardrails honored

- No `.changeset` / `CHANGELOG.md` edits.
- `src/api/providers/utils/timeout-config.ts` untouched.
- Deadlock-freedom and floor-of-1 invariants live entirely in the unchanged
  `createStaticRouteCapacityProvider`; `computeCapacityBounds` unchanged. The user map
  can replace a slot count but never remove the `>= 1` floor or the bounded-unknown
  default. Lifecycle #1469/#1021 witnesses and `taskLifecycle.ts` / the lifecycle model
  not touched.
- No `as any`; no floating promises added. Settings View Pattern honored (control bound
  to `cachedState`, not live `useExtensionState()`).
