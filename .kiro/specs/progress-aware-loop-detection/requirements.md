# Requirements Document

## Introduction

This feature (FEAT-002 of the Menagerie Autonomous Operations Lift) replaces the current exact-repetition loop detector with a progress-aware, state-aware detector. The existing `ToolRepetitionDetector` (`src/core/tools/ToolRepetitionDetector.ts`) counts consecutive identical serialized tool calls and intervenes at a fixed count (default limit 3, escalation at 2x). That design cannot distinguish legitimate iterative work (paging through a file, polling a Kubernetes resource, re-running a test suite that is now passing more tests) from genuine stagnation, because repetition of a tool name or serialized argument object is not evidence of stuck behavior.

The new Progress_Aware_Loop_Detector evaluates each tool execution across four phases (`beforeTool`, `executeTool`, `afterTool`, `evaluateProgress`) and maintains a per-task Iteration_State. It derives a Progress_Signal or Stagnation_Signal from observable tool, result, and workspace state, accumulates a No_Progress_Score, and escalates through graduated bands (continue, nudge, replanning, hard stop). The detector intervenes only on demonstrable lack of progress, never on mere repetition for Iterative_Capable_Tools, while still firing a Hard_Stop against genuine infinite loops.

The detector preserves a result contract compatible with the existing `ToolRepetitionCheckResult` so current call sites (notably `src/core/assistant-message/presentAssistantMessage.ts`) continue to work without changes to their branching on `allowExecution`, `nudge`, and `askUser`.

This spec is scoped only to loop detection. Task observatory, tier semantics, semantic retrieval, branding, parallelism, and metrics-as-features are separate specs. Metrics emitted for nudge and stop events are described only as outputs of this detector.

## Glossary

- **Progress_Aware_Loop_Detector**: The replacement detector class that evaluates progress across four phases per tool execution and produces an escalation decision. Successor to `ToolRepetitionDetector`.
- **Iteration_State**: The per-task record describing the most recent evaluated tool execution and the progress flags derived from it. Fields: `tool` (tool name), `normalizedArgsHash`, `resultHash?`, `cursor?` (string or number), `target?`, `errorClass?`, `workspaceChanged`, `todoChanged`, `resultChanged`, `cursorAdvanced`, `noProgressScore`.
- **No_Progress_Score** (`noProgressScore`): A non-negative integer, accumulated per task, that measures accumulated evidence of lack of progress across completed tool executions. Progress reduces the score; stagnation increases it. Determines the escalation band.
- **Iterative_Capable_Tool**: A tool whose repeated invocation is a normal part of making progress and therefore MUST NOT be blocked on repetition alone. The explicit set is: `read_file`, `read_command_output`, `codebase_search`, `search_files`, browser interaction tools (`browser_action`), kubectl/watch-style commands, test runners, and polling operations.
- **Progress_Signal**: An observable change, derived from tool arguments, results, or workspace state, that indicates work is advancing. A Progress_Signal decreases the No_Progress_Score.
- **Stagnation_Signal**: An observable condition, derived from tool arguments, results, or workspace state, that indicates work is not advancing. A Stagnation_Signal increases the No_Progress_Score.
- **Nudge**: A non-blocking internal intervention that returns an advisory result to the model without surfacing a user-facing stop, so the model can adjust approach and continue.
- **Replanning**: An intervention band that requires the model to adopt a different approach or produce a revised plan before continuing, triggered by sustained lack of progress.
- **Hard_Stop**: A terminal intervention that halts the loop and surfaces a loop condition to the user, reserved for evidence of no progress across multiple completed tool executions.
- **normalizedArgsHash**: A stable hash of the tool's arguments after normalization (canonical key ordering and relevant field selection), used to compare argument identity across executions independent of serialization order.
- **resultHash**: A stable hash of the tool execution result, used to detect whether result contents changed between executions.
- **cursor**: A string or numeric position (for example a read offset, pagination token, or line range) extracted from a tool's arguments or result that advances when iterative progress is made.

## Requirements

### Requirement 1: Four-Phase Progress Evaluation

**User Story:** As a Menagerie maintainer, I want loop detection evaluated across four phases around each tool execution, so that progress is judged from execution outcomes rather than from pre-execution call shape alone.

#### Acceptance Criteria

1. THE Progress_Aware_Loop_Detector SHALL expose four phase operations named `beforeTool`, `executeTool`, `afterTool`, and `evaluateProgress`.
2. WHEN a tool execution is initiated, THE Progress_Aware_Loop_Detector SHALL invoke `beforeTool` to capture the pre-execution Iteration_State inputs before `executeTool` runs.
3. WHEN a tool execution completes, THE Progress_Aware_Loop_Detector SHALL invoke `afterTool` to capture the post-execution result and workspace state.
4. WHEN `afterTool` has captured post-execution state, THE Progress_Aware_Loop_Detector SHALL invoke `evaluateProgress` to update the No_Progress_Score and determine the escalation band.
5. WHEN the same tool is invoked multiple times, THE Progress_Aware_Loop_Detector SHALL base its decision on the No_Progress_Score derived from observed Progress_Signals and Stagnation_Signals rather than on the count of identical invocations.

### Requirement 2: Per-Task Iteration State Model

**User Story:** As a Menagerie maintainer, I want a structured per-task Iteration_State, so that progress is tracked from observable fields and compared across executions.

#### Acceptance Criteria

1. THE Progress_Aware_Loop_Detector SHALL maintain one Iteration_State record per task.
2. THE Iteration_State SHALL contain the fields `tool`, `normalizedArgsHash`, `resultHash`, `cursor`, `target`, `errorClass`, `workspaceChanged`, `todoChanged`, `resultChanged`, `cursorAdvanced`, and `noProgressScore`.
3. THE Iteration_State SHALL treat `resultHash`, `cursor`, `target`, and `errorClass` as optional fields.
4. WHEN `evaluateProgress` completes for a tool execution, THE Progress_Aware_Loop_Detector SHALL update the Iteration_State to reflect the most recent evaluated execution.
5. WHEN comparing the current tool arguments to the previous execution, THE Progress_Aware_Loop_Detector SHALL compare `normalizedArgsHash` values so that arguments differing only in serialization order are treated as identical.

### Requirement 3: Progress Signals Decrease Suspicion

**User Story:** As a Menagerie maintainer, I want observable progress to lower loop suspicion, so that legitimate iterative work is never treated as a loop.

#### Acceptance Criteria

1. WHEN a read offset or cursor advances between two executions of the same tool, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
2. WHEN a tool targets a different file, line range, or `target` than the previous execution, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
3. WHEN a search query changes meaningfully between executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
4. WHEN the `resultHash` differs from the previous execution of the same tool, THE Progress_Aware_Loop_Detector SHALL set `resultChanged` to true and decrease the No_Progress_Score.
5. WHEN Git or worktree state changes between executions, THE Progress_Aware_Loop_Detector SHALL set `workspaceChanged` to true and decrease the No_Progress_Score.
6. WHEN the checklist (todo) state changes between executions, THE Progress_Aware_Loop_Detector SHALL set `todoChanged` to true and decrease the No_Progress_Score.
7. WHEN the external state of a command changes between executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
8. WHEN the set of failing tests changes between test runner executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
9. WHEN the number of failing tests decreases between test runner executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
10. WHEN a Kubernetes resource state changes between executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
11. WHEN browser state or observable DOM content changes between browser interaction executions, THE Progress_Aware_Loop_Detector SHALL record a Progress_Signal and decrease the No_Progress_Score.
12. WHEN a pagination token or cursor advances between executions, THE Progress_Aware_Loop_Detector SHALL set `cursorAdvanced` to true and decrease the No_Progress_Score.
13. WHERE an execution is part of an explicit wait or poll workflow, THE Progress_Aware_Loop_Detector SHALL treat the repeated execution as a Progress_Signal and refrain from increasing the No_Progress_Score for repetition alone.

### Requirement 4: Stagnation Signals Increase Suspicion

**User Story:** As a Menagerie maintainer, I want observable stagnation to raise loop suspicion, so that genuine lack of progress is detected.

#### Acceptance Criteria

1. WHEN a tool is executed with an identical `normalizedArgsHash` and produces an identical `resultHash` as the previous execution, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
2. WHEN a tool produces an identical `errorClass` as the previous execution without an intervening Progress_Signal, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
3. WHEN a mutation tool is executed and the workspace diff is empty for a repeated attempt, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
4. WHEN a repeated search produces an identical result set, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
5. WHEN an authentication failure is retried without new credentials, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
6. WHEN the same malformed edit is repeated, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
7. WHEN a command is repeated while its external state is unchanged, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.
8. WHEN a tool execution claims an action succeeded while verification indicates otherwise, THE Progress_Aware_Loop_Detector SHALL record a Stagnation_Signal and increase the No_Progress_Score.

### Requirement 5: Iterative-Capable Tools Are Not Blocked on Repetition Alone

**User Story:** As a Menagerie maintainer, I want iterative-capable tools exempt from repetition-only blocking, so that paging, polling, and re-running tests are never mistaken for loops.

#### Acceptance Criteria

1. THE Progress_Aware_Loop_Detector SHALL classify `read_file`, `read_command_output`, `codebase_search`, `search_files`, `browser_action`, kubectl/watch-style commands, test runners, and polling operations as Iterative_Capable_Tools.
2. WHILE an executing tool is classified as an Iterative_Capable_Tool, THE Progress_Aware_Loop_Detector SHALL allow repeated execution without raising an intervention when any Progress_Signal is present.
3. IF an Iterative_Capable_Tool repeats without any Progress_Signal, THEN THE Progress_Aware_Loop_Detector SHALL increase the No_Progress_Score through Stagnation_Signals rather than through a repetition count.
4. THE Progress_Aware_Loop_Detector SHALL base any intervention on an Iterative_Capable_Tool on the No_Progress_Score rather than on the number of identical invocations.

### Requirement 6: Escalation Thresholds on No-Progress Score

**User Story:** As a Menagerie maintainer, I want graduated escalation bands keyed to the No_Progress_Score, so that intervention strength matches the evidence of stagnation.

#### Acceptance Criteria

1. THE Progress_Aware_Loop_Detector SHALL maintain the No_Progress_Score as a non-negative integer per task, bounded to the range 0 to 100 inclusive, incremented by stagnation signals and decremented by progress signals, and clamped to this range.
2. WHEN a tool execution completes (the tool call has returned a result, whether success or failure, and is no longer in flight), THE Progress_Aware_Loop_Detector SHALL re-evaluate the current escalation band from the updated No_Progress_Score before the next tool execution begins.
3. WHILE the No_Progress_Score is in the range 0 to 5 inclusive, THE Progress_Aware_Loop_Detector SHALL allow execution to continue without intervention.
4. WHILE the No_Progress_Score is in the range 6 to 9 inclusive, THE Progress_Aware_Loop_Detector SHALL issue exactly one internal model Nudge per entry into this band.
5. WHILE the No_Progress_Score is in the range 10 to 13 inclusive, THE Progress_Aware_Loop_Detector SHALL require Replanning with a different approach before permitting the next tool execution.
6. IF the No_Progress_Score decreases such that it crosses below the lower boundary of the current band, THEN THE Progress_Aware_Loop_Detector SHALL transition to the band corresponding to the decreased score and apply that band's response on the next evaluation, cancelling any pending higher-band intervention that has not yet been issued.
7. IF the No_Progress_Score is 14 or greater AND no-progress evidence has accumulated across at least two completed tool executions within the current task, THEN THE Progress_Aware_Loop_Detector SHALL issue a Hard_Stop and surface the loop condition with an indication identifying the repeated tool executions that constitute the loop.
8. IF the No_Progress_Score is 14 or greater but no-progress evidence has accumulated across fewer than two completed tool executions, THEN THE Progress_Aware_Loop_Detector SHALL withhold the Hard_Stop and continue evaluating subsequent completed tool executions.
9. WHEN a tool name or serialized argument object has repeated three times while the No_Progress_Score remains in the range 0 to 5 inclusive, THE Progress_Aware_Loop_Detector SHALL allow execution to continue without intervention.

### Requirement 7: Preserve Genuine Infinite Loop Safety

**User Story:** As a Menagerie maintainer, I want the hard stop to still fire on genuine stagnation, so that true infinite loops remain bounded.

#### Acceptance Criteria

1. WHEN a tool execution accumulates Stagnation_Signals across multiple completed executions and the No_Progress_Score reaches 14 or greater, THE Progress_Aware_Loop_Detector SHALL issue a Hard_Stop.
2. WHILE no Progress_Signal is observed across successive executions of the same tool with identical arguments and identical results, THE Progress_Aware_Loop_Detector SHALL continue to increase the No_Progress_Score until a Hard_Stop is reached.
3. THE Progress_Aware_Loop_Detector SHALL derive all progress and stagnation determinations from observable tool arguments, results, and workspace state rather than from model self-reported progress.

### Requirement 8: Compatible Result Contract

**User Story:** As a Menagerie maintainer, I want the new detector to preserve the existing result contract, so that current call sites keep working without modification.

#### Acceptance Criteria

1. THE Progress_Aware_Loop_Detector SHALL return a result compatible with `ToolRepetitionCheckResult`, exposing the discriminated fields `allowExecution`, `nudge`, and `askUser`.
2. WHEN the No_Progress_Score is below the Nudge band, THE Progress_Aware_Loop_Detector SHALL return a result with `allowExecution` set to true.
3. WHEN the No_Progress_Score is in the Nudge band, THE Progress_Aware_Loop_Detector SHALL return a result with `allowExecution` set to false and a `nudge` payload containing `toolName` and `repeatCount`.
4. WHEN the No_Progress_Score reaches the Hard_Stop band, THE Progress_Aware_Loop_Detector SHALL return a result with `allowExecution` set to false and an `askUser` payload with `messageKey` equal to `mistake_limit_reached` and a populated `messageDetail`.
5. THE Progress_Aware_Loop_Detector SHALL accept a `ToolUse` value (fields `name`, `params`, `nativeArgs`) as execution input so that existing call sites in `presentAssistantMessage.ts` require no signature change.

### Requirement 9: Nudge and Stop Metrics Output

**User Story:** As a Menagerie maintainer, I want nudge and stop events emitted as metrics outputs, so that loop interventions are observable without expanding this feature's scope.

#### Acceptance Criteria

1. WHEN the Progress_Aware_Loop_Detector issues a Nudge, THE Progress_Aware_Loop_Detector SHALL emit a nudge metric output that includes the tool name and the No_Progress_Score.
2. WHEN the Progress_Aware_Loop_Detector issues a Hard_Stop, THE Progress_Aware_Loop_Detector SHALL emit a stop metric output that includes the tool name and the No_Progress_Score.
