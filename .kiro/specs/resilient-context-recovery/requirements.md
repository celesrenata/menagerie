# Requirements Document

## Introduction

This feature is the Resilient Context Recovery amendment to the Menagerie Autonomous Operations Lift. It defines a `Resilient_Context_Recovery` capability that guarantees a task whose conversation transcript has outgrown its serving context window can either recover under that window within a bounded budget or terminate cleanly with a classified terminal error — rather than entering an unrecoverable, infinitely retrying failure spiral.

This spec is motivated by a live production incident. A parallel reader worker bound to the `reader.fast` Capability_Lane (OmniRoute route `hybrid/fast`, served window 32768 tokens per `OMNIROUTE_ROUTE_CONTEXT_WINDOWS` in `src/api/providers/omniroute.ts`) accumulated a transcript of roughly 360,000 tokens and never recovered. Every API request returned a context-window error, and because parallel workers always auto-retry and no operator can answer their `api_req_failed` ask, the worker retried relentlessly until the batch stalled. A code trace identified two root causes that this spec exists to close:

- **Lane-independence defect (R1).** Context recovery routes its own recovery LLM call through the same handler and lane as the failing task. Auto-condense flows from `manageContext()` in `src/core/context-management/index.ts` into `summarizeConversation()` in `src/core/condense/index.ts`, which takes a single `apiHandler` and calls `apiHandler.createMessage(...)`. In `src/core/task/Task.ts`, `getCondensingApiHandler()` falls back to the task's own handler (`this.api`) whenever no dedicated condensing profile (`condensingApiConfigId`) is configured. The summarize request must carry the oversized history as its input, so on a lane whose model cannot hold that history the summarize request itself fails, and `manageContext` degrades to sliding-window truncation. A task on a too-small lane can therefore never summarize its way out.
- **Convergence defect (R2).** `handleContextWindowExceededError()` in `src/core/task/Task.ts` responds to a context-window error by force-truncating to `FORCED_CONTEXT_REDUCTION_PERCENT = 75` (keep 75%, drop 25%) and retrying, capped at `MAX_CONTEXT_WINDOW_RETRIES = 3`. From a 360K transcript, three 25% reductions reach roughly 152K — still about five times a 32K window. The reduction targets a fixed percentage of current size rather than the servable window, and the retry budget cannot close a large multiplicative gap. Each forced attempt also tries a summarize first, which fails on the same lane for the reason in R1.

This spec cross-references four sibling specs and interacts with their contracts without redefining them:

- **capability-lanes-routing**: Defines the four Capability_Lanes (`reader.fast`, `reader.deep`, `coder.primary`, `reasoning.escalation`) and the principle that OmniRoute owns the lane-to-model/hardware mapping. This spec consumes the lane-to-window relationship (a lane's served context window is a property OmniRoute exposes, as in `resolveOmniRouteContextWindow`) and defines recovery behavior relative to that window — but does NOT change lane selection, lane-to-model mapping, or the reason a task is on a given lane.
- **progress-aware-loop-detection**: Defines the `Progress_Aware_Loop_Detector` and the absolute turn/transcript backstop. This spec addresses recovery from context-window overflow specifically; it does NOT add an absolute turn or transcript backstop, which remains that spec's concern.
- **elastic-parallel-execution**: Defines the `Bounded_Elastic_Scheduler`, parallel worker retry behavior, and worker termination/self-fail semantics (the `PARALLEL_WORKER_MAX_API_RETRIES` budget and the parallel-worker auto-retry contract). This spec defines the terminal, non-recoverable classification a worker reaches when recovery cannot converge, and relies on that spec's self-fail mechanics to unblock the batch.
- **mastermind-execution-metadata**: Defines the `WorkerResult` contract. This spec emits recovery telemetry and a terminal-failure classification as additive metadata consistent with that contract — but does NOT modify or remove existing `WorkerResult` fields.

### Non-Goals

- The system MUST NOT change OmniRoute routing configuration or the lane-to-model mapping; OmniRoute owns the silicon and the served context window of each route.
- The system MUST NOT modify the `RouteCapability` enum or the scheduler mechanics defined in elastic-parallel-execution.
- The system MUST NOT redefine the `WorkerResult` base contract defined in mastermind-execution-metadata; recovery metadata extensions are additive only.
- This spec does NOT change WHY a task is assigned to a given Capability_Lane; lane selection is the concern of capability-lanes-routing.
- This spec does NOT add an absolute turn or transcript backstop; that backstop is the concern of progress-aware-loop-detection.
- This spec does NOT define the summarization prompt, the truncation algorithm's internal structure, or the implementation of any recovery mechanism; it states only what recovery MUST guarantee.

## Glossary

- **Resilient_Context_Recovery**: The capability that brings an over-window conversation transcript under its serving context window within a bounded budget, or, failing that, terminates the task with a classified terminal error instead of an unbounded retry loop.
- **Served_Context_Window**: The maximum input context, in tokens, that the model currently mapped to a task's Capability_Lane can accept for a single request, as exposed by OmniRoute (for example `OMNIROUTE_ROUTE_CONTEXT_WINDOWS` resolved via `resolveOmniRouteContextWindow` in `src/api/providers/omniroute.ts`). The Served_Context_Window is an OmniRoute-owned property and is not hard-coded into recovery logic.
- **Output_Reserve**: The portion of the Served_Context_Window reserved for the model's response (the maximum output tokens for the request), which recovery subtracts from the Served_Context_Window when computing the Servable_Input_Budget.
- **Servable_Input_Budget**: The Served_Context_Window minus the Output_Reserve — the maximum input the recovery target may occupy so that a subsequent request fits. This is the convergence target for forced reduction.
- **Failing_Task**: The task or parallel worker whose request exceeded its Served_Context_Window and triggered recovery.
- **Recovery_Handler**: The API handler through which a recovery LLM call (summarization) executes. The Recovery_Handler MAY differ from the Failing_Task's own handler.
- **Lane_Independent_Recovery**: The property that the Recovery_Handler is selected so its context window can carry the recovery input, independent of the (possibly too-small) lane the Failing_Task runs on.
- **Large_Context_Recovery_Handler**: A Recovery_Handler whose context window is large enough to carry the recovery input for the current transcript. When no such handler is available, recovery uses Deterministic_Reduction instead.
- **Deterministic_Reduction**: A non-LLM reduction of the transcript (for example bounded truncation) that depends on no model and no Capability_Lane, used as the fallback when no Large_Context_Recovery_Handler is available and as the mechanism that guarantees convergence toward the Servable_Input_Budget.
- **Convergent_Reduction**: Forced reduction that targets the Servable_Input_Budget rather than a fixed percentage of current size, so that a single pass or a bounded number of passes provably brings the transcript to or below the Servable_Input_Budget.
- **Recovery_Input_Bound**: The upper bound on the input handed to the summarizer, ensuring a summarization call never itself exceeds the Recovery_Handler's context window; input over this bound is pre-reduced before summarization.
- **Over_Size_Ratio**: The ratio of the current transcript token count to the Servable_Input_Budget, describing how far over the window a transcript is.
- **Recovery_Budget**: The maximum number of recovery passes (or the single-pass convergence guarantee) allotted to bring a transcript to or below the Servable_Input_Budget before the Failing_Task is declared non-recoverable.
- **Terminal_Non_Recoverable_Error**: The classified terminal outcome emitted when recovery cannot bring the transcript to or below the Servable_Input_Budget within the Recovery_Budget. A Failing_Task reaching this outcome stops retrying and, if it is a parallel worker, self-fails cleanly.
- **Recovery_Telemetry**: The machine-readable record of recovery activity — attempts, chosen Recovery_Handler and path, pre- and post-reduction token sizes, convergence outcome, and Terminal_Non_Recoverable_Error events.

## Requirements

### Section 1 — Lane-Independent Recovery

### Requirement 1: Recovery executes on a handler sized for the recovery input

**User Story:** As a Menagerie operator, I want the condense/summarize call to run on a handler whose context window can hold the recovery input, so that a task on a too-small lane is not forced to summarize through the same lane it is trying to escape.

#### Acceptance Criteria

1. WHEN Resilient_Context_Recovery performs a summarization LLM call, THE Resilient_Context_Recovery capability SHALL select a Recovery_Handler whose context window is large enough to carry the recovery input.
2. THE Resilient_Context_Recovery capability SHALL select the Recovery_Handler independently of the Served_Context_Window of the Capability_Lane on which the Failing_Task runs.
3. IF no Large_Context_Recovery_Handler is available, THEN THE Resilient_Context_Recovery capability SHALL fall back to Deterministic_Reduction that depends on no Capability_Lane and no model.
4. THE Resilient_Context_Recovery capability SHALL NOT require the summarization LLM call to execute on the Failing_Task's own handler when that handler's context window is smaller than the recovery input.
5. WHERE a dedicated large-context recovery profile is configured, THE Resilient_Context_Recovery capability SHALL use that profile as the Large_Context_Recovery_Handler for the summarization call.

### Section 2 — Convergent Reduction

### Requirement 2: Forced reduction targets the servable input budget

**User Story:** As a Menagerie operator, I want forced reduction to shrink the transcript toward the servable window rather than by a fixed percentage of current size, so that recovery provably reaches a size the lane can serve.

#### Acceptance Criteria

1. THE Resilient_Context_Recovery capability SHALL compute the Servable_Input_Budget as the Served_Context_Window of the Failing_Task's Capability_Lane minus the Output_Reserve.
2. WHEN the transcript token count exceeds the Servable_Input_Budget, THE Resilient_Context_Recovery capability SHALL reduce the transcript toward the Servable_Input_Budget rather than by a fixed percentage of the current transcript size.
3. WHEN Convergent_Reduction completes a reduction pass, THE Resilient_Context_Recovery capability SHALL produce a transcript whose token count is at or below the Servable_Input_Budget, OR SHALL perform a bounded number of further passes that provably reach the Servable_Input_Budget.
4. THE Resilient_Context_Recovery capability SHALL derive the reduction target from the Served_Context_Window exposed by OmniRoute and SHALL NOT hard-code any fixed context-window size into the reduction target.
5. THE Resilient_Context_Recovery capability SHALL apply Deterministic_Reduction when a summarization reduction fails or does not reach the Servable_Input_Budget, so that convergence does not depend on a successful LLM call.

### Section 3 — Retry Budget Sized to the Gap

### Requirement 3: Recovery budget is sufficient to close the over-size ratio

**User Story:** As a Menagerie operator, I want the recovery retry budget sized to the observed over-size ratio, so that a worker does not exhaust its retries while still over the window.

#### Acceptance Criteria

1. THE Resilient_Context_Recovery capability SHALL size the Recovery_Budget so that it is sufficient to reduce the transcript from the observed Over_Size_Ratio to at or below the Servable_Input_Budget, OR SHALL guarantee that a single Convergent_Reduction pass reaches the Servable_Input_Budget.
2. THE Resilient_Context_Recovery capability SHALL NOT allow a Failing_Task to exhaust its Recovery_Budget while the transcript remains above the Servable_Input_Budget AND further reduction remains possible.
3. WHEN the Over_Size_Ratio is large enough that a fixed small number of fixed-percentage passes cannot close the gap, THE Resilient_Context_Recovery capability SHALL rely on Convergent_Reduction toward the Servable_Input_Budget rather than on repeated fixed-percentage reductions.
4. THE Resilient_Context_Recovery capability SHALL treat the Recovery_Budget as a function of the gap between the transcript size and the Servable_Input_Budget rather than as a fixed constant independent of that gap.

### Section 4 — Recovery-Input Bound

### Requirement 4: The summarizer input is bounded to the recovery handler window

**User Story:** As a Menagerie operator, I want the input handed to the summarizer bounded to the recovery handler's window, so that the recovery call itself never overflows.

#### Acceptance Criteria

1. THE Resilient_Context_Recovery capability SHALL bound the input handed to the summarization call to at or below the Recovery_Input_Bound for the selected Recovery_Handler.
2. WHEN the recovery input exceeds the Recovery_Input_Bound, THE Resilient_Context_Recovery capability SHALL pre-reduce the input through Deterministic_Reduction before performing the summarization call.
3. THE Resilient_Context_Recovery capability SHALL derive the Recovery_Input_Bound from the context window of the selected Recovery_Handler.
4. THE Resilient_Context_Recovery capability SHALL NOT issue a summarization call whose input is known to exceed the Recovery_Handler's context window.

### Section 5 — Non-Recoverable Terminal Behavior

### Requirement 5: Terminate cleanly when recovery cannot converge

**User Story:** As a Menagerie operator, I want a task that cannot be brought under its window to terminate with a classified terminal error, so that a parallel worker self-fails cleanly instead of blocking the batch in an infinite retry loop.

#### Acceptance Criteria

1. WHEN Resilient_Context_Recovery cannot bring the transcript to or below the Servable_Input_Budget within the Recovery_Budget, THE Resilient_Context_Recovery capability SHALL terminate the Failing_Task with a Terminal_Non_Recoverable_Error.
2. WHEN a Terminal_Non_Recoverable_Error is declared, THE Resilient_Context_Recovery capability SHALL stop further automatic retries of the Failing_Task's request.
3. WHEN a Terminal_Non_Recoverable_Error is declared for a parallel worker, THE parallel worker SHALL self-fail cleanly using the parallel-worker termination semantics defined in elastic-parallel-execution so that the batch is not blocked.
4. THE Terminal_Non_Recoverable_Error SHALL carry a classification identifying the failure as a non-recoverable context-window overflow, distinct from a transient API failure.
5. THE Resilient_Context_Recovery capability SHALL NOT allow a context-window overflow to produce an unbounded sequence of automatic retries.

### Section 6 — Observability

### Requirement 6: Emit recovery telemetry

**User Story:** As a Menagerie operator, I want recovery activity emitted as metrics and telemetry, so that I can observe which recovery path was taken, how far the transcript was reduced, and when a task terminated as non-recoverable.

#### Acceptance Criteria

1. WHEN Resilient_Context_Recovery performs a recovery attempt, THE Resilient_Context_Recovery capability SHALL emit Recovery_Telemetry recording that the attempt occurred.
2. THE Recovery_Telemetry SHALL record the chosen Recovery_Handler and whether recovery used a Large_Context_Recovery_Handler or Deterministic_Reduction.
3. THE Recovery_Telemetry SHALL record the pre-reduction and post-reduction transcript token sizes for each recovery attempt.
4. WHEN a Terminal_Non_Recoverable_Error is declared, THE Resilient_Context_Recovery capability SHALL emit a Recovery_Telemetry event recording the terminal non-recoverable outcome.
5. THE Recovery_Telemetry SHALL be emitted as additive metadata consistent with the `WorkerResult` contract defined in mastermind-execution-metadata and SHALL NOT modify or remove existing `WorkerResult` fields.
6. THE Resilient_Context_Recovery capability SHALL NOT inject Recovery_Telemetry verbatim into the parent model's conversation history.
