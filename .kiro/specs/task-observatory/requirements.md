# Requirements Document

## Introduction

The Task Observatory is a first-class, read-only task-inspection workspace embedded in the Menagerie (VS Code extension) sidebar. It replaces the current editor-panel-oriented Task Board detail experience (`src/activate/taskBoard.ts`), which opens a `vscode.WebviewPanel` in `ViewColumn.Beside` and focuses the existing chat on row selection.

The Observatory lets a user inspect live parent and worker tasks, and completed persisted workers, without disturbing them. The central guarantee of this feature is that observation is purely observational: no inspection action may focus, activate, pause, cancel, resume, answer, re-route, or otherwise mutate any task. The feature must also present very large task histories (tens of thousands of lines) responsively without rendering entire transcripts eagerly, and must receive updates through an event-driven observation service rather than the current 5-second polling loop.

This specification is Phase 1 (FEAT-001) of the "Menagerie Autonomous Operations Lift." It is scoped strictly to observability of tasks and workers in the sidebar. Loop detection, tier semantics, semantic retrieval, branding, reasoning budgets, verification, parallelism scheduling, and metrics-as-features are explicitly out of scope and are covered by separate specifications.

### Non-Goals

- No GPU scheduling or resource-allocation behavior.
- No implicit resumption of a stopped task through inspection.
- No auto-injection of complete worker histories into the parent task context.
- No removal or rewriting of existing persisted task histories.
- No replacement of the active Menagerie chat selection as a result of inspection.

## Glossary

- **Menagerie_Sidebar**: The VS Code sidebar view container contributed by the Menagerie extension, driven by `ClineProvider` (`src/core/webview/ClineProvider.ts`).
- **Observatory**: The read-only task-inspection workspace that renders inside the Menagerie_Sidebar and is the subject of this specification.
- **Task_Observation_Service**: A read-only service (`TaskObservationService`) that receives lifecycle and activity events published by tasks and forwards them to the Observatory webview. It never issues commands to tasks.
- **Inspection_Tab**: An internal tab inside the Observatory that displays one inspected task. Inspection_Tabs are not VS Code editor tabs and are not `vscode.WebviewPanel` instances.
- **Parent_Task**: A task that originates workers; identified at runtime by its `taskId` and referenced by workers through `parallelParentTaskId` or `parentTaskId` (`src/core/task/Task.ts`).
- **Worker_Task**: A task spawned under a Parent_Task; identified at runtime by `parallelWorker === true` and `parallelParentTaskId`.
- **Logical_Worker**: A single worker position within a batch (for example `worker-N`), identified consistently across its live runtime record and its persisted record so a worker can be inspected before and after completion.
- **LIVE_State**: An inspection source state in which the inspected task has a current in-process `Task` runtime reachable through `ClineProvider.getAllInstances()`.
- **SNAPSHOT_State**: An inspection source state in which the inspected task data comes from a reconciliation snapshot of in-process tasks rather than directly from a live event stream.
- **COMPLETED_State**: An inspection source state in which the inspected task data comes only from the persisted parallel-task store (`parallel-tasks/<batch-id>/`) with no in-process `Task` runtime.
- **Persisted_Task_Store**: The existing global-storage directory `parallel-tasks/<batch-id>/` containing `manifest.json`, `worker-N.json`, and `worker-N.patch` (`docs/architecture/native-parallel-tasks.md`).
- **Lifecycle_Mutating_Operation**: Any of the following task-affecting operations: `task.run()`, resume, `abortTask()`, `cancelCurrentRequest()`, `dispose`, switching the active Menagerie chat, answering an `ask`, revealing a worker editor, modifying a parent/child relationship, or altering model routing.
- **Attention_Queue**: The "Needs You" surface within the Observatory listing tasks whose latest `clineMessage` is an unanswered `ask` (waiting for user input).
- **Mastermind_Dashboard**: A parent-level overview surface summarizing worker counts, lane status, context percentage, tier ceiling, artifacts, and blockers for a Parent_Task.

## Requirements

### Requirement 1: Sidebar Tasks Surface

**User Story:** As a Menagerie user, I want a Tasks view inside the Menagerie sidebar, so that I can inspect running and completed tasks without leaving the sidebar or opening editor panels.

#### Acceptance Criteria

1. THE Observatory SHALL render as a Tasks view inside the Menagerie_Sidebar.
2. WHEN the user opens the Tasks view, THE Observatory SHALL display inspected tasks without creating a `vscode.WebviewPanel` in `ViewColumn.Beside` as the primary inspection surface.
3. WHERE the existing Task Board command is retained, THE Menagerie extension SHALL expose it only as a compatibility or debug command.
4. THE Menagerie extension SHALL retain the existing persisted identifiers and the `zoo-code.*` command identifiers for internal compatibility.
5. WHERE user-visible strings are introduced by the Observatory, THE Observatory SHALL use the product name "Menagerie".

### Requirement 2: Task Hierarchy and State Indicators

**User Story:** As a Menagerie user, I want to see the active task tree with parent and worker relationships and each task's current state, so that I can understand what the system is doing at a glance.

#### Acceptance Criteria

1. THE Observatory SHALL display the active task tree with Parent_Task and Worker_Task relationships visible.
2. WHEN a task reports `parallelParentTaskId` or `parentTaskId`, THE Observatory SHALL render that task as a child of the task identified by that parent identifier.
3. THE Observatory SHALL display a state indicator for each task distinguishing the states: queued, working, streaming, waiting for user input, completed, failed, and cancelled or stopped.
4. WHEN a task's latest `clineMessage` is an unanswered `ask`, THE Observatory SHALL display that task in the waiting-for-user-input state.
5. WHEN a task reports `isStreaming === true`, THE Observatory SHALL display that task in the streaming state.
6. WHEN a task reports `abort === true` without a recorded completion, THE Observatory SHALL display that task in the cancelled-or-stopped state.

### Requirement 3: Inspection Tabs

**User Story:** As a Menagerie user, I want to open tasks as internal tabs that I can keep open together, so that I can compare and track several tasks at once.

#### Acceptance Criteria

1. WHEN the user selects a task, THE Observatory SHALL open that task in an Inspection_Tab inside the Observatory rather than in a VS Code editor tab.
2. THE Observatory SHALL keep multiple Inspection_Tabs open simultaneously.
3. THE Observatory SHALL allow the user to pin an Inspection_Tab.
4. THE Observatory SHALL allow the user to close an Inspection_Tab.
5. WHEN the user closes an Inspection_Tab, THE Observatory SHALL leave the underlying task running and uncancelled.

### Requirement 4: Zero-Lifecycle-Side-Effect Invariant

**User Story:** As a Menagerie user, I want to be certain that inspecting a task never changes it, so that I can observe autonomous work safely without risk of disrupting it.

#### Acceptance Criteria

1. WHEN the user selects an Inspection_Tab, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
2. WHEN the user switches between Inspection_Tabs, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
3. WHEN the user expands raw events, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
4. WHEN the user refreshes the Observatory, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
5. WHEN the user filters events, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
6. WHEN the user opens a patch, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
7. WHEN the user inspects evidence, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
8. WHEN the user closes an Inspection_Tab, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.
9. THE Observatory SHALL read task state through the read-only collection pattern used by `collectTaskBoard()` across `ClineProvider.getAllInstances()` without focusing or activating any chat.
10. THE Observatory SHALL NOT change the active Menagerie chat selection as a result of any inspection action.
11. WHEN any inspection action completes, THE Observatory SHALL leave each observed task's persisted lifecycle state (status, parent/child relationship, active-chat selection, and model routing) identical to its value immediately before the action, such that a before/after comparison of these fields shows no difference.
12. IF any inspection action encounters an error during state collection or rendering, THEN THE Observatory SHALL abort that action, surface an error indication to the user, and perform zero Lifecycle_Mutating_Operations, including no fallback that resumes, aborts, disposes, or re-activates any task.
13. IF a Lifecycle_Mutating_Operation on an observed task is initiated by any source other than the Observatory while an inspection action is in progress, THEN THE Observatory SHALL NOT suppress, intercept, or alter that operation, and SHALL reflect the resulting state on the next read-only collection pass.

### Requirement 5: Task Detail Summary Header

**User Story:** As a Menagerie user, I want a sticky summary header on each inspected task, so that I can read the task's key attributes without scrolling.

#### Acceptance Criteria

1. WHEN an Inspection_Tab is open, THE Observatory SHALL display a sticky summary header for the inspected task.
2. THE Observatory SHALL display in the summary header the fields: Status, Mode, Route, Profile, Model, Reasoning, Context used, Context limit, Started, Last activity, Workspace, Parent id, and Worker id.
3. WHERE a summary header field has no available value for the inspected task, THE Observatory SHALL display that field with an explicit empty-value indicator rather than omitting the field.
4. THE Observatory SHALL source Mode from `getTaskMode()`, Profile from `getTaskApiConfigName()`, and Model from `api.getModel().id` for a LIVE_State task.

### Requirement 6: Task Detail Tabbed Views

**User Story:** As a Menagerie user, I want the inspected task's detail organized into focused views, so that I can find activity, checklist, changes, evidence, metrics, and raw events without one overwhelming stream.

#### Acceptance Criteria

1. THE Observatory SHALL present the inspected task detail as the tabbed views: Activity, Checklist, Changes, Evidence, Metrics, and Raw.
2. THE Observatory SHALL render in the Activity view a human-readable timeline of task activity.
3. THE Observatory SHALL render in the Checklist view the task's TODO state sourced from `todoList`.
4. THE Observatory SHALL render in the Changes view the files modified, patches, and Git status with a diff summary.
5. THE Observatory SHALL render in the Evidence view tests, command results, line references, URLs, screenshots, and verifier findings available for the task.
6. THE Observatory SHALL render in the Metrics view tokens, latency, route, model, context pressure, reasoning escalation, and tool counts available for the task.
7. THE Observatory SHALL render in the Raw view the complete underlying events for the task.

### Requirement 7: Large-History Responsive Presentation

**User Story:** As a Menagerie user, I want very large task histories to stay responsive, so that inspecting a long-running task does not freeze the sidebar.

#### Acceptance Criteria

1. WHEN an Inspection_Tab opens a task whose timeline contains more than 200 events, THE Observatory SHALL render the timeline using virtualized rendering such that the number of event components mounted in the DOM at any time does not exceed the count required to fill the visible viewport plus an overscan buffer of at most 20 events above and below the viewport.
2. WHEN a user requests expansion of a collapsed timeline event, THE Observatory SHALL render that event's full detail content, and SHALL NOT render the full detail content of any timeline event that the user has not expanded.
3. WHEN a user applies a timeline filter, THE Observatory SHALL display only the events matching the filter criteria and SHALL exclude all non-matching events from the rendered timeline.
4. WHEN a tool result exceeds 50 rendered lines or 10,000 characters, THE Observatory SHALL render the result collapsed with a compact summary that includes the result line count, the result size in bytes, and the outcome, and SHALL offer Preview, Expand, and Open-raw affordances.
5. THE Observatory SHALL render API request metadata in compact form by default, and WHEN the user requests the raw form, THE Observatory SHALL render the raw form.
6. THE Observatory SHALL retain at most 500 timeline events in memory for the active Inspection_Tab at any time, and SHALL evict events outside this window rather than retaining all events in memory.
7. WHILE an inspected task has an activity history of at least 50,000 characters, THE Observatory SHALL acknowledge each scroll, filter, or expand interaction by beginning to update the rendered timeline within 100 milliseconds of the interaction.
8. IF rendering a requested timeline event or tool result fails, THEN THE Observatory SHALL display an error indication for that event identifying the failure and SHALL continue rendering the remaining timeline events without freezing the Inspection_Tab.

### Requirement 8: Event-Driven Updates

**User Story:** As a Menagerie user, I want the Observatory to update promptly when a task changes, so that I see current state without waiting for a slow polling cycle.

#### Acceptance Criteria

1. WHEN a task publishes a lifecycle or activity event, THE Task_Observation_Service SHALL forward that event to the Observatory webview without issuing any command or write operation back to the task.
2. THE Menagerie extension SHALL replace the existing 5-second polling of active in-process tasks with updates delivered through the Task_Observation_Service.
3. WHEN a task commits a lifecycle or activity event, THE Observatory SHALL reflect that event within 500 milliseconds, measured from the time the event is committed by the task to the time the Observatory webview applies the corresponding state change.
4. WHERE a reconciliation fallback is enabled, THE Menagerie extension SHALL run a snapshot reconciliation at a fixed interval between 5 and 30 seconds that produces SNAPSHOT_State data.
5. WHERE a reconciliation fallback is enabled, WHEN a snapshot reconciliation completes, THE Menagerie extension SHALL reconcile the Observatory state to the SNAPSHOT_State data, replacing any event-derived state that diverges from the snapshot.
6. IF the Task_Observation_Service fails to deliver an event or the Observatory fails to process an event or snapshot, THEN THE Menagerie extension SHALL contain the failure within the Observatory, SHALL leave task execution unaffected, and SHALL surface an error indication to the user identifying that the Observatory update failed.

### Requirement 9: Persisted Inspection and Source States

**User Story:** As a Menagerie user, I want to inspect completed workers after they finish, so that I can review results without the task still running.

#### Acceptance Criteria

1. WHEN a Worker_Task has completed, THE Observatory SHALL keep that worker inspectable using the Persisted_Task_Store.
2. THE Observatory SHALL use the Persisted_Task_Store `parallel-tasks/<batch-id>/` with `manifest.json`, `worker-N.json`, and `worker-N.patch` as the persisted backing store for completed workers.
3. THE Observatory SHALL label each inspected task's source as LIVE_State, SNAPSHOT_State, or COMPLETED_State.
4. WHEN the user opens a COMPLETED_State inspection from the Persisted_Task_Store, THE Observatory SHALL present the persisted data without creating a `Task` runtime.
5. THE Observatory SHALL associate a Logical_Worker's live record and persisted record under a consistent worker identity so the worker remains inspectable across completion.

### Requirement 10: Mastermind Parent Dashboard

**User Story:** As a Menagerie user running a batch, I want a parent-level overview, so that I can judge overall batch health without opening every worker.

#### Acceptance Criteria

1. WHERE a Parent_Task has associated Worker_Tasks, THE Observatory SHOULD present a Mastermind_Dashboard for that Parent_Task.
2. THE Mastermind_Dashboard SHOULD summarize worker counts, lane status, context percentage, tier ceiling, artifacts, and blockers.
3. WHEN the user opens the Mastermind_Dashboard, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.

### Requirement 11: Attention Queue

**User Story:** As a Menagerie user, I want tasks waiting for my input gathered in one place, so that I can find and review them quickly.

#### Acceptance Criteria

1. WHEN a task is in the waiting-for-user-input state, THE Observatory SHOULD display that task in the Attention_Queue.
2. WHEN the user selects a task from the Attention_Queue, THE Observatory SHALL open that task in an Inspection_Tab.
3. WHEN the user selects a task from the Attention_Queue, THE Observatory SHALL NOT make the selected Worker_Task the active Menagerie chat.
4. WHEN the user selects a task from the Attention_Queue, THE Observatory SHALL perform zero Lifecycle_Mutating_Operations.

### Requirement 12: Error Visibility and Classification

**User Story:** As a Menagerie user, I want errors classified by category, so that I can tell a transient hiccup from a real blocker.

#### Acceptance Criteria

1. WHEN a task reports an error, THE Observatory SHALL classify the error into one of the categories: TRANSIENT, MODEL, TOOL, VALIDATION, AUTH, INFRASTRUCTURE, LOOP, or USER_INPUT_REQUIRED.
2. WHEN a task is repeatedly polling an external system such as Kubernetes, THE Observatory SHALL NOT classify that polling activity as an error.
3. WHEN a task receives repeated 401 responses without an intervening credential change, THE Observatory SHALL classify that condition as LOOP.
4. THE Observatory SHALL display the error classification alongside the inspected task's error detail.
