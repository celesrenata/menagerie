# OmniRoute Semaphore-Fix Production Release Report

## Outcome

The approved semaphore-fix candidate was **not released**. Five fresh, independently backed-up production transactions reached the candidate runtime and exact policy state, then rolled back because mandatory canary evidence was not sufficient. The final deterministic canary established full tier1 occupancy with direct local 5090/4070 requests while GLM's account semaphore was available, but the marked `local/research` parent returned HTTP 503 instead of acquiring GLM. This failed the required tier1-to-tier1b acceptance gate.

Per the mandatory failure policy, each attempt restored the old immutable runtime digest before replaying legacy payloads, restored roots before leaves/cloud records, deleted the created research tier1b only after roots no longer referenced it, and restored the durable source byte-for-byte.

Production is healthy and fully rolled back on:

`registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

The corrected policy is **not active**. There are 93 combos, `pool/tier1b/research` is absent, and all 44 tier2-tier5 cloud pools are back at `targetTimeoutMs=30000` rather than the requested 60000.

## Approved candidate identity

Candidate:

`registry.celestium.life/library/omniroute@sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525`

Read-only preflight proved the exact source/image identity:

- Revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `49b1623b10e6a622e9432d09f3a2c0a318f91352`
- Binary diff SHA-256: `907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`
- Allowlist count: 18 exact paths
- `git diff --check`: PASS
- OCI revision/tree/diff labels: exact
- Old configured and running image before every transaction: exact old healthy digest

The temporary-index identity command loaded HEAD into a separate `GIT_INDEX_FILE`, added only the approved 18-path allowlist, ran `git write-tree`, and hashed `git diff --cached --binary --full-index HEAD`. It did not mutate the real index.

## Transaction helper and preflight

The transaction used the prior validated helper as its base and retained its backup, precondition, policy, persistence, rollout, and rollback mechanisms. The release-specific helper is recorded at:

`.agents/tasks/omniroute-capacity-cascade/semaphore_release.py`

Before each production attempt, the helper passed:

- Python compilation;
- command-wrapper self-test for successful JSON parsing and nonzero-command failure propagation;
- candidate registry label verification;
- old digest, one ready pod, exact running `imageID`, and authenticated `/healthz` HTTP 200 through a fresh service port-forward;
- 93-combo baseline projection;
- provider baseline modulo exactly the eight authorized volatile paths;
- byte-identical durable source baseline;
- offline policy build twice with identical output;
- exactly 80 managed records, 50 intended changes, and 44 cloud pools.

The authorized provider precondition exclusions were exactly:

1. `connection.lastTested`
2. `connection.providerSpecificData.apiKeyHealth`
3. `connection.updatedAt`
4. `connection.errorCode`
5. `connection.lastError`
6. `connection.lastErrorAt`
7. `connection.lastErrorType`
8. `connection.syncedModelsAt`

No additional provider path was excluded.

## Forward gates passed in every attempt

Each fresh transaction completed the following before its canary failure:

1. Created and validated a new backup as the first production-state mutation. The directory was mode 0700, every artifact was mode 0600, the journal was fsynced per event, and the management-key scan was clean.
2. Rechecked strict preconditions against that fresh backup.
3. Patched the `Recreate` deployment to the new immutable candidate digest.
4. Verified the exact configured digest, one ready pod, exact candidate `imageID`, exact OCI labels, and authenticated `/healthz` HTTP 200 through a newly started service tunnel.
5. Captured account semaphore occupancy immediately after rollout. Account queues were zero in every captured baseline.
6. Reconciled durable `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`.
7. Passed Python compilation and two identical offline `build('tiered', live)` projections.
8. Applied exactly 50 policy writes with immediate per-record readback: six code/research structures plus 44 cloud timeout records.
9. Verified 94 live combos while the policy was active, exact managed projections, unchanged tester records, exact roots, and queue depth zero preservation.
10. Passed the temporary POST/GET/PUT/GET persistence canary for numeric `queueDepth: 0`, `disablePromptCacheAffinity: true`, and `failFastOnAccountCapacity: true`, then deleted it.

Provider caps were already exact and required no provider writes:

- vLLM/5090: 2
- Ollama/4070 Ti Super: 1
- llama-cpp/GLM: 1

The active candidate policy during each forward phase was exact:

- Code and research tier1 round-robin: 5090, 4070 Ti Super, 5090
- `concurrencyPerModel=2`, `queueDepth=0`, `queueTimeoutMs=1000`, `maxRetries=0`
- `disableSessionStickiness=true`, `disablePromptCacheAffinity=true`, `failFastOnAccountCapacity=true`
- Local target timeout: 600000 ms
- Code and research tier1b: one GLM target, round-robin, concurrency 1, queue depth 0, queue timeout 1000 ms, same booleans and retry policy, timeout 600000 ms
- Hybrid roots: tier1 -> tier1b -> tier2 -> tier3 -> tier4 -> tier5
- Local roots: tier1 -> tier1b only
- Exactly 44 tier2-tier5 cloud pools at 60000 ms
- Tester projections unchanged

No paid cloud request was sent by any transaction. Controlled traffic used direct local models or `local/code`/`local/research` only.

## Fresh backups and journals

All attempts used fresh backups; no prior backup was reused.

| Attempt | Backup | Manifest SHA-256 | Final journal SHA-256 | Forward writes | Rollback records |
|---|---|---|---|---:|---:|
| 1 | `/home/celes/.local/state/omniroute-routing/20261011T024705Z-capacity-cascade` | `a13fc3311461bcbd2b671d01aadac51ea3733a4b1de7bf9db377cea8dd75206d` | `89492362f11718ccc04d3442c669cff4143984bb54577cab2091e319e6dd300a` | 50 | 50 |
| 2 | `/home/celes/.local/state/omniroute-routing/20261011T025155Z-capacity-cascade` | `4ba422443544636c3386bd3066417d88cb743666f05c3e718448c734f8dbc743` | `34cbb5ada6b8c6e5cf2d1c469af4d65bac40d353d67ac1fb5651f1425ea7844e` | 50 | 50 |
| 3 | `/home/celes/.local/state/omniroute-routing/20261011T025604Z-capacity-cascade` | `571ac6b1f75ca7535631fd67d114fc770599a2ecf4330ae172a0e7c55f2eac75` | `5552b4947b87d71ffff46bf8d5e286754034b261d9c4d0e200db36a869ba617b` | 50 | 50 |
| 4 | `/home/celes/.local/state/omniroute-routing/20261011T025753Z-capacity-cascade` | `2a0d42fa9bb874fb9fca00e1fd6a25ba517b69dbb1287c53ce486768af3c33da` | `0dd5b41587de636bf949bbcc76f1c02d9be9c1b0e497b332b9846f1f30d1001f` | 50 | 50 |
| 5 | `/home/celes/.local/state/omniroute-routing/20261011T030338Z-capacity-cascade` | `30069de1befb697e60f98133abb504ed83de0f26599005afbdf458d1a72039c4` | `a2e8312f6b95e182bc95da436ebcf01fbebea6e6d3b75fa7cd5fa906f7f26f4b` | 50 | 50 |

Independent scans confirmed all five directories/files remain 0700/0600 and contain no management key. Every journal contains two successful runtime gates (candidate forward and old-digest rollback) and one successful `rollback_verified` event.

## Canary attempts and findings

### Attempt 1: correlation-output assumption

The controlled request reached the expected first 5090 occupancy slot, but production logging did not emit the debug-level `ACCOUNT_SEMAPHORE` correlation event. The helper refused to infer ownership and rolled back. Failure:

`AssertionError({'marker': 'release-research-parent-skip-1791686869704930302-0', 'events': []})`

The canary was corrected to use exact pre-request occupancy deltas and exact post-EOF/cancel baseline restoration, with correlated logs required only when unrelated work made exact deltas ambiguous.

### Attempt 2: live occupancy correctly detected

The immediate post-rollout account baseline was `vllm=0, ollama=1, llama-cpp=0`, all queued zero. Before the scenario, unrelated work had moved to `vllm=1, ollama=0, llama-cpp=0`. The initial revised harness still required a zero-running baseline and correctly refused to pass without natural-traffic correlation evidence. Failure:

`CapacityBlocked(... vllm running=1 ...)` with `naturalEvidence={}`

The canary was corrected to preserve current production occupancy and fill only remaining capacity rather than requiring cluster idle.

### Attempt 3: rate-limit queue distinguished from account queue

The marked 5090 request acquired its account permit (`vllm running` moved 0 -> 1) with account `queued=0`, while the separate provider rate-limit queue briefly reported `rateQueued=1`. The harness had incorrectly treated that as an account waiter and rolled back. It was corrected to require the account semaphore's queued count to remain at baseline during the request while still requiring the complete state, including rate-limit queues, to return to baseline after release.

### Attempt 4: ambiguous replacement occupancy

The controlled scenario reached local occupancy and began reverse teardown. Marked 4070 and one marked 5090 request returned exactly to their captured pre-request states. The final 5090 count remained one rather than returning to zero for 90 seconds. With no debug correlation available, the helper could not distinguish a replacement production request from a retained marked permit and rolled back rather than weakening the release assertion.

This led to deterministic direct-provider fillers and preservation of the original canary exception during cleanup.

### Attempt 5: definitive parent cascade failure

This attempt used direct local backend requests to fill only missing tier1 capacity, avoiding round-robin filler ambiguity:

- direct 5090 fillers targeted `vllm/qwen3.8-27b-nvfp4`;
- direct 4070 filler targeted `ollama-local/qwen3.8:27b-iq3-code144k`;
- account queued counts remained at baseline;
- full tier1 occupancy was asserted before the parent request;
- GLM account occupancy was zero and available before the parent request.

The unique marked `local/research` parent request then completed with HTTP 503 without an attributable GLM acquisition:

`AssertionError({'marker': 'release-research-parent-skip-1791687858496281345-3', 'status': 503, 'error': None})`

This violates the mandatory requirement that the production parent advance tier1 -> tier1b and that the real GLM backend accept the corrected cascade when capacity allows. No source-regression-plus-correlated-natural-traffic fallback evidence was available. The transaction therefore stopped and rolled back.

Because this mandatory gate failed, the following downstream acceptance claims are intentionally **not** made:

- successful production research tier1-to-tier1b cascade;
- successful EOF/cancel lifecycle probes for the final transaction;
- complete affinity/repetition/mixed-lane scenarios;
- absence of 120s/300s semaphore timeouts over a completed canary window;
- absence of queue-full HTTP 500 over a completed canary window;
- final release-time vLLM `--max-num-seqs 2` gate. A post-rollback Kubernetes workload scan did not find a current deployment/statefulset/daemonset or pod containing that argument, so it cannot be claimed from this transaction.

## Rollback order and verification

Every failed attempt used the required rollback order:

1. Restore the old immutable digest first.
2. Wait for the old `Recreate` deployment and verify one ready pod.
3. Start a fresh service tunnel and verify authenticated `/healthz` HTTP 200.
4. Restore hybrid/local roots first.
5. Restore tier1/tier1b leaves and all 44 cloud records.
6. Delete newly created `pool/tier1b/research` only after roots no longer reference it.
7. Restore providers if required; no provider restore write was needed because caps did not drift.
8. Restore durable `omniroute-mode.py` byte-for-byte.
9. Verify all 93 combo projections, providers modulo only the eight authorized volatile fields, source bytes, backup modes, and management-key scan.

The final independent readback returned:

- Deployment strategy: `Recreate`
- Configured image: exact old healthy digest
- Ready pod: `omniroute-5d8c776fff-cttbp`
- Running pod `imageID`: exact old healthy digest
- Authenticated `/healthz`: HTTP 200
- Combo count: 93
- `pool/tier1b/research`: absent
- Cloud pool count: 44
- Cloud timeout values: `[30000]`
- Provider caps: `[2, 1, 1]`
- Providers: exact baseline modulo the eight approved volatile paths
- Durable source: byte-identical baseline
- Candidate labels: still exact in the registry
- Final read-only helper preflight: PASS

One parallel final-readback invocation briefly collided with another read-only helper on the same local port-forward port and returned connection refused. It made no mutation. The identical readback was immediately rerun serially and passed with the results above.

## Commands and operational record

The production work used these command classes over SSH to `celes@192.168.42.254`:

- `git rev-parse`, `git status --porcelain`, `git diff --check`, temporary-index `git write-tree`, and binary diff hashing for source identity;
- `docker buildx imagetools inspect` for immutable candidate labels;
- `kubectl get deployment/replicasets/pods`, `kubectl patch deployment`, and `kubectl rollout status` for runtime gates;
- dedicated `kubectl port-forward service/omniroute` tunnels for authenticated health and management API readbacks;
- management API paginated combo reads, per-record PUT/POST/readback, provider reads, concurrency reads, persistence canary, and rollback replay;
- Python `py_compile` and two identical offline generator builds;
- direct local-only chat canary requests with unique request/session/prompt markers;
- independent post-rollback preflight, policy projection, provider projection, backup mode/hash, and secret scans.

No commit or push changed OmniRoute application source. No image was rebuilt or republished. No user workload was reset, canceled, or preempted. No paid cloud request was made.
