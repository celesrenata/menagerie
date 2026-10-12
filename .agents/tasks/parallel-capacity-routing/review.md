# Capacity-aware parallel scheduling and backend spread

Menagerie's parallel fan-out had two root causes: the inference-capacity layer was dead code (`InferenceLeasePool` existed but `runParallelTasks` never called `handle.acquireLease`, and the capacity feed was an always-12 stub), and all non-reader workers collapsed onto a single reasoner route. This change makes capacity real via a static per-capability slot map read through the existing `RouteCapacityProvider` seam, wires a per-worker inference lease into the dispatch run body, seeds scheduler bounds from that capacity, and spreads `coder.primary` workers across configured code-capable routes by a coder-only round-robin. The change is additive — `assignLanes`/`laneToRouteCapability` stay pure, `InferenceLeasePool`/`BoundedElasticScheduler` mechanics are consumed unchanged, and the common small-batch/single-model case behaves as before. Both root causes are genuinely fixed and the deadlock-freedom argument holds against the real pool and dispatch code.

Watch for: nothing blocking. The one behavioral nuance worth noting (confirmed) is that the per-worker lease is held for the worker's whole lifetime, not per-generation — a deliberate, documented over-approximation that is safe (never under-counts pressure) and matches the brief's directive to wire into the dispatch run body.

**Verdict**: APPROVED

## High-level view

Capacity became real through `createStaticRouteCapacityProvider` in the new `routeCapacityMap.ts`. It returns per-capability slots floored at 1, substitutes `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` for an absent/invalid capability, and reports zero sustained pressure. The floor-of-1 is the central safety property: it makes a 0-capacity deadlock in `InferenceLeasePool.pump()` unreachable, and the bounded default (2, far below the old 12) prevents regression to over-dispatch. The always-12 `GENEROUS_BATCH_ROUTES` stub is deleted.

The lease is wired exactly once per worker at the top of the `scheduler.dispatch(name, async (handle) => …)` run body, strictly inside the already-held dispatch permit, and released in an outer `finally` that runs after the child-dispose finally. Acquisition order is uniformly permit≺lease with no reverse edge, so the wait-for graph is acyclic — deadlock-free independent of pool sizes. Auto-reader workers are exempt (no-op release), preserving their immediate-dispatch behavior under their own 90s deadline.

Bounds are seeded by the pure `computeCapacityBounds`: `maxInferenceLeases = max(1, capacitySum)` and `maxDispatched = max(capacitySum, maxPerCapability, SMALL_FLOOR)`, with the scheduler's `clampCeiling` still lowering (never raising) both by the user policy. The `maxPerCapability` term enforces the correct per-capability liveness invariant.

Routing spread is a pure addition in `parallelWorkerRouting.ts`: `collectCodeCapableRouteIds` builds the ordered code-route list (reasoner id plus custom routes explicitly classified `reasoner`/`general`), and `resolveLaneRouteId` round-robins `coder.primary` workers across them keyed on a coder-only ordinal, falling back to the single reasoner id when only one is configured. A new optional `capability` classifier on `openAiOmniRouteCustomRoutes` makes code-capability first-class rather than a name heuristic; it is optional so existing profiles round-trip, and it is surfaced in the OmniRoute settings editor. Code work can never reach a reader-only alias because only reasoner/general routes enter the spread set and only reader-mode specs get a reader lane.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking actionable issues. The implementation is faithful to the approved design.

</details>

<details>
<summary>Details</summary>

### Capacity source and the forward-progress floor

`createStaticRouteCapacityProvider` resolves each capability to `max(1, map[cap] ?? DEFAULT_UNKNOWN_CAPABILITY_SLOTS)` and the fall-through warn is deduplicated by a module-level `Set<RouteCapability>`, so a per-batch provider construction cannot spam. The floor-of-1 matters because `InferenceLeasePool.pump()` admits a waiter only while `held < liveCapacity()`; a `liveCapacity()` of 0 would queue every acquirer forever. Reading the real pool (unchanged by this diff) confirms the floor closes that path — the provider's floor plus `liveCapacity()`'s own negative-clamp make a 0 read unreachable. The default of 2 is above the floor and far below the old stub's 12, so an unknown capability is throttled, not flooded. Zod `z.number().int().positive()` validation runs at module load against the static map, so a mis-edit fails the suite rather than wedging a pool at runtime.

### Lease wiring and deadlock-freedom

The dispatch run body binds `handle`, and after `signal.throwIfAborted()` acquires `releaseLease = isAutoReader ? () => {} : await handle.acquireLease(capabilityByName.get(spec.name)!, signal)`, with `releaseLease()` in an outer `finally`. `BoundedElasticScheduler.dispatch` acquires the dispatch-semaphore permit and only then invokes `run(handle)`, so the permit is always held before the lease is requested — the permit≺lease order is uniform with no path that takes a permit while holding a lease. That single global lock-ordering makes the wait-for graph acyclic, which alone rules out the hold-and-wait cycle (dispatch-permit holder blocked on an ungrantable lease). Two independent reinforcements hold: `acquireLease`'s release is idempotent (`makeHandle`/`InferenceLeasePool.makeRelease`), wired into `finally`, so held leases strictly drain as workers settle on success/failure/abort; and the capacity floor keeps `liveCapacity() >= 1`, so `pump()` admits a queued waiter whenever a lease frees. The outer `finally` nests correctly around the existing inner child-dispose `finally`, so the lease is held for the worker's whole active lifetime and freed on settle. The capability a worker leases against is derived from the same lane that drives its route id (`laneToRouteCapability(lane, defaultLaneTaskType(spec.mode))`), so lease pool and dispatched backend class agree by construction.

The abort path is safe against the "never abandon siblings" invariant: `cancelQueued()` calls `pool.cancelWaiters()` which rejects only queued waiters and never touches a held lease (PAR-021.5). A worker waiting for a lease is returned to `runnable` by `makeHandle`'s catch, then recorded `cancelled`; a holder keeps its lease until its own `finally`.

### Bounds seeded from real capacity

`computeCapacityBounds` returns `maxInferenceLeases = max(1, capacitySum)` and `maxDispatched = max(capacitySum, maxPerCapability, SMALL_FLOOR)`, consumed by `new BoundedElasticScheduler(computeCapacityBounds(routeCapacity), policy, routeCapacity)`. The old `maxInferenceLeases: DEFAULT_SCHEDULER_BOUNDS.maxDispatched` seed (a local number) is gone, so throttling now happens inside Menagerie's per-capability pools rather than in OmniRoute's queue. The scheduler constructor still applies `clampCeiling` to both bounds, so a tight user policy lowers them and capacity never raises a bound above policy — the bounds-seeding + clamp test asserts both the seeded values (maxInferenceLeases 7, maxLive 12) and that a `{maxLive:3, maxDispatched:2}` policy clamps down and the batch still drains. The `maxPerCapability` term is the correct per-capability liveness invariant (enough permits to fill the largest single pool); `maxInferenceLeases` is an observability aggregate that may exceed distinct physical slots when capabilities share a backend, which has no effect on the per-capability gate.

### Routing spread, additive and reader-safe

`collectCodeCapableRouteIds` includes the reasoner id plus only those custom routes whose explicit `capability` is `reasoner`/`general`, de-duplicated in config order, falling back to `[parentModelId]` when empty. `resolveLaneRouteId` honors an explicit `route` first, resolves reader lanes to the reader route id, round-robins `coder.primary` across the code-route list by `coderOrdinal % n` when `n > 1` (regardless of task type, so the default reasoning-typed coder population spreads), and otherwise returns the single reasoner id unchanged. The round-robin key is a coder-only ordinal computed in a single O(N) pass over the lane assignments, so interleaved readers/researchers never perturb the distribution. `assignLanes`/`laneToRouteCapability`/`roleDefault`/`resolveWorkerModelId` are untouched — `capabilityLanes.ts` is not in the diff — so the capability-lanes-routing purity contract is preserved. Code work cannot reach a reader-only alias: only reasoner/general routes enter the spread set, and only reader-mode specs get a reader lane. The remaining non-additive-looking hunks in `parallelWorkerRouting.ts` are cosmetic line-wrapping of unrelated helper signatures, not behavioral changes.

The new `routeCapabilitySchema` enum matches the `ROUTE_CAPABILITIES` tuple in `elasticTypes.ts` exactly (`reader, reasoner, long-context, vision, general`), with a lockstep doc comment. The `capability` field is optional, so existing persisted `openAiOmniRouteCustomRoutes` round-trip unchanged, and it rides the already-persisted custom-routes array into the editor without a new top-level state key.

### Test coverage

`runParallelTasks.capacity.spec.ts` drives the real scheduler + lease pool through the exact permit→lease→finally wiring and covers the two required cases plus the rest of the design's test matrix: at-most-capacity generating with the excess throttled inside Menagerie; a no-deadlock drain at maxDispatched 8 / reasoner 2; fail-safe default throttling; abort-while-waiting with holders settling independently; the auto-reader exemption (3 auto-readers vs reader capacity 2, none parked in `waiting-for-inference`, while a non-auto coder leases); the N-coders-across-M-backends spread with lease throttling agreeing; and bounds seeding with a policy clamp. The provider-settings round-trip test and the `OmniRouteSettings` editor-binding test cover the schema field and its UI wiring.

Not tested at this layer (by design, and correctly so): no `apps/vscode-e2e` coverage, since nothing here depends on the real extension host — the behavior is fully provable with a fake capacity provider and the real scheduler.

### Scope adherence

`src/api/providers/utils/timeout-config.ts` (the stream-idle timeout fixed in 92f8035a5) is untouched; `taskLifecycle.ts` and the #1469/#1021 witnesses are untouched; no `.changeset` or `CHANGELOG.md` edit is present. The verification file records both model checks passing, check-types/bundle exit 0, focused Vitest suites passing, and per-file ESLint with no suppression increase — consistent with the additive, consume-don't-redefine shape of the diff.

</details>

<details>
<summary>File map</summary>

- `src/core/task/routeCapacityMap.ts` (new) — static per-capability slot map, floor-of-1 provider, bounded fail-safe, Zod validation, once-per-process warn, `computeCapacityBounds`.
- `src/core/task/runParallelTasks.ts` — deletes the always-12 stub; seeds the scheduler from real capacity; acquires/releases the per-worker lease (auto-reader exempt); lane-driven route-id spread with a coder-only ordinal.
- `src/core/task/parallelWorkerRouting.ts` (additive) — `collectCodeCapableRouteIds`, `resolveLaneRouteId`; lane helpers untouched.
- `packages/types/src/provider-settings/openai.ts` — optional `capability` classifier on custom routes + `routeCapabilitySchema`.
- `webview-ui/src/components/settings/OmniRouteSettings.tsx` + `settings.json` — capability control in the custom-routes editor.
- Test files: `routeCapacityMap.spec.ts`, `parallelWorkerRouting.spec.ts`, `runParallelTasks.capacity.spec.ts`, `provider-settings.test.ts`, `OmniRouteSettings.spec.tsx`.

Full diff: `git show e6dc45210`.

</details>
