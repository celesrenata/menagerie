# Requirements Document

## Introduction

This feature (FEAT-011 of the Menagerie Autonomous Operations Lift amendment) exposes a user-facing parallelism control in the chat composer, positioned beside the existing OmniRoute cost-tier selector. The control expresses parallelism **appetite** — a ceiling on how aggressively Menagerie may fan work out — rather than a literal GPU or worker count. The policy the user has selected when they press Enter is captured in the submitted request envelope using the same atomic, request-scoped semantics the OmniRoute tier uses, so the per-request parallelism value does not depend on asynchronous settings persistence and cannot lose a race with it.

Tier (cost/route ceiling), parallelism (breadth/concurrency ceiling), and reasoning effort (cognitive depth per worker) are three orthogonal dimensions. A high parallelism appetite constrains the maximum breadth of concurrent work but never forces the mastermind to manufacture work that is not useful.

This spec defines the user-facing modes, their user-visible labels and persisted internal values, the default policy table (recommended ceilings per mode), Auto-as-default behavior, ceiling-not-target semantics, the request-scoped atomic capture of the parallelism field, the three-way orthogonality of tier/parallelism/reasoning, and the persisted default setting plus `ParallelismMode` enum. It hands the resulting numeric ceilings to the Bounded_Elastic_Scheduler for enforcement.

### Scope and Non-Goals

This spec is strictly the user-facing control and the request-scoped parallelism policy. It explicitly does NOT include:

- The elastic scheduler internals, execution DAG, reader swarms, speculation, work stealing, inference leasing, or parallelism metrics — those belong to FEAT-010/012 (the separate `elastic-parallel-execution` spec and its `Bounded_Elastic_Scheduler`). This spec defines the ceilings and hands them off; the referenced spec enforces them.
- Numeric ceiling enforcement (how max live/runnable/swarm/speculation/work-stealing actually bound execution).
- The observatory, loop detection, semantic retrieval, branding, or reasoning budgets.
- Redefinition of the `tier`/`omniRouteTier` field of the request envelope — that field is owned by the `immediate-tier-semantics` spec. This spec reuses the SAME atomic request-envelope mechanism and adds only the `parallelism` field.
- GPU scheduling.

The feature SHALL NOT reintroduce an async-settings race for the per-request value, SHALL NOT manufacture filler workers for any mode (including MAXIMUM CHAOS), and SHALL NOT break the existing `omniRouteTier` setting or the existing composer.

## Glossary

- **Menagerie**: The autonomous orchestration layer in this workspace that decides what is ALLOWED to execute concurrently by applying the user's parallelism ceiling to the mastermind's decomposition.
- **Mastermind**: The orchestrating model (GLM) that decomposes a task into an ExecutionPlan and determines what work can execute concurrently (useful decomposition), independent of physical capacity.
- **OmniRoute**: The routing/serving fabric that determines what can PHYSICALLY execute concurrently right now (inference admission), independent of the user's appetite and the mastermind's decomposition.
- **Parallelism_Appetite**: A user expression of the maximum aggressiveness of concurrency Menagerie may apply to a request. It is a ceiling, not a GPU count, worker count, or target.
- **Parallelism_Mode**: One of the five user-selectable appetite levels. The TypeScript type `ParallelismMode = "conservative" | "balanced" | "auto" | "aggressive" | "max"`.
- **Parallelism_Ceiling**: The maximum concurrency permitted by the selected mode. The scheduler may run below the ceiling; it may never exceed it.
- **Parallelism_Target**: A concurrency level the system would try to reach. Parallelism modes in this feature are ceilings, never targets.
- **Auto_Mode**: The default `Parallelism_Mode` (`"auto"`). In Auto, the mastermind determines how much useful concurrency exists and OmniRoute determines how much physical concurrency can be admitted; Auto does not fill every available inference slot merely because capacity exists.
- **MAXIMUM_CHAOS**: The user-visible label for the highest appetite mode. Its persisted internal `Parallelism_Mode` value is `"max"`.
- **Request_Envelope**: The atomic submission payload shared with `immediate-tier-semantics`, shaped `{ text, omniRouteTier?: 1|2|3|4|5, parallelism?: ParallelismMode }`. This spec adds only the `parallelism` field.
- **Request_Envelope_Parallelism_Field**: The optional `parallelism?: ParallelismMode` field carried on the Request_Envelope at submit time, capturing the mode selected when the user pressed Enter.
- **Composer_Local_Parallelism_State**: The parallelism selection held synchronously in the composer's local component state, read at submit time to populate the Request_Envelope_Parallelism_Field, independent of asynchronous settings persistence.
- **Parallelism_Control**: The composer UI control that lets the user select a `Parallelism_Mode`, positioned beside the OmniRoute tier selector.
- **Orthogonal_Dimensions**: The three independent axes of a request — tier (cost/route ceiling), parallelism (breadth/concurrency ceiling), and reasoning effort (cognitive depth per worker). A change to one does not constrain the others.
- **ExecutionPlan_Intent**: The mastermind's expression of useful decomposition — an ExecutionPlan with tasks, parallelGroups, and dependencies — stated independent of physical capacity.
- **Useful_Work**: A worker or task that advances the user's request (for example, a needed reader scope, reasoner, or verifier).
- **Filler_Work**: A worker or task created solely to consume available concurrency capacity, not to advance the request. The feature forbids manufacturing Filler_Work.
- **Default_Policy_Table**: The recommended ceilings per `Parallelism_Mode` defined by this spec (values MAY be tuned later). Columns: max live workers, max runnable, reader swarm, speculation, work stealing, dynamic fan-out.
- **Bounded_Elastic_Scheduler**: The scheduler defined by the `elastic-parallel-execution` spec that enforces the numeric ceilings this spec supplies. Out of scope for this spec beyond the hand-off.
- **Persisted_Default_Parallelism_Mode**: The persisted global setting whose default value is `"auto"`, defined in `packages/types` global-settings per the AGENTS.md persisted-setting checklist.

## Requirements

### Requirement 1: Composer Parallelism Control

**User Story:** As a Menagerie user, I want a parallelism control in the chat composer beside the cost-tier selector, so that I can express how aggressively a request may fan out before I submit it.

#### Acceptance Criteria

1. THE Parallelism_Control SHALL render in the chat composer adjacent to the OmniRoute cost-tier selector.
2. THE Parallelism_Control SHALL present the current selection as a parallelism appetite label (recommended presentation beside the tier selector, for example `[$$$$] [⚡ Auto]`).
3. THE Parallelism_Control SHALL express parallelism appetite and SHALL NOT present the selection as a GPU count or a worker count.
4. WHEN the user opens the Parallelism_Control, THE Parallelism_Control SHALL offer exactly five selectable Parallelism_Mode options.
5. THE Parallelism_Control SHALL follow the composer-local-synchronous-state and Request_Envelope pattern defined by the `immediate-tier-semantics` spec rather than the immediate async settings-save flow, so that selecting a mode does not depend on asynchronous settings persistence completing before submit.

### Requirement 2: Parallelism Modes and Persisted Values

**User Story:** As a Menagerie user, I want five clearly named parallelism modes, so that I can choose an appetite that matches the task.

#### Acceptance Criteria

1. THE Parallelism_Mode type SHALL be exactly `"conservative" | "balanced" | "auto" | "aggressive" | "max"`.
2. THE Parallelism_Control SHALL display user-visible labels Conservative, Balanced, Auto, Aggressive, and MAXIMUM CHAOS for the five modes respectively.
3. WHEN the user selects the MAXIMUM CHAOS option, THE Parallelism_Control SHALL set the Composer_Local_Parallelism_State to the persisted internal value `"max"`.
4. WHEN a Parallelism_Mode is persisted, THE System SHALL store the internal enum value (`"conservative"`, `"balanced"`, `"auto"`, `"aggressive"`, or `"max"`) and SHALL NOT store the user-visible label.
5. IF a persisted or received parallelism value is not a member of the Parallelism_Mode type, THEN THE System SHALL treat the value as unset and apply the Persisted_Default_Parallelism_Mode `"auto"`.

### Requirement 3: Default Policy Table

**User Story:** As a Menagerie operator, I want each mode to map to a defined set of recommended ceilings, so that mode selection translates into concrete bounds handed to the scheduler.

#### Acceptance Criteria

1. THE Default_Policy_Table SHALL define, for Conservative, max live workers 3, max runnable 2, reader swarm 2, speculation disabled, and work stealing disabled.
2. THE Default_Policy_Table SHALL define, for Balanced, max live workers 6, max runnable 4, reader swarm 4, speculation limited, and work stealing enabled.
3. THE Default_Policy_Table SHALL define, for Auto, max live workers 12, max runnable dynamic, reader swarm dynamic, speculation mastermind-controlled, and work stealing enabled.
4. THE Default_Policy_Table SHALL define, for Aggressive, max live workers 10, max runnable 8, reader swarm at least 4, speculation enabled, and work stealing enabled.
5. THE Default_Policy_Table SHALL define, for MAXIMUM CHAOS (persisted `"max"`), max live workers 12, max runnable 12, reader swarm sized to saturate useful capacity, speculation enabled, dynamic fan-out enabled, and work stealing enabled.
6. WHEN a Parallelism_Mode is applied to a request, THE System SHALL resolve the mode to its Default_Policy_Table ceilings and SHALL hand those numeric ceilings to the Bounded_Elastic_Scheduler.
7. WHERE the Default_Policy_Table values are tuned after release, THE System SHALL continue to map each Parallelism_Mode to a single defined policy entry.

### Requirement 4: Auto as Default Mode

**User Story:** As a Menagerie user, I want Auto to be the default parallelism mode, so that the system chooses a sensible breadth without my intervention.

#### Acceptance Criteria

1. THE Persisted_Default_Parallelism_Mode SHALL be `"auto"`.
2. WHILE the user has not selected a Parallelism_Mode for a request, THE Parallelism_Control SHALL present Auto as the active selection.
3. WHILE Auto_Mode is active, THE Mastermind SHALL determine how much useful concurrency exists for the request and THE OmniRoute fabric SHALL determine how much physical concurrency can be admitted.
4. WHILE Auto_Mode is active, THE System SHALL NOT allocate a worker to an available inference slot unless that worker performs Useful_Work.
5. WHILE Auto_Mode is active and the task comprises two independent investigations, THE System SHALL create 2 logical workers.
6. WHILE Auto_Mode is active and the task comprises four reader scopes plus one reasoner plus one verifier, THE System SHALL create 6 logical workers.

### Requirement 5: Ceiling, Not Target (No Filler Work)

**User Story:** As a Menagerie user, I want my parallelism setting to be a ceiling, so that a high appetite never forces the system to invent unnecessary work.

#### Acceptance Criteria

1. THE System SHALL treat the selected Parallelism_Mode as a Parallelism_Ceiling that constrains maximum aggressiveness.
2. THE System SHALL NOT treat the selected Parallelism_Mode as a Parallelism_Target.
3. WHEN the selected Parallelism_Mode permits more concurrency than the request's Useful_Work requires, THE System SHALL create only the workers needed for Useful_Work.
4. THE System SHALL NOT create Filler_Work to consume available concurrency capacity for any Parallelism_Mode.
5. WHEN MAXIMUM CHAOS is selected and the task needs exactly one reasoner plus one reader, THE System SHALL create exactly 2 Useful_Work workers and SHALL NOT create 10 filler tasks.
6. IF the mastermind's useful decomposition requires fewer workers than the Parallelism_Ceiling, THEN THE System SHALL run below the ceiling.

### Requirement 6: Request-Scoped Atomic Capture

**User Story:** As a Menagerie user, I want the parallelism mode selected when I press Enter to apply to exactly that request, so that a later settings change or persistence delay cannot alter the request I submitted.

#### Acceptance Criteria

1. THE Request_Envelope SHALL be shaped `{ text, omniRouteTier?: 1|2|3|4|5, parallelism?: ParallelismMode }`, adding only the `parallelism` field to the envelope shared with `immediate-tier-semantics`.
2. WHEN the user submits a first message, THE System SHALL include the Composer_Local_Parallelism_State as the `parallelism` field on the `newTask` submit message.
3. WHEN the user submits a subsequent message, THE System SHALL include the Composer_Local_Parallelism_State as the `parallelism` field on the `askResponse` (`messageResponse`) submit message.
4. WHEN the user presses Enter, THE System SHALL read the Parallelism_Mode from Composer_Local_Parallelism_State synchronously at submit time and apply that mode to that exact request.
5. THE System SHALL derive the per-request `parallelism` field from Composer_Local_Parallelism_State and SHALL NOT derive it from asynchronous settings persistence.
6. IF the user changes the Parallelism_Mode after a request has been submitted, THEN THE System SHALL leave the already-submitted request's `parallelism` field unchanged.
7. WHERE the Parallelism_Control is not configured for a request, THE System SHALL omit the `parallelism` field from the Request_Envelope.

### Requirement 7: Orthogonality of Tier, Parallelism, and Reasoning

**User Story:** As a Menagerie user, I want tier, parallelism, and reasoning effort to be independent, so that I can tune cost, breadth, and depth separately.

#### Acceptance Criteria

1. THE System SHALL treat tier, parallelism, and reasoning effort as three Orthogonal_Dimensions.
2. WHEN the user changes the Parallelism_Mode, THE System SHALL leave the selected tier and the selected reasoning effort unchanged.
3. WHEN the user changes the tier, THE System SHALL leave the selected Parallelism_Mode and the selected reasoning effort unchanged.
4. WHERE a request specifies Tier $$$$ with MAXIMUM CHAOS and high reasoning, THE System SHALL permit a decomposition that mixes per-worker reasoning levels (for example, four readers at low reasoning, one reasoner at high reasoning, one verifier at high reasoning, and two speculative readers), subject to the Parallelism_Ceiling.
5. WHEN a decomposition has been admitted under the three dimensions, THE OmniRoute fabric SHALL determine the serving topology.

### Requirement 8: Mastermind Intent Versus Ceilings (Clean Boundaries)

**User Story:** As a Menagerie architect, I want clean boundaries between what can, what is allowed to, and what can physically execute concurrently, so that each layer owns a single responsibility.

#### Acceptance Criteria

1. THE Mastermind SHALL be permitted to express ExecutionPlan_Intent (tasks, parallelGroups, and dependencies) independent of physical capacity.
2. THE Menagerie layer SHALL apply the user's Parallelism_Ceiling to the mastermind's ExecutionPlan_Intent to determine what is ALLOWED to execute concurrently.
3. THE OmniRoute fabric SHALL apply physical inference admission to determine what can PHYSICALLY execute concurrently at the current moment.
4. THE System SHALL assign to the mastermind the responsibility for what can execute concurrently, to Menagerie the responsibility for what is allowed to execute concurrently, and to OmniRoute the responsibility for what can physically execute concurrently.
5. THE System SHALL supply the resolved numeric ceilings to the Bounded_Elastic_Scheduler and SHALL NOT itself enforce the numeric ceilings within this feature.

### Requirement 9: Persistence, Default Setting, and Optional Settings Mirror

**User Story:** As a Menagerie user, I want a persisted default parallelism mode and a well-defined settings schema, so that my preferred appetite is remembered without breaking the per-request guarantee.

#### Acceptance Criteria

1. THE System SHALL define the `ParallelismMode` enum and the Persisted_Default_Parallelism_Mode default value `"auto"` in the `packages/types` global-settings schema per the AGENTS.md persisted-setting checklist.
2. WHERE the webview requires the parallelism default, THE System SHALL carry the setting in `ExtensionState` in `packages/types/src/vscode-extension-host.ts`.
3. THE System SHALL persist the parallelism default through `ContextProxy`.
4. WHERE a SettingsView mirror of the parallelism default is added, THE SettingsView SHALL bind the control to local `cachedState`, include the value in the `updateSettings` payload sent on Save, and round-trip the value via `getStateToPostToWebview()`.
5. THE System SHALL derive the per-request `parallelism` field from Composer_Local_Parallelism_State and SHALL NOT make the per-request value depend on the SettingsView `cachedState` or on asynchronous settings persistence.
6. THE System SHALL preserve the existing `omniRouteTier` setting and the existing composer behavior when the parallelism feature is added.
