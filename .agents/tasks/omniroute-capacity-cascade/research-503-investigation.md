# OmniRoute `local/research` 503 Investigation

## Summary answer

The failed production canary was caused by **root tier-routing filtering, not GLM capacity and not a failure of the parent-skip patch**. Before nested runtime-unit execution begins, `selectRequestedTier()` filters root combo references using `^pool/tier([1-5])/`. That expression accepts `pool/tier1/research` but does **not** accept `pool/tier1b/research`. The active `local/research` payload had `tierRouting: {"defaultTier":1,"maximumTier":1}` and the canary supplied no `X-OmniRoute-Tier`, so the default-tier pass silently removed tier1b. The patched executor consequently received only the saturated tier1 child, pre-skipped it, and returned HTTP 503 `ALL_TARGETS_SKIPPED`. GLM was never a candidate and none of its capacity, availability, cooldown, circuit-breaker, model-lockout, hidden-model, or context checks ran.

The focused parent-skip regression passed because its root fixture omitted `tierRouting`; both tier1 and tier1b therefore reached `executeRuntimeUnitCombo()`. It also set `fallbackOnlyOnQuotaExhaustion: true` on both references, while the exact production references did not contain that field. The fixture proved the narrow parent pre-skip change but did not reproduce the upstream production root transformation.

The canary's load construction was valid: direct 5090 and 4070 requests acquired the same process-local account semaphore keys that `runtimeUnitCapacity` reads, and the isolated exact-payload reproduction saw the intended tier1 saturation. The canary's **diagnostics were defective**, however: it read the HTTP error body into memory but raised an assertion containing only marker/status/error, did not retain headers, and did not capture candidate logs before rollback. The deleted pod's stdout is no longer available through Kubernetes or the worker's kubelet log proxy. Thus the surviving production evidence contains the exact status but not the original response bytes or dynamic trace header. The classification is nevertheless deterministic from the published source and was reproduced with the exact production payload: `ALL_TARGETS_SKIPPED`, not generic capacity, unavailable model, or context filtering.

Do not retry this candidate in production. First fix tier parsing so `tier1b` is represented as logical local tier 1, add an exact production-shape regression that enters through `handleComboChat()` with tier routing enabled and realistic provider/account capacity, and improve the canary to journal response body/headers and failure-time logs before rollback.

## Evidence

### 1. Production transaction and 503 classification

The final transaction journal identifies the candidate pod and timeline:

- Candidate runtime gate: pod `omniroute-5b494bf746-jbwc5`, digest `sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525`, health 200 at `2026-10-11T03:04:16.478333Z`.
- Post-rollout account state: vLLM, Ollama, and llama-cpp each `running=0, queued=0, rateQueued=0` at `03:04:16.895015Z`.
- Policy and persistence operations completed before traffic; the failure was recorded at `03:04:20.919593Z`.
- Exact preserved production assertion: `AssertionError({'marker': 'release-research-parent-skip-1791687858496281345-3', 'status': 503, 'error': None})`.
- Rollback restored digest `sha256:41a9b0a6...` and passed at `03:04:59.838432Z`.

Sources: remote `20261011T030338Z-capacity-cascade/journal.jsonl`; local `semaphore-fix-release.md:147-156`.

The original response body and headers were not durably retained. `HeldRequest` stores an HTTP error body in `self.output` (`semaphore_release.py:647-648`), but the early-completion assertion serializes only marker, status, and error (`semaphore_release.py:811-812`). Headers are never copied. `logs_since()` is called only later in the successful canary sequence, so rollback began without a candidate log capture. Kubernetes reports that the candidate pod ran on `gremlin-2` with container ID `d58b886b03a...`, but the pod is deleted and its kubelet log directory has already been garbage-collected. The remaining host journal contains container start/stop events, not application stdout.

An isolated run against the same candidate source used the exact helper-generated three-combo payload, real provider rows with caps 2/1/1, real account semaphore keys, two occupied vLLM permits, one occupied Ollama permit, and an available llama-cpp account. It produced:

- Selected root references after tier routing: `['pool/tier1/research']`.
- HTTP status: `503`.
- Headers: `content-type: application/json` and a per-request `x-omniroute-combo-trace` value.
- Body: `{"error":{"message":"Service temporarily unavailable: all targets were skipped by pre-dispatch filters","type":"service_unavailable","code":"ALL_TARGETS_SKIPPED"}}`.
- Model dispatches: none.
- Failing-path logs: `local/research: requested tier 1`, followed by `Skipping combo-ref combo:pool/tier1/research — concurrency cap reached`.
- Control with only `tierRouting` removed: HTTP 200 with exactly one dispatch, `llama-cpp/ds4-glm53`.

The dynamic production `x-omniroute-combo-trace` value cannot be recovered. The body above is the deterministic candidate body for the confirmed path, generated by `allTargetsSkippedResponse()` (`runtimeUnits.ts:54-64`), but it should not be misrepresented as a byte capture from the deleted pod.

### 2. Exact active payloads and provider caps

The backup contains the pre-change records. The active candidate records are recoverable exactly from the immutable helper build plus its strict POST/PUT readback assertions (`semaphore_release.py:528,550`). The final journal records their IDs and projection hashes, and `live_policy_applied` confirms all 50 writes and 94-combo readback completed.

`pool/tier1/research`, record ID `ad888e43-2437-4ab6-bd10-b26bb039e8de`, active projection hash `8040ca1509965e069d0def066198af846aa64e3137cb46ca8621771188227962`:

```json
{"name":"pool/tier1/research","description":"Tier 1 research: 5090 Qwen3.8 / 4070 Qwen3.8 IQ3 round-robin 2:1 interleave","strategy":"round-robin","models":[{"connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","id":"research-t1-0","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","weight":1},{"connectionId":"b20e0770-3e14-40c1-87cd-85c34b34381a","id":"research-t1-1","kind":"model","model":"ollama-local/qwen3.8:27b-iq3-code144k","providerId":"ollama-local","weight":1},{"connectionId":"e9bd13fb-c6b6-4c18-b42f-3395266348ce","id":"research-t1-2","kind":"model","model":"vllm/qwen3.8-27b-nvfp4","providerId":"vllm","weight":1}],"config":{"concurrencyPerModel":2,"disablePromptCacheAffinity":true,"disableSessionStickiness":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"maxRetries":0,"queueDepth":0,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"strategy":"priority","targetTimeoutMs":600000,"trackMetrics":true},"context_cache_protection":false,"context_length":163840}
```

The nested `config.strategy: "priority"` is stale preserved metadata from the old record. It is not causal: runtime strategy selection uses top-level `combo.strategy` (`comboSetup.ts:77-81`), which was `round-robin`.

`pool/tier1b/research`, newly created record ID `b7511bc3-a51c-47d3-87ac-13b7521925c4`, active projection hash `4db1bc9c1d2323e71763b81f8e1a5ead770ed6d6a26f6ecb4a2d922c2e2af532`:

```json
{"name":"pool/tier1b/research","description":"Research high-context overflow: GLM-5.3 1M local before cloud","strategy":"round-robin","models":[{"connectionId":"70b82fc9-6f96-41ac-aa16-8da6099dd7ac","id":"research-t1b-glm","kind":"model","model":"llama-cpp/ds4-glm53","providerId":"llama-cpp","weight":100}],"config":{"concurrencyPerModel":1,"disablePromptCacheAffinity":true,"disableSessionStickiness":true,"failFastOnAccountCapacity":true,"failoverBeforeRetry":true,"maxRetries":0,"queueDepth":0,"queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"targetTimeoutMs":600000,"trackMetrics":true},"context_cache_protection":false,"context_length":1048576}
```

`local/research`, record ID `5dff08d5-d260-4582-9b82-ae75d0a552c9`, active projection hash `14d2a979060155cf47f1295e032d9b590f58e615c35a85179b67a2fe9945b9b2`:

```json
{"name":"local/research","description":"research routing: local-only; per-task X-OmniRoute-Tier","strategy":"priority","models":[{"comboName":"pool/tier1/research","id":"local-research-tier1","kind":"combo-ref","weight":0},{"comboName":"pool/tier1b/research","id":"local-research-tier1b","kind":"combo-ref","weight":0}],"config":{"disableSessionStickiness":true,"failoverBeforeRetry":true,"maxRetries":0,"nestedComboMode":"execute","queueTimeoutMs":1000,"stickyRoundRobinLimit":1,"targetTimeoutMs":600000,"tierRouting":{"defaultTier":1,"maximumTier":1},"trackMetrics":true},"context_cache_protection":false,"context_length":163840}
```

The three sanitized provider records in the final backup were:

| Provider / connection | Name | `isActive` | `testStatus` | `maxConcurrent` | Relevant model behavior |
|---|---|---:|---|---:|---|
| `vllm` / `e9bd13fb-c6b6-4c18-b42f-3395266348ce` | `esnixi-5090` | true | active | 2 | pinned Qwen model in combo |
| `ollama-local` / `b20e0770-3e14-40c1-87cd-85c34b34381a` | `gremlin-4070ti-ollama` | true | active | 1 | pinned IQ3 model in combo |
| `llama-cpp` / `70b82fc9-6f96-41ac-aa16-8da6099dd7ac` | `stabulous-m5max` | true | active | 1 | `passthroughModels: true`; default model differs but combo pins `ds4-glm53` |

The GLM connection also had `backoffLevel: 0`, `rateLimitProtection: false`, and no persisted health object entries in the sanitized backup. Runtime circuit and model-lockout state was not captured. That missing state does not weaken the causal finding because tier routing removed the GLM combo reference before any such state could be inspected.

Sources: remote final backup `combos.affected.json`, `providers.affected.json`, and `journal.jsonl`; helper payload construction at `semaphore_release.py:429-450`.

### 3. Every material difference from the passing regression fixture

The fixture is `tests/unit/combo-runtime-unit-concurrency.test.ts:247-345` in the candidate worktree.

| Area | Passing fixture | Exact active production shape | Effect |
|---|---|---|---|
| Root tier policy | No `tierRouting` | `defaultTier: 1`, `maximumTier: 1` | **Causal.** Production runs `selectRequestedTier`; fixture bypasses it. |
| Root refs reaching executor | tier1 and tier1b | tier1 only after name-regex filtering | **Causal.** GLM cannot be checked or dispatched. |
| Root quota flags | Both refs set `fallbackOnlyOnQuotaExhaustion: true` | Field absent on both refs | Not causal to this failure, but means fixture did not match production protection semantics. |
| Root metadata | Minimal config: execute mode, retries, failover | Full timeout, stickiness, tracking, and tier config | Tier config is causal; other fields are not. |
| Leaf IDs and weights | IDs and weights omitted | Unique IDs; tier1 weights 1/1/1; GLM weight 100 | Not causal to parent precheck, but required for an exact fixture. |
| Tier1 config | Only `maxRetries: 0`, `queueDepth: 0` | Full concurrency, queue timeout, affinity, fail-fast, retry, timeout, tracking; stale nested `strategy` | Not causal to removal of tier1b. |
| Tier1b config | Only `maxRetries: 0`, `queueDepth: 0` | Full concurrency 1, fail-fast, affinity, timeouts, tracking | Never evaluated in the failed request. |
| Context metadata | Omitted | tier1 163840; tier1b 1048576; cache protection false | Never evaluated for GLM because its root ref was removed first. |
| Connection records | Synthetic IDs seeded at 2/1/1 | Real IDs, active provider rows, caps 2/1/1 | Capacity semantics match, but production identity was not covered. |
| Request shape | Empty body, no headers | Streaming marked chat body, no tier header | Both select default tier 1 only when tier policy exists; fixture had none. |
| Availability | Stub always true | Production callback plus resilience state | Production callback was never called for GLM. |

The fixture therefore accurately tests `executeRuntimeUnitCombo()` once both children exist, but not the production entry path that mutates the root before the executor.

### 4. Exact execution trace and eligibility inputs

1. `handleComboChat()` calls `selectRequestedTier(combo, requestHeaders)` before combo setup or nested dispatch (`combo.ts:739-745`).
2. The canary did not send `X-OmniRoute-Tier`, so the root policy selected default tier 1 (`tierRouting.ts:27-39`).
3. `selectRequestedTier()` retained only combo refs matching `^pool/tier([1-5])/` and within 1..1 (`tierRouting.ts:49-56`). `pool/tier1/research` matched. `pool/tier1b/research` did not match at all and was removed.
4. Execute-mode resolution therefore produced one root runtime unit, tier1 (`dispatchPrelude.ts:691-711`).
5. `isRuntimeUnitAtConcurrencyCap()` expanded tier1's visible child targets, deduplicated by connection, looked up positive caps, and required every limited connection to be full (`runtimeUnitCapacity.ts:65-88`). Direct fillers had established vLLM 2/2 and Ollama 1/1 with queue zero, so tier1 was pre-skipped.
6. The candidate parent-skip code recognized an all-combo-ref priority root, counted the one capacity-skipped child, and returned `allTargetsSkippedResponse()` (`runtimeUnits.ts:212-218,238-260,362-369`).
7. There was no tier1b runtime unit. Consequently `runtimeUnitCapacity` did not query the GLM cap; `executeModelUnit` did not call `isModelAvailable`; child target resolution did not inspect hidden-model visibility or context compatibility; and resilience checks could not inspect provider cooldown, circuit state, or model lockout.

This explains why `llama-cpp running=0` was insufficient evidence: it established semaphore headroom but not eligibility. In this incident the missing eligibility input was even earlier—the root had removed the GLM tier structurally.

### 5. Candidate provenance and production execution

The published immutable digest currently reports these OCI labels:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=49b1623b10e6a622e9432d09f3a2c0a318f91352`
- `life.celestium.omniroute.diff-sha256=907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`

The preserved final build `candidate.env` contains the same revision/tree/diff identity and successful status. The worktree still contains the parent-skip additions in `runtimeUnits.ts`, including `priorityComboRefRoot`, `capacitySkippedComboRefs`, and the `ALL_TARGETS_SKIPPED` terminal response. The tier regex is present unchanged in HEAD, showing it predates and sits outside the parent-skip patch.

Production did execute the published digest: the transaction runtime gate recorded the exact digest and candidate pod; the retained ReplicaSet template uses that exact digest; pod status captured image ID `sha256:59baef...`; and Kubernetes events show it was started on `gremlin-2` before the canary and stopped only after rollback began. Direct application logs were not retained, so there is no marker-correlated production log line proving a particular source branch. The digest/source identity plus deterministic exact-payload reproduction is the available execution proof.

Sources: OCI label readback; remote `semaphore-sentinel-final-20261011T023611Z/candidate.env`; final journal; ReplicaSet `omniroute-5b494bf746`; `runtimeUnits.ts` diff.

### 6. Isolated exact-production reproduction

The reproduction did not modify source, deployment, live API, or production data. It ran the candidate source in a temporary data directory, created three active provider rows using the real provider/connection IDs and caps, acquired real account semaphore permits for vLLM 2/2 and Ollama 1/1, left llama-cpp available, and called `handleComboChat()` with the exact active combo projections and marked canary body. The temporary database was removed afterward.

Result: failure reproduced as HTTP 503 `ALL_TARGETS_SKIPPED`, no model call, tier1b absent from selected refs. Control: deleting only `local.config.tierRouting` preserved both refs and dispatched GLM successfully with HTTP 200. This isolates the defect to root tier selection rather than account capacity, leaf strategy, model availability, or the parent-skip executor.

### 7. Canary validity

The canary was valid for the behavior under test:

- Direct fillers use real `/v1/chat/completions` model calls and acquire account semaphores in the candidate pod.
- The account semaphore key is provider plus connection/account identity, the same identity checked by `runtimeUnitCapacity`.
- The helper asserted exact tier1 occupancy 2/1 and zero account queues immediately before the parent (`semaphore_release.py:828-835`).
- A normal `local/research` request with no tier header is supposed to use the root's default tier. Tier1b is explicitly a local overflow slot and should remain eligible under maximum tier 1.

It was not invalid due to context, target mismatch, or a GLM backend outage: GLM never reached those gates. The canary should be improved diagnostically by persisting status, headers, bounded body, selected combo refs/decision trace, semaphore snapshot, and `logs_since(start)` in a `finally` block before initiating rollback.

## Conclusions and recommendations

1. **Root cause:** `selectRequestedTier()` does not understand the `tier1b` naming convention. The root policy and tier parser disagree about whether tier1b belongs to logical tier 1.
2. **503 class:** `ALL_TARGETS_SKIPPED` generated by the parent-skip candidate after tier routing left only saturated tier1. It was not generic capacity, unavailable model, context rejection, or a GLM semaphore failure.
3. **Parent-skip patch:** present in the published digest and deployed. It behaved consistently; its regression fixture was too simplified to expose the upstream tier filter.
4. **Canary:** load/state construction was valid, but evidence capture was inadequate. This is a runtime-policy contract defect revealed by the canary, plus a canary observability defect—not a bad capacity filler design.

Recommended narrow fix, without implementing it here:

- Change `selectRequestedTier()` in `open-sse/services/combo/tierRouting.ts` to parse `pool/tier1b/*` explicitly and map it to logical numeric tier 1. Keep tiers 2–5 numeric. This preserves intended semantics: default/local tier 1 includes tier1 and tier1b; requested tier 2 includes local capacity plus tier2+; requested tier 3+ excludes both local tier1 variants.
- Do not remove `tierRouting` as the primary fix; that would disable the documented `X-OmniRoute-Tier` contract and hide the parser/schema mismatch.
- Add a direct tier-routing unit test for tier1b and an exact incident regression using the full production projections, real IDs/weights/config, absent `fallbackOnlyOnQuotaExhaustion`, default tier headers, provider caps 2/1/1, and real account semaphore occupancy. Assert: tier1 full/tier1b free dispatches only GLM; all local full returns 503 `ALL_TARGETS_SKIPPED`; tier 2 includes both local pools before cloud; tier 3 excludes tier1 and tier1b.
- Retain the existing simplified parent-skip tests as executor-level coverage, but do not treat them as production-shape integration coverage.
- Update the release helper before any future canary so every non-2xx response journals bounded body and non-secret headers and captures candidate logs before rollback.

Next step: prepare and review a new isolated candidate containing only the tier1b parser correction plus the exact regressions above, run the focused suite and full static/build gates, inspect the built artifact identity, and run the exact-payload isolated reproduction against that artifact. Only after those gates pass should an improved, evidence-preserving canary be considered. Another blind production retry of `sha256:59baef...` would deterministically fail again.
