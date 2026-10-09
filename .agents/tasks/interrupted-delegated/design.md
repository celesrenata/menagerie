# Design: Fix `interrupted → delegated` fan-out loop on subtask open

## Chosen approach

**Approach (b): the `interrupted → delegated` transition should NOT be attempted.** The lifecycle model has no legitimate "interrupted parent re-delegates" state; the bug is a stale `create_subtask` pending action being replayed against an interrupted parent, and the rollback re-resumes the parent and replays the same stale action forever. The fix routes delegation through the model's existing allowed path (and short-circuits the replay), rather than widening `VALID_TASK_STATUS_TRANSITIONS`.

## Root cause

Clicking a subtask in history calls `ClineProvider.showTaskWithId(id)` → `createTaskWithHistoryItem(historyItem)`, which rehydrates and resumes the task. During resume (`Task.resumeTaskFromHistory`, `src/core/task/Task.ts` ~2689), if the rehydrated task still carries a `pendingAction` whose `tool_result` is not yet in API history, it calls `resumePendingTaskAction(this.pendingAction)`.

For a `create_subtask` pending action (`src/core/task/Task.ts` ~2896), `resumePendingTaskAction` calls `provider.delegateParentAndOpenChild({ parentTaskId, ... })`. Inside `delegateParentAndOpenChildUnlocked` (`src/core/webview/ClineProvider.ts` ~4172):

1. Step 4 creates a brand-new child task (new generated id each attempt).
2. Step 5 calls the reducer `delegateTaskToChild(historyItem, child.taskId, awaitedChildStatus)` (`src/core/task-persistence/taskLifecycle.ts`).

`delegateTaskToChild` only special-cases a parent whose status is `delegated` (it severs `delegated → active → delegated` when the awaited child is `interrupted`). When the parent's own status is **`interrupted`**, it falls straight through to `assertValidTransition("interrupted", "delegated")`, which throws `Invalid task status transition: interrupted → delegated` because `VALID_TASK_STATUS_TRANSITIONS.interrupted = ["completed"]`.

The throw is caught by step 5's `catch`, which rolls back: it deletes the just-created child and **restores the parent via `createTaskWithHistoryItem(parentHistory)`**. That restore re-resumes the parent, whose `pendingAction` is still present and still unresolved (the delegation never completed, so the `tool_result` was never written and `clearPendingActionAfterDurableResult` never ran) → `resumePendingTaskAction` fires again → new child id → same throw → same rollback. This is the hot retry/fan-out loop: one parent id, hundreds of distinct generated child ids, one every few ms. Because each iteration tears down and reinstalls the task stack, the webview is repeatedly reset to the home/start surface and appears "stuck."

Why is the parent `interrupted` at all? A parent that delegated and was then evicted via navigation/new-task/clear is marked through `markDelegatedChildInterrupted` / eviction paths; the persisted `pendingAction` from the original `create_subtask` approval survives on the history item. On reopen it is replayed against a parent that is no longer in a delegatable state.

## Why this is approach (b), grounded in the lifecycle model invariants

- The model (`docs/architecture/task-lifecycle-model.md`, "Invariants" #4 and the production mapping) treats `interrupted` as the status of a prior **child** that was evicted: *"An interrupted prior child may retain lineage after re-delegation but cannot complete back into that parent."* Re-delegation is modeled only as `delegated → active → delegated`, driven by `delegateTaskToChild` when the parent is `delegated` and its awaited child is `interrupted`. There is no modeled action, landmark, or invariant in which a task whose own status is `interrupted` becomes `delegated`.
- The model-check explorer (`scripts/check-task-lifecycle.ts`) never generates a delegate transition from an `interrupted` parent: its `transitions()` guard only enables `delegate` when `parent.status === "active"` or (`delegated` with an interrupted awaited child). Adding `interrupted → delegated` to `VALID_TASK_STATUS_TRANSITIONS` would make the reducer accept a state the model has no action for and whose invariants were never designed to hold (e.g. an interrupted task carries no valid delegation pointers, and invariant #3 "non-delegated parents retain no active delegation pointer" plus #4 would need re-derivation). Allowing it would weaken the proven safety envelope for no modeled benefit.
- Therefore the correct fix is to stop the caller from ever attempting the transition, not to admit it.

## The fix

Two coordinated changes: (1) stop replaying a stale/invalid `create_subtask` pending action, and (2) short-circuit re-delegation when it is unnecessary. Both live outside the reducer; `taskLifecycle.ts` and `VALID_TASK_STATUS_TRANSITIONS` are left unchanged.

### Change 1 — guard delegation against a non-delegatable parent (stops the illegal transition and the fan-out)

In `delegateParentAndOpenChildUnlocked` (`src/core/webview/ClineProvider.ts`), **before** creating the child in step 4, read the authoritative parent status (the code already invalidates + reads `authoritativeParent` for the `delegated` case) and reject early when the parent is in a state the model cannot delegate from:

- If `authoritativeParent?.status` is `interrupted` or `completed` (anything other than `active`, or `delegated`-with-interrupted-awaited-child which the existing block already validates), throw a clear, **non-retried** error (e.g. `Parent <id> is not in a delegatable state (<status>); skipping stale delegation`) *before* any child is created.

Moving this guard ahead of child creation means the failure path no longer creates-then-deletes a child, and — critically — the error no longer flows through step 5's rollback that calls `createTaskWithHistoryItem(parentHistory)`. That removes the re-resume that drives the loop.

### Change 2 — do not replay a stale `create_subtask` pending action on resume (stops the loop at its source)

In `resumePendingTaskAction` / the resume path (`src/core/task/Task.ts` ~2689 and ~2896), make the `create_subtask` replay self-limiting and non-looping:

- Before calling `provider.delegateParentAndOpenChild(...)`, confirm the parent is still delegatable. If the task's own persisted status is `interrupted`/`completed` (read via `provider.taskHistoryStore.get(this.taskId)?.status`), the original delegation already resolved or was superseded: **clear the stale pending action** (`clearPendingActionAfterDurableResult(action.actionId)`) and fall through to the normal resume ask instead of delegating. This matches the existing precedent at ~2689 where a pending action is cleared once its `tool_result` is already present in API history.
- Ensure the delegation call is **not** retried on failure within this path: a single failed `delegateParentAndOpenChild` must surface once and stop, never re-enter resume. (The existing `else`-recursion into `resumePendingTaskAction` at ~2920 is for the *denied/alternate* branch after a durable result; the `create_subtask` success branch must not loop back into resume on a thrown delegation error.)

### Change 3 — delegation rollback must not re-resume into the same stale action

Even with Changes 1–2, harden step 5's `catch` in `delegateParentAndOpenChildUnlocked` so a persistence failure cannot resurrect the loop: when restoring the parent via `createTaskWithHistoryItem(parentHistory)` after a failure, the restored parent must not carry a pending `create_subtask` action that would immediately re-delegate. Since Change 1 now fails *before* child creation for the `interrupted` case, this rollback branch is reached only for genuine persistence faults on an otherwise-delegatable parent; keep its single-attempt semantics (it already rethrows `err` once) and do not add any retry. Document that step 5's rollback is bounded to one attempt per call and relies on the caller not re-invoking delegation for the same stale action.

Net effect: a single parent-metadata persistence failure results in at most one child create/rollback and one surfaced error — never hundreds of per-child attempts.

## Model-check implications

None required. Because this is approach (b), `VALID_TASK_STATUS_TRANSITIONS`, the reducers in `taskLifecycle.ts`, the model actions/invariants, and the named semantic landmarks are all unchanged. `pnpm lifecycle:model-check` must still pass unchanged — run it to confirm no reducer behavior drifted. The reconciliation spec assertions that `interrupted → active` and the implicit `interrupted → delegated` are rejected remain valid and must stay green (`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`).

## Loop-elimination summary

- **Origin of the loop:** step 5 `catch` in `delegateParentAndOpenChildUnlocked` restores the parent via `createTaskWithHistoryItem`, which re-resumes it, re-firing the unresolved `create_subtask` pending action → a new child id and the same illegal transition each time.
- **Bound/short-circuit:** Change 1 rejects a non-delegatable parent before any child is created (no fan-out of child ids); Change 2 clears the stale pending action on resume so the replay stops; Change 3 keeps the rollback to a single bounded attempt. The illegal transition is never attempted, and a legitimate persistence failure cannot fan out.

## Regression test (lowest layer that would have failed)

Primary coverage is **package-local unit tests** in `src/core/webview/__tests__` / `src/__tests__` against `ClineProvider` and `Task` doubles, matching the existing `ClineProvider.delegation.spec.ts` and `new-task-delegation.spec.ts` patterns:

1. **ClineProvider delegation guard** (`src/__tests__/ClineProvider.delegation.spec.ts`): with `authoritativeParent.status === "interrupted"`, assert `delegateParentAndOpenChild` rejects **before** `createTask` is called (spy on `createTask` → not called) and does **not** call `createTaskWithHistoryItem` (no re-resume). This directly covers "one failure must not fan out into child creation."
2. **Task resume short-circuit** (`src/__tests__/new-task-delegation.spec.ts` or a sibling): a task rehydrated with status `interrupted` and a stale `create_subtask` `pendingAction` must, on `resumeTaskFromHistory`/`resumePendingTaskAction`, clear the pending action and **not** call `provider.delegateParentAndOpenChild`.
3. **No-loop assertion:** drive the resume path with a provider stub whose `delegateParentAndOpenChild` would throw the lifecycle error, and assert it is invoked at most once (not repeatedly) — proving the fan-out is gone.

The reducer-level model (`check-task-lifecycle.ts`) would **not** have failed for this bug: the explorer never generates an `interrupted`-parent delegate transition, so the defect lives entirely in the provider/task caller wiring (stale pending-action replay + rollback re-resume), which the reducer model does not represent. Hence the regression tests belong at the provider/task unit layer, not the reducer model, and not E2E (the extension-host boundary is not required to reproduce the stale-replay loop; a `Task`/`ClineProvider` double reproduces it deterministically). Keep the existing `interrupted → active`/`interrupted → completed` reducer assertions as the guard that the transition table was not loosened.

## Files to change

- `src/core/webview/ClineProvider.ts` — add the pre-child-creation delegatable-parent guard in `delegateParentAndOpenChildUnlocked` (Change 1); keep step 5 rollback single-attempt and documented (Change 3).
- `src/core/task/Task.ts` — in `resumePendingTaskAction` / resume path, clear a stale `create_subtask` pending action against an interrupted/completed parent and avoid re-entry/retry (Change 2).
- `src/__tests__/ClineProvider.delegation.spec.ts` and `src/__tests__/new-task-delegation.spec.ts` (or a new sibling spec) — regression tests 1–3 above.
- No change to `src/core/task-persistence/taskLifecycle.ts` or `VALID_TASK_STATUS_TRANSITIONS`.

## Verification

- `pnpm --dir src exec vitest run src/__tests__/ClineProvider.delegation.spec.ts src/__tests__/new-task-delegation.spec.ts` — new regression tests pass.
- `pnpm --dir src exec vitest run src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts` — transition-table assertions still pass unchanged.
- `pnpm lifecycle:model-check` — passes unchanged (no reducer/model edits).
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <edited files>` — suppression counts do not increase (per AGENTS.md).
