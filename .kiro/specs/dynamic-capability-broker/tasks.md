# Implementation Plan: Dynamic Capability Broker and MCP Leasing

## Overview

This plan implements **FEAT-013 — the Dynamic Capability Broker**, the Menagerie layer that
schedules each worker's **tool-capability surface**: a worker is born with a tiny always-resident
core and acquires additional Tool Capabilities only while they are relevant, via policy-authorized
**leases** that expire at a declared boundary. Every addition is **additive TypeScript** in the
Menagerie `src/` tree and consumes sibling contracts **read-only**: `WorkerResult` /
`AutonomousTaskState` (mastermind-execution-metadata), `CapabilityLane` / `RoutingMetadata`
(capability-lanes-routing, an orthogonal cognitive axis), `RetrievalGatewayClient.retrieve` /
`EvidencePacket` / `SemanticFinding` (semantic-first-retrieval), `ObservationEvent` /
`observatoryUpdate` (task-observatory), and `BoundedElasticScheduler` / `RouteCapability`
(elastic-parallel-execution). No sibling contract is redefined. `checkAutoApproval` /
`AutoApprovalState` (`src/core/auto-approval/index.ts`) are the **sole** authorization authority —
risk classes map onto existing states; the module is **not** forked. `McpHub`
(`src/services/mcp/McpHub.ts`) is the single source of concrete MCP tool schemas, and
`SYSTEM_PROMPT`/`generatePrompt` (`src/core/prompts/system.ts`) is the enforcement hook via a
filtered `McpHub` view plus the existing `disabledTools` argument.

Work proceeds bottom-up and test-first: the pure taxonomy/registry/catalog land first, then the
lease ledger and its `AutonomousTaskState` persistence (condensation survival), then the pure
`CapabilityPolicyEngine` and the deterministic `SchemaComposer`, then the `CapabilityBroker`
orchestration that ties them together, then discovery, the `ParallelTaskSpec`/DAG wiring, the
Observatory event, the compatibility path, and telemetry — ending with the real-extension-host
enforcement smoke. The catalog, registry, policy engine, lease ledger, and composer are pure or
near-pure (`McpHub`, autonomy state, relevance, and capacity are passed in) so they are unit- and
property-testable without I/O.

New broker source modules live under `src/core/capability/`; new tests live under
`src/core/capability/__tests__/`. The additive `AutonomousTaskState.capabilities` and
`WorkerResult.capabilityTelemetry` fields are declared beside the existing
mastermind-execution-metadata types; the additive capability `ObservationEvent` variant and its
webview message type are declared beside `src/services/observatory/` and in
`packages/types/src/vscode-extension-host.ts`; the additive `NodeCapabilityRequirement` rides on
`ParallelTaskSpec` in `src/core/tools/ParallelTasksTool.ts`.

Property tests use `fast-check` at the package-local unit layer with a minimum of 100 iterations
each, tagged `// Feature: dynamic-capability-broker, Property N: ...`. Integration tests use faked
collaborators (filtered `McpHub` view, autonomy state, `RetrievalGatewayClient`, settled
`WorkerResult`s) from `src/test-utils`. Observatory zero-mutation is a `webview-ui` test. A single
`apps/vscode-e2e` smoke covers only the real-extension-host boundary that lower layers cannot
represent. Scheduler dispatch/leasing, the `WorkerResult`/`AutonomousTaskState` base contracts,
cognitive-lane routing, retrieval quality, and Observatory zero-mutation discipline are
cross-referenced to their owning specs rather than re-tested here.

After editing any file, run the narrowest Vitest suite and
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` per AGENTS.md; suppression
counts must not increase. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Tasks

- [x] 1. Define the Tool Capability taxonomy and the extensible provider registry foundations
  - [x] 1.1 Create `src/core/capability/toolCapability.ts` with `ToolCapabilityId`, risk/access/provider kinds, and the seed vocabulary
    - Define the exported `ToolCapabilityId` as the namespaced string union from the design (`"semantic.retrieve"`, `"repo.read"`, `"repo.write"`, `"git.read"`, `"git.write"`, `"terminal.read"`, `"terminal.execute"`, `"cluster.read"`, `"cluster.deploy"`, `"browser.inspect"`, `"browser.interact"`, `"cloud.read"`, `"cloud.mutate"`, `"observability.read"`, `"issue.read"`, `"issue.write"`, `"artifact.read"`, `"artifact.write"`) with the `| (string & {})` extension point — an **extensible** vocabulary backed by a runtime registry, NOT a closed enum.
    - Define `CapabilityAccessKind` (`"read" | "write" | "execute"`), `CapabilityRiskClass` (`"low" | "elevated" | "high"`), and `ProviderClass` (`"native" | "mcp"`).
    - Export a `SEED_RISK_BY_CAPABILITY` map pinning each seed capability to its design risk class (low reads; `terminal.read` elevated; the write/execute/deploy/mutate/interact set high) so the catalog and policy engine share one source of truth.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/toolCapability.ts`.
    - _Requirements: 4.4_

  - [x] 1.2 Create `src/core/capability/capabilityCatalog.ts` with `CapabilityCatalogEntry`, `CapabilityCatalog`, and the seed catalog + `mastermindView`
    - Import the taxonomy from `./toolCapability`. Define `CapabilityCatalogEntry` (`id`, `description`, `risk`, `access`, `providerClass`, `requiredArgHints?`, `scopeable?`, `core?`) and the `CapabilityCatalog` interface (`get`, `list`, `mastermindView`).
    - Implement a `createCapabilityCatalog(entries)` factory and a `SEED_CAPABILITY_CATALOG` seeding every taxonomy capability with compact metadata only. `mastermindView()` MUST return `Pick<CapabilityCatalogEntry, "id" | "description" | "risk" | "access" | "requiredArgHints" | "scopeable">[]` — it MUST NOT carry any tool-schema internals, server names, transports, or tool IDs.
    - Mark the Always-Resident-Core members (`core: true`): task-state read, task-state update, plan update, todo update, `semantic.retrieve`, bounded evidence read, `capability.request`, `capability.release`, `attempt_completion`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityCatalog.ts`.
    - _Requirements: 16.4_

  - [ ]* 1.3 Write unit tests for the compact mastermind view and seed-catalog risk assignment
    - Create `src/core/capability/__tests__/capabilityCatalog.spec.ts`.
    - Assert `mastermindView()` entries contain only the compact keys and never a `schemaRef`, server name, or tool id; assert every seed capability's risk matches `SEED_RISK_BY_CAPABILITY`; assert exactly the nine core members carry `core: true`.
    - Run `npx vitest run src/core/capability/__tests__/capabilityCatalog.spec.ts`.
    - _Requirements: 16.4, 4.4_

- [x] 2. Implement the Provider Registry grounded in McpHub
  - [x] 2.1 Create `src/core/capability/providerRegistry.ts` with `ResolvedTool`, `CapabilityProvider`, and `ProviderRegistry`
    - Import the taxonomy from `./toolCapability`. Define `ResolvedTool` (`providerClass`, `providerId`, `toolName`, `schemaRef: unknown`), `CapabilityProvider` (`providerClass`, `providerId`, `satisfies`, `toolsFor(capability)`), and `ProviderRegistry` (`register`, `providersFor(capability)`, `resolve(capability, preferredProviderId?)`).
    - Implement `createProviderRegistry()` that stores providers in an insertion-stable structure; `providersFor` returns every provider satisfying a capability (for remap/failover); `resolve` returns the concrete `ResolvedTool[]` for an active lease, preferring `preferredProviderId` when supplied.
    - Add `registerMcpProviders(registry, mcpHub)` that reads server/tool metadata from `McpHub` (`src/services/mcp/McpHub.ts`: connections, tool lists) and registers each configured MCP server as a `CapabilityProvider` whose `schemaRef` is an opaque handle sourced from the hub — it MUST NOT duplicate or copy schema storage; the hub stays the single source of concrete schemas. Accept the hub through a narrow passed-in interface so the registry is testable with a faked hub.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/providerRegistry.ts`.
    - _Requirements: 11.1, 11.2_

  - [ ]* 2.2 Write unit tests for registration, multi-provider resolution, and failover enumeration
    - Create `src/core/capability/__tests__/providerRegistry.spec.ts` with a faked `McpHub` surface.
    - Assert two providers satisfying the same capability (e.g. two `cluster.read` servers) are both returned by `providersFor`; `resolve` honors `preferredProviderId` and otherwise returns a deterministic provider; registration reads from the faked hub and never stores schema bytes (only opaque `schemaRef`).
    - Run `npx vitest run src/core/capability/__tests__/providerRegistry.spec.ts`.
    - _Requirements: 11.2, 14.1_

- [x] 3. Define the CapabilityLease, two-level worker state, and its AutonomousTaskState persistence
  - [x] 3.1 Create `src/core/capability/capabilityLease.ts` with lease and `WorkerCapabilityState` types plus pure state transitions
    - Define `LeaseRequester`, `LeaseState` (`"requested" | "active" | "released" | "denied"`), `LeaseLifetime` (`"tool-complete" | "phase-complete" | "task-complete"`), `CapabilityLease` (all fields from the design including `scope?: string[]`, `providerId?`, timestamps), and `WorkerCapabilityState` (`workerId`, `allowed`, `active`, `leases`).
    - Implement pure helpers over a `WorkerCapabilityState`: `activate`, `release`, `deny`, and `isActive`. `activate` MUST reject (returning the state unchanged plus an error marker) any attempt to place a capability in `active` that is not in `allowed`, enforcing the ACTIVE ⊆ ALLOWED invariant; `deny` MUST remove the capability from both `allowed` and `active`; the Always-Resident-Core capabilities MUST remain in `allowed` regardless of lease state. These helpers perform no I/O.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityLease.ts`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 3.2 Write property tests for the ACTIVE⊆ALLOWED invariant and DENIED exclusion
    - Create `src/core/capability/__tests__/capabilityLease.spec.ts` with the `fast-check` import.
    - **Property 2: ACTIVE is always a subset of ALLOWED, which excludes DENIED** — over generated sequences of request/grant/release/deny operations, the resulting `active` set is always a subset of `allowed`, and no capability with a `denied` lease ever appears in `allowed` or `active`; an `activate` of a non-allowed capability leaves both sets unchanged and signals the invariant violation (`// Feature: dynamic-capability-broker, Property 2: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/capabilityLease.spec.ts`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
    - _Properties: 2_

  - [x] 3.3 Add the additive `AutonomousTaskState.capabilities` field and worker-state serialization
    - Beside the mastermind-execution-metadata `AutonomousTaskState` type, declare the additive `AutonomousTaskStateCapabilities` extension (`capabilities?: { workers: WorkerCapabilityState[]; brokerDegraded?: boolean }`). Do NOT modify or remove any base `AutonomousTaskState` field; an absent `capabilities` reads as legacy compatibility mode.
    - In a new `src/core/capability/capabilityStatePersistence.ts`, add `writeWorkerCapabilityState(taskState, state)` and `readWorkerCapabilityState(taskState, workerId)` that persist/read the two-level state as structured fields only. `read` MUST return an explicit unavailable result (never a prose-reconstructed value) when the structured field is absent or unreadable.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityStatePersistence.ts`.
    - _Requirements: 8.2, 8.3, 8.4_

  - [ ]* 3.4 Write property test for capability-state round-trip through structured task state
    - Create `src/core/capability/__tests__/capabilityStatePersistence.spec.ts`.
    - **Property 8: Capability state round-trips through condensation** — over generated `WorkerCapabilityState`s, serializing into `AutonomousTaskState` and reading back yields byte-for-byte equal `allowed`, `active`, and per-lease scope/lifetime; reading when the structured field is absent returns the explicit unavailable result and never a value derived from transcript prose (`// Feature: dynamic-capability-broker, Property 8: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/capabilityStatePersistence.spec.ts`.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
    - _Properties: 8_

- [x] 4. Implement the pure Capability Policy Engine over checkAutoApproval
  - [x] 4.1 Create `src/core/capability/capabilityPolicyEngine.ts` with `PolicyDecision` and pure `decide`
    - Import the taxonomy/catalog, and import `AutoApprovalState`/`AutoApprovalStateOptions` types read-only from `src/core/auto-approval` (`..`). Define `PolicyDecision` (`"auto-allow" | "mastermind-approval" | "user-approval" | "deny"`, each with `reasons`).
    - Implement a pure, synchronous `decide({ entry, request, relevance, autoApprovalState })` that: returns `auto-allow` only when `entry.risk === "low"` AND `relevance >= threshold` (no mastermind turn, no user prompt); returns `user-approval` or `deny` (never `auto-allow`) for `high` risk regardless of relevance; maps each risk class onto exactly one existing `AutoApprovalState` key (low→`alwaysAllowReadOnly`, high→`alwaysAllowWrite`/`alwaysAllowExecute`/`alwaysAllowMcp` by access kind) using the passed-in autonomy state; and consults no permission store other than the auto-approval fields. The actual `checkAutoApproval` call is performed by the broker (step 7), keeping this engine pure/testable.
    - Add `readerForbids(role, capability)`: for a `project-reader` / `reader.*` role, return `true` for `repo.write`, `git.write`, `cluster.deploy`, `cloud.mutate`, `browser.interact` — derived solely from role identity and the requested capability, never from prompt text. `decide` MUST return `deny` whenever `readerForbids` holds, regardless of relevance.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityPolicyEngine.ts`.
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 4.2 Write property tests for low-auto/high-via-approval, relevance≠authorization, and reader denial
    - Create `src/core/capability/__tests__/capabilityPolicyEngine.spec.ts`.
    - **Property 4: Low-risk reads may auto-grant; privileged capabilities route through checkAutoApproval** — over generated requests across risk classes, relevance scores, and autonomy-state combinations, `auto-allow` occurs only for `low` risk at/above threshold, and a `high`-risk request is never `auto-allow` (only `user-approval` or `deny`) regardless of relevance (`// Feature: ..., Property 4: ...`, ≥100 runs).
    - **Property 5: Relevance never authorizes a dangerous capability by itself** — for any `high`-risk capability with relevance up to and including 1.0 and no autonomy-state approval, `decide` never yields `auto-allow` (`// Feature: ..., Property 5: ...`, ≥100 runs).
    - **Property 6: Reader workers never hold write/execute/mutate capabilities** — for any `project-reader`/`reader.*` request for the forbidden set, `decide` returns `deny` regardless of relevance or autonomy state (`// Feature: ..., Property 6: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/capabilityPolicyEngine.spec.ts`.
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4_
    - _Properties: 4, 5, 6_

- [x] 5. Implement the deterministic Schema Composer and its SYSTEM_PROMPT enforcement wiring
  - [x] 5.1 Create `src/core/capability/schemaComposer.ts` with `ComposedToolSurface` and deterministic `compose`
    - Import `WorkerCapabilityState`, `ProviderRegistry`, and `ResolvedTool`. Define `ComposedToolSurface` (`corePrefix`, `leasedNative`, `leasedMcp`, `disabledTools`). Implement `compose(state, registry)` producing exactly the Always-Resident-Core tools plus the tools of capabilities whose lease state is `active`, and nothing else — a capability that is only configured, only ALLOWED, `released`, or `denied` contributes zero tools.
    - Order the surface as: byte-stable core prefix, then leased native tools sorted ascending by `ToolCapabilityId`, then leased MCP tools sorted ascending by `(ToolCapabilityId, serverName, toolName)`. Composition MUST be a pure function of the active set so repeated calls yield byte-identical output and a single activation appends after existing leased entries without disturbing prior byte offsets.
    - Compute `disabledTools` as the filter suppressing every unleased native/MCP tool, to be threaded into the existing `SYSTEM_PROMPT` argument.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/schemaComposer.ts`.
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 5.2 Write property tests for surface = core + active, determinism/prefix-stability, and release removal
    - Create `src/core/capability/__tests__/schemaComposer.spec.ts`.
    - **Property 1: A worker's serialized tool surface equals core plus active leases, and nothing else** — over generated `WorkerCapabilityState`s, the composed surface contains exactly core + `active` tools and no tool of a merely configured/allowed/released/denied capability; an empty active set yields core-only (`// Feature: ..., Property 1: ...`, ≥100 runs).
    - **Property 3: Composition is deterministic and prefix-stable** — repeated `compose` of the same active set is byte-identical with an unchanged core prefix; adding one activation preserves the byte positions of the core prefix and all previously-ordered leased entries and appends the new schema last (`// Feature: ..., Property 3: ...`, ≥100 runs).
    - **Property 10: Release removes schemas on the next generation** — after moving a lease out of `active`, the next composed surface excludes that capability's tools while retaining the remaining active set and the byte-identical core prefix; a release of a capability still held by another active lease retains the schema (`// Feature: ..., Property 10: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/schemaComposer.spec.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 3.1, 3.2, 10.1, 10.5_
    - _Properties: 1, 3, 10_

  - [x] 5.3 Wire the composed surface into SYSTEM_PROMPT via a filtered McpHub view and disabledTools
    - Add `src/core/capability/composedMcpView.ts` exposing `applyComposedSurface(mcpHub, surface)` that returns a filtered `McpHub` view exposing only leased servers/tools plus the computed `disabledTools`, suitable to pass into `SYSTEM_PROMPT(... mcpHub, ... disabledTools ...)` → `generatePrompt` in `src/core/prompts/system.ts`. Reuse the existing serialization path; do NOT fork `SYSTEM_PROMPT`, and do NOT restart or disconnect any MCP process to remove a schema.
    - On recomposition failure, retain the last successfully composed surface, restart/disconnect no MCP process, and surface an error indication naming the failure.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/composedMcpView.ts`.
    - _Requirements: 10.2, 10.3, 10.4, 10.6_

  - [ ]* 5.4 Write integration test for enforcement wiring (only leased schemas serialized, no process restart)
    - Create `src/core/capability/__tests__/composerEnforcement.integration.spec.ts` using a faked `McpHub` surface and the real `SYSTEM_PROMPT`/`generatePrompt` seam.
    - Assert that composing an active subset and applying the filtered view + `disabledTools` serializes only the leased MCP/native schemas and omits all unleased ones; assert no MCP process restart/disconnect call is made; assert a recomposition failure retains the prior surface.
    - Run `npx vitest run src/core/capability/__tests__/composerEnforcement.integration.spec.ts`.
    - _Requirements: 1.1, 1.2, 10.2, 10.3, 10.6_

- [x] 6. Checkpoint - Ensure all pure-component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the Capability Broker orchestration surface
  - [x] 7.1 Create `src/core/capability/capabilityBroker.ts` with `coreCapabilities`, `requestCapability`, `releaseCapability`, and `snapshot`
    - Import the catalog, registry, policy engine, lease helpers, persistence, and composer. Define `CapabilityRequest`, `GrantOutcome` (`"activated" | "pending-approval" | "denied" | "broker-degraded"`), and the `CapabilityBroker` interface from the design.
    - `coreCapabilities()` returns exactly the nine Always-Resident-Core members, each always `active`, never leased/scoped/revoked; `capability.request`/`capability.release` are native core tools reachable with zero optional MCP active — reject any configuration that would make a core tool depend on an optional MCP capability (no acquisition recursion).
    - `requestCapability(req)` runs `CapabilityPolicyEngine.decide`; for `high` risk it calls `checkAutoApproval` from `src/core/auto-approval` and honors `approve`/`ask`/`deny` (ask → `pending-approval`, lease `requested`, no schema composed; deny → `denied` lease). IF `checkAutoApproval` fails or is unavailable, default to `deny`, do not activate, and return an error indication. On `approve`/`auto-allow`, transition to `active`, persist the delta per-worker, and recompose.
    - `releaseCapability(workerId, capability)` moves the lease out of `active` (schema gone next generation) unless another active lease still holds the capability; `snapshot(workerId)` is read-only and mutates no lifecycle state. All grant/compose paths are per-worker with no global lock.
    - Store the resolved `providerId` on an active lease; on provider unavailability, attempt transparent remap via `providersFor`, and if none is compatible surface an explicit `{capability, providerId, state}` capability-level error (never a silent success). Never report an invocation as succeeded while the provider is unavailable and unremapped.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityBroker.ts`.
    - _Requirements: 1.4, 4.6, 7.1, 7.2, 7.5, 10.1, 11.1, 11.2, 11.3, 11.4, 12.3, 16.1, 16.2, 16.3, 16.5, 17.1, 17.2, 17.3, 17.4_

  - [x] 7.2 Add fail-closed degradation and parent/child least-privilege scoping to the broker
    - When the broker's internal structures (catalog/registry/composer) fail, enter `Capability_Broker_Degradation`: retain the current `active` set unchanged, refuse every new `high`-risk activation with a `broker-degraded` outcome, never expose any capability outside the retained active set (never the full configured MCP set) to any discovery/acquisition request, set `brokerDegraded` in task state, and emit exactly one degraded Observatory event within 1 second of detecting the failure.
    - Scope each lease to exactly one `workerId`; activating/releasing for one worker leaves every sibling/parent/child `allowed`/`active` set unchanged. A child spawned without an explicit inheritance declaration receives only the core set; reject a request to activate a capability held only under another worker's lease without mutating the requester's sets. Preserve a granted scope byte-for-byte and never widen it; for a provider that declares no scoping for the requested dimension, either grant at the requested scope or deny.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityBroker.ts`.
    - _Requirements: 6.4, 7.3, 7.4, 13.1, 13.2, 13.3, 13.4, 13.5, 17.1, 17.2, 17.3, 17.4_

  - [ ]* 7.3 Write property tests for sibling isolation, no-recursion core, fail-closed, and scope preservation
    - Create `src/core/capability/__tests__/capabilityBroker.spec.ts` with faked catalog/registry/policy and a faked `checkAutoApproval`.
    - **Property 7: Sibling leases are isolated** — activating/releasing for one worker leaves every other concurrent worker's `allowed`/`active` byte-for-byte unchanged (`// Feature: ..., Property 7: ...`, ≥100 runs).
    - **Property 16: No acquisition recursion** — `capability.request`/`capability.release` are core members reachable with zero optional MCP active; any configuration introducing a core→optional dependency is rejected (`// Feature: ..., Property 16: ...`, ≥100 runs).
    - **Property 13: Fail-closed under broker degradation** — on simulated internal failure, the active set is retained, no new `high`-risk lease activates, and the full configured MCP set is never exposed (`// Feature: ..., Property 13: ...`, ≥100 runs).
    - **Property 17: Scope is preserved on the lease and never silently widened** — a granted scoped request stores a lease scope byte-identical to the request, and no grant path widens the requested scope (`// Feature: ..., Property 17: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/capabilityBroker.spec.ts`.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 13.1, 13.2, 13.3, 16.1, 16.2, 16.3, 17.1, 17.2, 17.3_
    - _Properties: 7, 13, 16, 17_

  - [ ]* 7.4 Write integration test for the policy→checkAutoApproval seam and provider failure/remap
    - Create `src/core/capability/__tests__/capabilityBroker.integration.spec.ts` with a faked autonomy state driving the real `checkAutoApproval` and a faked provider registry.
    - **Property 11: Unavailable provider yields an explicit error, never invented success** — a provider going unavailable with a registered compatible alternate transparently remaps with no error; with no alternate, the broker surfaces the explicit `{capability, providerId, state}` error and never reports success. Also assert a `high`-risk request calls `checkAutoApproval` and honors `approve`/`ask`/`deny`, and that a `checkAutoApproval` failure defaults to `deny` without activation (`// Feature: ..., Property 11: ...`).
    - Run `npx vitest run src/core/capability/__tests__/capabilityBroker.integration.spec.ts`.
    - _Requirements: 4.6, 11.1, 11.2, 11.3, 11.4_
    - _Properties: 11_

- [x] 8. Implement Capability Discovery as a recommendation signal only
  - [x] 8.1 Create `src/core/capability/capabilityDiscovery.ts` with `CapabilityRecommendation` and `recommend`
    - Import `CapabilityCatalog` and the retrieval client. Define `CapabilityRecommendation` (`capability`, `score`, `why`) and `CapabilityDiscovery.recommend(intent, workspace)`. Index the compact catalog descriptions and rank them for the intent using `RetrievalGatewayClient.retrieve` / `EvidencePacket` / `SemanticFinding` (semantic-first-retrieval), consumed read-only.
    - The output is a recommendation signal ONLY: it influences ranking order and MUST NOT authorize activation. A discovery/retrieval failure is not an authorization error — return an empty or partial ranking and let the broker proceed with mastermind/worker-initiated requests and core capabilities.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityDiscovery.ts`.
    - _Requirements: 5.2, 5.3_

  - [ ]* 8.2 Write unit test that discovery never activates a high-risk capability
    - Create `src/core/capability/__tests__/capabilityDiscovery.spec.ts` with a faked retrieval client.
    - Assert the k8s-cert intent ranks `cluster.read`/`observability.read` high while `cluster.deploy` (high risk) is surfaced only as requestable and never activated from the signal; assert a retrieval failure yields a non-throwing partial/empty ranking.
    - Run `npx vitest run src/core/capability/__tests__/capabilityDiscovery.spec.ts`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 9. Wire DAG-node capability provisioning additively onto ParallelTaskSpec
  - [x] 9.1 Attach `NodeCapabilityRequirement` additively to `ParallelTaskSpec` and provision before first generation
    - In `src/core/tools/ParallelTasksTool.ts`, add the additive `NodeCapabilityRequirement` (`required`, `optionalHints?`, `scopeHints?`) and `ParallelTaskSpecCapabilities` (`capabilities?`) riding on the existing `ParallelTaskSpec`. Do NOT change the schema's `.max(...)` cap; `.strip()` MUST remove only the additively attached capability field and keep every pre-existing field; a spec with no capability metadata MUST still validate (empty capability set, no error).
    - Add `provision(workerId, required, taskId)` wiring in `src/core/task/runParallelTasks.ts` that, before the worker's first generation, evaluates each declared required capability through the broker/policy engine, transitions the passing ones to `active`, and records a denial outcome for each withheld capability (provisioning only the passing subset). In-execution `capability.request` for an undeclared capability still runs through the same policy path.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ParallelTasksTool.ts src/core/task/runParallelTasks.ts`.
    - _Requirements: 12.1, 12.2, 12.4, 12.5_

  - [ ]* 9.2 Write property test for provision-before-first-generation, lazy acquisition, and `.strip()` legacy validity
    - Create `src/core/capability/__tests__/parallelTaskProvisioning.spec.ts` with a faked broker and faked `ParallelTaskSpec`s.
    - **Property 12: Provisioning activates declared requirements before first generation; lazy acquisition still works** — a DAG node whose `required` set passes policy has those capabilities `active` before first generation; an undeclared capability can still move to `active` via a later `requestCapability`; a failing required capability is withheld with a recorded denial while passing ones provision (`// Feature: ..., Property 12: ...`, ≥100 runs).
    - Assert a capability-less `ParallelTaskSpec` validates under `.strip()` with an empty capability set and that `.strip()` removes only the additive field.
    - Run `npx vitest run src/core/capability/__tests__/parallelTaskProvisioning.spec.ts`.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 14.4_
    - _Properties: 12_

- [x] 10. Expose capability state through the Observatory as a read-only event
  - [x] 10.1 Add the additive capability `ObservationEvent` variant and its webview message type
    - Add `CapabilityObservationEvent` (`taskId`, `workerId`, `kind: "capability"`, `active`, `available`, `released`, `denied`, `history?`, `committedAt`) as an additive read-only `ObservationEvent` variant beside `src/services/observatory/TaskObservationService.ts`, and add the corresponding additive message type to `packages/types/src/vscode-extension-host.ts` so it rides the existing `observatoryUpdate` channel. Do NOT add any mutation path.
    - Add `buildCapabilityObservationEvent(snapshot)` producing the four sections (ACTIVE / AVAILABLE = allowed-but-not-active / RELEASED / DENIED) and the optional read-only lease `history`. If a section cannot be read or serialized, omit it, send a read-only failure message naming the affected section, and leave all worker capability/lifecycle state unchanged. On degradation (step 7.2) emit the single degraded event here.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/services/observatory/TaskObservationService.ts packages/types/src/vscode-extension-host.ts`.
    - _Requirements: 9.1, 9.2, 9.4, 9.5, 13.5_

  - [ ]* 10.2 Write webview-ui test for zero-lifecycle-side-effect capability inspection
    - Create `webview-ui/src/components/observatory/__tests__/capabilityObservation.spec.tsx` (or the nearest existing observatory test location) exercising inspection of the ACTIVE/AVAILABLE/RELEASED/DENIED sections and the lease-history view.
    - **Property 9: Inspecting capability state causes zero lifecycle mutation** — over generated inspection sequences, no mutating webview message is sent and every worker's capability/lifecycle state is identical before and after, reusing the task-observatory zero-mutation discipline (`// Feature: ..., Property 9: ...`).
    - Run `npx vitest run webview-ui/src/components/observatory/__tests__/capabilityObservation.spec.tsx` from the `webview-ui` package directory.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
    - _Properties: 9_

- [x] 11. Implement the compatibility path from existing McpHub configuration
  - [x] 11.1 Create `src/core/capability/compatibilityMode.ts` mapping legacy alwaysAllow/disabledTools to allowed capabilities
    - Implement `buildCompatibilityExposure(mcpHub)` that, for a configuration with no capability metadata, exposes exactly the capabilities whose tools are present in `McpHub` config AND absent from `disabledTools` AND present in `alwaysAllow` — reproducing the operator's pre-adoption behavior, respecting `isMcpToolAlwaysAllowed`. Reuse `McpHub` (`src/services/mcp/McpHub.ts`) metadata; do NOT fork it.
    - Implement `applyTightening(baseline, change)` that produces an exposed set which is a subset of (or equal to) the compatibility baseline; IF a change would add a capability not in the baseline, reject the tightening, retain the prior exposed set, and return an error naming the would-be-added capabilities. Tightening only ever removes exposure.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/compatibilityMode.ts`.
    - _Requirements: 4.5, 14.1, 14.2, 14.3, 14.4_

  - [ ]* 11.2 Write property test for legacy equivalence and tightening-only-removes
    - Create `src/core/capability/__tests__/compatibilityMode.spec.ts` over generated `McpHub` `alwaysAllow`/`disabledTools` fixtures.
    - **Property 14: Legacy configurations keep working through the compatibility path** — the exposed set equals the configured, non-disabled, always-allowed tools (behavior equivalent to today); any tightening change yields a subset and never adds a capability; an additive change is rejected with the prior set retained (`// Feature: ..., Property 14: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/compatibilityMode.spec.ts`.
    - _Requirements: 14.1, 14.2, 14.3, 14.4_
    - _Properties: 14_

- [x] 12. Implement context-accounting telemetry on WorkerResult
  - [x] 12.1 Add the additive `WorkerResult.capabilityTelemetry` field and the per-generation accounting computation
    - Beside the mastermind-execution-metadata `WorkerResult` type, declare `CapabilityTelemetry` (all design fields) and `WorkerResultWithCapabilityTelemetry extends WorkerResult { capabilityTelemetry?: CapabilityTelemetry }`. Do NOT modify any base `WorkerResult` field; an absent field means accounting is unreported (never zero).
    - In `src/core/capability/capabilityTelemetry.ts`, implement `computeCapabilityTelemetry(...)` that reports `toolSchemaTokensAvoided = toolSchemaTokensTotalIfAllExposed − toolSchemaTokensActive` per generation, with both operands non-negative and `toolSchemaTokensActive ≤ toolSchemaTokensTotalIfAllExposed`, plus the available/active counts, core/leased tokens, and activation/release/request/denial counts (each a non-negative integer). IF the invariant is violated, omit `capabilityTelemetry` and record an error indication without altering the primary result.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/capability/capabilityTelemetry.ts`.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 12.2 Write property test for the exact token-savings accounting invariant
    - Create `src/core/capability/__tests__/capabilityTelemetry.spec.ts`.
    - **Property 15: Token-savings accounting is exact** — over generated active sets, `toolSchemaTokensAvoided` equals total-if-all-exposed minus active, both operands non-negative with active ≤ total; when the invariant would be violated the field is omitted and an error indication recorded, leaving the primary result unchanged; an absent field reads as unreported, not zero (`// Feature: ..., Property 15: ...`, ≥100 runs).
    - Run `npx vitest run src/core/capability/__tests__/capabilityTelemetry.spec.ts`.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
    - _Properties: 15_

- [x] 13. End-to-end wiring and real-extension-host boundary smoke
  - [x] 13.1 Wire the broker into the per-worker runtime and the deploy-then-audit phase lifecycle
    - In `src/core/task/runParallelTasks.ts`, give each worker its own broker-scoped lease set, provision declared node requirements before first generation, apply the composed `McpHub` view + `disabledTools` into `SYSTEM_PROMPT` on each generation, and transition leases to `released` at their declared `tool-complete`/`phase-complete`/`task-complete` boundary so released schemas drop from the next composition. Readers reuse the `project-reader` role with the default `{ semantic.retrieve, repo.read, core }` set (optionally `git.read`). No scheduler dispatch/leasing change.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/runParallelTasks.ts`.
    - _Requirements: 1.3, 6.2, 10.1, 12.1, 12.3_

  - [ ]* 13.2 Write integration test for the deploy-then-audit worked example (phases never coexist)
    - Create `src/core/capability/__tests__/deployThenAudit.integration.spec.ts` with faked collaborators.
    - Assert that across implement→deploy→audit phases, deploy (`cluster.deploy`) and browser (`browser.inspect`/`browser.interact`) schemas never coexist in a composed surface, and each capability's schema exists only while its phase is active.
    - Run `npx vitest run src/core/capability/__tests__/deployThenAudit.integration.spec.ts`.
    - _Requirements: 1.1, 1.3, 10.1_

  - [ ]* 13.3 Write the apps/vscode-e2e boundary smoke for real released-schema absence
    - Create `apps/vscode-e2e/src/suite/capabilityBroker.test.ts` starting a multi-worker batch where concurrent workers hold different ACTIVE capability sets. Assert each worker's real outbound request carries only its leased schemas (not the full configured MCP set) across the real messaging boundary, and that a release removes the schema on the next real generation — with workers continuing independently. Keep this to high-value boundary smoke only; protocol/policy/composition detail stays at the unit/integration layers.
    - _Requirements: 1.1, 7.1, 10.1_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (`_Requirements:_`) and, where applicable, the design correctness properties (`_Properties:_`) for traceability. All 17 requirements and all 17 correctness properties are covered.
- Every addition is additive TypeScript consuming sibling contracts read-only: `WorkerResult`/`AutonomousTaskState`, `CapabilityLane`/`RoutingMetadata`, the retrieval contracts, `ObservationEvent`/`observatoryUpdate`, and `BoundedElasticScheduler`/`RouteCapability` are never redefined. `checkAutoApproval`/`AutoApprovalState` are the sole authorization authority and are not forked; `McpHub` stays the single source of concrete schemas; `SYSTEM_PROMPT`/`generatePrompt` is reused, not forked.
- The catalog, registry, policy engine, lease ledger, and composer are pure or near-pure (`McpHub`, autonomy state, relevance, and capacity are passed in) so they are unit- and property-testable; the broker performs the single `checkAutoApproval` call and all I/O.
- Property tests use `fast-check` at the package-local unit layer under `src/core/capability/__tests__/`, each tagged `// Feature: dynamic-capability-broker, Property N: ...` with ≥100 iterations. Integration tests use faked collaborators; the Observatory zero-mutation check is a `webview-ui` test; a single `apps/vscode-e2e` smoke covers only the real-extension-host boundary. Scheduler interleavings and the base `WorkerResult`/`AutonomousTaskState` contracts are cross-referenced to their owning specs, not re-tested.
- Per AGENTS.md, after editing a file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; prefer typed APIs and bracket-notation private access over `as any`. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "3.2", "3.3", "4.1", "5.1"] },
    { "id": 3, "tasks": ["3.4", "4.2", "5.2", "5.3", "8.1"] },
    { "id": 4, "tasks": ["5.4", "7.1", "8.2"] },
    { "id": 5, "tasks": ["7.2", "9.1", "10.1", "11.1", "12.1"] },
    { "id": 6, "tasks": ["7.3", "7.4", "9.2", "10.2", "11.2", "12.2", "13.1"] },
    { "id": 7, "tasks": ["13.2", "13.3"] }
  ]
}
```
