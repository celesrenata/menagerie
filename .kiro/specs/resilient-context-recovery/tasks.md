# Implementation Plan: Resilient Context Recovery

## Overview

This plan implements the thin **recovery decision layer** that threads through the two existing
recovery entry points already in the Menagerie `src/` tree — `Task.handleContextWindowExceededError()`
in `src/core/task/Task.ts` and `manageContext()` → `summarizeConversation()` — so that an over-window
transcript either converges under its `Servable_Input_Budget` in one bounded pass or terminates with a
classified `Terminal_Non_Recoverable_Error` instead of retrying forever.

Every addition is **additive** and **minimal-blast-radius**. This plan changes neither the sliding-window
algorithm, `summarizeConversation`'s LLM mechanics, the `manageContext`/`ContextManagementOptions` or
`SummarizeConversationOptions` single-`apiHandler` signatures, the `WorkerResult` base contract (owned by
`mastermind-execution-metadata`), the scheduler/self-fail mechanics (owned by `elastic-parallel-execution`),
nor OmniRoute's route→model/window mapping (owned by `omniroute.ts` / capability-lanes-routing). Sibling-spec
types (`WorkerResult`, `failParallelWorker`, `resolveOmniRouteContextWindow`, `OMNIROUTE_ROUTE_CONTEXT_WINDOWS`,
`ApiMessage`, `ApiHandler`) are consumed **read-only**.

Work proceeds bottom-up and test-first: the four pure pieces land first with package-local unit +
`fast-check` property tests written alongside each (`ServableBudget` → `convergentReduction` →
`RecoveryHandlerResolver` → `ContextRecoveryClassifier`), then the additive `RecoveryTelemetry` types,
then the additive wiring into `Task.ts` (budget-derived target replacing the fixed 75%; recovery-handler
resolution step; terminal short-circuit in `attemptApiRequest`; telemetry attach), then two integration
tests with faked collaborators. Each pure component performs no I/O (window, reserve, token counts, and
candidate handlers are passed in) so it is unit- and property-testable in isolation.

New source modules live under `src/core/task/`; new tests live under `src/core/task/__tests__/`, alongside
the existing recovery wiring in `Task.ts` they extend. Property tests use `fast-check` at the package-local
unit layer with a minimum of 100 iterations each, tagged `// Feature: resilient-context-recovery, Property N: ...`.
Integration tests use faked collaborators from `src/test-utils`; the parallel-worker self-fail/abort mechanics,
the `WorkerResult` base contract, and the OmniRoute route→window mapping are cross-referenced to the sibling
specs rather than re-tested here. No `apps/vscode-e2e` test is added because no behavior requires the real
extension host, and **no `webview-ui` test is added because this feature touches no UI** (the existing
`condenseTaskContextStarted`/`Response` webview messages are reused unchanged).

After editing any file, run the narrowest Vitest suite and
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` per AGENTS.md; suppression counts
must not increase. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Tasks

- [x] 1. Implement the pure servable-budget arithmetic
  - [x] 1.1 Create `src/core/task/servableBudget.ts` with `ServableBudgetInput` and `computeServableInputBudget`
    - Define the exported `ServableBudgetInput` interface (`servedContextWindow: number`, `outputReserve: number`), where `servedContextWindow` is the `Served_Context_Window` sourced by the caller from `resolveOmniRouteContextWindow` / `modelInfo.contextWindow` and `outputReserve` is the `Output_Reserve` sourced from `getModelMaxOutputTokens`.
    - Implement the pure `computeServableInputBudget(input)` returning `Math.max(0, input.servedContextWindow - input.outputReserve)` — the `Servable_Input_Budget`. Embed NO fixed context-window literal; the window is passed in and OmniRoute-owned. The function performs no I/O and reads no other quantity.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/servableBudget.ts`; confirm the suppression count did not increase.
    - _Requirements: 2.1, 2.4_

  - [x]* 1.2 Write property tests for the servable-budget arithmetic
    - Create `src/core/task/__tests__/servableBudget.spec.ts` with the `fast-check` import.
    - **Property 2: The servable budget is exactly the window minus the reserve** — over generated `servedContextWindow`/`outputReserve` pairs (including reserve ≥ window), `computeServableInputBudget` equals `max(0, window − reserve)` and depends on no other quantity (`// Feature: resilient-context-recovery, Property 2: ...`, ≥100 runs).
    - **Property 3: The reduction target is derived from the OmniRoute window with no hard-coded size** (budget portion) — feeding two inputs that differ only in the resolved window yields proportionally different targets, and no fixed window literal participates (`// Feature: resilient-context-recovery, Property 3: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/servableBudget.spec.ts`.
    - _Requirements: 2.1, 2.4, 4.3_
    - _Properties: 2, 3_

- [x] 2. Implement the model-free convergent (deterministic) reduction
  - [x] 2.1 Create `src/core/task/convergentReduction.ts` with the reduction input/result types and `convergentReduction`
    - Import `ApiMessage` read-only from `core/task-persistence/apiMessages`. Define `ConvergentReductionInput` (`messages: ApiMessage[]`, `currentTokens: number`, `targetTokens: number`, `countTokens: (messages: ApiMessage[]) => Promise<number>`) and `ConvergentReductionResult` (`messages`, `resultTokens`, `converged`, `prevTokens`).
    - Implement `convergentReduction(input)` as a model-free, lane-free token-counted truncation: remove oldest removable history while preserving the first task message and the two newest visible messages (matching the existing `getAdaptiveTruncationMessageCount` discipline in `src/core/context-management/index.ts`) until the counted total ≤ `targetTokens`, in a single bounded pass. It depends on no model and no Capability_Lane — `countTokens` is its only external dependency and is never an LLM call.
    - Set `converged: true` when `resultTokens ≤ targetTokens`; when the minimal irreducible transcript (first task message + two newest visible messages) still exceeds `targetTokens`, return `converged: false` with that irreducible transcript (the Req 5.1 terminal condition). Record `prevTokens` for telemetry (`Deterministic_Reduction` / `Convergent_Reduction`).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/convergentReduction.ts`.
    - _Requirements: 1.3, 2.2, 2.3, 2.5, 3.1, 3.3, 3.4_

  - [x]* 2.2 Write property tests for single-pass convergence and the irreducible-core terminal condition
    - Create `src/core/task/__tests__/convergentReduction.spec.ts` with a faked `countTokens`.
    - **Property 4: Convergent reduction reaches the budget in one bounded pass regardless of over-size ratio** — over generated over-budget transcripts (including incident-scale ratios like 360K→32K) whose irreducible core is ≤ target, `convergentReduction` produces `resultTokens ≤ targetTokens` with `converged: true` in a single bounded pass, independent of the starting `Over_Size_Ratio`, and holds whether or not a prior summarization is modeled as succeeding (`// Feature: resilient-context-recovery, Property 4: ...`, ≥100 runs).
    - Add the irreducible-core edge case: when the minimal transcript exceeds the target, the result is `converged: false` (feeds Properties 6 and 7).
    - Run `npx vitest run src/core/task/__tests__/convergentReduction.spec.ts`.
    - _Requirements: 2.2, 2.3, 2.5, 3.1, 3.3, 3.4, 5.1_
    - _Properties: 4_

- [x] 3. Implement the pure recovery-handler resolver and recovery-input bound
  - [x] 3.1 Create `src/core/task/recoveryHandlerResolver.ts` with the candidate/resolution types and `resolveRecoveryHandler`
    - Define `RecoveryHandlerCandidate` (`id: string`, `contextWindow: number`, `outputReserve: number`, `configuredLargeContextProfile: boolean`), `RecoveryHandlerResolution` (`path: "large-context" | "deterministic"`, `handlerId?: string`, `recoveryInputBound?: number`), and `RecoveryHandlerResolverInput` (`requiredRecoveryInput: number`, `candidates: readonly RecoveryHandlerCandidate[]`). The failing lane's `Served_Context_Window` is intentionally NOT part of the input.
    - Implement the pure `resolveRecoveryHandler(input)`: compute each candidate's `Recovery_Input_Bound = contextWindow − outputReserve`, keep candidates whose bound ≥ `requiredRecoveryInput` (`Large_Context_Recovery_Handler`), prefer a `configuredLargeContextProfile` candidate among those (Req 1.5) and otherwise the one with the largest bound, and return `{ path: "large-context", handlerId, recoveryInputBound }`. When no candidate qualifies, return `{ path: "deterministic" }` (Req 1.3). Never return a handler whose bound is below the required input (Req 1.4). Perform no I/O and consult no failing-lane window (Req 1.2).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/recoveryHandlerResolver.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.3, 4.4_

  - [x]* 3.2 Write property tests for window-sufficiency, lane-independence, profile preference, and the input bound
    - Create `src/core/task/__tests__/recoveryHandlerResolver.spec.ts` with the `fast-check` import.
    - **Property 1: Recovery-handler resolution is window-sufficient, lane-independent, and prefers the configured profile** — over generated candidate sets and `requiredRecoveryInput`: `large-context` is returned only when the chosen handler's bound ≥ required input; `deterministic` when none qualifies; a handler whose bound is below required input is never returned; a qualifying `configuredLargeContextProfile` is chosen; and the result is unchanged when inputs differ only in a hypothetical failing-lane window (which is not part of the input) (`// Feature: resilient-context-recovery, Property 1: ...`, ≥100 runs).
    - **Property 5: The summarizer input never exceeds the recovery handler's window** — the resolution's `recoveryInputBound` equals the chosen handler's `contextWindow − outputReserve`, so an input above the bound must be pre-reduced and an input at or below it fits (`// Feature: resilient-context-recovery, Property 5: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/recoveryHandlerResolver.spec.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4_
    - _Properties: 1, 5_

- [x] 4. Implement the terminal recovery classifier
  - [x] 4.1 Create `src/core/task/contextRecoveryClassifier.ts` with the outcome/error types and `classifyRecoveryOutcome`
    - Define the `RecoveryOutcome` union (`{ kind: "converged"; postTokens: number }` | `{ kind: "non-recoverable"; irreducibleTokens: number; budget: number }`), the exported `CONTEXT_OVERFLOW_NON_RECOVERABLE = "context-window-overflow-non-recoverable"` constant, `TerminalContextError` (`classification`, `irreducibleTokens`, `budget`, `message`), and `RetryDecision` (`retry: boolean`, `terminalError?: TerminalContextError`).
    - Implement the pure `classifyRecoveryOutcome(outcome)`: a `converged` outcome returns `{ retry: true }` (resume once under budget); a `non-recoverable` outcome returns `{ retry: false, terminalError }` where `terminalError.classification === CONTEXT_OVERFLOW_NON_RECOVERABLE`, distinct from a transient API-failure classification (Req 5.4). Perform no I/O.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/contextRecoveryClassifier.ts`.
    - _Requirements: 5.1, 5.2, 5.4_

  - [x]* 4.2 Write property tests for terminal classification and bounded halt
    - Create `src/core/task/__tests__/contextRecoveryClassifier.spec.ts` with the `fast-check` import.
    - **Property 7: A non-recoverable outcome stops retry and is classified distinctly from a transient failure** — over generated `RecoveryOutcome`s, `classifyRecoveryOutcome` returns `retry:false` with a `TerminalContextError` iff the outcome is non-recoverable; the terminal error carries `CONTEXT_OVERFLOW_NON_RECOVERABLE` (distinct from a transient classification); a converged outcome returns `retry:true` with no terminal error (`// Feature: resilient-context-recovery, Property 7: ...`, ≥100 runs).
    - **Property 6: Context-window recovery always halts — converge or terminate, never unbounded retry** — model the recovery-and-retry loop over generated over-budget transcripts composing `convergentReduction` + `classifyRecoveryOutcome`; assert it reaches, in a bounded number of steps, either resume (≤ budget) or a terminal error, and never idles above budget while reduction remains possible (`// Feature: resilient-context-recovery, Property 6: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/contextRecoveryClassifier.spec.ts`.
    - _Requirements: 3.2, 5.1, 5.2, 5.4, 5.5_
    - _Properties: 6, 7_

- [x] 5. Define RecoveryTelemetry as an additive-optional extension of WorkerResult
  - [x] 5.1 Create `src/core/task/recoveryTelemetry.ts` with the telemetry types and `WorkerResultWithRecovery`
    - Import `WorkerResult` read-only from the `mastermind-execution-metadata` types and `CONTEXT_OVERFLOW_NON_RECOVERABLE` from `./contextRecoveryClassifier`. Do NOT modify or remove any base `WorkerResult` field.
    - Define `RecoveryAttemptTelemetry` (`path: "large-context" | "deterministic"`, `handlerId?: string`, `preTokens: number`, `postTokens: number`, `terminal?: { classification: typeof CONTEXT_OVERFLOW_NON_RECOVERABLE }`), `RecoveryTelemetry` (`attempts: RecoveryAttemptTelemetry[]`), and `WorkerResultWithRecovery extends WorkerResult { recovery?: RecoveryTelemetry }` so an absent `recovery` (or absent attempt sub-field) reads as unset rather than an error.
    - Add a small typed reader helper (e.g. `readRecoveryTelemetry`) that returns `undefined` for an absent `recovery` field without throwing, mirroring the sibling `readRoutingField` discipline in `routingMetadata.ts`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/recoveryTelemetry.ts`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x]* 5.2 Write property tests for telemetry fidelity and the additive-optional round trip
    - Create `src/core/task/__tests__/recoveryTelemetry.spec.ts` with the `fast-check` import.
    - **Property 8: Telemetry faithfully records every recovery attempt and the terminal event** — over generated attempt sequences, `RecoveryTelemetry` contains exactly one record per attempt; each record's `path` matches the resolution outcome (`large-context` names a `handlerId`, `deterministic` omits it); each `postTokens ≤ preTokens` and both equal the measured sizes; a terminal declaration produces exactly one record carrying the terminal classification (`// Feature: resilient-context-recovery, Property 8: ...`, ≥100 runs).
    - **Property 9: Recovery telemetry is additive-optional on WorkerResult and never injected verbatim into the parent** — over generated base `WorkerResult`s, the value validates as `WorkerResultWithRecovery` with and without a `recovery` field (every base field preserved), reading an absent `recovery` yields unset (never throws), and a faked compacted parent view (reusing the shape produced by `compactParallelTasksResultForParent`) never contains the verbatim telemetry block (`// Feature: resilient-context-recovery, Property 9: ...`, ≥100 runs).
    - Run `npx vitest run src/core/task/__tests__/recoveryTelemetry.spec.ts`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
    - _Properties: 8, 9_

- [x] 6. Checkpoint - Ensure all pure-component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Wire the budget-derived target and recovery-handler resolution into handleContextWindowExceededError
  - [x] 7.1 Replace the fixed 75% target with a budget-derived target in `handleContextWindowExceededError`
    - In `src/core/task/Task.ts`, inside `handleContextWindowExceededError(requestModelInfo)`, compute the `Servable_Input_Budget` with `computeServableInputBudget` from the same values the method already reads — the window (`this.api.getCondenseContextWindow?.() ?? modelInfo.contextWindow`) and the `Output_Reserve` (`getModelMaxOutputTokens`) — and derive the `manageContext` reduction target from that budget instead of passing `autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT`. Preserve the method signature, the `requestModelInfo` snapshot, the `manageContext`/`ContextManagementOptions` single-`apiHandler` signature, and the `say("condense_context")`/`say("sliding_window_truncation")` reporting. Keep `convergentReduction` as the `Deterministic_Reduction` floor the flow falls through to when summarize errors or does not reach the budget.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts`.
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 7.2 Insert the additive recovery-handler resolution step on top of `getCondensingApiHandler`
    - In `src/core/task/Task.ts`, add a resolution step that seeds `RecoveryHandlerCandidate`s from `getCondensingApiHandler()`'s resolved profile plus the task's own handler (each candidate's `contextWindow`/`outputReserve` read from its resolved route/model info and `getModelMaxOutputTokens`, with `configuredLargeContextProfile` true for a configured large-context condensing profile) and calls `resolveRecoveryHandler` with `requiredRecoveryInput` set to the current transcript token count. When the result is `large-context`, run the summarize call on that handler and pre-reduce the input to `recoveryInputBound` via `convergentReduction` first; when `deterministic`, skip the summarize call and reduce to the `Servable_Input_Budget` directly. Do NOT change `getCondensingApiHandler`'s single-`ApiHandler` return contract — existing callers continue to receive exactly what they do today; only `handleContextWindowExceededError` consults the resolver's additional signal.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.4_

- [x] 8. Wire the terminal classification short-circuit and recovery telemetry
  - [x] 8.1 Short-circuit the context-window retry branch in `attemptApiRequest` on a terminal outcome
    - In `src/core/task/Task.ts`, have `handleContextWindowExceededError` surface the `RetryDecision` from `classifyRecoveryOutcome` when `convergentReduction` returns `converged: false` for the irreducible core. In the `attemptApiRequest` context-window branch (`isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES`), when the decision is `retry: false`: a non-worker task throws the classified `TerminalContextError` (auto-retry stops recursing); a parallel worker calls the existing `failParallelWorker(terminalError.message)` with a context-overflow reason so it self-fails cleanly and the batch is unblocked, rather than idling against `PARALLEL_WORKER_MAX_API_RETRIES`. Do NOT change `failParallelWorker` or the scheduler/self-fail mechanics.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 8.2 Attach RecoveryTelemetry additively to the worker result
    - In `src/core/task/Task.ts`, record one `RecoveryAttemptTelemetry` per recovery attempt (`path` and `handlerId` from the resolution, `preTokens`/`postTokens` from `convergentReduction`'s `prevTokens`/`resultTokens`, and the `terminal` classification on the attempt that declares a `Terminal_Non_Recoverable_Error`) and attach the aggregated `RecoveryTelemetry` to the worker result as the additive-optional `recovery` field (`WorkerResultWithRecovery`). Ensure the telemetry is never injected verbatim into the parent model's conversation history — the parent continues to receive only its compacted summary via the existing `compactParallelTasksResultForParent` path. Do NOT modify or remove any base `WorkerResult` field.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 9. Integration tests for the two wiring boundaries
  - [x]* 9.1 Write integration test for recovery threading through handleContextWindowExceededError/manageContext
    - Create `src/core/task/__tests__/resilientContextRecovery.integration.spec.ts` using faked collaborators from `src/test-utils` (a faked `Task` whose `getCondensingApiHandler`/`manageContext`/`countTokens` collaborators are observable, and a faked window-sufficient large-context condensing profile).
    - Assert: the budget-derived target (from `computeServableInputBudget`) replaces the fixed `FORCED_CONTEXT_REDUCTION_PERCENT` in the `manageContext` call; when a window-sufficient profile exists the resolved recovery handler (not the failing handler) carries the summarize call; when no profile is window-sufficient the deterministic `convergentReduction` path runs and converges to the `Servable_Input_Budget`. Cross-reference the OmniRoute route→window mapping to `omniroute.ts`/capability-lanes-routing instead of re-testing it.
    - Run `npx vitest run src/core/task/__tests__/resilientContextRecovery.integration.spec.ts`.
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.5_

  - [x]* 9.2 Write integration test for the terminal → failParallelWorker self-fail short-circuit
    - In `src/core/task/__tests__/resilientContextRecovery.integration.spec.ts`, fake a parallel worker whose transcript's irreducible core exceeds the budget and whose `failParallelWorker` is a spy.
    - Assert: a `Terminal_Non_Recoverable_Error` triggers `failParallelWorker` exactly once with a context-overflow reason; the context-window retry branch stops recursing (no idling against `PARALLEL_WORKER_MAX_API_RETRIES`); a non-worker task instead throws the classified terminal error. Cross-reference `elastic-parallel-execution` for the self-fail/abort mechanics rather than re-testing them.
    - Run `npx vitest run src/core/task/__tests__/resilientContextRecovery.integration.spec.ts`.
    - _Requirements: 5.2, 5.3, 5.5_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (`_Requirements:_`) and, where applicable, the design correctness properties (`_Properties:_`) for traceability. All 6 requirements and all 9 correctness properties are covered.
- Every addition is additive TypeScript threading through the two existing recovery entry points: no change to the sliding-window algorithm, `summarizeConversation` mechanics, the `manageContext`/`SummarizeConversationOptions` single-`apiHandler` signatures, the `WorkerResult` base contract, the scheduler/self-fail mechanics, or OmniRoute's route→model/window mapping. Sibling-spec types are consumed read-only.
- The four decision components (`ServableBudget`, `convergentReduction`, `RecoveryHandlerResolver`, `ContextRecoveryClassifier`) are pure or near-pure (only `convergentReduction` takes an injected `countTokens`, never an LLM call) so they are unit- and property-testable; window, reserve, token counts, and candidate handlers are passed in.
- Property tests use `fast-check` at the package-local unit layer under `src/core/task/__tests__/`, each tagged `// Feature: resilient-context-recovery, Property N: ...` with ≥100 iterations. The two integration tests use faked collaborators; the parallel-worker self-fail mechanics, the `WorkerResult` base contract, and the OmniRoute route→window mapping are cross-referenced to the sibling specs, not re-tested. No `webview-ui` test and no `apps/vscode-e2e` test are added.
- Per AGENTS.md, after editing a file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; prefer typed APIs and bracket-notation private access over `as any`. Do not create `.changeset` files or edit `CHANGELOG.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2", "4.2", "5.1"] },
    { "id": 2, "tasks": ["5.2", "7.1"] },
    { "id": 3, "tasks": ["7.2"] },
    { "id": 4, "tasks": ["8.1"] },
    { "id": 5, "tasks": ["8.2"] },
    { "id": 6, "tasks": ["9.1", "9.2"] }
  ]
}
```
