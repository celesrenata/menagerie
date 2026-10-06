# Implementation Plan: Semantic-First Retrieval (FEAT-004)

## Overview

Convert the ExplorationPolicy design into incremental, test-first coding steps for the
extension-host runtime. The work is strictly additive: it builds a pure advisory decision
component plus supporting state/output/metrics mechanisms, routes semantic retrieval through a
`RetrievalGatewayClient`, and hooks the policy into `presentAssistantMessage` after
`validateToolUse` passes — never blocking a tool call. The existing `CodebaseSearchTool` contract
(`codebase_search_result` via `task.say`, `pushToolResult`) is preserved; compact surfacing is
additive.

Implementation proceeds bottom-up: shared types first, then the pure decision core
(`ExplorationPolicy.decide`, `IndexAvailabilitySnapshot` derivation, `KnownTargetDetector`), then
the gateway client, per-task state (cache + shared memory + metrics), the output budget,
change-aware ordering, worker bootstrap and reader-swarm packet delivery, and finally the dispatch
hook wiring in `presentAssistantMessage.ts` and metrics wiring. Each step builds on the previous and
ends by integrating into the dispatch flow with no orphaned code.

New runtime code lives under `src/core/exploration/` with tests in
`src/core/exploration/__tests__/`. The six correctness properties are each a single fast-check
property test (≥100 iterations) tagged `// Feature: semantic-first-retrieval, Property N: ...`.
Language: TypeScript (matches the design and the surrounding `src` package). Tests run under Vitest
(`test:core` suite).

## Tasks

- [x] 1. Establish shared types, constants, and property-test tooling
  - [x] 1.1 Define shared types and the packet-size constant
    - Create `src/core/exploration/types.ts` with `IndexAvailabilitySnapshot` (four getters +
      `state: IndexingState` + derived `readonly available`), `KnownTargetResult`,
      `ExplorationPolicyInputs`, `ExplorationOutcome`, `ExplorationDecision` (with `blocks: false`
      invariant and optional `metricEvent`), `ExplorationAffordance`, `SemanticFinding`,
      `EvidenceItem`, `EvidencePacket`, `RetrievalIntent`, `SurfacedEvidence`, and `RetrievalMetrics`
    - Export `export const MAX_EVIDENCE_PACKET_ITEMS = 8`
    - Reuse the existing `IndexingState` union from `src/services/code-index` rather than redeclaring it
    - _Requirements: 1.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.2, 11.1, 12.1_

  - [x] 1.2 Add fast-check as a dev dependency and a property-test helper
    - Add `fast-check` to `devDependencies` in `src/package.json`
    - Create `src/core/exploration/__tests__/arbitraries.ts` exporting fast-check arbitraries for
      `IndexAvailabilitySnapshot` (all four getters + every `IndexingState`), `KnownTargetResult`
      (present/absent across the three sources), `ExplorationPolicyInputs`, `EvidencePacket`
      (including over-bound item counts and arbitrary `fresh`/`score`), and query/finding seeds
    - _Requirements: 1.1, 4.1, 5.1, 6.1, 8.2, 12.1_

- [x] 2. Pure decision core: ExplorationPolicy, availability snapshot, known-target detection
  - [x] 2.1 Derive `IndexAvailabilitySnapshot` from `CodeIndexManager`
    - Create `src/core/exploration/indexAvailability.ts` with a pure
      `deriveIndexAvailability(managerLike): IndexAvailabilitySnapshot` where
      `available = isConfigurationLoaded && isFeatureEnabled && isFeatureConfigured && isInitialized && state !== "Indexing"`
    - Accept a minimal structural input (the four getters + `state`) so it stays testable without the
      real manager
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x]* 2.2 Unit test the availability mapping
    - Create `src/core/exploration/__tests__/indexAvailability.spec.ts`
    - One example row per false getter and the `Indexing` state yielding `available: false`;
      all-true + non-`Indexing` state yielding `available: true`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 2.3 Implement `KnownTargetDetector.detect`
    - Create `src/core/exploration/knownTargetDetector.ts` detecting an exact path from a user
      instruction, a `path:line` diagnostic, or a worker-held path; return `{ present: false }` when
      detection is ambiguous or throws
    - _Requirements: 3.2, 3.3, 3.4_

  - [x]* 2.4 Unit test known-target detection sources
    - Create `src/core/exploration/__tests__/knownTargetDetector.spec.ts`
    - Cover each of the three sources, the `path:line` parse, and safe-degrade-to-absent on
      ambiguous/throwing input
    - _Requirements: 3.2, 3.3, 3.4_

  - [x] 2.5 Implement pure `ExplorationPolicy.decide` and `affordancesFor`
    - Create `src/core/exploration/explorationPolicy.ts` with the biconditional:
      `PreferSemantic` iff `indexAvailability.available && gatewayAvailable && exploringUnseenArea && !knownTarget.present`;
      `KnownTarget` when `knownTarget.present` (with `requiresRetrieveBeforeRead: false`);
      `AllowWalking` otherwise; always `blocks: false`
    - Set `metricEvent` to `index-unavailable` / `gateway-unavailable` as applicable; implement
      `affordancesFor` to order affordances per the decision (semantic_retrieval / known_target_read /
      broad_walking)
    - No prompt text, no I/O
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 3.1, 4.6, 4.7, 8.5, 9.3_

  - [x]* 2.6 Write property test for Property 1
    - `src/core/exploration/__tests__/explorationPolicy.property.spec.ts`
    - **Property 1: Preference holds exactly when all conditions and the gateway align**
    - Assert `PreferSemantic` iff all four conditions hold, and `blocks === false` in every outcome
    - **Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.3, 4.6**
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.3, 4.6_

  - [x]* 2.7 Write property test for Property 2
    - `src/core/exploration/__tests__/explorationPolicyFallback.property.spec.ts`
    - **Property 2: Unavailability and failed conditions allow walking without blocking and record the right metric**
    - Assert walking is allowed, never blocks, and the correct `index-unavailable` /
      `gateway-unavailable` metric event is set
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8.5**
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8.5_

  - [x]* 2.8 Write property test for Property 3
    - `src/core/exploration/__tests__/knownTargetBypass.property.spec.ts`
    - **Property 3: A known target is read directly without a prior retrieve**
    - Assert a detected target (any of the three sources) yields `KnownTarget` with
      `requiresRetrieveBeforeRead: false` and no `retrieve()` invocation
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 9.3**
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 9.3_

- [x] 3. Checkpoint - pure core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. RetrievalGatewayClient
  - [x] 4.1 Define the `RetrievalGatewayClient` interface and a thin client
    - Create `src/core/exploration/retrievalGatewayClient.ts` with
      `retrieve(query, workspace, intent, limit): Promise<EvidencePacket>` and
      `isAvailable(): Promise<boolean>`; expose no node/replica selection
    - Treat a rejecting `retrieve` or `isAvailable() === false` as gateway-unavailable; drop malformed
      items (missing `file`/`startLine`/`endLine`/`score`) when normalizing a packet
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 4.2 Unit test gateway client signature and failure handling
    - Create `src/core/exploration/__tests__/retrievalGatewayClient.spec.ts`
    - Assert `retrieve` exposes no node/replica parameter, malformed items are dropped, and a rejected
      call surfaces as unavailable (never throws to the caller)
    - _Requirements: 8.1, 8.3, 8.5_

- [x] 5. Per-task state: cache, shared memory, metrics
  - [x] 5.1 Implement `SemanticExplorationCache` and `SharedRetrievalMemory`
    - Create `src/core/exploration/semanticExplorationState.ts` with a per-task `cache`
      (normalized-query → `SemanticFinding[]`), a cross-worker `sharedMemory` carrying only
      `SemanticFinding` fields (no chat transcript), and a `SemanticExplorationState` container
    - _Requirements: 5.1, 5.3, 11.1, 11.2, 11.3_

  - [x]* 5.2 Unit test cache scoping and shared-memory visibility
    - Create `src/core/exploration/__tests__/semanticExplorationState.spec.ts`
    - Two task states do not share cache entries (5.3); findings published by one worker are readable
      by a sibling and the mastermind within the same task and carry only `SemanticFinding` fields
      (11.2, 11.3)
    - _Requirements: 5.3, 11.1, 11.2, 11.3_

  - [x] 5.3 Implement `RetrievalMetricsRecorder` and `snapshot()`
    - Create `src/core/exploration/retrievalMetricsRecorder.ts` with all recorder methods
      (`recordSemanticQuery`, `recordUsefulHit`, `recordFilesReturned`, `recordFileOpened`,
      `recordRawRead`, `recordTokensFromReads`, `recordQueriesReused`, `recordIndexUnavailable`,
      `recordGatewayUnavailable`, `recordIndexFreshnessMiss`, `markFirstUsefulEvidence`) and a
      `snapshot(): RetrievalMetrics` computing `semanticHitRate` and
      `pctRawReadsPrecededByUsefulHit` in `[0,1]`; wrap recording so an error never affects callers
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_

  - [x]* 5.4 Unit test derived-metric consistency
    - Create `src/core/exploration/__tests__/retrievalMetricsRecorder.spec.ts`
    - Assert counters are monotonic and derived ratios stay in `[0,1]`, including the zero-query edge
    - _Requirements: 7.2, 7.9_

  - [x] 5.5 Wire cache/shared-memory reuse short-circuit into the policy flow
    - Add a reuse check (used before issuing `retrieve()`) in `explorationPolicy.ts` (or a thin
      coordinator module) that, on a cache/shared-memory hit for a concept, returns the stored
      findings, issues no gateway call, and records a `queries-reused` event
    - _Requirements: 5.2, 5.4, 11.4_

  - [x]* 5.6 Write property test for Property 4
    - `src/core/exploration/__tests__/reuse.property.spec.ts`
    - **Property 4: A concept already in the cache or shared memory reuses prior findings instead of a new retrieve**
    - Use a spied `RetrievalGatewayClient`; assert a populated cache/shared-memory returns stored
      findings, invokes no new `retrieve()`, and records `queries-reused`
    - **Validates: Requirements 5.1, 5.2, 5.4, 11.1, 11.3, 11.4**
    - _Requirements: 5.1, 5.2, 5.4, 11.1, 11.3, 11.4_

- [x] 6. Checkpoint - state and metrics
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Output budget and change-aware ordering
  - [x] 7.1 Implement `RetrievalOutputBudget`
    - Create `src/core/exploration/retrievalOutputBudget.ts` with
      `surfaceToParent(packet): ReadonlyArray<SurfacedEvidence>` (file, line range, score, one-line
      reason only; truncate to `MAX_EVIDENCE_PACKET_ITEMS`) and
      `retainWorkerLocal(packet)` keeping large snippets out of the parent context
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 8.2, 10.2_

  - [x]* 7.2 Write property test for Property 5
    - `src/core/exploration/__tests__/outputBudget.property.spec.ts`
    - **Property 5: The consumed packet is bounded and the parent context never receives the full candidate set**
    - Assert the consumed packet has ≤ `MAX_EVIDENCE_PACKET_ITEMS` items and surfaced entries contain
      only file/line-range/score/one-line-reason (no large chunks)
    - **Validates: Requirements 6.1, 6.2, 6.3, 8.2, 10.2**
    - _Requirements: 6.1, 6.2, 6.3, 8.2, 10.2_

  - [x] 7.3 Implement `Change_Aware_Preference` ordering
    - Create `src/core/exploration/changeAwarePreference.ts` applying a Menagerie-side ordering that
      never ranks a stale item above a current/changed item, honors a gateway-supplied `fresh`
      signal, and records an `index-freshness-miss` when a currently-changed file is absent from the
      consumed evidence
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x]* 7.4 Write property test for Property 6
    - `src/core/exploration/__tests__/changeAwarePreference.property.spec.ts`
    - **Property 6: A current changed file is not silently outranked by a stale index result**
    - Generate packets + currently-changed file sets; assert ordering never places stale above
      current/changed, honors `fresh`, and records `index-freshness-miss` on a missed changed file
    - **Validates: Requirements 12.1, 12.2, 12.4**
    - _Requirements: 12.1, 12.2, 12.4_

- [x] 8. Worker bootstrap and reader-swarm packet delivery
  - [x] 8.1 Implement worker bootstrap retrieval gating and seeding
    - Create `src/core/exploration/workerBootstrapRetrieval.ts`: bootstrap iff
      `enabled && readerOrReasonerStarting && !knownTarget`; on true, perform one `retrieve()` and
      seed the worker's initial context with the bounded packet; configurable; skipped on known target
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x]* 8.2 Unit test bootstrap gating
    - Create `src/core/exploration/__tests__/workerBootstrapRetrieval.spec.ts`
    - Assert exactly one `retrieve()` + context seeding when gated true; skipped (no `retrieve()`) on
      known target or when disabled
    - _Requirements: 9.1, 9.3, 9.4_

  - [x] 8.3 Implement reader-swarm per-scope packet delivery
    - Create `src/core/exploration/readerSwarmPacket.ts` delivering one bounded `EvidencePacket` per
      reader scope via `retrieve(..., "reader_scope", ...)` before targeted investigation; swarm
      scheduling stays owned by elastic-parallel-execution
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x]* 8.4 Integration test reader-swarm packet delivery
    - Create `src/core/exploration/__tests__/readerSwarmPacket.integration.spec.ts` with a faked
      `RetrievalGatewayClient` spy
    - Assert each scope receives exactly one bounded packet before investigation; scheduling itself is
      not exercised
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 9. Checkpoint - budget, change-aware, worker flows
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Dispatch hook wiring and gateway routing
  - [x] 10.1 Attach `SemanticExplorationState` to the task
    - In `src/core/task/Task.ts`, create and expose a per-task `SemanticExplorationState` (cache +
      shared memory + metrics) using the existing structured per-task state mechanism so it survives
      across turns
    - _Requirements: 5.3, 7.1, 11.1_

  - [x] 10.2 Hook `ExplorationPolicy.decide` into `presentAssistantMessage`
    - In `src/core/assistant-message/presentAssistantMessage.ts`, after `validateToolUse` passes and
      usage is recorded, assemble `ExplorationPolicyInputs` from the live `CodeIndexManager` snapshot
      (via `CodeIndexManagerRegistry`), gateway health, `KnownTargetDetector`, and the
      exploring-unseen signal, then call `policy.decide(...)`; use the result advisorily and always
      proceed with the model's chosen tool (never block)
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.3, 4.6_

  - [x]* 10.3 Integration test the advisory hook never blocks
    - Create `src/core/assistant-message/__tests__/presentAssistantMessage-exploration-policy.spec.ts`
      with faked `CodeIndexManager` states and a faked gateway
    - Assert dispatch proceeds for every outcome (`PreferSemantic`/`KnownTarget`/`AllowWalking`) and
      the policy never short-circuits the chosen tool
    - _Requirements: 1.4, 4.6_

  - [x] 10.4 Route `PreferSemantic` retrieval through the gateway while preserving the tool contract
    - On a `PreferSemantic` decision, obtain evidence via `RetrievalGatewayClient.retrieve(...)` and
      surface it through `RetrievalOutputBudget`; keep `CodebaseSearchTool.execute` emitting
      `codebase_search_result` via `task.say` and the `Query: …` `pushToolResult` unchanged (compact
      surfacing is additive)
    - _Requirements: 6.5, 8.1, 8.2, 8.4_

  - [x]* 10.5 Integration test gateway routing and contract preservation
    - Create `src/core/exploration/__tests__/gatewayRouting.integration.spec.ts` with a faked
      `RetrievalGatewayClient` spy, a faked `Task`, and faked `CodeIndexManager` states
    - Assert a `PreferSemantic` decision calls `retrieve()` (never a raw per-replica path), an
      unavailable gateway falls through to walking and records the metric, and
      `CodebaseSearchTool.execute` still emits `codebase_search_result` + `pushToolResult`
    - Keep `src/core/tools/__tests__/CodebaseSearchTool.spec.ts` passing unchanged
    - _Requirements: 6.5, 8.1, 8.5_

- [x] 11. Metrics wiring
  - [x] 11.1 Wire metric recording across the exploration flow
    - In `presentAssistantMessage.ts` and the exploration modules, record semantic queries, useful
      hits, files returned/opened, raw reads (with `precededByUsefulHit`), tokens from reads,
      queries-reused, index-unavailable, gateway-unavailable, index-freshness-miss, and
      time-to-first-useful-evidence through the per-task `RetrievalMetricsRecorder`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_

  - [x]* 11.2 Integration test end-to-end metric emission
    - Create `src/core/exploration/__tests__/metricsWiring.integration.spec.ts`
    - Drive a short exploration sequence through faked boundaries and assert the per-task
      `snapshot()` reflects the recorded events, including index/gateway/freshness events
    - _Requirements: 7.8, 7.9, 7.10, 7.11_

- [x] 12. Final checkpoint - full suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (unit / property / integration tests) and can be skipped for a
  faster MVP; core implementation tasks are never optional.
- Property tests use fast-check, run ≥100 iterations, and carry the
  `// Feature: semantic-first-retrieval, Property N: ...` tag required by the design.
- All exploration logic is pure extension-host runtime; no `apps/vscode-e2e` test is added. Faked
  `RetrievalGatewayClient` and faked `CodeIndexManager` states cover gateway routing and fallback.
- The `CodebaseSearchTool` contract is preserved; compact surfacing is additive (Req 6.5).
- After editing a file, run the narrowest Vitest suite (`pnpm --dir src test:core` for exploration
  and dispatch, `pnpm --dir src test:services` for code-index-adjacent changes) and
  `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`; suppression counts must
  not increase.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.3", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.5", "4.2", "5.1", "5.3"] },
    { "id": 3, "tasks": ["2.6", "2.7", "2.8", "5.2", "5.4", "5.5", "7.1", "7.3", "8.1", "8.3"] },
    { "id": 4, "tasks": ["5.6", "7.2", "7.4", "8.2", "8.4", "10.1"] },
    { "id": 5, "tasks": ["10.2"] },
    { "id": 6, "tasks": ["10.4"] },
    { "id": 7, "tasks": ["10.3", "10.5", "11.1"] },
    { "id": 8, "tasks": ["11.2"] }
  ]
}
```
