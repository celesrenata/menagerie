# OmniRoute Capacity-Cascade Correction Design

## Overview

OmniRoute remains the sole routing owner. The locked stack is the existing Next.js/TypeScript OmniRoute service, its `open-sse` combo executor and SQLite-backed management API, Kubernetes deployment `omniroute` in namespace `omniroute`, and the Python 3 durable policy generator at `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`. For both `code` and `research`, the topology is a three-entry round-robin GPU pool `[RTX 5090, RTX 4070 Ti Super, RTX 5090]`, then a one-entry round-robin M5 Max GLM pool. `hybrid/*` priority roots execute those children and then cloud tiers 2–5; `local/*` roots execute only the two local children.

The authoritative cloud target timeout is `targetTimeoutMs: 60000` for all 44 tier2–tier5 pools. Local tier1/tier1b targets and local roots remain at `600000` ms. The read-only live audit on 2026-10-10 found 93 combos, provider caps already at 2/1/1, and only two zero-depth combos (`pool/tier1/code` and `pool/tier1/tester`); the validated production backup/readback must re-establish current values before mutation.

A configuration-only rollout is not correct. The shared provider/account gate currently queues independently of the combo-local gate, and its queue-full exception becomes an HTTP 500 rather than capacity failover. The combo PUT handler also strips `queueDepth`, and prompt-cache affinity can override ordinary round-robin placement. The user has therefore authorized the narrow OmniRoute runtime/API source patch, focused tests, image build, immutable-digest deployment, and rollback enumerated below. No configuration-only workaround may be deployed.

## Inspected Baseline

All production operations run over SSH on `celes@192.168.42.254` (hostname `esnixi`). API access uses Bearer authentication against `http://127.0.0.1:20128`; the key is read from `/run/secrets/omniroute_management_api_key` only on the host and is never printed or persisted.

The previously inspected source was `/home/celes/sources/omniroute-transcript-fix` at revision `5458026c216f77a3da68ea49152dc33470cfe2cb`. It has unrelated working-tree changes, so implementation must first check for a newer canonical checkout and then create an isolated clean worktree from the selected source without including unrelated changes or creating/pushing a commit. The running pod was `omniroute-668497c5fc-qz524` with image ID `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`; no source revision label proved that image’s provenance. The candidate image must carry an OCI source revision/tree identifier and be deployed by immutable digest.

The current lane records that need policy changes are:

- `pool/tier1/code` (`8850ad01-6db0-4050-b24a-36e9682db1a7`): target order and caps are present, but `queueTimeoutMs` is 120000 and the new lane-scoped runtime controls are absent.
- `pool/tier1/research` (`ad888e43-2437-4ab6-bd10-b26bb039e8de`): priority, only two targets, and `concurrencyPerModel: 3`.
- `pool/tier1b/code` (`38a3423b-e0ca-4e20-9138-367a44f27e2b`): priority with a 15000 ms queue.
- `pool/tier1b/research`: absent.
- `hybrid/research` (`9ffe1cf9-307d-4de8-809f-2f233c00b0ae`) and `local/research` (`5dff08d5-d260-4582-9b82-ae75d0a552c9`): no tier1b reference and no explicit failover-before-retry.
- `hybrid/code` and `local/code` already have the required child order and execute mode.

## Source-Proven Routing Semantics

### Nested execute-mode cascade

`nestedComboMode: "execute"` resolves combo references as runtime units for supported simple strategies, including `priority` (`open-sse/services/combo/dispatchPrelude.ts:691-711`), then calls `executeRuntimeUnitCombo` (`dispatchPrelude.ts:713-744`). Priority preserves declared order (`open-sse/services/combo/runtimeUnits.ts:165-172`). A combo-ref recursively invokes the named child with depth and cycle guards (`runtimeUnits.ts:93-130`). The parent pre-skips a full child, attempts each child in order, returns on success, and advances after failover-eligible 408/429/500/502/503/504 responses (`runtimeUnits.ts:220-346`). Child capacity resolution deduplicates leaves by connection ID and reports the child full only when every positively capped connection is full (`runtimeUnitCapacity.ts:36-89`). Therefore the declared root order is the execution order: tier1, tier1b, tier2, tier3, tier4, tier5.

### Zero-depth queue and GLM strategy

`queueDepth` is schema-valid from 0 through 100 (`src/shared/validation/schemas/combo.ts:155-177`). Crucially, persisted numeric zero survives resolution: `resolveComboQueueDepth` in `open-sse/services/comboConfig.ts:275-278` computes `Number(config.queueDepth)`, returns the default only when the result is non-finite or negative, and otherwise returns `Math.min(Math.floor(raw), MAX_COMBO_QUEUE_DEPTH)`. For `queueDepth: 0`, the result is therefore exactly `0`; no truthiness fallback replaces it. A full combo-local semaphore with `maxQueueSize: 0` rejects immediately with `SEMAPHORE_QUEUE_FULL` and creates no waiter (`open-sse/services/rateLimitSemaphore.ts:126-177`). Round-robin passes the resolved queue depth and timeout to this semaphore and advances on queue-full/timeout (`open-sse/services/combo.ts:3245-3265`). A one-target priority combo does not use that bounded round-robin member gate; therefore `pool/tier1b/{code,research}` must use **round-robin**. When every target is skipped, round-robin returns a failover-eligible 503 `ALL_TARGETS_SKIPPED` response (`combo.ts:3836-3857`). The hybrid parent advances to cloud; the local parent has no cloud child and returns local-capacity exhaustion.

### `[5090, 4070, 5090]` placement

Duplicate 5090 entries remain distinct because execution keys include each unique step ID (`open-sse/services/combo/comboStructure.ts:87-147`). With `stickyRoundRobinLimit: 1`, the start is `counter % targets.length` (`combo/rrState.ts:38-53`); successful fallback moves the next pointer past the member that actually served (`combo.ts:3453-3464`). A positive provider-connection cap replaces combo fallback concurrency (`combo/concurrencyCaps.ts:57-75`; `combo/comboPredicates.ts:331-345`). Consequently one pool can occupy two 5090 slots and one 4070 slot while respecting connection caps 2 and 1. This is capacity occupancy, not a permanent wall-clock numbering guarantee after arbitrary prior traffic, and separate `code` and `research` counters do not provide global ordering.

### Shared-cap race that requires a runtime patch

The authoritative account semaphore key uses provider plus connection/account identity (`open-sse/handlers/chatCore/executorHelpers.ts:16-60`). Its defaults permit a nonzero wait and 20 queued waiters (`open-sse/services/accountSemaphore.ts:42-43`); when full with `maxQueueSize: 0`, it rejects with `SEMAPHORE_QUEUE_FULL` (`accountSemaphore.ts:182-218`). `chatCore` currently passes only max concurrency and abort signal (`open-sse/handlers/chatCore.ts:3059-3070`). `dispatchChatWithAffinityEviction` rethrows dispatch exceptions (`src/sse/handlers/chatDispatch.ts:52-64`), as does `handleSingleModelChat` (`src/sse/handlers/chat.ts:1818-1862`). Round-robin awaits `handleSingleModel` (`open-sse/services/combo.ts:3332-3339`), and an uncaught exception reaches the outer catch and becomes HTTP 500 (`combo.ts:3782-3786`). Thus merely forwarding zero depth is insufficient: account-gate queue-full must be classified as local capacity exhaustion inside the round-robin attempt.

### Prompt affinity

`disableSessionStickiness` clears conversation binding, but prompt-cache affinity is independently enabled from global settings, can reorder the target list, and resets the round-robin start to zero (`open-sse/services/combo.ts:3068-3118`). Explicit prompt keys up to 4096 characters and reusable message prefixes activate it (`open-sse/services/combo/promptCacheAffinity.ts:81-118`); rendezvous scoring intentionally keeps a key on one connection (`promptCacheAffinity.ts:120-175,318-347`). A separate per-combo `disablePromptCacheAffinity` field is therefore required. Reinterpreting `disableSessionStickiness` globally is rejected because it would change unrelated combos.

## Authorized Runtime/API Source Scope

The approved requirements authorize exactly this prerequisite, its focused tests, a candidate image build, production deployment by immutable digest, and runtime rollback. Before editing, identify the clean/current canonical checkout on `celes@192.168.42.254`; `/home/celes/sources/omniroute-transcript-fix` was previously inspected, but use a newer canonical source if one exists. Develop in an isolated clean worktree and do not include unrelated changes. The authorized application source surface is:

1. `src/shared/validation/schemas/combo.ts`: add optional booleans `disablePromptCacheAffinity` and `failFastOnAccountCapacity`. Both default to false/absent. No dashboard/global setting is added.
2. `open-sse/services/combo/types.ts`: add optional typed target runtime fields for account-semaphore max queue size and timeout.
3. `open-sse/services/combo.ts`: for round-robin only, disable prompt affinity when `config.disablePromptCacheAffinity === true`; when `config.failFastOnAccountCapacity === true`, pass the already validated `queueDepth` and `queueTimeoutMs` as per-target account-gate options. Catch `SEMAPHORE_QUEUE_FULL` thrown by `handleSingleModel`, classify it as a capacity skip, do not increment `recordedAttempts`, do not set provider cooldown/health failure, do not retry that target, and continue to the next member after the existing combo-local permit is released in `finally`. If no member was dispatched, retain the existing 503 `ALL_TARGETS_SKIPPED` terminal response. Unexpected exceptions retain the existing 500 behavior. `SEMAPHORE_TIMEOUT` is not expected with zero depth and is not reclassified by this patch.
4. `src/sse/handlers/chat.ts`: add the two account-gate options to both combo-to-single-model closures (`:1048-1080` and `:1360-1388`) and to `handleSingleModelChat` runtime options (`:1277-1315`), then pass them into the chat-core dispatch arguments.
5. `open-sse/handlers/chatCore.ts`: add optional account queue arguments to `handleChatCore` (`:497-526`) and pass them as `maxQueueSize`/`timeoutMs` to `acquireAccountSemaphore` (`:3059-3070`). Direct model calls and combos without `failFastOnAccountCapacity` retain current defaults.
6. `src/app/api/combos/[id]/route.ts`: remove `queueDepth` from `LEGACY_REMOVED_COMBO_CONFIG_KEYS`; the current PUT sanitizer strips it at `:45-73,163-165` despite schema support. POST already validates through `createComboSchema` (`src/app/api/combos/route.ts:52-75`).

No other OmniRoute application source file may be modified. Focused test files may be added or updated only to prove the authorized behavior; no changelog, changeset, commit, or push is part of this work.

`failFastOnAccountCapacity` is intentionally lane-scoped. Only the four corrected leaves set it, so `pool/tier1/tester` and unrelated round-robin combos retain current shared-account queue semantics. `disablePromptCacheAffinity` is also set only on those four leaves. This resolves the review’s blast-radius concern without changing global affinity behavior.

Required source tests are:

- Resolver/unit coverage for `resolveComboQueueDepth({ queueDepth: 0 }) === 0`; semaphore tests must prove zero depth rejects immediately and leaves `queued: 0`.
- `tests/unit/combo-strategy-fallbacks.test.ts` (or the existing round-robin suite): a thrown account `SEMAPHORE_QUEUE_FULL` advances to the next target without cooldown/retry/500; a one-target pool returns 503 `ALL_TARGETS_SKIPPED`.
- A chat/combo integration test that proves queue options reach `chatCore` only when `failFastOnAccountCapacity` is true.
- A persistence/dispatch integration test that creates a combo by POST with `queueDepth: 0`, reads back numeric zero, updates it by PUT, reads back numeric zero again, then occupies the combo-local gate and separately the shared-account gate. At both gates assert immediate rejection with no waiter (`queued: 0`) and immediate cascade. Exercise both the multi-target 4070 path and one-target GLM path.
- Deterministic synchronized race tests for both 4070 and GLM: distinct code/research combo-local gates pass capacity precheck, both requests pause immediately before shared account acquisition, one takes the shared permit, and the loser advances. Assert no account waiter, no HTTP 500, no in-place retry, and hybrid-versus-local terminal behavior.
- A prompt-key/continuing-session test proving `disablePromptCacheAffinity: true` preserves cyclic capacity placement while an unrelated combo without it retains existing affinity.
- Management route tests proving POST and PUT preserve both new booleans and literal numeric `queueDepth: 0`.

The isolated candidate tree must be clean except for the authorized patch, all targeted tests and project type/lint/build checks must pass, and the image must be built with an immutable digest and source revision/tree label. Future patch line numbers and the candidate digest are necessarily unverified until the patch exists; they are release-gate artifacts, not values to infer.

## Canonical Managed JSON

These are the exact managed routing projections. Existing IDs are retained for updates; server-generated fields, descriptions, timestamps, and unrelated metadata are preserved from the current record. Every model-step ID is unique within its combo.

### `pool/tier1/code`

```json
{"name":"pool/tier1/code","strategy":"round-robin","models":[{"id":"code-t1-0","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","weight":1},{"id":"code-t1-2","kind":"model","model":"ollama-local/qwen3.8:27b-iq3-code144k","providerId":"ollama-local","connectionId":"b20e0770-3e14-40c1-87cd-85c34b34381a","weight":1},{"id":"code-t1-3","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","weight":1}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"concurrencyPerModel":2,"queueTimeoutMs":1000,"queueDepth":0,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"disablePromptCacheAffinity":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"trackMetrics":true},"context_length":163840,"context_cache_protection":false}
```

### `pool/tier1/research`

```json
{"name":"pool/tier1/research","strategy":"round-robin","models":[{"id":"research-t1-0","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","weight":1},{"id":"research-t1-2","kind":"model","model":"ollama-local/qwen3.8:27b-iq3-code144k","providerId":"ollama-local","connectionId":"b20e0770-3e14-40c1-87cd-85c34b34381a","weight":1},{"id":"research-t1-3","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","weight":1}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"concurrencyPerModel":2,"queueTimeoutMs":1000,"queueDepth":0,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"disablePromptCacheAffinity":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"trackMetrics":true},"context_length":163840,"context_cache_protection":false}
```

The shared provider caps are authoritative: 5090 connection `e9bd13fb-c6b6-4c18-b42f-3395266348ce` = 2; 4070 connection `b20e0770-3e14-40c1-87cd-85c34b34381a` = 1; GLM connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac` = 1. `concurrencyPerModel: 2` is coherent because the 4070 connection cap narrows it to one while the 5090 retains two.

### `pool/tier1b/code`

```json
{"name":"pool/tier1b/code","strategy":"round-robin","models":[{"id":"code-t1b-glm","kind":"model","model":"llama-cpp/ds4-glm53","providerId":"llama-cpp","connectionId":"70b82fc9-6f96-41ac-aa16-8da6099dd7ac","weight":100}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"concurrencyPerModel":1,"queueTimeoutMs":1000,"queueDepth":0,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"disablePromptCacheAffinity":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"trackMetrics":true},"context_length":1048576,"context_cache_protection":false}
```

### `pool/tier1b/research`

```json
{"name":"pool/tier1b/research","strategy":"round-robin","models":[{"id":"research-t1b-glm","kind":"model","model":"llama-cpp/ds4-glm53","providerId":"llama-cpp","connectionId":"70b82fc9-6f96-41ac-aa16-8da6099dd7ac","weight":100}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"concurrencyPerModel":1,"queueTimeoutMs":1000,"queueDepth":0,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"disablePromptCacheAffinity":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"trackMetrics":true},"context_length":1048576,"context_cache_protection":false}
```

### `hybrid/code`

```json
{"name":"hybrid/code","strategy":"priority","models":[{"id":"hybrid-code-tier1","kind":"combo-ref","comboName":"pool/tier1/code","weight":0},{"id":"hybrid-code-glm-overflow","kind":"combo-ref","comboName":"pool/tier1b/code","weight":0},{"id":"hybrid-code-tier2","kind":"combo-ref","comboName":"pool/tier2/code","weight":0},{"id":"hybrid-code-tier3","kind":"combo-ref","comboName":"pool/tier3/code","weight":0},{"id":"hybrid-code-tier4","kind":"combo-ref","comboName":"pool/tier4/code","weight":0},{"id":"hybrid-code-tier5","kind":"combo-ref","comboName":"pool/tier5/code","weight":0}],"config":{"maxRetries":0,"retryDelayMs":0,"targetTimeoutMs":600000,"comboTimeoutMs":2700000,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"nestedComboMode":"execute","failoverBeforeRetry":true,"trackMetrics":true,"tierRouting":{"defaultTier":1,"maximumTier":5}},"context_length":262144,"context_cache_protection":false}
```

### `hybrid/research`

```json
{"name":"hybrid/research","strategy":"priority","models":[{"id":"hybrid-research-tier1","kind":"combo-ref","comboName":"pool/tier1/research","weight":0},{"id":"hybrid-research-tier1b","kind":"combo-ref","comboName":"pool/tier1b/research","weight":0},{"id":"hybrid-research-tier2","kind":"combo-ref","comboName":"pool/tier2/research","weight":0},{"id":"hybrid-research-tier3","kind":"combo-ref","comboName":"pool/tier3/research","weight":0},{"id":"hybrid-research-tier4","kind":"combo-ref","comboName":"pool/tier4/research","weight":0},{"id":"hybrid-research-tier5","kind":"combo-ref","comboName":"pool/tier5/research","weight":0}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"nestedComboMode":"execute","failoverBeforeRetry":true,"trackMetrics":true,"tierRouting":{"defaultTier":1,"maximumTier":5}},"context_length":262144,"context_cache_protection":false}
```

### `local/code`

```json
{"name":"local/code","strategy":"priority","models":[{"id":"local-code-tier1","kind":"combo-ref","comboName":"pool/tier1/code","weight":0},{"id":"local-code-tier1b","kind":"combo-ref","comboName":"pool/tier1b/code","weight":0}],"config":{"maxRetries":0,"retryDelayMs":0,"targetTimeoutMs":600000,"concurrencyPerModel":2,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"stickyWeightedLimit":1,"nestedComboMode":"execute","failoverBeforeRetry":true,"trackMetrics":true,"tierRouting":{"defaultTier":1,"maximumTier":1}},"context_length":163840,"context_cache_protection":false}
```

### `local/research`

```json
{"name":"local/research","strategy":"priority","models":[{"id":"local-research-tier1","kind":"combo-ref","comboName":"pool/tier1/research","weight":0},{"id":"local-research-tier1b","kind":"combo-ref","comboName":"pool/tier1b/research","weight":0}],"config":{"maxRetries":0,"targetTimeoutMs":600000,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"disableSessionStickiness":true,"nestedComboMode":"execute","failoverBeforeRetry":true,"trackMetrics":true,"tierRouting":{"defaultTier":1,"maximumTier":1}},"context_length":163840,"context_cache_protection":false}
```

The extra inert `concurrencyPerModel` and `stickyWeightedLimit` on `local/code`, and `comboTimeoutMs` on `hybrid/code`, are preserved live metadata. No local root may reference cloud.

Every combo matching `^pool/tier[2-5]/[^/]+$` retains its existing strategy, models, weights, context, and config, with only `config.targetTimeoutMs` asserted as exactly 60000. Treat all 44 matching records as managed timeout writes unless fresh precondition readback already reports exactly that value.

## Backup, Deployment, API Apply, and Rollback

### Backup is the first production-host mutation

Develop, test, build, and publish the candidate first in an isolated clean worktree; these activities must not change the running deployment, management API records, canary records, or writable durable policy. Then, as the first production-host mutation and before editing `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`, deploying an image, making any management API write, or creating/running a canary, create `/home/celes/.local/state/omniroute-routing/{UTC_TIMESTAMP}-capacity-cascade/` with directory mode 0700 and files mode 0600. Write temporary files in that directory, fsync, chmod, atomically rename, then parse/hash/read them back. Capture:

- `combos.pages.json`: every raw paginated `GET /api/combos?limit=100&offset=N` response until a stable reported total is captured.
- `combos.full.json`: the full 93-record pre-change export.
- `combos.affected.json`: complete records for all eight lane names (a null marker for absent tier1b research), all 44 cloud pools, and the four tester records.
- `providers.affected.json`: complete sanitized item-GET records for the three provider IDs. Remove `apiKey`; reject rather than store access/refresh/ID tokens, Authorization material, or an unmasked secret. The item endpoint masks/deletes these fields (`src/app/api/providers/[id]/route.ts:64-96`).
- `omniroute-mode.py`: byte-for-byte writable-source copy.
- `deployment.json`: complete pre-change `kubectl -n omniroute get deployment omniroute -o json` output.
- `runtime.json`: deployment UID/resourceVersion/revision, ReplicaSet, pod, configured image, running immutable image ID, readiness, and rollout state.
- `manifest.json`: UTC timestamp, host, namespace, affected IDs/names, old source revision, hashes, counts, and modes.

Scan all backup files for the actual management key and known secret field names; any match is fatal. The old immutable image digest in `runtime.json` is the runtime rollback target.

### Candidate deployment, policy application, and canaries

Build and test the authorized source in the isolated clean worktree before production mutation; do not create or push a commit. No isolated production-equivalent staging target was found in the inspected environment, so focused unit/integration tests and an ephemeral local container are the pre-production checks. After the backup validates, follow one order only:

1. Deploy the candidate by immutable digest to `deployment/omniroute`, wait for rollout completion, verify the ready pod’s image ID and OCI source revision label, and require `/healthz` HTTP 200. Kubernetes uses `Recreate`, so inability to become ready is a fatal deployment gate.
2. Reconcile the writable durable policy source, then apply and read back the provider/combo records in dependency order. No canary begins before both durable and live policy match the desired projection.
3. Run canaries and acceptance tests: verify POST/GET/PUT/GET retention of numeric zero and both booleans; execute-mode child order; held GLM hybrid fail-up and local 503; synchronized cross-lane 4070 and GLM races; and continuing-session plus explicit prompt-key placement. Temporary unreferenced canary records are created only at this stage and deleted in `finally`.

Any failure after candidate deployment is recovered as one transaction: restore successful live policy mutations in reverse dependency order, restore `omniroute-mode.py` from the validated backup, restore the old immutable runtime digest, wait for rollout readiness, verify the old image ID and `/healthz`, and verify restored policy readback. A canary failure is never allowed to leave the candidate runtime or corrected/partial policy in place.

### Smallest management API operation set

All calls use management Bearer auth. There are no pricing writes and no PATCH calls.

Reads:

1. `GET /healthz` before backup, after each deployment, and after rollback.
2. Paginated `GET /api/combos?limit=100&offset=N` before apply and after apply. Validate array shape, integer stable total, progress, unique IDs/names, exact 44 anchored cloud names, and no duplicate rows.
3. `GET /api/providers/{id}` for the three IDs before and after apply.
4. `GET /api/combos/{id}` immediately before and after every changed combo PUT; the pre-write hash must equal the backup/precondition hash.
5. `GET /api/admin/concurrency` during canary and acceptance load; the endpoint exposes semaphore running/queued counts (`src/app/api/admin/concurrency/route.ts:10-18`).

Conditional production writes at the audited baseline:

- Zero expected provider writes; if drift exists, up to three `PUT /api/providers/{id}` requests with only `{"maxConcurrent":2}`, `{"maxConcurrent":1}`, or `{"maxConcurrent":1}`. The provider PUT updates only supplied fields (`src/app/api/providers/[id]/route.ts:137-175,205-218`).
- Five expected combo PUTs, preserving IDs: `pool/tier1/code`, `pool/tier1/research`, `pool/tier1b/code`, `hybrid/research`, and `local/research`.
- One expected `POST /api/combos`: absent `pool/tier1b/research`. If a record appears concurrently, refetch and accept it only if the full managed projection already matches; otherwise abort.
- No expected PUT for `hybrid/code` or `local/code`. Each of the 44 cloud pools receives a full-record PUT with only `config.targetTimeoutMs` changed unless fresh readback already equals `60000`; membership, strategy, weights, and all other config remain unchanged.

PUT bodies overlay the complete canonical managed keys onto the latest record and send the complete resulting `config`, because config is normalized as a unit. Apply provider caps first if needed; tier1 leaves; tier1b leaves; any cloud timeout corrections; roots last. Journal every successful mutation with before/after hashes.

On any write/readback failure, stop forward progress and restore successful policy mutations in reverse dependency order: roots, leaf/cloud combos, then providers. Remove newly created tier1b research only after no root references it. Restore `omniroute-mode.py` from backup if edited. Then restore the old runtime digest, wait for rollout, verify image ID and `/healthz`, and rerun policy readback. A failed rollback is fatal and blocks automatic restart/reconciliation; retain the backup and journal for operator recovery.

## Durable Python/Nix Source Mapping

Only `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py` is edited for durable routing. The read-only Nix-store symlink, changelogs, and changesets are untouched. Line numbers below refer to the inspected pre-change file.

1. Add `CASCADE_CATEGORIES = {'code', 'research'}` and `LEGACY_TESTER = {'tester'}`. At `TIER1_OVERRIDES` (`:40-63`), add research with `[(QWEN5090,1),(IQ3,1),(QWEN5090,1)]`; retain code and tester entries.
2. At `TIER1_CONCURRENCY` (`:92-97`), set code and research to 2. Tester is handled explicitly by the legacy branch rather than inheriting the new cascade builder.
3. At `PROVIDER_POLICIES` (`:128-139`), retain vLLM 2, set Ollama to 1, and retain llama-cpp 1.
4. Remove `queueDepth` from `OBSOLETE` and stop deleting it in `projection` (`:126-127,168-173`) and root construction (`:272-273`). Missing zero depth must compare as drift.
5. Keep local/default `targetTimeoutMs: 600000` in `config_for` (`:175-183`). Overlay 60000 only for every tier2–tier5 pool generated at `:201-250`.
6. Replace the current coupled `('code','tester')` GPU branch (`:225-250`) with `CASCADE_CATEGORIES`. Generate exact tier1 configs above, including both lane-scoped booleans, no weighted strategy keys, no retries, zero queue, and disabled session stickiness.
7. Generate round-robin tier1b only for `CASCADE_CATEGORIES` at `:251-262`; use GLM concurrency 1, queue depth 0, queue timeout 1000, and both lane-scoped booleans.
8. At root assembly (`:263-273`), use the special tier1→tier1b path for `CASCADE_CATEGORIES`; local ends there and hybrid appends tiers 2–5.
9. Preserve tester through a separate explicit legacy builder and fixture, not by replacing tester with research in shared conditions. Its exact pre-change live projection remains: tier1 round-robin `[5090,4070,5090]`, `concurrencyPerModel:2`, `queueTimeoutMs:120000`, `queueDepth:0`, `stickyRoundRobinLimit:1`, `disableSessionStickiness:true`, local timeout 600000; tier1b priority GLM, concurrency 1, queue timeout 15000, no zero-depth/new booleans; hybrid refs tier1→tier1b→tier2→tier3→tier4→tier5; local refs only tier1→tier1b. Preserve tester IDs, weights, contexts, root metadata, and prompt-affinity behavior. The new runtime booleans remain absent, so its shared-gate and prompt-affinity semantics do not change.
10. Make plan application dependency ordered instead of dictionary-order dependent. Preserve complete pagination and concurrent-edit hashes.
11. Replace the partial backup in `apply_plan` (`:302-309`) with the complete timestamped backup contract above, including deployment/runtime records. Keep provider writes conditional and exact.

A captured-live fixture unit test compares all `pool/*/tester`, `hybrid/tester`, and `local/tester` managed projections byte-for-byte before and after generation. Separate tests assert exact code/research JSON, unique step IDs, tier1b generation, root order, caps, zero-depth readback, 60000 ms cloud timeout without membership changes, idempotent second dry run, full pagination, backup permissions/redaction, dependency order, and rollback order. Compile the script with Python and run its dry-run against fresh production readback; post-apply dry-run must report no managed drift.

No durable Kubernetes deployment source was found by searching the named Nix checkout, so this design does not invent a file path. The approved prerequisite release must identify the actual image/deployment owner before sign-off; until then, the exact immutable `kubectl` deployment and rollback operations above are the verified live mechanism. This is an explicitly unverified ownership assumption, not permission to leave an untracked tag change indefinitely.

## Validation and Error Handling

After apply and after durable reapplication/restart, readback must show all eight canonical structures, caps 2/1/1, exactly 44 cloud pools at 60000, no tester projection changes, and zero managed drift. Inspect the vLLM workload separately and require `--max-num-seqs 2` before load testing; this cannot be proven from OmniRoute source.

Run five overlapping requests independently through `hybrid/code` and `hybrid/research`, then a mixed-lane run. Hold requests long enough to observe steady occupancy. `/api/admin/concurrency`, OmniRoute dispatch logs, and backend logs must show 5090=2, 4070=1, GLM=1, allowed cloud=1; queued account waiters remain zero for the corrected leaves; no backend exceeds its cap; and no `SEMAPHORE_TIMEOUT` or account-capacity HTTP 500 occurs. Repeat with shared continuation identity and explicit `prompt_cache_key`. With four local slots held, hybrid cloud dispatch and local 503 `ALL_TARGETS_SKIPPED` must occur within 2000 ms. Release held requests in `finally`.

Failure policy is concrete:

- Host/namespace, auth, health, schema, pagination, count, candidate digest/revision, isolated test, or backup creation/validation failure: fatal; stop before the next mutation and log only sanitized method/path/status and mismatch.
- Candidate rollout failure: fatal and recoverable by restoring the backed-up runtime digest, then verifying readiness, health, and image ID; no policy write begins.
- Durable/live policy failure, canary failure, concurrent record drift, 400/401/403/404/409/5xx mutation, dropped field, wrong cap/order/timeout, unexpected waiter, placement mismatch, or timing breach: fatal transaction failure; reverse live policy mutations, restore the durable source, and restore the old runtime digest, then verify all three layers.
- Create conflict is recoverable only if fresh readback exactly equals desired.
- Rollback mismatch or old image failing readiness is fatal and not automatically recoverable; preserve artifacts and require operator intervention.

## Assumptions and Unverified Items

- Current cloud membership and tier order are approved; only timeout is governed here.
- The inspected checkout proves source semantics but is not provenance-linked to the old deployed digest.
- The candidate image digest, final patch line numbers, selected canonical checkout, and actual durable Kubernetes deployment owner remain release-gate values that implementation must identify and verify; no commit or push is required.
- The vLLM `--max-num-seqs 2` runtime argument was not verified in OmniRoute source and is a separate pre-load gate.
- Source proves cyclic placement within a pool, not permanent request-number order across arbitrary prior traffic. Acceptance is based on occupied capacity and shared caps.

## Responses to Design Review Findings

1. **Resolved — authorized scope.** `requirements.md` now explicitly authorizes only the six named runtime files, focused tests, candidate image build, immutable-digest deployment, and rollback. This design uses that approved narrow scope, requires canonical-checkout verification, and forbids unrelated source changes, changelogs, changesets, commits, and pushes.
2. **Resolved — numeric-zero preservation.** The semantic chain now cites `open-sse/services/comboConfig.ts:275-278`: `Number(config.queueDepth)` is defaulted only when non-finite or negative, then floored and clamped, so literal zero remains zero. Required persistence/dispatch tests cover POST and PUT readback plus `queued: 0` and immediate advancement at both combo-local and shared-account gates for 4070 and GLM paths.
3. **Resolved — one backup/deployment order.** Isolated candidate development, tests, build, and publication occur first. The validated mode-`0600` backup is the first production-host mutation; only then may implementation deploy the candidate digest, apply durable/live policy, and run canaries. Any failed post-deployment gate restores live records, durable source, and the old immutable runtime digest.
