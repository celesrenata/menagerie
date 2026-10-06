# Spec: GPU-aware parallel execution over OmniRoute

Status: superseded · Owner: celes

> **Superseded routing design:** Menagerie no longer owns GPU placement.
> `docs/architecture/omniroute-integration-design.md` §5 is authoritative:
> Menagerie selects a per-worker OmniRoute model/route id; OmniRoute owns
> admission, health, queuing, and physical GPU placement.

This spec covers the parallel-execution subsystem imported from the
`3.84.2-parallel` build and the work still needed to make it compete with
Kiro on a self-hosted, multi-GPU fabric. It assumes the OmniRoute topology in
`~/sources/m5max-darwin-flake/docs/local-inference.md`.

## 1. What exists today (imported and verified)

Two independent, default-off experiments plus the supporting infrastructure.

### 1.1 `parallelTasks` → the `parallel_tasks` tool
- Runs 2–3 independent full agents, each in its own editor tab and Git
  worktree (`ParallelTaskWorkspace.ts`: private index, unattached snapshot
  commit; source branch/index untouched; ignored files and secrets not copied).
- A process-wide pool of three permits (`ParallelTaskPool.ts`) bounds
  concurrency. Workers cannot create further tasks (no nested pools).
- The parent blocks in one tool call, collects every terminal result, and
  reviews the exported patches (`runParallelTasks.ts`, `waitForParallelTask`).
- Per-worker records and a manifest live under global storage
  `parallel-tasks/<batch-id>/`. No auto-resume after host restart.
- Each worker inherits mode/profile via the same `getTaskHandoffContext`
  policy as serial delegation; no worker mutates the parent profile.

### 1.2 `parallelToolExecution` → concurrent native reads
- Runs contiguous, complete native read calls concurrently, up to eight
  (`parallelReadTools.ts`, `ParallelTaskReader.ts`). Allowlist: `read_file`,
  `list_files`, `search_files`, `codebase_search`, `read_command_output`.
- Assistant history is persisted before admission; all reads join before the
  next command/edit/MCP/model turn. Unknown tools are barriers. A task-local UI
  mutex prevents one read consuming another's approval.

### 1.3 OmniRoute routing tiers
- `omnirouteTier.ts` + `routingTier.ts` + `RoutingTierSelector.tsx`: a 1–5
  "tier" dropdown (rendered as `$`..`$$$$$`) that sets an `X-OmniRoute-Tier`
  header. Tier is a local-first floor; a model tool call may escalate but not
  drop below the user-selected floor (`userTier`).

### 1.4 Task Board and infra
- `taskBoard.ts` (`Zoo: Show Task Board`, `zoo-code.getTaskBoard`, 5s snapshots
  under `task-boards/<window-id>.json`).
- `CachedUiValue.ts`, `WebviewMessageQueue.ts`, `compactEnvironmentDetails.ts`.

Verification at import: `tsc --noEmit` clean across types/src/webview-ui; 29
parallel tests, 54 parser/routing/board tests, 128 webview-ui tests pass;
lifecycle model check passes (57366 states, all landmarks); no eslint
suppression regression.

## 2. Gaps and required work

### 2.1 Routing targets the wrong OmniRoute instance (blocker)
`isOmniRoute()` hardcodes hostname `omniroute.celestium.life` (the central
Kubernetes instance). The Mac editor talks to the loopback instance at
`http://127.0.0.1:20128/v1`. As written, tier headers are only attached for the
central host, so local editing gets no routing.

Requirement: treat the loopback instance as OmniRoute too. Detect by a
configurable allowlist of hosts (default: `omniroute.celestium.life`,
`127.0.0.1:20128`, `localhost:20128`) rather than one literal hostname.

### 2.2 Fan-out does not spread across GPUs (the core improvement)
Today all parallel workers inherit the parent's single tier/combo. OmniRoute's
priority strategy then picks the first-available backend for each worker, so
2–3 workers can land on the **same** GPU and serialize. That negates the point
of parallelism on a 3-GPU rig.

Requirement: GPU-aware placement. When dispatching N parallel workers, assign
each a **distinct single-GPU alias** so N workers occupy N GPUs. Proposed
default placement policy, given the fabric:

| Worker role | Alias | Rationale |
| --- | --- | --- |
| Hardest / most reasoning | `local/5090` (`qwen3.8-27b-nvfp4`) | highest accuracy |
| Fast / tool-heavy / short | `local/4070ti` (`ornith-1.5:9b-262k`) | best latency + tool selection |
| Large-context / spec | `local/long` or `local/m5max` (GLM 5.3, 160K) | only 160K local lane |

Placement must be:
- **Capability-aware**: a worker whose context exceeds the 5090's 16K NVFP4
  ceiling must not be pinned to `local/5090` (it would fall through anyway);
  route it to the M5 long lane.
- **Overridable** per task spec (`parallel_tasks` already carries per-task
  fields; add an optional `route`/`gpu` hint), and per placement policy setting.
- **Degrade gracefully**: fewer healthy GPUs than workers → fall back to shared
  `local/any`/`local/code` for the overflow, never block the batch.

### 2.3 Tier model vs. GPU model need reconciliation
Tiers (1–5, cost/quality escalation) and GPU aliases (placement) are orthogonal
today. Decide and document the interaction: a tier could select the *alias set*
(e.g. tier 1 = local-only aliases, tier ≥4 = hybrid), while placement chooses
*which* alias within the set per worker. The dropdown UI should be able to show
both "how hard to try" (tier) and "spread across GPUs" (placement on/off).

### 2.4 Health-driven placement
Placement should consult live backend health (the proxy/OmniRoute
`/v1/models` and combo health) before pinning, so a scaled-to-zero 4070ti
deployment or a stopped 5090 unit is skipped rather than assigned. Reuse the
probes documented in `local-inference.md`.

### 2.5 Batch resume and Task Board integration
- No auto-resume after host restart (by design). Add an explicit "resume batch"
  entry point that reads `parallel-tasks/<batch-id>/` and re-attaches or
  re-runs unfinished workers.
- Surface live batch workers and their assigned GPU alias on the Task Board.

### 2.6 Security (must fix before sharing history)
`~/sources/m5max-darwin-flake/secrets/cline_mcp_settings.json` and the tracked
Roo/Cline settings contain plaintext credentials (Postman `PMAK-…`, an OpenAI
`sk-proj-…`, 21st.dev keys, a Wolfram app id). Rotate them and move to the SOPS
path (`configure-omniroute.sh` already reads `/run/secrets/*`) before the flake
history is shared. This is a flake-side task, tracked here because the routing
work touches the same files.

## 3. Design direction

- Introduce a `placement` module beside `omnirouteTier.ts` that maps a batch of
  worker specs → distinct aliases, given (a) a placement policy setting, (b) per
  worker capability needs (context size, tool-heaviness), (c) live GPU health.
- `runParallelTasks` calls the placement module once per batch, after resolving
  contexts and before dispatch, and threads the chosen alias into each worker's
  `apiConfiguration` (model id) the same way `applyTaskRouting` threads the tier
  header. Keep it scoped to the child context; never mutate the parent profile.
- Extend `isOmniRoute` host detection (2.1) as a prerequisite.
- Keep both experiments default-off; add a `parallelGpuPlacement` setting
  (default off) so placement can be enabled independently of the tier dropdown.

## 4. Task list

1. Widen `isOmniRoute` to an allowlist including the loopback instance; add a
   setting for extra hosts. Tests: loopback + central both detected.
2. Add the `placement` module: batch specs → distinct aliases, capability- and
   health-aware, with graceful fallback. Pure-logic unit tests.
3. Wire placement into `runParallelTasks` behind a `parallelGpuPlacement`
   setting; thread alias into child `apiConfiguration`. Tests: 3 workers → 3
   aliases; overflow falls back; oversized-context worker avoids the 5090.
4. Reconcile tier ↔ placement (3.3): document interaction; update
   `RoutingTierSelector` to expose a placement toggle. Webview tests.
5. Add explicit batch resume from `parallel-tasks/<batch-id>/`; show live batch
   workers + assigned alias on the Task Board.
6. Persisted-setting round trip for `parallelGpuPlacement` and any host
   allowlist per AGENTS.md checklist (types → ExtensionState → cachedState →
   handler → getState → getStateToPostToWebview → tests).
7. Flake-side: rotate the plaintext secrets and move them behind SOPS.
8. Optional: extension-host E2E proving 3 simultaneous requests hit 3 distinct
   GPUs (extends the existing `apps/vscode-e2e/src/suite/parallel-tasks.test.ts`).

## 5. Non-goals
- Replacing the boomerang/serial delegation lifecycle (unchanged).
- A production trace adapter for the abstract fanout model (stays a reference).
- Turning either experiment on by default.
