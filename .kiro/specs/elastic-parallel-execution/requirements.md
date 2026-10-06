# Requirements Document

## Introduction

This feature (FEAT-010 and FEAT-012 of the Menagerie Autonomous Operations Lift amendment) replaces the fixed process-wide worker pool with an elastic logical execution fabric. Today, parallel task execution is gated by a single `ParallelTaskPool` constructed with capacity 4 (`export const parallelTaskPool = new ParallelTaskPool(4)`), and the `parallel_tasks` tool accepts between one and four tasks (`parallelTasksSchema` with `.max(4)`). This hard four-worker ceiling conflates two distinct ideas — how many tasks can be *logically alive* and how many *inference generations* can run at once — and blocks richer orchestration patterns such as reader swarms, speculative branches, and event-driven dependency graphs.

The elastic fabric separates logical task concurrency from physical inference concurrency. Many more logical workers may be alive than there are physical inference slots, because inference capacity is leased per generation rather than reserved for a worker's whole lifetime. A worker that is waiting on a long-running tool, waiting on a dependency, or waiting on the user does not hold an inference slot. A bounded elastic scheduler replaces the fixed four-worker pool, driven by an event-based task DAG so that a dependent node becomes runnable the instant all of its dependencies complete and never waits on unrelated siblings.

The governing ownership rule is: GLM schedules cognition; the user sets the aggressiveness ceiling; Menagerie manages the logical graph; OmniRoute schedules silicon. Menagerie owns logical task orchestration — decomposition, dependencies, admission of logical work, priority, speculation, and backpressure of new fan-out. OmniRoute owns inference admission, model selection, residency, and physical placement. Menagerie MUST NOT contain GPU-aware logic.

This spec covers the logical fabric (FEAT-010) and parallelism metrics with adaptive tuning (FEAT-012). It references reasoning budgets, verification, and structured results as defined in the sibling `mastermind-execution-metadata` spec without redefining them. The user-facing parallelism control is a separate spec (FEAT-011, `user-controlled-parallelism`); this spec treats the user parallelism policy only as a ceiling that constrains aggressiveness. The observatory UI, loop detection, tiers, semantic retrieval, branding, and reasoning budgets are separate specs and are referenced only where behavior must be observable.

The feature preserves existing parallel-task persistence (`parallel-tasks/<batchId>/` manifests and per-worker records written by `runParallelTasks`), Git-worktree isolation, result ownership (children never mutate the parent's message buffers), and the lifecycle reducers in `src/core/task-persistence/taskLifecycle.ts`. The new logical worker states integrate with the existing lifecycle model rather than replacing it.

## Glossary

- **Menagerie**: The autonomous operations system that owns logical task orchestration — decomposition, dependency graphs, admission of logical work, scheduling priority, speculation, and backpressure of new fan-out.
- **OmniRoute**: The external system that owns physical inference: inference admission, model selection, model residency, and physical placement. OmniRoute exposes route capability and capacity abstractions and may independently queue or delay generations.
- **Logical_Worker**: A task runtime that Menagerie tracks as alive. A Logical_Worker exists and progresses through its lifecycle without necessarily consuming an inference slot.
- **Physical_Inference_Concurrency**: The number of model generations that can execute simultaneously, admitted and bounded by OmniRoute. This is distinct from, and typically smaller than, the number of live Logical_Workers.
- **Logical_Worker_State**: One of `queued`, `runnable`, `waiting-for-inference`, `generating`, `running-tool`, `waiting-on-tool`, `waiting-on-dependency`, `waiting-for-user`, `verifying`, `completed`, `failed`, or `cancelled`.
- **RouteCapacity**: A capability/capacity abstraction OmniRoute exposes with fields `route`, `capacity`, `available`, `capability` (one of `"reader"`, `"reasoner"`, `"long-context"`, `"vision"`, `"general"`), and optional `pressure`. It describes route-level inference capacity without revealing GPU placement.
- **Task_DAG**: The directed acyclic graph the mastermind represents, whose nodes are tasks and whose edges are dependencies. Independent nodes may execute concurrently.
- **Dependency**: A relationship in which one node (the dependent) requires one or more other nodes (its dependencies) to complete before it may run.
- **Runnable**: The state of a Logical_Worker whose dependencies are all complete and that is eligible to be dispatched, independent of whether inference capacity is currently available.
- **Reader_Swarm**: A first-class decomposition pattern that splits an investigation into independent semantic scopes, each executed by a reader that returns bounded structured evidence, which the mastermind then synthesizes.
- **Dynamic_Fan_Out**: The mastermind's determination of a useful reader (or worker) count that saturates useful work rather than available worker count. Available capacity does not mandate utilization.
- **Work_Stealing**: Splitting long-running reader work into new bounded child tasks when idle reader capacity appears, so remaining investigation finishes concurrently while preserving provenance and output contracts.
- **Speculative_Execution**: Concurrent investigation of multiple hypotheses, where branches are cancelled when evidence eliminates them, and which carries lower scheduling priority than critical-path work.
- **Inference_Lease**: Inference capacity treated as a per-generation resource. A lease is held only while a Logical_Worker is `generating` and released during tool execution and I/O waits.
- **Scheduling_Priority**: One of `critical`, `high`, `normal`, `background`, or `speculative`, used to order inference admission when capacity is constrained.
- **Critical_Path**: The chain of dependent Task_DAG nodes that determines the earliest possible completion time of the overall task. Critical-path nodes receive scheduling preference.
- **Dynamic_Admission**: The policy by which a Logical_Worker that exceeds currently available inference capacity remains `runnable` or `queued` (not rejected) until suitable capacity frees.
- **Backpressure**: Reduction of new logical fan-out when continuing to add execution would degrade quality, driven by signals such as route saturation, high first-token latency, memory pressure, model swap in progress, queue length, context pressure, error rate, and thermal or resource constraints exposed by OmniRoute.
- **Useful_Parallelism_Ratio**: The ratio of Logical_Workers whose results contributed to the final outcome to the total number of Logical_Workers created.
- **Critical_Path_Idle**: The accumulated time during which a critical-path task was `runnable` AND suitable inference capacity was unavailable.
- **Cognition_Silicon_Ownership**: The division of responsibility in which Menagerie manages the logical graph (cognition orchestration) and OmniRoute schedules inference (silicon), such that Menagerie never contains GPU-aware logic.
- **User_Parallelism_Policy**: The aggressiveness ceiling set by the user (owned by FEAT-011, `user-controlled-parallelism`). This spec treats it only as an upper bound on logical fan-out and dispatch.
- **Bounded_Elastic_Scheduler**: The scheduler that replaces the fixed four-worker `ParallelTaskPool`, admitting logical work up to configurable live and dispatched bounds, constrained by the User_Parallelism_Policy and OmniRoute admission.

## Requirements

### Logical Fabric (FEAT-010)

### Requirement 1: Separate logical concurrency from physical inference concurrency (PAR-001)

**User Story:** As a Menagerie operator, I want logical task concurrency to be independent of physical inference concurrency, so that the system can keep many tasks alive without reserving an inference slot for each.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL track logical task concurrency as a quantity distinct from Physical_Inference_Concurrency.
2. THE Bounded_Elastic_Scheduler SHALL support at least 12 simultaneous live Logical_Workers.
3. WHEN at least 12 Logical_Workers are alive simultaneously, THE Bounded_Elastic_Scheduler SHALL preserve each Logical_Worker's lifecycle without corruption of task state.
4. WHILE a Logical_Worker is not `generating`, THE Bounded_Elastic_Scheduler SHALL NOT consume an Inference_Lease on behalf of that Logical_Worker.
5. THE Bounded_Elastic_Scheduler SHALL permit the count of live Logical_Workers to exceed the count of available inference slots.
6. THE Bounded_Elastic_Scheduler SHALL represent each Logical_Worker as being in exactly one Logical_Worker_State.

### Requirement 2: Route capacity interface without GPU placement (PAR-002)

**User Story:** As a Menagerie scheduler, I want a route capability and capacity abstraction, so that I can decide whether more useful work can be dispatched without knowing anything about GPU placement.

#### Acceptance Criteria

1. WHERE OmniRoute exposes a RouteCapacity, THE RouteCapacity SHALL include `route`, `capacity`, `available`, and `capability` fields and MAY include a `pressure` field.
2. THE RouteCapacity `capability` field SHALL be one of `reader`, `reasoner`, `long-context`, `vision`, or `general`.
3. WHEN Menagerie reads a RouteCapacity, THE Bounded_Elastic_Scheduler MAY use the `available` and `capacity` values to decide whether additional useful work can be dispatched.
4. THE Bounded_Elastic_Scheduler SHALL NOT derive GPU placement from any RouteCapacity field.
5. THE RouteCapacity abstraction SHALL NOT reveal GPU placement.

### Requirement 3: Replace the fixed four-worker ceiling (PAR-003)

**User Story:** As a Menagerie operator, I want the fixed four-worker pool replaced by a bounded elastic scheduler, so that orchestration is no longer capped at four tasks.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL replace the fixed four-worker execution ceiling currently enforced by `parallelTaskPool = new ParallelTaskPool(4)`.
2. THE `parallel_tasks` tool SHALL accept a number of tasks greater than four, removing the current `parallelTasksSchema` `.max(4)` cap.
3. THE Bounded_Elastic_Scheduler SHALL default to a maximum of 12 live Logical_Workers and a maximum of 8 concurrently dispatched Logical_Workers.
4. THE Bounded_Elastic_Scheduler SHALL expose the maximum live and maximum dispatched bounds as configurable values.
5. THE Bounded_Elastic_Scheduler SHALL constrain the maximum live and maximum dispatched bounds by the User_Parallelism_Policy.
6. WHEN OmniRoute queues or delays a generation by route capacity, THE Bounded_Elastic_Scheduler SHALL keep the affected Logical_Worker alive and SHALL NOT treat the delay as a failure.

### Requirement 4: Event-driven task DAG (PAR-004)

**User Story:** As a mastermind, I want to represent dependencies as a DAG and run independent nodes concurrently, so that dependent work starts the instant its inputs are ready and never waits on unrelated siblings.

#### Acceptance Criteria

1. THE mastermind SHALL represent task dependencies as a Task_DAG.
2. WHILE two Task_DAG nodes are independent, THE Bounded_Elastic_Scheduler SHALL permit the nodes to execute concurrently.
3. WHEN all dependencies of a dependent node complete, THE Bounded_Elastic_Scheduler SHALL mark the dependent node `runnable`.
4. WHILE at least one dependency of a dependent node is incomplete, THE Bounded_Elastic_Scheduler SHALL NOT begin the dependent node.
5. THE Bounded_Elastic_Scheduler SHALL NOT require a `runnable` dependent node to wait for unrelated sibling tasks to complete.
6. WHEN a Logical_Worker completes, THE Bounded_Elastic_Scheduler SHALL publish a completion event that MAY unlock dependents, satisfy evidence, cancel speculative siblings, trigger a verifier, trigger a new reader fan-out, or update task state.
7. WHEN a subset of a batch's Logical_Workers complete, THE mastermind SHALL act on the published completion events without waiting for every child in the batch to complete.

### Requirement 5: Reader swarms and dynamic fan-out (PAR-005)

**User Story:** As a mastermind, I want to decompose investigation into independent reader scopes that run concurrently, so that I can gather bounded evidence in parallel and synthesize it.

#### Acceptance Criteria

1. THE mastermind SHALL support a Reader_Swarm that decomposes an investigation into independent semantic scopes.
2. WHEN a Reader_Swarm executes, THE Bounded_Elastic_Scheduler SHALL run the reader scopes concurrently subject to route capacity, the User_Parallelism_Policy, and OmniRoute admission.
3. WHEN a reader completes, THE reader SHALL return bounded structured evidence within the reader output bounds (`MAX_READER_DOCUMENT_BYTES` and `MAX_READER_EXCERPT_CHARS`).
4. WHEN all readers in a Reader_Swarm complete, THE mastermind SHALL synthesize their evidence.
5. WHEN the mastermind determines reader count by Dynamic_Fan_Out, THE mastermind SHALL size the swarm to saturate useful work rather than to match available worker count.
6. WHERE additional inference capacity is available, THE mastermind SHALL NOT create readers beyond those that perform useful work.

### Requirement 6: Work stealing and dynamic splitting (PAR-006)

**User Story:** As a mastermind, I want long-running reader work to be splittable when idle reader capacity appears, so that remaining investigation finishes concurrently.

#### Acceptance Criteria

1. WHEN idle reader capacity appears WHILE a reader has outstanding bounded investigation, THE Bounded_Elastic_Scheduler SHOULD split the remaining work into one or more new bounded child tasks.
2. WHEN work is split, THE Bounded_Elastic_Scheduler SHALL run the new child tasks concurrently with the remaining original work.
3. WHEN work is split, THE Bounded_Elastic_Scheduler SHALL preserve task provenance, evidence ownership, parent and child relationships, and bounded output contracts.

### Requirement 7: Speculative execution and isolated cancellation (PAR-007)

**User Story:** As a mastermind, I want to investigate multiple hypotheses concurrently and cancel eliminated branches, so that I converge faster without the cost of a wrong serial guess.

#### Acceptance Criteria

1. THE mastermind MAY investigate multiple hypotheses concurrently as Speculative_Execution.
2. WHEN evidence eliminates a hypothesis, THE mastermind SHALL cancel the corresponding speculative branch.
3. THE Bounded_Elastic_Scheduler SHALL assign Speculative_Execution a lower Scheduling_Priority than critical-path work.
4. WHEN a speculative task is cancelled, THE Bounded_Elastic_Scheduler SHALL NOT affect that task's siblings, its parent, persisted evidence, or any other branch.
5. WHEN a speculative task is cancelled, THE Bounded_Elastic_Scheduler SHOULD preserve useful partial evidence produced by that task.
6. WHEN a speculative task is cancelled because its hypothesis was eliminated, THE Bounded_Elastic_Scheduler SHALL record the outcome as `cancelled — hypothesis eliminated` rather than as a failure.

### Requirement 8: Inference leasing per generation (PAR-008)

**User Story:** As a Menagerie operator, I want inference capacity leased per generation rather than per worker lifetime, so that far more logical work can proceed than there are physical inference slots.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL treat inference capacity as a per-generation Inference_Lease rather than a per-worker-lifetime reservation.
2. WHEN a Logical_Worker enters the `generating` state, THE Bounded_Elastic_Scheduler SHALL hold an Inference_Lease for that worker.
3. WHEN a Logical_Worker leaves the `generating` state to run a tool or wait on I/O, THE Bounded_Elastic_Scheduler SHALL release that worker's Inference_Lease.
4. WHILE a Logical_Worker is `running-tool`, `waiting-on-tool`, `waiting-on-dependency`, or `waiting-for-user`, THE Bounded_Elastic_Scheduler SHALL NOT hold an Inference_Lease for that worker.

### Requirement 9: I/O concurrency independent of model parallelism (PAR-009)

**User Story:** As a Menagerie operator, I want tool-heavy tasks to not reduce model parallelism, so that I/O work and model generation proceed independently.

#### Acceptance Criteria

1. WHILE a Logical_Worker is `running-tool` or `waiting-on-tool`, THE Bounded_Elastic_Scheduler SHALL NOT reduce the number of other Logical_Workers that may be `generating`.
2. THE Bounded_Elastic_Scheduler SHALL distinguish inference-running, tool-running, and tool-waiting Logical_Workers.

### Requirement 10: Scheduling priority and critical-path awareness (PAR-010)

**User Story:** As a mastermind, I want higher-priority and critical-path work admitted before lower-priority work, so that optional work never delays the architect or verifier.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL assign each Logical_Worker a Scheduling_Priority of `critical`, `high`, `normal`, `background`, or `speculative`.
2. WHILE inference capacity is constrained, THE Bounded_Elastic_Scheduler SHOULD admit higher-priority inference requests before lower-priority inference requests.
3. THE mastermind SHOULD identify Critical_Path nodes within the Task_DAG.
4. WHILE inference capacity is constrained, THE Bounded_Elastic_Scheduler SHALL give critical-path Logical_Workers scheduling preference over non-critical-path Logical_Workers.
5. THE Bounded_Elastic_Scheduler SHALL NOT allow `background` or `speculative` work to delay admission of the architect or a required verifier.

### Requirement 11: Dynamic admission of over-capacity work (PAR-011)

**User Story:** As a Menagerie operator, I want tasks that exceed available inference capacity to remain queued rather than rejected, so that useful work is not lost when capacity is temporarily full.

#### Acceptance Criteria

1. IF a Logical_Worker's inference request exceeds currently available inference capacity, THEN THE Bounded_Elastic_Scheduler SHALL keep the Logical_Worker `runnable` or `queued` rather than rejecting it.
2. WHEN suitable inference capacity frees, THE Bounded_Elastic_Scheduler SHALL admit a `runnable` Logical_Worker that was waiting for capacity.
3. WHILE a Logical_Worker is `runnable` and waiting for inference capacity, THE Bounded_Elastic_Scheduler SHALL expose a `Runnable — waiting for inference capacity` state for observatory consumption.

### Requirement 12: Backpressure on logical fan-out (PAR-012)

**User Story:** As a Menagerie operator, I want parallelism constrained when more execution would degrade quality, so that the system backs off under sustained pressure.

#### Acceptance Criteria

1. WHEN continuing to add execution would degrade quality, THE Bounded_Elastic_Scheduler SHALL constrain new logical fan-out.
2. THE Bounded_Elastic_Scheduler SHALL treat route saturation, high first-token latency, memory pressure, model swap in progress, queue length, context pressure, error rate, and thermal or resource constraints exposed by OmniRoute as Backpressure signals.
3. WHEN OmniRoute reports sustained pressure, THE Bounded_Elastic_Scheduler SHALL reduce new logical fan-out.
4. THE Bounded_Elastic_Scheduler SHALL defer physical backpressure to OmniRoute rather than modeling physical capacity itself.

### Requirement 13: No GPU-aware logic in Menagerie (PAR-013)

**User Story:** As a Menagerie maintainer, I want Menagerie to contain no GPU-aware logic, so that all physical placement and model residency decisions remain with OmniRoute.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL operate only on route capability and capacity abstractions, not on GPU, VRAM, CUDA, or node identities.
2. THE Bounded_Elastic_Scheduler SHALL NOT branch its logical decisions on a specific GPU model.
3. THE Bounded_Elastic_Scheduler SHALL NOT decide model load or unload.
4. THE Bounded_Elastic_Scheduler SHALL delegate model selection, residency, and physical placement to OmniRoute.

### Requirement 14: User parallelism policy as a ceiling (PAR-014)

**User Story:** As a user, I want my parallelism policy to limit aggressiveness for exactly the request I submitted, so that selecting a high setting raises the ceiling without manufacturing busywork.

#### Acceptance Criteria

1. WHEN the user submits a request, THE Bounded_Elastic_Scheduler SHALL apply the User_Parallelism_Policy as an upper bound on logical fan-out and dispatch for that exact submitted request.
2. WHERE the User_Parallelism_Policy selects its maximum aggressiveness setting, THE Bounded_Elastic_Scheduler SHALL raise the fan-out ceiling without creating Logical_Workers that perform no useful work.
3. WHEN the mastermind operates under the Auto policy, THE Bounded_Elastic_Scheduler SHALL scale the Logical_Worker count by useful decomposition and route capacity rather than by a fixed count.

### Parallelism Metrics (FEAT-012)

### Requirement 15: Collect local parallelism metrics

**User Story:** As a Menagerie operator, I want local parallelism metrics collected per execution, so that I can measure how effectively parallelism is used.

#### Acceptance Criteria

1. WHEN an execution runs, THE Bounded_Elastic_Scheduler SHALL record Logical_Workers created, peak live Logical_Workers, peak `runnable` Logical_Workers, and peak simultaneous generations.
2. WHEN a Reader_Swarm executes, THE Bounded_Elastic_Scheduler SHALL record the Reader_Swarm size.
3. WHEN a Logical_Worker runs, THE Bounded_Elastic_Scheduler SHALL record queue wait time, generation duration, tool wait duration, and task duration for that worker.
4. WHEN an execution runs, THE Bounded_Elastic_Scheduler SHALL record speculative cancellation count, Work_Stealing operation count, and Critical_Path_Idle time.
5. WHEN an execution reads route information, THE Bounded_Elastic_Scheduler SHALL record route capacity and route pressure.
6. WHEN an execution completes, THE Bounded_Elastic_Scheduler SHALL record time-to-first-useful-result and time-to-final-result.

### Requirement 16: Useful parallelism efficiency metric

**User Story:** As a Menagerie operator, I want a useful parallelism efficiency metric, so that tuning optimizes toward useful work rather than toward maximum worker count.

#### Acceptance Criteria

1. WHEN an execution completes, THE Bounded_Elastic_Scheduler SHALL compute the Useful_Parallelism_Ratio as the number of Logical_Workers whose results contributed to the final outcome divided by the number of Logical_Workers created.
2. THE Bounded_Elastic_Scheduler SHALL expose the Useful_Parallelism_Ratio as an efficiency metric rather than exposing worker count as the efficiency objective.

### Requirement 17: Critical-path idle metric

**User Story:** As a Menagerie operator, I want to measure critical-path idle time, so that I can minimize time a critical task waits for inference capacity.

#### Acceptance Criteria

1. WHILE a critical-path task is `runnable` AND suitable inference capacity is unavailable, THE Bounded_Elastic_Scheduler SHALL accumulate Critical_Path_Idle time.
2. THE Bounded_Elastic_Scheduler SHALL expose Critical_Path_Idle as a metric whose objective is minimization.

### Requirement 18: Speculation value metric

**User Story:** As a Menagerie operator, I want each speculative task's value recorded, so that I can judge whether speculation is worthwhile.

#### Acceptance Criteria

1. WHEN a speculative task runs, THE Bounded_Elastic_Scheduler SHALL record the task's hypothesis, duration, and token count.
2. WHEN a speculative task settles, THE Bounded_Elastic_Scheduler SHALL record whether the task affected the final decision and whether the task was cancelled early.

### Requirement 19: Parallelism learning tunes orchestration only

**User Story:** As a Menagerie operator, I want historical execution data to inform the Auto policy, so that orchestration improves over time without touching physical placement.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler MAY use historical execution data to tune the Auto policy.
2. WHERE parallelism learning adjusts behavior, THE Bounded_Elastic_Scheduler SHALL apply the adjustment to orchestration policy only.
3. THE Bounded_Elastic_Scheduler SHALL NOT apply parallelism learning to physical GPU placement.

### Requirement 20: Observable logical worker states

**User Story:** As an observatory consumer, I want logical worker states exposed distinctly, so that the UI can show what each worker is doing.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL expose each Logical_Worker's current Logical_Worker_State for observatory consumption.
2. THE Bounded_Elastic_Scheduler SHALL distinguish `queued`, `waiting-for-inference`, `generating`, `running-tool`, `waiting-on-tool`, and `waiting-on-dependency` as separate observable states.

### Requirement 21: Preserve persistence, isolation, and lifecycle integration

**User Story:** As a Menagerie maintainer, I want the elastic fabric to preserve existing persistence, isolation, and lifecycle guarantees, so that the change is additive and non-breaking.

#### Acceptance Criteria

1. THE Bounded_Elastic_Scheduler SHALL preserve the existing parallel-task persistence layout, including per-batch `parallel-tasks/<batchId>/` manifests and per-worker records.
2. THE Bounded_Elastic_Scheduler SHALL preserve Git-worktree isolation for each Logical_Worker.
3. THE Bounded_Elastic_Scheduler SHALL preserve result ownership such that child Logical_Workers do not mutate the parent's message buffers.
4. THE Bounded_Elastic_Scheduler SHALL integrate the Logical_Worker_State values with the existing lifecycle reducers in `src/core/task-persistence/taskLifecycle.ts` without corrupting the persisted lifecycle graph.
5. WHEN a Logical_Worker is cancelled or fails, THE Bounded_Elastic_Scheduler SHALL NOT abandon sibling Logical_Workers that hold inference leases or scheduler permits.
