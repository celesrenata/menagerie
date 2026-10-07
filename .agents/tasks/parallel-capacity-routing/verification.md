# Verification — Capacity-Aware Parallel Scheduling and Backend Spread

Implements the approved design (`design.md`) and plan (`plan.md`). First iteration
(no `review.json` present). All commands below were run from the repo root
`/Users/celes/sources/celesrenata/menagerie` on macOS (Node v24, pnpm 10.8.1 — the
engine warning is pre-existing and does not affect results).

## Design choices as implemented

### Capacity source (design §A)
Configured **static capacity map** keyed by `RouteCapability`, read at batch start,
with a bounded fail-safe. New module `src/core/task/routeCapacityMap.ts`:

- `STATIC_ROUTE_CAPACITY: Readonly<Record<RouteCapability, number>>` = reader 4,
  reasoner 2, long-context 4, general 1, vision 2 (operator-tunable; source-of-truth
  doc comment names OmniRoute `PROVIDER_POLICIES`, mirroring `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`).
- `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` — bounded fail-safe for an absent/invalid
  capability: never 0 (no deadlock), never 12 (no over-dispatch).
- `createStaticRouteCapacityProvider()` floors every returned `available`/`capacity`
  at 1 (forward-progress guarantee) and reports `sustainedPressure() === 0`.
- Zod `z.number().int().positive()` validation at module load (`validateRouteCapacityMap`),
  plus a runtime floor as defense in depth. A once-per-process `console.warn`
  (module-level dedupe set) fires the first time a capability falls through to the
  default, so a persistently unmapped capability never spams across per-batch
  provider construction (finding #7).

### acquireLease wiring + deadlock-freedom (design §B)
In `src/core/task/runParallelTasks.ts`, the `scheduler.dispatch(spec.name, async (handle) => {...})`
run body now binds `handle`, and at the very top (after `signal.throwIfAborted()`)
acquires one per-worker lease for the worker's whole active lifetime:

```
const isAutoReader = spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
const releaseLease = isAutoReader ? () => {} : await handle.acquireLease(capabilityByName.get(spec.name)!, signal)
try { ...existing run body (workspace, runtime, broker, waitForParallelTask, child dispose finally)... }
finally { releaseLease() }   // OUTER finally, runs after the inner child-dispose finally
```

- The capability is `laneToRouteCapability(lane, defaultLaneTaskType(spec.mode))`,
  derived from the SAME lane that drives routing — so a worker's lease pool and its
  dispatched backend class agree by construction.
- **Auto-reader exemption** (finding #4): auto-reader workers (`project-reader` +
  `AUTO_READER_NAME` prefix) skip the acquire and use a no-op release, preserving
  today's immediate-dispatch behavior (read-only, 90s-bounded, 9B lane, not the 27B
  bottleneck).

**Deadlock-freedom argument.** A worker acquires the dispatch permit first (inside
`scheduler.dispatch`), then the inference lease strictly inside that permit — the
global order is permit≺lease with no reverse edge anywhere, so the wait-for graph is
acyclic (sufficient alone). Independently: every lease is released in a `finally`
(idempotent `makeHandle`/`InferenceLeasePool.makeRelease`) and a worker holds exactly
one lease for its lifetime, so held leases strictly drain as workers settle; and the
capacity provider guarantees `liveCapacity() >= 1` per capability, so `pump()` always
admits a queued waiter when a lease frees. Over-capacity workers for a hot capability
queue in `waiting-for-inference` INSIDE Menagerie instead of spilling to OmniRoute.

### Routing spread (design §C)
`src/core/task/parallelWorkerRouting.ts` (additive — `assignLanes`/`assignLane`/
`laneToRouteCapability`/`roleDefault`/`resolveWorkerModelId` untouched):

- `collectCodeCapableRouteIds(profile, parentModelId)` — ordered, de-duplicated list:
  `openAiOmniRouteReasonerRouteId` (when set) plus each `openAiOmniRouteCustomRoutes`
  entry whose explicit `capability` is `"reasoner"` or `"general"`; readers/long-context/
  vision/unclassified excluded; `[parentModelId]` fallback when empty.
- `resolveLaneRouteId({ lane, taskType, profile, route, parentModelId, coderOrdinal, codeCapableRouteIds })`
  — explicit `route` wins; `reader.*` → reader route id; `coder.primary` → round-robin
  `codeCapableRouteIds[coderOrdinal % n]` when `n > 1` **regardless of task type**
  (finding #1), else the single reasoner id unchanged (no regression); `reasoning.escalation`
  → reasoner route id.

The **routing-spread mechanism**: `runParallelTasks` computes `assignLanes(specs)` once,
derives a per-batch **coder-only ordinal** (0-based index among `coder.primary`
assignments in spec order, finding #3), builds `codeCapableRouteIds` once from the
parent profile, and sets each worker's `openAiModelId` via `resolveLaneRouteId(...)`.
Spread is opt-in: it engages only when >1 code-capable route is configured. All spread
coders still lease against the single `reasoner` pool, so the map's `reasoner` value is
the summed code-backend slots when spread is active (documented in `routeCapacityMap.ts`).

Code-route source (finding #2): a new OPTIONAL `capability` classifier on
`openAiOmniRouteCustomRoutes` in `packages/types/src/provider-settings/openai.ts`
(`routeCapabilitySchema = z.enum([...])`, kept in lockstep with the `RouteCapability`
union). Optional ⇒ existing persisted profiles round-trip unchanged. Surfaced in the
custom-routes editor (`webview-ui/.../OmniRouteSettings.tsx`) through the existing
`cachedState`/`updateSettings` array (no new top-level `ExtensionState`/`getState` key),
read only on the extension side by `collectCodeCapableRouteIds`.

### Bounds-seeding formula (design §D)
`computeCapacityBounds(provider)` (pure, in `routeCapacityMap.ts`):

```
capacitySum       = Σ_cap provider.capacitiesFor(cap)[*].available
maxPerCapability  = max_cap provider.capacitiesFor(cap)[*].available
maxInferenceLeases= max(1, capacitySum)                              // observability aggregate, never 0
maxDispatched     = max(capacitySum, maxPerCapability, SMALL_FLOOR=4) // before policy clamp
maxLive           = DEFAULT_SCHEDULER_BOUNDS.maxLive (12, unchanged)
scheduler         = new BoundedElasticScheduler(computeCapacityBounds(provider), policy, provider)
```

The scheduler's own `clampCeiling` lowers `maxLive`/`maxDispatched` by the
`UserParallelismPolicy` (never raises). The `maxPerCapability` term enforces the correct
per-capability liveness invariant `maxDispatched >= max_cap liveCapacity(cap)` (finding #5).
`maxInferenceLeases` is an observability aggregate that may exceed distinct physical slots
when capabilities share a backend (finding #6); the per-capability pool is the sole gate.

## Commands run and results

### (1) `pnpm --dir src check-types`
Exit code **0** (`tsc --noEmit`, no errors).

### (2) Focused Vitest suites (scheduler / lease / routing / capacity)
- `pnpm --dir src exec vitest run core/task/__tests__/routeCapacityMap.spec.ts` →
  **1 file, 15 tests passed**.
- `pnpm --dir src exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts` →
  **1 file, 28 tests passed**.
- `pnpm --dir src exec vitest run core/task/__tests__/runParallelTasks.capacity.spec.ts` →
  **1 file, 9 tests passed** (throttle under capacity=small; no-deadlock smoke;
  fail-safe default; abort-while-waiting; auto-reader exemption; spread of N coders
  across M backends; bounds seeding + user-policy clamp).
- `pnpm --dir src exec vitest run core/task/__tests__/InferenceLeasePool.spec.ts core/task/__tests__/TaskScheduler.spec.ts routeCapacityMap parallelWorkerRouting runParallelTasks.capacity`
  (combined run) → **5 files, 67 tests passed** (no sibling regression).
- Full directory `pnpm --dir src exec vitest run core/task` → **63 files, 813 tests passed**.
- `pnpm --dir packages/types exec vitest run` → **30 files, 444 tests passed**
  (includes the new custom-route `capability` round-trip/back-compat/reject tests).
- `pnpm --dir webview-ui exec vitest run src/components/settings` → **52 files, 606 tests passed**
  (includes the new `OmniRouteSettings` capability editor binding tests: add with/without
  capability, per-row update, clear-to-unclassified, back-compat render).

### (3) Model checks (scheduler fan-out / lifecycle affected)
- `pnpm lifecycle:model-check` → exit **0**. Sub-checks all passed, e.g.
  "Task lifecycle model check passed: 53 reachable states, 4/4 actions, 2/2 landmarks";
  "Provider handoff/scheduler model check passed: 104 distinct reachable states ...
  6/6 legacy counterexamples"; "Task cleanup protocol model check passed: 229464
  reachable states ..."; "Completion persistence model check passed"; "Delegated mode
  reader check passed".
- `pnpm fanout-protocol:model-check` → exit **0**:
  "Task fan-out protocol model check passed: 113 distinct reachable states, 6/6 actions,
  5/5 landmarks, 8/8 unsafe counterexamples, depth <= 10, states <= 500".

### (4) ESLint per edited file (`--prune-suppressions --max-warnings=0`)
All exited **0** with no new suppressions:
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/runParallelTasks.ts core/task/parallelWorkerRouting.ts core/task/routeCapacityMap.ts core/task/__tests__/routeCapacityMap.spec.ts core/task/__tests__/parallelWorkerRouting.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts`
- `pnpm --dir webview-ui exec eslint --prune-suppressions --max-warnings=0 src/components/settings/OmniRouteSettings.tsx src/components/settings/__tests__/OmniRouteSettings.spec.tsx`
- `pnpm --dir packages/types exec eslint --prune-suppressions --max-warnings=0 src/provider-settings/openai.ts src/__tests__/provider-settings.test.ts`
- `pnpm --dir packages/types exec tsc --noEmit` → exit **0**.

### (5) `pnpm --dir src bundle`
Exit code **0** (esbuild bundle + asset/locale copy completed).

## Scope adherence
- `src/api/providers/utils/timeout-config.ts` — untouched (stream-idle timeout fix in
  commit 92f8035a5 left alone).
- Task-lifecycle reducers and the #1469/#1021 witnesses — untouched; both model checks pass.
- `InferenceLeasePool` and `shouldAdmitNewFanOut` — consumed, not changed; now exercised.
- `assignLanes`/`assignLane`/`laneToRouteCapability` — unchanged (pure/additive preserved).
- No `.changeset` or `CHANGELOG.md` edits.
- No new runtime dependencies.
