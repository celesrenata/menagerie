# Implementation Plan: Capability Lanes, Model Routing, and Escalation Policy

## Overview

This plan implements the thin capability-lane layer that sits **above** the elastic scheduler
(`elastic-parallel-execution`) and the structured worker-result contract
(`mastermind-execution-metadata`). Every addition is additive TypeScript in the Menagerie `src/`
tree: no scheduler mechanics, `WorkerResult` base, `RouteCapability` enum, reasoning controller, or
condensation behavior changes. Sibling-spec types (`RouteCapability`, `RouteCapacity`,
`RouteCapacityProvider`, `WorkerResult`, `EvidenceReference`, `AutonomousTaskState`, `EvidencePacket`,
and the loop-detector signal) are consumed **read-only**.

Work proceeds bottom-up and test-first: pure types/mapping land first, then the additive metadata
extension, then the three pure decision components (`RoutingPolicy`, `ReaderEscalationDecision`,
`GlmInvocationGate`) and the `PreparedContextWorkPackageBuilder`, then the additive wiring onto the
existing `ParallelTaskSpec` and reader bounded-output path, and finally the condense-independence
guard. Each pure component is unit- and property-testable because it performs no I/O (capacity,
failure history, and loop signals are passed in).

New source modules live under `src/core/task/`; new tests live under `src/core/task/__tests__/`,
alongside the existing `parallelWorkerRouting.ts` / `ParallelTasksTool.ts` wiring they extend.
Property tests use `fast-check` at the package-local unit layer with a minimum of 100 iterations
each, tagged `// Feature: capability-lanes-routing, Property N: ...`. Integration tests use faked
collaborators (`RouteCapacityProvider`, scheduler settle surface, `WorkerResult`) from
`src/test-utils`; scheduler dispatch/lease/DAG interleavings and the `WorkerResult` base contract are
cross-referenced to the sibling specs rather than re-tested here. No `apps/vscode-e2e` test is added
because no behavior requires the real extension host.

After editing any file, run the narrowest Vitest suite and
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` per AGENTS.md; suppression
counts must not increase. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Tasks

- [x] 1. Define the four capability lanes and the total RouteCapability mapping
  - [x] 1.1 Create `src/core/task/capabilityLanes.ts` with the lane roles, task-type hint, and `laneToRouteCapability`
    - Define the exported `CapabilityLane` union (`"reader.fast" | "reader.deep" | "coder.primary" | "reasoning.escalation"`) and the exhaustive, ordered `CAPABILITY_LANES` const tuple (exactly four lanes).
    - Define the exported `LaneTaskType` union (`"lookup" | "implementation" | "debugging" | "refactor" | "test" | "architecture" | "adjudication" | "long-horizon"`).
    - Import `RouteCapability` read-only from the `elastic-parallel-execution` types; do NOT redefine or widen the enum. If the sibling type is not yet present in the tree, declare a local structural `RouteCapability` type alias in a single clearly-commented location and consume it only — never introduce model/GPU identity.
    - Implement the total, range-safe `laneToRouteCapability(lane, type)`: readers (`reader.fast`/`reader.deep`) → `"reader"`; `coder.primary` → `"reasoner"` for `implementation`/`debugging`/`refactor`, else `"general"`; `reasoning.escalation` → `"long-context"` for `long-horizon`/`architecture`, else `"reasoner"`. The function MUST switch only on lane role and task type (never model name, size, quantization, or GPU identity).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/capabilityLanes.ts`; confirm the suppression count did not increase.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4_

  - [ ]* 1.2 Write property test for the lane-to-capability mapping and model/GPU-identity invariance
    - Create `src/core/task/__tests__/capabilityLanes.spec.ts` with the `fast-check` import.
    - **Property 1: Lane logic never branches on model or GPU identity** (mapping portion) — over all `(CapabilityLane, LaneTaskType)` pairs: readers always yield `"reader"`; `coder.primary` ∈ `{"reasoner","general"}`; `reasoning.escalation` ∈ `{"long-context","reasoner"}`; every result is a member of the fixed `RouteCapability` set; two calls with the same `(lane, type)` are identical regardless of any hypothetical model/hardware binding (`// Feature: capability-lanes-routing, Property 1: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/capabilityLanes.spec.ts`.
    - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 10.8, 13.4_
    - _Properties: 1_

- [x] 2. Define RoutingMetadata as an additive-optional extension of WorkerResult
  - [x] 2.1 Create `src/core/task/routingMetadata.ts` with `RoutingMetadata` and `WorkerResultWithRouting`
    - Import `WorkerResult` read-only from the `mastermind-execution-metadata` types and import `CapabilityLane` from `./capabilityLanes`. Do NOT modify or remove any base `WorkerResult` field.
    - Define `RoutingMetadata` with all-optional fields: `confidence?`, `files_inspected?`, `symbols_inspected?`, `ambiguities?`, `conflicting_findings?`, `recommended_escalation?: CapabilityLane | null`, `tests_run?`, `tests_passed?`, `failure_class?: string | null`, `model_lane?: CapabilityLane`, `hardware_lane?: string | null`.
    - Define `WorkerResultWithRouting extends WorkerResult { routing?: RoutingMetadata }` so an absent `routing` (or absent sub-field) reads as unset rather than an error.
    - Add a small typed reader helper (e.g. `readRoutingField`) that returns `undefined` for any absent field without throwing, so downstream gates treat missing triggers as "not present".
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/routingMetadata.ts`.
    - _Requirements: 12.1, 12.2, 12.5_

  - [ ]* 2.2 Write property test for the additive-optional round trip
    - Create `src/core/task/__tests__/routingMetadata.spec.ts`.
    - **Property 9: RoutingMetadata is additive-optional on WorkerResult** — over generated base `WorkerResult`s, the value validates as `WorkerResultWithRouting` with and without a `routing` field, every base field is preserved, and reading any absent `RoutingMetadata` field yields unset (never throws). Assert that a faked compacted parent view (reusing the shape produced by `compactParallelTasksResultForParent`) never contains the verbatim metadata block (`// Feature: capability-lanes-routing, Property 9: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/routingMetadata.spec.ts`.
    - _Requirements: 12.1, 12.2, 12.4, 12.5_
    - _Properties: 9_

- [x] 3. Implement the pure RoutingPolicy and the five routing patterns
  - [x] 3.1 Create `src/core/task/routingPolicy.ts` with `RoutingContext`, `RoutingDecision`, and `createRoutingPolicy`
    - Import `CapabilityLane`/`LaneTaskType`/`laneToRouteCapability` from `./capabilityLanes`, `RoutingMetadata` from `./routingMetadata`, and `RouteCapability`/`RouteCapacity` read-only from `elastic-parallel-execution`.
    - Define `RoutingContext` (`taskType`, `estimatedComplexity`, `priorMetadata?`, `previousFailures`, `contextRequirement`, `capacity`, `modelResident`, `latencyBudget?`, `queuePressure`, `explicitLaneRequest?`, `loopSignal?`) and `RoutingDecision` (`lane`, `capability`, `pattern`, `reasons`).
    - Implement a pure, synchronous `decide(ctx)` that selects the lane from task type/complexity/prior confidence/failures/context requirement/capacity/residency/latency/queue pressure/loop signal/explicit request. It is NOT a mandatory ladder: encode the five patterns — simple lookup → `["reader.fast"]`; normal implementation → `["reader.fast","coder.primary"]`; ambiguous investigation → `["reader.fast","reader.deep","coder.primary"]`; architectural problem → `["reasoning.escalation","reader.fast","coder.primary"]`; repeated failure → `["reader.fast","coder.primary","coder.primary","reasoning.escalation"]`.
    - Honour `explicitLaneRequest` and direct-assignment characteristics by beginning the `pattern` at the directly indicated lane and skipping intermediate lanes. Populate `capability` via `laneToRouteCapability(lane, taskType)` and set `reasons` to trigger/pattern tags only (never model/GPU identity). Perform no I/O.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/routingPolicy.ts`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 13.1, 13.2_

  - [ ]* 3.2 Write property tests for purity, not-a-ladder, lane-skipping, and the five patterns
    - Create `src/core/task/__tests__/routingPolicy.spec.ts`.
    - **Property 1: Lane logic never branches on model or GPU identity** (policy portion) — two `RoutingContext`s differing only in a hypothetical model/hardware binding (same lane inputs, same task type, same capacity) yield identical `RoutingDecision`s; `decide` is deterministic/pure (`// Feature: ..., Property 1: ...`, ≥100 runs).
    - **Property 2: Routing is not a mandatory ladder and lanes can be skipped** — any `lookup` context routes to `reader.fast → parent` and never includes `reader.deep`/`coder.primary`/`reasoning.escalation`; any direct-assignment context (explicit lane request or architectural task) omits intermediate lanes and begins at the indicated lane (`// Feature: ..., Property 2: ...`, ≥100 runs).
    - **Property 10: The five example routing patterns are produced for their task types** — each of the five named task shapes produces exactly the specified lane pattern (`// Feature: ..., Property 10: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/routingPolicy.spec.ts`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 13.1, 13.2_
    - _Properties: 1, 2, 10_

- [x] 4. Implement the confidence-driven ReaderEscalationDecision with the resource-cost model
  - [x] 4.1 Create `src/core/task/readerEscalationDecision.ts` with triggers, `EscalationCost`, and `decide`
    - Import `RoutingMetadata` from `./routingMetadata` and `RouteCapacity` read-only from `elastic-parallel-execution`.
    - Define `ReaderQualityTrigger` (`"low-confidence" | "contradictory-evidence" | "multi-subsystem" | "unsuccessful-search" | "hard-analysis" | "architectural-ambiguity" | "reader-disagreement" | "explicit-request"`), `EscalationCost` (`modelSwapLoadLatencyMs`, `interruptsParallelFastCapacity`, `queuedFastReaderWork`, `expectedDeepTaskMs`, `alternateHardwareCanAnswer`, `capacity`), `ReaderEscalationInput` (`metadata?`, `explicitRequest`, `cost`), and `ReaderEscalationOutcome` (`stay-fast` | `spawn-another-fast` | `escalate-deep` with `triggers`).
    - Implement `decide(input)` deriving quality triggers ONLY from `RoutingMetadata`/explicit request (confidence below threshold → `low-confidence`; `conflicting_findings > 0` → `contradictory-evidence`/`reader-disagreement`; `ambiguities > 0` → `architectural-ambiguity`; `recommended_escalation === "reader.deep"` or `explicitRequest` → `explicit-request`; caller flags for `multi-subsystem`/`unsuccessful-search`/`hard-analysis`), NEVER from token count.
    - Return `escalate-deep` only when a quality trigger is present AND resource cost (read solely from `RouteCapacity` fields — never GPU/VRAM identity) clears the deep threshold, which is strictly higher than the spawn-another-fast threshold; an `explicitRequest` mandates `escalate-deep` regardless of the cost band. The decision is monotonic in cost (holding quality fixed, higher cost never makes `escalate-deep` more likely). `reader.deep` is never selected for implementation task types.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/readerEscalationDecision.ts`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 13.1_

  - [ ]* 4.2 Write property tests for quality-trigger-only escalation and the resource-aware higher threshold
    - Create `src/core/task/__tests__/readerEscalationDecision.spec.ts`.
    - **Property 3: Reader escalation fires only on quality triggers, never on token count alone** — `escalate-deep` is returned only when ≥1 `ReaderQualityTrigger` is present (and always on explicit request); two inputs differing only in token consumption with no quality trigger are identical and never `escalate-deep` (`// Feature: ..., Property 3: ...`, ≥100 runs).
    - **Property 7: Fast-to-deep escalation uses a higher threshold than spawning another fast reader and is resource-aware** — cost is read only from `RouteCapacity` fields; the decision is monotonic in cost; there exists a signal band choosing `spawn-another-fast` while declining `escalate-deep` (deep threshold strictly exceeds spawn threshold); implementation task types never resolve to `reader.deep` (`// Feature: ..., Property 7: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/readerEscalationDecision.spec.ts`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_
    - _Properties: 3, 7_

- [x] 5. Implement the PreparedContextWorkPackage builder and the ReaderFinding contract
  - [x] 5.1 Create `src/core/task/preparedContextWorkPackage.ts` with `ReaderFinding`, inputs, and `build`
    - Import `EvidenceReference`/`AutonomousTaskState` read-only from `mastermind-execution-metadata` and `EvidencePacket` read-only from `semantic-first-retrieval`.
    - Define `ReaderFinding` (`claim`, `location?` as a `file:line` reference, `whyItMatters?`, `uncertainty?`, `confidence?`, `evidence: EvidenceReference[]`), `PreparedContextWorkPackage` (the nine defined fields: `objective`, `relevantFiles`, `relevantSymbols`, `readerFindings`, `architecturalConstraints`, `knownAssumptions`, `existingTestFailures`, `expectedBehavior`, `implementationBoundaries`), and `PreparedContextInputs` (`objective`, `readerFindings`, `bootstrap?`, `taskState?`).
    - Implement `build(inputs)` merging reader findings (Req 4 contract), `Worker_Bootstrap_Retrieval` evidence (`EvidencePacket`), and `AutonomousTaskState` (objective/constraints/assumptions/test failures). Populate only the nine defined fields, omitting those with no available input. Copy only concise findings and evidence references — NEVER full file contents or function bodies, even when an input origin carries raw source.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/preparedContextWorkPackage.ts`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 13.5, 13.6_

  - [ ]* 5.2 Write property test for the concise-only, no-raw-source package
    - Create `src/core/task/__tests__/preparedContextWorkPackage.spec.ts`.
    - **Property 5: The prepared-context work package contains concise findings, never raw source** — over generated `PreparedContextInputs` (including inputs that carry raw source material in their origin), the built package populates only the nine defined fields (omitting those with no input) and contains only concise findings and evidence references, never full file contents or function bodies (`// Feature: ..., Property 5: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/preparedContextWorkPackage.spec.ts`.
    - _Requirements: 6.3, 6.5_
    - _Properties: 5_

- [x] 6. Implement the GLM dual-role invocation gate with the scarcity guard
  - [x] 6.1 Create `src/core/task/glmInvocationGate.ts` with the trigger sets and `evaluate`
    - Import `RoutingMetadata` from `./routingMetadata`.
    - Define `GlmPlanningTrigger` (`"complex-decomposition" | "scope-assignment" | "constraint-definition" | "synthesis"`), `GlmAdjudicationTrigger` (`"repeated-coder-failure" | "reader-disagreement" | "bug-vs-architecture-conflict" | "system-wide-reasoning" | "cross-subsystem-design" | "coder-low-confidence" | "architectural-uncertainty-despite-passing-tests" | "loop-detector-cyclic"`), `GlmInvocationInput` (`metadata?`, `previousFailures`, `loopSignal`, `complexity`, `contextRequirement`), and `GlmInvocationDecision` (`invoke:false` | `invoke:true` with `role: "planning"` | `"adjudication"` and the matching triggers).
    - Implement `evaluate(input)` deriving adjudication triggers from `RoutingMetadata` (`conflicting_findings`, `ambiguities`, `confidence`, `failure_class`, `recommended_escalation`), from `previousFailures` (repeated coder failures), and from `loopSignal` (`cyclic`/`hard-stop` → `loop-detector-cyclic`); derive planning triggers from complexity/context requirement. Return `invoke:true` if and only if at least one planning or adjudication trigger is present; otherwise return `invoke:false` with reasons, preserving the GLM scarcity invariant (never required per task).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/glmInvocationGate.ts`.
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 13.3_

  - [ ]* 6.2 Write property test for invoke-iff-trigger and scarcity preservation
    - Create `src/core/task/__tests__/glmInvocationGate.spec.ts`.
    - **Property 6: GLM is invoked only when its triggers are present, preserving scarcity** — the gate returns `invoke:true` iff ≥1 planning or adjudication trigger is present (adjudication triggers derived from `RoutingMetadata`, failure history, and loop signal); any input with no trigger returns `invoke:false`, so `reasoning.escalation` is never required per task (`// Feature: ..., Property 6: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/glmInvocationGate.spec.ts`.
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 13.3_
    - _Properties: 6_

- [x] 7. Checkpoint - Ensure all pure-component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Wire lane assignment and follow-up spec production onto the existing ParallelTaskSpec path
  - [x] 8.1 Attach additive lane routing metadata to reader/coder `ParallelTaskSpec`s
    - In a new helper in `src/core/task/parallelWorkerRouting.ts` (extending the existing routing module), build the lane assignment that rides additively on `ParallelTaskSpec`: reader specs keep `mode: "project-reader"`; the chosen `CapabilityLane` is carried via the existing `route` passthrough / additive routing metadata, and the resolved `RouteCapability` from `laneToRouteCapability` is what the scheduler/`InferenceLeasePool` consume. Do NOT change `parallelTaskSpecSchema`'s `.max(...)` cap or `.strip()` behavior; specs without lane metadata must still validate and default (`reader.fast` for reader tasks).
    - Keep the helper pure/synchronous (no scheduler dispatch or leasing changes); it only selects which specs to build and what lane each carries.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/parallelWorkerRouting.ts`.
    - _Requirements: 2.1, 9.8, 13.1_

  - [x] 8.2 Produce escalation and GLM follow-up specs in the deeper lane
    - Add a function that, given a settled `WorkerResultWithRouting` plus failure history and loop signal, invokes `ReaderEscalationDecision.decide` and `GlmInvocationGate.evaluate` and emits a NEW follow-up `ParallelTaskSpec` in the chosen deeper lane (`reader.deep` on `escalate-deep`; `reasoning.escalation` on GLM invoke) or no follow-up when neither fires. The function must not alter dispatch, leasing, DAG runnability, or `onWorkerSettled`; it reads capacity exclusively through a passed-in `RouteCapacityProvider` snapshot.
    - Ensure routing metadata is never injected verbatim into the parent context; the parent continues to receive only the compacted summary.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/parallelWorkerRouting.ts`.
    - _Requirements: 5.2, 8.1, 8.8, 12.3, 12.4, 13.3_

  - [x] 8.3 Insert the prepared-context handoff between reader settle and the coder spec
    - Add wiring that runs the `PreparedContextWorkPackageBuilder` after reader completion and before the `coder.primary` spec is built, using the built package as the `message`/context seed for the coder spec. Source reader findings from the existing bounded-output path and bootstrap evidence from `Worker_Bootstrap_Retrieval`; the coder spec must not perform broad repository re-exploration.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/parallelWorkerRouting.ts`.
    - _Requirements: 6.1, 6.2, 6.4, 13.5, 13.6_

  - [ ]* 8.4 Write integration tests for lane-assignment wiring and follow-up spec production
    - Create `src/core/task/__tests__/capabilityLaneRouting.integration.spec.ts` using faked collaborators from `src/test-utils` (a faked `RouteCapacityProvider` snapshot, a faked scheduler surface exposing `admitPlan`/`onWorkerSettled`, and faked `WorkerResultWithRouting`s) rather than the real `BoundedElasticScheduler`.
    - Assert: lane rides additively on `ParallelTaskSpec` (`mode`/`route` preserved, legacy specs still validate under `.strip()`); an escalation follow-up spec is produced in `reader.deep` only when `decide` returns `escalate-deep`; a GLM follow-up spec is produced only when the gate invokes; the prepared-context package seeds the coder spec. Cross-reference `elastic-parallel-execution` for dispatch/lease/DAG interleavings instead of re-testing them.
    - Run `npx vitest run src/core/task/__tests__/capabilityLaneRouting.integration.spec.ts`.
    - _Requirements: 5.2, 6.2, 8.1, 9.8, 12.4_

- [ ] 9. Guard reader delivery and condense independence at the integration boundary
  - [ ]* 9.1 Write integration test for concise reader delivery through the existing bounded-output path
    - In `src/core/task/__tests__/capabilityLaneRouting.integration.spec.ts`, fake a reader `WorkerResult` and assert on `compactParallelTasksResultForParent` output (reusing `MAX_READER_PARENT_RESULT_CHARS = 2400`).
    - **Property 4: Reader output delivered to the parent is a concise summary, never a transcript or raw source** — the parent-visible artifact is bounded by the existing reader output bound and contains only concise findings, evidence references, relevant symbols/paths, a confidence assessment, and an optional requested patch — never the reader's full internal reasoning, tool-call transcript, intermediate steps, full file contents, or complete code blocks (`// Feature: ..., Property 4: ...`).
    - Run `npx vitest run src/core/task/__tests__/capabilityLaneRouting.integration.spec.ts`.
    - _Requirements: 3.4, 3.5, 4.2, 4.3, 4.4, 13.5, 13.6_
    - _Properties: 4_

  - [ ]* 9.2 Write integration test for condense independence from reader execution
    - Create `src/core/task/__tests__/capabilityLaneRouting.condense-independence.spec.ts` driving a sequence of reader spawns against a faked `Task` whose `condenseContext` is a spy.
    - **Property 8: Spawning readers never triggers condensation, and reader summaries are not condense I/O** — for any sequence of reader spawns, the count of `condenseContext` invocations attributable to those spawns is zero; no reader evidence summary is used as condense input or treated as condense output; no reader conversation history is used as condense input (`// Feature: ..., Property 8: ...`, ≥100 runs where a generated spawn count is used).
    - Run `npx vitest run src/core/task/__tests__/capabilityLaneRouting.condense-independence.spec.ts`.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
    - _Properties: 8_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (`_Requirements:_`) and, where applicable, the design correctness properties (`_Properties:_`) for traceability. All 13 requirements and all 10 correctness properties are covered.
- Every addition is additive TypeScript above the scheduler and worker-result contracts: no scheduler mechanics, `WorkerResult` base, `RouteCapability` enum, reasoning controller, or condensation behavior changes. Sibling-spec types are consumed read-only.
- The three decision components (`RoutingPolicy`, `ReaderEscalationDecision`, `GlmInvocationGate`) and the `PreparedContextWorkPackageBuilder` are pure (no I/O) so they are unit- and property-testable; capacity, failure history, and loop signals are passed in.
- Property tests use `fast-check` at the package-local unit layer under `src/core/task/__tests__/`, each tagged `// Feature: capability-lanes-routing, Property N: ...` with ≥100 iterations. Integration tests use faked collaborators; scheduler interleavings and the `WorkerResult` base contract are cross-referenced to the sibling specs, not re-tested.
- Per AGENTS.md, after editing a file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; prefer typed APIs and bracket-notation private access over `as any`. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2", "6.2", "8.1"] },
    { "id": 4, "tasks": ["8.2", "8.3"] },
    { "id": 5, "tasks": ["8.4", "9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
