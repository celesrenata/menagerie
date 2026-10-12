# Implementation Plan — Parallel-tasks cache retention + fail-closed packaging

Two app-level fixes in the Menagerie VS Code extension (repo root `/Users/celes/sources/celesrenata/menagerie`). Work directly in the repo, no worktree. After the FIX 1 code changes, rebuild the bundle (`pnpm --dir src bundle`) — a stale bundle has repeatedly masked fixes, so building is part of done.

## Design decisions (grounded in the code I read)

- **Retention lives in a new standalone module** `src/core/task/parallelTaskRetention.ts`, not inside `runParallelTasks.ts`. Rationale: `parallelTaskRecovery.ts` must import the age constant to avoid duplicating the literal (FIX 1-D), and a separate module gives both consumers one source of truth plus an independently testable surface. This mirrors the existing split where `parallelTaskRecovery.ts` is its own file.
- **Prune runs at the very top of `runParallelTasks`, before `const directory = ...`.** Rationale: the task spec requires the active batch to never be a deletion target. Since prune only deletes dirs that already exist and the new `batchId` dir has not been created yet (it is created later by `snapshotWorkingTree` via `fs.mkdir(storage, {recursive:true})` — confirmed in `ParallelTaskWorkspace.ts:8`), running prune first guarantees the active batch is excluded by construction. This ordering is awaited (not fire-and-forget) to satisfy the no-floating-promise rule in AGENTS.md.
- **Age filter is applied before "latest" selection in recovery.** Rationale: `getInterruptedParallelBatchSummary` sorts candidates by manifest mtime desc and takes `[0]`. If an ancient batch is the newest matching one, filtering too-old batches out of the candidate list (before the sort/pick) is what actually prevents the ancient reminder; filtering after picking would just drop the result without surfacing a valid recent one. The task requires both: skip too-old, still surface a recent matching batch.
- **Prune is resilient and never throws.** Per-dir failures are accumulated and swallowed with a `console.warn("[ParallelTaskRetention] ...")`; a missing storage root resolves to `{ removed: [], kept: 0 }`. Rationale: cache management must never break a user's batch run.
- **FIX 2 is a turbo-cache fail-closed change (see item 7 for the exact script path and decision).**

## FIX 1 — Cache retention + age-bounded recovery

- [ ] 1. Create the retention module with exported constants and `pruneParallelTaskBatches`.
      Create `src/core/task/parallelTaskRetention.ts`. Export `const MAX_BATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000` and `const MAX_BATCH_COUNT = 50`. Export `async function pruneParallelTaskBatches(storageRoot: string, now: number = Date.now()): Promise<{ removed: string[]; kept: number }>`.
      Behavior: resolve `root = path.join(storageRoot, "parallel-tasks")`; `fs.readdir(root)` in a try/catch that returns `{ removed: [], kept: 0 }` if the root is missing. For each entry, stat `manifest.json` mtime (fallback to the dir's own mtime if the manifest stat fails) to compute age against `now`. Delete any dir older than `MAX_BATCH_AGE_MS` via `fs.rm(dir, { recursive: true, force: true })`, pushing its name to `removed`. Then, if the surviving count still exceeds `MAX_BATCH_COUNT`, sort survivors oldest-first by the same mtime and delete oldest down to the cap, appending to `removed`. Wrap every per-dir delete/stat in try/catch: accumulate the failure, `console.warn` with the `[ParallelTaskRetention]` prefix, and continue the sweep (never abort, never throw). Return `{ removed, kept }` where `kept` is the final surviving dir count. Use `node:fs/promises` and `node:path` imports matching `parallelTaskRecovery.ts`. No `as any`; type the stat results via the fs promises API.
      Files: `src/core/task/parallelTaskRetention.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` compiles clean; the unit tests in item 4 drive behavior.

- [ ] 2. Wire the prune into `runParallelTasks` before the batch directory is created.
      In `src/core/task/runParallelTasks.ts`, inside `runParallelTasks` (~line 302, right after the function opens and BEFORE `const batchId = crypto.randomUUID()` / `const directory = ...` at ~line 305), `await pruneParallelTaskBatches(provider.context.globalStorageUri.fsPath)`. Add an import for `pruneParallelTaskBatches` near the existing `./parallelTaskRecovery`-adjacent imports (the file already imports from `./normalizeWorkerResult`, `./ParallelTaskReader`, `./ParallelTaskWorkspace` ~lines 22-23). Add a comment documenting the ordering: prune runs before `directory` is created so the active batch dir does not yet exist and can never be a deletion target. Await it (no `void`, no floating promise) per AGENTS.md.
      Files: `src/core/task/runParallelTasks.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` compiles; existing parallel-task tests still pass (item 4 adds the ordering test).

- [ ] 3. Age-bound the recovery reminder, reusing the retention constant.
      In `src/core/task/parallelTaskRecovery.ts`, import `MAX_BATCH_AGE_MS` from `./parallelTaskRetention` and alias it locally as `MAX_RECOVERABLE_BATCH_AGE_MS` (do not duplicate the literal). In `getInterruptedParallelBatchSummary`, after building the `batches` array and before `const latest = ...`, filter out any batch whose `modified` mtime is older than `Date.now() - MAX_RECOVERABLE_BATCH_AGE_MS`. Keep every other behavior unchanged: `parentTaskId` match, non-"completed" worker filter, the once-per-session `surfacedBatches` guard, and the exact `# Recoverable Parallel Work` message text. The filter must happen before the sort/`[0]` pick so a too-old newest batch does not shadow a recent valid one.
      Files: `src/core/task/parallelTaskRecovery.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` compiles; item 4 adds the age-bound recovery test. The call site `src/core/environment/getEnvironmentDetails.ts:180` is unchanged (signature is unchanged).

- [ ] 4. Add package-local unit tests for retention and recovery age-bound.
      Create `src/core/task/__tests__/parallelTaskRetention.spec.ts` following the real-tmpdir pattern in the existing `src/core/task/__tests__/parallelTaskRecovery.spec.ts` (`fs.mkdtemp(path.join(os.tmpdir(), ...))` in `beforeEach`, `fs.rm` cleanup in `afterEach`). Use real dirs and `fs.utimes(dir/manifest, atime, mtime)` to set ages; do NOT use `src/test-utils/fs.ts` (it only mocks fs and cannot exercise real mtimes). Cover:
        - Age prune: a dir with manifest mtime older than `MAX_BATCH_AGE_MS` is removed; a recent dir is kept (assert on returned `removed`/`kept` and on `fs.readdir`).
        - Count cap: create >50 recent dirs with staggered mtimes; after prune, exactly 50 survive, the oldest are in `removed`, and the newest are kept.
        - Active-batch exclusion via ordering: assert prune only ever deletes dirs that already exist on disk; model the `runParallelTasks` ordering by pruning first, then creating a fresh batch dir, and confirm the fresh dir is never in `removed`.
        - Resilience: `pruneParallelTaskBatches("/non/existent/root")` resolves to `{ removed: [], kept: 0 }` without throwing; simulate a per-dir failure (e.g. a dir whose manifest/dir cannot be removed) and confirm the sweep continues and the function still resolves. Prefer a typed stub over `as any`; if a VS Code / fs structural cast is unavoidable, keep it local with a one-line comment per AGENTS.md.
      Add recovery age-bound cases to `src/core/task/__tests__/parallelTaskRecovery.spec.ts`: a matching interrupted batch with manifest mtime older than the bound returns `undefined`; a recent matching interrupted batch still returns the reminder. Use unique `parentTaskId`s/dirs per test because the module-level `surfacedBatches` Set persists across tests in one process.
      Files: `src/core/task/__tests__/parallelTaskRetention.spec.ts`, `src/core/task/__tests__/parallelTaskRecovery.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/parallelTaskRetention.spec.ts core/task/__tests__/parallelTaskRecovery.spec.ts` — all tests pass.

- [ ] 5. Lint-check every touched file against the ESLint-suppressions contract.
      Run the AGENTS.md command on each new/edited file and confirm no file's suppression count increased.
      Files: (verification only)
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/parallelTaskRetention.ts core/task/runParallelTasks.ts core/task/parallelTaskRecovery.ts core/task/__tests__/parallelTaskRetention.spec.ts core/task/__tests__/parallelTaskRecovery.spec.ts` — exits clean, counts unchanged.

- [ ] 6. Rebuild the extension bundle (part of done — a stale bundle has masked fixes before).
      Files: (produces `src/dist/**`)
      Verify: `pnpm --dir src bundle` completes without errors and emits `[esbuild-problem-matcher#onEnd]`; `src/dist/extension.js` mtime is newer than the edits above.

## FIX 2 — Packaging must rebuild the bundle (no stale installs)

Investigation result — the exact vsix path: `pnpm vsix` (root `package.json`) → `turbo vsix` → the `src` package `vsix` script `mkdirp ../bin && vsce package --no-dependencies --out ../bin` (`src/package.json:486`). The turbo `vsix` task (`src/turbo.json`) is `{ "dependsOn": ["bundle"], "inputs": ["dist/**"], "outputs": ["../bin/**"] }`. The `bundle` task is `{ "dependsOn": ["^build", "@roo-code/vscode-webview#build"], "outputs": ["dist/**"] }` — note it declares NO `inputs`, so it also uses default inputs. `esbuild.mjs` already cleans `dist/` before every build, and `vscode:prepublish` runs `pnpm bundle --production`; vsce runs `vscode:prepublish` by default. So the real stale-bundle risk is turbo CACHING: both `bundle` and `vsix` are cacheable tasks, so turbo can restore a cached `dist/**` and/or a cached `../bin/*.vsix` and skip re-running vsce entirely — shipping a `.vsix` whose `dist` predates the current source. That matches the Oct-3 stale-install symptom.

- [ ] 7. Make the `vsix` turbo task fail-closed by disabling its cache so vsce always repackages a freshly built dist.
      In `src/turbo.json`, set `"cache": false` on the `vsix` task (keep `"dependsOn": ["bundle"]`, keep `"inputs"`/`"outputs"`). Rationale: this forces `vsce package` to re-run on every `pnpm vsix`, so a `.vsix` can never be served from a stale turbo cache; combined with the existing `vscode:prepublish` → `pnpm bundle --production` (clean dist via esbuild.mjs) that vsce invokes, the packaged `dist` is always built from current source. This is the minimal correct fix and does not restructure the build system. Decision: CHANGE (not a no-change) — the stale vsix was reproducible through turbo's cache on the documented packaging path, so the guarantee "packaging a vsix always rebuilds dist from current source first" requires removing the cache short-circuit on `vsix`.
      Note: do NOT touch `bin/*.vsix` or the user's installed extension under `~/.vscode/extensions` (already hot-patched separately), and do NOT build a new `.vsix` here (packaging is heavy and out of scope).
      Files: `src/turbo.json`
      Verify: `node -e "JSON.parse(require('fs').readFileSync('src/turbo.json','utf8'))"` parses clean and the `vsix` task shows `"cache": false`; confirm `vsce package` is no longer a turbo-cacheable step by inspecting the task config. (A full `pnpm vsix` run is intentionally NOT part of verification — packaging is heavy and not required.)

## Scope guardrails (do NOT touch)

- WorkerResult schema, `normalizeWorkerResult.ts`, `ParallelTasksTool.ts` caps, the auto-reader fan-out (`AUTO_READER_NAME` "m5-contract-audit" is intended), and the manifest/worker file formats — FIX 1 is purely additive cache management.
- FIX 1 does NOT retroactively clean the existing 28 GB cache; it only bounds future growth and future recovery age.
- Do NOT create `.changeset` files or edit `CHANGELOG.md` / `src/CHANGELOG.md` (AGENTS.md).

## Final verification (run before marking the task complete)

- `pnpm --dir src exec vitest run core/task/__tests__/parallelTaskRetention.spec.ts core/task/__tests__/parallelTaskRecovery.spec.ts` — green.
- `pnpm --dir src exec tsc --noEmit` — clean.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <all touched files>` — counts unchanged.
- `pnpm --dir src bundle` — rebuilds `dist` clean.
