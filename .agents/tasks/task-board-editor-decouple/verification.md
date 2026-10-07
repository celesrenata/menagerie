# Verification — Decouple the Task Board / task lifetime from the editor tab

Implements `design.md` revision 3 (`design-review.md`: 0 HIGH). First iteration (no `review.json`
present at start). Worked directly in the repo on branch `main`; no worktree, no push.

## What changed

### `editorViewRole` discrimination (Decision A, Option i-b)
- Added `private editorViewRole?: "popout" | "worker"` to `ClineProvider` plus a
  `setEditorViewRole(role)` setter (avoids changing constructor arity relied on by the spec and
  other callers) and `private isDetachableView()` → `editorViewRole === "popout"`.
- The sidebar provider leaves `editorViewRole` unset; any editor provider whose role was never
  set falls through to the safe `dispose()` path on tab-close.
- `openClineInNewTab` (`registerCommands.ts`) now calls `tabProvider.setEditorViewRole("popout")`.
- `createParallelTaskRuntime` (`ClineProvider.ts`) now calls `provider.setEditorViewRole("worker")`;
  worker tab-close keeps the existing abort-on-close path.

### `detachTabView` / `rebindView` / `bindWebview`
- Factored a private `bindWebview(view)` out of `resolveWebviewView`: it sets webview options +
  HTML (keeping the HMR/prod branch), registers the message listener, the view-state/visibility
  repost listener (keeping the `"onDidChangeViewState" in view` vs `"onDidChangeVisibility" in view`
  discriminator — exactly one is registered), the config listener, and the view-close
  `onDidDispose` — **all onto `webviewDisposables`** (moved from `this.disposables`), so
  `clearWebviewResources()` drains them on every teardown and re-open does not accumulate listeners
  (review Finding 2). `resolveWebviewView` keeps its first-time-only extras (terminal seeding,
  stale-task clear, zoo-gateway seeding) around the `bindWebview` call.
- The view-close `onDidDispose` keeps the `inTabMode` discriminator; inside the tab branch it
  routes popouts → `detachTabView()` and workers/unknown → `dispose()`; the sidebar branch keeps
  `clearWebviewResources()`.
- `detachTabView()`: guard (`_disposed || view === undefined` → return) → role safety (non-popout →
  `dispose()` fallback) → **capture panel + null `this.view` BEFORE disposing** (re-entrancy
  idempotency, review Finding 3) → `clearWebviewResources()` → `panel.dispose()` in try/catch →
  terminal-check reap (if the owned task is already `completed`/`abort`, `void this.dispose()`,
  else leave the provider live and headless). For a still-running task it makes ZERO
  `removeClineFromStack`/`abortTask`/task-`dispose` calls, never touches `taskRegistry` /
  `activeInstances`, and does not set `_disposed`.
- `rebindView(panel)`: declines (and disposes the passed panel) if `_disposed` or `view` is already
  set; otherwise `this.view = panel` → `bindWebview(panel)` → `void postStateToWebview()`. Re-open
  uses this (NOT a second `resolveWebviewView`), so first-time init is not re-run and listeners do
  not accumulate.
- Added `openTaskInNewTab(taskId, { context })` in `registerCommands.ts`: locates the owning
  provider via `getAllInstances().find(p => p.getCurrentTask()?.taskId === taskId)`; if none, shows
  "That task is no longer running" and declines (never `createTask`); else creates a fresh panel and
  calls `owningProvider.rebindView(panel)`. Exported as a function (no new `CommandId` / webview
  message required by the design).

### Headless self-reap (Correction #2 + review Finding 1)
- Added `private reapIfDetachedPopoutTerminal(terminatedTaskId)`:
  `if (editorViewRole === "popout" && view === undefined && getCurrentTask()?.taskId === terminatedTaskId) void this.dispose()`.
- Wired into `onTaskCompleted` (after the existing `await` status write + `emit`) and
  `onTaskAborted` (after the `emit`; the synchronous listener writes no status — `"aborted"` is
  persisted by the abort flow itself). Keyed on the terminal EVENT, not registry-emptiness, because
  completion does NOT drain the registry for a standalone popout task.

### Two mechanical corrections applied
1. **`taskRegistry.getCurrentTaskId()` does not exist.** The reap guard uses
   `this.getCurrentTask()?.taskId` (provider accessor returning `this.taskRegistry.current`).
2. **`onTaskAborted` is a synchronous listener with no status write.** The reap is appended after
   its `emit`; the aborted status is treated as already persisted by the abort path (not written by
   this listener). The completed path appends the reap after its `await` status write + `emit`.

### Lifecycle model (Decision D) — `scripts/check-task-cleanup-protocol.ts` only
- Added per-task `view: "owning-visible" | "owning-detached" | "none"` (init `"owning-visible"`).
- Added the `view-detach(task)` transition, enabled only when `view === "owning-visible" &&
  disposal === "idle"`; it sets ONLY `view = "owning-detached"` and asserts (at construction time)
  that it changes no abort/disposal/reversion/cleanup/finalization state.
- Added `"view-detach"` to `expectedActions`.
- Added the orthogonality invariant to `invariantViolations` (a modeled task's `view` may only ever
  be `"owning-visible"` or `"owning-detached"`; reaching `"none"` means some other action wrote
  `view`, breaking orthogonality).
- Added the `view-detach-preserves-owned-task` landmark (reachable state where
  `view === "owning-detached" && abort === "idle" && disposal === "idle"`) to `reachedLandmarks`
  and `expectedLandmarks`; bumped the summary literal `/8` → `/9`.
- Raised `MAX_STATES` 100_000 → 300_000 (the orthogonal ternary field grows the exhaustive BFS to
  ~229k states; raised explicitly per the model's extension rules rather than sampling).
- Did NOT touch `taskLifecycle.ts`, `VALID_TASK_STATUS_TRANSITIONS`, or the #1469/#1021 witnesses in
  `scripts/check-task-store-concurrency.ts` (those run in the chain and still print their legacy
  counterexamples — unchanged).

## Commands run and results

1. `pnpm --dir src check-types` → exit 0 (`tsc --noEmit`, no output).

2. Focused Vitest (`pnpm --dir src exec vitest run <spec>`):
   - `core/webview/__tests__/ClineProvider.spec.ts` + `activate/__tests__/taskBoard.spec.ts` +
     `activate/__tests__/registerCommands.spec.ts` → **Test Files 3 passed (3), Tests 217 passed (217)**.
     (ClineProvider spec: 192 total incl. 11 new popout-decouple tests; registerCommands spec:
     includes 2 new `openTaskInNewTab` tests; taskBoard spec: includes the new N-rows/popout-detach
     regression test.)

3. `pnpm lifecycle:model-check` → exit 0. Full chain green. Cleanup-protocol checker:
   ```
   Task cleanup protocol model check passed: 229464 reachable states, 17/17 actions reachable, 9/9 landmarks reached, depth <= 20, tasks=2
   ```
   Lifecycle delegation checker still prints the #1469/#1021 legacy counterexamples (unchanged,
   not weakened); parser-scope (924/924, 8/8), completion-persistence (7/7), and delegated-mode
   reader checks all pass. `pnpm test` was NOT run (too broad to finish in this environment); the
   focused lifecycle model-check + the webview/taskBoard/registerCommands Vitest suites above cover
   the change — stated explicitly per the instruction.

4. ESLint on every edited file, `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0`:
   - Production: `core/webview/ClineProvider.ts activate/registerCommands.ts activate/taskBoard.ts`
     → exit 0, clean.
   - Tests: `core/webview/__tests__/ClineProvider.spec.ts activate/__tests__/taskBoard.spec.ts
     activate/__tests__/registerCommands.spec.ts` → exit 0, clean.
   - `git diff --stat src/eslint-suppressions.json` → empty (no suppression-count increase). New
     test code uses bracket-notation private accessors and `as unknown as T` structural doubles
     (with comments) instead of `as any`.

5. `pnpm --dir src bundle` → exit 0 (esbuild completed, assets copied).

## Repo rules observed
- No `.changeset` files; no `CHANGELOG.md` / `src/CHANGELOG.md` edits.
- Lifecycle mutation lives only in `scripts/check-task-cleanup-protocol.ts` (the cleanup-protocol
  MODEL), not in `taskLifecycle.ts`.
- Parallel-worker abort-on-close semantics and the #1469/#1021 witnesses are unchanged.
