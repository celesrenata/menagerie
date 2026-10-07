# Implementation Plan — Capacity-Aware Parallel Scheduling and Backend Spread

Implements the approved design at `.agents/tasks/parallel-capacity-routing/design.md`, grounded in
`.agents/tasks/parallel-execution-bottlenecks/findings.md`. Makes inference capacity real inside
Menagerie (wire the existing-but-dead `InferenceLeasePool` via `handle.acquireLease`), spreads
same-category code workers across backends, and seeds scheduler bounds from real capacity — all
additive, no deadlock, no regression to the common small-batch case.

## Scope / guardrails (do NOT violate)

- Do NOT touch `src/api/providers/utils/timeout-config.ts` (stream-idle timeout already fixed in commit `92f8035a5`).
- Do NOT weaken task-lifecycle reducers (`src/core/task-persistence/taskLifecycle.ts`) or the #1469/#1021 witnesses.
- Keep `assignLanes` / `assignLane` / `laneToRouteCapability` **pure and additive** — add new functions, never mutate these.
- Do NOT redefine `RouteCapability`, `InferenceLeasePool`, or dispatch/lease mechanics; consume them.
- `src/eslint-suppressions.json`: suppression counts must never increase for files touched. Avoid `as any`.
- Do NOT create `.changeset` files or edit `CHANGELOG.md`.

## Commands used for verification (discovered during exploration)

- `src` unit/integration tests: `pnpm --dir src exec vitest run <path>` (or `cd src && pnpm vitest run <path>`).
- `src` type check: `pnpm --dir src exec tsc --noEmit`.
- `src` lint for a touched file: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>`.
- `packages/types` tests: `pnpm --dir packages/types exec vitest run <path>`.
- `webview-ui` tests: `pnpm --dir webview-ui exec vitest run <path>`.
- Model checks (run after wiring, since lease/scheduler fan-out behavior is touched):
  `pnpm lifecycle:model-check` and `pnpm fanout-protocol:model-check` from repo root.

Design decisions are already fixed in `design.md`; this plan sequences them. Where the design leaves
a mechanical choice (constant placement, test file names), the choice is recorded inline.

---

- [ ] 1. Add the optional `capability` classifier field to the OmniRoute custom-routes schema.
      Extend `openAiOmniRouteCustomRoutes` in `packages/types/src/provider-settings/openai.ts` from
      `z.object({ name, modelId })` to `z.object({ name: z.string(), modelId: z.string(), capability: routeCapabilitySchema.optional() })`,
      where `routeCapabilitySchema = z.enum(["reader","reasoner","long-context","vision","general"])`
      is defined in that file (or imported) with a doc comment requiring it stay in lockstep with the
      `RouteCapability` union in `src/core/task/elasticTypes.ts` and the `ROUTE_CAPABILITIES` tuple there.
      Field is optional so every existing persisted profile round-trips unchanged.
      Files: `packages/types/src/provider-settings/openai.ts`
      Verify: `pnpm --dir packages/types exec vitest run` passes, including a new round-trip test (step 2);
      `pnpm --dir packages/types exec tsc --noEmit` succeeds.

- [ ] 2. Add a `packages/types` round-trip test for the new optional `capability` field.
      Assert a custom-routes array with a `capability` value parses and preserves the field, that an
      entry with no `capability` still validates (back-compat), and that an invalid capability string is
      rejected by the enum. Place beside existing provider-settings tests (follow the nearest existing
      `openai`/provider-settings spec layout under `packages/types/src`).
      Files: new `packages/types/src/provider-settings/__tests__/openai.capability.test.ts` (match the
      directory convention used by sibling provider-settings tests; if a single `openai` spec already
      exists, extend it instead of adding a new file).
      Verify: `pnpm --dir packages/types exec vitest run <that spec>` — new assertions pass.

- [ ] 3. Create the static route-capacity provider module.
      New `src/core/task/routeCapacityMap.ts` exporting: `STATIC_ROUTE_CAPACITY: Readonly<Record<RouteCapability, number>>`
      (reader 4, reasoner 2, long-context 4, general 1, vision via fail-safe — values are operator-tunable;
      add a source-of-truth doc comment naming OmniRoute `PROVIDER_POLICIES` (vllm/ollama-local/llama-cpp)
      and, per design-review finding #1, stating that when code spread is configured across >1 backend the
      `reasoner` value MUST equal the summed real slots of every route returned by `collectCodeCapableRouteIds`);
      `DEFAULT_UNKNOWN_CAPABILITY_SLOTS = 2`; optional `SMALL_FLOOR = 4` (used by step 6);
      `createStaticRouteCapacityProvider(map = STATIC_ROUTE_CAPACITY): RouteCapacityProvider` whose
      `capacitiesFor(cap)` returns one `RouteCapacity { route: "static:<cap>", capability: cap, capacity: slots, available: slots }`
      with `slots = max(1, map[cap] ?? DEFAULT_UNKNOWN_CAPABILITY_SLOTS)` (floor of 1 guarantees forward
      progress), and `sustainedPressure()` returns `0`. Validate `STATIC_ROUTE_CAPACITY` at module load
      with `z.number().int().positive()` per value. Emit a once-per-process `warn` (module-level
      `Set<RouteCapability>`) the first time a capability falls through to the default, so a persistently
      unmapped capability never spams across per-batch provider construction (finding #7).
      Files: `src/core/task/routeCapacityMap.ts`
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/routeCapacityMap.spec.ts` (step 4) passes;
      `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/routeCapacityMap.ts` reports no new suppressions.

- [ ] 4. Unit-test `routeCapacityMap`.
      New `src/core/task/__tests__/routeCapacityMap.spec.ts`: Zod load-time validation rejects 0/negative/
      non-integer map values; `createStaticRouteCapacityProvider` returns floored capacity for known
      capabilities, `DEFAULT_UNKNOWN_CAPABILITY_SLOTS` for an absent one, never 0 (floor of 1 for a
      hypothetical 0/negative map override passed in); `sustainedPressure()` is `0`; the fall-through warn
      fires at most once per process for the same capability.
      Files: `src/core/task/__tests__/routeCapacityMap.spec.ts`
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/routeCapacityMap.spec.ts` — all new tests pass.

- [ ] 5. Add the pure lane→route-id spread resolvers to `parallelWorkerRouting.ts` (additive).
      Add `collectCodeCapableRouteIds(profile, parentModelId): string[]` — ordered, de-duplicated list:
      `profile.openAiOmniRouteReasonerRouteId` (if set) plus each `openAiOmniRouteCustomRoutes` entry whose
      `capability` is `"reasoner"` or `"general"` (others, incl. `"reader"/"long-context"/"vision"`, excluded —
      finding #2), preserving config order; falls back to `[parentModelId]` filtered of undefined when empty.
      Add `resolveLaneRouteId({ lane, taskType, profile, route, parentModelId, coderOrdinal, codeCapableRouteIds })`
      — pure, extends `resolveWorkerModelId` precedence with the lane dimension:
      (1) explicit `route` wins verbatim; (2) by lane: `reader.*` → `openAiOmniRouteReaderRouteId`;
      `coder.primary` → round-robin `codeCapableRouteIds[coderOrdinal % codeCapableRouteIds.length]` when
      `codeCapableRouteIds.length > 1` **regardless of taskType** (finding #1), else `openAiOmniRouteReasonerRouteId`
      unchanged; `reasoning.escalation` → reasoner/long-context id by taskType; (3) else fall back to parent id.
      Leave `roleDefault`/`resolveWorkerModelId`/`assignLane`/`assignLanes`/`laneToRouteCapability` untouched
      (purity contract preserved).
      Files: `src/core/task/parallelWorkerRouting.ts`
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/parallelWorkerRouting.spec.ts` (step 6) passes;
      `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/parallelWorkerRouting.ts` — no new suppressions.

- [ ] 6. Unit-test the new routing resolvers (extend the existing routing spec).
      In `src/core/task/__tests__/parallelWorkerRouting.spec.ts` add: `collectCodeCapableRouteIds` includes
      reasoner id when set, includes custom routes with `capability "reasoner"/"general"`, excludes `"reader"`,
      de-duplicates, preserves config order, and returns `[parentModelId]` when empty; `resolveLaneRouteId`
      — explicit `route` wins; `reader.*` → reader id; `coder.primary` with a single code route returns
      `openAiOmniRouteReasonerRouteId` unchanged for a reasoning-typed (`implementation`) coder (no-regression);
      `coder.primary` with multiple code routes round-robins by `coderOrdinal % n` and a default reasoning-typed
      coder spreads (directly covers finding #1); no-lane/parent fallback returns parent id.
      Files: `src/core/task/__tests__/parallelWorkerRouting.spec.ts`
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/parallelWorkerRouting.spec.ts` — new tests pass.

- [ ] 7. Wire capacity, bounds-seeding, lane-driven routing, and the coder-only ordinal into `runParallelTasks`.
      In `src/core/task/runParallelTasks.ts`:
      (a) Remove the `GENEROUS_BATCH_ROUTES` stub; `const provider = createStaticRouteCapacityProvider()`.
      (b) Replace the scheduler construction: compute `capacitySum = Σ_cap provider.capacitiesFor(cap)[*].available`
          and `maxPerCapability = max_cap ...` over `ROUTE_CAPABILITIES`; set
          `maxInferenceLeases = max(1, capacitySum)` and
          `maxDispatched = max(capacitySum, maxPerCapability, SMALL_FLOOR)` (SMALL_FLOOR=4), `maxLive` unchanged (12);
          pass the existing `policy` through to `new BoundedElasticScheduler(bounds, policy, provider)` so
          `clampCeiling` still lowers (never raises) both bounds. (The `maxPerCapability` term enforces the
          correct liveness invariant from finding #5; `clampCeiling` is applied inside the scheduler, unchanged.)
      (c) Before dispatch: `const assignments = assignLanes(specs)` (pure); build the per-spec `RouteCapability`
          via `laneToRouteCapability(lane, defaultLaneTaskType(spec.mode))` (or a mastermind-supplied type if present);
          build `codeCapableRouteIds = collectCodeCapableRouteIds(profile, parentModelId)` once; compute the
          per-batch **coder-only ordinal** map in one O(N) pass over `assignments` in spec order (0,1,2,… for
          `lane === "coder.primary"` only; finding #3). Set `context.apiConfiguration.openAiModelId` via
          `resolveLaneRouteId({ lane, taskType, profile: context.apiConfiguration, route: spec.route, parentModelId, coderOrdinal, codeCapableRouteIds })`
          replacing the current `resolveWorkerModelId(...)` call in the `Promise.all` over specs.
      (d) Bind the handle: `scheduler.dispatch(spec.name, async (handle) => { ... })`. At the very top of the
          run body, after `signal.throwIfAborted()`, acquire a lease **unless the worker is an auto-reader**:
          `const releaseLease = isAutoReader(spec) ? () => {} : await handle.acquireLease(capability, workerSignalOrBatchSignal)`
          where `isAutoReader(spec)` reuses the existing predicate `spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)`
          (finding #4; auto-readers keep today's immediate dispatch). Wrap the existing body so `releaseLease()`
          runs in an **outer** `finally` that executes after the existing inner child-dispose `finally`
          (`acquireLease`'s release is idempotent, so a double release is a no-op). Acquisition order is strictly
          permit-then-lease (dispatch permit already held when the lease is acquired) — do not add any reverse edge.
      Files: `src/core/task/runParallelTasks.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` succeeds; `pnpm --dir src exec vitest run src/core/task`
      (there is no pre-existing `runParallelTasks` spec; the new capacity spec in step 8 provides coverage —
      ensure no sibling scheduler/routing suite regresses); `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/runParallelTasks.ts` — no new suppressions.

- [ ] 8. Add the scheduler integration test: throttling + spread + no-deadlock + abort + reader exemption.
      New `src/core/task/__tests__/runParallelTasks.capacity.spec.ts` using the **real** `BoundedElasticScheduler` + `InferenceLeasePool` with a fake/injected
      `RouteCapacityProvider` (reuse the elastic-parallel-execution harness patterns; cross-reference, do not
      duplicate its interleavings). Cover:
      - **Throttle under capacity=small:** `reasoner` capacity 2, a 6-`coder.primary` batch dispatched through
        the real `acquireLease` wiring → at most 2 `generating` at once, the rest `waiting-for-inference`
        (throttled inside Menagerie), and all 6 eventually reach a terminal state (forward progress).
      - **No-deadlock smoke (capacity=small):** `maxDispatched` 8, `reasoner` capacity 2, all code workers →
        the batch drains with no stall within the test's deterministic pump.
      - **Spread of N code workers across M backends:** two code routes configured (`reasoner` pool capacity
        set to their summed slots per the design's operator rule) → assert the N `coder.primary` workers'
        resolved route ids distribute across both ids by `coderOrdinal % M` AND at most `reasoner`-capacity are
        `generating` at once (route-id spread and lease throttling agree; finding #3 second half).
      - **Abort-while-waiting:** cancel the batch while workers queue on a lease → queued waiters are rejected to
        `cancelled`, lease-holders settle on their own, no sibling abandoned (`PAR-021.5`).
      - **Auto-reader exemption:** a reader swarm larger than `reader` capacity (e.g. 8 auto-readers vs capacity 4)
        → no auto-reader waits on a `reader` lease (none times out from lease-queue wait), while a non-auto worker
        in the same batch does lease (finding #4).
      Files: `src/core/task/__tests__/runParallelTasks.capacity.spec.ts`
      Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/runParallelTasks.capacity.spec.ts` — all new tests pass.

- [ ] 9. Add a focused bounds-seeding unit test.
      In the capacity spec (step 8) or a small dedicated spec, given a fake provider assert:
      `maxInferenceLeases === max(1, capacitySum)`; `maxDispatched >= max(capacitySum, maxPerCapability, SMALL_FLOOR)`
      before clamp; `maxDispatched >= maxPerCapability` when policy does not clamp (finding #5); a tight
      `UserParallelismPolicy` clamps both bounds down and the resulting unused-slots case drains (never a stall).
      Prefer extracting the seeding math into a tiny pure helper (e.g. `computeCapacityBounds(provider, policy)`
      in `runParallelTasks.ts` or `routeCapacityMap.ts`) so it is testable without constructing a full batch;
      if extracted, keep the production call site using it.
      Files: `src/core/task/__tests__/runParallelTasks.capacity.spec.ts` (and the helper's module if extracted)
      Verify: `pnpm --dir src exec vitest run <that spec>` — bounds-seeding assertions pass.

- [ ] 10. Surface the optional `capability` field in the OmniRoute custom-routes editor (webview, additive).
      In `webview-ui/src/components/settings/OmniRouteSettings.tsx` add one optional control per custom-route row
      (and to the add-route row) for the new `capability` (a small select/dropdown over the five values plus an
      "unclassified"/empty default); include it in the object pushed by `addCustomRoute` and persist it in the
      same `setApiConfigurationField("openAiOmniRouteCustomRoutes", ...)` array so it rides the existing
      `cachedState`/`updateSettings` path (no new top-level `ExtensionState`/`getState` key — the field is nested
      in the already-persisted custom-routes array). Give the new control a stable `data-testid`
      (e.g. `omniroute-route-capability-${index}` and `omniroute-new-route-capability`).
      Files: `webview-ui/src/components/settings/OmniRouteSettings.tsx` (+ i18n string keys if a label is added)
      Verify: `pnpm --dir webview-ui exec vitest run <OmniRouteSettings test>` (step 11) passes.

- [ ] 11. Add the webview test for the capability-field editor binding.
      Add/extend a JSDOM Vitest test for `OmniRouteSettings` (follow the `webview-ui/src/**/__tests__` convention
      and `renderWithExtensionState`/`makeExtensionState` helpers): selecting a `capability` on a custom route (and
      on the add-route flow) updates the `openAiOmniRouteCustomRoutes` entry via `setApiConfigurationField`, and an
      existing route with no `capability` renders without error (back-compat).
      Files: `webview-ui/src/components/settings/__tests__/OmniRouteSettings.spec.tsx` (extend the existing spec)
      Verify: `pnpm --dir webview-ui exec vitest run <that test>` — new assertions pass.

- [ ] 12. Run the affected lifecycle/scheduler model checks and full type/lint gates.
      Because lease wiring and scheduler fan-out behavior changed, run both model checks the brief named plus
      the per-package gates for every touched file.
      Files: none (verification only)
      Verify, all must pass:
      - `pnpm lifecycle:model-check`
      - `pnpm fanout-protocol:model-check`
      - `pnpm --dir src exec tsc --noEmit`
      - `pnpm --dir packages/types exec tsc --noEmit`
      - `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/runParallelTasks.ts core/task/parallelWorkerRouting.ts core/task/routeCapacityMap.ts`
        (confirm no suppression count increased for any touched file)
      - `pnpm --dir src exec vitest run src/core/task` (the touched scheduler/routing suites)
      - `pnpm --dir packages/types exec vitest run` and `pnpm --dir webview-ui exec vitest run src/components/settings`
      Clean up any temporary files created during verification.

## Notes / assumptions

- Capability derivation per worker and the route-id spread both key off the same lane assignment, so a worker's
  lease pool and its dispatched backend class agree by construction (design decisions B and C) — keep that
  coupling: do not derive capability from a different source than the lane used for `resolveLaneRouteId`.
- The design treats the `reasoner` map value as "total code-capable concurrency the operator spreads across";
  the step-3 doc comment and the step-8 spread test together encode this (design-review finding #1 NIT).
- `src/core/task/elasticTypes.ts`, `src/core/tools/ParallelTasksTool.ts`: no change required (design says so).
  `ROUTE_CAPABILITIES`/`RouteCapability` remain the source of truth that `routeCapabilitySchema` mirrors; if
  either changes, update both (note in the step-1 doc comment).
- Test placement follows the repo Test Placement Guidance: all scheduler/routing/throttling behavior is proven
  at the package-local unit/integration layer with a fake capacity provider and the real scheduler; **no
  `apps/vscode-e2e` coverage is added** (nothing here needs the real extension host).
