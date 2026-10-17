# Menagerie Next-Level Lift — Integration Results (P6)

**Date:** 2026-10-16
**Head at integration:** `main` after merging `menagerie-lift/1-session` (P1),
`menagerie-lift/2-navigation` (P2), `menagerie-lift/3-editing` (P3),
`menagerie-lift/4-policy` (P4), and `menagerie-lift/5-leases` (P5), plus this P6
integration on `main`.
**Companion:** `menagerie-lift-baseline.md` (Phase 0) and
`menagerie-lift-execution-plan.md` (wave/ownership map).

This is the integration record for the lift. P1–P5 each landed in their own
worktree; P6 is the "everything else" integration on `main` (per the execution
plan's file-ownership table): additive DAG fields, named scout readers, phase
telemetry, the comparative benchmark, and this ADR.

## 1. What P6 added on top of P1–P5

| Workstream | Files | Status |
|---|---|---|
| Additive DAG fields (`dependsOn`, `filesRead`, `filesWrite`, `expectedOutput`, `deadlineMs`, `priority`) | `src/core/tools/ParallelTasksTool.ts`, `src/core/task/runParallelTasks.ts`, `src/core/task/BoundedElasticScheduler.ts` | threaded end-to-end (not documented-only) |
| Named, bounded scout readers | `src/core/task/scoutReaders.ts` | new pure module + tests |
| Phase telemetry (backpressure vs. lease starvation, counted separately) | `src/core/task/ParallelismMetrics.ts`, `src/core/task/BoundedElasticScheduler.ts` | additive collectors + tests |
| Comparative benchmark on the pinned 8-task suite | `scripts/bench-menagerie-lift.ts`, `pnpm menagerie-lift:bench` | new, deterministic |
| P2 merge type cleanup (integration owner) | `src/activate/taskBoard.ts`, `src/activate/__tests__/taskBoard.spec.ts` | fixes P2 merge type errors |

### 1.1 Additive DAG discipline (C4)

The `parallelTaskSpecSchema` now carries optional `dependsOn`, `filesRead`,
`filesWrite`, `expectedOutput`, `deadlineMs`, and `priority`. Legacy specs omit
them (`.strip()` leaves them out), so a spec list with no `dependsOn` still
produces a flat `{ tasks }` plan — legacy behavior is unchanged.

`buildExecutionPlan` (the single builder both the tool's admission validation and
`runParallelTasks` dispatch now use) collects per-spec `dependsOn` into
`plan.dependencies`. `admitPlan` compiles that into a real `TaskDag`; a dependent
with an unsatisfied prerequisite is admitted `waiting-on-dependency` and unlocks
to `runnable` the instant its prerequisite settles `completed`. A **failed**
prerequisite does **not** unlock dependents (only `completed` does). The spec's
`priority` is honored at admission (default `normal`), so rank-based lease
admission is unchanged for legacy specs.

Verified by:
- `core/tools/__tests__/buildExecutionPlan.spec.ts` — flat vs. threaded plans,
  field survival through validation, invalid `priority` rejected, legacy
  tolerance.
- `core/task/__tests__/dagDependentUnlock.spec.ts` — end-to-end: dependent admitted
  `waiting-on-dependency`, unlocks on prerequisite completion; failed prerequisite
  unlocks nothing.

### 1.2 Named, bounded scout readers (C3)

`scoutReaders.ts` generalizes the historical single shared-document reader into
separately **named**, bounded read-only jobs — `symbol-locator`,
`call-graph-scout`, `api-contract-reader`, `test-failure-analyst`,
`dependency-docs-scout`. Each carries an explicit scope, a byte budget, a timeout,
and a short structured result schema (the parent-visible return channel — never a
raw transcript). The planner spawns **only** readers with at least one concrete
scope: an empty fact yields zero readers, never fabricated filler ("don't spawn
work just to occupy a GPU"). Candidates are ranked by a concrete information-gain
score, and `buildScoutReaderSpecs` takes the top-N within the elastic ceiling
(`ceiling <= 0` ⇒ no fan-out). Verified by `scoutReaders.spec.ts`.

### 1.3 Phase telemetry (C5)

`ParallelismMetricsCollector` now counts **scheduler backpressure** and **lease
starvation** separately, by design, from provider/network latency:
- `newFanOutDeniedByBackpressure` — incremented at the two *new* fan-out
  admission gates (work-stealing split and speculative branch) when OmniRoute
  reports sustained pressure. This is a scheduler decision, never a
  provider-latency measurement.
- `leaseStarvationEvents` — incremented when a worker enters
  `waiting-for-inference` while its lease pool reports zero available leases (it
  had to block). Distinct from the fan-out backpressure gate.

Both are surfaced on the `ParallelismMetrics` snapshot. Verified by
`ParallelismMetrics.c5.spec.ts`.

### 1.4 Comparative benchmark (C2 / C5)

`pnpm menagerie-lift:bench` runs a **deterministic** comparative benchmark on the
pinned 8-task suite (8 workers, capacity-1 lane, generation 100ms, tool-wait
5000ms, virtual time). It computes the exact completion time under the two
lease-holding models:

| strategy | completion | peak-gen | starvation | speedup |
|---|---|---|---|---|
| lifetime (baseline) | 40800ms | 1 | 7 | 1.00x |
| per-generation (P5) | 5800ms | 1 | 7 | **7.03x** |

Per-generation leasing (P5) releases the single lane slot at the end of each
generation, so the next worker can generate while a peer waits on its tool —
cutting lane completion by 7.03× while keeping peak simultaneous generations at
1 on the 1-slot lane. Deterministic (closed-form, no timers) ⇒ CI-stable.

## 2. Gate results (spec §7/§8, restated in the execution plan)

| Gate | Result |
|---|---|
| `pnpm check-types` | No errors introduced by P6. The only remaining type errors are the **pre-existing baseline** set documented in `menagerie-lift-baseline.md` (`contextRecoveryClassifier`, `recoveryTelemetry`, `Task.spec.ts`/`Task.parallel-worker-failure.spec.ts` `{retry}` args, `EditTransactionService.spec.ts` vscode cast). P6 additionally **cleared** the P2-merge errors in `activate/taskBoard.ts` / `taskBoard.spec.ts` that were new at merge HEAD. |
| `pnpm test` | 104/104 pass across every suite P6 or P1–P5 touches (tool, DAG, scout, C5 metrics, dependent-unlock, generation-lease, TaskDag, capacity, board, command router, policy, reader). The full-suite failures remain the documented pre-existing 226 (environmental `vscode` mock missing `createTextEditorDecorationType`, transitively imported by `DiffViewProvider`/`Task`/`ClineProvider`); none are in P6/P1–P5 files. |
| `pnpm lifecycle:model-check` | Passed (cleanup protocol 229,464 reachable states; parser-scope 924/924; completion persistence 88 states; delegated-mode readers verified). |
| `pnpm fanout-protocol:model-check` | Passed (113 reachable states, 6/6 actions, 5/5 landmarks, 8/8 counterexamples). |
| ESLint (`--prune-suppressions --max-warnings=0`) | Clean on every P6-touched file; `src/eslint-suppressions.json` unchanged. |

## 3. Known hazards / out-of-scope

- **Pre-existing type & test failures** are the documented baseline set; not
  caused by, and not cleared by, this lift. The baseline report tracks them.
- `filesWrite` is now *validated and surfaced* on the spec; exclusive write
  ownership enforcement by the integrator (rejecting overlapping writers) is the
  next integration step and is intentionally **not** wired into dispatch here —
  it requires the coordinator merge pass, which is a separate C4 sub-task. The
  field is threaded so that enforcement is additive, not a re-plumbing.
- Scout readers are a pure planner + spec builder; wiring them into
  `addSharedDocumentReader`'s fan-out (so a coordinator can request a named
  scout set) is the follow-up seam. The module is independently tested and ready.
