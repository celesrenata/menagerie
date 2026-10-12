# OmniRoute tier1b fix — production release report

## Outcome

**Not released; production is fully rolled back and healthy on the old immutable digest.**

Five fresh guarded transactions deployed the approved tier1b candidate, applied and read back the exact 50 intended policy changes, and entered the mandatory live canary. Every failed transaction executed the required failure policy: restore the old digest first, restore roots before leaves/cloud records, delete the newly created research tier1b only after roots no longer referenced it, restore the durable source byte-for-byte, and verify the complete rollback.

The candidate did prove the corrected core path in attempt 4: with direct fillers at vLLM `2/2`, Ollama `1/1`, and GLM `0/1`, a marked `local/research` request with no tier header skipped `pool/tier1/research`, selected `pool/tier1b/research`, acquired `llama-cpp/ds4-glm53`, returned HTTP 200, created no account waiter, used no cloud provider, and restored every request-specific permit to the exact zero baseline. The release still failed because all required canaries did not complete in one transaction. The final attempt reached vLLM `2/2`, Ollama `1/1`, GLM `1/1` with the marked parent at HTTP 200, then observed `vllm queued=1`; the explicit no-account-waiter gate therefore failed and triggered rollback.

Final production state:

- Configured and running image: `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`
- Ready pod: `omniroute-5d8c776fff-6vfrq`; exactly one ready replica
- Pod `imageID`: exact old digest above
- Fresh authenticated `/healthz`: HTTP 200, body `ok`
- Combo count: 93
- `pool/tier1b/research`: absent
- Provider caps: vLLM 2, Ollama 1, llama-cpp 1
- Cloud pools: exactly 44, all restored to `targetTimeoutMs=30000`
- Durable source SHA-256: `b01df6d64ca411616f8d4978d9590f55f1ff489134af2e70ce108034214944c4`, byte-identical to baseline
- Corrected candidate policy is **not active**.

## Read-only preflight and candidate identity

The in-transaction preflight and final independent post-rollback preflight both passed.

Old baseline checks:

- Deployment configured image and sole ready pod `imageID` were the exact old digest.
- Fresh port-forward health returned HTTP 200 `ok`.
- The paginated management API returned exactly 93 unique combos and the exact baseline projections.
- Provider projections matched baseline modulo only the eight approved volatile paths; caps were 2/1/1.
- Durable source matched the baseline bytes.
- Offline planning found exactly 50 intended changes, 44 cloud pools, and 80 managed records.

Approved candidate checks:

- Candidate digest: `registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`
- The forbidden stale digest `sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525` was never deployed.
- Revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `dfa5ef0b9142c57aee9915869620a47eea3bd310`
- Binary diff SHA-256: `be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`
- `git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z diff --check`: clean
- Temporary-index reconstruction returned the exact tree and diff hash; the real index remained empty.
- Allowlist was exactly the approved 20 paths: the prior 18 plus `open-sse/services/combo/tierRouting.ts` and `tests/unit/tier-routing.test.ts`.
- OCI labels read from the immutable digest were exact:
  - `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
  - `life.celestium.omniroute.candidate-tree=dfa5ef0b9142c57aee9915869620a47eea3bd310`
  - `life.celestium.omniroute.diff-sha256=be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`

## Fresh backups and transaction record

Each attempt created a new backup as its first production-state mutation. Every directory is mode 0700, every contained artifact is mode 0600, every journal is valid JSONL and fsynced per event, and all secret scans passed. Preconditions used **exactly** these eight volatile provider exclusions and no others:

1. `connection.lastTested`
2. `connection.providerSpecificData.apiKeyHealth`
3. `connection.updatedAt`
4. `connection.errorCode`
5. `connection.lastError`
6. `connection.lastErrorAt`
7. `connection.lastErrorType`
8. `connection.syncedModelsAt`

| Attempt | Fresh backup | Manifest SHA-256 | Final journal SHA-256 | Candidate pod | Old-digest rollback pod | Forward / rollback records |
|---:|---|---|---|---|---|---:|
| 1 | `/home/celes/.local/state/omniroute-routing/20261011T033722Z-capacity-cascade` | `8c03295e2be58018bfee21d1cd21801fa363a475d9ee260b91e507de8ab400b4` | `14ec96b41810b6d114cb74c0bd7ef2b251f5c977d9b62c30ff2a3fef133ae19a` | `omniroute-7f9bf6dbcc-6m4nt` | `omniroute-5d8c776fff-sk7xr` | 50 / 50 |
| 2 | `/home/celes/.local/state/omniroute-routing/20261011T034108Z-capacity-cascade` | `b9a79c351048014565f9e349ef3c91e0048a17e7715ba1615d376a92c9898552` | `8f6e5ce38b121544c2ca3e4d3b56795a70f8759a5faa32b758d9c7fef2219c9e` | `omniroute-7f9bf6dbcc-l2v4c` | `omniroute-5d8c776fff-bp96m` | 50 / 50 |
| 3 | `/home/celes/.local/state/omniroute-routing/20261011T034359Z-capacity-cascade` | `3ecb960c24f57fb9e8301ea69dc20c19505c17b671d97807f8da262b180da887` | `a638e10e128c4197dab2b6741887ff5fcb7b617772604deaa5145f73318b3685` | `omniroute-7f9bf6dbcc-jnrtq` | `omniroute-5d8c776fff-nhmm8` | 50 / 50 |
| 4 | `/home/celes/.local/state/omniroute-routing/20261011T034606Z-capacity-cascade` | `aafa693908aef60287ce452ae8c75e34f60db519288343e8f2476dd09d9682c9` | `7030ad12eb308f78bbb5e2846a288fd5c1de9293c4a44e0814c611ddffdbefd2` | `omniroute-7f9bf6dbcc-8jbdh` | `omniroute-5d8c776fff-gh7d8` | 50 / 50 |
| 5 | `/home/celes/.local/state/omniroute-routing/20261011T034849Z-capacity-cascade` | `f121cb2583dc5f4729b3751c862497859b80d039d4e1f09c767f4a8df64c6700` | `668980a6b3c56b088d0db2ea32465a604556c98f8bc15f31f4351b0a44863a41` | `omniroute-7f9bf6dbcc-ncrbq` | `omniroute-5d8c776fff-6vfrq` | 50 / 50 |

Every candidate and rollback runtime gate verified exact configured image, exact running `imageID`, one ready pod, one ready deployment replica, and health 200. Every journal contains one successful `rollback_verified` event and two successful `runtime_gate` events.

## Candidate deployment and exact 50-change readback

On every attempt the new digest rolled out successfully, its labels were rechecked, and the candidate passed the sole-ready-pod/imageID/health gate. The durable source was then written atomically, compiled with `py_compile`, loaded twice, and produced byte-for-byte identical offline plans. The candidate durable source SHA-256 was `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`.

Each attempt applied exactly 50 management API writes with immediate GET projection equality after every write:

- Structural records (6):
  - `PUT pool/tier1/code`: `c13e9fac…` → `cc393260…`
  - `PUT pool/tier1/research`: `ae059ad2…` → `8040ca15…`
  - `PUT pool/tier1b/code`: `b76c2d7f…` → `e679b995…`
  - `POST pool/tier1b/research`: absent projection `74234e98…` → `4db1bc9c…`
  - `PUT hybrid/research`: `637d4183…` → `4892e6bf…`
  - `PUT local/research`: `488432dc…` → `14d2a979…`
- Cloud timeout records (44): every `pool/tier{2,3,4,5}/{any,code,fast,frontier,long,planner,reader,research,reviewer,tester,tiny}` record was PUT and read back with `targetTimeoutMs=60000`.

The full before/after projection SHA-256 values for all 50 records are retained as `record_write` events in each secured journal above. The 44 exact cloud names are:

- Tier 2: `pool/tier2/any`, `code`, `fast`, `frontier`, `long`, `planner`, `reader`, `research`, `reviewer`, `tester`, `tiny`
- Tier 3: `pool/tier3/any`, `code`, `fast`, `frontier`, `long`, `planner`, `reader`, `research`, `reviewer`, `tester`, `tiny`
- Tier 4: `pool/tier4/any`, `code`, `fast`, `frontier`, `long`, `planner`, `reader`, `research`, `reviewer`, `tester`, `tiny`
- Tier 5: `pool/tier5/any`, `code`, `fast`, `frontier`, `long`, `planner`, `reader`, `research`, `reviewer`, `tester`, `tiny`

The live readback after the writes was exactly 94 combos. A temporary POST/GET/PUT/GET persistence canary proved that numeric `queueDepth: 0`, `disablePromptCacheAffinity: true`, and `failFastOnAccountCapacity: true` survived persistence, then deleted itself.

Exact forward policy projection while candidate policy was active:

- Code and research tier1 were round-robin `[vllm/qwen3.8-27b-nvfp4, ollama-local/qwen3.8:27b-iq3-code144k, vllm/qwen3.8-27b-nvfp4]`, using connection IDs `e9bd13fb-c6b6-4c18-b42f-3395266348ce`, `b20e0770-3e14-40c1-87cd-85c34b34381a`, `e9bd13fb-c6b6-4c18-b42f-3395266348ce`.
- Tier1 config: `concurrencyPerModel=2`, `queueDepth=0`, `queueTimeoutMs=1000`, `maxRetries=0`, `disableSessionStickiness=true`, `disablePromptCacheAffinity=true`, `failFastOnAccountCapacity=true`, `failoverBeforeRetry=true`, `targetTimeoutMs=600000`.
- Code and research tier1b were one-target round-robin `llama-cpp/ds4-glm53` on connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`, weight 100.
- Tier1b config: `concurrencyPerModel=1`, `queueDepth=0`, `queueTimeoutMs=1000`, the same booleans/retry policy, and `targetTimeoutMs=600000`.
- Hybrid code/research roots were exactly tier1 → tier1b → tier2 → tier3 → tier4 → tier5, with `defaultTier=1`, `maximumTier=5`.
- Local code/research roots were exactly tier1 → tier1b, with `defaultTier=1`, `maximumTier=1`.
- All 44 tier2–tier5 records had timeout 60000.
- Tester root/tier1/tier1b projections were unchanged; tester cloud records changed only through the global cloud timeout.
- Shared provider caps remained vLLM 2 / Ollama 1 / llama-cpp 1; no provider write was necessary.

## Canary helper diagnostic improvement

Before the first canary, the release wrapper was changed so that **every non-2xx chat response is journaled from the canary `finally` block before an exception can reach rollback**. The fsynced `canary_non_2xx_diagnostic` event contains:

- response body bounded to 4096 bytes;
- allowlisted non-secret response headers only;
- requested root, explicit proof that no tier header was sent, combo trace/ref lines, and request marker;
- the last 128 concurrency snapshots;
- candidate logs from `logs_since(canary_start)`, bounded to 12000 bytes;
- the exact start timestamp used for log collection.

The general failure-finally event also captures these fields for in-flight/no-response failures, including each request's marker, model, status/error, bounded body, safe headers, selected-combo trace lines, concurrency snapshots, and candidate logs. This closed the previous response-diagnostic gap. Later helper corrections prevented attribution of an unrelated occupancy delta until the exact filler request itself reached HTTP 2xx, synchronized the two vLLM fillers, and added retries only for pre-proof environmental filler completion/timeouts—never for queue growth, non-2xx parent behavior, a wrong backend, or failed exhaustion behavior.

## Full journaled canary evidence

### Successful mandatory research → GLM proof (attempt 4)

Journal: `/home/celes/.local/state/omniroute-routing/20261011T034606Z-capacity-cascade/journal.jsonl` (SHA-256 `7030ad12eb308f78bbb5e2846a288fd5c1de9293c4a44e0814c611ddffdbefd2`).

- Canary marker: `release-research-parent-skip-1791690376337885279-parent`
- Requested root: `local/research`
- Tier header sent: false
- Baseline: vLLM `0/2`, Ollama `0/1`, GLM `0/1`; every account/rate queue 0
- Direct filler occupancy: vLLM `2/2`, Ollama `1/1`, GLM `0/1`; every account/rate queue 0
- Parent occupancy: vLLM `2/2`, Ollama `1/1`, GLM `1/1`; every account/rate queue 0
- Selected provider: `llama-cpp`
- Parent HTTP status: 200
- Paid cloud requests: 0
- Fifth all-local request: HTTP 503 `ALL_TARGETS_SKIPPED`, not 500

Request-specific reverse release evidence was exact:

1. Parent GLM: `(2,1,1)` → `(2,1,0)`
2. Second vLLM filler: `(2,1,0)` → `(1,1,0)`
3. First vLLM filler: `(1,1,0)` → `(0,1,0)`
4. Ollama filler: `(0,1,0)` → `(0,0,0)`

No account or rate queue changed during this accepted mandatory scenario.

### Non-2xx diagnostic body and safe headers

The expected fifth local-only exhaustion response was captured before rollback:

- Status: 503
- Bounded body: `{"error":{"message":"Service temporarily unavailable: all targets were skipped by pre-dispatch filters","type":"service_unavailable","code":"ALL_TARGETS_SKIPPED"}}`
- Safe headers:
  - `content-type: application/json`
  - `Date: Sun, 11 Oct 2026 03:46:34 GMT`
  - `x-correlation-id: 315121d7-7ef5-4208-97f7-09fc44be89a3`
  - `x-omniroute-combo-trace: combo-b79ac910-4b27-49e4-b40d-6385975b219a`
  - `x-omniroute-route-class: CLIENT_API`
  - `x-omniroute-session-id: 0a0b5f48f7b265a9`
  - `x-request-id: 3d30e28e-df60-48d6-a9fd-f352993e928a`

No authorization, cookie, API key, or provider credential header was recorded.

### Selected combo trace/ref and candidate logs

The bounded candidate logs and trace event recorded the following sequence:

1. `POST /v1/chat/completions | local/research`.
2. `Combo "local/research" [priority] with 2 models`.
3. `local/research: requested tier 1` (default; no tier header was sent).
4. `Skipping combo-ref combo:pool/tier1/research — concurrency cap reached`.
5. `Trying combo-ref combo:pool/tier1b/research`.
6. `[RR #0] → llama-cpp/ds4-glm53`.
7. `Provider: llama-cpp, Model: ds4-glm53` and masked account selection.
8. `[ProxyEgress] llama-cpp status=success`.
9. The fifth `local/code` request skipped both saturated local refs and returned `ALL_TARGETS_SKIPPED`.

The complete bounded log payload, all 128 snapshots, exact bodies, safe headers, and trace arrays remain in the journal event; backup validation confirmed the management key does not occur in any artifact.

### Final strict attempt and release-blocking waiter

The final attempt's failure-finally event is in `/home/celes/.local/state/omniroute-routing/20261011T034849Z-capacity-cascade/journal.jsonl` (SHA-256 `668980a6b3c56b088d0db2ea32465a604556c98f8bc15f31f4351b0a44863a41`). It captured 128 snapshots and all in-flight response evidence before rollback.

All exact canary requests had HTTP 200 and safe SSE headers: one Ollama filler, two vLLM fillers, and the `local/research` parent. The parent had no tier header, returned HTTP 200, and logs again showed tier1 pre-skip → tier1b → `llama-cpp/ds4-glm53` → successful llama-cpp egress. Seven consecutive final snapshots showed `(vLLM running=2 queued=0, Ollama running=1 queued=0, GLM running=1 queued=0)`. The next snapshot was:

`vLLM running=2 queued=1; Ollama running=1 queued=0; llama-cpp running=1 queued=0; all rate queues=0`.

That violated the mandatory no-account-waiter assertion. There was no non-2xx response in this final attempt, so the per-non-2xx list was correctly empty; the general finally diagnostic still recorded empty/partial bodies as applicable, all safe response headers, the selected combo trace, the 128 snapshots, and candidate logs before rollback began.

### Attempt progression and uncompleted gates

- Attempt 1: an unrelated `hybrid/code` request won the second vLLM slot; the original helper misattributed its occupancy delta to the direct filler, whose resulting vLLM waiter correctly caused failure.
- Attempt 2: after requiring the exact filler to reach 2xx, an earlier vLLM filler completed while the second was being established; the synchronized state fell from vLLM 1 to 0.
- Attempt 3: an unrelated vLLM request appeared while the slow Ollama filler was warming; the pre-proof attempt was rejected.
- Attempt 4: the mandatory no-header research→GLM HTTP-200 scenario and exact release chain passed. The later affinity scenario was invalidated when Ollama voluntarily stopped after 793 completion tokens before synchronized occupancy formed.
- Attempt 5: one environmental pre-proof attempt was discarded under the bounded retry rule. The next attempt reached all four local permits and the marked parent returned HTTP 200 from GLM, but vLLM `queued` changed 0→1, so the release failed closed.

Because no single transaction completed all mandatory gates, this report does **not** claim successful completion of the code repetition/affinity, mixed-lane, EOF, cancel, full timeout/HTTP-500 scan, or final acceptance gates. No paid cloud request was made in any attempt.

## Structural validation and observability

Before canary entry on every attempt:

- durable source `py_compile`: pass;
- two identical offline policy builds: pass;
- intended change set: exactly 50;
- managed records: 80;
- cloud records: exactly 44 at 60000 in the candidate plan/readback;
- exact code/research tier1, tier1b, local, and hybrid projections: pass;
- queue depth zero persistence canary: pass and cleaned up;
- tester non-cloud projections: unchanged;
- provider projections/caps: exact modulo only the eight approved volatile fields.

A read-only cluster scan found no deployment, statefulset, or daemonset exposing `--max-num-seqs`; therefore vLLM `--max-num-seqs 2` was not observable and is not claimed.

## Rollback verification

Every failure used this order:

1. Patch the deployment back to the old immutable digest before any policy/source restore.
2. Wait for rollout and verify the old exact `imageID`, one ready pod, and health 200 through a fresh port-forward.
3. Restore hybrid/local roots first.
4. Restore changed tier1/tier1b leaves and all 44 cloud records.
5. Delete newly created `pool/tier1b/research` only after no root referenced it.
6. Restore provider caps if drifted (none drifted).
7. Restore `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py` byte-for-byte.
8. Verify all 93 combo projections, provider projections modulo the exact eight exclusions, source bytes, backup hashes/modes, and secret scan.

The final independent readback confirms the old digest is both configured and running, the service is healthy, there are 93 combos, research tier1b is absent, all 44 cloud pools are back at 30000, caps are 2/1/1, and durable source bytes equal the baseline. The candidate digest and corrected 60000-ms policy were not left active.
