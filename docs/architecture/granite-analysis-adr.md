# ADR: Granite analysis executor and executable spec contracts

Status: accepted for opt-in use, default off. Spec: `.kiro/specs/granite-workflow-contracts/` (MEN-GRANITE-SDD-001).

## Decision
Menagerie adds a **bounded, non-streaming, tool-less JSON analysis executor** and a **versioned spec contract layer**
on top of the existing DAG, scheduler, capability lanes, retrieval, verification gate and task lifecycle.
It does not add an agent, scheduler or task database. Granite never replaces the tool-capable `project-reader`.

## Roles
- Tool-capable `project-reader` workers still discover code. Granite only transforms excerpts they cite.
- Evidence reaches Granite only through `evidenceAdapter.ts`, which re-reads the file, pins its sha256 and rejects
  stale, unsafe, out-of-range or oversize items. A scout's claims are never forwarded as evidence.
- Every model citation is validated against the request's anchors; unsupported claims are suppressed or `unknown`.
- A model assertion can never be evidence that a check passed. `SpecEvidenceRecord.source` has no model member;
  `runnerEvidence()` takes only an exit code and artifact digest; `SpecGate` PASS needs fresh passing runner or
  verifier-gate artifacts for every required criterion, plus the existing verifier gate, plus approval in `strict`.

## Protocol limits (from the operator-reported service, verified in `docs/performance/granite-analysis-baseline.md`)
- Served window 32,768 tokens (the checkpoint's 131,072 is not served). Output reserve and a 10% margin are
  deducted before admission; oversize input is refused or chunked, never silently truncated.
- `stream:false`, no `tools`/`tool_choice`/`temperature`. The live service accepts `stream:true` and `tools`
  without error, so these are enforced by the client, not trusted to the server. Leaving tools out is a design choice,
  not a service limit: the live service can emit structured `tool_calls` (see "Tool-call probe" in
  `docs/performance/granite-analysis-baseline.md`). The analyzer stays tool-less because the host already selects
  the evidence, each tool round would cost another generation against the 2-slot, 32,768-token budget, and tool output
  is an extra injection surface.
- At most 2 active generations. One process-wide queue per (base URL, model), separate from the reader pool,
  with a finite waiting list, deadlines and cancellation. KV prefix reuse is a speed hint only; the result
  cache is keyed by workspace namespace plus a digest of operation, evidence, versions and model.

## Operator configuration
Route details are never source constants and OmniRoute keeps ownership of placement.

| Variable | Meaning |
| --- | --- |
| `MENAGERIE_ANALYSIS_BASE_URL` | required; http(s) URL including `/v1` |
| `MENAGERIE_ANALYSIS_MODEL` | required; served model id |
| `MENAGERIE_ANALYSIS_API_KEY` | optional bearer key |
| `MENAGERIE_ANALYSIS_MAX_ACTIVE` | optional, 1-2 (default 2) |

Missing base URL or model means "not published". Settings: `graniteWorkflowEnabled` (default off) and
`graniteWorkflowPolicy` (`explore` | `build` | `strict`, default `build`).

## Behaviour by policy (when enabled)
- `explore`: dispatch rejects edit-capable modes and tasks declaring `filesWrite` (recoverable tool error).
- `build`: no extra restriction; a single worker is allowed.
- `strict`: workers edit isolated worktrees whose patches are NOT applied to your checkout, so after the batch the gate verifies a throwaway sandbox (snapshot commit + the workers' patches) rather than your checkout; dispatch only accepts tasks compiled from a stored, user-approved `SpecRevision` (`specTrace`); after the batch the host runs the revision's executable checks and the tool result carries a deterministic `specGate` verdict. Analysis that cannot run **escalates to `reader.deep`** and is reported in the result; it is never skipped.
- Optional analysis that cannot run is reported as `skipped` with its cause.
- When disabled nothing changes: no policy check, no analysis, and the `parallel_tasks` result has no `analysis` key.

## Recovery and escalation
Typed outcomes cover unavailable, timeout, queue-full, cancelled, non-JSON, invalid-schema, oversize and
stale-evidence. One bounded format retry is allowed and the first failure stays visible. Quality signals from an
outcome map onto the existing `readerEscalationDecision` inputs via `analysisOutcomeToEscalationSignals`.

## Reader-assisted follow-up questions
When `ask_followup_question` finds nothing in memory or by lexical overlap, and `readerAssistedQuestions` is on (default),
a reader looks before the user is interrupted (`src/core/questions/readerAnswer.ts`, `assistWithReader`):
1. Low lane: the host builds excerpts (the original request, earlier replies, README/AGENTS, steering, specs, `docs/`
   design docs; secret-looking text excluded) and Granite answers from them through the same bounded, tool-less path
   (`completeOnAnalysisRoute`, shared 2-slot queue). Every citation quote must appear verbatim in the excerpt it names.
2. `readerEscalationDecision.decide` judges the answer. Low confidence (< 0.5) or no grounded citation escalates.
3. High lane: one tool-capable `project-reader` subtask forced onto `reader.deep`. Its answer counts only if it names a
   file that exists inside the workspace.
4. Otherwise, or if the service is down, the user is asked as before. The question is marked handled before any reader runs,
   so a repeat always reaches the user, and reader output is never stored as a user answer in question memory.

## Authoring and approving a spec (user-driven)
1. Write a draft at `.kiro/specs/<id>/spec.draft.json`: the revision content without `revisionId`
   (`specId`, `policy`, `sourceRevision`, `requirements`, `decisions`, `tasks`, `acceptance`, `checks`; see
   `src/core/specs/__tests__/specFixtures.ts` for a complete example). A model may draft it; it cannot approve it.
2. Run **Import Spec Draft**. The draft is validated (schema, traceability graph, dependency cycles, write collisions,
   unsafe paths, shell commands), sealed into an immutable content-addressed revision, and projected into
   `requirements.md`, `design.md` and `tasks.md` (hand edits are preserved and reported).
3. Run **Approve Spec Revision**. A modal shows the exact argv commands the revision may run; only an explicit click records
   `approvedBy: "user"`. Editing the spec means importing a new revision, which needs its own approval.
4. Compile tasks with `compileSpec` (they carry `specTrace`) and dispatch under the `strict` policy.
5. After you integrate the returned patches, run **Verify Spec Revision**: it runs the approved checks in your real workspace and
   ticks the Kiro checkboxes from the evidence. Per-worker audit and rework already happen during the batch (see Known gaps);
   the strict host-run checks stay the authority for spec criteria.

## Known gaps (see tasks.md for the authoritative list)
- Readers that return prose without structured file citations produce `no-file-evidence`.
- Checks run host-side (`SpecCheckRunner`): `execFile` with no shell, refused shells, timeout, output cap, scrubbed
  environment, and only for a revision the user approved (that approval is consent to the exact argv). This is outside the
  Capability Broker by design because a worker's exit code would be a model-reported assertion.
- `runParallelTasks` now audits workers at runtime (`src/core/task/auditLoop.ts`, built on `decideVerifierScheduling`,
  `gateParentOutcome`, `decideFixerLoop` and `produceDeeperLaneFollowUp`). A worker with `verification.required`, or any
  edit-capable worker when `workerAuditMode` is `edits` (the default), is checked by an independent read-only verifier
  in its own kept worktree. On FAIL the same worker is sent back with the verifier's findings, up to 2 rounds, and then
  re-verified. After the rounds are used, one deeper-lane follow-up (`reader.deep` or `reasoning.escalation`) runs if the
  routing gates allow it, and its summary is recorded as advice. The outcome then stays `not-successfully-verified`;
  the audit never upgrades it to `pass`. DAG dependents unlock only after the audit finishes. Blocking and background
  batches share this path. The result carries an `audit` record (`rounds`, `verifierTaskIds`, `outcome`, `escalation`).
- Granite constraint unchanged: the audit module has no input for analysis output, verifier routing never uses the analysis
  route, and only a completed verifier `WorkerResult` (or the host-run checks in `strict`) can produce a PASS. Granite or
  reader summaries, including the escalation advice, are never evidence that a check passed.
- The audit verifier is a model worker judging the workspace, so it is not the host-run `SpecCheckRunner`. For spec
  criteria the host-run checks remain the authority. The post-batch strict gate still only advises on fixers.
- Not done: the verifier does not run in a separate scratch checkout from the worker, and reworked output is only
  visible in the worker's worktree until you integrate the patch.
- No host E2E (it needs a full extension bundle, a VS Code download and recorded model traffic); restart rehydration is
  covered at the store layer. Observatory spec status is a display cache, also persisted under `.kiro/specs/.status` and restored after a restart.
- Quality evidence: `docs/performance/granite-analysis-quality.md` (50 cases x 6 runs). Contradiction finding is
  advisory only and risk classification needs the deterministic floor; neither may gate a PASS.
