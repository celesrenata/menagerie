# Task Board / editor-tab decouple — implementation review

The change severs the lifetime coupling between an interactive popout editor tab and the task it hosts. Closing a popout tab now detaches the view and leaves the owning `ClineProvider` headless (still in `activeInstances`, still owning its task), so `collectTaskBoard()` keeps enumerating it as one row. Parallel-worker tabs keep their abort-on-close lifecycle. The approach is Decision A option (i-b) from `design.md` revision 3: discriminate by an explicit per-provider `editorViewRole` ("popout" | "worker" | undefined), not by `renderContext` or registry emptiness.

Watch for: nothing blocking. All seven verification points are implemented as designed; the two mechanical corrections are present; the cleanup-protocol model gained the `view-detach` transition, orthogonality invariant, and landmark with the `/8`→`/9` literal bump; recorded evidence shows check-types, focused Vitest (217 tests), `lifecycle:model-check` (9/9 landmarks), ESLint, and bundle all green.

**Verdict**: APPROVED

## High-level view

The discrimination is correct. `editorViewRole` is a new private field set via `setEditorViewRole()` by the two editor creators (`openClineInNewTab` → "popout", `createParallelTaskRuntime` → "worker"); the sidebar leaves it undefined. The view-close `onDidDispose` keeps the existing `inTabMode` discriminator and, inside the tab branch, routes popouts to `detachTabView()` and workers/unknown-role to `dispose()` — so unknown roles fail safe to the task-draining path, and genuine `dispose()` (deactivate) is unchanged.

The re-entrancy ordering is correct. `detachTabView()` guards on `_disposed || view === undefined`, captures the panel into a local, nulls `this.view`, then drains `webviewDisposables` and disposes the captured panel. Because `this.view` is null before `panel.dispose()` synchronously re-fires the view-close handler, the re-entrant entry short-circuits at the guard. A dedicated unit test simulates the re-fire and asserts single execution.

The re-attach path is factored as designed. The shared bind body is a private `bindWebview(view)` that `resolveWebviewView` and `rebindView` both call; `resolveWebviewView` keeps its first-time-only extras (terminal seeding, stale-task clear) around that call. The view-close `onDidDispose` now lives on `webviewDisposables`, so detach drains it and a re-open installs exactly one of each listener — proven by the no-accumulation test.

The headless self-reap fires on the provider's own terminal events, not registry-emptiness. `reapIfDetachedPopoutTerminal(taskId)` is called from `onTaskCompleted` (after its await status write + emit) and `onTaskAborted` (after its emit; synchronous, no status write), plus a terminal check in `detachTabView()`. Both mechanical corrections are present: the guard reads `this.getCurrentTask()?.taskId` (no `taskRegistry.getCurrentTaskId()`), and the aborted path relies on the abort flow having already persisted "aborted".

The cleanup-protocol model gained exactly the designed state: a ternary `view` field, a `view-detach` transition enabled only from `owning-visible` with `disposal === "idle"` that writes only `view` (with construction-time orthogonality asserts), an invariant tripping if `view` reaches `"none"`, and the `view-detach-preserves-owned-task` landmark. The `#1469/#1021` witnesses in the separate concurrency submodel are untouched; the summary literal moved to `/9`; `MAX_STATES` was raised 100k→300k to keep the BFS exhaustive.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. The implementation matches the approved design across all seven verification points.

</details>

<details>
<summary>Details</summary>

### editorViewRole discrimination

`ClineProvider.ts:219` adds `private editorViewRole?: "popout" | "worker"` with a comment documenting the three cases. `setEditorViewRole()` (`:3468`) and `isDetachableView()` (`:3474`, `=== "popout"`) are added as designed, avoiding a constructor-arity change. `openClineInNewTab` (`registerCommands.ts:240`) calls `setEditorViewRole("popout")`; `createParallelTaskRuntime` (`ClineProvider.ts:3557`) calls `setEditorViewRole("worker")`.

The `onDidDispose` handler (now in `bindWebview`, `ClineProvider.ts:1122`) keeps the `inTabMode` discriminator and, in the tab branch, calls `detachTabView()` when `isDetachableView()` else `dispose()`; the sidebar branch keeps `clearWebviewResources()`. Unknown-role editor providers (never set) therefore route to `dispose()` — the safe default. Genuine `dispose()` is unchanged (`:860`): it still drains the registry via `evictCurrentTask()`/`removeClineFromStack()` and aborts, confirmed by the "genuine dispose() still aborts even for a popout provider" test. Workers routing to `dispose()`/abort is confirmed by the "worker tab-close still disposes (aborts) the worker" test.

### detachTabView re-entrancy ordering

`detachTabView()` (`ClineProvider.ts:1159`) orders: guard (`_disposed || view === undefined`) → role-safety fallback to `dispose()` for a non-popout → `const panel = this.view; this.view = undefined` → `clearWebviewResources()` → `panel.dispose()` in try/catch → terminal-check reap. Nulling `this.view` before `panel.dispose()` means the synchronously re-fired view-close handler short-circuits at the guard. The "re-entrant onDidDispose during detach short-circuits (null-before-dispose)" test stubs `panel.dispose()` to re-invoke the captured callback and asserts `clearWebviewResources` and `panel.dispose` each run once. For a still-running task, the method makes zero `removeClineFromStack`/`abortTask`/task-`dispose` calls and never touches `taskRegistry`/`activeInstances`/`_disposed` — asserted by the "keeps the running task alive" test.

The terminal-check reap uses `this.taskHistoryStore.get(task.taskId)?.status === "completed" || task.abort`, a faithful mirror of `collectTaskBoard`'s terminal detection in `taskBoard.ts:38` (`history?.status === "completed" ... : task.abort`). This handles a tab closed after the task already finished.

### bindWebview / rebindView factoring and listener lifetime

`bindWebview(view)` (`ClineProvider.ts:1061`) holds the shared setup: webview options, HTML (dev-HMR vs prod branch preserved), message listener, the `onDidChangeViewState`/`onDidChangeVisibility` repost listener (exactly one, by the existing shape discriminator), the config listener, and the view-close `onDidDispose` — all pushed to `webviewDisposables`. `resolveWebviewView` (`:1150`) sets `this.view`, registers the panel, awaits `bindWebview`, then runs the first-time-only extras (terminal `getState()` seeding, stale-task clear). `rebindView(panel)` (`:1225`) asserts headlessness (`_disposed || view !== undefined` → log + dispose the passed panel + return), sets `this.view = panel`, awaits `bindWebview(panel)`, and `void postStateToWebview()` — no first-time extras, so the stale-task clear cannot evict the re-opened task. Because detach drains `webviewDisposables`, a rebind installs exactly one view-close and one message listener; the "rebind cycles do not accumulate view-close listeners" test fires detach after each of two rebinds and asserts `detachTabView` is invoked exactly once per close. The "rebindView declines ... when the provider is not headless" test covers the decline path.

### Headless self-reap on terminal events

`reapIfDetachedPopoutTerminal(terminatedTaskId)` (`ClineProvider.ts:1286`) reaps only when `editorViewRole === "popout" && view === undefined && getCurrentTask()?.taskId === terminatedTaskId`, then `void this.dispose()` (idempotent via `_disposed`). It is wired into `onTaskCompleted` after the await status write + `this.emit(TaskCompleted, …)` (`:457`) and into `onTaskAborted` after `this.emit(TaskAborted, …)` (`:461`). `onTaskAborted` is synchronous and writes no status; the comment and design agree that "aborted" is persisted by the abort flow, not this listener — mechanical correction #2. The guard reads `getCurrentTask()?.taskId`, not the non-existent `taskRegistry.getCurrentTaskId()` — mechanical correction #1.

The reap keys on the terminal event, not registry-emptiness: completion does not drain the registry, so the task is still the current entry (length 1) when the event fires. The "self-reap on TaskCompleted removes a detached popout even with the task still in the registry" test asserts exactly this; "self-reap on TaskAborted removes a detached popout" covers the aborted path; "a terminal event on a VISIBLE popout does not reap" covers the `view`-defined negative; and "detachTabView after a visible completion reaps via its terminal check" covers the post-completion tab-close reap.

### Cleanup-protocol model

`scripts/check-task-cleanup-protocol.ts` adds `view: "owning-visible" | "owning-detached" | "none"` to `TaskState` (init `"owning-visible"` in `task()`), a `view-detach(task)` transition enabled only when `view === "owning-visible" && disposal === "idle"` that writes only `view` and asserts at construction time that abort/disposal/reversion/cleanup/finalization are unchanged, `"view-detach"` added to `expectedActions`, an invariant that trips if `view === "none"` (orthogonality: `view-detach` is the sole writer and no action reads it as a guard), and the `view-detach-preserves-owned-task` landmark (reachable when `view === "owning-detached" && abort === "idle" && disposal === "idle"`) added to both `reachedLandmarks` and `expectedLandmarks`. The summary literal is `/9`. `MAX_STATES` raised 100k→300k, documented as keeping the BFS exhaustive (~229k states). `taskLifecycle.ts`, `VALID_TASK_STATUS_TRANSITIONS`, and the `#1469/#1021` witnesses in `check-task-store-concurrency.ts` are untouched. Recorded evidence: `pnpm lifecycle:model-check` → exit 0, cleanup checker "229464 reachable states, 17/17 actions, 9/9 landmarks reached"; the delegation checker still prints the #1469/#1021 counterexamples unchanged.

### Test placement

Every behavior is tested at the lowest layer (`src/` Vitest). ClineProvider spec covers detach-vs-dispose, role branch, idempotency, re-entrancy, both self-reap paths, the visible-no-reap negative, the post-completion terminal-check reap, no-accumulation, and rebind decline. taskBoard spec adds the N-rows + survives-popout-detach regression. registerCommands spec covers `openTaskInNewTab` missing-id (no `createTask`, info message) and live-id (`rebindView`, not `resolveWebviewView`). Recorded run: 3 files, 217 tests passed. No E2E added, consistent with the plan (lower layers prove every assertion).

### Evidence sufficiency

`verification.md` and the commit message record check-types (exit 0), the focused Vitest run (217 passed), `lifecycle:model-check` (exit 0, 9/9 landmarks, #1469/#1021 unchanged), ESLint `--prune-suppressions --max-warnings=0` on all edited files (clean, no suppression-count increase per `git diff --stat src/eslint-suppressions.json` empty), and `bundle` (exit 0). Evidence is complete and internally consistent with the diff; no suite re-run or spot-check was warranted.

</details>

<details>
<summary>File map</summary>

- `src/core/webview/ClineProvider.ts` — `editorViewRole` field + `setEditorViewRole`/`isDetachableView`; `bindWebview` factored out of `resolveWebviewView` with view-close `onDidDispose` moved to `webviewDisposables`; `detachTabView` (null-before-dispose + terminal reap); `rebindView`; `reapIfDetachedPopoutTerminal` wired into `onTaskCompleted`/`onTaskAborted`; worker role at `createParallelTaskRuntime`.
- `src/activate/registerCommands.ts` — popout role at `openClineInNewTab`; new `openTaskInNewTab` re-open entry (rebindView, never createTask).
- `scripts/check-task-cleanup-protocol.ts` — `view` field, `view-detach` transition, orthogonality invariant, `view-detach-preserves-owned-task` landmark, `/8`→`/9`, `MAX_STATES` 100k→300k.
- `src/core/webview/__tests__/ClineProvider.spec.ts` — popout decouple suite (detach/dispose/reap/re-entrancy/no-accumulation/rebind-decline).
- `src/activate/__tests__/taskBoard.spec.ts` — N-rows + survives-popout-detach regression.
- `src/activate/__tests__/registerCommands.spec.ts` — `openTaskInNewTab` missing-id and live-id tests.

Full diff: `git show HEAD` on `main` (commit 1e6ae17fb).

</details>
