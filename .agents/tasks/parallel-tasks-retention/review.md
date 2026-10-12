# Bound parallel-tasks cache growth and fail-closed vsix packaging

Two independent fixes. FIX 1 adds cache management for the `parallel-tasks` batch store: a new retention module defines the age/count bounds in one place, prunes aged and overflow batch dirs before each new batch is created, and age-bounds the interrupted-batch recovery so an ancient batch can't resurface. FIX 2 disables turbo caching on the `vsix` task so packaging can never serve a `.vsix` built from a stale `dist`. Both are minimal, additive changes; no schema, worker format, or build-system restructuring. Watch for: nothing blocking — the active-batch exclusion relies on prune-before-create ordering (confirmed) rather than an explicit exclusion filter, which is the one design subtlety worth understanding.

**Verdict**: APPROVED

## High-level view

The retention bounds (`MAX_BATCH_AGE_MS = 7 days`, `MAX_BATCH_COUNT = 50`) live in `parallelTaskRetention.ts` as the single source of truth. Both the prune sweep and the recovery age bound import them, so the window is defined once. The recovery module imports the age constant aliased rather than duplicating the literal.

The active batch is protected from deletion by ordering, not by filtering: `runParallelTasks` awaits the prune at the top of the function body, before the new `batchId` directory exists on disk. The sweep therefore only ever sees already-persisted batches, and the active batch cannot be a deletion target. This is documented in a comment at the call site and exercised by a test that models the ordering.

The prune is fail-safe: a missing storage root resolves to `{ removed: [], kept: 0 }`, and per-dir stat/delete failures are swallowed with a `[ParallelTaskRetention]` `console.warn` so one bad entry never aborts the sweep. Because the call is awaited and the function never throws, a prune failure cannot break a batch run.

FIX 2 traces the vsix flow (`turbo vsix` → `src` `vsix` script → `vsce package`, with `vscode:prepublish` → `pnpm bundle --production` cleaning `dist/` first). The stale-vsix symptom is explained by turbo's `vsix` task being cacheable: it could restore a cached `../bin/*.vsix` and skip re-running vsce. Setting `"cache": false` forces vsce to run every time, and the existing clean-bundle prepublish guarantees the packaged `dist` is current.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. Both fixes meet their acceptance criteria and the verification evidence is complete.

</details>

<details>
<summary>Details</summary>

## Retention bounds as a single source of truth

`parallelTaskRetention.ts` exports `MAX_BATCH_AGE_MS` (7 days as `7 * 24 * 60 * 60 * 1000`) and `MAX_BATCH_COUNT` (50) alongside `pruneParallelTaskBatches(storageRoot, now?)`. The recovery module imports `MAX_BATCH_AGE_MS` aliased as `MAX_RECOVERABLE_BATCH_AGE_MS` rather than re-declaring the number, so the age window exists in exactly one place — satisfying the "does NOT duplicate the literal" requirement.

Age is resolved per batch from `manifest.json` mtime, falling back to the directory's own mtime when the manifest can't be statted. The prune runs two passes: delete anything past the age bound, then if survivors still exceed the count cap, sort oldest-first and evict down to 50. Eviction is by age and count only — patch contents are never inspected, consistent with the "purely additive cache management" scope.

## Active-batch exclusion by ordering

The one design subtlety: nothing in the prune explicitly excludes the active batch. Instead, `runParallelTasks` awaits `pruneParallelTaskBatches(provider.context.globalStorageUri.fsPath)` at the top of the function body, before `const batchId = crypto.randomUUID()` and the `directory` creation. Since the new dir doesn't exist on disk when the sweep runs, it cannot be a deletion target. (confirmed — read the diff ordering at `runParallelTasks.ts`; the prune precedes `batchId`/`directory` creation.)

The retention spec covers this with a test that prunes first, then creates `active-batch`, and asserts the new dir survives. (confirmed)

## Fail-safe prune

A missing `parallel-tasks` root (or storage root) returns `{ removed: [], kept: 0 }` instead of throwing — the batch run proceeds on first-ever use. Per-dir failures during stat, aged-delete, or over-cap eviction are caught individually, logged with the `[ParallelTaskRetention]` prefix, and the loop continues; a dir that fails its aged-delete is retained as a survivor rather than silently dropped. The call in `runParallelTasks` is awaited (no floating promise, per AGENTS.md), and because the function never rejects, the await cannot break the run. (confirmed — error handling read in `parallelTaskRetention.ts`; resilience tested via missing-root and dangling-symlink cases.)

## Recovery preserves prior behavior under the new age bound

`getInterruptedParallelBatchSummary` adds a single `.filter((batch) => batch.modified >= Date.now() - MAX_RECOVERABLE_BATCH_AGE_MS)` before the newest-batch selection. Everything else is intact: the `parentTaskId` match, the non-"completed" worker filter, the once-per-session `surfacedBatches` guard, and the exact `# Recoverable Parallel Work` message text. (confirmed — read the full recovery module; only the age filter was inserted into the selection chain.) Placing the age bound before selection means an ancient interrupted batch can't shadow a recent one, which was the stated goal.

## Packaging fail-closed via turbo cache disable

The vsix path resolves to `turbo vsix` → `src/package.json` `vsix` (`vsce package --no-dependencies --out ../bin`), with `vscode:prepublish` running `pnpm bundle --production`. `esbuild.mjs` cleans `dist/` before building (confirmed at `esbuild.mjs` lines 63-66, `removeDirWithRetries(distDir)`), so prepublish always yields a fresh bundle. The stale-vsix path was turbo's `vsix` task being cacheable with `outputs: ["../bin/**"]`: turbo could restore a cached `.vsix` and skip vsce entirely, shipping a package whose `dist` predates current source. Adding `"cache": false` (keeping `dependsOn`/`inputs`/`outputs`) forces vsce to run on every `pnpm vsix`. The diagnosis matches the reported stale-install symptom and the fix is one line. (confirmed)

## Test coverage

Retention spec (6 tests): age prune (old removed, recent kept), manifest-missing dir-mtime fallback, count cap (60 → 50 survive, 10 oldest removed, newest kept), active-batch exclusion by ordering, missing-root resolves without throw, and per-dir stat failure (dangling symlink) swallowed while a valid aged dir is still removed. Recovery spec adds two: too-old interrupted batch → `undefined`, recent matching → reminder. The age-bound tests use unique `parentTaskId`s to avoid the module-level `surfacedBatches` set leaking across tests. (confirmed — both spec files read in full.)

Not tested: FIX 2's turbo cache behavior has no automated test, which is appropriate — it's a build-config change verified by reasoning about turbo's cache semantics, not something a unit test can assert without invoking the packager.

## Verification evidence

`verification.md` records: `check-types` exit 0; focused Vitest run of both spec files → 2 files, 10 tests passed; ESLint with `--prune-suppressions --max-warnings=0` exit 0 with `eslint-suppressions.json` unchanged (confirmed — not in the diff name-only list); `pnpm bundle` exit 0; and `grep -c` for `pruneParallelTaskBatches|MAX_BATCH_AGE_MS` in `src/dist/extension.js` = 6. I re-ran that grep independently and got 6, confirming the new code is in the shipped bundle. (confirmed)

</details>

<details>
<summary>File map</summary>

- `src/core/task/parallelTaskRetention.ts` — new: retention constants + `pruneParallelTaskBatches`.
- `src/core/task/__tests__/parallelTaskRetention.spec.ts` — new: 6 prune tests.
- `src/core/task/runParallelTasks.ts` — prune-before-create at top of `runParallelTasks`, awaited.
- `src/core/task/parallelTaskRecovery.ts` — import shared age bound, filter candidates before newest selection.
- `src/core/task/__tests__/parallelTaskRecovery.spec.ts` — 2 added age-bound tests.
- `src/turbo.json` — `vsix` task `"cache": false`.
- `.agents/tasks/parallel-tasks-retention/verification.md` — coder's verification record.

Full diff: `git diff origin/main..HEAD`

</details>
