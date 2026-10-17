# Menagerie Next-Level Lift — Cross-Cutting Contracts (frozen for waves)

This document is the integration owner's contract for the parallel workstreams. It is frozen
before implementation starts; if a workstream discovers a contract gap, it reports the gap to
the integration owner instead of improvising a second contract.

- Target: `celesrenata/menagerie` @ `d841deb10` (baseline)
- Companion docs: `docs/performance/menagerie-lift-baseline.md`, `docs/performance/menagerie-lift-execution-plan.md`

## 1. Task identity & summary (P1 produces, P2 consumes)

Source of truth: `src/core/task/session/types.ts` (new). The observer remains read-only; a new
command service owns mutations/navigation.

```ts
/** Stable, persisted identity. Never derived from array position or "last active" instance. */
export interface TaskRef {
	/** Extension-host owner id (window-scoped); persisted and revalidated on activation. */
	hostId: string
	/** Workspace root URI (file:// or virtual scheme), string form for portability. */
	workspaceUri: string
	/** Existing task id (uuid). Reused; never regenerated on navigation. */
	taskId: string
}

export type TaskStatus = "queued" | "running" | "waiting-input" | "review" | "completed" | "failed" | "cancelled"

export interface TaskSummary {
	ref: TaskRef
	parentTaskId?: string
	/** Worker mode slug, e.g. "code", "project-reader". */
	role: string
	/** OmniRoute route id if pinned (e.g. "hybrid/code"); undefined otherwise. */
	route?: string
	status: TaskStatus
	/** Truncated task title (first line of the first message), ≤ 120 chars. */
	title: string
	changedFileCount: number
	pendingApprovalCount: number
	lastMeaningfulEventAt: number
	/** Monotonic per-task revision; board reconciles on gaps. */
	revision: number
}

export type TaskCommand =
	| { kind: "open"; ref: TaskRef; destination?: "task-hub" | "editor" }
	| { kind: "inspect-diff"; ref: TaskRef; path?: string }
	| { kind: "resume"; ref: TaskRef }
	| { kind: "cancel"; ref: TaskRef; confirmed: true }
```

Commands must validate host ownership, task state, parent relationships, and permissions. All
messages carry a versioned schema, a correlation id, and an explicit success/error response.
Event streams use monotonic `(taskId, sequence)`; a dropped sequence triggers snapshot
reconciliation. Never expose API keys or raw prompts in board JSON snapshots or logs.

## 2. TaskSessionRegistry (P1)

```ts
export interface TaskSessionRegistryApi {
	register(handle: TaskRuntimeHandle): void
	unregister(ref: TaskRef): void
	/** Live + persisted local tasks. Stable order by (workspaceUri, taskId). */
	summaries(): TaskSummary[]
	/** Resolve by stable id. Returns null if the task is unknown or owned by another host. */
	get(ref: TaskRef): TaskRuntimeHandle | null
	/** Ephemeral view bindings: zero or many clients per task. Detach never cancels. */
	attachView(ref: TaskRef, client: TaskViewClient): void
	detachView(ref: TaskRef, client: TaskViewClient): void
	onEvent(cb: (e: { ref: TaskRef; sequence: number; summary: TaskSummary }) => void): () => void
}
```

`TaskRuntimeHandle` wraps the existing task/provider/runtime without transplanting provider
state into every worker. ClineProvider stays a compatibility adapter until tests pass.

**Invariants (spec §2, non-negotiable):**
1. Task lifetime never depends on webview visibility, tab focus, or component mounting.
2. No worker is automatically given an editor tab.
3. Only explicit cancel/stop, safe shutdown, or a documented policy terminates a task.
4. Source of truth is task state/history/worktree, not transient React state.
5. The observer remains read-only; task commands are permission-checked.

## 3. New user settings (P1 owns the schema file)

`packages/types/src/global-settings.ts` — additive `MenagerieSettings` block (published
`zoo-code.*` namespace retained; no published id renamed):

```ts
export interface MenagerieSettings {
	/** "headless" (default) | "task-hub" | "editor-tabs" (legacy opt-in, abort-on-close preserved) */
	workerPresentation?: "headless" | "task-hub" | "editor-tabs"
	/** "sidebar" (default) | "secondary-sidebar-when-user-moved" | "panel-when-user-moved" */
	taskHome?: "sidebar" | "secondary-sidebar-when-user-moved" | "panel-when-user-moved"
	/** false (default): approved agent writes apply without opening a tab/diff editor */
	openFilesOnAgentEdit?: boolean
	/** false (default): attention never moves the UI on its own */
	autoRevealAttention?: boolean
	/** true (default): persist lastSelectedTaskId and restore on reload */
	rememberTaskNavigation?: boolean
}
```

Per the persisted-setting checklist (AGENTS.md): schema + default constant in `global-settings.ts`;
`ExtensionState` inclusion if the webview uses it; `SettingsView` binds to `cachedState`;
`webviewMessageHandler` persists via `ContextProxy`; `ClineProvider.getState()` +
`getStateToPostToWebview()` round-trip; tests for both set and unset.

## 4. Effective parallelism policy mapping (P4)

**Verified correction to the spec:** the authoritative per-request policy is
`task.resolvedParallelismPolicy` — a FEAT-011 `ParallelismPolicy`
(`packages/types/src/parallelism-policy.ts`), set by `webviewMessageHandler` on `newTask` /
`messageResponse`. `ParallelTasksTool.parallelismPolicy` is a never-set optional member on a
stateless singleton; it is the *dead* seam, not the source. P4 must read the live Task field,
snapshot it once per `execute()` call, and drive **all** of: schema max, reader fan-out,
admission, and dispatch — from that single snapshot.

Mapping `ParallelismPolicy → UserParallelismPolicy` (scheduler consumption shape,
`src/core/task/elasticTypes.ts:270`), implemented as a pure function
`src/core/task/resolveUserParallelismPolicy.ts`:

```ts
// "dynamic" and "saturate" are NOT local caps: they mean "no additional local ceiling",
// so map to `undefined` (scheduler defaults apply: live 12, dispatched 8, reader 1).
// Numeric ceilings are clamped to sane ranges and floored to int.
export function toUserParallelismPolicy(p?: ParallelismPolicy): UserParallelismPolicy {
	if (!p) return {}
	return {
		maxLive: numericCeiling(p.maxLive) ?? undefined,
		maxDispatched: numericCeiling(p.maxRunnable) ?? undefined,
		maxReaderSwarm: numericCeiling(p.readerSwarm) ?? undefined,
	}
}
```

Semantics preserved: a policy only tightens the batch bound; `DEFAULT_READER_SWARM = 1`
remains the safe fallback when no policy is present. `maxSpeculativeBranches` /
`maxWorkStealing` stay unmapped until P6 (no speculative execution yet).

## 5. Inference lease contract (P5)

Already documented by `BoundedElasticScheduler.DispatchHandle` (correct) but violated by
`runParallelTasks` (acquires before worker start, releases after child dispose — i.e. the lease
is held for the worker's whole lifetime). P5 moves acquire/release to the **generation
boundary**: acquire just before the model request dispatches; release in `finally` on stream
end/error/abort/timeout/fallback. Never held during tool calls, edits, approvals, UI, or
backoff. Reacquired per generation. Idempotent release; guard against stream callbacks
throwing. Auto-reader exemption only if measured-necessary; exempt work still subject to
OmniRoute physical admission.

Deterministic test (capacity 1): worker A generates, then waits on a 5s tool; worker B must be
able to generate while A waits; never >1 concurrent generation in a lane. Simulate
abort/error while holding → full release, no queued-task starvation.

## 6. Edit transaction contract (P3)

`EditTransactionService` (new) used by `WriteToFileTool`, `EditTool`, `ApplyDiffTool`,
`ApplyPatchTool`. Before writing: canonicalize URI; enforce workspace/symlink scope; honor
write-protected path policy; read + fingerprint the base; detect dirty VS Code documents;
validate against exact base hash. `WorkspaceEdit`/document-aware where compatible; guarded
disk fallback for closed clean documents. Per-path lock with recheck. **Never overwrite a
dirty buffer** — surface a conflict decision. Change index: `(taskId, path, beforeHash,
afterHash, patch, timestamp, status)`.

Presentation policy (promotes `PREVENT_FOCUS_DISRUPTION` experiment): `silent` (default for
approved agent writes; gated by `openFilesOnAgentEdit=false`), `review` (preparation in Task
Hub; approval request must not steal focus), `interactive` (legacy live diff editor, opt-in).

## 7. Navigation contract (P2)

Board click → `menagerie.openTask(taskRef)` → `TaskCommandRouter` → resolve the *actual owning*
session by stable id (never array position) → focus Menagerie view → switch selected chat →
scroll to latest meaningful event. **Never** `createTask()` / `evictCurrentTask()` on
navigation. Cross-window tasks: optional authenticated local IPC locator; if unsupported, show
workspace/path + a safe open action — never silently select an identically-numbered task in
another window. Persist `lastSelectedTaskId` when `rememberTaskNavigation` is true.

Board columns: `Running`, `Needs input`, `Queued`, `Review`, `Completed`, `Failed`; filters:
workspace, parent, role, route, status. No five-second polling as the primary mechanism —
consume normalized event batches + periodic snapshot reconciliation.

## 8. Non-goals (binding for all workstreams)

- No renaming published `zoo-code.*` identifiers; no breaking task-history migration.
- No replacing OmniRoute/Menagerie task engine with an external runtime.
- No MCP permission changes; no reader write-deny weakening; no blanket destructive approvals.
- No unbounded reader swarms, infinite retries, or filler work to occupy hardware.
- No `.changeset` files, no CHANGELOG edits (repo convention).
- No push/merge/publish without explicit user authorization.
