# Design — Capacity-Aware Parallel Scheduling and Backend Spread

## Overview

Menagerie's parallel fan-out currently over-dispatches to a single saturated backend and starves the others. The read-only investigation (`.agents/tasks/parallel-execution-bottlenecks/findings.md`) confirmed two independent root causes that this design fixes (the already-shipped stream-idle timeout change, commit `92f8035a5`, is explicitly out of scope and untouched):

- **Root cause A — the inference-capacity layer is dead code.** `BoundedElasticScheduler` ships a complete, correct `InferenceLeasePool` plus a `DispatchHandle.acquireLease(capability, signal)` API, but `runParallelTasks.ts` never calls `handle.acquireLease(...)`. The only live gate is the dispatch semaphore sized at `maxDispatched` (8). The capacity feed wired in (`GENEROUS_BATCH_ROUTES`) is a stub reporting `available = 12` for every capability and `sustainedPressure() = 0` always, and `maxInferenceLeases` is seeded from `maxDispatched` (a local number). So Menagerie dispatches up to 8 concurrent workers at a backend with ~2 real slots; the excess spills into OmniRoute's rate-limit queue.
- **Root cause B — all non-reader workers route to one backend.** `resolveWorkerModelId()` is a pass-through; `roleDefault()` returns the single `openAiOmniRouteReasonerRouteId` for every non-reader worker (code, tester, research). N code workers all get the same reasoner route id and land on the single vLLM backend (`maxConcurrent 2`, effectively ~1), serializing while ollama-local's 4 slots idle.

The fix makes capacity real inside Menagerie and spreads same-category work across capable backends, without contradicting any accepted spec and without regressing the common small-batch case. It is additive: every safety behavior `runParallelTasks` relies on today (batch persistence layout, Git-worktree isolation, result ownership, "a cancelled/failed worker never abandons siblings holding permits") is preserved. The capability-lane layer stays pure and additive exactly as `capability-lanes-routing` requires; the `RouteCapability` enum, `InferenceLeasePool`, and dispatch/lease mechanics owned by `elastic-parallel-execution` are consumed, never redefined.

## Technology stack (locked once approved)

- TypeScript, in-tree with the existing extension host code. No new runtime dependencies.
- Existing scheduler primitives: `BoundedElasticScheduler`, `InferenceLeasePool`, `TaskSemaphore`, `DispatchHandle`, `RouteCapacityProvider`, `RouteCapacity`, `RouteCapability` (from `src/core/task/elasticTypes.ts` and siblings).
- Existing routing primitives: `resolveWorkerModelId`, `roleDefault`, `assignLanes`, `laneToRouteCapability`, `CapabilityLane`, `LaneTaskType` (from `src/core/task/parallelWorkerRouting.ts`, `src/core/task/capabilityLanes.ts`).
- Zod for the capacity-map validation (already a project dependency, used throughout `packages/types`).
- Vitest in the `src` package for unit/integration tests.

## Design decisions

### A. Capacity source — configured static capacity map, with a fail-safe default (chosen)

**Decision: a configured static capacity map (option ii), keyed by `RouteCapability`, read at batch start, with a bounded fail-safe when a capability is absent.** No live OmniRoute capacity/pressure query is introduced in this pass.

Rationale. `findings.md` establishes that no live capacity feed exists and that OmniRoute's capacity-query surface lives in the remote `omniroute-mode.py`, which was not inspected — its endpoint and payload shape are unknown. Inventing an endpoint would be speculative and could fail silently. The codebase already sets the precedent for a maintained static map that mirrors the serving config: `OMNIROUTE_ROUTE_CONTEXT_WINDOWS` in `src/api/providers/omniroute.ts` is a hand-maintained `Record<routeId, number>` whose doc comment names its source of truth as the self-hosted serving config and instructs maintainers to keep it in lockstep. A per-capability slot-count map follows the exact same pattern and the exact same source of truth (the OmniRoute `PROVIDER_POLICIES` the brief describes: vllm ~2, ollama-local 4, llama-cpp 1). This is the pragmatic first step the brief anticipates, and it removes the remote dependency entirely.

Tradeoffs. A static map does not track live load (a backend that is momentarily busy with non-Menagerie traffic still reports its full slot count), and it must be updated by hand when the cluster changes. That is acceptable because (1) it is strictly better than today's always-12 stub, (2) OmniRoute still owns real inference admission and will queue anything Menagerie over-commits, and (3) the map is a single, documented constant with a clear source-of-truth comment, exactly like the context-window map that already lives beside it.

**Hybrid is deliberately deferred, not rejected.** The capacity feed is injected through the existing `RouteCapacityProvider` interface. If a live OmniRoute capacity surface is later confirmed, a `LiveRouteCapacityProvider` can be dropped in behind the same interface (option iii, static defaults + live refinement) with no change to the lease-wiring or routing code. This design implements the static provider and leaves that seam open; it does not build the live path on an assumed endpoint.

**Capacity shape.** The map is keyed by `RouteCapability` (`reader | reasoner | long-context | vision | general`) — the only abstraction the scheduler and `InferenceLeasePool` consume (`PAR-013`: no GPU/VRAM/node identity). It maps each capability to the summed real slot count of the backends that serve it. From the confirmed cluster topology and the known route→backend mapping in `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`:

| `RouteCapability` | Backing route(s) today | Real slots | Notes |
|---|---|---|---|
| `reader` | `hybrid/reader`, `local/m5-reader` (9B/ollama lane) | 4 | ollama-local serves readers |
| `reasoner` | `hybrid/code` etc. (27B/vLLM) | 2 | vLLM `maxConcurrent 2`, effectively ~1 |
| `long-context` | `hybrid/planner`/`long` (GLM via ollama) | 4 | shares the ollama backend |
| `general` | mechanical/general edits | 1 | llama-cpp overflow |
| `vision` | (none configured) | fail-safe | falls to default below |

These exact numbers are **not hardcoded as magic literals in the scheduler**; they live in one documented constant (see "Capacity-map data model" below) whose source-of-truth comment names the OmniRoute `PROVIDER_POLICIES` the operator maintains, mirroring `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`. Treat the specific values above as runtime-provided and operator-tunable; the design fixes the *mechanism*, not the numbers.

Two notes on the table (finding #6, finding #1-interaction): (1) `reader` and `long-context` both back onto the ollama-local backend, so these per-capability counts are *not* literally four distinct physical slots per capability — summing them (for the `maxInferenceLeases` aggregate, decision D) overstates distinct hardware. The per-capability pool is still the operative gate; the sum is an observability figure only. (2) When the operator configures the routing spread (decision C) so code work spreads across more than one backend, the `reasoner` slot count here must equal the **sum of those spread code backends' real slots** (not just vLLM's 2), because all spread `coder.primary` workers lease against the single `reasoner` pool. The map value is therefore the total code-capable concurrency the operator intends Menagerie to admit, kept in lockstep with how many code backends they spread across.

**Fail-safe (required).** When a capability is absent from the map (or reads as a non-positive number), the provider returns a single bounded default capacity — `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` — never `0` and never `maxLive` (12). This is the central safety property:

- It must **not** regress to today's over-dispatch: the default (2) is far below the old stub's 12, so an unknown capability is throttled, not flooded.
- It must **not** deadlock on a `0` read: `InferenceLeasePool.liveCapacity()` clamps negatives to `0`, and if `liveCapacity()` were ever `0` the pool would queue every acquirer forever (the `pump()` loop condition `held < liveCapacity()` can never fire). The provider therefore guarantees a floor of `1` on every returned `available`/`capacity` so a lease can always eventually be granted. `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` sits above that floor.

### B. Wiring `acquireLease` — once per worker, around the whole run body

**Decision: call `handle.acquireLease(capability, signal)` exactly once at the top of the `scheduler.dispatch(spec.name, async (handle) => { ... })` run body in `runParallelTasks.ts`, immediately before the worker begins its agent loop, and release it in a `finally` that runs after `waitForParallelTask(...)` resolves/rejects.** The capability is derived per worker from the same lane layer that drives routing (decision C), so the lease a worker holds is the lease for the backend class it will actually hit.

Why once-per-worker and not once-per-generation. The ideal design in `elastic-parallel-execution` acquires a lease per *generation* (held only while `generating`, released on tool/I-O). But that acquire/release point lives deep inside the child `Task` agent loop (`Task.ts`), which `runParallelTasks` does not drive and cannot reach without threading the `DispatchHandle` through the entire child runtime — a far larger, riskier change than this fix warrants, and one the findings did not scope. The brief directs the wiring into the `scheduler.dispatch(...)` run body, which is per-worker. A per-worker lease is a conservative over-approximation: it treats a worker as holding an inference slot for its whole lifetime rather than only while generating. That is *safe* (it never under-counts real inference pressure) and it is exactly the throttle we need to stop over-dispatch; it is only *less efficient* than per-generation leasing for tool-heavy workers, which is an acceptable, non-regressing tradeoff versus today (today there is no lease at all).

Exact placement. In `runParallelTasks`, the current run body is `await scheduler.dispatch(spec.name, async () => { ... })`. The change:

1. Bind the handle: `async (handle) => { ... }` (today the `DispatchHandle` argument is unbound).
2. At the very top of the body, after `signal.throwIfAborted()` and after the per-worker capability is resolved, acquire: `const releaseLease = await handle.acquireLease(capability, signal)`.
3. Wrap the existing body (`createParallelWorkspace`, `createParallelTaskRuntime`, `setUpWorkerBroker`, `waitForParallelTask`, worker-N.json writes, the existing child-dispose `finally`) so that `releaseLease()` is called in an **outer** `finally` that runs after the existing inner `finally` (child dispose). `acquireLease`'s returned release fn is idempotent (see `makeHandle`), so a double release is a no-op.

Composition with `waitForParallelTask`. The lease is held across `waitForParallelTask(child, runtime.provider, workerSignal)` — i.e. for the worker's whole active lifetime — and released only when that settles (success, failure, or abort). This is the intended semantics for the per-worker approximation: the worker occupies one inference slot of its capability class for as long as it is alive.

**Auto-reader lease exemption (fixes finding #4).** `runParallelTasks` gives auto-reader workers (`spec.mode === "project-reader"` *and* `spec.name.startsWith(AUTO_READER_NAME)`) a hard `AbortSignal.timeout(90_000)` wall-clock deadline (verified in `runParallelTasks.ts`). Under a per-worker lifetime lease with `reader` capacity 4, a reader-swarm wider than 4 would queue the 5th+ auto-reader in the `reader` lease pool while its fixed 90s deadline is already counting down — so an auto-reader could time out purely from lease-queue wait, a behavior change versus today (no lease, all readers dispatch immediately). **Resolution: auto-reader workers are exempt from `acquireLease`.** They are read-only, individually bounded by their own 90s timeout, and do not meaningfully pressure the 27B inference bottleneck that root cause A is about (they hit the 9B reader lane, and their bounded output is already capped by `READER_OUTPUT_BOUNDS`). Concretely, the dispatch body acquires a lease only when the worker is **not** an auto-reader; for auto-readers it skips the acquire and `releaseLease` is a no-op (`() => {}`). This preserves today's immediate-dispatch behavior for the auto-reader swarm while still leasing every non-exempt worker (all code/tester/research workers and any explicit non-auto reader-mode worker). The exemption is narrow and explicit (the exact `AUTO_READER_NAME` + `project-reader` predicate already present at the `workerSignal` site), so it cannot accidentally exempt a code worker. Deadlock-freedom is unaffected: an exempt worker holds no lease, so it adds no edge to the permit≺lease wait graph; it only ever holds a dispatch permit, which it releases on settle as today.

Capability derivation per worker. The worker's `RouteCapability` is `laneToRouteCapability(lane, taskType)`, where `lane` is the lane the worker was assigned by `assignLanes(...)` (decision C) and `taskType` is `defaultLaneTaskType(spec.mode)` unless the mastermind supplied one. Reader-mode specs resolve to `reader`; non-reader specs resolve to `reasoner` (or `general` for mechanical edits). This is the *same* lane→capability resolution the routing spread uses, so the lease pool a worker waits in is the pool for the backend class it is routed to — the two decisions are consistent by construction.

Ordering of the two gates. A worker first acquires a **dispatch permit** (the `dispatchSemaphore`, sized `maxDispatched`), then — inside the run body — acquires an **inference lease** (the per-capability `InferenceLeasePool`). The permit is the coarse "may progress" gate; the lease is the fine "may occupy a real inference slot" gate. This ordering is fixed and uniform for every worker.

**Deadlock-freedom argument.** The concern is a classic hold-and-wait cycle: a worker holds a dispatch permit while waiting for a lease that can never be granted because every lease is held by other dispatch-permit holders. This cannot occur, for three independent reasons, any one of which is sufficient:

1. **No circular wait.** Leases are only ever *acquired by* dispatch-permit holders and are *released by* those same holders when the worker settles. A lease is never acquired while *waiting for a dispatch permit*, and a dispatch permit is never acquired while *holding a lease* — the acquisition order is strictly permit-then-lease for every worker, with no reverse edge anywhere. With a single global lock-ordering (permit ≺ lease) and no path that acquires a permit while holding a lease, the wait-for graph is acyclic, so no deadlock is possible regardless of the pool sizes.
2. **Leases always eventually free.** Every lease is wired into a `finally` and `acquireLease`'s release is idempotent, so a lease is released when its worker settles even on throw or abort. A worker's progress to settlement does not require acquiring *another* lease (it holds exactly one for its lifetime), so no worker can be blocked from releasing by needing a second lease. Therefore the set of held leases strictly drains as workers finish, and `InferenceLeasePool.pump()` admits the next waiter each time one frees.
3. **Capacity floor guarantees forward progress.** The capacity provider guarantees `liveCapacity() >= 1` for every capability (fail-safe floor, decision A). `InferenceLeasePool` queues over-capacity acquirers and never rejects them (`PAR-011.1`); its `pump()` admits a waiter whenever `held < liveCapacity()`. With `liveCapacity() >= 1`, as soon as any lease frees a queued waiter is admitted. Combined with (2), at least one worker is always able to make progress and release, so the batch cannot stall.

The lease-vs-dispatch-semaphore interaction is therefore safe: more workers may hold dispatch permits (up to 8) than there are leases for a given capability (e.g. 2 for `reasoner`); the excess permit-holders sit in the lease pool's queue in the `waiting-for-inference` state (surfaced as "Runnable — waiting for inference capacity"), **inside Menagerie**, instead of all being handed to OmniRoute at once. That is precisely the behavior root cause A was missing.

**Correct liveness invariant (fixes finding #5).** The pools are **per-capability**, so the invariant that actually matters for *slot utilization* (not for deadlock-freedom, which the acyclic argument already settles) is `maxDispatched >= max over capabilities of liveCapacity(cap)` — the largest *single* pool, not the capacity *sum*. If dispatch permits were fewer than a single pool's slots, that pool could never fill all its slots (a throughput gap, not a deadlock). The earlier draft stated the stronger `maxDispatched >= capacitySum` as the prerequisite, which happens to hold with the current topology but is the wrong invariant to seed against. Decision D therefore seeds `maxDispatched` to include the `maxPerCapability` term so the largest pool is always fillable. (A tighter *user policy* may clamp `maxDispatched` below a pool's slot count; those excess slots then go unused — acceptable and documented, see decision E — never a deadlock.)

Abort behavior. `acquireLease` propagates the batch/worker `signal`. On cancel, a worker *waiting* for a lease is rejected by the pool's abort path (the worker returns to `runnable`, then the catch in the dispatch body records `cancelled`); a worker *holding* a lease keeps it until its `finally` releases it — `cancelQueued()` already calls `pool.cancelWaiters()` for queued waiters and never touches held leases (`PAR-021.5`). This matches the existing "never abandon siblings mid-flight" invariant.

### C. Routing spread — connect the pure lane assignment to the resolved route id

**Decision: option (i) — connect the existing capability-lane assignment to the resolved route id — combined with (iii) honoring any mastermind-supplied explicit per-worker `route`.** Capacity-aware per-dispatch backend selection (option ii) is deferred.

Rationale. The capability-lanes-routing spec is explicit and must not be contradicted: `assignLanes`/`laneToRouteCapability` are **pure and additive**, the lane rides beside the spec on the `LaneAssignment` sidecar, "the `route` field already passes an OmniRoute route id through," and the lane layer "does not change how the scheduler dispatches or leases." The spec's intended wiring is that the mastermind's RoutingPolicy picks a lane per spec and the resolved route id rides through `spec.route`. Today that wiring is simply *absent* in `runParallelTasks` — `resolveWorkerModelId` only ever sees `roleDefault`, which collapses all non-reader lanes to one reasoner route id. The fix is to make the lane the worker was assigned select among the *capability-appropriate route ids*, so same-category workers spread across the capable backends instead of all taking `openAiOmniRouteReasonerRouteId`.

Why not option (ii) now. Capacity-aware least-loaded selection at dispatch would require the dispatch site to know per-route live load, which is exactly the live feed decision A declined to assume. It also risks duplicating placement logic that OmniRoute owns. The lane-driven spread (i) is sufficient to break the single-backend concentration and keeps Menagerie out of physical placement, consistent with "OmniRoute owns model + placement." Option (ii) remains a future refinement behind the same `RouteCapacityProvider` seam.

**Correcting the two review blockers before the mechanism.** The first design draft put the spread on the `coder.primary` *mechanical/`general`* path, but `defaultLaneTaskType(mode)` returns `"implementation"` for every non-reader mode and `laneToRouteCapability("coder.primary","implementation")` returns `"reasoner"` (verified in `capabilityLanes.ts`). So the default code worker is a *reasoning*-typed coder, and the draft routed those to a single id with no spread — leaving root cause B unfixed for the exact motivating batch. **This revision moves the spread onto the `coder.primary` reasoning path (the common case), independent of task type.** The second blocker was that the draft spread "across code-capable custom routes flagged as code," but `openAiOmniRouteCustomRoutes` is `{ name: string, modelId: string }[]` with no capability field (verified in `packages/types/src/provider-settings/openai.ts`) — there is no supported way to classify a custom route as code-capable. **This revision adds one explicit, optional schema field** rather than inventing a name heuristic (see "Code-route source" below).

Mechanism. A new pure resolver, `resolveLaneRouteId(args)`, extends the existing precedence in `resolveWorkerModelId` with a lane dimension, keeping it a pure id pass-through (no tier/GPU math, consistent with the module's existing contract). Its arguments are `{ lane, taskType, profile, route, parentModelId, coderOrdinal, codeCapableRouteIds }` (the last two carry the spread inputs; see below):

1. If `route` (the spec's explicit per-worker route, mastermind- or user-supplied) is set, use it verbatim — unchanged, honors option (iii) and the existing `rejectMastermindPhysicalPlacement` pass-through-for-`route` rule.
2. Else resolve by lane:
   - `reader.fast` / `reader.deep` → `profile.openAiOmniRouteReaderRouteId` (the 9B reader lane — readers already route correctly; this is preserved exactly, and code work is never sent to a reader-only model because only reader-*mode* specs get a reader lane).
   - `coder.primary` → **the spread** (below): round-robin across `codeCapableRouteIds` keyed by `coderOrdinal` **regardless of task type**, when more than one code-capable id is configured; otherwise `profile.openAiOmniRouteReasonerRouteId` unchanged.
   - `reasoning.escalation` → the reasoner/long-context route id by task type (scarce lane, assigned only by `produceDeeperLaneFollowUp`, unchanged).
3. Else fall back to the parent model id (single-model behavior unchanged).

**The actual spread (fixes finding #1).** Concentration happens because N `coder.primary` workers all resolve to one `openAiOmniRouteReasonerRouteId`. The spread now engages for the common reasoning-typed coder population:

- When the profile exposes **more than one code-capable route id** (`codeCapableRouteIds.length > 1`), the resolver distributes `coder.primary` workers across those ids by **deterministic round-robin keyed by `coderOrdinal`** — the 0-based index of this worker among the `coder.primary` workers *only* (not the global batch index; fixes finding #3). This spreads N code workers across the configured code-capable routes (e.g. the vLLM `hybrid/code` route and an ollama-capable overflow route) so they no longer all serialize behind vLLM's ~2 slots. Round-robin (not random) keeps it deterministic and testable. The chosen id is `codeCapableRouteIds[coderOrdinal % codeCapableRouteIds.length]`.
- When the profile exposes **only one** code-capable id (today's common config: just `openAiOmniRouteReasonerRouteId`), the resolver returns that single id — behavior is unchanged, so this fix never *reduces* throughput for an unconfigured user; it only *enables* spread for users who configure overflow routes. The spread is opt-in via existing profile configuration, matching the "fail safe, never regress the common case" requirement (decision F).

**Coder-only ordinal (fixes finding #3).** The round-robin key is NOT the global `specs.map((spec, index) => ...)` index, because interleaved readers/researchers would perturb the cycle and unbalance the code routes. Instead, `runParallelTasks` computes a per-batch `coderOrdinal` up front: after `assignLanes(specs)`, it walks the assignments in spec order and assigns a monotonically increasing ordinal (0,1,2,…) to each assignment whose `lane === "coder.primary"`, leaving non-coder assignments without one. This is a pure O(N) pass over the lane assignments producing a `Map<specName, number>` (or an aligned array). The ordinal is independent of how readers/researchers interleave, so the distribution across code routes is balanced.

**Code-route source (fixes finding #2) — explicit schema field, chosen over a name heuristic.** The resolver needs a defined, testable set of code-capable route ids. The two options the review posed:

- (a) add an explicit optional capability field to the `openAiOmniRouteCustomRoutes` object schema; or
- (b) define a name-prefix convention and parse it.

**Chosen: (a).** A name heuristic (b) is fragile (operators name routes freely, substring matching silently mis-classifies) and would bake an undocumented convention into routing. Adding an explicit field is the clean, non-heuristic path and makes the capability intent first-class. The change, in `packages/types/src/provider-settings/openai.ts`:

```
openAiOmniRouteCustomRoutes: z.array(z.object({
  name: z.string(),
  modelId: z.string(),
  capability: routeCapabilitySchema.optional(),   // NEW: optional "reader"|"reasoner"|"long-context"|"vision"|"general"
})).optional(),
```

where `routeCapabilitySchema` is a `z.enum([...])` over the existing `RouteCapability` vocabulary (added beside the schema or imported; it must stay in lockstep with the `RouteCapability` union in `elasticTypes.ts`). The field is **optional** so every existing persisted profile round-trips unchanged (a missing `capability` means "unclassified"). `codeCapableRouteIds` is then built by a small pure helper, `collectCodeCapableRouteIds(profile)`:

1. Start with `profile.openAiOmniRouteReasonerRouteId` if set (the always-present code route).
2. Append each `openAiOmniRouteCustomRoutes[i].modelId` whose `capability === "reasoner"` (or `"general"` — mechanical code work is still code-capable), de-duplicated, preserving config order for deterministic round-robin.
3. If the result is empty, fall back to `[parentModelId]` filtered of `undefined` (single-model behavior); if it has exactly one entry, no spread occurs (unchanged behavior). No custom route is ever treated as code-capable **unless** its `capability` explicitly says so, so the spread can never accidentally send code work to a reader-only alias.

Because this adds a persisted setting field, the **Persisted Setting Checklist applies to this one field** (see "Files to modify" and the dedicated checklist note below): it is defined in the provider schema, is already part of `openAiOmniRouteCustomRoutes` which round-trips through `ContextProxy`/import-export today, needs no `cachedState`/`SettingsView` wiring change beyond what the existing custom-routes editor already does for `name`/`modelId` (the new field rides the same array), and is read only on the extension side in `collectCodeCapableRouteIds`. It is operator/power-user config, not a new top-level toggle.

Lane-to-route-id spread is a **routing** addition in `parallelWorkerRouting.ts` and the `runParallelTasks` dispatch site, plus the one additive schema field above; it does **not** touch `assignLanes`/`laneToRouteCapability` (which stay pure/additive) and does **not** change scheduler dispatch or leasing. The lane the worker carries drives both (a) the `RouteCapability` it leases against (decision B) and (b) the route id it dispatches with (here) — consistent by construction.

**How spread route ids relate to lease pools (fixes finding #3, second half).** The spread changes the *route id* a worker dispatches with, but every spread `coder.primary` worker still leases against the single `reasoner` capability pool (its `laneToRouteCapability` is `"reasoner"` for reasoning-typed coders). If the `reasoner` pool capacity stayed at vLLM's 2 while workers spread across vLLM + an ollama overflow backend, Menagerie would under-admit — only 2 generating at once even though two backends can serve code. **Resolution:** when the profile configures more than one code-capable route (spread is active), the `reasoner` capacity in the static map must be the **sum of the spread backends' real code slots**, not just vLLM's 2. This is documented in the capacity map (decision A) as an operator responsibility: the `reasoner` slot count equals the total code-capable concurrency the operator has configured to spread across. The design does not introduce per-route lease pools (that would require the live per-route load feed decision A declined to assume); it keeps the single `reasoner` pool and makes its capacity reflect the summed code backends. When no spread is configured, `reasoner` stays at the single backend's slots (2). This keeps Menagerie-side throttling and the route-id spread in agreement.

### D. Seeding `maxDispatched` / `maxInferenceLeases` from capacity

**Decision: seed `maxInferenceLeases` from the summed live capacity across all capabilities, and set the dispatch permit count to the larger of the capacity sum and a small floor, both clamped by the `User_Parallelism_Policy`.**

Today `runParallelTasks` builds the scheduler with `{ ...DEFAULT_SCHEDULER_BOUNDS, maxInferenceLeases: DEFAULT_SCHEDULER_BOUNDS.maxDispatched }` — leases seeded from the dispatch ceiling (8), a local number. The replacement, computed once at batch start from the capacity provider:

```
capacitySum      = Σ over RouteCapabilities of provider.capacitiesFor(cap)[*].available
maxPerCapability = max over RouteCapabilities of provider.capacitiesFor(cap)[*].available
maxInferenceLeases    = max(1, capacitySum)                 // real backend slots aggregate, never 0
maxDispatched (bound) = clampCeiling(max(capacitySum, maxPerCapability, SMALL_FLOOR), policy.maxDispatched)
maxLive (bound)       = clampCeiling(DEFAULT_SCHEDULER_BOUNDS.maxLive, policy.maxLive)  // unchanged (12)
```

- `maxInferenceLeases` is an **observability aggregate**, not an admission gate. The pools are **per-capability** (`InferenceLeasePool.liveCapacity()` is read per capability from the provider), so the operative cap is always the provider's per-capability `available`; `maxInferenceLeases` is the scheduler-level sum reported for metrics. For the confirmed topology it is ~7 (reader 4 + reasoner 2 + general 1), but note this **may exceed distinct physical slots when two capabilities share one backend** (fixes finding #6): e.g. `reader` and `long-context` both back onto ollama-local, so summing their per-capability `available` double-counts that backend. The sum is deliberately an upper-bound aggregate for observability; the per-capability pool is the only thing that actually gates admission, so the double-count has no effect on throttling. The excess for a hot capability (e.g. a 6-code-worker batch against 2 `reasoner` slots) queues on that capability's pool, not at OmniRoute.
- `maxDispatched` is seeded to the larger of the capacity sum, the **largest single-capability capacity** (`maxPerCapability`), and a small floor (`SMALL_FLOOR = 4`), then clamped down by any user policy. The `maxPerCapability` term is what guarantees the correct liveness invariant from decision B — enough dispatch permits exist to fill the largest single pool, so no pool's slots sit unfillable for want of a permit. Workers beyond real capacity for a given capability wait on that capability's lease rather than being dispatched to OmniRoute.
- When a user policy clamps `maxDispatched` below `maxPerCapability`, the excess slots of the largest pool simply go unused for that batch (acceptable, documented): the user's appetite ceiling wins over physical capacity, consistent with decision E. This is a throughput choice, never a deadlock — a smaller permit count still lets every admitted worker reach and release its lease.
- `maxLive` (logical liveness, 12) is unchanged: logical workers may far exceed inference slots by design (`PAR-001`); liveness is bounded by policy, not by physical capacity.

This directly implements findings target (a)#4: once capacity is known, seed from the live capacity (sum and per-capability max) instead of `maxDispatched`.

### E. User control / spec reconciliation

The `user-controlled-parallelism` spec defines parallelism as an **appetite ceiling**, not a capacity setting, and explicitly hands the resolved numeric ceilings to the `Bounded_Elastic_Scheduler` for enforcement (Req 3.6, 8.5). Capacity is **not** user-set here; it is operator-configured (the static map, decision A) and read automatically. These compose cleanly and without contradiction:

- The `User_Parallelism_Policy` remains the **upper** bound: `clampCeiling` only ever *lowers* `maxLive`/`maxDispatched` by the policy (Req 8.2, PAR-014.1). Capacity-seeding (decision D) sets the *starting* bound; policy clamps it down. A Conservative policy (max live 3, max dispatched 2) still wins when it is tighter than capacity.
- Capacity never *raises* a bound above what policy allows. If capacity says 7 but policy says max dispatched 2, dispatched is 2.
- Auto mode (default) keeps "mastermind decides useful concurrency, OmniRoute decides physical" — now with Menagerie *actually* enforcing physical slots via leases instead of over-dispatching. This makes Auto behave as its spec text already promises (Req 4.3) rather than flooding OmniRoute.
- No new user-facing control is added; no accepted spec is contradicted. The capacity map is operator config, orthogonal to the user's appetite dimension.

The `elastic-parallel-execution` spec's lease state machine (`runnable` → `waiting-for-inference` → `generating` → `runnable`) is now *exercised* for the first time, exactly as that spec designed it. The `capability-lanes-routing` spec's purity contract for `assignLanes`/`laneToRouteCapability` is preserved. The `dynamic-capability-broker` spec is orthogonal (tool-capability axis, not inference capacity) and is untouched.

### F. Backward safety

- **No deadlock.** Proven in decision B (acyclic permit≺lease ordering + draining leases + capacity floor ≥ 1).
- **No throughput regression for the common small-batch case.** A batch whose worker count ≤ real capacity acquires every lease immediately (the pool grants without queueing when `held < liveCapacity()` and no one is queued), so it behaves exactly as today minus the OmniRoute queue spills. A single-worker or 2-worker batch is unaffected. The routing spread is opt-in (only engages when multiple code-capable routes are configured), so an unconfigured user sees identical routing to today.
- **Fail safe on unknown capacity.** A capability absent from the map returns the bounded default (2), never 0 (no deadlock) and never 12 (no over-dispatch). A malformed/negative reading is clamped by `InferenceLeasePool.liveCapacity()` and by the provider's floor-of-1 guarantee.
- **Preserves all existing invariants.** Batch persistence, worktree isolation, result ownership, idempotent lease release, and "never abandon siblings holding permits" are all retained; the lease wiring is purely additive around the existing run body.

## Capacity-map data model

A new module `src/core/task/routeCapacityMap.ts` (sits beside the scheduler types; mirrors `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`'s role in `omniroute.ts`):

- `STATIC_ROUTE_CAPACITY: Readonly<Record<RouteCapability, number>>` — per-capability real slot counts, with a source-of-truth doc comment naming the OmniRoute `PROVIDER_POLICIES` (vllm/ollama-local/llama-cpp) the operator maintains, and the instruction to keep it in lockstep with the serving config (identical discipline to the context-window map).
- `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2` — the bounded fail-safe for an absent/invalid capability.
- `createStaticRouteCapacityProvider(map = STATIC_ROUTE_CAPACITY): RouteCapacityProvider` — returns a provider whose `capacitiesFor(capability)` yields one `RouteCapacity { route: "static:<capability>", capability, capacity: slots, available: slots }` with `slots = max(1, map[capability] ?? DEFAULT_UNKNOWN_CAPABILITY_SLOTS)` (floor of 1 guarantees forward progress), and whose `sustainedPressure()` returns `0` (no live pressure signal in this pass, so new-fan-out backpressure stays off — unchanged from today, and safe because the lease pools now throttle generations directly).

Validation. `STATIC_ROUTE_CAPACITY` values are validated at module load by a small Zod schema (`z.number().int().positive()`), so a mis-edit (0, negative, non-integer) is caught in tests rather than silently producing a wedged pool. `createStaticRouteCapacityProvider` additionally applies the runtime floor-of-1 as defense in depth.

## Files to modify / add

- `src/core/task/routeCapacityMap.ts` (**new**) — `STATIC_ROUTE_CAPACITY`, `DEFAULT_UNKNOWN_CAPABILITY_SLOTS`, `createStaticRouteCapacityProvider`, Zod validation. ~40–60 lines.
- `src/core/task/runParallelTasks.ts` (**modify**):
  - Remove the `GENEROUS_BATCH_ROUTES` stub; construct the scheduler with `createStaticRouteCapacityProvider()` instead.
  - Replace the `maxInferenceLeases: DEFAULT_SCHEDULER_BOUNDS.maxDispatched` seed with the capacity-derived seeding of decision D (compute `capacitySum`, seed `maxInferenceLeases` and `maxDispatched` accordingly, pass through the existing `policy` so `clampCeiling` still applies).
  - Bind the `handle` argument of `scheduler.dispatch(spec.name, async (handle) => {...})`; acquire a lease at the top of the run body via `handle.acquireLease(capability, signal)` and release it in an outer `finally` — **except for auto-reader workers** (`project-reader` + `AUTO_READER_NAME` prefix), which skip the acquire and use a no-op release (decision B, finding #4).
  - Compute each worker's `(lane, taskType)` via `assignLanes(specs)` (pure, additive) once, derive the per-worker `RouteCapability` via `laneToRouteCapability`, compute the per-batch **coder-only ordinal** map (0-based index among `coder.primary` assignments, in spec order; decision C / finding #3), build `codeCapableRouteIds` once via `collectCodeCapableRouteIds(profile)`, and derive the per-worker route id via the new `resolveLaneRouteId(...)` (decision C) in place of today's `resolveWorkerModelId` call that sets `context.apiConfiguration.openAiModelId`.
- `src/core/task/parallelWorkerRouting.ts` (**modify, additive**):
  - Add `resolveLaneRouteId({ lane, taskType, profile, route, parentModelId, coderOrdinal, codeCapableRouteIds })` — a pure resolver extending `resolveWorkerModelId`'s precedence with the lane dimension and the round-robin code-route spread keyed on `coderOrdinal`. `resolveWorkerModelId`/`roleDefault` stay for the no-lane fallback path and for backward compatibility.
  - Add `collectCodeCapableRouteIds(profile, parentModelId): string[]` — a pure helper that returns the ordered, de-duplicated list of code-capable route ids: `openAiOmniRouteReasonerRouteId` (if set) plus every `openAiOmniRouteCustomRoutes` entry whose new `capability` is `"reasoner"` or `"general"`; falls back to `[parentModelId]` (filtered of undefined) when empty. No changes to `assignLane`/`assignLanes`/`laneToRouteCapability` (purity contract preserved).
- `packages/types/src/provider-settings/openai.ts` (**modify, additive, finding #2**):
  - Add an optional `capability` field to the `openAiOmniRouteCustomRoutes` object schema: `z.object({ name: z.string(), modelId: z.string(), capability: routeCapabilitySchema.optional() })`, where `routeCapabilitySchema = z.enum(["reader","reasoner","long-context","vision","general"])` matches the `RouteCapability` union in `src/core/task/elasticTypes.ts` (add a doc comment requiring the two stay in lockstep). The field is optional, so existing persisted profiles round-trip unchanged. **Persisted Setting Checklist (this one field):** it rides the existing `openAiOmniRouteCustomRoutes` array that already persists through `ContextProxy` and import/export; the existing custom-routes editor in `SettingsView` must surface the new optional field through `cachedState` like `name`/`modelId` (one added control in the existing per-route row, saved in the same `updateSettings` payload); it is read only on the extension side by `collectCodeCapableRouteIds`; no new `ExtensionState`/`getState()` top-level key is introduced because it is nested in the already-returned custom-routes array. Add a focused `webview-ui` test for the editor binding and a `packages/types` round-trip test for the new field.
- `src/core/task/elasticTypes.ts` — **no change** to the types; `DEFAULT_SCHEDULER_BOUNDS` is read, not edited. (The `RouteCapability` union is the source of truth that `routeCapabilitySchema` mirrors; if it changes, update both.) If a shared `SMALL_FLOOR` constant is wanted, it lives in `routeCapacityMap.ts`, not here.
- `src/core/tools/ParallelTasksTool.ts` — **no change** required; `ADMISSION_ONLY_ROUTES` stays for validation-only plan admission (its capacity is never consulted). Optional future cleanup: share the admitted scheduler with `runParallelTasks`, out of scope here.

Scope note on `packages/types`: the one additive schema field above is required by the chosen (non-heuristic) spread source (decision C, finding #2). The capacity *numbers* remain operator config in a code constant (`routeCapacityMap.ts`, like the context-window map), not a persisted user setting; only the optional per-custom-route `capability` classifier is a persisted field, and the Persisted Setting Checklist is traced for it above.

## Data flow (chosen capacity source)

1. `runParallelTasks` is entered with the validated `specs` and the request-scoped `UserParallelismPolicy`.
2. `provider = createStaticRouteCapacityProvider()` reads `STATIC_ROUTE_CAPACITY` (per-capability real slots, floored at 1).
3. `capacitySum = Σ provider.capacitiesFor(cap).available`; bounds are seeded (decision D) and clamped by `policy`; `new BoundedElasticScheduler(bounds, policy, provider)`.
4. `assignLanes(specs)` (pure) yields `(spec, lane, capability)` per worker; `defaultLaneTaskType(spec.mode)` (or a mastermind-supplied type) gives the `taskType`. A single pass over the assignments computes the coder-only ordinal map (0-based index among `coder.primary` assignments in spec order), and `codeCapableRouteIds = collectCodeCapableRouteIds(profile, parentModelId)` is built once.
5. Per worker: `openAiModelId = resolveLaneRouteId({ lane, taskType, profile, route: spec.route, parentModelId, coderOrdinal, codeCapableRouteIds })` (route-id spread keyed on the coder ordinal, decision C), and the worker's `RouteCapability = laneToRouteCapability(lane, taskType)` is captured for leasing.
6. Dispatch: `scheduler.dispatch(spec.name, async (handle) => { const releaseLease = isAutoReader(spec) ? () => {} : await handle.acquireLease(capability, signal); try { ...existing run body... } finally { releaseLease() } })`, where `isAutoReader(spec)` is the existing `project-reader` + `AUTO_READER_NAME`-prefix predicate (decision B, finding #4).
7. Inside `handle.acquireLease`, the scheduler reads the capability's pool, which reads `provider.capacitiesFor(capability)` **fresh** (`InferenceLeasePool.liveCapacity()`), grants or queues (`waiting-for-inference`), and transitions the worker to `generating` when the lease is held. Over-capacity workers for a hot capability queue *inside* Menagerie.
8. On settle, the outer `finally` releases the lease; `pump()` admits the next queued waiter for that capability; the existing completion-event/manifest path is unchanged.

## Error handling (per operation that can fail)

- **Capacity map read / malformed value.** Failure condition: a capability missing from the map, or a non-positive/non-integer value. Recoverable. The provider substitutes `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` (missing) or the floor-of-1 clamp (invalid), and the Zod load-time validation fails the test suite for a static mis-edit. Caller receives a usable, bounded capacity, never 0 and never 12. Logged: a **once-per-process** warn when a capability first falls through to the default, so operators notice an unmapped capability without failing the batch. Because `createStaticRouteCapacityProvider()` is constructed per batch (finding #7), the warn is deduplicated by a module-level `Set<RouteCapability>` of already-warned capabilities (or emitted from the one-time Zod load-time validation path), never once per batch — so a persistently unmapped capability does not spam the log.
- **`acquireLease` rejected by abort.** Failure condition: the batch/worker `signal` aborts while a worker waits for a lease. Recoverable at the worker level: the pool rejects just that waiter (returning it to `runnable`), the dispatch body's existing `catch` records `cancelled`/`failed`, and no held lease is touched (`PAR-021.5`). Caller: the worker's `ParallelTaskResult.state` becomes `cancelled`. Not separately logged beyond the existing per-worker error capture.
- **Run-body throw while holding a lease.** Failure condition: `createParallelWorkspace`, runtime creation, or `waitForParallelTask` throws. Recoverable for siblings. The outer `finally` releases the lease (idempotent), the inner `finally` disposes the child, and the existing `catch` records the error on the result; siblings holding permits/leases are untouched. Logged via the existing per-worker `result.error` channel and manifest.
- **Double release.** Not an error: `makeHandle`'s returned release and `InferenceLeasePool.makeRelease` are both idempotent, so a defensive double `finally` is a no-op and cannot corrupt the held count.
- **Capacity sum resolves to 0.** Cannot occur: every per-capability value is floored at 1 and the sum is over a non-empty capability set, so `capacitySum >= 1` and `maxInferenceLeases = max(1, capacitySum) >= 1`. The deadlock path is therefore unreachable.

## Input validation (external inputs)

- **`STATIC_ROUTE_CAPACITY` (operator config, compiled-in).** Required: a positive integer per listed capability. Type: `number`. Limits: `> 0`, integer. On failure: Zod schema fails at module load (test-visible); runtime floor-of-1 as defense in depth.
- **`spec.route` (mastermind/user-supplied route id).** Optional. Type: string, 1–200 chars (already enforced by `parallelTaskSpecSchema`). On present: used verbatim (decision C step 1), consistent with the existing pass-through-for-`route` rule in `rejectMastermindPhysicalPlacement`. On absent: lane/role fallback.
- **`UserParallelismPolicy` fields.** Optional (already consumed read-only as upper bounds). On absent: scheduler defaults apply. On present: `clampCeiling` lowers the bound, never raises it. No new validation needed.
- **`lane` / `taskType`.** Produced internally by `assignLanes`/`defaultLaneTaskType` (total functions over the enums); no external value reaches `laneToRouteCapability` unvalidated.

## Invariant ownership

- **"A lease is held only while a worker occupies an inference slot."** Owned by `BoundedElasticScheduler.makeHandle`/`InferenceLeasePool` (existing). This design upholds it with a per-worker (lifetime) approximation and never fabricates a `generating` state outside a held lease.
- **"Capacity reflects real backend slots, floored at 1, never 0 or 12."** Owned by `createStaticRouteCapacityProvider` (new), the single enforcement point. Chosen there because it is the one place every capacity read funnels through, so the floor/default cannot be bypassed.
- **"Permit ≺ lease acquisition order, uniformly."** Owned by the `runParallelTasks` dispatch body (the only lease-acquire site). Enforced by acquiring the lease strictly inside the already-held dispatch permit, with no reverse path.
- **"Lanes/`laneToRouteCapability` stay pure and additive."** Owned by `capabilityLanes.ts`/`parallelWorkerRouting.ts` existing contract; this design adds route-id resolution in a *separate* pure function and never mutates the lane helpers.
- **"User policy is the upper bound; capacity never raises a bound."** Owned by `clampCeiling` (existing) plus the decision-D seeding, which feeds `clampCeiling` and never bypasses it.

## Testability

Unit-testable (package-local Vitest in `src`), the lowest layer that proves each behavior:

- `routeCapacityMap`: Zod validation rejects 0/negative/non-integer; `createStaticRouteCapacityProvider` returns floored capacity for known capabilities, `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` for an absent one, and never 0; `sustainedPressure()` is 0.
- `resolveLaneRouteId`: explicit `route` wins; `reader.*` → reader route id; `coder.primary` with a single configured code route returns `openAiOmniRouteReasonerRouteId` unchanged (no-regression case) **regardless of task type**; `coder.primary` with multiple configured code routes round-robins by `coderOrdinal` (assert `coderOrdinal % n` selection, and that a reasoning-typed coder — the default — spreads, directly covering finding #1); no-lane fallback returns the parent id.
- `collectCodeCapableRouteIds`: reasoner id included when set; custom routes with `capability: "reasoner"`/`"general"` included, others (e.g. `"reader"`) excluded; de-duplicated and config-ordered; empty → `[parentModelId]`.
- Coder-only ordinal: a mixed batch (readers/researchers interleaved with coders) assigns 0,1,2,… to coders only in spec order, independent of non-coder placement (finding #3).
- Bounds seeding: given a fake provider, assert `maxInferenceLeases = max(1, capacitySum)`, `maxDispatched >= max(capacitySum, maxPerCapability, SMALL_FLOOR)` before clamp, that `maxDispatched >= maxPerCapability` holds when policy does not clamp (finding #5), and that a tight `UserParallelismPolicy` clamps both down (and the unused-slots case is tolerated, not a stall).

Integration-testable (package-local, multiple internal modules, no VS Code host) using a fake `RouteCapacityProvider` and the real `BoundedElasticScheduler` + `InferenceLeasePool` (reuse the `elastic-parallel-execution` test harness; cross-reference rather than duplicate its interleavings):

- With `reasoner` capacity 2 and a 6-`coder.primary` batch dispatched through the real `acquireLease` wiring, assert at most 2 workers are `generating` at once and the rest are `waiting-for-inference` (throttled inside Menagerie), and that all 6 eventually complete (forward progress).
- Deadlock-freedom smoke: `maxDispatched` 8, `reasoner` capacity 2, all workers code — assert the batch drains with no stall (every worker reaches terminal state within the test's deterministic pump).
- Fail-safe: a capability absent from the map (capacity → default 2) still throttles and still drains; a hypothetical 0 is impossible by the floor and is asserted as such.
- Abort-while-waiting: cancel the batch while workers queue on a lease; assert queued waiters are rejected to `cancelled`, lease-holders settle on their own, and no sibling is abandoned.
- Auto-reader lease exemption (finding #4): a reader-swarm of size > `reader` capacity (e.g. 8 auto-readers against capacity 4), dispatched through the real wiring, asserts that **no** auto-reader waits on a `reader` lease (they are exempt), so none times out purely from lease-queue wait; and that a non-auto-reader worker in the same batch *does* lease. This proves the exemption preserves today's immediate-dispatch behavior for the auto-reader swarm.
- Spread + lease agreement (finding #3 second half): with two code routes configured and the `reasoner` pool capacity set to their summed slots, assert that spread `coder.primary` workers dispatch across both route ids and that at most `reasoner`-capacity are `generating` at once (route-id spread and lease throttling agree).

No `apps/vscode-e2e` coverage is needed: nothing here depends on the real extension host, workspace APIs, webview messaging, or activation. The behavior is fully provable at the unit/integration layer with a fake capacity provider and the real scheduler, per the Test Placement Guidance (keep protocol/throttling/edge-case assertions at the lowest layer that fails for the bug).

A design that was hard to test would be a red flag; this one injects capacity through the existing `RouteCapacityProvider` interface and keeps routing resolution pure, so every decision is exercised with fakes and the real scheduler — no runtime, no network, no host.

## Bounds-seeding formula (summary)

```
provider          = createStaticRouteCapacityProvider()          // floored ≥ 1 per capability
capacitySum       = Σ_cap provider.capacitiesFor(cap)[*].available        // observability aggregate
maxPerCapability  = max_cap provider.capacitiesFor(cap)[*].available      // largest single pool
maxInferenceLeases= max(1, capacitySum)                          // real slots aggregate, never 0
maxDispatchedBound= clampCeiling(max(capacitySum, maxPerCapability, SMALL_FLOOR), policy.maxDispatched)
maxLiveBound      = clampCeiling(DEFAULT_SCHEDULER_BOUNDS.maxLive, policy.maxLive)   // 12, unchanged
scheduler         = new BoundedElasticScheduler(
                      { maxLive: maxLiveBound, maxDispatched: maxDispatchedBound, maxInferenceLeases },
                      policy, provider)
```

where `SMALL_FLOOR = 4` (keeps dispatch able to feed the slots and reach lease-wait) and `clampCeiling` is the existing policy clamp (lowers only, floors at 1). The `maxPerCapability` term enforces the correct liveness invariant (`maxDispatched >= largest single-capability capacity` so no pool's slots sit unfillable; finding #5); the `capacitySum` term is retained because it is never larger than `maxPerCapability` only in degenerate single-capability maps and is harmless otherwise. This is the complete, concrete seeding; no architectural decision is left to the implementer.

## Review responses (revision pass)

This design was revised against `design-review.json` / `design-review.md`. Every finding is addressed below.

- **#1 (HIGH) — spread did not engage for the default coder population.** ADDRESSED. The spread now applies to the `coder.primary` **reasoning** path (the common `implementation`→`reasoner` case) regardless of task type, with the single-id carve-out removed. See decision C "The actual spread". A unit test asserts a default reasoning-typed coder spreads.
- **#2 (HIGH) — spread depended on a non-existent custom-route classification.** ADDRESSED via option (a): an optional `capability` field is added to the `openAiOmniRouteCustomRoutes` object schema in `packages/types/src/provider-settings/openai.ts`, listed in Files-to-modify with its Persisted Setting Checklist trace, and consumed by the new pure `collectCodeCapableRouteIds`. No name heuristic. No-match falls back to the single reasoner id.
- **#3 (MEDIUM) — round-robin under-specified; lease-pool relationship unstated.** ADDRESSED. The round-robin is keyed on a **coder-only ordinal** (not the global batch index), computed in one pass over the lane assignments. The spread-vs-lease relationship is specified: spread workers lease against the single `reasoner` pool, and the map's `reasoner` capacity must equal the summed code-backend slots when spread is active (documented in decisions A and C). An integration test asserts route-id spread and lease throttling agree.
- **#4 (MEDIUM) — reader floor could starve the 90s auto-reader timeout under lifetime leases.** ADDRESSED via option (b): auto-reader workers (`project-reader` + `AUTO_READER_NAME`) are exempt from `acquireLease` (read-only, 90s-bounded, 9B lane, not the 27B bottleneck). An integration test asserts a reader-swarm > `reader` capacity has no auto-reader waiting on a lease and none timing out from lease wait.
- **#5 (MEDIUM) — wrong liveness invariant for per-capability pools.** ADDRESSED. The invariant is restated as `maxDispatched >= max over capabilities of liveCapacity(cap)`, and the seed includes `maxPerCapability`. A tighter user policy leaving slots unused is called out as acceptable and documented.
- **#6 (NIT) — capacitySum double-counts shared backends.** ADDRESSED. `maxInferenceLeases` is explicitly labelled an observability aggregate that may exceed distinct physical slots when capabilities share a backend; the per-capability pool is the sole admission gate.
- **#7 (NIT) — per-batch warn can spam logs.** ADDRESSED. The fall-through warn is deduplicated once-per-process via a module-level warned-capability set (or emitted from the one-time Zod load path), not per batch.
