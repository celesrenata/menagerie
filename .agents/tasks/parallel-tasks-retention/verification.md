# Verification — Parallel-tasks cache retention + fail-closed packaging

## FIX 1 — Cache retention + age-bounded recovery

### Retention constants (single source of truth)
`src/core/task/parallelTaskRetention.ts` exports:
- `MAX_BATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000` (7 days)
- `MAX_BATCH_COUNT = 50`

### Prune function
`pruneParallelTaskBatches(storageRoot: string, now?: number): Promise<{ removed: string[]; kept: number }>`
- Lists `<storageRoot>/parallel-tasks/*`; computes each batch's age from `manifest.json` mtime, falling back to the dir's own mtime.
- Deletes dirs older than `MAX_BATCH_AGE_MS` via `fs.rm(dir, { recursive: true, force: true })`.
- If survivors still exceed `MAX_BATCH_COUNT`, evicts oldest-first down to the cap.
- Never throws: missing storage root resolves to `{ removed: [], kept: 0 }`; per-dir stat/delete failures are swallowed with a `[ParallelTaskRetention]` `console.warn` and the sweep continues.

### Where prune is wired
`src/core/task/runParallelTasks.ts`, inside `runParallelTasks`, at the very top of the function body — `await pruneParallelTaskBatches(provider.context.globalStorageUri.fsPath)` runs BEFORE `const batchId = crypto.randomUUID()` / `const directory = ...` create the new batch dir. Because the new batch dir does not exist on disk yet when prune runs, the active batch can never be a deletion target (documented in a comment). The call is awaited (no floating promise, per AGENTS.md).

### Recovery age bound
`src/core/task/parallelTaskRecovery.ts` imports `MAX_BATCH_AGE_MS` from `./parallelTaskRetention` aliased as `MAX_RECOVERABLE_BATCH_AGE_MS` (no duplicated literal). In `getInterruptedParallelBatchSummary`, candidate batches are filtered to those with `modified >= Date.now() - MAX_RECOVERABLE_BATCH_AGE_MS` BEFORE the newest is selected, so an ancient interrupted batch cannot shadow or resurface in place of a recent one. All other behavior unchanged: parentTaskId match, non-"completed" worker filter, once-per-session `surfacedBatches` guard, exact `# Recoverable Parallel Work` message text.

### Scope note
FIX 1 does NOT retroactively clean the existing 28 GB / 98-dir cache. It prunes on the NEXT batch run (prune-before-create), and bounds recovery age immediately once the new bundle is loaded. No WorkerResult schema, `normalizeWorkerResult.ts`, `ParallelTasksTool.ts` caps, auto-reader fan-out (`AUTO_READER_NAME` "m5-contract-audit" is intended), or manifest/worker formats were changed — the change is purely additive cache management; patches within the window are preserved (evicted by age/count only, never selective patch inspection).

## FIX 2 — Packaging must rebuild the bundle (decision: CHANGE)

### Investigation
- Root `package.json` `vsix` → `turbo vsix`.
- `src/package.json` `vsix` script: `mkdirp ../bin && vsce package --no-dependencies --out ../bin`.
- `src/package.json` `vscode:prepublish`: `pnpm bundle --production` (vsce runs this by default; `esbuild.mjs` cleans `dist/` first).
- `src/turbo.json` `vsix` task: `{ "dependsOn": ["bundle"], "inputs": ["dist/**"], "outputs": ["../bin/**"] }` — a CACHEABLE task. Turbo could restore a cached `../bin/*.vsix` (and/or cached `dist/**`) and skip re-running vsce, shipping a `.vsix` whose `dist` predates current source. This matches the stale-install symptom.

### Change applied
`src/turbo.json`: added `"cache": false` to the `vsix` task (kept `dependsOn`/`inputs`/`outputs`). This forces `vsce package` to re-run on every `pnpm vsix`, so a `.vsix` can never be served from a stale turbo cache; combined with the existing `vscode:prepublish` → clean `pnpm bundle --production`, the packaged `dist` is always built from current source. Minimal fix; build system not restructured.

Did NOT touch `bin/*.vsix` or `~/.vscode/extensions`, and did NOT build a new `.vsix` (packaging is heavy, out of scope).

## Files created / edited
- Created: `src/core/task/parallelTaskRetention.ts`
- Created: `src/core/task/__tests__/parallelTaskRetention.spec.ts`
- Edited: `src/core/task/runParallelTasks.ts` (import + prune-before-create)
- Edited: `src/core/task/parallelTaskRecovery.ts` (import + age-bound filter)
- Edited: `src/core/task/__tests__/parallelTaskRecovery.spec.ts` (age-bound cases)
- Edited: `src/turbo.json` (`vsix` → `"cache": false`)

## Commands run and results
1. `pnpm --dir src check-types` → exit 0 (tsc --noEmit, no errors).
2. `pnpm --dir src exec vitest run core/task/__tests__/parallelTaskRetention.spec.ts core/task/__tests__/parallelTaskRecovery.spec.ts` → 2 files, 10 tests passed.
3. `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/parallelTaskRetention.ts core/task/runParallelTasks.ts core/task/parallelTaskRecovery.ts core/task/__tests__/parallelTaskRetention.spec.ts core/task/__tests__/parallelTaskRecovery.spec.ts` → exit 0; `src/eslint-suppressions.json` unchanged (not in git status; no entries for touched task files).
4. `pnpm --dir src bundle` → exit 0; `[esbuild-problem-matcher#onEnd]` emitted.
5. `grep -c "pruneParallelTaskBatches\|MAX_BATCH_AGE_MS" src/dist/extension.js` → 6 (> 0).

### Test coverage summary (10 tests)
Retention spec:
- Age prune removes old dir, keeps recent.
- Manifest-missing fallback to dir mtime.
- Count cap: 60 recent dirs → 50 survive, 10 oldest removed, newest kept.
- Active-batch exclusion via prune-before-create ordering.
- Non-existent root resolves `{ removed: [], kept: 0 }` without throwing.
- Per-dir stat failure (dangling symlink) is swallowed; sweep continues and still removes a valid aged dir.

Recovery spec (added):
- Interrupted batch older than the age bound returns `undefined`.
- Recent matching interrupted batch still returns the reminder.
