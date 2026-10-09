# Verification — subtask-open-bounce (sticky welcome gate)

## Bug

Clicking a task/subtask in the history view / Task Board bounced the user back to the
welcome/start page instead of opening the task.

Root cause: `ExtensionStateContext.tsx` recomputed
`setShowWelcome(!checkExistKey(newState.apiConfiguration, newState.zooCodeIsAuthenticated))`
on **every** `"state"` message. During `showTaskWithId -> createTaskWithHistoryItem`,
intermediate `postStateToWebview()` pushes carry a transient, task-scoped,
under-configured `apiConfiguration` (`ClineProvider` pushes
`currentTaskApiConfiguration ?? apiConfiguration` together with a `currentTaskId`) and a
momentarily cold `zooCodeIsAuthenticated`. That flipped `showWelcome` back to `true`, and
`App.tsx`'s `isSetupGatedTab` rendered `WelcomeView` over the chat/history tab.

## Fix

Made the welcome gate sticky in `ExtensionStateContext.tsx`, mirroring the existing
`clineMessagesSeq` "don't regress on stale pushes" pattern:

- A valid, configured push lowers the gate and latches it for the session
  (`hasLoweredWelcomeGateRef`).
- An unconfigured push while the gate has never been lowered keeps the first-run behavior
  (shows `WelcomeView`).
- Once the gate is lowered, a **task-scoped** push (`currentTaskId !== undefined`) can
  never re-raise it — this is the transient task-scoped `apiConfiguration` seen during a
  task open.
- Only an authoritative, **non-task-scoped** unconfigured push (`currentTaskId === undefined`,
  e.g. sign-out / config reset reflected in the global `apiConfiguration`) re-raises the gate.

Fresh-install first-run and sign-in-dismisses-welcome behavior are preserved.

## Files changed

- `webview-ui/src/context/ExtensionStateContext.tsx` — sticky gate logic + `useRef` import.
- `webview-ui/src/context/__tests__/welcomeGateSticky.spec.tsx` — new regression test (added).

## Commands run (from `webview-ui/`, inside the worktree)

1. Install (worktree had no `node_modules`):
   `pnpm install --frozen-lockfile` (from repo root) — PASS, lockfile unchanged.

2. Targeted Vitest suites, single-run:
   `pnpm exec vitest run src/context/__tests__/welcomeGateSticky.spec.tsx src/context/__tests__/ExtensionStateContext.spec.tsx src/__tests__/App.spec.tsx`
   — PASS: 3 files, 43 tests passed.

3. Regression confirmation (fix stashed, new test only):
   `pnpm exec vitest run src/context/__tests__/welcomeGateSticky.spec.tsx`
   — FAIL without the fix: "keeps the welcome gate down when a task-scoped under-configured
   push follows a valid state" fails (`expected true to be false`). The other 3 cases
   (first-run, sign-in, sign-out) pass with or without the fix. Fix restored afterward.

4. Type check: `pnpm exec tsc` — PASS (no errors).

5. Lint: `pnpm exec eslint src/context/ExtensionStateContext.tsx src/context/__tests__/welcomeGateSticky.spec.tsx --ext=ts,tsx --max-warnings=0`
   — PASS (0 warnings). No `src/` files were touched, so no eslint-suppressions change.
