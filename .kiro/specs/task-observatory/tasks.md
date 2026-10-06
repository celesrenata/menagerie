# Implementation Plan: Task Observatory

## Overview

This plan implements the Task Observatory as a read-only, in-sidebar task-inspection surface for the existing Menagerie (Roo/Cline-derived) VS Code extension. Work proceeds test-first and bottom-up: shared data models and the total `deriveStatus` function first; then the read-only extension-host service, persisted-store reader, and error classifier (with unit and `fast-check` property tests); then the additive read-only message contracts; then the React webview surface under `webview-ui/src/components/observatory/` (with webview-ui tests); then wiring, routing, and the trim of `src/activate/taskBoard.ts`; and finally the boundary-only `apps/vscode-e2e` smokes.

Every task builds on prior tasks and ends integrated — nothing orphaned. All tasks are coding-only. After editing a file, run the narrowest relevant Vitest suite from the package that declares Vitest and run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` (or the webview-ui equivalent) per AGENTS.md, confirming suppression counts do not increase.

The governing guarantee is the P0 Zero-Lifecycle-Side-Effect invariant (Property 1), which has dedicated test seams and tests over the full inspection-action alphabet.

## Tasks

- [x] 1. Define shared Observatory data models and the read-only message surface
  - Create `packages/types/src/observatory.ts` with `ObservationSource`, `ObservedTaskStatus`, `ObservedTask`, `SummaryHeader`, `ObservationEvent`, `TimelineEvent`, `DetailView`, `ChangedFile`, `EvidenceItem`, `TaskMetrics`, `MastermindSummary`, and `ErrorClassification` exactly as specified in the design Data Models section
  - Export the new module from the `packages/types` barrel so both host and webview consume one source of truth
  - Add the additive `ExtensionMessage` variants (`observatoryUpdate`, `observatoryWindow`, `observatoryPersisted`, `observatoryMastermind`, `observatoryError`) and the complete read-only `WebviewMessage` allowlist (`observatorySubscribe`, `observatoryRequestWindow`, `observatoryRequestPersisted`, `observatoryRequestMastermind`, `observatoryRefresh`) in `packages/types/src/vscode-extension-host.ts`, referencing the `observatory.ts` payload types
  - Keep all existing message contracts unchanged (additive only)
  - Run the `packages/types` Vitest suite and eslint prune-suppressions on the two edited files
  - _Requirements: 9.3, 5.2, 5.3, 6.1, 7.4, 10.2, 12.1_

- [ ] 2. Implement status derivation as a total function
  - [x] 2.1 Implement `deriveStatus` in `src/services/observatory/deriveStatus.ts`
    - Pure function `deriveStatus(fields): ObservedTaskStatus` taking only read-only task-field inputs (`history.status`, last `clineMessage` type/`say`/`isAnswered`/`partial`, `abort`, `isStreaming`, admitted-worker flag, terminal failure markers)
    - Mirror the `collectTaskBoard()` precedence rules exactly: completed → cancelled → waiting → streaming → queued → working, with `failed` derived from terminal failure records (`parallelWorkerFailure` / manifest worker failure outcome)
    - Function must be total and side-effect-free; no `Task` method is invoked
    - _Requirements: 2.3, 2.4, 2.5, 2.6_
    - _Properties: 4_

  - [ ]* 2.2 Write property test for status derivation totality
    - **Property 4: Status derivation is a total function matching collectTaskBoard**
    - Generate arbitrary task-field combinations; assert exactly one of the seven statuses is returned and the result matches `collectTaskBoard` precedence
    - Tag the test `// Feature: task-observatory, Property 4: ...`; minimum 100 cases via `fast-check`
    - Place in `src/services/observatory/__tests__/deriveStatus.property.test.ts`
    - _Requirements: 2.3, 2.4, 2.5, 2.6_
    - _Properties: 4_

- [ ] 3. Implement the persisted-task-store reader
  - [x] 3.1 Implement `PersistedTaskStoreReader` in `src/services/observatory/PersistedTaskStoreReader.ts`
    - Read `parallel-tasks/<batch-id>/manifest.json`, `worker-N.json`, `worker-N.patch` from global storage via file reads and JSON parsing only
    - Map persisted records to `ObservedTask` + `TimelineEvent[]` with `source: "COMPLETED"`; derive status via `deriveStatus` over persisted fields
    - Assign `logicalWorkerId = \`${batchId}:worker-${index}\`` from the manifest; never construct a `Task`
    - _Requirements: 9.1, 9.2, 9.4, 9.5_
    - _Properties: 3, 11, 13_

  - [ ]* 3.2 Write property test: persisted-store parsing round-trips
    - **Property 11: Persisted-store parsing round-trips**
    - Generate valid persisted record sets, serialize, parse via the reader, assert parsed `ObservedTask` fields equal serialized values; 100+ cases, `fast-check`, tagged
    - Place in `src/services/observatory/__tests__/PersistedTaskStoreReader.property.test.ts`
    - _Requirements: 9.2_
    - _Properties: 11_

  - [ ]* 3.3 Write property test: opening a COMPLETED inspection never constructs a Task
    - **Property 3: Opening a COMPLETED inspection never constructs a Task**
    - Install a spy over the `Task` constructor; for arbitrary persisted batches, open COMPLETED inspections and assert zero constructions
    - 100+ cases, `fast-check`, tagged; same test directory
    - _Requirements: 9.4_
    - _Properties: 3_

  - [ ]* 3.4 Write property test: logical worker identity is stable across completion
    - **Property 13: Logical worker identity is stable across completion**
    - For arbitrary workers, assert the live-correlated record and the persisted record resolve to the same `logicalWorkerId`
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 9.5_
    - _Properties: 13_

- [ ] 4. Implement the error classifier
  - [x] 4.1 Implement `ErrorClassifier.classify` in `src/services/observatory/ErrorClassifier.ts`
    - Pure `classify(signal): ErrorClassification` mapping signals to the fixed enum per the design mapping table
    - Implement loop detection (repeated same-tool/same-error `TaskToolFailed` with no intervening state change → LOOP; repeated 401 with no credential change → LOOP, reset to AUTH on credential change) and polling exclusion (external-system polling is never an error)
    - _Requirements: 12.1, 12.2, 12.3_
    - _Properties: 17, 18, 19_

  - [ ]* 4.2 Write property test: error classification is total
    - **Property 17: Error classification is total**
    - Arbitrary error signals → exactly one of the eight categories; 100+ cases, `fast-check`, tagged
    - Place in `src/services/observatory/__tests__/ErrorClassifier.property.test.ts`
    - _Requirements: 12.1_
    - _Properties: 17_

  - [ ]* 4.3 Write property test: polling activity is never an error
    - **Property 18: Polling activity is never classified as an error**
    - Generate polling-signal sequences (e.g. Kubernetes status checks); assert no error category is assigned
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 12.2_
    - _Properties: 18_

  - [ ]* 4.4 Write property test: repeated 401 without credential change is LOOP
    - **Property 19: Repeated 401 without credential change is LOOP**
    - Repeated 401 with no intervening credential change → LOOP; inserting a credential change prevents LOOP
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 12.3_
    - _Properties: 19_

- [ ] 5. Checkpoint - pure models, derivation, persisted reader, and classifier
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement the read-only Task Observation Service
  - [x] 6.1 Implement `TaskObservationService` core lifecycle and read-only subscription in `src/services/observatory/TaskObservationService.ts`
    - `start(provider)` / `dispose()` registering as a `vscode.Disposable`; `attachTo(task)` / `detachFrom(taskId)` managing per-task `Disposable` listener records keyed by `taskId`
    - Subscribe read-only to the relevant `RooCodeEventName.*` events (`Message`, `TaskActive`, `TaskInteractive`, `TaskResumable`, `TaskIdle`, `TaskStarted`, `TaskAborted`, `TaskAskResponded`, `TaskUserMessage`, `TaskTokenUsageUpdated`, `TaskToolFailed`, `QueuedMessagesUpdated`) using typed `on()`/`off()`; attach on creation, detach on `TaskAborted`/disposal
    - Must not import or hold references to `Task.run`, `abortTask`, `cancelCurrentRequest`, `resumeTask`, or `handleWebviewAskResponse`
    - _Requirements: 8.1, 8.2, 4.9_
    - _Properties: 1_

  - [x] 6.2 Implement event normalization, failure isolation, and debounced batching
    - Wrap every listener body and the reconciliation pass in `try/catch`; translate each raw event into an `ObservationEvent` using read-only field access and `deriveStatus`; assign monotonic per-task `seq` and `committedAt`
    - On normalization/post/listener failure: log, emit an `observatoryError`, skip the batch, never rethrow into the `Task` emit site and never perform any task write
    - Coalesce events per task over an ~80 ms debounce window and flush as one `observatoryUpdate` via `postMessageToWebview`
    - _Requirements: 8.1, 8.3, 8.6, 4.12_
    - _Properties: 1, 12_

  - [x] 6.3 Implement the SNAPSHOT reconciliation pass
    - Fixed-interval timer configurable within [5 s, 30 s] (default 10 s) running `collectTaskBoard()`-style read-only collection over `getAllInstances()`; produce `SNAPSHOT_State` rows and post a reconciliation `observatoryUpdate`
    - Reconcile the listener set against `getAllInstances()` to prevent leaked listeners; set `source` on every row to its true origin
    - _Requirements: 8.4, 8.5, 9.3, 4.13_
    - _Properties: 10, 12, 14_

  - [ ]* 6.4 Write Property 1 zero-mutation property test (host P0 safety)
    - **Property 1: Observation never mutates task state (P0 safety)**
    - Install spies over `ClineProvider.postMessageToWebview` AND over every `ClineProvider`/`Task` mutation method (`run`, `resume`, `abortTask`, `cancelCurrentRequest`, `dispose`, active-chat switch, `handleWebviewAskResponse`); generate random sequences from the full inspection-action alphabet
    - Assert zero mutating calls, no webview→host message outside the read-only allowlist, and observed lifecycle fields identical before/after; inject collection/delivery/render failures into the generator to also prove error-path zero-mutation (4.12, 8.6)
    - 100+ cases, `fast-check`, tagged `// Feature: task-observatory, Property 1: ...`; place in `src/services/observatory/__tests__/zeroMutation.property.test.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 8.1, 8.6, 10.3, 11.3, 11.4, 3.5_
    - _Properties: 1_

  - [ ]* 6.5 Write property test: reconciliation converges state to the snapshot
    - **Property 10: Reconciliation converges state to the snapshot**
    - For arbitrary event-derived state and arbitrary snapshots, assert post-reconciliation state equals the snapshot on every diverging field
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 8.5_
    - _Properties: 10_

  - [ ]* 6.6 Write property test: source labeling is total and matches origin
    - **Property 12: Source labeling is total and matches origin**
    - For arbitrary inspected tasks, assert `source` is exactly one of {LIVE, SNAPSHOT, COMPLETED} and equals the producing origin
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 9.3_
    - _Properties: 12_

  - [ ]* 6.7 Write property test: external mutations are reflected, not suppressed
    - **Property 14: External mutations are reflected, not suppressed**
    - Simulate a non-Observatory Lifecycle_Mutating_Operation during an inspection sequence; assert the service neither suppresses nor alters it and the result appears on the next collection pass
    - 100+ cases, `fast-check`, tagged
    - _Requirements: 4.13_
    - _Properties: 14_

  - [ ]* 6.8 Write integration/timing test: commit-to-webview latency
    - Measure a few committed events end-to-end through the service to a captured `postMessageToWebview`; assert ≤ 500 ms with margin (example/integration test, not PBT)
    - _Requirements: 8.3_

- [ ] 7. Implement Mastermind and Attention aggregation in the host service
  - [x] 7.1 Implement Mastermind summary and attention aggregation helpers
    - Compute `MastermindSummary` (worker counts, lane status, context percent, tier ceiling, artifacts, blockers) from a parent's workers' derived statuses; compute the waiting-for-input set
    - Expose read-only aggregation used by the message router; perform no task writes
    - _Requirements: 10.2, 11.1_
    - _Properties: 15, 16_

  - [ ]* 7.2 Write property test: Mastermind summary aggregates workers correctly
    - **Property 15: Mastermind summary aggregates workers correctly**
    - For arbitrary worker sets under a parent, assert counts and lane status equal the true tallies from derived statuses; 100+ cases, `fast-check`, tagged
    - _Requirements: 10.2_
    - _Properties: 15_

  - [ ]* 7.3 Write property test: attention queue contains exactly the waiting tasks
    - **Property 16: Attention queue contains exactly the waiting tasks**
    - For arbitrary mixed-status task sets, assert the attention set equals exactly the waiting-for-user-input tasks; 100+ cases, `fast-check`, tagged
    - _Requirements: 11.1_
    - _Properties: 16_

- [ ] 8. Implement the read-only Observatory message router
  - [x] 8.1 Add Observatory read-only handlers in `webviewMessageHandler`
    - Create `ObservatoryMessageRouter` wiring handling `observatorySubscribe`, `observatoryRequestWindow` (`{taskId, offset, limit}` → bounded `observatoryWindow`), `observatoryRequestPersisted` (`{batchId, workerId}` → `observatoryPersisted` via `PersistedTaskStoreReader`), `observatoryRequestMastermind` (`{parentTaskId}` → `observatoryMastermind`), and `observatoryRefresh` (fresh read-only collection pass)
    - Each handler reads data and calls `postMessageToWebview` only; none calls a lifecycle-mutating operation
    - _Requirements: 4.1, 4.4, 4.9, 8.1, 9.1, 10.3_
    - _Properties: 1_

  - [ ]* 8.2 Write unit tests for the message router read-only discipline
    - Assert each handler responds with the correct read-only `ExtensionMessage` and that no handler invokes a mutation method (spy); include a bounded-window request asserting `limit` is honored
    - _Requirements: 4.9, 8.1_
    - _Properties: 1_

- [ ] 9. Checkpoint - host service, aggregation, and routing
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Build the Observatory webview foundation and store
  - [x] 10.1 Implement `ObservatoryRoot` and the observatory store in `webview-ui/src/components/observatory/`
    - `ObservatoryRoot` sends `observatorySubscribe` on mount, owns the store, applies `observatoryUpdate` (event + snapshot) messages in `seq` order, and renders the Tasks view + tab bar + active detail region
    - Store applies snapshot-wins reconciliation and groups LIVE/COMPLETED records under `logicalWorkerId`
    - _Requirements: 1.1, 8.5, 9.5_
    - _Properties: 10, 13_

  - [ ]* 10.2 Write webview Property 1 facet test (message discipline)
    - **Property 1 (webview facet): closing/switching/pinning tabs sends no mutating message**
    - Spy on the webview message bus; generate random tab actions (select, switch, pin, close) and assert only read-only allowlist messages are ever sent
    - 100+ cases, `fast-check`, tagged; place in `webview-ui/src/components/observatory/__tests__/zeroMutation.property.test.tsx`
    - _Requirements: 3.5, 4.1, 4.2, 4.8_
    - _Properties: 1_

- [ ] 11. Implement the Tasks view: tree, attention queue, and Mastermind dashboard
  - [x] 11.1 Implement `TaskTree`
    - Render parent/worker hierarchy nesting each child under its `parentId` (`parallelParentTaskId ?? parentTaskId`); roots are tasks without a parent; render per-task state indicators for all seven statuses
    - _Requirements: 2.1, 2.2, 2.3_
    - _Properties: 5_

  - [ ]* 11.2 Write property test: task hierarchy groups children under their parent
    - **Property 5: Task hierarchy groups children under their parent**
    - Generate arbitrary task sets with parent links; assert every child nests under its `parentId` and parentless tasks are roots; 100+ cases, `fast-check`, tagged
    - _Requirements: 2.1, 2.2_
    - _Properties: 5_

  - [x] 11.3 Implement `AttentionQueue` and `MastermindDashboard`
    - `AttentionQueue` lists exactly waiting-for-input tasks; selecting an item opens an Inspection_Tab and sends no active-chat or mutating message
    - `MastermindDashboard` renders the parent-level summary from `observatoryMastermind`; opening it sends only `observatoryRequestMastermind`
    - _Requirements: 10.1, 11.1, 11.2, 11.3, 11.4, 10.3_
    - _Properties: 1, 15, 16_

  - [ ]* 11.4 Write unit tests for attention-select and Mastermind presence
    - Assert queue-select opens a tab without changing active chat (11.2, 11.3), and Mastermind renders for a parent with workers (10.1); example tests
    - _Requirements: 10.1, 11.2, 11.3_

- [ ] 12. Implement Inspection tabs and the sticky summary header
  - [x] 12.1 Implement `InspectionTabBar` and `InspectionTab`
    - Multiple simultaneous tabs; pin and close are pure webview store actions; closing dispatches a local action and sends no host message that mutates a task; leaves the underlying task running
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.8_
    - _Properties: 1_

  - [x] 12.2 Implement `SummaryHeader`
    - Sticky header rendering the fixed field set (Status, Mode, Route, Profile, Model, Reasoning, Context used, Context limit, Started, Last activity, Workspace, Parent id, Worker id); any absent value renders an explicit empty-value indicator and is never omitted, so field count is constant
    - LIVE sourcing comes from `getTaskMode()`/`getTaskApiConfigName()`/`api.getModel().id` as supplied by the host header payload
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
    - _Properties: 9_

  - [ ]* 12.3 Write property test: summary header completeness with explicit empty values
    - **Property 9: Summary header completeness with explicit empty values**
    - For arbitrary `ObservedTask`, assert every required field renders, missing values show an explicit empty indicator, and the rendered field count is constant; 100+ cases, `fast-check`, tagged
    - _Requirements: 5.2, 5.3_
    - _Properties: 9_

  - [ ]* 12.4 Write unit tests for tab interactions and header sourcing
    - Assert tab open/pin/close behavior (3.1, 3.3, 3.4), sticky header presence (5.1), and LIVE field sourcing (5.4); example tests
    - _Requirements: 3.1, 3.3, 3.4, 5.1, 5.4_

- [ ] 13. Implement detail views and the virtualized timeline
  - [x] 13.1 Implement `DetailTabs`
    - Render the six views Activity, Checklist (from `todoList`), Changes (files/patches/git summary), Evidence (tests/commands/refs), Metrics (`TaskMetrics`), and Raw (complete underlying events) from the `DetailView` union; compact-by-default API metadata with a raw toggle
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.5_

  - [x] 13.2 Implement `VirtualTimeline` with bounded windowing and lazy expansion
    - Virtualized list with overscan ≤ 20 above/below the viewport, ≤ 500 events retained in memory (evict outside the window), lazy per-event full-detail fetch on expand via `observatoryRequestWindow`, and tool-result collapse (collapsed iff lineCount > 50 or byteSize > 10000) with line count / byte size / outcome summary and Preview/Expand/Open-raw affordances
    - Support timeline filtering that renders exactly the matching events
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_
    - _Properties: 2, 6, 7, 8_

  - [x] 13.3 Implement `ErrorBadge` and per-event render-failure isolation
    - Render `ErrorClassification` beside error detail; wrap each timeline row in a React error boundary so a failing row shows an inline error and all other rows keep rendering without freezing the tab
    - _Requirements: 12.4, 7.8_

  - [ ]* 13.4 Write property test: timeline window never exceeds bounds
    - **Property 2: Timeline window never exceeds bounds**
    - For arbitrary ingest sequences and viewport sizes, assert mounted components ≤ viewport + overscan(≤20) and in-memory events ≤ 500 with eviction; 100+ cases, `fast-check`, tagged
    - _Requirements: 7.1, 7.6_
    - _Properties: 2_

  - [ ]* 13.5 Write property test: expanding an event renders only that event's detail
    - **Property 6: Expanding an event renders only that event's detail**
    - For arbitrary event sets and expanded subsets, assert exactly expanded events render full detail and non-expanded render only previews; 100+ cases, `fast-check`, tagged
    - _Requirements: 7.2_
    - _Properties: 6_

  - [ ]* 13.6 Write property test: filtering shows exactly the matching events
    - **Property 7: Filtering shows exactly the matching events**
    - For arbitrary event sets and predicates, assert the rendered timeline equals exactly the matching events; 100+ cases, `fast-check`, tagged
    - _Requirements: 7.3_
    - _Properties: 7_

  - [ ]* 13.7 Write property test: tool-result collapse threshold and summary
    - **Property 8: Tool-result collapse threshold and summary**
    - Assert collapse iff lineCount > 50 or byteSize > 10000, and collapsed summary includes line count, byte size, outcome, with Preview/Expand/Open-raw; 100+ cases, `fast-check`, tagged
    - _Requirements: 7.4_
    - _Properties: 8_

  - [ ]* 13.8 Write edge-case and example tests for detail views and failure isolation
    - Per-event render-failure isolation (7.8), the six views render (6.1–6.7), API compact/raw toggle (7.5), and error badge rendering (12.4); include a loose large-history responsiveness check (≥ 50,000-char fixture, first update begins promptly after interaction) for 7.7
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.5, 7.7, 7.8, 12.4_

- [ ] 14. Checkpoint - webview surface complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Wire the service into activation and trim the legacy Task Board
  - [x] 15.1 Register `TaskObservationService` during extension activation
    - Start the service with the active `ClineProvider`, register it as a context `Disposable`, and route the read-only `WebviewMessage`s through `ObservatoryMessageRouter`
    - _Requirements: 8.1, 8.2_
    - _Properties: 1_

  - [x] 15.2 Trim `src/activate/taskBoard.ts`
    - Retain the `zoo-code.*` command identifiers (`zoo-code.getTaskBoard`, `zoo-code.taskBoardShowDetails`, `zoo-code.showTaskBoard`, `zoo-code.exportTaskBoard`) re-registered as compatibility/debug commands and keep the `task-boards/<id>.json` snapshot writer
    - Remove the `onDidChangeSelection` + `TreeItem.command` focus-on-selection behavior and the `ViewColumn.Beside` detail panel as the primary inspection surface, and remove the 5-second polling loop
    - Use "Menagerie" for any new user-visible strings
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 4.10, 8.2_
    - _Properties: 1_

  - [ ]* 15.3 Write unit/smoke tests for compat commands and inspection-path neutrality
    - Assert retained `zoo-code.*` ids register as compat/debug (1.3, 1.4), no `createWebviewPanel` on the inspection path (1.2, spy), 5 s poll removed (8.2), and "Menagerie" strings (1.5)
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 8.2_

- [ ] 16. Add boundary-only extension-host E2E smokes
  - [ ]* 16.1 E2E: three parallel workers inspected while running with zero side effects
    - In `apps/vscode-e2e`, start a 3-worker batch, open each as an Inspection_Tab, exercise select/switch/expand/filter, and assert all three continue running uncancelled and the active chat is unchanged (real-boundary proof of Property 1)
    - _Requirements: 3.5, 4.1, 4.2, 4.9, 4.11_
    - _Properties: 1_

  - [ ]* 16.2 E2E: persisted-worker inspection after restart
    - With an interrupted batch's `parallel-tasks/<batch-id>/` on disk and no auto-resume, open a COMPLETED inspection and assert it renders from persisted files with no `Task` runtime created
    - _Requirements: 9.1, 9.4_
    - _Properties: 3_

- [ ] 17. Final checkpoint - full feature integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references the specific requirement sub-clauses (`_Requirements:_`) and, where it implements a correctness property, the property number (`_Properties:_`) for traceability.
- All property tests use `fast-check` with a minimum of 100 generated cases and carry the `// Feature: task-observatory, Property N: ...` tag. One property-based test per correctness property.
- Property placement follows AGENTS.md: protocol/derivation/virtualization/classification live at the extension-host unit layer (`src/services/observatory/__tests__/`) and the webview-ui layer (`webview-ui/src/components/observatory/__tests__/`); only the real-extension-host boundary smokes live in `apps/vscode-e2e` (tasks 16.1, 16.2).
- The P0 Property 1 is proven at both the host layer (task 6.4, spies over `postMessageToWebview` and all `ClineProvider`/`Task` mutation methods across the full inspection-action alphabet, including error-path injection) and the webview layer (task 10.2, message-bus discipline), and smoke-proven at the real boundary (task 16.1).
- All message types are additive to `packages/types/src/vscode-extension-host.ts`; existing contracts are unchanged. On-disk `task-boards/` and `parallel-tasks/` formats are not modified; the Observatory only reads `parallel-tasks/`.
- After editing each file, run the narrowest relevant Vitest suite from the owning package and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` (webview-ui and packages/types use their own suites); suppression counts must not increase.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.4", "4.2", "4.3", "4.4", "6.1"] },
    { "id": 3, "tasks": ["6.2", "6.3"] },
    { "id": 4, "tasks": ["6.4", "6.5", "6.6", "6.7", "6.8", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 6, "tasks": ["8.2", "10.1"] },
    { "id": 7, "tasks": ["10.2", "11.1", "11.3", "12.1", "12.2", "13.1"] },
    { "id": 8, "tasks": ["11.2", "11.4", "12.3", "12.4", "13.2", "13.3"] },
    { "id": 9, "tasks": ["13.4", "13.5", "13.6", "13.7", "13.8", "15.1"] },
    { "id": 10, "tasks": ["15.2"] },
    { "id": 11, "tasks": ["15.3", "16.1", "16.2"] }
  ]
}
```
