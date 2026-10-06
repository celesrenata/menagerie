# Requirements Document

## Introduction

This feature equips the Menagerie GLM mastermind with "orchestrator intelligence": the ability to attach normalized execution metadata to delegated work without becoming a GPU scheduler. It bundles four sub-features of the Menagerie Autonomous Operations Lift:

- **FEAT-006 — Reasoning and execution budget:** The mastermind expresses how hard a problem deserves to be thought about using a normalized reasoning enum, optional adaptive escalation, and a priority bias. Menagerie carries this intent; OmniRoute translates it into provider/model capabilities.
- **FEAT-007 — Structured worker results and evidence:** Workers return a bounded, structured `WorkerResult` to the parent context while the complete result stays persisted, so the mastermind reasons over findings and evidence instead of raw transcripts.
- **FEAT-008 — Verification as a first-class phase:** For consequential work, the mastermind can require independent verification by a separate verifier role, with a compact pass/fail evidence list gating success.
- **FEAT-009 — Structured autonomous task state:** Task state (`AutonomousTaskState`) becomes first-class data that survives context condensation, rather than being reconstructed from conversational prose.

The governing ownership rule across all four sub-features is: **GLM schedules cognition; OmniRoute schedules silicon.** The mastermind expresses cognition intent (reasoning effort, priority, verification policy, execution intent); it does not and must not select physical placement (GPU, VRAM, CUDA device, provider-specific thinking tokens, or physical node) unless the user explicitly supplied a route override.

### Scope Boundaries (Non-Goals)

This spec deliberately excludes, and must not implement or redefine:

- GPU / VRAM / CUDA device / physical-node / provider-thinking-token selection by GLM (owned by OmniRoute).
- DAG scheduling, elastic/user-controlled parallelism, reader swarms, and speculation (owned by FEAT-010 / FEAT-011 / FEAT-012).
- The Task Observatory UI (separate spec; referenced only).
- Tier ceilings and tier semantics (owned by the immediate-tier-semantics spec; referenced, not redefined).
- Loop detection, semantic retrieval, and branding (separate specs).

This spec must not break the existing `ParallelTaskSpec` fields (`name`, `mode`, `message`, `todos`, `route`) or the existing `compactParallelTasksResultForParent` bounded-parent behavior.

## Glossary

- **Mastermind / GLM:** The orchestrating model that delegates work via `new_task` handoff and `parallel_tasks`. It expresses cognition intent and task state; it does not choose physical placement.
- **OmniRoute:** The routing layer that translates normalized cognition intent into provider/model-specific capabilities and resolves physical placement.
- **Worker:** A delegated task (implementer, verifier, fixer, reader, etc.) spawned via `new_task` or `parallel_tasks` that performs work and returns a result.
- **Cognition-vs-Silicon Ownership:** The invariant that GLM schedules cognition (reasoning effort, priority, verification policy, execution intent) while OmniRoute schedules silicon (GPU, VRAM, CUDA device, provider thinking tokens, physical node).
- **Route Override:** A user-supplied `route` value on a `ParallelTaskSpec` (or equivalent handoff field) that explicitly pins placement. The only condition under which placement-related selection is permitted to originate outside OmniRoute.
- **ReasoningEffort (normalized orchestration enum):** The orchestration-facing enum `"minimal" | "low" | "medium" | "high" | "max"` used by the mastermind to express reasoning intent. It is a normalized subset that maps onto the existing `reasoningEffortsExtended` enum in `packages/types/src/model.ts` (`"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`). It is NOT a new conflicting type; design must reconcile it with the existing `ReasoningEffort` (`"low" | "medium" | "high"`) and `ReasoningEffortWithMinimal` types.
- **WorkerReasoningPolicy:** The reasoning intent attached to a worker: `{ effort: ReasoningEffort; adaptive?: boolean; maxEffort?: ReasoningEffort; priority?: "latency" | "balanced" | "quality" }`.
- **Adaptive Reasoning:** Behavior where a worker begins at the requested `effort` and may escalate up to `maxEffort` in response to defined triggers, never exceeding `maxEffort`.
- **Escalation:** A single increase in applied reasoning effort during adaptive reasoning, triggered by ambiguity, conflicting evidence, repeated failures, or low confidence.
- **Priority (reasoning bias):** A worker-level bias toward `"latency"`, `"balanced"`, or `"quality"` that informs how reasoning intent is translated. It is a cognition bias, not a physical-placement directive.
- **WorkerResult:** The bounded, structured contract a worker returns: `{ status; summary; findings; evidence; changes; tests; blockers; artifacts; reasoning? }`.
- **Finding:** A single claim produced by a worker: `{ claim: string; confidence?: number }`.
- **Evidence Reference:** A pointer to verifiable support for a result: `{ type: "file" | "test" | "command" | "url" | "screenshot"; reference: string; lines?: [number, number]; result?: string }`.
- **Verification Policy:** The mastermind's request for independent verification on a task: `{ required: boolean; mode?: string; criteria?: string[] }`.
- **Verifier:** A distinct worker role that independently checks an implementer's work and returns a compact pass/fail evidence list. The implementer is not the sole source asserting its own correctness.
- **Consequential Task:** A task whose outcome has material impact (code modification, deployment, migration/destructive infrastructure) for which independent verification is recommended or required by default.
- **AutonomousTaskState:** First-class task state: `{ objective; constraints; decisions; assumptions; activeWork; completedWork; filesTouched; blockers; openQuestions; evidence; nextActions }`.
- **Context Condensation:** The existing `condenseContext` operation on a `Task` that summarizes conversational history to fit the context window. `AutonomousTaskState` must survive it.
- **Bounded Parent Result:** The existing mechanism (`compactParallelTasksResultForParent`, `clipParentResult`, `MAX_WORKER_PARENT_RESULT_CHARS`, `MAX_WORKER_PARENT_ERROR_CHARS`) that bounds what a worker injects into the coordinator/parent context while the full result stays persisted in the worker record and manifest.
- **Task Observatory:** A separate feature/spec that can display complete raw worker history. Referenced here only as a downstream consumer of the full persisted result and `AutonomousTaskState`.

## Requirements

### FEAT-006 — Reasoning and Execution Budget

#### Requirement 1: Normalized reasoning effort enum

**User Story:** As the GLM mastermind, I want a normalized reasoning-effort vocabulary, so that I can express how hard a problem deserves to be thought about independent of any provider's internal knobs.

##### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL define a normalized `ReasoningEffort` orchestration enum with exactly the values `"minimal"`, `"low"`, `"medium"`, `"high"`, and `"max"`.
2. THE Menagerie_Orchestration_Layer SHALL define the normalized `ReasoningEffort` enum as a mapping onto the existing `reasoningEffortsExtended` enum in `packages/types/src/model.ts` rather than as a conflicting independent type.
3. IF a reasoning-effort value outside the normalized enum is supplied by the mastermind, THEN THE Menagerie_Orchestration_Layer SHALL reject the value with a descriptive error identifying the permitted values.
4. THE Menagerie_Orchestration_Layer SHALL preserve the existing `ReasoningEffort` (`"low" | "medium" | "high"`), `ReasoningEffortWithMinimal`, and `reasoningEffortsExtended` type definitions without modifying their members.

#### Requirement 2: Worker reasoning policy

**User Story:** As the GLM mastermind, I want to attach a reasoning policy to a worker, so that each delegated task carries its intended cognition budget and bias.

##### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL define a `WorkerReasoningPolicy` with a required `effort` field of type normalized `ReasoningEffort`.
2. THE Menagerie_Orchestration_Layer SHALL define `WorkerReasoningPolicy` with optional fields `adaptive` (boolean), `maxEffort` (normalized `ReasoningEffort`), and `priority` (one of `"latency"`, `"balanced"`, `"quality"`).
3. WHEN a `WorkerReasoningPolicy` is supplied with `adaptive` set to `true` and no `maxEffort`, THE Menagerie_Orchestration_Layer SHALL treat the requested `effort` as the escalation ceiling.
4. IF a `WorkerReasoningPolicy` supplies a `maxEffort` lower than its `effort`, THEN THE Menagerie_Orchestration_Layer SHALL reject the policy with a descriptive error.

#### Requirement 3: ParallelTaskSpec reasoning field

**User Story:** As the GLM mastermind, I want to specify reasoning intent per parallel worker, so that different workers in a batch can be budgeted differently.

##### Acceptance Criteria

1. THE ParallelTasksTool SHALL accept an optional `reasoning` field of type `WorkerReasoningPolicy` on each `ParallelTaskSpec`.
2. WHEN a `ParallelTaskSpec` omits the `reasoning` field, THE ParallelTasksTool SHALL accept the spec and apply the existing default reasoning behavior.
3. THE ParallelTasksTool SHALL continue to accept the existing `ParallelTaskSpec` fields `name`, `mode`, `message`, `todos`, and `route` with their current validation bounds.
4. WHEN a `ParallelTaskSpec` carries both a `reasoning` policy and a `route` override, THE ParallelTasksTool SHALL accept both fields and pass each through without resolving placement locally.

#### Requirement 4: Cognition-vs-silicon ownership

**User Story:** As a platform owner, I want GLM to schedule cognition and OmniRoute to schedule silicon, so that the mastermind cannot make physical-placement decisions that belong to the routing layer.

##### Acceptance Criteria

1. WHEN the mastermind supplies reasoning intent, THE Menagerie_Orchestration_Layer SHALL carry the normalized reasoning intent to OmniRoute without translating it into provider/model-specific capabilities.
2. THE OmniRoute_Layer SHALL translate normalized reasoning intent into provider/model-specific capabilities.
3. WHERE the user has not supplied a route override, THE Menagerie_Orchestration_Layer SHALL reject any mastermind-originated selection of GPU, VRAM, CUDA device, provider-specific thinking tokens, or physical node.
4. WHERE the user has supplied an explicit route override on a worker spec, THE Menagerie_Orchestration_Layer SHALL pass the route identifier through to OmniRoute for placement resolution.
5. THE Menagerie_Orchestration_Layer SHALL NOT redefine tier ceilings and SHALL defer to the immediate-tier-semantics spec for tier-ceiling definitions.

#### Requirement 5: Adaptive reasoning and escalation

**User Story:** As the GLM mastermind, I want a worker to think harder when a problem turns out to be difficult, so that effort scales with difficulty without exceeding a budget.

##### Acceptance Criteria

1. WHEN a worker is configured with `{ effort: "medium", adaptive: true, maxEffort: "high", priority: "balanced" }`, THE Worker SHALL begin execution at `"medium"` reasoning effort.
2. WHILE a worker runs with adaptive reasoning enabled, IF the worker encounters ambiguity, conflicting evidence, repeated failures, or low confidence, THEN THE Worker SHALL escalate the applied reasoning effort toward `maxEffort`.
3. THE Worker SHALL NOT escalate the applied reasoning effort above the configured `maxEffort`.
4. WHEN adaptive reasoning is disabled or unset, THE Worker SHALL hold the applied reasoning effort at the requested `effort`.
5. WHEN a worker completes, THE Worker SHOULD report `reasoning: { requested, used, escalations }` in its result, where `requested` and `used` are normalized `ReasoningEffort` values and `escalations` is a non-negative integer count.

### FEAT-007 — Structured Worker Results and Evidence

#### Requirement 6: Bounded structured representation with full persistence

**User Story:** As the GLM mastermind, I want a bounded structured summary of a worker's result while the complete output is retained, so that my context is not flooded by large completion text yet nothing is lost.

##### Acceptance Criteria

1. WHEN a worker completes, THE Menagerie_Orchestration_Layer SHALL persist the complete worker result in the worker record and the parallel-task manifest.
2. WHEN a worker result is injected into the coordinator/parent context, THE Menagerie_Orchestration_Layer SHALL deliver a bounded structured representation through the existing `compactParallelTasksResultForParent` mechanism.
3. IF a structured worker result exceeds the configured parent-context bounds, THEN THE Menagerie_Orchestration_Layer SHALL clip the parent-visible representation and include a reference to the full persisted result.
4. THE Menagerie_Orchestration_Layer SHALL preserve the existing `MAX_WORKER_PARENT_RESULT_CHARS`, `MAX_WORKER_PARENT_ERROR_CHARS`, and reader-specific bound behavior.

#### Requirement 7: WorkerResult contract

**User Story:** As the GLM mastermind, I want workers to return a typed result with findings and evidence, so that I can reason over claims and verifiable references instead of prose.

##### Acceptance Criteria

1. THE Worker SHALL return a `WorkerResult` with a `status` field equal to one of `"completed"`, `"failed"`, or `"blocked"`.
2. THE Worker SHALL return a `WorkerResult` containing a `summary` string, a `findings` array, an `evidence` array, a `changes` string array, a `tests` string array, a `blockers` string array, and an `artifacts` string array.
3. THE Worker SHALL represent each entry of `findings` as `{ claim: string; confidence?: number }`.
4. THE Worker SHALL represent each entry of `evidence` as `{ type: "file" | "test" | "command" | "url" | "screenshot"; reference: string; lines?: [number, number]; result?: string }`.
5. WHERE a worker reports reasoning telemetry, THE Worker SHALL include a `reasoning` field of shape `{ requested: ReasoningEffort; used: ReasoningEffort; escalations: number }`.
6. IF a worker returns a result that does not conform to the `WorkerResult` contract, THEN THE Menagerie_Orchestration_Layer SHALL record a conforming `WorkerResult` with `status` `"failed"` and a descriptive `summary`.

#### Requirement 8: Parent receives bounded result; observatory references full history

**User Story:** As the GLM mastermind, I want the parent context to receive the bounded structured result while the full raw history remains available to the Task Observatory, so that each consumer gets the representation it needs.

##### Acceptance Criteria

1. WHEN a worker completes, THE Menagerie_Orchestration_Layer SHALL deliver the bounded structured `WorkerResult` to the parent context.
2. THE Menagerie_Orchestration_Layer SHALL retain the complete raw worker history in persisted storage for separate consumption by the Task Observatory.
3. THE Menagerie_Orchestration_Layer SHALL NOT implement Task Observatory display behavior within this feature.

### FEAT-008 — Verification as a First-Class Phase

#### Requirement 9: Verification policy on a task

**User Story:** As the GLM mastermind, I want to request independent verification for consequential work, so that correctness is confirmed by a party other than the implementer.

##### Acceptance Criteria

1. THE ParallelTasksTool SHALL accept an optional `verification` field of shape `{ required: boolean; mode?: string; criteria?: string[] }` on a task.
2. WHEN a task omits the `verification` field, THE ParallelTasksTool SHALL accept the task and treat verification as not required.
3. WHEN a `verification` policy sets `required` to `true`, THE Menagerie_Orchestration_Layer SHALL schedule an independent verifier role for the task.

#### Requirement 10: Recommended verification defaults by task kind

**User Story:** As the GLM mastermind, I want sensible default verification expectations per task kind, so that risky work is verified by default and low-risk work is not over-constrained.

##### Acceptance Criteria

1. WHERE a task is read-only analysis, THE Menagerie_Orchestration_Layer SHALL treat verification as optional.
2. WHERE a task is a code modification, THE Menagerie_Orchestration_Layer SHALL recommend verification.
3. WHERE a task is a deployment, THE Menagerie_Orchestration_Layer SHALL treat verification as required.
4. WHERE a task is a migration or destructive infrastructure change, THE Menagerie_Orchestration_Layer SHALL treat verification as required.

#### Requirement 11: Implementer–verifier flow

**User Story:** As the GLM mastermind, I want an implementer-then-verifier flow with a fix loop on failure, so that no implementer is the sole source asserting its own correctness.

##### Acceptance Criteria

1. WHEN verification is required for a task, THE Menagerie_Orchestration_Layer SHALL run the implementer, then an independent verifier, and SHALL report a PASS result to the parent only after the verifier passes.
2. IF the verifier returns a FAIL result, THEN THE Menagerie_Orchestration_Layer SHALL route the task to a fixer followed by a re-run of the verifier.
3. THE Menagerie_Orchestration_Layer SHALL NOT treat the implementer as the sole source asserting the correctness of its own work.
4. THE Menagerie_Orchestration_Layer SHALL schedule the verifier as an additional worker role within the batch and SHALL NOT treat verification scheduling as a GPU-placement concern.

#### Requirement 12: Verification evidence and the required-verification gate

**User Story:** As the GLM mastermind, I want the verifier to return a compact pass/fail evidence list and I want required verification to gate success, so that I confirm correctness without rereading full transcripts.

##### Acceptance Criteria

1. WHEN a verifier completes, THE Verifier SHALL return a compact pass/fail evidence list expressed as `evidence` references rather than a full transcript.
2. THE Menagerie_Orchestration_Layer SHALL NOT consider a task with required verification successfully verified until the verifier criteria pass.
3. IF a task has required verification and the verifier criteria do not pass, THEN THE Menagerie_Orchestration_Layer SHALL report the task as not successfully verified to the parent.
4. WHEN a `verification` policy supplies `criteria`, THE Verifier SHALL evaluate each criterion and SHALL include a pass/fail evidence entry for each supplied criterion.

### FEAT-009 — Structured Autonomous Task State

#### Requirement 13: AutonomousTaskState contract

**User Story:** As the GLM mastermind, I want task state as first-class structured data, so that I maintain objective, decisions, and evidence without reconstructing them from chat prose.

##### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL define an `AutonomousTaskState` containing the fields `objective` (string), `constraints` (string array), `decisions` (string array), `assumptions` (string array), `activeWork` (string array), `completedWork` (string array), `filesTouched` (string array), `blockers` (string array), `openQuestions` (string array), `evidence` (array of Evidence References), and `nextActions` (string array).
2. THE Menagerie_Orchestration_Layer SHALL represent each entry of the `evidence` field of `AutonomousTaskState` as an Evidence Reference of the same shape used by `WorkerResult` evidence.
3. WHEN a worker reports new findings, changes, or blockers, THE Menagerie_Orchestration_Layer SHALL update the corresponding fields of `AutonomousTaskState`.

#### Requirement 14: Task state survives condensation

**User Story:** As the GLM mastermind, I want task state to persist across context condensation, so that the conversational transcript is no longer the sole database for task state.

##### Acceptance Criteria

1. WHEN the `condenseContext` operation runs on a task, THE Menagerie_Orchestration_Layer SHALL preserve the `AutonomousTaskState` for that task.
2. WHEN task state is read after a condensation, THE Menagerie_Orchestration_Layer SHALL return the preserved `AutonomousTaskState` rather than reconstructing it from the conversational transcript.
3. THE Menagerie_Orchestration_Layer SHALL maintain `AutonomousTaskState` as the authoritative source of task state and SHALL NOT treat the conversational transcript as the sole database for task state.

### Cross-Cutting — Ownership and Adaptive Reporting

#### Requirement 15: Cognition expressed by GLM, capabilities resolved by OmniRoute

**User Story:** As a platform owner, I want the mastermind to express how hard to think while OmniRoute decides provider/model capabilities and placement, so that cognition and silicon concerns stay separated.

##### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL carry the mastermind's normalized reasoning intent, priority, verification policy, and execution intent as cognition metadata.
2. THE OmniRoute_Layer SHALL translate normalized reasoning intent into provider/model-specific capabilities and SHALL resolve physical placement.
3. WHERE the user has not supplied a route override, THE Menagerie_Orchestration_Layer SHALL reject any mastermind-originated choice of physical placement.

#### Requirement 16: Worker reasoning telemetry

**User Story:** As the GLM mastermind, I want workers to report requested versus used reasoning and escalation counts, so that I can observe how adaptive reasoning behaved.

##### Acceptance Criteria

1. WHEN a worker completes with reasoning telemetry, THE Worker SHALL report `reasoning.requested` as the normalized `ReasoningEffort` originally requested.
2. WHEN a worker completes with reasoning telemetry, THE Worker SHALL report `reasoning.used` as the highest normalized `ReasoningEffort` applied during execution.
3. WHEN a worker completes with reasoning telemetry, THE Worker SHALL report `reasoning.escalations` as a non-negative integer count of escalations that occurred during execution.
