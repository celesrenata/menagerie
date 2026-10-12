# Priority parent capacity pre-skip cascades to the next local lane

The patch changes execute-mode PRIORITY parents composed entirely of combo references so a child rejected by the parent’s pre-dispatch capacity check no longer terminates the root while a later child remains available. Dispatched child responses retain the existing quota-protection, retry, validation, cycle, and depth behavior. Deterministic coverage recreates the saturated 5090/4070 tier1 and available GLM tier1b incident, plus all-local exhaustion and a non-capacity child failure. The current allowlisted tree and binary diff hashes match the new immutable candidate’s recorded metadata.

Watch for: **confirmed** deployment must select `sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b`; the forbidden prior candidate `sha256:388fa7e…` does not contain this parent-cascade fix.

**Verdict**: APPROVED

## High-level view

The executor recognizes only the target topology: effective strategy `priority`, at least one runtime unit, and every unit a `combo-ref`. A pre-dispatch concurrency-cap rejection in that topology is counted and advances to the next local combo reference instead of triggering the quota-protected terminal return.

Non-capacity 4xx/5xx responses, quality failures, validation failures, cycle/depth failures, and retry outcomes still pass through the existing protected-target logic. Direct-model, mixed-unit, and non-priority roots do not enter the new path.

The tests model tier1 as `[5090, 4070, 5090]` with shared caps `2/1`, tier1b as GLM with cap `1`, and the parent as the production-shaped priority combo-ref root. They cover GLM success when tier1 is full, `503 ALL_TARGETS_SKIPPED` when every local child is full, zero queue waiters, and terminal handling for a child HTTP 400.

The candidate remains a dirty isolated worktree at approved revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`. Its seven authorized application files and seven focused tests reproduce the tree and binary diff hashes recorded in the candidate labels.

<details>
<summary>Issues (0)</summary>

No actionable review findings.

</details>

<details>
<summary>Details</summary>

## Capacity pre-skip becomes a parent-level fallback signal

`executeRuntimeUnitCombo` computes `priorityComboRefRoot` from the effective strategy and the complete ordered unit set. This excludes direct-model and mixed roots even when they use PRIORITY, preserving the rule that a protected model or a protected combo-ref in a mixed root stops at local capacity.

For the target root shape, the concurrency precheck increments `capacitySkippedComboRefs`, bypasses only the immediate `protectedPriorityUnit` return, increments the existing fallback count, and continues:

```text
local/research PRIORITY
  tier1 combo-ref  -- precheck: full --> skip, continue
  tier1b combo-ref -- precheck: free --> dispatch --> GLM success
```

The condition does not reinterpret child responses, broaden status-based fallback, or inspect response text. If every child is pre-skipped, the root stays local and returns the established OpenAI-shaped `503 service_unavailable` response with code `ALL_TARGETS_SKIPPED` rather than the last child’s generic capacity message.

## Dispatched failures retain quota-protected terminal semantics

The retryable status set, `observeFailure`, `isQuotaExhaustionResponse`, protected-target trust, and post-dispatch terminal return are untouched. An HTTP 400 from tier1 remains terminal after tier1’s existing round-robin behavior, and tier1b is not called; arbitrary 4xx/5xx responses therefore do not become fallback signals merely because the parent contains only combo references.

`SEMAPHORE_TIMEOUT` is not reclassified because the new decision applies only to `isRuntimeUnitAtConcurrencyCap` before dispatch. Queue responses and terminal validation, missing-child, cycle, depth, abort, attempt-budget, and quality-failure paths remain outside the modified branch. A root with no usable later child remains terminal rather than escaping to cloud or another strategy.

## Incident-shaped coverage exercises success and exhaustion

The success regression occupies both 5090 permits and the sole 4070 permit. It requires HTTP 200, exactly one model invocation to `llama-cpp/ds4-glm53`, the tier1 skip and tier1b attempt logs, and zero waiters on both saturated accounts. The fixture has no cloud child, and the successful GLM-only result excludes a terminal HTTP 500, `SEMAPHORE_TIMEOUT`, or hidden tier1 retry.

The exhaustion regression also occupies GLM, expects no model dispatch, checks all three account queues remain at zero, and requires HTTP 503 with `error.code === "ALL_TARGETS_SKIPPED"`. The non-capacity regression returns HTTP 400 from tier1 and confirms tier1b GLM is never invoked.

The recorded before/after run shows these three focused cases failing before the executor edit and passing afterward. The broader focused run passed 176/176 tests; lint, core typecheck, and production build passed. The only open-sse checker diagnostic was the documented unrelated frozen-baseline TypeScript 6.0.3 issue outside every authorized file. Per the review brief, no suite was rerun.

## Candidate scope and immutable identity remain controlled

Remote inspection shows only the expected seven application files and seven focused tests. Two tests are untracked, so plain `git diff --name-only` lists 12 paths; adding the full authorized set to a temporary index reproduces tree `aea994df380df929bee410618dfe5bd41ee9006e` and binary diff SHA-256 `ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`. `git diff --check` is clean, HEAD remains the approved revision, and the implementation record states that no commit or push was created.

The new candidate is `registry.celestium.life/library/omniroute@sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b`, with matching revision, tree, and diff labels and an ephemeral `/healthz` HTTP 200. It is distinct from forbidden candidate `sha256:388fa7e33a360bfa4d18b4414ed92af66b5a32eeba38db055d76da50651ae4aa`.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo/runtimeUnits.ts` — advances all-combo-ref PRIORITY parents past capacity pre-skips and emits `ALL_TARGETS_SKIPPED` on complete pre-skip exhaustion.
- `open-sse/handlers/chatCore.ts` — carries the earlier authorized account-capacity controls through chat-core handling.
- `open-sse/services/combo.ts` — carries the earlier authorized combo capacity and affinity behavior.
- `open-sse/services/combo/types.ts` — types the earlier authorized combo options.
- `src/app/api/combos/[id]/route.ts` — preserves the earlier authorized combo persistence behavior.
- `src/shared/validation/schemas/combo.ts` — validates the earlier authorized lane controls.
- `src/sse/handlers/chat.ts` — carries the earlier authorized fail-fast account-capacity behavior.
- `tests/unit/combo-runtime-unit-concurrency.test.ts` — reproduces parent pre-skip failover, complete local exhaustion, and non-capacity terminal behavior.
- `tests/unit/accountSemaphore.test.ts` — covers the earlier authorized zero-depth account-capacity behavior.
- `tests/unit/chatcore-translation-paths.test.ts` — covers the earlier authorized chat-core translation path.
- `tests/unit/combo-capacity-cascade-persistence.test.ts` — covers the earlier authorized persistence round trip.
- `tests/unit/combo-config.test.ts` — covers the earlier authorized config surface.
- `tests/unit/combo-shared-account-race.test.ts` — covers the earlier authorized shared-account race behavior.
- `tests/unit/combo-strategy-fallbacks.test.ts` — covers the earlier authorized lane ordering, affinity, and fallback behavior.

Full diff: `ssh celes@192.168.42.254 'cd /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z && git diff'`; include the two untracked focused tests shown by `git status --short` when reconstructing the candidate tree.

</details>
