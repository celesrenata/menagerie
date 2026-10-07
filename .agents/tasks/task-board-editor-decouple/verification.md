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

---

## Final verification (post-approval gate, 2026-10-07)

Run fresh after review approval, at commit `1e6ae17fb` ("fix: decouple Task Board / task lifetime
from the popout editor tab") on branch `main`. Node v24.21.0 / pnpm 10.8.1 (the engine-mismatch
`WARN` is pre-existing and harmless). No feature changes were made during this gate; every required
command was run as specified and passed, so no fixes were needed.

Edited-file set confirmed from `git show --stat 1e6ae17fb` (5 code files + the model script +
this doc):
- `src/core/webview/ClineProvider.ts`
- `src/activate/registerCommands.ts`
- `src/core/webview/__tests__/ClineProvider.spec.ts`
- `src/activate/__tests__/taskBoard.spec.ts`
- `src/activate/__tests__/registerCommands.spec.ts`
- `scripts/check-task-cleanup-protocol.ts` (lifecycle MODEL only)
- `.agents/tasks/task-board-editor-decouple/verification.md`

Note: `src/activate/taskBoard.ts` (production) was NOT edited by this change — only its spec. ESLint
was therefore run on the 5 edited `.ts` files above.

### 1. `pnpm --dir src check-types`
```
> zoo-code@3.84.4 check-types
> tsc --noEmit
EXIT=0
```
Exit 0, no diagnostics.

### 2. Focused Vitest for every edited spec
```
pnpm --dir src exec vitest run \
  core/webview/__tests__/ClineProvider.spec.ts \
  activate/__tests__/taskBoard.spec.ts \
  activate/__tests__/registerCommands.spec.ts
```
Result:
```
 Test Files  3 passed (3)
      Tests  217 passed (217)
```
Exit 0. Covers the ClineProvider popout-decouple/self-reap/rebind/re-entrancy cases, the
taskBoard N-rows/popout-detach regression test, and the `openTaskInNewTab` registerCommands tests.

### 3. `pnpm lifecycle:model-check`
Exit 0. Full chain green — full output:
```
Task lifecycle model check passed: 53 reachable states, 4/4 actions reachable, 2/2 landmarks reached, depth <= 12, 3 task slots
Known unsafe #1469: stale child completion cleared a newer parent handoff
  complete-a.read -> complete-a.prepare -> redelegate-b.read -> redelegate-b.prepare -> redelegate-b.revalidate(child-a) -> redelegate-b.commit(child-a) -> complete-a.revalidate(child-a) -> complete-a.commit(child-a) -> redelegate-b.revalidate(child-b) -> redelegate-b.commit(child-b) -> redelegate-b.revalidate(parent) -> redelegate-b.commit(parent) -> complete-a.revalidate(parent) -> complete-a.commit(parent)
Known unsafe #1021: stale live-task save reattached abandoned lineage
  stale-save-a.read -> abandon-b.read -> abandon-b.prepare -> abandon-b.revalidate(child-a) -> abandon-b.commit(child-a) -> abandon-b.revalidate(parent) -> abandon-b.commit(parent) -> A.refresh -> stale-save-a.prepare -> stale-save-a.revalidate(child-a) -> stale-save-a.commit(child-a)
Shared-store model check passed: 625 states, 6 scenarios, 6 invariants, 7/7 phases reachable, 3/3 landmarks reached
Provider handoff/scheduler model check passed: 104 distinct reachable states, 3/3 profile scenarios, 1/1 downstream shared-mode witness, 10/10 actions, 12/12 landmarks, depth <= 15, states <= 20000, 6/6 legacy counterexamples
Legacy counterexample start-before-commit: child started without exact commit
  initial -> claim(a, g0) -> prepare(a, g0) -> start(a, g0)
Legacy counterexample resume-before-permit-release: parent resumed before child permit release
  initial -> claim(a, g0) -> prepare(a, g0) -> commit(a, g0) -> start(a, g0) -> complete-child -> publish-parent -> resume-parent(g0)
Legacy counterexample redelegate-before-permit-release: parent redelegated before child permit release
  initial -> claim(a, g0) -> prepare(a, g0) -> commit(a, g0) -> start(a, g0) -> complete-child -> publish-parent -> redelegate(g1)
Legacy counterexample empty-publication: observable current task is empty
  initial -> claim(a, g0) -> prepare(a, g0)
Legacy counterexample stale-concurrent-provider-commits: multiple provider commits for one parent generation
  initial -> claim(a, g0) -> prepare(a, g0) -> claim(b, g0) -> commit(a, g0) -> prepare(b, g0) -> commit(b, g0)
Legacy counterexample publication-releases-parent-transition: stale parent continuation crossed a newer transition
  initial -> claim(a, g0) -> prepare(a, g0) -> commit(a, g0) -> start(a, g0) -> complete-child -> publish-parent -> redelegate(g1) -> claim(a, g1) -> prepare(a, g1) -> commit(a, g1) -> release-child-permit -> resume-parent(g0)
Task cleanup protocol model check passed: 229464 reachable states, 17/17 actions reachable, 9/9 landmarks reached, depth <= 20, tasks=2
Native tool-call parser scope model check passed: 924/924 valid local-order interleavings, 6/6 actions reachable, 8/8 landmarks reached, scopes=2, raw-index=0, actions-per-scope=6
Completion persistence model check passed: 88 states, 12/12 actions reachable, 5 invariants, 7/7 landmarks reached, depth <= 10, writes <= 2
Delegated mode reader check passed: regression scenario verified, 4 divergent-mode pairs checked, 5/5 built-in modes verified
```
The cleanup-protocol MODEL (changed by this task) passes with 229464 reachable states and 9/9
landmarks. The #1469/#1021 witnesses and all 6 legacy scheduler counterexamples still print
unchanged — not weakened.

`pnpm test` was NOT run — too broad to finish reliably in this environment. Per the instruction, the
focused lifecycle model-check (full chain above) plus the focused webview/taskBoard/registerCommands
Vitest suites in step 2 cover the change. STATED EXPLICITLY: the full `pnpm test` suite was not
executed in this gate.

### 4. ESLint on every edited `.ts` file
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`:
```
core/webview/ClineProvider.ts                      -> EXIT=0 (clean)
activate/registerCommands.ts                       -> EXIT=0 (clean)
core/webview/__tests__/ClineProvider.spec.ts       -> EXIT=0 (clean)
activate/__tests__/taskBoard.spec.ts               -> EXIT=0 (clean)
activate/__tests__/registerCommands.spec.ts        -> EXIT=0 (clean)
```
`git status --short src/eslint-suppressions.json` → empty; `git diff --stat` → empty. No
suppression-count increase for any file.

### 5. `pnpm --dir src bundle`
Exit 0. esbuild cleaned and rebuilt `src/dist`, copied assets/WASMs/locales:
```
[extension] Cleaning dist directory: .../src/dist
[copyPaths] Copied 911 files from node_modules/vscode-material-icons/generated ...
[copyWasms] Copied 36 tree-sitter language wasms ...
[copyLocales] Copied 126 locale files ...
EXIT=0
```
Fresh artifact confirmed: `src/dist/extension.js` (~33 MB) regenerated. The install-sync step's
dependency on a fresh `src/dist` is satisfied.

### Final gate result
All five required checks pass. No command failed; no fixes or behavior changes were required during
this gate. The #1469/#1021 witnesses and legacy scheduler counterexamples remain intact.
