# Menagerie Next-Level Lift — Execution Plan & File-Ownership Map

Companion to `menagerie-lift-baseline.md` (Phase 0). All work happens on local branches in
dedicated worktrees; **nothing is pushed, merged, or published without explicit user authorization.**

## Wave structure

| Wave | Workstreams (parallel) | Worktree / branch | Depends on |
|---|---|---|---|
| 1 | **P1 Session control** (headless workers, TaskSessionRegistry, view attach/detach) | `menagerie-lift-1-session` | — |
| 1 | **P3 Silent editing** (EditTransactionService, dirty/version checks, change index) | `menagerie-lift-3-editing` | — |
| 1 | **P4 Policy propagation** (effective UserParallelismPolicy end-to-end) | `menagerie-lift-4-policy` | — |
| 2 | **P2 Navigation** (Board → TaskCommandRouter → openTask, selection restore, filters) | `menagerie-lift-2-navigation` | P1 interfaces |
| 2 | **P5 Per-generation inference leases** | `menagerie-lift-5-leases` | P4 (touches same scheduler/runtime files) |
| 3 | **P6 DAG/scout readers/telemetry/benchmarks** (integration on main) | main worktree | P1–P5 |

Integration owner: the main worktree on `main`. Cross-cutting contracts (TaskRef/TaskSummary/
TaskCommand schemas, registry API, policy mapping) are fixed here before consumers land.

## File ownership (conflict avoidance)

| Phase | Owned files (exclusive) | New files |
|---|---|---|
| P1 | `src/core/webview/ClineProvider.ts` (worker runtime path + detach generalization), `src/core/task/runParallelTasks.ts` (worker-creation seam only), `src/activate/index.ts` (registry boot) | `src/core/task/session/TaskSessionRegistry.ts`, `src/core/task/session/types.ts` (TaskRef, TaskSummary, TaskCommand), `src/core/task/session/HeadlessWorkerRuntime.ts`, settings in `packages/types/src/global-settings.ts` (zoo-code.menagerie.* block) |
| P2 | `src/activate/taskBoard.ts`, `src/services/observatory/ObservatoryMessageRouter.ts` (command dispatch hook only) | `src/activate/taskCommandRouter.ts`, board UI wiring, `menagerie.openTask` command registration |
| P3 | `src/integrations/editor/DiffViewProvider.ts` (`saveDirectly` → service-backed), `src/core/tools/{WriteToFileTool,EditTool,ApplyDiffTool,ApplyPatchTool}.ts` | `src/integrations/editor/EditTransactionService.ts`, change-index store, `src/core/tools/__tests__/edit-transaction*.spec.ts` |
| P4 | `src/core/tools/ParallelTasksTool.ts`, `src/core/task/ParallelTaskReader.ts` (no signature change; only call-site), `src/core/task/runParallelTasks.ts` (scheduler seeding from policy snapshot only) | `src/core/task/resolveUserParallelismPolicy.ts` (pure mapping helper), policy propagation tests |
| P5 | `src/core/task/BoundedElasticScheduler.ts`, `src/core/task/InferenceLeasePool.ts`, `src/core/task/runParallelTasks.ts` (lease site), `src/core/task/Task.ts` (generation boundary hooks) | lease lifecycle tests, per-route queue diagnostics |
| P6 | everything else (DAG fields, scout readers, telemetry, benchmarks, ADR) | `docs/performance/menagerie-lift-results.md`, benchmark harness |

Hard rule: a workstream must not edit files owned by another wave's workstream. If a needed
change is cross-cutting, it goes to the integration owner, not both worktrees.

## Phase gates (from spec §7/§8, restated as testable claims)

- **P1:** 10 headless workers → 0 `createWebviewPanel` calls; closing/detaching a view leaves the
  task running; explicit cancel still aborts. Test: provider-level unit tests + a scripted batch.
- **P2:** every live local task resolvable by stable TaskRef; selection restored across reload;
  no `createTask`/`evictCurrentTask` on navigation.
- **P3:** 50 silent writes → 0 tabs opened; dirty buffer never overwritten (conflict surfaced);
  changed-baseline revert refused.
- **P4:** effective policy from the task snapshot drives schema max, reader fan-out (ceiling 4 ⇒
  ≤4 readers; 0 useful docs ⇒ 0), admission, and dispatch; follow-up requests use the fresh
  per-request policy, not a stale singleton field.
- **P5:** capacity-1 lane: worker A waiting on a tool does not block worker B's generation;
  abort/error while holding a lease fully releases; queue never starves.
- **P6:** comparative benchmarks on the pinned 8-task suite; `pnpm check-types`, `pnpm test`,
  `pnpm lifecycle:model-check`, `pnpm fanout-protocol:model-check` green (modulo the pre-existing
  baseline mock failures documented in the baseline report).

## Known baseline hazards

- 226 pre-existing unit-test failures at HEAD (vscode mock lacks `createTextEditorDecorationType`,
  called at module scope by `DecorationController.ts`). Pre-existing, environmental; tracked in
  the baseline report. Phase work must not increase the failure count.
- Node 24 vs engines 22.23.1: tests pass under this node; keep CI expectations unchanged.
- `src/eslint-suppressions.json`: suppression counts must never increase (AGENTS.md).
- `zoo-code.*` identifiers, task history, MCP permissions, worker isolation: untouched by design.
