# Implementation Plan: Elastic Parallel Execution

## Overview

This plan converts the elastic logical execution fabric design (FEAT-010 + FEAT-012) into incremental, test-first coding tasks in TypeScript. It replaces the fixed `parallelTaskPool = new ParallelTaskPool(4)` and the `parallel_tasks` `.max(4)` cap with a `BoundedElasticScheduler` that separates logical liveness (`maxLive`=12) from dispatch (`maxDispatched`=8) and per-generation inference leasing, driven by an event-driven `TaskDag`.

The build is bottom-up: pure data models and small units first (`TaskDag`, `InferenceLeasePool`), then the scheduler core, then event-driven DAG wiring, reader-swarm/work-stealing/speculation, priority/backpressure, the `parallel_tasks`/`runParallelTasks` rehost, metrics, and finally a lifecycle reducer change ONLY if an unavoidable new persisted transition is discovered. Each step wires its output into the previous steps so no code is orphaned.

All new scheduler code lives under `src/core/task/`; property and unit tests live under `src/core/task/__tests__/`, reusing `src/test-utils/stream.ts` and the existing `TaskSemaphore`/`TaskScheduler` test patterns. Property tests use `fast-check` at ≥100 iterations and are tagged `// Feature: elastic-parallel-execution, Property N: ...`.

## Tasks

- [x] 1. Define elastic-fabric data models and types
  - [x] 1.1 Add scheduler data-model module
    - Create `src/core/task/elasticTypes.ts` with `LogicalWorkerState` (the 12 states), `SchedulingPriority`, `RouteCapability`, `RouteCapacity`, `RouteCapacityProvider`, `LogicalWorker`, `WorkerProvenance`, `WorkerOutcome`, `ExecutionPlan`, `SchedulerBounds`, `SchedulerConfig`, and the `UserParallelismPolicy` consumption shape (imported/typed as a ceiling input, not defined here)
    - Define `DEFAULT_SCHEDULER_BOUNDS` (`maxLive: 12`, `maxDispatched: 8`) as a shared constant
    - Export a `RouteCapacity` runtime validator (zod) requiring `route`, `capacity`, `available`, `capability`, optional `pressure`, with `capability` restricted to the five values
    - _Requirements: 1.6, 2.1, 2.2, 3.3, 3.4, 20.1, 20.2_

  - [ ]* 1.2 Write unit tests for data-model validation and defaults
    - Assert `RouteCapacity` validator requires the four fields, allows optional `pressure`, and restricts `capability` to `reader|reasoner|long-context|vision|general`
    - Assert `DEFAULT_SCHEDULER_BOUNDS` is `maxLive: 12`, `maxDispatched: 8` and that overrides take effect
    - Assert all 12 `LogicalWorkerState` values and the 5 `SchedulingPriority` values are present
    - _Requirements: 2.1, 2.2, 3.3, 3.4_

- [x] 2. Implement the Task_DAG
  - [x] 2.1 Implement `TaskDag` over `ExecutionPlan`
    - Create `src/core/task/TaskDag.ts` compiling `ExecutionPlan.dependencies` into a dependency graph (edges dependency → dependent)
    - Implement `isRunnable(nodeId)` (true iff every dependency completed), `unlockedBy(nodeId)` (nodes whose last dependency just completed), `criticalPath()` (longest dependency chain)
    - Reject cycles and non-unique task names at construction, throwing a recoverable argument error consumable by the `ParallelTasksArgumentError` path
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 10.3_

  - [ ]* 2.2 Write property test for DAG runnability
    - **Property 3: A dependent node runs exactly when all dependencies complete**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**
    - Generate random acyclic DAGs + completion orders; assert `isRunnable` ⇔ all deps complete and never earlier; independent nodes concurrently runnable; no all-complete barrier
    - _Requirements: 4.2, 4.3, 4.4, 4.5_
    - _Properties: 3_

  - [ ]* 2.3 Write unit tests for cycle rejection and criticalPath
    - Assert cyclic `dependencies` and duplicate task names are rejected as recoverable argument errors
    - Assert `criticalPath()` returns the longest dependency chain for representative graphs
    - _Requirements: 4.1, 10.3_

- [x] 3. Implement the InferenceLeasePool
  - [x] 3.1 Implement `InferenceLeasePool` over `TaskSemaphore`
    - Create `src/core/task/InferenceLeasePool.ts` wrapping `TaskSemaphore`, parameterized by `RouteCapability` and reading `RouteCapacityProvider` capacity read-only
    - Implement priority-ordered `acquire(priority, signal)` returning a release fn; grant iff route `available`/`capacity` allows, otherwise queue by priority (never reject)
    - Expose `available` and `waiting`; release never alters other held permits; delays/queueing are not failures
    - Guarantee release-on-throw discipline for callers via a returned idempotent release fn
    - _Requirements: 2.3, 8.1, 10.2, 11.1, 11.2_

  - [ ]* 3.2 Write property test for over-capacity queuing
    - **Property 10: Over-capacity work is queued, never rejected**
    - **Validates: Requirements 3.6, 11.1, 11.2, 11.3**
    - Generate over-capacity lease demand; assert no acquirer is rejected/failed by delay, each stays waiting, and each is admitted when a lease frees
    - _Requirements: 11.1, 11.2_
    - _Properties: 10_

  - [ ]* 3.3 Write property test for priority admission ordering
    - **Property 6: Higher-priority and critical-path work is admitted first**
    - **Validates: Requirements 7.3, 10.1, 10.2, 10.3, 10.4, 10.5**
    - Generate waiter sets with priorities/critical-path flags; assert admission honors priority, critical-path, and architect/required-verifier precedence
    - _Requirements: 10.1, 10.2_
    - _Properties: 6_

  - [ ]* 3.4 Write property test for no-physical-identity branching
    - **Property 7: No scheduling decision branches on physical identity**
    - **Validates: Requirements 2.4, 2.5, 13.1, 13.2, 13.3, 13.4, 19.3**
    - Drive lease decisions with capability/capacity-only inputs; assert decisions invariant under injected GPU/VRAM/CUDA/node values; no load/unload decision taken
    - _Requirements: 2.4, 2.5, 13.1, 13.3_
    - _Properties: 7_

- [x] 4. Implement the BoundedElasticScheduler core
  - [x] 4.1 Implement scheduler construction, admission, and dispatch
    - Create `src/core/task/BoundedElasticScheduler.ts` owning the dispatch `TaskSemaphore`, the `InferenceLeasePool`, the `TaskDag`, and the state map
    - Implement `admitPlan(plan)` (compile DAG, admit nodes as `LogicalWorker`s up to `maxLive`, clamp `maxLive`/`maxDispatched` by `UserParallelismPolicy`)
    - Implement `dispatch(workerId, run)` mirroring `TaskScheduler.schedule`: skip + release if cancelled/abandoned before admission, release on throw via `try/finally`; over-capacity workers stay `runnable`, never rejected
    - Implement the `LogicalWorkerState` machine with `DispatchHandle.acquireLease` transitioning to `generating` (lease held) and releasing on tool/wait/complete; expose `snapshotStates()`, `cancelQueued()`
    - Keep I/O (`running-tool`/`waiting-on-tool`) from reducing available generations
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.5, 8.2, 8.3, 8.4, 9.1, 9.2, 11.3, 14.1, 20.1, 20.2, 21.5_

  - [ ]* 4.2 Write property test for lifecycle integrity under many workers
    - **Property 1: Many live workers preserve lifecycle integrity**
    - **Validates: Requirements 1.2, 1.3, 1.6, 4.1, 21.4**
    - Generate ≥12 workers + random admit/dispatch/lease/tool/wait/settle interleavings (fast-check command/model-based); assert exactly-one-state and only legal transitions
    - _Requirements: 1.2, 1.3, 1.6_
    - _Properties: 1_

  - [ ]* 4.3 Write property test for lease-held ⇔ generating
    - **Property 2: A worker holds an inference lease only while generating**
    - **Validates: Requirements 1.4, 8.2, 8.3, 8.4, 9.1, 9.2**
    - Model worker transitions; assert lease-held ⇔ `generating`, held leases never exceed `maxInferenceLeases`, and tool/wait states never reduce others that may be `generating`
    - _Requirements: 1.4, 8.2, 8.3, 8.4, 9.1_
    - _Properties: 2_

  - [ ]* 4.4 Write unit tests for dispatch edge cases and observable states
    - Assert dispatch of an already-cancelled/abandoned worker is a no-op that releases the permit
    - Assert `snapshotStates()` distinguishes `queued`, `waiting-for-inference`, `generating`, `running-tool`, `waiting-on-tool`, `waiting-on-dependency` and exposes "Runnable — waiting for inference capacity"
    - Assert cancelling/failing one worker leaves siblings holding leases/permits untouched
    - _Requirements: 11.3, 20.1, 20.2, 21.5_

- [x] 5. Wire the event-driven completion bus and partial completion
  - [x] 5.1 Implement completion event bus and DAG unlock in the scheduler
    - Extend `BoundedElasticScheduler` with `onWorkerSettled(workerId, outcome)` publishing a completion event
    - On settle: unlock dependents via `TaskDag.unlockedBy`, mark newly-runnable nodes `runnable`, and allow handlers to satisfy evidence / trigger a verifier / trigger a new reader fan-out / update state
    - Act on each event as it arrives (partial batch completion); no barrier that waits for every child
    - _Requirements: 4.6, 4.7_

  - [ ]* 5.2 Write unit tests for partial completion and event unlock
    - Assert completing a subset of a batch makes dependents of completed nodes runnable without waiting for every child
    - Assert a completion event can trigger a verifier/reader fan-out hook and update state
    - _Requirements: 4.6, 4.7_

- [x] 6. Checkpoint - Ensure all scheduler-core tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement reader-swarm generalization and work stealing
  - [x] 7.1 Generalize `ParallelTaskReader` reader fan-out
    - Edit `src/core/task/ParallelTaskReader.ts`: remove the `specs.length < 4` guard; bound appended reader count by the elastic reader-swarm ceiling from the policy
    - Keep `AUTO_READER_NAME`, `MAX_READER_DOCUMENT_BYTES`, `MAX_READER_EXCERPT_CHARS`; size the swarm to saturate useful work, not available worker count; create no readers beyond useful scopes
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 7.2 Implement `stealWork` splitting in the scheduler
    - Add `stealWork(parentWorkerId, split)` to `BoundedElasticScheduler` splitting a reader's remaining bounded work into new bounded child tasks that run concurrently with the original
    - Preserve `WorkerProvenance` (`parentWorkerId`, `batchId`, same `evidenceOwnerId`), parent/child relationship, and the reader output bounds on children
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]* 7.3 Write property test for work-stealing provenance and bounds
    - **Property 5: Work-stealing splits preserve provenance and bounds**
    - **Validates: Requirements 6.1, 6.2, 6.3**
    - Generate random splits; assert provenance, `evidenceOwnerId`, parent-child linkage, output bounds preserved, and children run concurrently with remaining work
    - _Requirements: 6.1, 6.2, 6.3_
    - _Properties: 5_

  - [ ]* 7.4 Write unit tests for reader-swarm fan-out and output bounds
    - Assert reader fan-out exceeds four scopes when useful, stays within the policy ceiling, and creates no filler readers when capacity is free
    - Assert reader evidence overflow is clamped (not thrown) to `MAX_READER_DOCUMENT_BYTES`/`MAX_READER_EXCERPT_CHARS`
    - _Requirements: 5.2, 5.3, 5.5, 5.6_

- [x] 8. Implement speculation, priority, critical-path, and backpressure
  - [x] 8.1 Implement speculative execution and isolated cancellation
    - Add speculative-branch support to `BoundedElasticScheduler`: assign `speculative` priority (below critical-path), per-branch `AbortController` cancellation
    - On hypothesis elimination, cancel only that branch, record outcome `{ kind: "cancelled", reason: "hypothesis-eliminated" }` (never `failed`), preserve partial evidence, and never touch siblings/parent/other branches
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6_

  - [ ]* 8.2 Write property test for isolated speculative cancellation
    - **Property 4: Speculative cancellation is isolated**
    - **Validates: Requirements 7.2, 7.4, 7.5, 7.6**
    - Generate branch trees; cancel one speculative branch; assert sibling/parent/other-branch/evidence invariance and the `cancelled`/`hypothesis-eliminated` outcome
    - _Requirements: 7.2, 7.4, 7.5, 7.6_
    - _Properties: 4_

  - [x] 8.3 Implement priority, critical-path preference, and backpressure
    - Wire `SchedulingPriority` ordering + `TaskDag.criticalPath()` preference into lease admission; ensure `background`/`speculative` never delay the architect or a required verifier
    - Implement backpressure that reduces NEW logical fan-out only on sustained `RouteCapacityProvider.sustainedPressure()`; defer physical capacity entirely to OmniRoute (no physical modeling)
    - _Requirements: 7.3, 10.1, 10.2, 10.4, 10.5, 12.1, 12.2, 12.3, 12.4_

  - [ ]* 8.4 Write unit tests for backpressure and verifier precedence
    - Assert sustained pressure reduces new fan-out while keeping in-flight workers alive and computes no physical capacity
    - Assert `background`/`speculative` work never delays architect/required-verifier admission
    - _Requirements: 10.5, 12.1, 12.3, 12.4_

- [x] 9. Checkpoint - Ensure reader/speculation/priority tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Elasticize the parallel_tasks tool schema and ExecutionPlan build
  - [x] 10.1 Elasticize `parallelTasksSchema` and error wording
    - Edit `src/core/tools/ParallelTasksTool.ts`: replace `.max(4)` with `.max(maxLive)` bounded by the `User_Parallelism_Policy` at request time; keep `.strip()` and duplicate-name rejection
    - Update `formatParallelTasksArgumentError` wording to drop the "1–4" phrasing
    - _Requirements: 3.2, 14.1_

  - [ ]* 10.2 Write unit tests for the elasticized schema
    - Assert `parallelTasksSchema` accepts more than four tasks, still rejects duplicate names, and `formatParallelTasksArgumentError` no longer claims a 1–4 cap
    - _Requirements: 3.2_

  - [x] 10.3 Build `ExecutionPlan` and admit it in `ParallelTasksTool.execute`
    - Edit `src/core/tools/ParallelTasksTool.ts`: in `execute`, build an `ExecutionPlan { tasks, parallelGroups?, dependencies? }` and call `scheduler.admitPlan`; route cyclic/invalid plans through the recoverable `ParallelTasksArgumentError` path
    - Keep `compactParallelTasksResultForParent` and parent-result char bounds unchanged
    - _Requirements: 4.1, 14.1_

  - [ ]* 10.4 Write property test for policy-bounded, filler-free fan-out
    - **Property 8: Policy bounds the exact request without manufacturing filler**
    - **Validates: Requirements 3.5, 5.5, 5.6, 14.1, 14.2, 14.3**
    - Generate policy ceilings + plans; assert effective live/dispatched never exceed the ceiling and worker count equals useful nodes (no filler at MAXIMUM CHAOS)
    - _Requirements: 3.5, 14.1, 14.2, 14.3_
    - _Properties: 8_

- [x] 11. Rehost runParallelTasks on the scheduler
  - [x] 11.1 Dispatch workers through the scheduler in `runParallelTasks`
    - Edit `src/core/task/runParallelTasks.ts`: replace `parallelTaskPool.run(signal, op)` with `scheduler.dispatch(workerId, run)` and replace the `Promise.all` lockstep with event-driven settling (partial batch completion)
    - Preserve the workspace snapshot, worktree creation, `worker-N.json` writes, patch export, result ownership (children never mutate parent buffers), and `parent.lifetimeSignal` abort wiring
    - _Requirements: 3.1, 3.6, 4.7, 21.1, 21.2, 21.3, 21.5_

  - [x] 11.2 Replace the process-wide pool wiring
    - Remove the `parallelTaskPool = new ParallelTaskPool(4)` export usage from `src/core/task/ParallelTaskPool.ts` consumers and construct/share a `BoundedElasticScheduler` instead (keep `ParallelTaskPool`'s abort-safe acquire/release discipline reused by the scheduler)
    - _Requirements: 3.1_

  - [ ]* 11.3 Write compatibility tests for persistence and sibling safety
    - Assert `runParallelTasks` still writes `parallel-tasks/<batchId>/` manifest + `worker-N.json`, still creates per-worker worktrees, and children do not mutate parent buffers
    - Assert cancelling/failing one worker leaves siblings holding leases/dispatch permits untouched
    - _Requirements: 21.1, 21.2, 21.3, 21.5_

- [x] 12. Checkpoint - Ensure tool and runParallelTasks tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement parallelism metrics (FEAT-012)
  - [x] 13.1 Implement `ParallelismMetrics` collection in the scheduler
    - Create `src/core/task/ParallelismMetrics.ts` with `WorkerTimings`, `SpeculationRecord`, `ParallelismMetrics`, and a collector wired into `BoundedElasticScheduler`
    - Record workers created, peak live/runnable/generations, reader-swarm sizes, per-worker queue/generation/tool-wait/task durations, speculative-cancellation and work-stealing counts, route capacity/pressure samples, time-to-first-useful and time-to-final result
    - Compute `usefulParallelismRatio` (contributing/created, in [0,1]) and expose it as the efficiency objective; accumulate `criticalPathIdleMs` while a critical-path worker is `runnable` and capacity unavailable; record `SpeculationRecord`s (hypothesis, duration, tokens, affectedFinalDecision, cancelledEarly)
    - Ensure parallelism learning tunes orchestration policy only; record no GPU identity
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 16.1, 16.2, 17.1, 17.2, 18.1, 18.2, 19.1, 19.2, 19.3_

  - [ ]* 13.2 Write property test for useful parallelism ratio
    - **Property 9: Useful parallelism ratio is computed correctly**
    - **Validates: Requirements 16.1, 16.2**
    - Generate worker sets with contribution flags; assert ratio equals contributing/created, lies in [0,1], is 0 only when none contributed and 1 only when all contributed
    - _Requirements: 16.1, 16.2_
    - _Properties: 9_

  - [ ]* 13.3 Write unit tests for metric population and critical-path idle
    - Assert all Req 15 fields populate and `SpeculationRecord`s capture Req 18 fields
    - Assert `criticalPathIdleMs` accumulates only while a critical-path worker is `runnable` and suitable capacity is unavailable
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 17.1, 17.2, 18.1, 18.2_

- [x] 14. Lifecycle integration (reducer change only if unavoidable)
  - [x] 14.1 Map logical-worker states onto persisted lifecycle statuses
    - Read `docs/architecture/task-lifecycle-model.md` first; map the 12 scheduler-internal states onto `active|delegated|interrupted|completed` only at proven boundaries, keeping cancel/fail paths on existing reducers
    - Promote a transition into `src/core/task-persistence/taskLifecycle.ts` ONLY if the lifecycle model must prove it (e.g. interrupted-DAG restart visibility, persistence/rehydration); update model actions/invariants and run `pnpm lifecycle:model-check` if the reducer/model changes
    - _Requirements: 21.4_

  - [ ]* 14.2 Add E2E coverage only for reducer-unprovable boundaries
    - In `apps/vscode-e2e`, cover restart visibility of an interrupted DAG + persistence/rehydration of in-flight workers, real scheduler permit behavior, and delayed provider streams exercising lease acquire/release; do not duplicate reducer interleavings
    - _Requirements: 21.4_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Every task references specific sub-requirements; property-test sub-tasks also reference the design's correctness Property number they validate.
- Checkpoints (tasks 6, 9, 12, 15) ensure incremental validation at reasonable breaks.
- Property tests use `fast-check` at ≥100 iterations, tagged `// Feature: elastic-parallel-execution, Property N: ...`, placed under `src/core/task/__tests__/`, reusing `src/test-utils/stream.ts` and existing `TaskSemaphore`/`TaskScheduler` patterns.
- Scheduler interleavings stay at the reducer/unit layer; E2E (task 14.2) is reserved for boundaries the reducer model cannot prove.
- Do NOT create `.changeset` files or update `CHANGELOG.md`. After editing a file, run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; run narrowest Vitest suites from the package directory, and `pnpm lifecycle:model-check` + `pnpm test` only if lifecycle reducers change.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "3.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "5.1", "7.1"] },
    { "id": 4, "tasks": ["5.2", "7.2"] },
    { "id": 5, "tasks": ["7.3", "7.4", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "10.1"] },
    { "id": 7, "tasks": ["8.4", "10.2", "10.3"] },
    { "id": 8, "tasks": ["10.4", "11.1"] },
    { "id": 9, "tasks": ["11.2", "13.1"] },
    { "id": 10, "tasks": ["11.3", "13.2", "13.3", "14.1"] },
    { "id": 11, "tasks": ["14.2"] }
  ]
}
```
