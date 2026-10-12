# Sticky webview welcome gate so opening a task no longer bounces to WelcomeView

Opening a task or subtask from the history view / Task Board was bouncing the user back to the welcome/start page. The webview recomputed `showWelcome` on every `"state"` message from `checkExistKey(apiConfiguration, zooCodeIsAuthenticated)`, and the intermediate pushes emitted during `showTaskWithId -> createTaskWithHistoryItem` carry a transient, task-scoped, under-configured `apiConfiguration` plus a momentarily cold auth flag — which flipped `showWelcome` back to `true` and rendered `WelcomeView` over the chat/history tab. The fix makes the gate sticky: once a configured state lowers it, the gate latches for the session and a task-scoped push can no longer re-raise it; only an authoritative, non-task-scoped unconfigured push (sign-out / config reset) re-raises. The change is small and localized to `ExtensionStateContext.tsx` plus a new regression test.

Watch for: the re-raise discriminator is `currentTaskId === undefined` (confirmed) — this correctly separates transient task-scoped pushes from authoritative global ones, verified against `ClineProvider.getStateToPostToWebview`. One minor process note: the referenced `findings.md` is absent from the task directory (confirmed), but the root cause is independently confirmed from source and the verification note, so it is non-blocking.

**Verdict**: APPROVED

## High-level view

The gate is genuinely sticky. `hasLoweredWelcomeGateRef` latches once a configured state is seen, and the only path that re-raises after that is an under-configured push with `currentTaskId === undefined`. Task-scoped pushes (`currentTaskId` defined) can never re-raise, which is exactly the transient window the bug occurred in. This mirrors the existing `clineMessagesSeq` "don't regress on stale pushes" guard in the same file.

The fix correlation is sound against the real producer. `ClineProvider.getStateToPostToWebview()` emits `apiConfiguration: currentTaskApiConfiguration ?? apiConfiguration` alongside `currentTaskId: currentTask?.taskId`, so during a task open the under-configured apiConfiguration always travels with a defined `currentTaskId`. Keying the guard on `currentTaskId` is therefore the right discriminator, not a heuristic.

Fresh-install and sign-in behavior are preserved. An unconfigured push while the gate has never been lowered still shows `WelcomeView` (first run); a configured push always lowers the gate (sign-in dismisses welcome). The existing `App.spec.tsx` welcome-gate assertions are untouched by this diff, so that coverage is intact, and the new spec adds direct first-run, sign-in, and sign-out cases.

The regression test lives in `webview-ui` and drives the real three-push sequence (valid -> task-scoped under-configured -> valid), asserting `showWelcome` stays `false`. The verification note reports it fails without the fix and passes with it, and the test structure is consistent with that claim.

No changesets, no CHANGELOG edits, and no suppression-count regressions. The two touched source files are both under `webview-ui/`, outside the `src/eslint-suppressions.json` ledger, and the verification note confirms a clean `--max-warnings=0` lint run.

<details>
<summary>Issues (1)</summary>

1. **Missing findings.md (non-blocking)** — the task directory contains only `verification.md`; the `findings.md` referenced by the review brief is absent. Root cause is independently confirmed from `ClineProvider.ts` and the verification note, so no action required beyond noting it.

</details>

<details>
<summary>Details</summary>

## Stickiness via a latched ref, mirroring the clineMessagesSeq guard

The gate logic replaces the unconditional `setShowWelcome(!checkExistKey(...))` with a four-way branch keyed on a session-scoped `useRef`:

```tsx
const isConfigured = checkExistKey(newState.apiConfiguration, newState.zooCodeIsAuthenticated)
if (isConfigured) {
	hasLoweredWelcomeGateRef.current = true
	setShowWelcome(false)
} else if (!hasLoweredWelcomeGateRef.current) {
	setShowWelcome(true)                       // first run, never lowered
} else if (newState.currentTaskId === undefined) {
	hasLoweredWelcomeGateRef.current = false   // authoritative global reset
	setShowWelcome(true)
}
// else: gate lowered AND task-scoped push -> keep gate down
```

This is the same shape as the existing `clineMessagesSeq` guard in `mergeExtensionState` ("apply the newer value, ignore stale/regressing pushes"). The latch is a `useRef`, not state, so it does not itself trigger a re-render and persists across pushes within the provider's lifetime — the correct choice for a per-session latch.

The requirement that a lowered gate can only be re-raised by an explicit sign-out / config-reset is satisfied: the re-raise branch is gated on `currentTaskId === undefined` (a non-task-scoped push). A transient task-scoped under-configured push lands in the final no-op branch and leaves `showWelcome` untouched.

## The currentTaskId discriminator matches the real producer

The discriminator is not a heuristic. `ClineProvider.getStateToPostToWebview()` returns:

```ts
apiConfiguration: currentTaskApiConfiguration ?? apiConfiguration,
...
currentTaskId: currentTask?.taskId,
```

So whenever the webview receives the task-scoped `currentTaskApiConfiguration` (the under-configured value that caused the bounce), that same push also carries a defined `currentTaskId`. Conversely, a sign-out / config reset with no active task pushes the global `apiConfiguration` with `currentTaskId` undefined. Keying the re-raise on `currentTaskId === undefined` therefore cleanly partitions "transient task-scoped" from "authoritative global", which is exactly what requirement 1 asks for.

## Fresh-install and sign-in / sign-out preserved

First-run: before any configured state is seen, `hasLoweredWelcomeGateRef.current` is `false`, so an unconfigured push takes the `else if (!hasLoweredWelcomeGateRef.current)` branch and shows `WelcomeView`. Sign-in: any configured push takes the first branch, lowers and latches the gate. Sign-out after lowering: an unconfigured push with no active task takes the third branch, resets the latch, and re-raises the gate.

`App.spec.tsx` is not modified by this diff, so its welcome-gate assertions (welcome shown when setup incomplete, history gated behind welcome, view switching while gated, dismissal on settings import) remain in force. The new `welcomeGateSticky.spec.tsx` adds dedicated first-run ("still shows the welcome gate on a genuinely unconfigured fresh install") and sign-in ("dismisses the welcome gate when sign-in completes") cases, so both required scenarios have explicit coverage.

## Regression test exercises the bug path

`welcomeGateSticky.spec.tsx` lives in `webview-ui/src/context/__tests__/` (not `apps/vscode-e2e`), renders the real `ExtensionStateContextProvider`, and dispatches actual `MessageEvent`s of `type: "state"`. The key case drives the exact failing sequence:

1. configured push -> `showWelcome` false
2. task-scoped under-configured push (`zooCodeIsAuthenticated: false`, `currentTaskId: "task-123"`) -> asserts `showWelcome` stays false
3. configured push again -> still false

Without the sticky guard, step 2 would recompute `showWelcome` to `true` (unconfigured apiConfiguration + cold auth), so the assertion at step 2 is what fails pre-fix — consistent with the verification note's reported `expected true to be false`. The test genuinely exercises the fix rather than asserting a tautology, because the task-scoped push it sends is under-configured and would flip the gate under the old unconditional recompute. The other three cases (fresh install, sign-in, sign-out) lock in the preserved behaviors.

## Hygiene checks

Changed files: `.agents/tasks/subtask-open-bounce/verification.md` (doc), `webview-ui/src/context/ExtensionStateContext.tsx` (fix), `webview-ui/src/context/__tests__/welcomeGateSticky.spec.tsx` (test). No `.changeset` files and no `CHANGELOG.md` / `src/CHANGELOG.md` edits (confirmed via `--name-only`). Both touched code files are under `webview-ui/`, outside the `src/eslint-suppressions.json` ledger, which the diff does not modify; the verification note confirms a clean `eslint ... --max-warnings=0` run on both.

</details>

<details>
<summary>File map</summary>

- `webview-ui/src/context/ExtensionStateContext.tsx` — sticky welcome-gate branch keyed on a `useRef` latch + `currentTaskId`; adds `useRef` import.
- `webview-ui/src/context/__tests__/welcomeGateSticky.spec.tsx` — new regression test: sticky-on-task-open, fresh install, sign-in, sign-out.
- `.agents/tasks/subtask-open-bounce/verification.md` — coder's verification note.

Full diff: `git -C /Users/celes/sources/celesrenata/menagerie/.worktrees/fix-welcome-gate-sticky diff main...fix/welcome-gate-sticky`

</details>
