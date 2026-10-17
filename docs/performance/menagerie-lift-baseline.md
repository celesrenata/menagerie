# Menagerie Next-Level Lift — Phase 0 Baseline

**Date:** 2026-10-16
**Baseline HEAD:** `d841deb10` (`main`, `celesrenata/menagerie`)
**Spec:** `MENAGERIE_NEXT_LEVEL_LIFT.md` (reviewed spec; this document verifies every line-level
finding against the live checkout before any implementation starts).

## 1. Verified findings (all 8 hold at HEAD, with one refinement)

| # | Spec finding | Verified at HEAD | Notes / corrections |
|---|---|---|---|
| 1 | `createParallelTaskRuntime()` unconditionally opens a `createWebviewPanel(... { viewColumn: Active, preserveFocus: true })` per worker; worker panel closure aborts the task | **Confirmed** — `src/core/webview/ClineProvider.ts:3606-3653` | Worker role set at `:3620`; abort-on-close path at `:1126-1141` (`onDidDispose` → `dispose()` for non-detachable tab views). Popouts already detach headless (`detachTabView` `:1163`). **Refinement:** the detach-keeps-task-alive machinery already exists for `popout` role — the headless worker path is a generalization of `detachTabView`, not a new lifecycle system. |
| 2 | Legacy `taskBoard.ts` is a `TreeDataProvider`; `taskBoardShowDetails` only refreshes a JSON snapshot; no row command focuses a task; 5 s poll when visible | **Confirmed** — `src/activate/taskBoard.ts:69-181` | `collectTaskBoard()` enumerates live providers (`:23-56`). `taskBoardShowDetails` is a documented compat stub (`:167-171`). Poll interval 5000 ms (`:148`). Observatory declared primary inspection UI in comments. |
| 3 | Observatory normalizes/batches events, reconciles snapshots, supports persisted inspection; request router is read-only | **Confirmed** — `src/activate/observatory.ts`, `src/services/observatory/{TaskObservationService,ObservatoryMessageRouter}.ts` | `handleObservatoryMessage` returns a boolean and the router exposes no mutation verbs. Command service must live separately. |
| 4 | `PREVENT_FOCUS_DISRUPTION` selects `saveDirectly()` which writes disk bytes with `fs.writeFile`, opens doc in memory only; no version/dirty conflict handling | **Confirmed** — `src/integrations/editor/DiffViewProvider.ts:1141-1225` | `fs.writeFile` at `:1159` with **no prior read, no hash, no dirty check**; in-memory open at `:1171` then `doc.save()` — this path can clobber an unsaved user buffer silently. Call sites: `WriteToFileTool.ts:148`, `EditTool.ts:215`, `ApplyPatchTool.ts:217/414/439`, `ApplyDiffTool` (via same provider). Experiment default: disabled (`src/shared/experiments.ts:23`). |
| 5 | `ParallelTasksTool` omits the optional policy on `addSharedDocumentReader(...)` and `runParallelTasks(task, provider, tasks)`; `parallelismPolicy` declared optional with no initializer | **Confirmed** — `src/core/tools/ParallelTasksTool.ts:373,383,398-403,429-435,450` | `resolveParallelTasksMax(this.parallelismPolicy)` at `:383` is the only consumer of the policy. `addSharedDocumentReader` (5th arg `policy?`) and `runParallelTasks` (4th arg `policy = {}`) are called without it. Admission scheduler at `:430` gets `this.parallelismPolicy ?? {}`. **Refinement (critical for C1):** the *authoritative* per-request policy is NOT a `ParallelTasksTool` field — it is `task.resolvedParallelismPolicy` (`Task.ts:245`), a `ParallelismPolicy` (from `packages/types/src/parallelism-policy.ts`, FEAT-011) set by `webviewMessageHandler` on `newTask`/`messageResponse`. The spec's "resolve from the task's already-resolved user parallelism settings" therefore means: read `task.resolvedParallelismPolicy`, map `maxRunnable → maxDispatched`, `readerSwarm → maxReaderSwarm` (`"dynamic"`/`"saturate"` → no local cap, i.e. scheduler defaults), and pass that single snapshot to schema, reader fan-out, admission, **and** `runParallelTasks`. Today `parallelTasksTool` is a stateless singleton (`:472`), so the per-request policy can never reach it at all. |
| 6 | `DEFAULT_READER_SWARM = 1`; readers only for useful bounded shared documents | **Confirmed** — `src/core/task/ParallelTaskReader.ts:59` | Ceiling logic `:62-66`; useful-work tests (existence, `..` rejection, size cap, denylist) `:97-119`. Tests at `src/core/task/__tests__/ParallelTaskReader.spec.ts` and `parallelTaskReader.denylist.spec.ts` already pass a `POLICY` arg, confirming the 5-arg signature. |
| 7 | `DispatchHandle` contract: dispatch permit for worker lifetime; inference leases **per generation**. `runParallelTasks` acquires lease *before* worker start, releases *after* child dispose | **Confirmed** — `BoundedElasticScheduler.ts:30-41` vs `runParallelTasks.ts:500-624` | Contract documented at `:23-41` ("releasing it the instant it runs a tool or waits on I/O"); runtime holds the lease from `:518-520` (before workspace creation + runtime creation) to `:623` (after `dispose()`), i.e. for the worker's whole lifetime including all tool calls, approvals, I/O, and backoff. Auto-reader exemption at `:517-519`. |
| 8 | `runParallelTasks` already has isolated worktrees, result normalization, compact parent return, per-worker manifest/patch, OmniRoute route metadata fallback, capability lanes, code-route spreading, per-worker MCP brokers | **Confirmed** — `src/core/task/runParallelTasks.ts:279-649+` | Reuse, do not replace. `setUpWorkerBroker` per-generation surface at `:212-276`. |

**Outdated assumptions corrected:** (a) spec item 5 frames the policy as the tool's optional
member; in reality the resolved policy is a per-request Task field (`task.resolvedParallelismPolicy`,
`ParallelismPolicy` from FEAT-011) and the tool never sees it. Fix = read it off the Task inside
`execute()` and snapshot once. (b) spec item 1 implies worker detach needs new machinery; the
`popout` detach/rebind/self-reap machinery (`detachTabView`, `rebindView`,
`reapIfDetachedPopoutTerminal`) already implements attach/detach semantics and should be
generalized to workers behind the new presentation setting.

## 2. Baseline measurements

| Metric | Baseline (d841deb10) |
|---|---|
| Editor tabs opened per parallel worker | **1** — `createWebviewPanel` with `viewColumn: Active` per worker (finding 1) |
| Task board navigation | Tree rows have **no** command; detail view = JSON snapshot refresh (finding 2) |
| Background edit safety | `saveDirectly` writes disk with no version/dirty check; dirty buffers clobberable (finding 4) |
| Reader fan-out under configured policy | Capped at `DEFAULT_READER_SWARM = 1` regardless of user policy (findings 5, 6) |
| Worker batch ceiling under configured policy | `resolveParallelTasksMax(undefined)` = 12 (scheduler default); user mode ceilings (conservative 3 / balanced 6 / max 12, `maxRunnable` up to 12) never reach schema, admission, or runtime dispatch (finding 5) |
| Inference-lease occupancy | One lease per worker for the worker's **entire lifetime** (workspace setup → task → tools → approvals → dispose), not per generation (finding 7). With 8 dispatched workers on a 1-slot lane, 7 workers can never generate while any one holds the lease. |
| Board update latency | 5 s poll, only while visible (finding 2) |
| Task lifetime ↔ view coupling | Worker panel close ⇒ `dispose()` ⇒ task abort (finding 1); sidebar close clears webview resources only |

Tooling baseline on `d841deb10`:

| Check | Result |
|---|---|
| `pnpm test` (turbo) | 10223 tests: 9958 pass, 226 fail (20 files), 39 skip. All 226 share one environmental root cause: `src/integrations/editor/DecorationController.ts:3,9` calls `vscode.window.createTextEditorDecorationType` at module scope, and the inline `vi.mock("vscode")` in the affected files lacks it. Every test that transitively imports `DiffViewProvider`/`Task`/`ClineProvider` is affected. Pre-existing at HEAD; not caused by any pending work. |
| `pnpm check-types` | 5 pre-existing errors, all in `src/core/task/__tests__` (`contextRecoveryClassifier.spec.ts` imports missing `../task-persistence/apiMessages`; `recoveryTelemetry.spec.ts` fast-check `Arbitrary` mismatch; 3× `Task*.spec.ts` `{ retry: boolean }` vs `void` mock signatures). No production-path type errors. |
| `pnpm lifecycle:model-check` | Passes (all sub-checks green). |

Phase work must not increase any failure count. Benchmark suite (8 pinned tasks, wall time,
lease occupancy) lands with Phase 6.

## 3. Validation gates per spec §7

Phase order: 0 → 1 (session control) → {2, 3, 4 parallel} → 5 → 6.
Worktrees: `.worktrees/menagerie-lift-{1..5}` on branches `menagerie-lift/N-*`.
Integration owner: main worktree `main` (this checkout). No pushes, no merges, no publishes
without explicit authorization.
