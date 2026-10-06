# Requirements Document

## Introduction

This feature is **FEAT-013 — Dynamic Capability Broker and MCP Leasing**, an amendment to the Menagerie Autonomous Operations Lift. It replaces a single wasteful default: today every worker on a task is handed every configured MCP server's tool schema plus every native tool for the task's entire lifetime, whether or not that worker will ever deploy to a cluster, drive a browser, or mutate cloud resources. Those schemas are serialized into every outbound model request, inflating the prompt, polluting the tool-choice space with invalid and hallucinated tool calls, and defeating prefix caching whenever the configured set shifts.

The Dynamic Capability Broker introduces **least-privilege, phase-scoped tool access**: a worker starts with a tiny always-resident core surface and acquires additional Tool Capabilities only while they are relevant, via leases that a policy engine authorizes and that expire at a declared boundary (tool-complete, phase-complete, task-complete). The governing layering boundary is:

> **GLM requests capabilities. Menagerie grants and scopes them. MCP providers implement them.**

The mastermind and workers reason only in terms of semantic Tool Capabilities (for example `cluster.deploy`, `browser.inspect`). They never see server names, MCP transports, tool-schema internals, tool IDs, or provider naming — unless they are explicitly choosing among semantically distinct capabilities. The Capability Broker lives in Menagerie, not OmniRoute: OmniRoute still schedules silicon, GLM still schedules cognition, and the broker schedules the tool-capability surface.

This spec cross-references sibling specs and interacts with their contracts without redefining them:

- **capability-lanes-routing**: Defines `CapabilityLane` (`reader.fast` | `reader.deep` | `coder.primary` | `reasoning.escalation`) as a cognitive role, plus `RoutingMetadata` and `WorkerResultWithRouting`. This spec adds an orthogonal Tool-Capability axis; it does NOT touch lane logic, `laneToRouteCapability`, or `RoutingMetadata`. A worker runs IN a cognitive `CapabilityLane` AND holds a set of Tool Capability leases; the two axes coexist and never redefine each other.
- **mastermind-execution-metadata**: Defines `WorkerResult` (`{status, summary, findings, evidence, changes, tests, blockers, artifacts, reasoning?}`), `AutonomousTaskState`, and `ParallelTaskSpec` reasoning/verification fields. This spec adds an additive `AutonomousTaskState.capabilities` lease-state field and an additive optional `WorkerResult.capabilityTelemetry` field — but does NOT redefine the `WorkerResult` base contract or `AutonomousTaskState`'s core semantics.
- **semantic-first-retrieval** and **retrieval-fabric**: Define `RetrievalGatewayClient.retrieve`, `EvidencePacket`, and `SemanticFinding`. This spec consumes retrieval as a capability-discovery recommendation signal only; embeddings and retrieval ranking never authorize a capability.
- **task-observatory**: Defines `TaskObservationService`, `ObservationEvent`, the `observatoryUpdate` message, and the Zero-Lifecycle-Side-Effect invariant. This spec adds an additive read-only capability `ObservationEvent` variant and adds no mutation path.
- **elastic-parallel-execution**: Defines `BoundedElasticScheduler`, `RouteCapability`, and `RouteCapacity`. The broker is a per-worker concern layered beside the scheduler; it adds no global lock, does not alter dispatch or inference leasing, and does not modify the `RouteCapability` enum (a cognitive route, unrelated to `ToolCapabilityId`).
- **McpHub** (`src/services/mcp/McpHub.ts`) and **auto-approval** (`src/core/auto-approval/*`): Consumed as the single source of concrete MCP tool schemas and the sole authorization authority (`checkAutoApproval`, `AutoApprovalState`), respectively. This spec extends them through their existing surfaces and does NOT fork them.

### Non-Goals

- The system MUST NOT introduce a second permissions system; all privileged authorization routes through `checkAutoApproval` / `AutoApprovalState`.
- The system MUST NOT relocate the broker into OmniRoute; the broker lives in Menagerie, and OmniRoute still owns model and hardware placement.
- This spec MUST NOT redefine `CapabilityLane`, `WorkerResult`, `ParallelTaskSpec`, the scheduler mechanics, or the MCP wire protocol (additive extensions only).
- v1 MUST NOT require physically stopping or restarting MCP processes to remove schemas from context; process idle/disconnect is a secondary, optional optimization.
- The system MUST NOT guarantee perfect fine-grained scoping for every provider; scoping is best-effort and provider-declared.

## Glossary

- **Tool_Capability**: A semantic unit of tool or MCP access describing a kind of action — for example `repo.read`, `cluster.deploy`, `browser.inspect`. A Tool_Capability is identified by a namespaced string and is distinct from the sibling cognitive `CapabilityLane`.
- **ToolCapabilityId**: The namespaced string identifier of a Tool_Capability (for example `"repo.read"`). An extensible vocabulary backed by a runtime registry, NOT a closed enum.
- **Capability_Broker**: The Menagerie orchestration component that grants, scopes, composes, and releases Tool_Capability access for workers. The broker is the authority for which capabilities are serialized into a worker's outbound request, but delegates privileged authorization to the auto-approval mechanism.
- **Capability_Lease**: The explicit record of which worker holds which Tool_Capability, for what reason, at what scope, for how long, and in which lease state (`requested`, `active`, `released`, or `denied`).
- **Capability_Catalog**: The compact, mastermind-visible metadata describing available Tool_Capabilities (id, description, risk class, access kind, argument hints, scopeability) without carrying any tool-schema internals.
- **Capability_Policy_Engine**: The component that classifies a Tool_Capability request by risk and returns an authorization decision (`auto-allow`, `mastermind-approval`, `user-approval`, or `deny`), routing privileged grants through `checkAutoApproval`.
- **ALLOWED**: The set of Tool_Capabilities a worker is authorized to use (approved by policy, or always-resident core). Being ALLOWED does NOT place a tool schema in the model request.
- **ACTIVE**: The subset of ALLOWED whose tool schemas are currently serialized into the worker's outbound model request. Only ACTIVE Tool_Capabilities cost context tokens. ACTIVE is always a subset of ALLOWED.
- **Always_Resident_Core**: The minimal Tool_Capability set every worker is born with — task-state read/update, plan/todo update, `semantic.retrieve`, bounded evidence read, `capability.request`, `capability.release`, and `attempt_completion`. The core is always ACTIVE and is never leased, scoped, or revoked by the broker.
- **Schema_Composer**: The component that produces the effective tool surface (core prefix plus leased native and leased MCP tools, in deterministic order) fed into `SYSTEM_PROMPT` / `generatePrompt`, so only ACTIVE schemas are serialized.
- **Capability_Discovery**: The component that ranks compact catalog entries against a task intent using retrieval and returns a relevance recommendation signal only; it never authorizes a capability.
- **CapabilityLane_Distinction**: `Tool_Capability` names a unit of tool access and is a DIFFERENT axis from the sibling `CapabilityLane`, which names a cognitive role (`reader.fast`, `reader.deep`, `coder.primary`, `reasoning.escalation`). A worker runs IN a `CapabilityLane` AND holds `Tool_Capability` leases; the lane never changes which Tool_Capabilities are authorized, and the Tool_Capability set never changes the lane.
- **Capability_Broker_Degradation**: The state in which the broker's internal structures (catalog, registry, or composer) have failed, triggering fail-closed behavior.

## Requirements

### Section 1 — Serialized Tool Surface

### Requirement 1: Worker tool surface is core plus active leases only

**User Story:** As a Menagerie operator, I want each worker's serialized tool surface to contain only its always-resident core capabilities plus its currently active leases, so that unrelated tool schemas never inflate the prompt and released schemas disappear.

#### Acceptance Criteria

1. WHEN the Schema_Composer composes a worker's outbound tool surface, THE Schema_Composer SHALL include exactly the set union of the Always_Resident_Core tools and the tools of every Tool_Capability whose Capability_Lease state equals `active`, and SHALL include no other tools. *(MCP-001)*
2. THE Schema_Composer SHALL exclude from the serialized outbound model request every tool belonging to a Tool_Capability whose Capability_Lease state is any value other than `active` (including a Tool_Capability that is only configured, only ALLOWED, `released`, or `denied`). *(MCP-002)*
3. WHEN a Capability_Lease transitions to `released`, THE Schema_Composer SHALL exclude that Tool_Capability's tools from the next composed tool surface, and SHALL retain in that tool surface every Always_Resident_Core tool and the tools of every other Tool_Capability whose lease state remains `active`. *(MCP-013)*
4. WHEN the Capability_Broker determines which non-core tools are serialized, THE Capability_Broker SHALL use the set of Tool_Capabilities whose Capability_Lease state equals `active` as the sole determinant, such that a non-core tool is serialized if and only if its Tool_Capability's lease state equals `active`.
5. WHEN the set of Tool_Capabilities whose lease state equals `active` is empty, THE Schema_Composer SHALL compose a tool surface containing exactly the Always_Resident_Core tools and no non-core tools. *(MCP-002)*

### Section 2 — Two-Level Capability State

### Requirement 2: Two-level ALLOWED and ACTIVE worker state

**User Story:** As a Menagerie operator, I want each worker's capability state tracked at two distinct levels — authorized versus serialized — so that authorizing a capability does not by itself cost context tokens.

#### Acceptance Criteria

1. THE Capability_Broker SHALL maintain, per worker, an ALLOWED set and an ACTIVE set, and SHALL enforce the invariant that every Tool_Capability in the ACTIVE set is also in the ALLOWED set. *(MCP-001)*
2. IF any operation would place a Tool_Capability in the ACTIVE set that is not present in the ALLOWED set, THEN THE Capability_Broker SHALL reject the operation, leave both the ALLOWED set and the ACTIVE set unchanged, and return an error indicating the ACTIVE-subset-of-ALLOWED invariant was violated. *(MCP-001)*
3. WHEN a Tool_Capability's Capability_Lease is `denied`, THE Capability_Broker SHALL exclude that Tool_Capability from both the ALLOWED set and the ACTIVE set. *(MCP-005, MCP-007)*
4. THE Capability_Broker SHALL include every Always_Resident_Core Tool_Capability in every worker's ALLOWED set, and SHALL retain each such Tool_Capability in the ALLOWED set regardless of its Capability_Lease state. *(MCP-005, MCP-007)*
5. WHILE a Tool_Capability is in a worker's ALLOWED set but not in that worker's ACTIVE set, THE Capability_Broker SHALL authorize the worker to use the Tool_Capability AND SHALL exclude the Tool_Capability's schema from the outbound request, contributing zero schema tokens for that Tool_Capability.
6. WHEN a Tool_Capability transitions into a worker's ACTIVE set, THE Capability_Broker SHALL serialize that Tool_Capability's schema into the worker's outbound request.

### Section 3 — Deterministic Composition

### Requirement 3: Deterministic composition preserves prefix caching

**User Story:** As a Menagerie operator, I want tool-surface composition deterministic and prefix-stable, so that prefix and prompt caching are preserved across turns with an unchanged active set.

#### Acceptance Criteria

1. WHEN the Schema_Composer composes the same ACTIVE set across two or more repeated calls, THE Schema_Composer SHALL produce a tool surface whose serialized bytes are identical across all calls and whose core prefix bytes are unchanged. *(MCP-011)*
2. WHEN a single Tool_Capability activation is added to an ACTIVE set, THE Schema_Composer SHALL retain the exact byte offsets of the core prefix and of every previously-ordered leased entry and SHALL append the new schema after the last existing leased entry. *(MCP-011)*
3. THE Schema_Composer SHALL compose the tool surface as the stable core prefix, followed by leased native tools, followed by leased MCP tools. *(MCP-011)*
4. THE Schema_Composer SHALL order leased native tools in ascending order by ToolCapabilityId. *(MCP-011)*
5. THE Schema_Composer SHALL order leased MCP tools in ascending order by the tuple of ToolCapabilityId, then server name, then tool name. *(MCP-011)*

### Section 4 — Policy and Authorization

### Requirement 4: Policy engine authorizes by risk, routing privileged grants through checkAutoApproval

**User Story:** As a Menagerie operator, I want low-risk reads auto-granted when relevant and privileged capabilities routed through the existing approval mechanism, so that relevance never substitutes for authorization and no second permissions system is introduced.

#### Acceptance Criteria

1. WHEN the Capability_Policy_Engine evaluates a request whose risk class is `low` and whose relevance is greater than or equal to the configured relevance threshold, THE Capability_Policy_Engine SHALL return an `auto-allow` decision without triggering a mastermind turn and without triggering a user prompt. *(MCP-004)*
2. WHEN the Capability_Policy_Engine evaluates a request whose risk class is `high`, THE Capability_Policy_Engine SHALL route the decision through `checkAutoApproval` and SHALL return exactly one of `user-approval` or `deny`, and SHALL NOT return `auto-allow`, regardless of the relevance score. *(MCP-005, security)*
3. IF Capability_Discovery reports a relevance score greater than or equal to the configured threshold for a `high`-risk Tool_Capability without a corresponding `checkAutoApproval` approval, THEN THE Capability_Broker SHALL leave the Tool_Capability in its prior non-active state and SHALL NOT make it `active`. *(MCP-015)*
4. THE Capability_Policy_Engine SHALL map each Tool_Capability risk class onto exactly one existing `AutoApprovalState` and SHALL NOT consult or write any permission store other than the existing auto-approval mechanism. *(MCP-005)*
5. WHERE an existing MCP configuration carries no capability metadata, THE Capability_Broker SHALL expose, through the compatibility path, exactly the Tool_Capabilities corresponding to the configured, non-disabled, always-allowed tools and SHALL expose no additional Tool_Capabilities, reproducing current behavior. *(MCP-020)*
6. IF `checkAutoApproval` fails or is unavailable while evaluating a `high`-risk request, THEN THE Capability_Policy_Engine SHALL default to `deny`, SHALL NOT make the Tool_Capability `active`, and SHALL return an error indication to the caller. *(MCP-005, security)*

### Section 5 — Relevance Is Not Authorization

### Requirement 5: Relevance never authorizes a dangerous capability by itself

**User Story:** As a Menagerie operator, I want a high relevance recommendation to never activate a privileged capability on its own, so that discovery ranking can never substitute for approval.

#### Acceptance Criteria

1. IF Capability_Discovery produces a recommendation, including a relevance score of any value up to the maximum of 1.0, for a `high`-risk Tool_Capability without a corresponding `checkAutoApproval` approval, THEN THE Capability_Broker SHALL NOT transition the Tool_Capability to the `active` state AND SHALL return a rejection result indicating that policy authorization is required. *(MCP-015)*
2. THE Capability_Broker SHALL treat Capability_Discovery output solely as a recommendation signal that influences ranking order and SHALL NOT treat any relevance score, including the maximum score of 1.0, as authorization to activate a Tool_Capability. *(MCP-015)*
3. WHEN Capability_Discovery surfaces a `high`-risk Tool_Capability as requestable, THE Capability_Broker SHALL request Capability_Policy_Engine authorization before activation AND SHALL keep the Tool_Capability in its pre-activation state until the Capability_Policy_Engine returns an explicit approval. *(MCP-015)*
4. IF the Capability_Policy_Engine returns a denial or returns no approval for a `high`-risk Tool_Capability, THEN THE Capability_Broker SHALL leave the Tool_Capability in its pre-activation state AND SHALL indicate to the caller that activation was not authorized. *(MCP-015)*

### Section 6 — Reader Isolation

### Requirement 6: Reader workers hold a minimal runtime-enforced surface

**User Story:** As a Menagerie operator, I want reader workers denied write, execute, and mutate capabilities at the runtime layer, so that read-only isolation does not depend on prompt text.

#### Acceptance Criteria

1. WHEN a `project-reader` or `reader.*` worker requests `repo.write`, `git.write`, `cluster.deploy`, `cloud.mutate`, or `browser.interact`, THE Capability_Policy_Engine SHALL return a `deny` decision regardless of request relevance, requesting prompt content, or prior grant history. *(MCP-006)*
2. THE Capability_Broker SHALL grant a `project-reader` or `reader.*` worker a default Tool_Capability set consisting of exactly `semantic.retrieve`, `repo.read`, and the Always_Resident_Core, with `git.read` granted if and only if the worker configuration explicitly enables it, and no other Tool_Capability granted by default. *(MCP-006)*
3. THE Capability_Broker SHALL enforce reader forbidden-capability denial at the runtime authorization layer, where the denial decision is evaluated solely from the worker role identity (`project-reader` or `reader.*`) and the requested capability, and is not derived from any prompt text. *(MCP-006)*
4. IF a `project-reader` or `reader.*` worker is granted a Tool_Capability outside its default set, THEN THE Capability_Broker SHALL deny the grant and preserve the worker's existing capability set unchanged, with an error indication reported to the requesting caller. *(MCP-006)*

### Section 7 — Sibling Isolation

### Requirement 7: Sibling-worker leases are isolated

**User Story:** As a Menagerie operator, I want each worker's leases scoped to that worker, so that one worker acquiring a capability never grants it to siblings.

#### Acceptance Criteria

1. WHEN a Tool_Capability is activated or released for one worker, THE Capability_Broker SHALL leave every other concurrent worker's ALLOWED and ACTIVE sets byte-for-byte unchanged, including sibling, parent, and child workers. *(MCP-007, MCP-010)*
2. THE Capability_Broker SHALL scope each Capability_Lease to exactly one worker identifier, such that no lease grants a capability to more than one worker. *(MCP-007)*
3. IF a parent worker holds an active lease for a Tool_Capability, THEN THE Capability_Broker SHALL NOT add that capability to any child worker's ALLOWED or ACTIVE set absent an explicit inheritance declaration naming that capability. *(MCP-007)*
4. WHERE a child worker is spawned without an explicit inheritance declaration, THE Capability_Broker SHALL grant the child only the Always_Resident_Core set and no other capability, requiring the child to request every capability outside that set through policy. *(MCP-007)*
5. IF a worker requests activation of a Tool_Capability that is held only under another worker's lease, THEN THE Capability_Broker SHALL reject the request without modifying the requesting worker's ALLOWED or ACTIVE set and SHALL return an indication that the capability is not leased to the requesting worker. *(MCP-007, MCP-010)*

### Section 8 — Condensation Survival

### Requirement 8: Capability state survives condensation

**User Story:** As a Menagerie operator, I want capability lease state persisted in structured task state, so that condensing the conversation history never loses or reconstructs it from prose.

#### Acceptance Criteria

1. WHEN a `condenseContext` cycle completes, THE Capability_Broker SHALL read back from structured `AutonomousTaskState` the ALLOWED set, ACTIVE set, and each lease's scope and lifetime fields, and each value SHALL be byte-for-byte equal to the corresponding value present immediately before the cycle began. *(MCP-008)*
2. THE Capability_Broker SHALL persist per-worker capability state within `AutonomousTaskState` as structured data fields, retaining for each worker its ALLOWED set, ACTIVE set, and per-lease scope and lifetime. *(MCP-008)*
3. THE Capability_Broker SHALL derive capability lease state exclusively from structured `AutonomousTaskState` fields and SHALL NOT read, parse, or reconstruct any ALLOWED, ACTIVE, scope, or lifetime value from the conversation transcript prose. *(MCP-008)*
4. IF a required capability lease field is absent or unreadable from structured `AutonomousTaskState` after a `condenseContext` cycle, THEN THE Capability_Broker SHALL treat the affected worker's capability state as unavailable, SHALL return an error indicating the structured lease state could not be read, and SHALL NOT substitute a value reconstructed from the conversation transcript. *(MCP-008)*

### Section 9 — Observatory Integration

### Requirement 9: Observatory exposes capability state read-only

**User Story:** As a Menagerie operator, I want capability state visible in the Observatory, so that I can inspect active, available, released, and denied capabilities without mutating task lifecycle.

#### Acceptance Criteria

1. WHEN a user inspects any capability Observatory section, THE Capability_Broker SHALL perform zero lifecycle-mutating operations and SHALL send only read-only webview messages on the `observatoryUpdate` channel. *(MCP-009)*
2. THE Capability_Broker SHALL expose capability state as an additive read-only `ObservationEvent` variant delivered through the existing `observatoryUpdate` channel, partitioned into exactly four sections: ACTIVE, AVAILABLE, RELEASED, and DENIED. *(MCP-009)*
3. WHILE a capability inspection sequence runs, THE Capability_Broker SHALL leave every worker's capability assignment and lifecycle state byte-for-byte identical before and after inspection. *(MCP-009)*
4. WHERE lease event history is enabled, THE Capability_Broker SHALL include a read-only lease event history collection within the `ObservationEvent` variant and SHALL NOT alter any lease, capability, or lifecycle state when producing it. *(MCP-009)*
5. IF capability state cannot be read or serialized into an `ObservationEvent`, THEN THE Capability_Broker SHALL omit the unavailable section, send a read-only webview message indicating the inspection failure and the affected section, and SHALL leave all worker capability and lifecycle state unchanged. *(MCP-009)*

### Section 10 — Release Removes Schemas

### Requirement 10: Release removes schemas on the next generation without an MCP process restart

**User Story:** As a Menagerie operator, I want releasing a capability to remove its schema on the next generation by recomposition rather than by restarting MCP processes, so that release is cheap and non-disruptive.

#### Acceptance Criteria

1. WHEN a worker releases an active Capability_Lease, THE Schema_Composer SHALL exclude that Tool_Capability's tools from the composed surface used for the next generation (the first generation whose SYSTEM_PROMPT is composed after the release is recorded), while retaining every remaining ACTIVE Tool_Capability's schema and the core prefix byte-identical to their pre-release content. *(MCP-013)*
2. WHEN a Tool_Capability is released, THE Schema_Composer SHALL remove its schema from the next composed surface without restarting or disconnecting the providing MCP process, and without altering the connection state of any other MCP process. *(MCP-018)*
3. THE Schema_Composer SHALL remove unleased schemas by presenting a filtered `McpHub` view plus a `disabledTools` filter into `SYSTEM_PROMPT`, reusing the existing serialization path. *(MCP-018)*
4. THE Capability_Broker SHALL treat MCP process idle or disconnect as an optional secondary optimization and SHALL NOT require it to remove a schema from context. *(MCP-018)*
5. IF a release targets a Tool_Capability whose tools remain held by at least one other active Capability_Lease, THEN THE Schema_Composer SHALL retain that Tool_Capability's schema in the next composed surface and SHALL return an outcome indicating the schema was retained due to a remaining active lease. *(MCP-018)*
6. IF recomposition of the next composed surface fails, THEN THE Schema_Composer SHALL retain the last successfully composed surface, SHALL NOT restart or disconnect any MCP process, and SHALL surface an error indication identifying that recomposition failed. *(MCP-018)*

### Section 11 — Provider Failure

### Requirement 11: Unavailable capability yields an explicit error with optional remap

**User Story:** As a Menagerie operator, I want an unavailable capability provider to raise an explicit capability-level error, so that the model never assumes a tool succeeded.

#### Acceptance Criteria

1. IF an active Capability_Lease's provider becomes unavailable and no semantically compatible alternate provider is registered, THEN THE Capability_Broker SHALL surface an explicit capability-level error that includes the capability identifier, the provider id, and the lease state at the time of failure. *(MCP-014)*
2. WHEN an active Capability_Lease's provider becomes unavailable and a semantically compatible alternate provider is registered, THE Capability_Broker MAY transparently remap the lease to the alternate provider without surfacing an error to the caller. *(MCP-014)*
3. WHILE a Tool_Capability's provider is unavailable and no remap has succeeded, THE Capability_Broker SHALL NOT report that Tool_Capability's tool invocation as succeeded. *(MCP-014)*
4. IF a transparent remap to a semantically compatible alternate provider fails, THEN THE Capability_Broker SHALL surface the explicit capability-level error defined in criterion 1, carrying the capability identifier, the originating provider id, and the lease state. *(MCP-014)*

### Section 12 — Provisioning and Lazy Acquisition

### Requirement 12: DAG-node required capabilities are provisioned before first generation, and lazy acquisition still works

**User Story:** As a Menagerie operator, I want a DAG node's declared required capabilities provisioned before the worker's first generation while in-execution requests still work, so that a worker begins with the tools its node needs and can acquire more lazily.

#### Acceptance Criteria

1. WHEN a DAG node declares a required Tool_Capability set and every Tool_Capability in that set passes the Capability_Policy_Engine evaluation, THE Capability_Broker SHALL transition each of those Tool_Capabilities to `active` state and confirm all are `active` before the worker's first generation begins. *(MCP-016)*
2. IF one or more Tool_Capabilities in a DAG node's declared required set fail the Capability_Policy_Engine evaluation, THEN THE Capability_Broker SHALL withhold `active` state from the failed Tool_Capabilities, provision only the passing Tool_Capabilities as `active` before the worker's first generation, and record a denial outcome identifying each withheld Tool_Capability. *(MCP-016)*
3. WHEN a worker invokes `capability.request` during execution with a ToolCapabilityId and a reason, THE Capability_Broker SHALL evaluate the request through the Capability_Policy_Engine and return a grant outcome of either granted or denied, where a granted outcome transitions the Tool_Capability to `active` and a denied outcome leaves its state unchanged and indicates the denial to the caller. *(MCP-003)*
4. WHERE a requested Tool_Capability was not declared in the worker's provisioned requirement set, THE Capability_Broker SHALL still accept and evaluate the worker's `capability.request` during execution through the same Capability_Policy_Engine path used for declared capabilities. *(MCP-017)*
5. THE Capability_Broker SHALL attach node capability requirements additively to `ParallelTaskSpec` such that a `ParallelTaskSpec` containing no node capability requirements remains valid after `.strip()` and `.strip()` removes only the additively attached node capability requirements while preserving all pre-existing `ParallelTaskSpec` fields. *(MCP-016)*

### Section 13 — Fail-Closed Degradation

### Requirement 13: Fail-closed when the broker is unhealthy

**User Story:** As a Menagerie operator, I want the broker to fail closed on internal failure, so that a broker fault never exposes the full configured MCP tool set.

#### Acceptance Criteria

1. IF the Capability_Broker's internal structures fail, THEN THE Capability_Broker SHALL retain the current ACTIVE set unchanged, performing no additions, removals, or modifications to any `active` Capability_Lease for the duration of Capability_Broker_Degradation. *(MCP-019)*
2. WHILE the Capability_Broker is in Capability_Broker_Degradation, THE Capability_Broker SHALL refuse every request to make a new `high`-risk Capability_Lease `active` and SHALL return a refusal response indicating the broker is in a degraded state. *(MCP-019)*
3. IF the Capability_Broker's internal structures fail, THEN THE Capability_Broker SHALL NOT expose any Capability outside the retained ACTIVE set, including the full configured MCP tool set, in any response to a tool-discovery or acquisition request. *(MCP-019)*
4. WHEN Capability_Broker_Degradation occurs, THE Capability_Broker SHALL set the task state to indicate the degraded condition. *(MCP-019)*
5. WHEN Capability_Broker_Degradation occurs, THE Capability_Broker SHALL emit exactly one Observatory event indicating the degraded condition within 1 second of detecting the internal failure. *(MCP-019)*

### Section 14 — Compatibility Path

### Requirement 14: Existing MCP configurations keep working through the compatibility path

**User Story:** As a Menagerie operator, I want existing MCP configurations to keep working through a compatibility path, so that adopting the broker does not break any configured tool and tightening only ever removes exposure.

#### Acceptance Criteria

1. WHERE an existing MCP configuration carries no capability metadata, THE Capability_Broker SHALL expose exactly the set of Tool_Capabilities whose corresponding tools are present in the McpHub configuration AND absent from the `disabledTools` list AND present in the `alwaysAllow` list, such that the exposed set is identical to the set the operator observed before broker adoption. *(MCP-020)*
2. WHEN an operator applies a configuration change that tightens toward least privilege, THE Capability_Broker SHALL produce a resulting exposed Tool_Capability set that is a subset of (or equal to) the compatibility-baseline exposed set, adding zero Tool_Capabilities not already present in that baseline. *(MCP-020)*
3. IF a configuration change would add one or more Tool_Capabilities not present in the compatibility-baseline exposed set, THEN THE Capability_Broker SHALL reject the tightening change, retain the prior exposed set unchanged, and return an error indication identifying the capabilities that would have been added. *(MCP-020)*
4. WHEN a `ParallelTaskSpec` entry carries no capability metadata, THE Capability_Broker SHALL treat it as valid by applying the existing `.strip()` normalization, producing a non-null spec with an empty capability set and no validation error. *(MCP-020)*

### Section 15 — Context Accounting

### Requirement 15: Tool-schema token-savings accounting is exact

**User Story:** As a Menagerie operator, I want exact context-accounting metrics for tool schemas, so that I can measure tokens avoided by not exposing unleased schemas.

#### Acceptance Criteria

1. WHEN the Capability_Broker completes a generation, THE Capability_Broker SHALL report `toolSchemaTokensAvoided` as `toolSchemaTokensTotalIfAllExposed` minus `toolSchemaTokensActive`, computed per-generation. *(MCP-012)*
2. WHEN the Capability_Broker reports token-accounting metrics, THE Capability_Broker SHALL report `toolSchemaTokensActive` as less than or equal to `toolSchemaTokensTotalIfAllExposed`, with both operands being non-negative integers. *(MCP-012)*
3. THE Capability_Broker SHALL expose context-accounting metrics as an additive optional `capabilityTelemetry` field on `WorkerResult`, such that when the field is absent all consumers treat accounting as unreported rather than zero. *(MCP-012)*
4. WHEN the Capability_Broker reports `capabilityTelemetry`, THE Capability_Broker SHALL record, for the generation, the count of available MCP tools, the count of active MCP tools, core tokens, leased tokens, capabilities activated, capabilities released, request count, and denial count, with each count being a non-negative integer. *(MCP-012)*
5. IF `toolSchemaTokensActive` exceeds `toolSchemaTokensTotalIfAllExposed`, or if either operand is negative, THEN THE Capability_Broker SHALL omit the `capabilityTelemetry` field and record an error indication that accounting invariants were violated, without altering the generation's primary result. *(MCP-012)*

### Section 16 — Always-Resident Core

### Requirement 16: Always-resident core surface with no acquisition recursion

**User Story:** As a worker, I want a minimal always-resident core surface including the request and release tools, so that I can always function and always ask for more without first needing an optional MCP capability.

#### Acceptance Criteria

1. THE Capability_Broker SHALL include `capability.request` and `capability.release` as members of the Always_Resident_Core surface, each invocable while zero optional MCP Tool_Capabilities are `active`. *(MCP-003)*
2. WHEN a worker invokes any Always_Resident_Core tool while no optional MCP Tool_Capability is `active`, THE Capability_Broker SHALL execute the invocation without first requiring acquisition of any optional MCP Tool_Capability.
3. IF acquiring, invoking, or releasing an Always_Resident_Core tool would require any optional MCP Tool_Capability to be `active` as a precondition, THEN THE Capability_Broker SHALL reject the configuration with an error indicating a prohibited core-to-optional dependency, such that no acquisition cycle exists among Always_Resident_Core tools.
4. THE Capability_Broker SHALL include exactly the following tools in the Always_Resident_Core surface: task-state read, task-state update, plan update, todo update, `semantic.retrieve`, bounded evidence read, `capability.request`, `capability.release`, and `attempt_completion`.
5. THE Capability_Broker SHALL keep every Always_Resident_Core tool in the `active` state at all times and SHALL NOT lease, scope, or revoke any Always_Resident_Core tool.

### Section 17 — Scoping

### Requirement 17: Capability scope is best-effort, preserved, and never silently widened

**User Story:** As a Menagerie operator, I want a granted capability's scope preserved exactly as requested, so that a scoped grant is never silently widened.

#### Acceptance Criteria

1. WHEN a scoped Tool_Capability request is granted, THE Capability_Broker SHALL store a Capability_Lease whose scope string is byte-for-byte identical to the requested scope string (for example, requested `repo.read scope=/workspace` yields stored lease scope `/workspace`; `cluster.deploy scope=namespace=nervecenter` yields `namespace=nervecenter`; `browser.interact scope=current session` yields `current session`). *(MCP-017 scope)*
2. THE Capability_Broker SHALL NOT, on any grant path, store or return a Capability_Lease whose scope is broader than the requested scope, where "broader" means the granted scope admits any resource, namespace, path, or session not admitted by the requested scope. *(MCP-017 scope)*
3. IF a scoped Tool_Capability request is received for a provider that declares no scoping support for the requested scope dimension, THEN THE Capability_Broker SHALL either grant a Capability_Lease whose scope equals the requested scope or deny the request, and SHALL NOT grant a lease with a widened scope. *(MCP-017 scope)*
4. THE Capability_Broker SHALL treat scoping as best-effort and provider-declared, and SHALL NOT guarantee fine-grained scoping for every provider. *(MCP-017 scope)*
