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

---

## Post-approval re-verification run

Re-run of the full verification suite after `review.json` recorded **APPROVED**
(verdict `APPROVED`, 0 findings). Implementation commit `e6dc45210`
(`feat(parallel): capacity-aware scheduling and backend spread`). All commands run
from repo root `/Users/celes/sources/celesrenata/menagerie` on macOS (Node v24.21.0,
pnpm 10.8.1 — the "Unsupported engine" warning is pre-existing and does not affect
results). No feature changes were made in this step; nothing was broken, so no fix
was needed.

### (1) `pnpm --dir src check-types`
```
> zoo-code@3.84.4 check-types
> tsc --noEmit
```
**Exit code 0** (no type errors).

### (2) Focused Vitest suites (scheduler / lease / routing / capacity)

Combined focused run — the scheduler/lease/routing specs plus the no-deadlock and
N-workers-across-M-backends tests:
```
pnpm --dir src exec vitest run \
  core/task/__tests__/routeCapacityMap.spec.ts \
  core/task/__tests__/parallelWorkerRouting.spec.ts \
  core/task/__tests__/runParallelTasks.capacity.spec.ts \
  core/task/__tests__/InferenceLeasePool.spec.ts \
  core/task/__tests__/TaskScheduler.spec.ts
```
Result: **Test Files 5 passed (5), Tests 67 passed (67)**, exit 0.
(`TaskScheduler.spec.ts` exercises `BoundedElasticScheduler`; the class lives in
`src/core/task/BoundedElasticScheduler.ts`.)

Capacity spec, verbose, confirming the two required scenarios ran and passed:
```
pnpm --dir src exec vitest run core/task/__tests__/runParallelTasks.capacity.spec.ts --reporter=verbose
```
→ **Tests 9 passed (9)**, exit 0. Named cases:
- ✓ admits at most `reasoner` capacity generating at once, queueing the rest inside Menagerie
- ✓ **drains a small-capacity batch with no deadlock (maxDispatched 8, reasoner 2)**
- ✓ still throttles and drains when a capability falls through to the bounded default
- ✓ rejects queued waiters on abort while lease-holders settle on their own (PAR-021.5)
- ✓ never queues an auto-reader on the reader lease, while a non-auto worker does lease (finding #4)
- ✓ **spreads N reasoning-typed coders across M code routes by coderOrdinal**
- ✓ holds at most the summed reasoner capacity generating when spread across two backends
- ✓ seeds the scheduler bounds from capacity and leaves maxLive at 12 (finding #5)
- ✓ lets a tight user policy clamp both bounds down, and the batch still drains

Supporting suites for the schema/UI additions:
- `pnpm --dir packages/types exec vitest run src/__tests__/provider-settings.test.ts`
  → **Test Files 1 passed (1), Tests 90 passed (90)**, exit 0.
- `pnpm --dir webview-ui exec vitest run src/components/settings/__tests__/OmniRouteSettings.spec.tsx`
  → **Test Files 1 passed (1), Tests 10 passed (10)**, exit 0.

### (3) Model checks (scheduler fan-out / lifecycle)
- `pnpm lifecycle:model-check` → **exit 0**. Sub-checks:
  - "Task lifecycle model check passed: 53 reachable states, 4/4 actions reachable, 2/2 landmarks reached, depth <= 12, 3 task slots"
  - "Shared-store model check passed: 625 states, 6 scenarios, 6 invariants, 7/7 phases reachable, 3/3 landmarks reached"
  - "Provider handoff/scheduler model check passed: 104 distinct reachable states, 3/3 profile scenarios, 1/1 downstream shared-mode witness, 10/10 actions, 12/12 landmarks, depth <= 15, states <= 20000, 6/6 legacy counterexamples"
  - "Task cleanup protocol model check passed: 229464 reachable states, 17/17 actions reachable, 9/9 landmarks reached, depth <= 20, tasks=2"
  - "Native tool-call parser scope model check passed: 924/924 valid local-order interleavings, 6/6 actions reachable, 8/8 landmarks reached"
  - "Completion persistence model check passed: 88 states, 12/12 actions reachable, 5 invariants, 7/7 landmarks reached, depth <= 10, writes <= 2"
  - "Delegated mode reader check passed: regression scenario verified, 4 divergent-mode pairs checked, 5/5 built-in modes verified"
- `pnpm fanout-protocol:model-check` → **exit 0**:
  "Task fan-out protocol model check passed: 113 distinct reachable states, 6/6 actions, 5/5 landmarks, 8/8 unsafe counterexamples, depth <= 10, states <= 500"

### (4) ESLint per edited file (`--prune-suppressions --max-warnings=0`)
All exited **0**; `src/eslint-suppressions.json` was left unchanged by the prune
(`git status`/`git diff` show no modification) — no suppression-count increase. The
"@typescript-eslint/typescript-estree ... not officially supported" banner is a
pre-existing environment warning, not a lint failure.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/runParallelTasks.ts core/task/parallelWorkerRouting.ts core/task/routeCapacityMap.ts core/task/__tests__/routeCapacityMap.spec.ts core/task/__tests__/parallelWorkerRouting.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts` → exit 0.
- `pnpm --dir webview-ui exec eslint --prune-suppressions --max-warnings=0 src/components/settings/OmniRouteSettings.tsx` → exit 0.
- `pnpm --dir packages/types exec eslint --prune-suppressions --max-warnings=0 src/provider-settings/openai.ts` → exit 0.

### (5) `pnpm --dir src bundle`
```
> zoo-code@3.84.4 bundle
> node esbuild.mjs
[extension] Cleaning dist directory: .../src/dist
...
[copyLocales] Copied 126 locale files to .../src/dist/i18n/locales
[esbuild-problem-matcher#onEnd]
```
**Exit code 0** (esbuild bundle + asset/WASM/locale copy completed).

### Re-verification summary
| Check | Result |
|-------|--------|
| `pnpm --dir src check-types` | exit 0 |
| Focused scheduler/lease/routing Vitest (5 files) | 67/67 passed |
| Capacity spec (incl. no-deadlock + N×M spread) | 9/9 passed |
| types provider-settings round-trip | 90/90 passed |
| webview OmniRouteSettings editor binding | 10/10 passed |
| `pnpm lifecycle:model-check` | exit 0 |
| `pnpm fanout-protocol:model-check` | exit 0 |
| ESLint per edited file (prune-suppressions) | exit 0, no suppression increase |
| `pnpm --dir src bundle` | exit 0 |

All green. No build/lint/test breakage found; no fixes were required in this step.

### Design decisions recap (as implemented and verified)
- **Capacity source**: configured static per-capability slot map in
  `src/core/task/routeCapacityMap.ts` (`STATIC_ROUTE_CAPACITY`: reader 4, reasoner 2,
  long-context 4, general 1, vision 2), read at batch start through the existing
  `RouteCapacityProvider` seam. `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` is the bounded
  fail-safe (never 0, never the old 12); every returned slot is floored at 1 for
  forward progress; Zod `z.number().int().positive()` validates the map at module load.
- **acquireLease wiring + deadlock-freedom**: in `runParallelTasks.ts`, each worker's
  `scheduler.dispatch(name, async (handle) => …)` run body acquires exactly one lease
  (`handle.acquireLease(capabilityByName.get(spec.name)!, signal)`) after
  `signal.throwIfAborted()` and releases it in an **outer `finally`** nested around the
  child-dispose finally; auto-readers are exempt (no-op release). Deadlock-freedom:
  the dispatch permit is always acquired first and the inference lease strictly inside
  it — a uniform permit≺lease global order with no reverse edge, so the wait-for graph
  is acyclic. Reinforced by idempotent `finally` release (leases strictly drain) and
  the capacity floor keeping `liveCapacity() >= 1` so `pump()` always admits a waiter
  when a lease frees. The leased capability derives from the same lane that drives the
  route id, so lease pool and dispatched backend agree by construction.
- **Routing-spread mechanism**: additive helpers in `parallelWorkerRouting.ts`.
  `collectCodeCapableRouteIds` builds an ordered, de-duplicated code-route list (the
  reasoner route id plus custom routes explicitly classified `reasoner`/`general`,
  `[parentModelId]` fallback). `resolveLaneRouteId` round-robins `coder.primary`
  workers across that list by a per-batch **coder-only ordinal** (`coderOrdinal % n`)
  whenever `n > 1`, regardless of task type; otherwise returns the single reasoner id
  unchanged (no regression). Backed by a new optional `capability` classifier on
  `openAiOmniRouteCustomRoutes` (optional ⇒ existing profiles round-trip).
- **Bounds-seeding formula** (`computeCapacityBounds`, pure):
  `capacitySum = Σ_cap available`; `maxPerCapability = max_cap available`;
  `maxInferenceLeases = max(1, capacitySum)` (observability aggregate, never 0);
  `maxDispatched = max(capacitySum, maxPerCapability, SMALL_FLOOR=4)`;
  `maxLive = 12` (unchanged). The scheduler's `clampCeiling` still lowers both by the
  `UserParallelismPolicy` and never raises. The `maxPerCapability` term enforces the
  per-capability liveness invariant `maxDispatched >= max_cap liveCapacity(cap)`.
