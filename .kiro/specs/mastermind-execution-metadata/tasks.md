# Implementation Plan: Mastermind Execution Metadata (FEAT-006 → FEAT-009)

## Overview

This plan implements orchestrator-intelligence cognition metadata on the native-parallel-tasks machinery under one invariant: **GLM schedules cognition; OmniRoute schedules silicon.** The work is strictly additive and backward-compatible.

Implementation is in **TypeScript** (the design specifies concrete TypeScript against `packages/types` and `src/core`).

Sequencing is test-first and bottom-up: (1) normalized reasoning enum + mapping + rank; (2) policy/result/state schemas; (3) additive `ParallelTaskSpec` fields + ownership rejection; (4) adaptive reasoning controller; (5) worker-result normalizer + bounded-parent/persistence wiring; (6) verifier role + required-verification gate + fixer loop; (7) `AutonomousTaskState` store + condensation-survival hook.

Same-file writers are separated into different waves (multiple `packages/types/src/model.ts` edits, multiple `ParallelTasksTool.ts` edits, and shared test files) to avoid write conflicts under parallel scheduling. Property tests (fast-check, ≥100 iterations) are tagged `// Feature: mastermind-execution-metadata, Property N: ...` and placed at the narrowest layer. Per AGENTS.md: fix lint in new code (no `as any`, no floating promises), run the narrowest Vitest from the owning package and `pnpm --dir <pkg> exec eslint --prune-suppressions --max-warnings=0 <file>` after edits, run `pnpm lifecycle:model-check` only if lifecycle reducers change, and do NOT create `.changeset` files.

## Tasks

- [x] 1. Normalized orchestration reasoning vocabulary (additive, in `packages/types/src/model.ts`)
  - [x] 1.1 Add the normalized orchestration enum, mapping, and rank
    - In `packages/types/src/model.ts`, add `orchestrationReasoningEfforts = ["minimal","low","medium","high","max"] as const`, `orchestrationReasoningEffortSchema = z.enum(...)`, and `OrchestrationReasoningEffort` type.
    - Add `mapNormalizedToExtended(value: OrchestrationReasoningEffort): ReasoningEffortExtended` as a total, identity-on-shared-members mapping returning a member of `reasoningEffortsExtended`.
    - Add `orchestrationReasoningRank: Record<OrchestrationReasoningEffort, number>` (`minimal:0 … max:4`) for ordering comparisons.
    - PRESERVE existing `reasoningEfforts`, `reasoningEffortsSchema`, `ReasoningEffort`, `reasoningEffortWithMinimalSchema`, `ReasoningEffortWithMinimal`, `reasoningEffortsExtended`, and `reasoningEffortExtendedSchema` members unchanged.
    - _Requirements: 1.1, 1.2, 1.4_

  - [ ]* 1.2 Write property test for normalized reasoning mapping (new file `packages/types/src/__tests__/orchestrationReasoning.property.test.ts`)
    - **Property 1: Normalized reasoning mapping is total, range-safe, and preserves existing enums**
    - Over all five normalized values assert `mapNormalizedToExtended` returns a `reasoningEffortsExtended` member; over arbitrary non-enum strings assert `orchestrationReasoningEffortSchema` rejects with an error naming `minimal, low, medium, high, max`; assert existing enum members are unchanged. fast-check, ≥100 iterations.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_ · _Properties: 1_

  - [ ]* 1.3 Write unit tests for enum membership and out-of-enum rejection (new file `packages/types/src/__tests__/orchestrationReasoning.test.ts`)
    - Assert exact enum membership, rank ordering, identity mapping on each shared member, and the descriptive rejection message content.
    - _Requirements: 1.1, 1.3, 1.4_

- [x] 2. Policy, result, and state schemas in `packages/types`
  - [x] 2.1 Add `WorkerReasoningPolicy` schema + `resolveEffortCeiling` (append to `packages/types/src/model.ts`)
    - Add `workerReasoningPriorities = ["latency","balanced","quality"] as const` and `workerReasoningPolicySchema` with required `effort`, optional `adaptive`/`maxEffort`/`priority`, and a `superRefine` rejecting `maxEffort` ranked below `effort` with a message naming both values.
    - Add `WorkerReasoningPolicy` type and `resolveEffortCeiling(policy)` returning `policy.maxEffort ?? policy.effort`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 2.2 Write property test for policy ceiling validation (new file `packages/types/src/__tests__/workerReasoningPolicy.property.test.ts`)
    - **Property 2: WorkerReasoningPolicy validation enforces the effort ceiling**
    - Over random `effort`/`maxEffort` pairs assert acceptance iff `maxEffort` absent or `rank(maxEffort) >= rank(effort)`; when `adaptive` true and `maxEffort` absent assert `resolveEffortCeiling === effort`. fast-check, ≥100 iterations.
    - _Requirements: 2.3, 2.4_ · _Properties: 2_

  - [ ]* 2.3 Write unit tests for policy optional-field shapes (new file `packages/types/src/__tests__/workerReasoningPolicy.test.ts`)
    - Assert optional-field shapes accepted, invalid `priority` rejected, and the `maxEffort < effort` message identifies both values.
    - _Requirements: 2.1, 2.2_

  - [x] 2.4 Add `evidenceReferenceSchema`, `findingSchema`, and `workerResultSchema` (append to `packages/types/src/model.ts`)
    - Add `evidenceReferenceSchema` (`type` enum file/test/command/url/screenshot, `reference`, optional `lines` tuple, optional `result`), `findingSchema` (`claim`, optional `confidence`), and `workerResultSchema` (`status` enum, `summary`, `findings`/`evidence`/`changes`/`tests`/`blockers`/`artifacts` arrays, optional `reasoning` telemetry object with `requested`/`used`/`escalations`).
    - Export `WorkerResult`, `EvidenceReference`, `Finding` types.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 2.5 Write unit tests for WorkerResult/evidence/finding shapes (new file `packages/types/src/__tests__/workerResultSchema.test.ts`)
    - Assert `status` enum, array field presence, `findings`/`evidence` entry shapes, and optional `reasoning` telemetry shape.
    - _Requirements: 7.1, 7.3, 7.4, 7.5_

  - [x] 2.6 Add `verificationPolicySchema`, `TaskKind`, and `defaultVerificationFor` (append to `packages/types/src/model.ts`)
    - Add `verificationPolicySchema` (`required` boolean, optional `mode`, optional `criteria` string array), `VerificationPolicy` type, `TaskKind` union, and `defaultVerificationFor(kind)` returning `read-only→optional`, `code-modification→recommended`, `deployment→required`, `migration-destructive→required`.
    - _Requirements: 9.1, 10.1, 10.2, 10.3, 10.4_

  - [ ]* 2.7 Write unit tests for verification policy and default table (new file `packages/types/src/__tests__/verificationPolicy.test.ts`)
    - Assert policy shape (required/mode/criteria) and the `defaultVerificationFor` kind→policy mapping for all four kinds.
    - _Requirements: 9.1, 10.1, 10.2, 10.3, 10.4_

  - [x] 2.8 Add `autonomousTaskStateSchema` (append to `packages/types/src/model.ts`)
    - Add `autonomousTaskStateSchema` with `objective`, string arrays `constraints`/`decisions`/`assumptions`/`activeWork`/`completedWork`/`filesTouched`/`blockers`/`openQuestions`/`nextActions`, and `evidence` reusing `evidenceReferenceSchema`. Export `AutonomousTaskState` type.
    - _Requirements: 13.1, 13.2_

  - [ ]* 2.9 Write unit tests for AutonomousTaskState shape (new file `packages/types/src/__tests__/autonomousTaskState.test.ts`)
    - Assert all fields present and `evidence` reuses the shared evidence-reference shape.
    - _Requirements: 13.1, 13.2_

- [x] 3. Checkpoint - Ensure all `packages/types` tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Additive `ParallelTaskSpec` fields and ownership rejection (`src/core/tools/ParallelTasksTool.ts`)
  - [x] 4.1 Add optional `reasoning` and `verification` fields to `parallelTaskSpecSchema`
    - Extend `parallelTaskSpecSchema` with optional `reasoning: workerReasoningPolicySchema` and `verification: verificationPolicySchema`, importing both from `packages/types`.
    - PRESERVE `.strip()`, the existing `name`/`mode`/`message`/`todos`/`route` fields and bounds, the 1–4 cap in `parallelTasksSchema`, and the unique-name refinement.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 9.1, 9.2_

  - [x] 4.2 Add mastermind-originated physical-placement rejection
    - In `ParallelTasksTool.ts`, add a guard that rejects any mastermind-originated selection of GPU/VRAM/CUDA device/provider thinking tokens/physical node when no user `route` override is present, surfaced through the existing `formatParallelTasksArgumentError` recoverable path with a cognition-vs-silicon message; a supplied `route` passes through verbatim.
    - _Requirements: 4.1, 4.3, 4.4, 15.1, 15.3_

  - [ ]* 4.3 Write unit tests for additive-field acceptance and compat bounds (new file `src/core/tools/__tests__/parallelTaskSpec.reasoning.test.ts`)
    - Assert specs accept/omit `reasoning` and `verification`, `.strip()` drops stray keys, legacy five-field specs still validate, and the 1–4 cap plus unique-name refinement are unchanged.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 9.1, 9.2_

  - [ ]* 4.4 Write property test for ownership rejection (new file `src/core/tools/__tests__/parallelTaskSpec.ownership.property.test.ts`)
    - **Property 8: The mastermind cannot select physical placement without a user route override**
    - Over random specs with/without placement keys and route overrides, assert placement keys without a route override are rejected, the carried envelope has no provider/model-capability keys, and a route override is forwarded verbatim. fast-check, ≥100 iterations.
    - _Requirements: 4.1, 4.3, 4.4, 15.1, 15.3_ · _Properties: 8_

- [x] 5. Adaptive reasoning controller (worker runtime, new file `src/core/task/AdaptiveReasoningController.ts`)
  - [x] 5.1 Implement `AdaptiveReasoningController` and telemetry
    - Create `AdaptiveReasoningController` holding `applied` starting at `policy.effort`; `escalate(trigger)` bumps one rank toward `resolveEffortCeiling(policy)` without exceeding it, holds steady when `adaptive` is false/unset, and counts effort-changing escalations; `telemetry()` returns `{ requested: policy.effort, used: highest applied, escalations }`. Define `EscalationTrigger` union.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 16.1, 16.2, 16.3_

  - [ ]* 5.2 Write property test for adaptive escalation + telemetry (new file `src/core/task/__tests__/AdaptiveReasoningController.property.test.ts`)
    - **Property 3: Adaptive reasoning stays within the ceiling and telemetry is faithful**
    - Over random trigger sequences assert applied starts at requested, is non-decreasing, never exceeds the resolved ceiling (= requested when adaptive off/unset), and telemetry `requested == effort`, `used == highest applied`, `escalations == non-negative effort-changing count`. fast-check, ≥100 iterations.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 16.1, 16.2, 16.3_ · _Properties: 3_

  - [ ]* 5.3 Write unit tests for adaptive-off hold and ceiling clamp (new file `src/core/task/__tests__/AdaptiveReasoningController.test.ts`)
    - Assert the Req 5.1 example (`medium`/adaptive/`high`) begins at `medium`, escalation stops at the ceiling, and adaptive-off holds at `effort`.
    - _Requirements: 5.1, 5.3, 5.4_

- [x] 6. Worker result normalizer and bounded-parent/persistence wiring
  - [x] 6.1 Implement `normalizeWorkerResult` (new file `src/core/task/normalizeWorkerResult.ts`)
    - Implement `normalizeWorkerResult(raw, { workerName })` that parses and defaults conforming output (absent arrays → `[]`) and converts non-conforming output into a schema-valid `WorkerResult` with `status: "failed"` and a non-empty descriptive `summary` referencing the raw output. Never throws.
    - _Requirements: 7.2, 7.6_

  - [ ]* 6.2 Write property test for normalization (new file `src/core/task/__tests__/normalizeWorkerResult.property.test.ts`)
    - **Property 5: Non-conforming worker output normalizes to a conforming failed result**
    - Over arbitrary raw outputs assert the result is always schema-valid and non-conforming inputs yield `status: "failed"` with non-empty `summary`. fast-check, ≥100 iterations.
    - _Requirements: 7.2, 7.6_ · _Properties: 5_

  - [x] 6.3 Wire normalized `WorkerResult` through persistence and the attempt_completion capture
    - In the worker-result layer (`src/core/task/runParallelTasks.ts` and the `attempt_completion` capture in `src/core/tools/AttemptCompletionTool.ts`), run `normalizeWorkerResult` over the completion output, serialize the full `WorkerResult` into the worker record and manifest, and route the serialized string through the existing `result` channel so `compactParallelTasksResultForParent` clips it. Do NOT add a new parent-injection path.
    - _Requirements: 6.1, 6.2, 7.1, 8.1, 8.2, 8.3_

  - [ ]* 6.4 Write property test for bounded-parent + full persistence (new file `src/core/tools/__tests__/compactParallelTasksResult.property.test.ts`)
    - **Property 4: Parent always receives a bounded conforming result while the full result persists**
    - Over random (including oversized) results assert full persisted length equals original, parent length within `MAX_WORKER_PARENT_RESULT_CHARS` (or `MAX_READER_PARENT_RESULT_CHARS` for reader workers) and `MAX_WORKER_PARENT_ERROR_CHARS`, and the manifest reference is present when clipped. fast-check, ≥100 iterations.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 8.1, 8.2_ · _Properties: 4_

  - [ ]* 6.5 Write unit tests for bound-preservation regression (new file `src/core/tools/__tests__/compactParallelTasksResult.bounds.test.ts`)
    - Assert `MAX_WORKER_PARENT_RESULT_CHARS`/`MAX_WORKER_PARENT_ERROR_CHARS`/reader-bound values and clip-with-manifest behavior are unchanged by this feature.
    - _Requirements: 6.4_

- [x] 7. Checkpoint - Ensure reasoning, normalization, and wiring tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Verifier role, required-verification gate, and fixer loop
  - [x] 8.1 Implement verifier scheduling and the required-verification gate (new file `src/core/task/verificationGate.ts`)
    - When `verification.required` is true, schedule an independent verifier worker role (distinct runtime from the implementer); gate parent PASS on verifier criteria passing, otherwise report not-successfully-verified. Prefer expressing the gate as orchestration sequencing over existing worker-terminal states rather than a new lifecycle status.
    - _Requirements: 9.3, 11.1, 11.3, 11.4, 12.2, 12.3_

  - [x] 8.2 Implement verifier criteria evaluation and compact evidence list
    - Produce a `WorkerResult` whose `evidence` array carries exactly one pass/fail entry per supplied criterion, in criterion order (not a transcript).
    - _Requirements: 12.1, 12.4_

  - [x] 8.3 Implement the fixer loop on verifier FAIL
    - On verifier FAIL, schedule a fixer worker followed by a verifier re-run; treat verifier scheduling as a cognition role within the batch, never a GPU/placement concern.
    - _Requirements: 11.2, 11.4_

  - [x] 8.4 Add lifecycle transition only if unavoidable (`src/core/task-persistence/taskLifecycle.ts`)
    - ONLY if the gate cannot be represented by existing worker-terminal states: read `docs/architecture/task-lifecycle-model.md` first, add the verifier/fixer transition to the shared reducers with updated model actions/invariants/landmarks, then run `pnpm lifecycle:model-check`. If sequencing over existing terminal states suffices, make no reducer change and note that in the implementation.
    - _Requirements: 11.1, 11.2_

  - [ ]* 8.5 Write property test for the verification gate (new file `src/core/task/__tests__/verificationGate.property.test.ts`)
    - **Property 6: Required verification gates success through an independent verifier**
    - Over random implementer/verifier/fixer outcomes and criteria lists assert verifier is distinct from implementer, PASS to parent iff verifier passed, FAIL routes fixer→verifier re-run, and one pass/fail evidence entry per criterion in order. fast-check, ≥100 iterations.
    - _Requirements: 9.3, 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4_ · _Properties: 6_

  - [ ]* 8.6 Write lifecycle E2E for verifier-transition restart visibility (only if 8.4 added a transition) (`apps/vscode-e2e`)
    - ONLY if a new reducer transition was introduced: add extension-host E2E asserting an interrupted implementer→verifier batch is not auto-resumed after a restart (a reducer-unprovable boundary). Otherwise skip. Run `pnpm test` and focused lifecycle tests.
    - _Requirements: 11.1, 11.2_

- [x] 9. AutonomousTaskState store, merge, and condensation-survival hook (`src/core/task`)
  - [x] 9.1 Implement the AutonomousTaskState store and `applyWorkerResult` (new file `src/core/task/autonomousTaskState.ts`)
    - Store `AutonomousTaskState` on the `Task` out-of-band from `apiConversationHistory`; implement `applyWorkerResult(state, result)` merging reported findings/changes/blockers/evidence into the corresponding fields, and read it as the authoritative task-state source.
    - _Requirements: 13.1, 13.2, 13.3, 14.3_

  - [ ]* 9.2 Write unit tests for `applyWorkerResult` merge accumulation (new file `src/core/task/__tests__/autonomousTaskState.test.ts`)
    - Assert findings/changes/blockers/evidence accumulate into the correct fields across successive worker results.
    - _Requirements: 13.3_

  - [x] 9.3 Implement `preserveAutonomousTaskState` hook across `condenseContext` (`src/core/task/Task.ts`)
    - Add a `preserveAutonomousTaskState` capture point so `condenseContext` summarizes transcript messages without reading, rewriting, or dropping the state object; a read after condensation returns the preserved object.
    - _Requirements: 14.1, 14.2, 14.3_

  - [ ]* 9.4 Write property test for condensation survival (new file `src/core/task/__tests__/autonomousTaskState.condense.property.test.ts`)
    - **Property 7: AutonomousTaskState survives condensation**
    - Over random states and transcript mutations assert read-after-condense equals pre-condense state. fast-check, ≥100 iterations. Reuse `src/test-utils` for Task/stream setup.
    - _Requirements: 14.1, 14.2, 14.3_ · _Properties: 7_

- [x] 10. OmniRoute boundary cognition-metadata forwarding
  - [x] 10.1 Carry normalized cognition intent to the OmniRoute boundary
    - Forward normalized reasoning intent, priority, verification policy, and execution intent to the OmniRoute boundary as cognition metadata via `mapNormalizedToExtended`, with no local provider/model-capability translation and no placement resolution.
    - _Requirements: 4.1, 4.2, 15.1, 15.2_

  - [ ]* 10.2 Write boundary/integration test for translation ownership (new file `src/core/task/__tests__/omniRouteBoundary.integration.test.ts`)
    - With 1–3 representative examples at the boundary stub, assert the carried envelope holds only normalized cognition fields and that provider/model-capability translation is OmniRoute's responsibility (not performed locally).
    - _Requirements: 4.1, 4.2, 15.1, 15.2_

- [x] 11. Final checkpoint - Ensure all tests pass and suppressions did not increase
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (unit, property, integration, and E2E tests) and may be skipped for a faster MVP; core implementation tasks are never optional.
- Every task references specific requirements; property-test tasks also reference the design property they validate.
- Property tests use fast-check with ≥100 iterations and are tagged `// Feature: mastermind-execution-metadata, Property N: ...` per AGENTS.md.
- All changes are additive and backward-compatible: existing reasoning enums, `ParallelTaskSpec` fields, the 1–4 cap, unique-name refinement, and `compactParallelTasksResultForParent` bounds are preserved.
- Same-file writers are placed in separate waves below: `packages/types/src/model.ts` edits (1.1 → 2.1 → 2.4 → 2.6 → 2.8), `ParallelTasksTool.ts` edits (4.1 → 4.2), and shared test files are serialized.
- Prefer expressing the verification gate as orchestration sequencing over existing terminal states; introduce a lifecycle transition (and `pnpm lifecycle:model-check` + E2E) only if unavoidable (tasks 8.4, 8.6).
- After editing a file, run the narrowest Vitest from the owning package and `pnpm --dir <pkg> exec eslint --prune-suppressions --max-warnings=0 <file>`; do NOT create `.changeset` files.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6"] },
    { "id": 4, "tasks": ["2.7", "2.8"] },
    { "id": 5, "tasks": ["2.9", "4.1", "5.1"] },
    { "id": 6, "tasks": ["4.2", "5.2", "5.3", "6.1"] },
    { "id": 7, "tasks": ["4.3", "6.2", "6.3"] },
    { "id": 8, "tasks": ["4.4", "6.4", "6.5", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3", "9.1"] },
    { "id": 10, "tasks": ["8.4", "9.2", "9.3", "10.1"] },
    { "id": 11, "tasks": ["8.5", "8.6", "9.4", "10.2"] }
  ]
}
```
