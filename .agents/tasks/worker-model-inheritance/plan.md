# Implementation Plan — Parallel-Worker Model-Routing Bug (worker-model-inheritance)

## Summary

project-reader (and other) parallel workers send the parent orchestrator's model
id (`hybrid/planner`) to OmniRoute instead of their own profile's model id
(`hybrid/reader`). All worker inference lands on the GLM planner lane; the
reader/code backends never receive traffic.

The hypothesis in the task brief named `resolveWorkerModelId` in
`parallelWorkerRouting.ts` as the culprit. That function is CORRECT and already
has the needed "own saved profile model" step — but **it is not the function the
live path calls.** The real cause is in a sibling resolver,
`resolveLaneRouteId`, which the live call site in `runParallelTasks.ts` uses
instead. `resolveLaneRouteId` has no own-profile-model step, so a reader whose
role route id is `null` falls straight through to the parent's model id.

## Confirmed root-cause chain (file:line evidence)

The brief's hypothesis about the *mechanism* (child inherits a profile, role
route is null, falls back to parent) is right, but it is wired through
`resolveLaneRouteId`, not `resolveWorkerModelId`. Chain:

1. **Live call site uses `resolveLaneRouteId`, not `resolveWorkerModelId`.**
   `src/core/task/runParallelTasks.ts:363-379` builds each worker's context and
   sets the model id:
   ```ts
   const context = await provider.getTaskHandoffContext(parent, spec.mode, true)   // :364
   const lane = laneByName.get(spec.name)!                                          // :366
   const codeCapableRouteIds = collectCodeCapableRouteIds(context.apiConfiguration, parentModelId) // :367
   context.apiConfiguration.openAiModelId = resolveLaneRouteId({                    // :367-376
       lane,
       taskType: defaultLaneTaskType(spec.mode),
       profile: context.apiConfiguration,
       route: spec.route,
       parentModelId,                      // = parent.apiConfiguration.openAiModelId (:357) = "hybrid/planner"
       coderOrdinal: coderOrdinalByName.get(spec.name),
       codeCapableRouteIds,
   })
   ```
   `resolveWorkerModelId` is **never called** from production code — a grep for
   `resolveWorkerModelId` across `src/**/*.ts` returns only its definition in
   `parallelWorkerRouting.ts` and its unit test. So the own-profile-model fix the
   brief credits (step 2 of `resolveWorkerModelId`,
   `parallelWorkerRouting.ts:68-73`) is effectively dead code for the live path.

2. **The worker's context DOES carry the correct profile.** With
   `preferSavedModeProfile=true`, `getTaskHandoffContext`
   (`src/core/webview/ClineProvider.ts:3645-3685`) loads the mode-mapped saved
   profile via `providerSettingsManager.getModeConfigId("project-reader")` →
   `omni-hybrid-reader`, strips `name`/`id`, and hands it to
   `selectHandoffExecutionContext`. That selector
   (`src/core/task/providerHandoff.ts:14-39`) returns the saved profile's
   `apiConfiguration` when `savedModeProfile?.apiConfiguration.apiProvider` is set
   (confirmed by `providerHandoff.spec.ts:70-89`, "uses the saved Code profile for
   a parallel worker even when its parent is in Code mode"). So at line 367
   `context.apiConfiguration.openAiModelId` is genuinely `"hybrid/reader"` and
   `context.apiConfiguration.openAiOmniRouteReaderRouteId` is `null` — exactly the
   OmniRoute-Hybrid-Reader profile described in the brief.

3. **`resolveLaneRouteId` discards the correct own-model and falls to parent.**
   For a `project-reader`, `assignLanes` assigns the default lane `reader.fast`
   (`parallelWorkerRouting.ts` `DEFAULT_READER_LANE`), so `resolveLaneRouteId`
   enters the reader branch:
   ```ts
   case "reader.fast":
   case "reader.deep":
       return profile.openAiOmniRouteReaderRouteId ?? parentModelId
   ```
   `openAiOmniRouteReaderRouteId` is `null` → returns `parentModelId` =
   `"hybrid/planner"`. The worker's own `openAiModelId` (`"hybrid/reader"`) is
   sitting right there on `profile` but is never consulted. Net: a reader worker
   dispatches `hybrid/planner`, matching the live evidence (13× `hybrid/planner`,
   0× `hybrid/reader` in the worker task record; 120 planner combos / 0 reader at
   OmniRoute).

4. **Same defect for every lane's parent fallback.** `coder.primary`
   (`openAiOmniRouteReasonerRouteId ?? codeCapableRouteIds[0] ?? parentModelId`)
   and `reasoning.escalation` (`openAiOmniRouteReasonerRouteId ?? parentModelId`)
   have the identical hole: when the role route id is unset, they fall to
   `parentModelId` and ignore the worker's own profile model. Any worker whose
   profile sets `openAiModelId` but leaves the role route fields null inherits the
   planner.

**Why the hypothesis pointed at the wrong function:** a later feature
(parallel-capacity-routing / capability-lanes-routing) introduced the lane
dimension and `resolveLaneRouteId`, and the live call site was switched from
`resolveWorkerModelId` to `resolveLaneRouteId`. The own-profile-model guard was
added to `resolveWorkerModelId` (and its tests pass) but never ported to the
function that actually runs.

## Chosen fix — Option A, applied to the live resolver (`resolveLaneRouteId`)

Add the own-saved-profile-model step to `resolveLaneRouteId`, mirroring the
existing step 2 of `resolveWorkerModelId`: whenever a lane resolution would
otherwise fall back to `parentModelId`, first prefer the worker's own
`profile.openAiModelId` when it is set and differs from `parentModelId`.

Why this approach:
- It is minimal and sits exactly where the bug is (the function the live path
  calls), not in dead code.
- It is consistent with how child profiles are loaded: the worker already carries
  its correct mode-mapped profile (`hybrid/reader`) on `profile.openAiModelId`
  (chain step 2). Honoring that value is the direct, truthful fix — no new profile
  lookup, no scheduler/capacity change.
- It preserves every existing precedence rule: an explicit `route` still wins
  first; a configured role route id (reader/reasoner) still wins over the own
  model; the code-route spread still round-robins when `codeCapableRouteIds` has
  >1 entry; `parentModelId` remains the true last resort. A reader can never land
  on planner, because its own `hybrid/reader` is preferred before `parentModelId`.
- It matches the design doc's stated intent (§5.2:
  `spec.route ?? roleDefault(spec.mode) ?? parent.openAiModelId`) while adding the
  own-model tier the two-field profile needs when role route ids are null.

Rejected alternative (brief's Option B, "make roleDefault robust"): `roleDefault`
is not on the live path (`resolveLaneRouteId` reads the route-id fields directly),
so patching it would not fix the live bug. Rejected also: changing the profile
load in `getTaskHandoffContext` — the profile is already correct; only the
resolver drops it.

### Exact edit

Introduce a single helper inside `resolveLaneRouteId` that resolves the fallback
preferring the own model, and use it at every `?? parentModelId` site in that
function.

- File: `src/core/task/parallelWorkerRouting.ts`
- Function: `resolveLaneRouteId` (and only that function)
- Shape of change (semantics, not final text):
  - Compute `const ownModelFallback = profile.openAiModelId && profile.openAiModelId !== parentModelId ? profile.openAiModelId : parentModelId`.
  - `reader.fast` / `reader.deep`: `return profile.openAiOmniRouteReaderRouteId ?? ownModelFallback`.
  - `coder.primary` single-id branch: `return profile.openAiOmniRouteReasonerRouteId ?? codeCapableRouteIds[0] ?? ownModelFallback`.
    (The multi-id round-robin branch is unchanged — a configured spread still
    wins; it never reaches the fallback.)
  - `reasoning.escalation`: `return profile.openAiOmniRouteReasonerRouteId ?? ownModelFallback`.
  - The explicit-`route` short-circuit at the top is unchanged.
- Update the function's JSDoc to document the own-model tier so the precedence
  comment stays truthful.

This leaves `resolveWorkerModelId`, `roleDefault`, `assignLane(s)`,
`collectCodeCapableRouteIds`, and the call site in `runParallelTasks.ts`
untouched. DO-NOT-CHANGE items (timeout 1800s, routeCapacityMap/scheduler, 64k
reader cap, lifecycle reducers, OmniRoute/nix config) are not involved.

## Plan items

- [ ] 1. Add the own-saved-profile-model fallback to `resolveLaneRouteId`.
      Prefer `profile.openAiModelId` (when set and != `parentModelId`) over
      `parentModelId` at every lane fallback in `resolveLaneRouteId`: the
      `reader.fast`/`reader.deep` branch, the `coder.primary` single-id branch,
      and the `reasoning.escalation` branch. Leave the explicit-`route`
      short-circuit and the `coder.primary` multi-id round-robin unchanged. Update
      the JSDoc precedence comment to describe the own-model tier.
      Files: `src/core/task/parallelWorkerRouting.ts`
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts` — all existing tests still pass (no regression to the spread or to configured role routes).

- [ ] 2. Add regression tests pinning the fix in `resolveLaneRouteId`.
      In the `resolveLaneRouteId` describe block, add cases: (a) a `reader.fast`
      worker with `openAiModelId:"hybrid/reader"`, `openAiOmniRouteReaderRouteId`
      unset (null), `parentModelId:"hybrid/planner"` → resolves to `"hybrid/reader"`
      (the exact live-bug scenario); (b) same but reader route id IS set → still
      returns the reader route id (configured role route wins over own model);
      (c) an explicit `route` still overrides the own model for a reader;
      (d) a `coder.primary` single-id worker with own `openAiModelId:"hybrid/code"`,
      reasoner route unset, no code-capable ids → resolves to `"hybrid/code"`, not
      the parent planner; (e) `reasoning.escalation` with own model and unset
      reasoner route → own model, not parent; (f) when own `openAiModelId` equals
      `parentModelId` and no role route is set, the result is still `parentModelId`
      (no spurious change). Follow the existing `profile()` helper and
      `resolveLaneRouteId({ ...base, ... })` pattern in the file.
      Files: `src/core/task/__tests__/parallelWorkerRouting.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts` — new tests pass; case (a) fails before the item-1 edit and passes after (prove the regression is captured).

- [ ] 3. Lint the touched files and confirm suppressions did not increase.
      Files: `src/core/task/parallelWorkerRouting.ts`, `src/core/task/__tests__/parallelWorkerRouting.spec.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/parallelWorkerRouting.ts core/task/__tests__/parallelWorkerRouting.spec.ts` — zero warnings; suppression counts for both files unchanged or lower.

- [ ] 4. Type-check the package.
      Files: (none — verification only)
      Verify: `pnpm --dir src exec tsc --noEmit` — no new type errors.

## Notes / assumptions

- Scope is purely worker model-id resolution in `resolveLaneRouteId`. The
  profile-load path (`getTaskHandoffContext` → `selectHandoffExecutionContext`) is
  already correct and is not touched.
- `resolveWorkerModelId` is left as-is (dead on the live path but still unit
  tested); removing it is out of scope for this bug fix.
- The brief's `review.json` stop contract (jsonPath `verdict` == "APPROVED") is
  honored by the existing workflow loop that consumes this plan; the reviewer
  writes that file.

## Verification note (first iteration)

Fix applied to `resolveLaneRouteId` in `src/core/task/parallelWorkerRouting.ts`
(the function the live path in `runParallelTasks.ts` actually calls), per Option
A of the plan. A single `ownModelFallback` tier (`profile.openAiModelId` when set
and != `parentModelId`, else `parentModelId`) now backs every `?? parentModelId`
site: the `reader.fast`/`reader.deep` branch, the `coder.primary` single-id
branch, and the `reasoning.escalation` branch. The explicit-`route` short-circuit
and the `coder.primary` multi-id round-robin are unchanged. The JSDoc now
documents the own-model tier and the parent-planner-inheritance trap it closes.

Commands run (from repo root):

- `pnpm --dir src exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts`
  → 34 passed.
- `pnpm --dir src exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts`
  → 43 passed (no spread/capacity regression).
- `pnpm --dir src check-types` (tsc --noEmit) → no errors.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/parallelWorkerRouting.ts core/task/__tests__/parallelWorkerRouting.spec.ts`
  → zero warnings, suppression counts unchanged.

Fails-before / passes-after (regression proof): with the reader branch
temporarily reverted to `?? parentModelId`, the new regression test
"resolves a reader to its own hybrid/reader, NOT the inherited parent planner"
FAILED (`expected 'hybrid/planner' to be 'hybrid/reader'`). After restoring the
`?? ownModelFallback` fix, it PASSES. This pins the exact live bug: a
`project-reader` whose child context inherited `openAiModelId = "hybrid/planner"`
with a null reader route now resolves to `hybrid/reader`, not the planner.
