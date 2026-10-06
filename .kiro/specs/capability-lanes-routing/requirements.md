# Requirements Document

## Introduction

This feature is the Capability Lanes, Model Routing, and Escalation Policy amendment to the Menagerie Autonomous Operations Lift. It defines four model capability lanes as semantic roles, reader isolation and context-isolation contracts, confidence-driven reader escalation, prepared-context work packages for the primary coder, GLM-5.3's dual roles (planning/orchestration and escalation/adjudication), the "not a mandatory ladder" routing policy, shared 4070 Ti Super resource awareness for the scheduler, condense independence from reader execution, routing metadata on worker completion results, and the architectural principle of using the smallest model capable of obtaining reliable evidence and the strongest appropriate model for decisions and modifications.

This spec cross-references four sibling specs and interacts with their contracts without redefining them:

- **elastic-parallel-execution**: Defines `RouteCapability` (`"reader"` | `"reasoner"` | `"long-context"` | `"vision"` | `"general"`), `RouteCapacity`, `Inference_Lease`, reader swarms, `Scheduling_Priority`, and the `BoundedElasticScheduler`. This spec refines `"reader"` into `reader.fast` and `reader.deep` as semantic sub-lanes, adds `coder.primary` and `reasoning.escalation` as roles, and interacts with inference leasing and the scheduler's resource awareness — but does NOT redefine the scheduler's mechanics or the `RouteCapability` enum.
- **mastermind-execution-metadata**: Defines `WorkerResult` (`{status, summary, findings, evidence, changes, tests, blockers, artifacts, reasoning?}`), `WorkerReasoningPolicy`, `AdaptiveReasoningController`, and `AutonomousTaskState`. This spec extends `WorkerResult` metadata with additive routing-specific fields and defines the escalation triggers that feed adaptive reasoning — but does NOT redefine the `WorkerResult` base contract or the reasoning controller's core behavior.
- **semantic-first-retrieval**: Defines `Worker_Bootstrap_Retrieval`, `Reader_Swarm_Packet`, `ExplorationPolicy`, and `Semantic_Exploration_Cache`. This spec defines the prepared-context work package for the coder (consuming reader findings) and the reader output contract (concise findings/evidence, not raw source).
- **progress-aware-loop-detection**: Defines the `Progress_Aware_Loop_Detector` with cyclic investigation/implementation detection. The repeated cyclic behavior signal is one of the GLM escalation triggers defined in this spec.

### Non-Goals

- Menagerie MUST NOT hard-code GPU, VRAM, or model-identity into lane selection — OmniRoute owns the lane-to-model/hardware mapping.
- The system MUST NOT implement routing as a mandatory sequential ladder.
- GLM MUST NOT be required for every task.
- Raw reader context MUST NOT be injected into the parent model history.
- Condense MUST NOT be triggered merely because reader workers were spawned.
- This spec does NOT redefine the elastic scheduler's mechanics, the `WorkerResult` base contract, the `AdaptiveReasoningController`'s core behavior, or the `RouteCapability` enum (additive extensions only).

## Glossary

- **Capability_Lane**: A semantic role describing the kind of cognitive work a model performs. The four lanes are `reader.fast`, `reader.deep`, `coder.primary`, and `reasoning.escalation`. A Capability_Lane is NOT a fixed agent or model; OmniRoute MAY change the underlying model or hardware without changing the semantic role exposed to Menagerie.
- **reader.fast**: The default reader lane for cheap parallel read-only investigation. Current intended mapping: Qwen 3.5 9B on RTX 4070 Ti Super. The lane-to-model mapping is an OmniRoute concern and is not hard-coded into Menagerie.
- **reader.deep**: A reader lane for difficult or ambiguous bounded investigation requiring higher model quality. Current intended mapping: Qwen 3.8 27B IQ3 on RTX 4070 Ti Super. The lane-to-model mapping is an OmniRoute concern and is not hard-coded into Menagerie.
- **coder.primary**: The implementation lane for coding, debugging, refactoring, testing, and code reasoning. Current intended mapping: Qwen 3.8 27B NVFP4 on RTX 5090. The lane-to-model mapping is an OmniRoute concern and is not hard-coded into Menagerie.
- **reasoning.escalation**: The lane for architecture, adjudication, long-horizon reasoning, planning, and failure recovery. Current intended mapping: GLM-5.3 321B DwarfStar4 on M5 Max 128 GB. The lane-to-model mapping is an OmniRoute concern and is not hard-coded into Menagerie.
- **Reader_Isolation**: The contract that reader workers execute in private conversation histories, remain read-only with respect to the repository, and return only concise findings without injecting raw source material into the parent model history.
- **Confidence_Driven_Escalation**: Escalation from `reader.fast` to `reader.deep` triggered by investigation quality signals — low confidence, contradictory evidence, multi-subsystem relationships, unsuccessful bounded searches, difficult type/control/data-flow analysis, architectural ambiguity, reader disagreement, or explicit parent request — rather than by token consumption.
- **Prepared_Context_Work_Package**: A compact package delivered to `coder.primary` before implementation, containing (where available): objective, relevant files, relevant symbols, reader findings, architectural constraints, known assumptions, existing test failures, expected behavior, and requested implementation boundaries.
- **Mandatory_Ladder_Anti_Pattern**: The routing anti-pattern of forcing every request through 9B → 27B IQ3 → 27B NVFP4 → GLM sequentially. The system explicitly rejects this pattern.
- **Shared_Hardware_Resource_Awareness**: The scheduler's awareness that `reader.fast` and `reader.deep` currently share the RTX 4070 Ti Super, making escalation from fast to deep a resource-affecting operation that impacts parallel reader capacity.
- **Model_Swap_Load_Latency**: The time cost of unloading one model and loading another on shared hardware, which the scheduler accounts for when evaluating reader escalation cost.
- **Condense_Independence**: The architectural invariant that reader execution and conversation condensation are independent mechanisms with distinct data flows: readers produce evidence reports from repository investigation; condense summarizes the parent conversation history.
- **Routing_Metadata**: Machine-readable metadata on worker completion results — `confidence`, `files_inspected`, `symbols_inspected`, `ambiguities`, `conflicting_findings`, `recommended_escalation`, `tests_run`, `tests_passed`, `failure_class`, `model_lane`, `hardware_lane` — consumed by OmniRoute and NerveCenter for routing decisions.
- **GLM_Scarce_Resource_Invariant**: The architectural constraint that `reasoning.escalation` (GLM-5.3) is preserved as a scarce high-capability reasoning resource, invoked only when lower-capability lanes cannot resolve uncertainty.
- **Smallest_Model_Evidence_Principle**: The architectural principle that the system optimizes for the smallest model capable of obtaining reliable evidence and the strongest appropriate model for decisions and modifications.

## Requirements

### Section 1 — Model Capability Lanes

### Requirement 1: Define four capability lanes as semantic roles

**User Story:** As a Menagerie operator, I want model capability lanes defined as semantic roles independent of specific models or hardware, so that OmniRoute can change the underlying model or hardware without affecting Menagerie's orchestration logic.

#### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL define exactly four Capability_Lanes: `reader.fast`, `reader.deep`, `coder.primary`, and `reasoning.escalation`.
2. THE Menagerie_Orchestration_Layer SHALL reference Capability_Lanes by their semantic role names and SHALL NOT reference specific model names, model sizes, quantization formats, or GPU identities in lane selection logic.
3. WHEN OmniRoute changes the underlying model or hardware mapped to a Capability_Lane, THE Menagerie_Orchestration_Layer SHALL continue to function using the same semantic role name without modification.
4. THE Menagerie_Orchestration_Layer SHALL treat Capability_Lanes as describing cognitive roles — the kind of work a model performs — rather than as identifying fixed agents, fixed models, or fixed hardware.
5. THE Menagerie_Orchestration_Layer SHALL define `reader.fast` as the lane for cheap parallel read-only investigation, `reader.deep` as the lane for difficult or ambiguous bounded investigation, `coder.primary` as the lane for implementation, debugging, refactoring, testing, and code reasoning, and `reasoning.escalation` as the lane for architecture, adjudication, long-horizon reasoning, planning, and failure recovery.

### Requirement 2: Lane-to-RouteCapability mapping as semantic enrichment

**User Story:** As a Menagerie operator, I want capability lanes mapped onto the existing RouteCapability vocabulary, so that the scheduler can reason about lanes without changing the RouteCapability enum.

#### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL map `reader.fast` and `reader.deep` to the `"reader"` RouteCapability defined in elastic-parallel-execution.
2. THE Menagerie_Orchestration_Layer SHALL map `coder.primary` to the `"reasoner"` or `"general"` RouteCapability depending on task type.
3. THE Menagerie_Orchestration_Layer SHALL map `reasoning.escalation` to the `"long-context"` or `"reasoner"` RouteCapability depending on task type.
4. THE Menagerie_Orchestration_Layer SHALL treat the lane-to-RouteCapability mapping as a requirements-level semantic enrichment and SHALL NOT modify the `RouteCapability` enum values defined in elastic-parallel-execution.
5. THE OmniRoute_Layer SHALL resolve the mapping from Capability_Lane to a specific model and hardware at inference time.

### Section 2 — Reader Isolation and Context-Isolation

### Requirement 3: Reader isolation contract

**User Story:** As a Menagerie operator, I want reader workers to be read-only and context-isolated from the parent model, so that raw repository content does not flood the parent's context window and readers cannot modify the repository.

#### Acceptance Criteria

1. THE Reader_Worker SHALL execute in a private conversation history separate from the parent model's conversation history.
2. THE Reader_Worker SHALL receive a bounded investigation scope defining the files, symbols, or questions to investigate.
3. THE Reader_Worker SHALL remain read-only with respect to the repository and SHALL NOT write, modify, or delete files in the repository.
4. THE Reader_Worker SHALL NOT inject raw source material — including full file contents, full function bodies, or complete code blocks — into the parent model's conversation history.
5. THE Reader_Worker SHALL return ONLY concise findings, evidence references, relevant symbol names, relevant file paths, a confidence assessment, and optionally a proposed git patch when explicitly requested.
6. THE Reader_Worker SHALL terminate using the existing short `attempt_completion` contract defined for reader workers.

### Requirement 4: Reader output contract

**User Story:** As a Menagerie operator, I want reader output to answer specific investigation questions concisely, so that the parent model receives actionable evidence without absorbing the reader's full internal reasoning.

#### Acceptance Criteria

1. THE Reader_Worker output SHOULD answer: what was found, where the finding is located, why the finding matters to the investigation, what remains uncertain, and what should be inspected next when confidence is insufficient.
2. THE parent model SHALL NOT inherit a Reader_Worker's full internal reasoning or full conversation history.
3. THE parent model SHALL NOT inherit the Reader_Worker's tool call transcripts or intermediate investigation steps.
4. WHEN a Reader_Worker's findings are delivered to the parent model, THE Menagerie_Orchestration_Layer SHALL deliver findings as a concise evidence summary rather than as a transcript of the Reader_Worker's conversation.

### Section 3 — Confidence-Driven Reader Escalation

### Requirement 5: Confidence-driven escalation from reader.fast to reader.deep

**User Story:** As a Menagerie operator, I want reader escalation driven by investigation quality signals rather than token consumption, so that deeper analysis is invoked only when the fast reader cannot produce reliable evidence.

#### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL use `reader.fast` as the default reader Capability_Lane for new reader tasks.
2. WHEN a `reader.fast` task produces a low-confidence conclusion, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
3. WHEN a `reader.fast` task produces contradictory evidence, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
4. WHEN a `reader.fast` task requires reasoning about relationships spanning multiple subsystems, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
5. WHEN a `reader.fast` task performs unsuccessful bounded searches without finding the target, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
6. WHEN a `reader.fast` task requires difficult type, control-flow, or data-flow analysis, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
7. WHEN a `reader.fast` task encounters architectural ambiguity, THE Menagerie_Orchestration_Layer MAY escalate the task to `reader.deep`.
8. WHEN parallel `reader.fast` tasks disagree materially on findings, THE Menagerie_Orchestration_Layer MAY escalate a follow-up task to `reader.deep`.
9. WHEN the parent model explicitly requests deeper analysis, THE Menagerie_Orchestration_Layer SHALL escalate the task to `reader.deep`.
10. THE Menagerie_Orchestration_Layer SHALL NOT escalate from `reader.fast` to `reader.deep` merely because the task consumed many tokens.
11. THE `reader.deep` lane SHALL improve investigation quality and SHALL NOT replace `coder.primary` for implementation work.

### Section 4 — Prepared-Context Work Package for the Primary Coder

### Requirement 6: Deliver a prepared-context work package to coder.primary

**User Story:** As a Menagerie operator, I want the primary coder to receive a compact work package before implementation, so that the RTX 5090 is preserved for high-value coding work instead of spending context budget rediscovering repository structure.

#### Acceptance Criteria

1. THE `coder.primary` lane SHOULD NOT perform broad repository exploration when that exploration can be performed by Reader_Workers.
2. WHEN Reader_Workers have completed investigation for a coding task, THE Menagerie_Orchestration_Layer SHOULD deliver a Prepared_Context_Work_Package to `coder.primary` before implementation begins.
3. THE Prepared_Context_Work_Package SHOULD contain, where available: objective, relevant files, relevant symbols, reader findings, architectural constraints, known assumptions, existing test failures, expected behavior, and requested implementation boundaries.
4. THE Prepared_Context_Work_Package SHALL consume reader findings from the Reader_Worker output contract (Requirement 4) and bootstrap evidence from the `Worker_Bootstrap_Retrieval` defined in semantic-first-retrieval.
5. THE Prepared_Context_Work_Package SHALL NOT contain raw source material from Reader_Workers; the package SHALL contain concise findings and evidence references.

### Section 5 — GLM-5.3 Dual Roles

### Requirement 7: GLM-5.3 planning and orchestration role

**User Story:** As a Menagerie operator, I want GLM-5.3 available as a planner and orchestrator for sufficiently complex work, so that difficult problems benefit from high-capability problem decomposition.

#### Acceptance Criteria

1. WHERE work is sufficiently complex to benefit from high-capability decomposition, THE `reasoning.escalation` lane MAY decompose a problem into sub-tasks.
2. WHERE work is sufficiently complex, THE `reasoning.escalation` lane MAY identify investigation questions, assign reader scopes, define implementation constraints, and synthesize reader findings.
3. THE `reasoning.escalation` lane SHALL NOT be required for planning or orchestration of work that lower-capability lanes can handle.

### Requirement 8: GLM-5.3 escalation and adjudication role

**User Story:** As a Menagerie operator, I want GLM-5.3 invoked when lower-capability lanes cannot resolve uncertainty, so that the system recovers from failures, disagreements, and architectural ambiguity.

#### Acceptance Criteria

1. WHEN multiple implementation attempts by `coder.primary` fail, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for adjudication.
2. WHEN Reader_Workers disagree materially on findings, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for adjudication.
3. WHEN the apparent bug conflicts with architectural intent, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for adjudication.
4. WHEN the task requires system-wide reasoning spanning many subsystems, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation`.
5. WHEN a design decision spans many subsystems, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation`.
6. WHEN `coder.primary` reports low confidence in its result, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for review.
7. WHEN tests pass but architectural correctness remains uncertain, THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for review.
8. WHEN the `Progress_Aware_Loop_Detector` detects repeated cyclic investigation or implementation behavior (as defined in progress-aware-loop-detection), THE Menagerie_Orchestration_Layer SHOULD invoke `reasoning.escalation` for failure recovery.
9. THE Menagerie_Orchestration_Layer SHALL NOT require `reasoning.escalation` to process every task.
10. THE Menagerie_Orchestration_Layer SHALL preserve `reasoning.escalation` as a scarce high-capability reasoning resource consistent with the GLM_Scarce_Resource_Invariant.

### Section 6 — Routing Shall Not Be a Mandatory Ladder

### Requirement 9: Routing selects the appropriate capability lane without a mandatory sequential ladder

**User Story:** As a Menagerie operator, I want routing to select the appropriate lane based on task characteristics rather than forcing every request through a sequential escalation chain, so that simple tasks execute on cheap models and complex tasks reach capable models without unnecessary intermediate steps.

#### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL NOT implement routing as a mandatory sequential ladder of `reader.fast` → `reader.deep` → `coder.primary` → `reasoning.escalation` for every request.
2. THE Menagerie_Orchestration_Layer SHALL select the appropriate Capability_Lane based on: task type, estimated complexity, confidence from prior results, previous failure history, context requirements, available hardware capacity, model residency, latency constraints, and current queue pressure.
3. WHEN a task is a simple repository lookup, THE Menagerie_Orchestration_Layer SHALL route through the pattern: `reader.fast` → parent synthesis.
4. WHEN a task is a normal implementation, THE Menagerie_Orchestration_Layer SHALL route through the pattern: `reader.fast` × N (parallel investigation) → `coder.primary`.
5. WHEN a task involves ambiguous investigation, THE Menagerie_Orchestration_Layer SHALL route through the pattern: `reader.fast` × N → `reader.deep` → `coder.primary`.
6. WHEN a task is an architectural problem requiring high-capability planning, THE Menagerie_Orchestration_Layer SHALL route through the pattern: `reasoning.escalation` (planning) → `reader.fast` × N → `coder.primary`.
7. WHEN a task experiences repeated implementation failure, THE Menagerie_Orchestration_Layer SHALL route through the pattern: `reader.fast` → `coder.primary` → failure → `coder.primary` retry → `reasoning.escalation` (adjudication).
8. THE Menagerie_Orchestration_Layer SHALL support routing patterns that skip intermediate lanes when the task characteristics indicate a direct lane assignment.

### Section 7 — Shared 4070 Ti Super Resource Awareness

### Requirement 10: Shared-hardware escalation as a resource-affecting operation

**User Story:** As a Menagerie operator, I want the scheduler to treat reader escalation from 9B to 27B IQ3 as a resource-affecting operation, so that escalation decisions account for the cost to parallel reader capacity on shared hardware.

#### Acceptance Criteria

1. THE BoundedElasticScheduler SHALL treat escalation from `reader.fast` to `reader.deep` as a resource-affecting operation, not merely a model-quality change.
2. WHEN evaluating a `reader.fast`-to-`reader.deep` escalation, THE BoundedElasticScheduler SHOULD account for Model_Swap_Load_Latency on the shared hardware.
3. WHEN evaluating a `reader.fast`-to-`reader.deep` escalation, THE BoundedElasticScheduler SHOULD account for the interruption of parallel `reader.fast` capacity caused by unloading the 9B model.
4. WHEN evaluating a `reader.fast`-to-`reader.deep` escalation, THE BoundedElasticScheduler SHOULD account for queued `reader.fast` work that would be delayed by the escalation.
5. WHEN evaluating a `reader.fast`-to-`reader.deep` escalation, THE BoundedElasticScheduler SHOULD account for the expected duration of the `reader.deep` task.
6. WHEN evaluating a `reader.fast`-to-`reader.deep` escalation, THE BoundedElasticScheduler SHOULD evaluate whether another available model on different hardware can answer the question without evicting the `reader.fast` model.
7. THE BoundedElasticScheduler SHALL apply a higher threshold for escalation from `reader.fast` to `reader.deep` than for spawning an additional `reader.fast` worker.
8. THE BoundedElasticScheduler SHALL NOT hard-code the RTX 4070 Ti Super identity or VRAM capacity into escalation logic; the scheduler SHALL reason about shared-hardware constraints through route capacity abstractions exposed by OmniRoute.

### Section 8 — Condense Independence

### Requirement 11: Reader execution is independent from conversation condensation

**User Story:** As a Menagerie operator, I want reader execution and conversation condensation to be independent mechanisms, so that spawning readers does not trigger condensation and condensation does not consume reader output as its input.

#### Acceptance Criteria

1. THE Reader_Worker architecture (repository → isolated worker → concise evidence report) SHALL remain independent from the condensation architecture (parent conversation history → `summarizeConversation`/`manageContext` → replacement effective history).
2. THE Menagerie_Orchestration_Layer SHALL NOT treat Reader_Worker evidence summaries as condense output.
3. THE Menagerie_Orchestration_Layer SHALL NOT trigger the `condenseContext` operation merely because Reader_Workers were spawned.
4. THE Menagerie_Orchestration_Layer SHALL NOT use Reader_Worker conversation histories as input to the `condenseContext` operation.
5. THE Reader_Worker mechanism SHALL exist specifically to avoid adding raw repository context to the parent context window; condensation SHALL address parent conversation history length independently.

### Section 9 — Routing Metadata

### Requirement 12: Routing metadata on worker completion results

**User Story:** As a Menagerie operator, I want worker completion results to carry machine-readable routing metadata, so that OmniRoute and NerveCenter can make informed routing decisions without injecting metadata into the parent model context.

#### Acceptance Criteria

1. THE Reader_Worker and `coder.primary` completion results SHOULD expose Routing_Metadata containing the fields: `confidence` (number), `files_inspected` (number), `symbols_inspected` (number), `ambiguities` (number), `conflicting_findings` (number), `recommended_escalation` (Capability_Lane or null), `tests_run` (number), `tests_passed` (number), `failure_class` (string or null), `model_lane` (Capability_Lane), and `hardware_lane` (string or null).
2. THE Routing_Metadata fields SHALL be additive optional fields extending the `WorkerResult` contract defined in mastermind-execution-metadata and SHALL NOT modify or remove existing `WorkerResult` fields.
3. THE Routing_Metadata MAY be consumed by OmniRoute and NerveCenter for routing decisions.
4. THE Menagerie_Orchestration_Layer SHALL NOT inject Routing_Metadata verbatim into the parent model context.
5. WHEN a Worker completes without providing a Routing_Metadata field, THE Menagerie_Orchestration_Layer SHALL treat the absent field as unset rather than as an error.

### Section 10 — Architectural Principle

### Requirement 13: Smallest model for evidence, strongest model for decisions

**User Story:** As a Menagerie operator, I want the system to optimize for the smallest model capable of obtaining reliable evidence and the strongest appropriate model for decisions and modifications, so that expensive resources are reserved for high-value work.

#### Acceptance Criteria

1. THE Menagerie_Orchestration_Layer SHALL optimize routing so that Reader_Workers gather evidence using the smallest Capability_Lane capable of producing reliable findings.
2. THE Menagerie_Orchestration_Layer SHALL optimize routing so that `coder.primary` performs modifications and implementation using a Capability_Lane appropriate for code reasoning.
3. THE Menagerie_Orchestration_Layer SHALL optimize routing so that `reasoning.escalation` resolves uncertainty, adjudicates disagreements, and makes architectural decisions.
4. THE OmniRoute_Layer SHALL determine where inference executes (model selection and hardware placement) without Menagerie specifying physical placement.
5. THE Menagerie_Orchestration_Layer SHALL manage agent execution (task decomposition, dependency tracking, result synthesis) without requiring the parent model to absorb raw Reader_Worker context to maintain orchestration state.
6. THE Menagerie_Orchestration_Layer SHALL NOT require any component to inject raw Reader_Worker context into the parent model's context window merely to preserve orchestration state.
