# User-adjustable parallel per-capability capacity map (`parallelCapacityMap`)

The parallel-task per-capability capacity map, previously the hardcoded `STATIC_ROUTE_CAPACITY`, becomes a persisted, user-adjustable setting. A partial `Record<RouteCapability, positive-int>` is merged over the static map at batch start by a new `mergeRouteCapacityMap` helper, then fed to the unchanged `createStaticRouteCapacityProvider`. Unset or empty resolves to exactly today's static map, so the change is a true no-op for anyone who never touches the control. Every deadlock-freedom fail-safe (floor-of-1, bounded unknown-capability default) stays inside the untouched provider, so a user map can only tune a slot count, never defeat them. The round trip follows AGENTS.md's Persisted Setting Checklist end to end, including the `getStateToPostToWebview` leg that is easy to forget.

Watch for: nothing blocking. The merge, floor, and schema layers each independently reject a hostile `0`/negative/non-integer entry (confirmed), the webview control binds to `cachedState` not live state (confirmed), and the storage→webview round trip is closed (confirmed).

**Verdict**: APPROVED

## High-level view

The persisted setting is defined once in `packages/types` as `parallelCapacityMapSchema = z.record(routeCapabilitySchema, z.number().int().positive())`, attached optional to `globalSettingsSchema`, and added to the `ExtensionState` Pick union. Because `GLOBAL_SETTINGS_KEYS` is derived from the schema's `keyof()`, the key is auto-registered for storage and import/export without a separate list edit.

The merge and floor story is layered defense. The schema rejects invalid values at the persistence/import boundary; `mergeRouteCapacityMap` independently ignores any non-positive-integer override and falls back to the static value; and `createStaticRouteCapacityProvider` still applies `Math.max(1, …)` plus the bounded unknown-capability default. No single layer is load-bearing for the no-deadlock invariant — any one of them alone keeps a slot count `>= 1`. `computeCapacityBounds` is untouched.

The default is deliberately `undefined` in `ClineProvider.getState()`, which is correct here: `mergeRouteCapacityMap(undefined)` deep-equals `STATIC_ROUTE_CAPACITY`, so leaving the state value absent preserves exact current behavior rather than materializing a concrete default. `runParallelTasks` reads the setting from `provider.getState()` and passes the merged map to the capacity provider.

On the webview, the per-capability numeric grid lives in `OmniRouteSettings` but renders outside the `isOmniRoute` guard (fleet-wide), binds to `cachedState` via `setCachedStateField`, and `SettingsView.handleSubmit` includes `parallelCapacityMap ?? {}` in the `updateSettings` payload. An empty or invalid input deletes the key so the capability falls back to its default rather than persisting a zero. Persistence rides the generic `contextProxy.setValue` path in `webviewMessageHandler` with no special case needed.

Tests cover the schema accept/reject and round-trip (set/empty/unset), the merge/floor and no-deadlock-under-tiny-capacity cases (including a hostile `0`), and the UI binding/save (seed, write, clear-deletes-key, invalid-deletes-key). Both set and unset paths are exercised at each layer.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking action items. The implementation satisfies every Persisted Setting Checklist step and preserves all deadlock-freedom invariants.

</details>

<details>
<summary>Details</summary>

## Checklist round trip, leg by leg

The setting is defined in `packages/types/src/global-settings.ts`: `parallelCapacityMapSchema` reuses `routeCapabilitySchema` (the five-capability enum) as the record key and `z.number().int().positive()` as the value, attached as `parallelCapacityMap: parallelCapacityMapSchema.optional()` on `globalSettingsSchema`. Reusing the enum as the record key is what gives the "rejects unknown-capability keys" guarantee the schema test asserts (`{nope: 4}` → fail) — zod validates record keys against the enum. `ExtensionState` in `vscode-extension-host.ts` adds the key to its Pick union.

`SettingsView` destructures `parallelCapacityMap` from `cachedState` (not live `useExtensionState()`), passes it plus `setCachedStateField` into `OmniRouteSettings`, and includes `parallelCapacityMap: parallelCapacityMap ?? {}` in the `handleSubmit` `updateSettings` payload — the Settings View Pattern AGENTS.md requires, so edits buffer until Save with no race against the live `ContextProxy`. Persistence rides the generic `contextProxy.setValue` loop in `webviewMessageHandler`'s `updateSettings` case; `parallelCapacityMap` has no special-case branch.

The round trip's blocking-risk leg is closed: `getStateToPostToWebview()` both destructures `parallelCapacityMap` from state and returns it. Without the return leg a saved control would revert visually, which is the specific failure the checklist flags as blocking.

## Merge and floor: the invariant proof

The no-deadlock property is defended at three independent layers, and the review's main concern was confirming none can be bypassed by a user map:

```
user input ──► schema (int().positive())      ──► rejects 0/-1/1.5/unknown-key at persist/import
            └► mergeRouteCapacityMap()         ──► ignores non-positive-int override, uses STATIC value
            └► createStaticRouteCapacityProvider ──► Math.max(1, resolved), bounded-unknown default (2)
```

`mergeRouteCapacityMap` walks `ROUTE_CAPABILITIES` and takes `userMap[cap]` only when it is `Number.isInteger(override) && override > 0`, else `STATIC_ROUTE_CAPACITY[cap]`. So `undefined` and `{}` both deep-equal the static map, and a hostile `{reasoner: 0}` resolves to the static `reasoner: 2`. Even if an invalid value somehow reached the provider (it cannot, given the two upstream layers), the provider's `Math.max(1, …)` floor and `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` fallback still guarantee `available >= 1`. `createStaticRouteCapacityProvider` and `computeCapacityBounds` are byte-for-byte unchanged in this diff, so deadlock-freedom reasoning carries over directly.

The merge helper intentionally duplicates the positive-integer check that the schema already enforces. That is not dead code: `mergeRouteCapacityMap` is called with whatever `provider.getState()` returns, which could in principle include a value written before the schema existed or by a non-UI path, so the runtime guard is a legitimate belt-and-suspenders rather than a redundant check behind a validated boundary.

## Webview control behavior

The capacity grid renders outside the `isOmniRoute` guard, so it is visible fleet-wide even when the OmniRoute endpoint block is collapsed — the UI test seeds `apiProvider: openai` with OmniRoute unset and still finds all five inputs. Each input shows the persisted value or blank when unset, and `updateCapacitySlot` deletes the key on empty/blank/non-positive-integer input instead of writing a sentinel. Deleting rather than zeroing is the right choice: it keeps the persisted map partial, so an unset capability transparently falls back to its default through the same merge path, and it means the control can never persist a value the floor would have to rescue.

## Test coverage

Schema tests (`packages/types`) cover accept (`{}`, partial, full), reject (`0`, `-1`, `1.5`, unknown key), and `globalSettingsSchema` round-trip for set/empty/unset, plus `GLOBAL_SETTINGS_KEYS` membership. Merge tests (`src/core/task`) cover `undefined`/`{}` → static, single-capability override, invalid overrides (`0`, `-1`, `2.5`, `NaN`) falling back, provider floor holding through a hostile merge, and no-deadlock bounds under a tiny (`reasoner: 1`) and hostile (`reasoner: 0`) user map. UI tests (`webview-ui`) cover always-visible rendering, seeding from a persisted map with unset-blank, writing a valid integer to `cachedState`, and key-deletion on both clear and invalid entry. Both set and unset cases appear at every layer.

Not tested: there is no end-to-end extension-host assertion that a map saved through the real webview survives a reload and reaches the scheduler, but that boundary is covered compositionally (schema round-trip + `getStateToPostToWebview` return + `runParallelTasks` read), and the checklist directs this coverage to the lowest layer, so an e2e test is not warranted.

## Guardrails

No `.changeset` or `CHANGELOG` edits. `src/api/providers/utils/timeout-config.ts` is untouched. `taskLifecycle.ts` and the lifecycle model (#1469/#1021 witnesses) are untouched. Per the recorded verification, `eslint --prune-suppressions --max-warnings=0` ran clean on every edited file with no suppression-count increase, and no `as any` or floating promises were introduced; the webview props use `unknown`-based casts in test seams only. The feature commit (`f69d3037c`) is self-contained — no unrelated changes bundled in.

</details>

<details>
<summary>File map</summary>

- `packages/types/src/global-settings.ts` — `parallelCapacityMapSchema` + optional field on `globalSettingsSchema`.
- `packages/types/src/vscode-extension-host.ts` — key added to `ExtensionState` Pick union.
- `src/core/task/routeCapacityMap.ts` — `mergeRouteCapacityMap()` added; provider/floor/bounds unchanged.
- `src/core/task/runParallelTasks.ts` — reads setting from `provider.getState()`, feeds merged map to provider.
- `src/core/webview/ClineProvider.ts` — `getState()` default (`undefined`) + `getStateToPostToWebview()` destructure and return.
- `webview-ui/src/components/settings/SettingsView.tsx` — cache binding + `handleSubmit` payload + prop wiring.
- `webview-ui/src/components/settings/OmniRouteSettings.tsx` — per-capability numeric grid bound to `cachedState`.
- `webview-ui/src/i18n/locales/en/settings.json` — `omniroute.parallelCapacity.*` strings.
- `packages/types/src/__tests__/global-settings.test.ts` — schema accept/reject + round-trip.
- `src/core/task/__tests__/routeCapacityMap.spec.ts` — merge/floor + no-deadlock.
- `webview-ui/src/components/settings/__tests__/OmniRouteSettings.spec.tsx` — UI binding/save.

Full diff: `git show f69d3037c` (feature commit on `main`, ahead of `origin/main`).

</details>
