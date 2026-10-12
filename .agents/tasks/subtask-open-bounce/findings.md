# Findings: Subtask / Task Board click bounces to the welcome (start) page

Read-only investigation. No code was modified.

Repo: `/Users/celes/sources/celesrenata/menagerie` (Roo/Zoo Code fork, pnpm monorepo).

---

## 1. Summary (root cause)

Clicking a task or subtask does successfully resolve and open the task on the
extension host. The user is bounced to the welcome/start page by the **webview's
welcome gate**, which is recomputed on *every* `state` message:

```ts
// webview-ui/src/context/ExtensionStateContext.tsx (handleMessage, "state" case)
setShowWelcome(!checkExistKey(newState.apiConfiguration, newState.zooCodeIsAuthenticated))
```

`showTaskWithId` → `createTaskWithHistoryItem` fires one or more intermediate
`postStateToWebview()` pushes (task eviction, provider-profile activation, and the
final full push). If **any** of those pushes carries an `apiConfiguration` /
`zooCodeIsAuthenticated` combination that `checkExistKey` reads as "not
configured", `showWelcome` flips to `true`. The App then renders `WelcomeView`
because the gate is applied whenever the active tab is `chat` (or `history`):

```ts
// webview-ui/src/App.tsx
const isSetupGatedTab = showWelcome && tab !== "settings" && tab !== "marketplace"
return isSetupGatedTab ? <WelcomeView /> : ( ...ChatView/HistoryView... )
```

The gate is **not** guarded by `didHydrateState`, by whether a task is currently
active, or by any "only lower the gate, never re-raise it mid-session" rule. A
single transient state push with an under-configured `apiConfiguration` is enough
to throw the user back to the start page — which is exactly the reported symptom
for both the history list and the Task Board.

For this fork specifically the gate is fragile because the default provider is the
**Zoo Gateway**, whose credential (`zooSessionToken`) is **not** a member of
`SECRET_STATE_KEYS`. For Zoo Gateway, `checkExistKey` returns `true` only when the
posted `apiConfiguration.zooSessionToken` is present **or** the top-level
`zooCodeIsAuthenticated` flag is `true`. Any push where the current task's
`apiConfiguration` lacks `zooSessionToken` and `zooCodeIsAuthenticated` is not
`true` at that instant will raise the welcome gate.

---

## 2. Message-flow trace

### 2a. Webview click → host

Both click handlers post the same message:

- `webview-ui/src/components/history/SubtaskRow.tsx:32` — `handleClick` →
  `vscode.postMessage({ type: "showTaskWithId", text: item.id })`
- `webview-ui/src/components/history/TaskItem.tsx:39` — `handleClick` (non-selection
  branch) → same message. `TaskItem` is what the Task Board / history list renders
  for each clickable row.
- Also `ChatRow.tsx` (go-to-subtask links) and `TaskHeader.tsx` (back-to-parent)
  use the same message.

### 2b. Host handler

- `src/core/webview/webviewMessageHandler.ts:970` —
  `case "showTaskWithId": await provider.showTaskWithId(message.text!)`.
  There is **no** `try/catch` around this case, so a throw propagates to the
  caller of `webviewMessageHandler`.

### 2c. Task resolution (subtask ids DO resolve)

- `src/core/webview/ClineProvider.ts:2477` `showTaskWithId(id)`:
  ```ts
  if (id !== this.getCurrentTask()?.taskId) {
      const { historyItem } = await this.getTaskWithId(id)   // resolve
      await this.createTaskWithHistoryItem(historyItem)       // clears existing task
  }
  await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
  ```
- `getTaskWithId` (`ClineProvider.ts:2418`) → `getTaskHistoryItem(id)`
  (`ClineProvider.ts:2406`) → `this.taskHistoryStore.get(id)`.

  **Subtasks are stored flat**, not nested. Each subtask is its own `HistoryItem`
  in the task-history store with a `parentTaskId` field; the webview rebuilds the
  parent/child tree purely in `useGroupedTasks` from the flat `taskHistory` array
  (`webview-ui/src/components/history/useGroupedTasks.ts`, via `childrenMap` keyed
  on `task.parentTaskId`). Therefore a subtask id **is** present in the store and
  `getTaskWithId` resolves it normally.

  Not-found path (only if the id is genuinely absent): `getTaskWithId` throws
  `new Error("Task not found")` (`ClineProvider.ts:2426-2428`). `showTaskWithId`
  does not catch it, so for a truly missing id the open would fail with an
  unhandled rejection — but that is **not** the normal subtask case, since the id
  does exist in the store.

### 2d. State pushes during the open

`createTaskWithHistoryItem` → `createTaskWithHistoryItemUnlocked`
(`ClineProvider.ts:1384`) does several things that each can post state:

1. `evictCurrentTask()` / `removeClineFromStack()` (`ClineProvider.ts:685` / `639`)
   — tears down the current task.
2. If the restored history item has a saved mode-config or `apiConfigName`, it
   calls `activateProviderProfile(...)`
   (`ClineProvider.ts:1421`, `1463`), and
   `activateProviderProfileUnlocked` calls `await this.postStateToWebview()`
   (`ClineProvider.ts:2220`) unless `skipCurrentTaskRebuild` is set.
3. The new `Task` is constructed with `apiConfiguration` from `getState()`
   (`ClineProvider.ts:1498`, `Task` ctor `src/core/task/Task.ts:718`,
   `this.apiConfiguration = ... apiConfiguration` at `Task.ts:799`).
4. Task scheduling / first save triggers the final full `postStateToWebview()`.

Each `postStateToWebview` sends a complete `state` object built by
`getStateToPostToWebview` (`ClineProvider.ts` ~2930-3125):

```ts
apiConfiguration: currentTaskApiConfiguration ?? apiConfiguration,  // ~line 2971
...zooCodeState,   // includes zooCodeIsAuthenticated: Boolean(getCachedZooCodeToken())  (~2958, spread ~3122)
```

`currentTaskApiConfiguration = currentTask?.apiConfiguration`
(`ClineProvider.ts:2937`). So the posted `apiConfiguration` is whatever the
*current* task holds at the moment of the push — which, during the
evict/activate/rebuild window, can be a transient or under-configured value, and
during eviction there may be no current task at all (falls back to global
`apiConfiguration`).

### 2e. Webview view-render decision

- `ExtensionStateContext.tsx:350` recomputes `setShowWelcome(...)` for every
  `state` message (raw `newState.apiConfiguration`, not the merged copy — see
  `mergeExtensionState` at `ExtensionStateContext.tsx:161`, which replaces
  `apiConfiguration` wholesale).
- `App.tsx` (`isSetupGatedTab`) renders `WelcomeView` whenever `showWelcome` is
  true and the tab is not settings/marketplace. The `chatButtonClicked` action
  sets `tab = "chat"` (`App.tsx` `tabsByMessageAction`), which is a *gated* tab —
  so if `showWelcome` is true at that point, the user lands on `WelcomeView`.

This gate behavior is intentional and covered by tests:
`webview-ui/src/__tests__/App.spec.tsx` — "keeps history behind the welcome gate
while setup is incomplete" and "shows welcome view when setup is incomplete".
Those tests confirm that `showWelcome === true` hides history and chat and shows
the welcome view. The bug is that `showWelcome` is being set `true` transiently
during a legitimate task open.

---

## 3. Why `checkExistKey` can report "not configured" mid-open

`src/shared/checkExistApiConfig.ts`:

```ts
export function checkExistKey(config, zooCodeIsAuthenticated?) {
  if (!config) return false
  // fakeAi / openaiCodex / qwenCode -> true
  // kimiCode oauth -> true
  if (config.apiProvider === providerIdentifiers.zooGateway) {
    return Boolean(config.zooSessionToken) || Boolean(zooCodeIsAuthenticated)
  }
  const providerSecretKeys = SECRET_STATE_KEYS.filter(...)
  const hasSecretKey = providerSecretKeys.some(key => config[key] !== undefined)
  const hasOtherConfig = [awsRegion, vertexProjectId, ollamaModelId, lmStudioModelId, vsCodeLmModelSelector].some(v => v !== undefined)
  return hasSecretKey || hasOtherConfig
}
```

Key facts:

- `zooSessionToken` is **not** in `SECRET_STATE_KEYS`
  (`packages/types/src/global-settings.ts:482-516` — list enumerated, no
  `zooSessionToken`/`zooGateway*` entry). The comment in `checkExistApiConfig.ts`
  explicitly calls this out.
- Therefore for the Zoo Gateway provider the gate hangs entirely on
  (a) `config.zooSessionToken` being present in the posted config, or
  (b) `zooCodeIsAuthenticated` (top-level) being `true` at push time.

Failure conditions that bounce the user, each plausible during a task open:

1. The current task's `apiConfiguration` (what gets posted via
   `currentTaskApiConfiguration ?? apiConfiguration`) does not carry
   `zooSessionToken` (e.g. a profile that authenticates via the global
   `zoo-code-auth` login rather than a per-profile token), **and**
   `getCachedZooCodeToken()` returns falsy at the instant of that specific push
   (cache not yet populated / token refresh in flight) → `zooCodeIsAuthenticated:
   false` → gate raised.
2. A transient push during eviction where no current task is active and the global
   `apiConfiguration` is an incomplete/empty default profile (the restore code at
   `ClineProvider.ts:1437-1444` explicitly warns that profiles can be empty
   "id + name only"). `checkExistKey` → `false`.
3. More generally: because the gate is re-evaluated on every push and the posted
   `apiConfiguration` is task-scoped, any task whose config does not independently
   satisfy `checkExistKey` will raise the welcome gate the moment it becomes the
   current task.

For a non-Zoo-Gateway provider configured with a normal API key the key is a
secret in `SECRET_STATE_KEYS`; whether it survives into the posted state (secrets
are often stripped on serialization) determines whether those users see the same
bounce. The Zoo Gateway path is the most exposed because its credential is
intentionally outside `SECRET_STATE_KEYS`.

---

## 4. Recent history relevant to this area

`git log --oneline -40 -- webview-ui/src/components/history src/core/webview`
surfaced prior fixes for this exact class of bug — strong evidence it is a
recurring regression that the recent large cherry-pick/reapply (see
`progress.txt`) is prone to reintroducing:

- `cd09db10e` **[Fix] Child task view returns to Home during state updates (#1458)**
  — reorders the `clineMessagesSeq` increment in `postStateToWebview`
  (`++this.clineMessagesSeq` captured *before* building state). This fix **is
  present** in the current tree (`ClineProvider.ts:2606` and `2621`). It protects
  `clineMessages` from stale pushes, but it does **not** protect `showWelcome`.
- `8d296deef` **[Fix] Task history disappears when user reopens a task (#1319)**
- `2ecbf35a8` **[Fix] Task history can disappear when users restart after completion (#1452)**
- `1dbe3bd22` **[Fix] Restore subtask approvals when users return to tasks (#1320)**
- `45968c042` **fix(webview): dismiss welcome after Zoo Gateway sign-in (#961)** —
  this is the commit that changed the gate to
  `checkExistKey(newState.apiConfiguration, newState.zooCodeIsAuthenticated)`
  (confirmed via `git log -L` on `ExtensionStateContext.tsx`). It fixed sign-in
  but left the per-push recomputation fragile.

The `clineMessagesSeq` sequence guard (in `mergeExtensionState`,
`ExtensionStateContext.tsx:179-188`) deliberately protects `clineMessages` from
out-of-order pushes. **No equivalent guard exists for `showWelcome`** — that is
the gap.

---

## 5. Most likely root cause + exact locations to change

### Primary root cause
`showWelcome` is recomputed from the raw per-push `apiConfiguration` /
`zooCodeIsAuthenticated` on every `state` message, with no guard against transient
under-configured pushes and no "do not re-raise the gate once a task/session is
active" rule.

- `webview-ui/src/context/ExtensionStateContext.tsx:350`
  (`setShowWelcome(!checkExistKey(newState.apiConfiguration, newState.zooCodeIsAuthenticated))`)
- Gate application: `webview-ui/src/App.tsx` — `isSetupGatedTab` /
  `return isSetupGatedTab ? <WelcomeView /> : (...)` (the two lines around
  `const isSetupGatedTab = showWelcome && tab !== "settings" && tab !== "marketplace"`).

### Contributing / secondary issues
- `src/core/webview/ClineProvider.ts` `getStateToPostToWebview`
  (`apiConfiguration: currentTaskApiConfiguration ?? apiConfiguration`, ~line 2971;
  `...zooCodeState` with `zooCodeIsAuthenticated: Boolean(getCachedZooCodeToken())`,
  ~line 2958 / spread ~3122) — the posted config is task-scoped and the auth flag
  is time-sensitive, so transient pushes can legitimately look "unconfigured".
- `src/shared/checkExistApiConfig.ts` + `packages/types/src/global-settings.ts:482`
  — Zoo Gateway credential (`zooSessionToken`) is outside `SECRET_STATE_KEYS`, so
  the gate depends on a volatile auth flag for the fork's default provider.
- `src/core/webview/ClineProvider.ts:1421/1463/2220` — intermediate
  `postStateToWebview()` during profile activation inside the task-open path
  creates extra pushes that each re-evaluate the gate.

---

## 6. Recommended fix approach (do not implement here)

Preferred, smallest-blast-radius fix — make the welcome gate "sticky" so it is
never re-raised by a transient mid-session push:

1. In `ExtensionStateContext.tsx` only *lower* the welcome gate, and only clear it
   once; never flip `showWelcome` back to `true` on a later push during the same
   session once a task/config has been seen as valid. Concretely: track the last
   known-good configured state and keep `showWelcome` false once it has been false,
   unless an explicit sign-out / config-reset signal arrives. This mirrors the
   existing `clineMessagesSeq` "don't regress on stale pushes" pattern.

2. Alternatively (or additionally), gate the recomputation so it only runs when the
   push actually carries provider-config fields, instead of on every `state`
   message. Pushes that omit/transiently-blank `apiConfiguration` should not be
   able to raise the gate.

3. Harden `getStateToPostToWebview` so the posted `apiConfiguration` for an active
   task cannot regress to an under-configured value mid-open, and ensure
   `zooCodeIsAuthenticated` reflects authenticated state consistently across the
   evict → activate → rebuild window (e.g. read the authoritative auth state rather
   than a cache that may be cold during the transition).

Also add a regression test at the webview layer (per `webview-ui/AGENTS.md`,
Vitest + JSDOM): simulate a sequence of `state` pushes during a task open where an
intermediate push has an under-configured `apiConfiguration`, and assert the view
does not revert to `WelcomeView` once a valid-config state has been applied. This
is the lowest layer that reproduces the bug (`App.spec.tsx` already models the
gate), so the regression test belongs in `webview-ui/src/__tests__` /
`src/context/__tests__`, not in `apps/vscode-e2e`.

---

## 7. Verification notes

- Static investigation only; the build/tests were not run (per the brief).
- Subtask id resolution was verified by reading `getTaskHistoryItem` /
  `getTaskWithId` and `useGroupedTasks` (flat store + client-side tree). Subtask
  ids resolve; the bounce is a view-gating problem, not a resolution problem.
- The `#1458` ordering fix is present but does not cover `showWelcome`; that is the
  key remaining gap.
