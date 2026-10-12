# Parallel worker resolves to its own profile model, not the parent planner

`resolveLaneRouteId` — the pure resolver that `runParallelTasks` calls once per worker to stamp `context.apiConfiguration.openAiModelId` — fell through to `parentModelId` whenever a lane's role route id was null. Because each worker's child context is seeded with its mode-mapped saved profile but inherits the orchestrator's `openAiModelId = "hybrid/planner"` as `parentModelId`, a project-reader with a null `openAiOmniRouteReaderRouteId` sent all reader inference to the planner lane. The fix inserts an own-saved-profile-model tier: before falling to the parent, prefer `profile.openAiModelId` when it is set and differs from the parent. Applied at the reader, single-id coder, and reasoning.escalation fallbacks; the explicit-route short-circuit and the multi-id coder round-robin are untouched.

Watch for: nothing blocking. The resolver change is minimal, the live caller passes the worker's own child profile (confirmed), and the regression test reproduces the exact live condition. (confidence: confirmed)

**Verdict**: APPROVED

## High-level view

The resolution precedence is now: explicit `route` → lane role route id → the worker's own `profile.openAiModelId` (new tier) → `parentModelId`. The new tier is computed once as `ownModelFallback` and substituted for the bare `parentModelId` at exactly the three branches where a null role route previously leaked the parent model: `reader.fast`/`reader.deep`, the single-id `coder.primary` tail, and `reasoning.escalation`. The multi-id coder round-robin never touched `parentModelId` and is unchanged, so the spread behavior is preserved.

The own-model tier is guarded by `profile.openAiModelId !== parentModelId`, so when a worker's own model genuinely equals the parent (or is unset) the behavior collapses back to the pre-fix single-model fallback. This keeps the parent as a true last resort rather than overriding it unconditionally.

The orchestrator is unaffected: `resolveLaneRouteId` runs only inside the per-worker loop in `runParallelTasks`; the parent task is never routed through it. The live caller passes `profile: context.apiConfiguration` (the child's own handoff context) and `parentModelId` from the parent's config, which is precisely the inheritance condition the fix targets.

The regression test seeds `openAiModelId: "hybrid/reader"` with a null reader route and `parentModelId: "hybrid/planner"` and asserts `"hybrid/reader"`. On the old `?? parentModelId` branch this resolved to `hybrid/planner`, so the test fails pre-fix and passes post-fix — a genuine regression lock, corroborated by the commit's revert-proof note. Companion cases pin that a configured reader route still wins, an explicit per-worker route still wins, and the own-equals-parent case still falls to the parent.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. The change is scoped to the resolver, its regression test, and the task plan; no forbidden areas were touched.

</details>

<details>
<summary>Details</summary>

### The own-model fallback tier and its guard

The fix hoists a single `ownModelFallback` constant above the lane switch:

```ts
const ownModelFallback =
	profile.openAiModelId && profile.openAiModelId !== parentModelId ? profile.openAiModelId : parentModelId
```

and substitutes it for `parentModelId` at the three branches that previously ended in `?? parentModelId`: the reader lane, the single-id coder tail (`?? codeCapableRouteIds[0] ?? ownModelFallback`), and reasoning.escalation. The `!== parentModelId` guard is the important part — it means the new tier only diverges from prior behavior when the worker's own model is distinct from the parent. When they are equal, or `openAiModelId` is unset, the expression yields `parentModelId` and the function behaves exactly as before. This is what keeps the parent a genuine last resort and prevents a worker from "overriding" with a value identical to the parent (which would be a no-op anyway but is explicitly excluded).

Ordering relative to the role route id: `profile.openAiOmniRouteReaderRouteId ?? ownModelFallback` keeps a configured reader route ahead of the own model (an explicit lane route is a stronger signal than the generic profile model), and the explicit per-worker `route` short-circuits before `ownModelFallback` is consulted, so it still wins unconditionally.

The multi-id coder round-robin (`codeCapableRouteIds.length > 1`) returns before reaching the `?? ownModelFallback` tail, so only the single-id / none-configured coder path gains the own-model fallback — the spread is unaffected.

### Live-condition fidelity of the regression test

`runParallelTasks` resolves `parentModelId = parent.apiConfiguration.openAiModelId` and calls the resolver with `profile: context.apiConfiguration` where `context` is the per-worker handoff context. That child context carries the mode-mapped saved profile but inherits the parent's `openAiModelId` as the parent dimension — exactly the setup the regression test encodes with `profile({ openAiModelId: "hybrid/reader" })` + null reader route + `parentModelId: "hybrid/planner"`. The resolver under test is the same pure function on the live path, so the test is a faithful reproduction rather than a mock approximation.

The companion cases cover the precedence corners that matter: configured reader route id still wins (`"9b"`), explicit `route` still wins (`"explicit-id"`), a coder with no code-capable ids resolves to its own `hybrid/code`, reasoning.escalation resolves to its own `hybrid/reasoner`, and the own-equals-parent case correctly falls to `hybrid/planner`. The last case is the one that proves the guard is doing its job rather than blindly preferring the profile model.

### Scope and forbidden areas

The commit touches three files: `parallelWorkerRouting.ts`, its spec, and `.agents/tasks/worker-model-inheritance/plan.md`. No timeout config, no `routeCapacityMap`/scheduler, no 64k reader cap, no lifecycle reducers, no OmniRoute/nix config, and no `.changeset`/CHANGELOG edits. Verification evidence (check-types, focused Vitest 34→43 passed, eslint with unchanged suppression counts, and a revert-proof regression demonstration) is recorded in the commit message; no re-run was warranted.

</details>

<details>
<summary>File map</summary>

- `src/core/task/parallelWorkerRouting.ts` — adds the `ownModelFallback` tier and substitutes it for the bare `parentModelId` at the reader, single-id coder, and reasoning.escalation fallbacks; JSDoc documents the parent-planner-inheritance trap.
- `src/core/task/__tests__/parallelWorkerRouting.spec.ts` — adds the `own-saved-profile-model fallback` describe block with six cases, including the exact live-bug reproduction and the own-equals-parent guard case.
- `.agents/tasks/worker-model-inheritance/plan.md` — task plan/notes.

Full diff: `git show b0a986cdb`.

</details>
