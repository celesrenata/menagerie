# Design Review: Decouple the Task Board / task lifetime from the editor tab (Revision 3)

Reviewed document: `.agents/tasks/task-board-editor-decouple/design.md` (Revision 3).
Scope: design review only. No builds or test suites were run. Source files were read to verify the design's load-bearing claims.

## Verdict

CHANGES_REQUESTED — 0 HIGH, 2 MEDIUM, 3 NIT.

The ownership model (Decision A, Option i-b), the headless self-reap trigger, the re-attach path, the lifecycle-model transition, and the board/editor scope are all sound and verified against source. The blocking issues are two concrete API-reference errors that will not compile or will behave differently than described, plus three nits. None of the brief's hard-block conditions (ownership ambiguity, invariant breakage, weakening #1469/#1021, missing re-attach, unverified core assumptions) are triggered — those are all resolved and verified. The MEDIUMs are mechanical correctness gaps in the spec that a coder would otherwise reproduce.

---

## Findings

### 1. MEDIUM — `taskRegistry.getCurrentTaskId()` does not exist on `TaskRegistry`

Decision A's reap seam specifies the guard `editorViewRole === "popout" && view === undefined && taskRegistry.getCurrentTaskId() === terminatedTaskId`, and the Affected-files bullet repeats "the terminated `taskId` is this provider's current task."

Verified against `src/core/task/TaskRegistry.ts`: the registry exposes `current` (a getter returning `Task | undefined`), `length`, `taskIds`, `getById`, `getAll`, `getRunning`, `hasRunning` — but **no** `getCurrentTaskId()` and no `getCurrentTask()`. The provider-level accessor is `ClineProvider.getCurrentTask()` (used by `collectTaskBoard`), which returns `this.taskRegistry.current`.

As written the guard references a method that is not on the class and would not compile.

CONCRETE FIX: change the reap guard to use an existing accessor, e.g.
```ts
editorViewRole === "popout" &&
  this.view === undefined &&
  this.getCurrentTask()?.taskId === terminatedTaskId
```
(or `this.taskRegistry.current?.taskId === terminatedTaskId`). Update both the Decision A "Reap seam" bullet and the Affected-files `taskCreationCallback` bullet to name the real accessor.

### 2. MEDIUM — `onTaskAborted` is a synchronous non-async listener; "after their existing status write + emit" does not apply symmetrically

Decision A and the Affected-files bullet say to augment `onTaskCompleted` **and** `onTaskAborted` so that "after their existing work (status write + `emit`)" the reap runs. Verified in `ClineProvider.ts` (~435, `taskCreationCallback`):

- `onTaskCompleted` is `async`, does a history status write, then `this.emit(RooCodeEventName.TaskCompleted, …)`.
- `onTaskAborted` is `const onTaskAborted = () => this.emit(RooCodeEventName.TaskAborted, instance.taskId)` — a **synchronous** arrow with **no** status write.

So the symmetric phrasing "after their existing status write + emit" is inaccurate for the abort path (there is no status write there), and the reap call `void this.dispose()` added to the abort listener will run while the listener is still synchronous. `dispose()` is async; calling it fire-and-forget (`void`) is fine, but the design should state that `onTaskAborted` gains the reap as a `void this.dispose()` after the `emit`, and that it has no pre-existing status write to sequence after. This also interacts with the fact that the terminated task's `"aborted"` status must already be persisted before reap — for the completed path the status write precedes `emit`; for the aborted path the design must confirm where `"aborted"` is persisted (the abort status is written elsewhere in the abort flow, not in this listener).

CONCRETE FIX: reword the Decision A reap bullet and Affected-files bullet to describe the two listeners separately: for `onTaskCompleted`, append the reap after the existing `await` status write + `emit`; for `onTaskAborted`, append `void this.dispose()` after the `emit` (noting there is no status write in that listener) and state the assumption that `"aborted"` was already persisted by the abort flow before this listener fires. Add that assumption to the Assumptions section with a verification step.

### 3. NIT — `dispose()` disposes `this.view` then calls `clearWebviewResources()`; `detachTabView()` reverses that order

`detachTabView()` is described as "mirrors the panel dispose that `dispose()` would have done." Verified in `dispose()`: the order is drain registry → `if (this.view && "dispose" in this.view) this.view.dispose()` → `clearWebviewResources()`. `detachTabView()` instead does null-`this.view` → `clearWebviewResources()` → `panel.dispose()`. The reversed order is **intentional and correct** for the re-entrancy guard (null before dispose), and the end state is equivalent, but "mirrors" slightly overstates the similarity.

CONCRETE FIX: change "mirrors the panel dispose that `dispose()` would have done" to "performs the same panel disposal that `dispose()` performs, but ordered after `clearWebviewResources()` and after nulling `this.view` so the re-entrant `onDidDispose` short-circuits." No behavioral change needed.

### 4. NIT — Decision C `rebindView` reuses the `onDidChangeViewState` repost listener, but the design must confirm it is a `WebviewPanel` not `WebviewView`

`bindWebview(view)` is said to register "the `onDidChangeViewState`/`onDidChangeVisibility` repost listener … onto `webviewDisposables`." Verified in `resolveWebviewView`: the current code branches `if ("onDidChangeViewState" in webviewView)` (panel) vs `else if ("onDidChangeVisibility" in webviewView)` (sidebar). A re-bound popout is always a `WebviewPanel`, so `bindWebview` must take the panel branch. The design lists both event names with a slash, which could read as "register both."

CONCRETE FIX: state that `bindWebview` keeps the existing `"onDidChangeViewState" in view` / `"onDidChangeVisibility" in view` discriminator and registers exactly the one listener matching the view shape (panel → `onDidChangeViewState`), so a re-bound popout panel gets the view-state repost listener, never both.

### 5. NIT — Checker summary literal: confirm there is no second hardcoded count besides `/8`

Decision D and Affected-files call for bumping the `/8` → `/9` summary literal "and any count assertion against the landmark total." Verified in `scripts/check-task-cleanup-protocol.ts`: the only hardcoded total is the `${result.landmarks}/8 landmarks reached` literal in the final `console.log`; the actions line uses `${expectedActions.length}` (dynamic) and `missingLandmarks` compares against the `expectedLandmarks` array (dynamic). So the single mechanical edit is the `/8` literal plus adding the new entry to `expectedLandmarks` (and `view-detach` to `expectedActions`). There is no separate count assertion to change.

CONCRETE FIX: tighten the design to say "the only hardcoded total is the `/8` summary literal; bump it to `/9`. The actions count and `missingLandmarks` check are already array-length-driven and need no literal edit." Removes the ambiguous "any count assertion" hedge.

---

## Verified Assumptions

1. **Root cause — editor tab-close kills the task via `dispose()`.** Verified. `resolveWebviewView` registers `webviewView.onDidDispose(…, null, this.disposables)`; the handler's `inTabMode` branch calls `await this.dispose()`, and `dispose()` drains the registry via `evictCurrentTask()` → `removeClineFromStack()`. The sidebar branch calls `clearWebviewResources()` only. (`ClineProvider.ts` ~1038–1145, ~848–915.)
2. **`onDidDispose` is currently on `this.disposables` (process-lifetime), not `webviewDisposables`.** Verified — the third argument is `this.disposables`. Finding 2's premise (relocate it to `webviewDisposables` so `clearWebviewResources()` drains it) is correct, and `setWebviewMessageListener` already pushes its binding onto `webviewDisposables` (~1722). The view-state/visibility listeners also already live on `webviewDisposables` (~1116, ~1130).
3. **`collectTaskBoard()` reads exactly one task per provider.** Verified. `taskBoard.ts` maps `getAllInstances()` → `provider.getCurrentTask()`, one row per provider, filtering `undefined`. The i-a rejection (N tasks on one sidebar registry collapses to top-of-stack) is correct against `TaskRegistry.current`.
4. **Completion does NOT drain the registry (Finding 1 fix premise).** Verified. `onTaskCompleted` (~435) writes `status: "completed"` to the history store and emits `TaskCompleted`; it calls neither `removeClineFromStack()` nor `evictCurrentTask()`. The completed task remains the registry's current task, which is exactly why a `"completed"` board row can be read. Keying the reap on the terminal event (not registry-emptiness) is the right fix.
5. **`createParallelTaskRuntime` constructs an `"editor"` provider that owns a worker task.** Verified (~3395): `new ClineProvider(…, "editor", …)`, `resolveWebviewView(panel)`, then `createTask(…, { parallelWorker: true, … })`. Worker tab-close hits the same `inTabMode` → `dispose()` path; keeping that unchanged is correct. The "discriminate by role, not by `renderContext`/registry-emptiness" conclusion is justified because workers contradict any "editor providers never own a task" invariant.
6. **`openClineInNewTab` creates an `"editor"` provider and does not itself `createTask`.** Verified (`registerCommands.ts` ~222). The command's own `newPanel.onDidDispose` only calls `setPanel(undefined, "tab")` and never aborts a task. The task is created later by the `newTask` message handler.
7. **`newTask` message → `provider.createTask(...)` on the resolving (popout) provider.** Verified (`webviewMessageHandler.ts` ~699–720). So the popout provider owns its task — this is the bug surface the design targets.
8. **`#1469` / `#1021` witnesses live in `scripts/check-task-store-concurrency.ts`, a separate submodel.** Verified. The cleanup-protocol checker (`check-task-cleanup-protocol.ts`) models `abort`/`disposal`/`reversion`/`cleanup`/`finalization` + shutdown cursor with no view/ownership state. `view-detach` writes no state the concurrency witnesses read; adding it cannot weaken them. No block.
9. **Cleanup-protocol checker has a hardcoded `/8` landmark summary and exactly 8 `expectedLandmarks`.** Verified. The `/8` literal and the 8-entry `expectedLandmarks` array both exist; the actions count is dynamic.
10. **`dispose()` is idempotent via `_disposed`, and deletes the instance from `activeInstances`.** Verified (~848, ~912). So a self-reap `void this.dispose()` on an already-reaping provider is safe.
11. **Headless provider (`view === undefined`) message posting is a safe no-op at transport.** Verified. `postMessageToWebview` guards `_disposed` and enqueues to `messageQueue`, whose callback uses `this.view?.webview.postMessage(message)` (optional chaining) wrapped in try/catch. Assumption 2's "safe no-op when headless" holds at the transport layer; the design still (correctly) asks for a confirming unit test.
12. **`TaskRegistry.current` is a single top-of-stack getter and `tasks.size === stack.length` is the stated invariant.** Verified. A view detach performs no registry mutation, so it cannot disturb `size === length`, single-current-per-provider, or delegation-stack ordering (Decision B holds).

## Unverified / Wrong Assumptions

1. **WRONG — `taskRegistry.getCurrentTaskId()` (Finding 1).** No such method on `TaskRegistry`. Use `this.getCurrentTask()?.taskId` or `this.taskRegistry.current?.taskId`.
2. **IMPRECISE — "augment `onTaskCompleted` and `onTaskAborted` after their status write + emit" (Finding 2).** `onTaskAborted` is synchronous and has no status write; the symmetric phrasing is inaccurate and the `"aborted"`-already-persisted assumption is unstated/unverified in this design.
3. **UNVERIFIED (design defers by contract) — exhaustiveness of the two editor-provider kinds (Assumption 1).** The design explicitly does NOT assert exhaustiveness; it records a required pre-implementation `grep 'new ClineProvider(' | grep '"editor"'` and defaults any unknown editor role to the safe `dispose()` path. This is an acceptable, fail-safe deferral — not a block. I did not run the grep (design review scope); the two cited call sites were verified to exist and own tasks.
4. **UNVERIFIED (acceptable) — model state-space stays within `MAX_STATES` after adding the ternary `view` field (Assumption 5).** Not run (no model-check in scope). The design's "≤3× per task, raise `MAX_STATES` explicitly if approached" plan is a reasonable, bounded mitigation.
