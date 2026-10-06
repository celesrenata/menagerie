# Implementation Plan: Progress-Aware Loop Detection

## Overview

This plan implements the `ProgressAwareLoopDetector` that replaces the exact-repetition `ToolRepetitionDetector` with a progress-aware, state-aware detector. Work proceeds bottom-up and test-first: pure helpers (normalized args hash, cursor/target extraction, band mapping) land first with their property tests, then signal derivation, then the detector class with the two-call protocol and scoring, then metrics, then the call-site wiring, and finally the migration/rewrite of the existing spec.

All code is TypeScript in the VS Code extension (`src/`). The detector preserves the `ToolRepetitionCheckResult` discriminated union so the sole runtime call site (`src/core/assistant-message/presentAssistantMessage.ts`) keeps its `allowExecution`/`nudge`/`askUser` branching. The class is renamed with a compatibility export preserving `ToolRepetitionCheckResult` and a `ToolRepetitionDetector` alias.

Property tests use `fast-check` at the package-local unit layer under `src/core/tools/__tests__/`, tagged `// Feature: progress-aware-loop-detection, Property N: ...`, with a minimum of 100 iterations each. No e2e is required — the logic depends on neither the extension host nor the webview.

After editing any file, run the narrowest Vitest suite and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` per AGENTS.md; suppression counts must not increase.

## Tasks

- [x] 1. Scaffold the detector module with the preserved contract and core type definitions
  - [x] 1.1 Create `src/core/tools/ProgressAwareLoopDetector.ts` with types and the preserved result contract
    - Create the new module importing `safe-stable-stringify`, `ToolUse` from `../../shared/tools`, and `t` from `../../i18n`.
    - Define the exported `ToolRepetitionCheckResult` discriminated union with the additive optional `nudge.band: "nudge" | "replanning"` field (keep `{ allowExecution: true }`, `{ allowExecution: false, nudge }`, `{ allowExecution: false, askUser }`).
    - Define `IterationState` with all public fields (`tool`, `normalizedArgsHash`, `resultHash?`, `cursor?`, `target?`, `errorClass?`, `workspaceChanged`, `todoChanged`, `resultChanged`, `cursorAdvanced`, `noProgressScore`) plus internal bookkeeping (`completedExecutions`, `lastBand`, `pendingIntervention?`, `prevFailingTestCount?`, `prevFailingTestSetHash?`, `prevExternalStateHash?`).
    - Define `ProgressSignal`, `StagnationSignal`, `Band`, `CapturedSignals`, `BandDecision`, `ToolResultContext`, `ToolExecutionResult`, `MetricsSink`, and `ProgressAwareLoopDetectorDeps` exactly as in the design's Components/Data Models sections.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`; confirm the suppression count did not increase.
    - _Requirements: 2.2, 2.3, 8.1_

- [x] 2. Implement the dependency-free hashing and normalized args hash
  - [x] 2.1 Implement `fnv1a`, `normalizeArgs`, and `hashArgs`
    - Add a small FNV-1a string hash function (no new runtime dependency) used for `normalizedArgsHash`, `resultHash`, `prevFailingTestSetHash`, and `externalStateHash`.
    - Implement `normalizeArgs(block)` merging `params` and `nativeArgs` into one plain object, dropping `undefined`/empty-string/`null` values.
    - Implement `hashArgs(block)` serializing `{ name, args: normalizeArgs(block) }` with `safe-stable-stringify` (order-stable key sorting) then FNV-1a hashing the string.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 2.5_

  - [ ]* 2.2 Set up fast-check and write property test for order-insensitive args hash
    - Add `fast-check` as a dev dependency in `src/package.json` if absent, then create `src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts` with the fast-check import.
    - **Property 5: `normalizedArgsHash` is order-insensitive** — arbitrary arg object split across `params`/`nativeArgs` and any key permutation produce an identical hash (`// Feature: progress-aware-loop-detection, Property 5: ...`, ≥100 runs).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 2.5_
    - _Properties: 5_

- [x] 3. Implement cursor/target extraction and band derivation
  - [x] 3.1 Implement `extractCursor`, `extractTarget`, and `cursorAdvanced` comparison
    - Implement `extractCursor(block, context)` preferring explicit `offset`, then `start_line:end_line` range, then a pagination token parsed from `context.resultText`.
    - Implement `extractTarget(block)` producing `path` plus optional `#start-end` line range identity.
    - Implement the cursor-advance comparison helper: true when the new cursor is comparable to and strictly forward of the previous cursor for the same `target` (numeric for offsets, token inequality for pagination tokens).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 3.1, 3.2, 3.12_

  - [x] 3.2 Implement `deriveBand` and the band-to-result mapping with clamping
    - Implement `clamp(0, 100)` and a `deriveBand(score)` total function: `continue` 0–5, `nudge` 6–9, `replanning` 10–13, `hard_stop` 14–100.
    - Implement the band → `ToolRepetitionCheckResult` mapping: `continue` ⇒ `{ allowExecution: true }`; `nudge` ⇒ `{ allowExecution: false, nudge: { toolName, repeatCount, band: "nudge" } }`; `replanning` ⇒ nudge-variant with `band: "replanning"`; `hard_stop` ⇒ `{ allowExecution: false, askUser: { messageKey: "mistake_limit_reached", messageDetail } }` populated via `t("tools:toolRepetitionLimitReached", { toolName })`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 8.2, 8.3, 8.4_

  - [ ]* 3.3 Write property tests for band mapping, clamping, and result validity
    - **Property 3: Band and result are a total function of score with exact boundaries and hysteresis** — `deriveBand` over every integer 0–100 yields the exact band; include a rise-then-fall path that demotes and cancels a pending higher-band intervention (`// Feature: progress-aware-loop-detection, Property 3: ...`, ≥100 runs).
    - **Property 8: Score stays bounded 0–100** — arbitrary finite progress/stagnation signal sequences keep `0 ≤ score ≤ 100` (`// Feature: progress-aware-loop-detection, Property 8: ...`, ≥100 runs).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
    - _Properties: 3, 8_

- [x] 4. Implement iterative-capable tool classification
  - [x] 4.1 Implement `ITERATIVE_CAPABLE_TOOLS`, `ITERATIVE_COMMAND_PATTERNS`, and `isIterativeCapable`
    - Define the explicit tool set (`read_file`, `read_command_output`, `codebase_search`, `search_files`, `browser_action`) and the command-shape regexes (kubectl/watch, test runners, explicit wait/poll shells).
    - Implement `isIterativeCapable(block, context)` returning true for set membership, `context.isPollingWorkflow`, or a matching `command`/`nativeArgs.command` pattern.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 5.1_

  - [ ]* 4.2 Write unit tests for iterative-capable classification
    - Assert membership for each named tool and each command pattern (kubectl/watch, jest/vitest/pytest/go test/cargo test/mocha, sleep/poll/until/while), plus `isPollingWorkflow` and non-iterative negatives.
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 5.1_

- [x] 5. Implement signal derivation and scoring
  - [x] 5.1 Implement progress-signal derivation in `afterTool`
    - Derive progress signals from the `ToolResultContext` and extracted cursor/target: `cursor_advanced`, `target_changed`, `query_changed`, `result_changed`, `workspace_changed`, `todo_changed`, `external_state_changed`, `failing_tests_changed`, `failing_tests_decreased`, `poll_progress`.
    - Set the derived flags `workspaceChanged`, `todoChanged`, `resultChanged`, `cursorAdvanced` and compute `resultHash` via FNV-1a over `resultText`; track `prevFailingTestCount`, `prevFailingTestSetHash`, `prevExternalStateHash` for change detection.
    - Treat any `undefined` context field conservatively (no progress credit, no fabricated stagnation).
    - Return the populated `CapturedSignals`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.13, 7.3_

  - [x] 5.2 Implement stagnation-signal derivation in `afterTool`
    - Derive stagnation signals: `identical_args_and_result` (same `normalizedArgsHash` and `resultHash` with no progress), `repeated_error_class` (same `errorClass` without intervening progress; covers auth retry without new credentials), `empty_mutation_diff` (mutation tool with empty workspace diff on repeat; covers repeated malformed edit), `unverified_success` (`verifiedSucceeded === false` contradicting a claimed success).
    - Append derived stagnation signals to `CapturedSignals`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 5.3 Implement `evaluateProgress` scoring with clamping and iterative-capable exemption
    - Convert captured signals into score deltas (progress decreases, stagnation increases), route all mutations through `clamp(0, 100)`, update `IterationState`, increment `completedExecutions`, and re-derive the band via `deriveBand`.
    - Ensure repetition alone never raises the score for iterative-capable tools when any progress signal is present, and that repetition without progress raises the score only through stagnation signals (never a raw count).
    - Return a `BandDecision` with `band`, `noProgressScore`, and the mapped `result`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 1.5, 3.1, 5.2, 5.3, 5.4, 6.1, 7.2_

  - [ ]* 5.4 Write property tests for the universal scoring rules
    - **Property 1: Observable progress never escalates an iterative-capable tool** — iterative tool + ≥1 progress signal each run keeps `score ≤ 5` and `allowExecution: true` over arbitrary run counts (`// Feature: ..., Property 1: ...`, ≥100 runs).
    - **Property 4: Interventions depend on score, never on raw repetition count** — arbitrary N identical iterative calls with progress ⇒ no intervention regardless of N (`// Feature: ..., Property 4: ...`, ≥100 runs).
    - **Property 7: Scoring depends only on observable inputs** — identical observable inputs ⇒ identical score delta, independent of any self-report-shaped field (`// Feature: ..., Property 7: ...`, ≥100 runs).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 1.5, 3.1, 3.13, 5.2, 5.3, 5.4, 7.3_
    - _Properties: 1, 4, 7_

  - [ ]* 5.5 Write unit/edge tests for individual signal derivations
    - Cover empty mutation diff (4.3), repeated malformed edit (4.6), auth retry without new credentials (4.5), unverified-success mismatch (4.8), failing-test count decrease and set change (3.8, 3.9), k8s/browser/external state change (3.7, 3.10, 3.11), and poll-workflow no-increase (3.13).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 3.7, 3.8, 3.9, 3.10, 3.11, 3.13, 4.3, 4.5, 4.6, 4.8_

- [x] 6. Implement the detector class and two-call protocol
  - [x] 6.1 Implement the `ProgressAwareLoopDetector` class with the four phase methods and per-task state
    - Add the private `states: Map<string, IterationState>` with lazy default creation per `taskId` (defaulting to a single implicit task when omitted).
    - Implement `beforeTool(block, taskId)` (normalize args, compute hash, extract cursor/target, return the gate decision from the band derived from accumulated prior score, capture pending pre-execution inputs) and `executeTool()` as a documented no-op boundary marker.
    - Wire `afterTool(block, result, context, taskId)` (from task 5.1/5.2) and `evaluateProgress(taskId, captured)` (from task 5.3) as public methods.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.4_

  - [x] 6.2 Implement `check()` and `recordResult()` wrappers with hysteresis and hard-stop precondition
    - Implement `check(block, taskId?)` as a thin wrapper over `beforeTool` preserving the existing single-arg signature.
    - Implement `recordResult(block, result, context, taskId?)` calling `afterTool` then `evaluateProgress`.
    - Enforce once-per-entry nudge, hysteresis demotion/cancellation of pending higher-band interventions (6.6), the hard-stop precondition requiring `completedExecutions >= 2` (withhold otherwise), hard-stop `messageDetail` identifying the repeated tool, and score/intervention reset after a hard stop is surfaced.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 1.5, 6.2, 6.6, 6.7, 6.8, 6.9, 7.1, 8.1, 8.5_

  - [x] 6.3 Add the compatibility exports preserving the old names
    - Add `export { ProgressAwareLoopDetector as ToolRepetitionDetector }` and ensure `ToolRepetitionCheckResult` is re-exported from this module so existing import sites keep resolving.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 8.1, 8.5_

  - [ ]* 6.4 Write property tests for the protocol-level invariants
    - **Property 2: Identical args and identical result monotonically escalate to a hard stop** — repeated identical args+result increases score each completed execution until clamped, then returns an `askUser` hard stop identifying the tool once score ≥ 14 with ≥2 completed executions (`// Feature: ..., Property 2: ...`, ≥100 runs).
    - **Property 6: The returned result is always a valid `ToolRepetitionCheckResult`** — arbitrary `ToolUse` + arbitrary accumulated state ⇒ a mutually-exclusive union variant; hard stop uses `messageKey === "mistake_limit_reached"` with non-empty `messageDetail` (`// Feature: ..., Property 6: ...`, ≥100 runs).
    - **Property 9: Hard stop is withheld below two completed executions** — `score ≥ 14` with `completedExecutions < 2` ⇒ never `askUser` (`// Feature: ..., Property 9: ...`, ≥100 runs).
    - **Property 10: Per-task state isolation** — interleaved executions across two task ids evolve scores independently (`// Feature: ..., Property 10: ...`, ≥100 runs).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 2.1, 4.1, 4.4, 4.7, 6.7, 6.8, 7.1, 7.2, 8.1, 8.2, 8.3, 8.4_
    - _Properties: 2, 6, 9, 10_

  - [ ]* 6.5 Write unit tests for phase API, state shape, and once-per-entry/hysteresis behavior
    - Assert the four phase methods exist and run in order (`beforeTool` captures before result, `afterTool` captures result/workspace, `evaluateProgress` updates band); assert `IterationState` optional fields and post-evaluation state reflects the latest execution.
    - Add stateful tests for once-per-entry nudge and hysteresis cancellation; assert `check(block)` type-checks and behaves with the single-arg signature (contract compatibility).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.2, 2.3, 2.4, 6.4, 6.6, 8.5_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement nudge/stop metrics emission
  - [x] 8.1 Wire `MetricsSink` emission into `evaluateProgress`
    - Accept the optional `metrics` sink via `ProgressAwareLoopDetectorDeps` in the constructor.
    - Emit `emitNudge({ toolName, noProgressScore })` when a nudge (including the replanning variant) is issued, and `emitStop({ toolName, noProgressScore })` when a hard stop is issued.
    - Wrap emission so a throwing sink cannot break gating (swallow emission failures).
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/ProgressAwareLoopDetector.ts`.
    - _Requirements: 9.1, 9.2_

  - [ ]* 8.2 Write unit tests for metrics emission
    - Mock `MetricsSink`; assert `emitNudge`/`emitStop` carry `toolName` and `noProgressScore`, and that a throwing sink does not break the gate.
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 9.1, 9.2_

- [x] 9. Wire the detector into the host and preserve the call-site contract
  - [x] 9.1 Update `Task.ts` to use `ProgressAwareLoopDetector`
    - Change the import in `src/core/task/Task.ts` from `../tools/ToolRepetitionDetector` to `../tools/ProgressAwareLoopDetector` (via the compatibility alias) and keep the field type and `new ProgressAwareLoopDetector(this.consecutiveMistakeLimit)` construction.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts`.
    - _Requirements: 8.1, 8.5_

  - [x] 9.2 Add the post-execution `recordResult()` call in `presentAssistantMessage.ts`
    - Keep the existing `const repetitionCheck = cline.toolRepetitionDetector.check(block)` gate and its `nudge`/`askUser` branching unchanged.
    - After a tool executes and its result is pushed, build a `ToolResultContext` from signals the host already has (result text, dispatch `catch` error class, git/worktree change, todo change) and call `cline.toolRepetitionDetector.recordResult(block, result, context)`.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/assistant-message/presentAssistantMessage.ts`.
    - _Requirements: 1.2, 1.3, 1.4, 8.1, 8.5_

- [x] 10. Migrate and rewrite the existing detector spec
  - [x] 10.1 Migrate `ToolRepetitionDetector.spec.ts` behavior into the new spec and delete the old file
    - Rename/move assertions into `ProgressAwareLoopDetector.spec.ts`: order-insensitive argument comparison, differentiation by `nativeArgs` (different files/offsets/cwd), empty tool call, and hard-stop `messageKey`/tool-name interpolation.
    - Rewrite the fixed-count nudge/escalate cases to feed stagnation signals (identical args + identical result) so genuine-loop cases reach a nudge and then a hard stop under the new count-independent semantics; remove `src/core/tools/__tests__/ToolRepetitionDetector.spec.ts`.
    - Use bracket notation for any private-member access (no `as any`).
    - Run `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts` and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
    - _Requirements: 2.5, 7.1, 7.2, 8.1, 8.4, 8.5_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (`_Requirements:_`) and, where applicable, design correctness properties (`_Properties:_`) for traceability.
- Property tests use `fast-check` at the package-local unit layer (`src/core/tools/__tests__/`), each tagged `// Feature: progress-aware-loop-detection, Property N: ...` with ≥100 iterations. No e2e is needed — the detector is pure logic.
- Per AGENTS.md, after editing a file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; the narrowest Vitest suite is `npx vitest run src/core/tools/__tests__/ProgressAwareLoopDetector.spec.ts`.
- The call-site contract in `presentAssistantMessage.ts` is preserved: `check()` branching stays identical and only one `recordResult()` call is added post-execution.
- Do not create `.changeset` files or edit `CHANGELOG.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "3.2", "4.1"] },
    { "id": 3, "tasks": ["3.3", "4.2", "5.1", "5.2"] },
    { "id": 4, "tasks": ["5.3"] },
    { "id": 5, "tasks": ["5.4", "5.5", "6.1"] },
    { "id": 6, "tasks": ["6.2"] },
    { "id": 7, "tasks": ["6.3", "6.4", "6.5", "8.1"] },
    { "id": 8, "tasks": ["8.2", "9.1", "9.2"] },
    { "id": 9, "tasks": ["10.1"] }
  ]
}
```
