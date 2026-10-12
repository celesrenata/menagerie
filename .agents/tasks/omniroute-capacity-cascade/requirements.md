# OmniRoute Concurrent-Capacity Cascade Requirements

## Summary

Correct the production OmniRoute configuration on `celes@192.168.42.254` and reconcile the durable writable Nix source so the `code` and `research` lanes consume local capacity in this order: two real RTX 5090 slots with the RTX 4070 Ti Super slot interleaved between them, then one M5 Max GLM slot, then free/cheap cloud tiers. “Job N” means the Nth concurrently occupied capacity slot, not the Nth request received over time. Routing must be capacity-driven, must not pin continuing sessions to a busy target, and must immediately cascade past saturated local targets instead of queuing on them.

Assumptions:
- The existing cloud model membership and tier order are already the approved free/cheap policy; this work changes their timeout, not their membership.
- Existing non-routing metadata and local-target timeouts remain unchanged unless they conflict with the requirements below.
- Model-entry IDs may retain existing stable values, but each entry must have a unique ID within its combo.

## Functional Requirements

### 1. Local provider capacities

The live provider connections and durable source must enforce these shared physical capacities:

- RTX 5090 connection `e9bd13fb-c6b6-4c18-b42f-3395266348ce`: `maxConcurrent: 2`, serving `vllm/qwen3.8-27b-nvfp4`. The underlying vLLM runtime must remain configured for two real sequences (`--max-num-seqs 2`).
- RTX 4070 Ti Super connection `b20e0770-3e14-40c1-87cd-85c34b34381a`: `maxConcurrent: 1`, serving `ollama-local/qwen3.8:27b-iq3-code144k`.
- M5 Max GLM connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`: `maxConcurrent: 1`, serving `llama-cpp/ds4-glm53`.

These connection caps are shared across all lanes and are the authoritative protection against oversubscribing the physical backends.

### 2. Exact `code` routing structures

`pool/tier1/code` must have:

- `strategy: round-robin`.
- Exactly three ordered model entries: RTX 5090 `vllm/qwen3.8-27b-nvfp4`, RTX 4070 Ti Super `ollama-local/qwen3.8:27b-iq3-code144k`, then a second entry for the same RTX 5090 model and connection.
- Equal/neutral round-robin weights for the three entries.
- `concurrencyPerModel: 2`, while respecting each connection’s stricter shared cap.
- `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, and `stickyRoundRobinLimit: 1`.
- `context_length: 163840` and `context_cache_protection: false`.

`pool/tier1b/code` must have:

- `strategy: round-robin`, even though it contains one target, so round-robin’s bounded semaphore behavior is used.
- Exactly one model entry: M5 Max `llama-cpp/ds4-glm53` through connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`.
- `concurrencyPerModel: 1`, `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, and `stickyRoundRobinLimit: 1`.
- `context_length: 1048576` and `context_cache_protection: false`.

`hybrid/code` must have:

- `strategy: priority`.
- Ordered executable combo references: `pool/tier1/code`, `pool/tier1b/code`, `pool/tier2/code`, `pool/tier3/code`, `pool/tier4/code`, and `pool/tier5/code`.
- `nestedComboMode: execute`, `maxRetries: 0`, `failoverBeforeRetry: true`, and `disableSessionStickiness: true`.
- Tier routing with default tier 1 and maximum tier 5.

`local/code` must have:

- `strategy: priority`.
- Exactly two ordered executable combo references: `pool/tier1/code`, then `pool/tier1b/code`; it must not reference cloud tiers.
- `nestedComboMode: execute`, `maxRetries: 0`, `failoverBeforeRetry: true`, and `disableSessionStickiness: true`.
- Tier routing with default tier 1 and maximum tier 1.

### 3. Exact `research` routing structures

`pool/tier1/research` must match the capacity behavior of `pool/tier1/code`:

- `strategy: round-robin`.
- Exactly three ordered model entries: RTX 5090 `vllm/qwen3.8-27b-nvfp4`, RTX 4070 Ti Super `ollama-local/qwen3.8:27b-iq3-code144k`, then the second RTX 5090 entry.
- Equal/neutral round-robin weights for the three entries.
- `concurrencyPerModel: 2`, subject to the shared connection caps.
- `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, and `stickyRoundRobinLimit: 1`.
- `context_length: 163840` and `context_cache_protection: false`.

`pool/tier1b/research` must be created or reconciled with:

- `strategy: round-robin`.
- Exactly one model entry: M5 Max `llama-cpp/ds4-glm53` through connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`.
- `concurrencyPerModel: 1`, `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, and `stickyRoundRobinLimit: 1`.
- `context_length: 1048576` and `context_cache_protection: false`.

`hybrid/research` must have:

- `strategy: priority`.
- Ordered executable combo references: `pool/tier1/research`, `pool/tier1b/research`, `pool/tier2/research`, `pool/tier3/research`, `pool/tier4/research`, and `pool/tier5/research`.
- `nestedComboMode: execute`, `maxRetries: 0`, `failoverBeforeRetry: true`, and `disableSessionStickiness: true`.
- Tier routing with default tier 1 and maximum tier 5.

`local/research` must have:

- `strategy: priority`.
- Exactly two ordered executable combo references: `pool/tier1/research`, then `pool/tier1b/research`; it must not reference cloud tiers.
- `nestedComboMode: execute`, `maxRetries: 0`, `failoverBeforeRetry: true`, and `disableSessionStickiness: true`.
- Tier routing with default tier 1 and maximum tier 1.

### 4. Capacity and failover semantics

- With overlapping work, the four local occupancy slots for both `code` and `research` must resolve to two RTX 5090 executions, one RTX 4070 Ti Super execution, and one M5 Max GLM execution before any fifth-or-later overlapping job reaches cloud.
- Capacity selection must be based on current occupancy. Idle capacity must become eligible again when a running request releases it; the routing order must not be interpreted as a permanent request sequence.
- Session or conversation identity must not pin requests to a saturated member. Continuing sessions must retain the same capacity placement behavior as new sessions.
- Saturation of either model entry in a round-robin pool must immediately try the next member. `queueDepth: 0` must remain present in the live records and survive durable reconciliation; it must not be stripped as obsolete.
- When GLM is occupied, `pool/tier1b/*` must fail immediately to the next parent combo reference. `hybrid/*` therefore proceeds to cloud; `local/*` returns local-capacity exhaustion rather than using cloud.
- A target failure must not be retried in place before trying the next capacity tier.

### 5. Cloud timeout

Every cloud pool matching `pool/tier2/*`, `pool/tier3/*`, `pool/tier4/*`, or `pool/tier5/*` must have exactly `config.targetTimeoutMs: 60000`. This applies to all 44 currently installed cloud pool records, including pools not referenced by the two corrected lanes. Local `tier1`/`tier1b` pools and local roots remain at `600000` ms.

### 6. Authorized OmniRoute runtime source scope

The user authorizes the narrow OmniRoute runtime/API correction required for immediate shared-account-capacity failover, including isolated development, focused tests, image build, immutable-digest production deployment, and rollback. Before editing, the implementer must identify the clean/current canonical OmniRoute checkout on `celes@192.168.42.254`; `/home/celes/sources/omniroute-transcript-fix` was previously inspected, but a newer canonical source must be preferred if one exists. The only authorized application source files are:

1. `src/shared/validation/schemas/combo.ts` — add optional lane-scoped booleans `disablePromptCacheAffinity` and `failFastOnAccountCapacity`, defaulting to false/absent.
2. `open-sse/services/combo/types.ts` — add optional typed per-target account-semaphore queue-size and timeout fields.
3. `open-sse/services/combo.ts` — for round-robin only, skip prompt affinity when `disablePromptCacheAffinity` is true; when `failFastOnAccountCapacity` is true, pass validated `queueDepth`/`queueTimeoutMs` into the account gate; classify `SEMAPHORE_QUEUE_FULL` as a capacity skip that advances member/tier, not an HTTP 500 or in-place retry.
4. `src/sse/handlers/chat.ts` — thread account-gate options through both combo-to-single-model closures and through `handleSingleModelChat` runtime options into `chatCore`.
5. `open-sse/handlers/chatCore.ts` — accept optional account queue arguments in `handleChatCore` and `acquireAccountSemaphore`; direct calls and unrelated combos retain defaults.
6. `src/app/api/combos/[id]/route.ts` — stop stripping `queueDepth` on PUT.

No other OmniRoute application source file is authorized for modification. Tests may be added or updated only as needed to prove this behavior. Direct calls, unrelated combos, and `tester` retain existing runtime semantics because the new controls are optional and enabled only on the four corrected `code`/`research` leaves.

The patch is required because the combo-local round-robin semaphore already honors `queueDepth: 0` and advances immediately on `SEMAPHORE_QUEUE_FULL`, while the shared account semaphore is keyed by provider plus connection and currently does not receive zero-depth options from combo dispatch. A second 4070 request can therefore queue for about 120 seconds and return `SEMAPHORE_TIMEOUT` instead of advancing to another 5090 slot or GLM. Prompt-cache affinity can independently reorder ordinary round-robin even with `disableSessionStickiness: true`, and management PUT currently strips `queueDepth` despite schema acceptance.

The implementation tests must persist and read back `queueDepth: 0` through both POST and PUT, then prove that saturation creates no waiter (`queued: 0`) and causes immediate cascade at both the combo-local semaphore and shared-account semaphore. Coverage must include multi-target 4070 member advancement, one-target GLM tier advancement, no HTTP 500, no in-place retry, and unchanged defaults for unrelated combos.

### 7. Backup and rollback readiness

Isolated candidate development, testing, image build, and publication occur first in a clean worktree and are not production mutations. The timestamped mode-`0600` backup is the first production-host mutation and must be created and validated before editing the writable durable policy, deploying an image, changing any live API record, or creating/running a canary. Store it under `/home/celes/.local/state/omniroute-routing` with an owner-only directory, and include:

- The complete pre-change live combo export.
- The pre-change records for the three provider connections, including their concurrency values.
- A byte-for-byte copy of `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`.
- The pre-change Kubernetes deployment state and old immutable image digest needed for runtime rollback.

The backup must not contain the management API key, must validate by parse/hash/readback before proceeding, and must be sufficient to restore the runtime digest, live policy records, and durable source. After validation, the single authorized order is: deploy the candidate digest; apply the durable and live policy; run canaries and acceptance gates. Any failed gate must roll back both the runtime digest and all durable/live policy mutations, then verify health and restored readback.

### 8. Durable source reconciliation

- Reconcile `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py` so its generated plan and provider policies reproduce all requirements above for both `code` and `research`.
- The source must preserve `queueDepth: 0` through plan construction, projection, persistence, and readback comparison. Remove `queueDepth` from any `OBSOLETE` list or projection stripping so a missing zero is detected as drift.
- The source must set provider caps to 5090/4070/GLM = `2/1/1`; generate both lanes’ exact `[5090, 4070, 5090]` tier1 pools and one-target round-robin GLM tier1b pools; set `queueDepth: 0`, `disableSessionStickiness: true`, `disablePromptCacheAffinity: true`, and `failFastOnAccountCapacity: true` on all four corrected leaves; and generate `60000` ms for every tier2–tier5 cloud pool.
- `hybrid/code` and `hybrid/research` must generate root order tier1 → tier1b → tier2 → tier3 → tier4 → tier5. `local/code` and `local/research` must generate only tier1 → tier1b.
- `tester` must remain structurally unchanged and must not be included in `CASCADE_CATEGORIES`; only the shared provider caps and global cloud timeout can affect it.
- Applying or evaluating the reconciled source against the corrected live configuration must report no managed routing drift.
- Only the writable policy source may be edited. The read-only Nix-store symlink must not be modified.

## Non-Functional Requirements

- The correction must be applied through the authenticated OmniRoute management API in namespace `omniroute`, service port `20128`, using Bearer authentication without printing, logging, or backing up `/run/secrets/omniroute_management_api_key`.
- The authorized runtime patch must be built and tested from an isolated clean checkout, published with an OCI revision label, and deployed by immutable image digest. Rollback must also use the captured immutable digest.
- Changes must be reversible from the validated backup.
- Existing combo IDs should be updated in place where possible to avoid unnecessary route identity churn.
- Validation must observe actual backend occupancy or dispatch logs, not infer success solely from static JSON.

## Acceptance Criteria

1. Isolated candidate development and tests complete before production mutation. The first production-host mutation creates a validated backup under `/home/celes/.local/state/omniroute-routing` with an owner-only directory and mode-`0600` files containing the combo export, three provider records, writable Python source, deployment state, and old immutable image digest, with no management key.
2. The runtime patch changes only the six authorized application files plus focused tests, passes its checks, and is deployed by immutable candidate digest only after backup validation.
3. Management API readback reports provider `e9bd13fb-c6b6-4c18-b42f-3395266348ce` at `maxConcurrent: 2`, provider `b20e0770-3e14-40c1-87cd-85c34b34381a` at `maxConcurrent: 1`, and provider `70b82fc9-6f96-41ac-aa16-8da6099dd7ac` at `maxConcurrent: 1`.
4. Management API readback for `pool/tier1/code` and `pool/tier1/research` shows `round-robin`, the ordered `[5090, 4070, 5090]` targets, and config values `concurrencyPerModel: 2`, `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, `disablePromptCacheAffinity: true`, `failFastOnAccountCapacity: true`, and `stickyRoundRobinLimit: 1`.
5. Management API readback for `pool/tier1b/code` and `pool/tier1b/research` shows a one-target `round-robin` GLM pool and config values `concurrencyPerModel: 1`, `queueDepth: 0`, `maxRetries: 0`, `disableSessionStickiness: true`, `disablePromptCacheAffinity: true`, `failFastOnAccountCapacity: true`, and `stickyRoundRobinLimit: 1`.
6. Management API readback for `hybrid/code` and `hybrid/research` shows the ordered tier1, tier1b, tier2, tier3, tier4, and tier5 references; readback for `local/code` and `local/research` shows only tier1 and tier1b. All four roots execute nested combos and disable session stickiness.
7. An audit of all cloud pools returns exactly 44 records matching `pool/tier[2-5]/*`, with every record reporting `targetTimeoutMs: 60000` and none reporting another value.
8. Persistence/dispatch tests prove POST and PUT both retain numeric `queueDepth: 0`; an occupied combo-local gate and an occupied shared-account gate each reject without creating a waiter (`queued: 0`) and immediately advance the multi-target 4070 path or one-target GLM tier path, with no HTTP 500 or in-place retry.
9. A controlled five-request overlapping-capacity test for `code` reaches steady occupancy of two executions on the RTX 5090, one on the RTX 4070 Ti Super, one on M5 Max GLM, and the fifth on an allowed cloud tier. No backend exceeds its provider cap.
10. The same controlled overlapping-capacity test for `research` produces the same `2 + 1 + 1 + cloud` placement.
11. During either concurrency test, a request encountering the already-occupied 4070 proceeds immediately to another available member/tier; no second request is dispatched concurrently to the 4070, no request waits there for the 120000 ms queue timeout, and logs contain no 120-second Ollama `SEMAPHORE_TIMEOUT`.
12. Repeating the concurrency test with shared or continuing-session identity does not collapse placement onto one GPU and still uses all four local slots before cloud.
13. With all four local slots occupied, an additional `hybrid/code` or `hybrid/research` request begins cloud fallback without waiting on the 4070 or GLM semaphore. Under the equivalent `local/*` route, it does not call cloud.
14. After source reconciliation, its dry-run/readback verification reports no drift for all managed target structures and provider caps, and a restart or reapplication reproduces the same live configuration, including `queueDepth: 0` and 60000 ms cloud timeouts.
15. A before/after diff confirms no unrelated pool membership, strategy, or configuration changed, except the global cloud timeout correction and effects necessarily caused by the three shared provider caps.
16. If any deployment, policy, canary, or acceptance gate fails, verification shows restoration of the old immutable runtime digest, durable policy source, and prior live records before the operation is considered recovered.

## Out of Scope

- Modifying Menagerie to select GPUs or implement silicon placement; OmniRoute remains the sole routing owner.
- Changing cloud pool membership, pricing policy, or tier ordering beyond enforcing the 60000 ms timeout.
- Changing unrelated local pools or route families.
- Changing `tester` combo structure or behavior, except for unavoidable effects of correcting the shared 5090, 4070, and GLM provider caps.
- Changing model binaries, quantization, context-window settings, vLLM sequence capacity, Ollama runtime settings, or hardware allocation.
- Modifying OmniRoute application source outside the six explicitly authorized runtime files and focused tests.
- Editing the read-only Nix-store symlink, changelogs, or changesets.
- Creating commits or pushing changes.
