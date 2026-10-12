# Verification — worker-model-inheritance (parent-planner-inheritance trap)

Full post-approval verification of the model-routing fix committed as
`b0a986cdb` — "fix: resolve parallel workers to their own profile model, not
parent planner". Verifier made no product changes; the only source touch was a
temporary, fully-restored revert used to demonstrate the regression test's
fail-before state (see §2).

Repository: `/Users/celes/sources/celesrenata/menagerie`
Branch: `main`, HEAD `b0a986cdb` (1 commit ahead of `origin/main`).

---

## 1. Confirmed root-cause chain (file:line)

The live caller `runParallelTasks` stamps each worker's child context model by
calling the pure resolver `resolveLaneRouteId` once per worker, passing
`profile: context.apiConfiguration` (the worker's own mode-mapped handoff
context) and `parentModelId` from the parent orchestrator's config.

The trap, pre-fix, in `src/core/task/parallelWorkerRouting.ts`:

- The reader lane branch resolved
  `profile.openAiOmniRouteReaderRouteId ?? parentModelId`
  (`reader.fast` / `reader.deep`, now lines **303–305**).
- A `project-reader` worker's child context carries its saved profile model
  `openAiModelId: "hybrid/reader"` but inherits the orchestrator's
  `openAiModelId = "hybrid/planner"` as `parentModelId`, and its
  `openAiOmniRouteReaderRouteId` is **null**.
- With the role route id null, the `?? parentModelId` fallback fired and
  resolved the reader to `"hybrid/planner"` — so **all reader inference was
  routed to the planner lane**, and the reader/code backends never ran. This
  matches the user-observed symptom: "choosing the hybrid reader class, but I
  don't see it actually calling any new models" / "only hitting glm".
- The same `?? parentModelId` leak existed on two other null-role-route
  branches: the single-id `coder.primary` tail (now line **317**) and
  `reasoning.escalation` (now line **326**).

## 2. Chosen fix approach and why

An **own-saved-profile-model fallback tier** inserted between the lane role
route id and the parent model id. Computed once above the lane switch
(`src/core/task/parallelWorkerRouting.ts:298–299`):

```ts
const ownModelFallback =
    profile.openAiModelId && profile.openAiModelId !== parentModelId ? profile.openAiModelId : parentModelId
```

and substituted for the bare `parentModelId` at exactly the three branches that
previously leaked the parent model:

- `reader.fast` / `reader.deep` — line 305: `?? ownModelFallback`
- single-id `coder.primary` tail — line 317: `?? codeCapableRouteIds[0] ?? ownModelFallback`
- `reasoning.escalation` — line 326: `?? ownModelFallback`

New resolution precedence:
explicit `route` → lane role route id → **worker's own `profile.openAiModelId`
(new tier)** → `parentModelId`.

Why this approach:
- Minimal and scoped to the pure resolver; the live caller is unchanged.
- The `profile.openAiModelId !== parentModelId` guard means the new tier only
  diverges when the worker's own model is genuinely distinct from the parent.
  When equal or unset, the expression collapses to `parentModelId` and
  pre-fix single-model behavior is preserved — the parent stays a true last
  resort.
- The explicit per-worker `route` short-circuit (line 291) and the multi-id
  `coder.primary` round-robin (lines 306–316, which returns before the `??`
  tail) are untouched, so explicit routing and backend spread are preserved.

## 3. Regression test — fail-before / pass-after

Test: `src/core/task/__tests__/parallelWorkerRouting.spec.ts`, describe block
`own-saved-profile-model fallback (parent-planner-inheritance trap)` (6 cases),
primary case: *"resolves a reader to its own hybrid/reader, NOT the inherited
parent planner"* — seeds `profile.openAiModelId: "hybrid/reader"`, null reader
route, `parentModelId: "hybrid/planner"`; asserts `"hybrid/reader"`.

Demonstrated live during this verification (temporary source revert of the
reader branch to `?? parentModelId`, run, then restored — `git diff --stat`
confirmed the file was byte-identical afterward):

- **Fail-before** (reader branch reverted to `?? parentModelId`):
  ```
  FAIL  core/task/__tests__/parallelWorkerRouting.spec.ts > ... > resolves a reader to its own hybrid/reader, NOT the inherited parent planner
  AssertionError: expected 'hybrid/planner' to be 'hybrid/reader' // Object.is equality
    Expected: "hybrid/reader"
    Received: "hybrid/planner"
   ❯ core/task/__tests__/parallelWorkerRouting.spec.ts:300:6
  Test Files  1 failed (1)
       Tests  1 failed | 33 skipped (34)
  ```
- **Pass-after** (fix restored):
  ```
  Test Files  1 passed (1)
       Tests  1 passed | 33 skipped (34)
  ```

This is a genuine regression lock and matches the revert-proof note recorded in
the implementation commit `b0a986cdb`.

---

## 4. Command outputs with exit codes

Note on exit codes: commands were run via zsh; `pnpm` emits a harmless
`Unsupported engine` WARN (Node v24 vs wanted 22.23.1) that does not affect any
exit code.

### 4.1 `check-types` — EXIT 0

```
$ pnpm --dir /Users/celes/sources/celesrenata/menagerie/src check-types
> zoo-code@3.84.4 check-types
> tsc --noEmit
EXIT_CODE=0
```
No type errors.

### 4.2 Focused Vitest — EXIT 0

Combined run (parallelWorkerRouting + runParallelTasks.capacity):
```
$ pnpm exec vitest run core/task/__tests__/parallelWorkerRouting.spec.ts core/task/__tests__/runParallelTasks.capacity.spec.ts
 Test Files  2 passed (2)
      Tests  43 passed (43)
```
Split:
- `parallelWorkerRouting.spec.ts` — **34 passed** (1 file passed).
- `runParallelTasks.capacity.spec.ts` — remaining **9 passed** (34 + 9 = 43).

Note on the "runParallelTasks child-context spec": the only runParallelTasks
spec present in `src` is `runParallelTasks.capacity.spec.ts`. The worker
child-context model-stamping behavior is covered at its lowest layer by the pure
`parallelWorkerRouting.spec.ts` resolver tests (the live caller stamps
`context.apiConfiguration.openAiModelId` with this resolver's return value); no
dedicated runParallelTasks child-context spec exists.

Fail-before / pass-after of the new regression test: see §3 (captured live).

### 4.3 ESLint `--prune-suppressions --max-warnings=0` — EXIT 0

```
$ pnpm exec eslint --prune-suppressions --max-warnings=0 \
    core/task/parallelWorkerRouting.ts \
    core/task/__tests__/parallelWorkerRouting.spec.ts
(no output)
ESLINT_EXIT=0
```
- Clean, zero warnings/errors on both edited files.
- `git status` on `src/eslint-suppressions.json` after the prune: **no change**
  (suppression counts unchanged / not increased).
- New code audit: **no `as any`**, **no `as unknown as`** in either file.
- No floating promises: `resolveLaneRouteId` and the added `ownModelFallback`
  constant are pure synchronous code with no promises.
- No `.changeset`, no `CHANGELOG.md` / `src/CHANGELOG.md` edits — confirmed both
  in working tree (`git status`) and in commit `b0a986cdb`
  (`git show --name-only` → no changeset/changelog/suppression files).

Files in commit `b0a986cdb`:
```
.agents/tasks/worker-model-inheritance/plan.md
src/core/task/__tests__/parallelWorkerRouting.spec.ts
src/core/task/parallelWorkerRouting.ts
```

### 4.4 `bundle` — EXIT 0

```
$ pnpm --dir /Users/celes/sources/celesrenata/menagerie/src bundle
> zoo-code@3.84.4 bundle
> node esbuild.mjs
[extension] Cleaning dist directory: .../src/dist
[esbuild-problem-matcher#onStart]
[copyPaths] Copied ../README.md to README.md
...
[copyLocales] Copied 126 locale files to .../src/dist/i18n/locales
[esbuild-problem-matcher#onEnd]
BUNDLE_EXIT=0
```
Bundle built cleanly — no esbuild problems reported between `onStart` and
`onEnd`.

---

## Summary

| Step | Command | Result |
|------|---------|--------|
| 1 | `check-types` (`tsc --noEmit`) | **PASS** — exit 0, no errors |
| 2 | Vitest `parallelWorkerRouting` + `runParallelTasks.capacity` | **PASS** — 43/43 (34 + 9); regression test fails-before (`hybrid/planner` vs `hybrid/reader`), passes-after |
| 3 | ESLint `--prune-suppressions --max-warnings=0` on both edited files | **PASS** — exit 0, counts unchanged, no `as any`/floating promises, no changeset/CHANGELOG edits |
| 4 | `bundle` (`esbuild.mjs`) | **PASS** — exit 0, built cleanly |

No verification-caused build break; no product changes made.
