# Requirements: Granite-Assisted Workflows & Executable Spec Contracts

**Feature ID:** MEN-GRANITE-SDD-001  
**Target:** `celesrenata/menagerie`, `main` at `1b1b09bbc13532ea37ae5d4beb02e35dfa63d1a7` (2026-11-08 review snapshot)  
**Status:** Proposed, not implemented.  
**Owners:** Menagerie owns workflow, evidence and spec contracts; OmniRoute owns route/model placement; Granite provides bounded stateless or explicitly sticky inference.

## Problem and scope

Menagerie already has a `TaskDag`, `BoundedElasticScheduler`, scout readers, capability lanes, evidence packages, independent verification and Kiro-style specifications. However, the existing spec-orchestrator instructions are not an enforced acceptance contract; routine reader returns can be very large; and the new Granite service is not yet a measured-quality part of those pipelines. Add a **pure-analysis executor** and a **versioned spec contract/traceability layer** on top of existing components, not a new agent/scheduler/task database.

### R1 — Modes and workflow/spec relationship
1. THE SYSTEM SHALL support three workflow policies: `explore` (evidence only), `build` (just-in-time micro-spec), and `strict` (complete versioned requirements/design/tasks and enforced acceptance gates). Existing tasks SHALL retain their behavior when the feature is disabled.
2. THE SYSTEM SHALL distinguish **workflow** (event-driven execution graph and recovery) from **spec** (persisted commitments, acceptance criteria, provenance and revisions). Specs SHALL compile into existing `ExecutionPlan`/`ParallelTaskSpec` objects.
3. THE SYSTEM SHALL NOT spawn work merely to occupy a GPU; `build` SHALL permit single-worker execution for trivial changes.
4. THE SYSTEM SHALL NOT turn model-generated speculation into a verified repo fact.

### R2 — Granite operating contract
1. GIVEN the described current service, THE CLIENT SHALL treat Granite 4.2 8B as an OpenAI-style `POST /v1/chat/completions` endpoint with `stream:false`, `model:"granite-4.2-8b"`, no function calling, no native streaming, no switchable thinking mode and ignored temperature.
2. THE EXECUTOR SHALL omit `tools` and `tool_choice`; it SHALL NOT treat textual tool-role content as a structured function call or provide file-writing permissions.
3. THE EXECUTOR SHALL permit at most **2 active generations** for this service; further jobs SHALL queue with deadlines, cancellation and bounded queue length. Keep this service's capacity separate from the existing reader tier's capacity.
4. THE EXECUTOR SHALL use `32768` as the **served context window**, not the checkpoint's `131072` potential window; it SHALL reserve output and safety margin before admitting input.
5. THE EXECUTOR SHALL bound every request's `max_tokens` and refuse/compact oversize input before sending; it SHALL never silently truncate away critical requirement text.
6. THE SYSTEM SHALL make URL, model ID, rate limits and capacity configurable or discoverable through OmniRoute. No LAN IP, GPU or model placement shall be hardcoded in Menagerie routing policy.
7. THE EXECUTOR SHALL report missing capability, 429, timeout, non-JSON, invalid schema, stale evidence and cancellation as typed outcomes, not fabricated success.

### R3 — Service protocol and correctness preflight
1. BEFORE enabling Granite decision support, THE IMPLEMENTATION SHALL compare the serving chat template with checkpoint `chat_template.jinja`, verify role boundaries (`<|im_end|>`), and regression-test system-message isolation from the first user message.
2. THE IMPLEMENTATION SHALL verify the server accepts `stream:false`, selected max token budgets, request cancellation and error envelopes. It SHALL test that unsupported `stream:true` and tools are not sent.
3. Any configured startup numeric/weight-parity gate is an **inference parity check**, not an answer-quality benchmark or a substitute for end-to-end accuracy tests.
4. Fresh-request repeatability SHALL be measured, but caching SHALL use input hashes and schema/template/model versions rather than assuming resumed generations always agree near tie tokens.

### R4 — Pure analysis operations
1. THE EXECUTOR SHALL initially support `extract-requirements`, `extract-code-contract`, `summarize-evidence`, `find-contradictions`, `classify-change-risk`, `map-acceptance-to-tests`, `triage-test-failure`, and `review-diff-against-criteria` as typed operations.
2. These are **bounded transformations of supplied material**. File discovery, repo I/O, dependency traversal, test execution and actual edits remain with existing tool-capable workers, retrieval and test runners.
3. THE SYSTEM SHALL Zod-validate each JSON response, validate file/line citations against the current workspace snapshot, and record `unknown` rather than inventing missing citations or passing criteria by assertion.
4. Outputs SHALL include source provenance (`workspace`, Git revision or file digest, path, line range), schema version, operation, model ID and uncertainties.
5. Parsing retries SHALL be bounded; a format failure can be retried once with a stable correction prompt, then escalated or marked unavailable. A retry SHALL NOT erase an earlier failure.

### R5 — Evidence and cache
1. THE SYSTEM SHALL reuse existing retrieval gateway, `scoutReaders`, `ReaderFinding` and `PreparedContextWorkPackage`; it SHALL never insert raw reader transcripts into the parent as a substitute for typed findings.
2. It SHALL store full reports separately, and return **configurable per-operation summaries** (initial target 2–4 KiB, never silently assume the current 64,000-character reader ceiling is the ideal analysis cap).
3. Evidence SHALL become stale if the cited blob/line content, relevant spec revision or referenced test result changes. A stale item SHALL not justify an automatic PASS.
4. Inference result cache keys SHALL include operation, canonicalized inputs, file digests or revision, exact prompt/template and schema versions, model ID and relevant runtime configuration. Unrelated task content SHALL never share a cache entry.
5. Prefix-cache optimization SHALL be opportunistic: preserve exact message prefixes within explicitly sticky conversations, allow at most two cached slots, and NEVER rely on persistence, LRU placement or cached answers for correctness.

### R6 — Executable specification contracts
1. THE SYSTEM SHALL persist an immutable **SpecRevision** for each approved baseline, with requirement IDs, acceptance IDs, design decisions, task IDs, dependencies, source references and a content digest.
2. A SPEC SHALL carry a traceability graph: `requirement → design decision → task → acceptance criterion → executable check → evidence artifact`.
3. THE COMPILER SHALL reject duplicate IDs, missing references, dependency cycles, undefined checks, contradictory constraints and unapproved changes to frozen contracts.
4. THE COMPILER SHALL produce the existing `ExecutionPlan` and additive `ParallelTaskSpec` fields; no second independent task/DAG lifecycle or scheduler is permitted.
5. Editing a frozen spec SHALL create a new revision and mark affected dependent checks and evidence stale rather than mutating history.
6. Generate or refresh `requirements.md`, `design.md`, `tasks.md` in existing `.kiro/specs/<slug>/` format and preserve human-authored sections/edits using conflict detection.
7. Kiro markdown checkboxes SHALL reflect actual run state only after corresponding evidence is recorded; no text-only claim of completion qualifies.

### R7 — Planning, escalation and isolation
1. A capable planner SHALL decide architecture, ambiguous business intent, cross-subsystem tradeoffs, critical risk and remediation. Granite SHALL assist by extracting evidence and detecting obvious contradictions; it is not the mastermind.
2. The policy SHALL integrate with `readerEscalationDecision.ts` and `glmInvocationGate.ts`; low confidence, contradictions, missing evidence or complex dependency analysis can promote the task to a deeper capable reader/architect.
3. Tool-capable `project-reader` workers SHALL continue to perform discovery. Granite SHALL consume the prepared excerpts without masquerading as an autonomous tool-calling `project-reader`.
4. The existing Capability Broker SHALL enforce tool rights on workers; the pure-analysis executor SHALL receive no tools at all. No change shall grant unapproved write/deploy/secret access.
5. The existing per-generation lease and OmniRoute backpressure semantics SHALL remain intact. Do not change lifetime/ownership of tasks when a UI panel is closed.

### R8 — Verification and release gates
1. A check requiring an actual command/test SHALL be decided from test runner exit status and associated artifacts, NOT from Granite prose.
2. Granite's `review-diff-against-criteria` SHALL be **advisory** and may flag concerns, but SHALL NOT be the sole independent verifier or a source of positive PASS.
3. In `strict`, all required acceptance criteria need fresh evidence and a passing `verificationGate.ts` result before a spec task is marked verified; missing evidence means blocked/not verified.
4. A failing check SHALL produce a bounded fixer loop using existing logic; every retry SHALL be linked to the requirement and retain previous evidence.
5. Source-of-truth requirement coverage and gate outcomes SHALL be computed deterministically; the model may suggest links but not authoritatively assert them.

### R9 — UI, observability and provenance
1. The task board/Observatory SHALL show spec revision, current phase, `requirements covered / total`, test evidence, stale findings, open questions, blocked criteria, retries and analysis queue pressure.
2. Views SHALL be read-only with respect to task lifecycle unless invoking existing validated command routes. Closing a view SHALL NOT cancel a task.
3. Log/metrics SHALL cover queue wait, prefill, decode, tokens, cache hit rate, validation failures, escalation, evidence invalidation and gate outcomes, without logging source/credentials by default.
4. Settings SHALL follow `AGENTS.md`'s complete persisted-settings round trip including `cachedState`, `ContextProxy`, `getState()` and `getStateToPostToWebview()`.

### R10 — Tests, benchmarks and go/no-go
1. THE FEATURE SHALL ship behind a default-off flag until tested. Fixtures SHALL include ordinary code, stale citations, conflicting requirements, irrelevant files, malicious prompt instructions inside a source document, malformed JSON, near-tie outputs and failing tests.
2. A golden-set evaluation SHALL report schema-valid rate, evidence citation precision, requirement coverage recall, contradiction precision, false PASS rate, escalation quality, median/p95 latency and token cost versus the existing reader path.
3. Suggested **release gates** (adjust after measuring baseline): 100% required checks grounded in executable evidence; zero observed false PASS on gate regression fixtures; ≥99% schema-valid after at most one bounded retry; ≥95% citation validity on curated easy cases; no significant regression to existing test suites. Quality claims require measured results, not model reputation.
4. THE SYSTEM SHALL run `pnpm check-types`, relevant unit/integration suites, `pnpm lifecycle:model-check`, `pnpm fanout-protocol:model-check`, and the touched-file ESLint checks. Host-level E2E is required for real VS Code messaging/persistence, not for pure schema code.

## Out of scope
Training or finetuning Granite; changing its inference kernels; native streaming/tool calling; direct GPU placement in Menagerie; a second retrieval DB; automatically deploying changes without approval; modifying OmniRoute's serving configuration in this Menagerie-only feature; treating model-suggested passing tests as actually run.
