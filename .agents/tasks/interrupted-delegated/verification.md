# Verification: fix `interrupted → delegated` fan-out loop on subtask open

Chosen approach: **(b)** — do NOT widen `VALID_TASK_STATUS_TRANSITIONS`. The reducer
(`taskLifecycle.ts`) and the lifecycle model are left unchanged; the fix stops the caller
from ever attempting the illegal transition and short-circuits the stale-pending-action
replay that drove the loop.

## Changes

1. `src/core/webview/ClineProvider.ts` — `delegateParentAndOpenChildUnlocked` (Change 1 + 3):
   - Pre-child-creation guard: if the authoritative parent status is `interrupted` or
     `completed`, throw a clear, non-retried error **before** flush, parent disposal, or
     child creation. `undefined` status still defaults to `active` (model semantics), so
     normal delegation is unaffected.
   - Documented step-5 rollback as bounded to a single attempt (no retry); with Change 1 it
     is now reached only for genuine persistence faults on an otherwise-delegatable parent.
2. `src/core/task/Task.ts` — `resumePendingTaskAction` `create_subtask` branch (Change 2):
   - When this task's own persisted status is `interrupted`/`completed`, clear the stale
     pending action and fall through to the normal resume path instead of delegating.
   - For an active parent, delegate exactly once; a thrown delegation error surfaces once
     and is never re-entered into resume (that re-entry was the fan-out loop).
   - Control flow preserved: the completion-kind `reopenParentFromDelegation` branch now
     sits in an explicit `else` (previously reached via the create_subtask early `return`).

No change to `src/core/task-persistence/taskLifecycle.ts` or `VALID_TASK_STATUS_TRANSITIONS`.

## Regression tests (lowest layer that reproduces the bug)

- `src/__tests__/resume-pending-create-subtask.spec.ts` (NEW): drives `Task.resumePendingTaskAction`
  directly.
  - interrupted/completed parent → clears stale action, does NOT delegate, falls through.
  - active parent → delegates exactly once with the right payload.
  - delegation that throws the lifecycle error is invoked at most once (no retry loop).
- `src/__tests__/ClineProvider.delegation.spec.ts` (ADDED cases): interrupted/completed parent
  is rejected BEFORE `createTask` / `atomicReadAndUpdate` and without `createTaskWithHistoryItem`
  (no re-resume) — i.e. a single failure cannot fan out into child creation.

Reducer-model note: `scripts/check-task-lifecycle.ts` never generates an interrupted-parent
delegate transition, so it could not have failed for this defect; the bug lives entirely in
the provider/task caller wiring. Tests therefore belong at the provider/task unit layer, not
the reducer model and not E2E.

## Fails-without-fix confirmation

With both source files stashed (tests kept):
`pnpm --dir src exec vitest run __tests__/resume-pending-create-subtask.spec.ts __tests__/ClineProvider.delegation.spec.ts`
→ **4 failed | 18 passed** (the 2 new short-circuit tests + the 2 new interrupted/completed
guard cases all fail). Fix restored via `git stash pop`.

## Commands run (from the worktree root) and results

- `pnpm install --frozen-lockfile` → OK (worktree had no node_modules).
- `pnpm lifecycle:model-check` → **PASS**, unchanged (task-lifecycle, task-store-concurrency,
  provider-handoff-scheduler, cleanup-protocol, parser-scope, completion-persistence,
  delegated-mode-readers all green).
- `pnpm --dir src exec vitest run __tests__/resume-pending-create-subtask.spec.ts __tests__/ClineProvider.delegation.spec.ts __tests__/new-task-delegation.spec.ts`
  → **23 passed**.
- `pnpm --dir src exec vitest run core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts __tests__/ClineProvider.history-resume-delegation.spec.ts`
  → **86 passed** (interrupted→active / implicit interrupted→delegated rejection assertions
  still green; transition table not loosened).
- `pnpm --dir src exec vitest run core/task-persistence/__tests__/taskLifecycle.spec.ts`
  → **7 passed**.
- `pnpm --dir src check-types` (`tsc --noEmit`) → **PASS**.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts core/task/Task.ts __tests__/ClineProvider.delegation.spec.ts __tests__/resume-pending-create-subtask.spec.ts`
  → **clean, no new suppressions** (exit 0).

## Not run (and why)

Full `pnpm test` was not run: it is the whole monorepo suite and is too broad/slow for this
environment. The focused suites above cover every file touched (provider delegation, task
resume, reducer, reconciliation, history-resume) plus typecheck and the full model-check,
which is the governing safety gate for lifecycle changes.
