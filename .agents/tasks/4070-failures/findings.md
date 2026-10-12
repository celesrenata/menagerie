# RTX 4070 Ti Super failure investigation

**Investigation window:** 2026-10-11 21:24:00Z–22:59:52Z (95m52s). All timestamps below are UTC. Investigation was read-only: no code/config/routing/service/deployment changes, no restarts, and no generation canary. Probes were finite GETs (`/v1/models`, `/api/tags`, `/api/ps`), SQLite was opened `readonly:true`, and observed generation traffic was pre-existing workflow traffic.

## Summary answer

The reported failures are real and are primarily **OmniRoute-local execution expirations, not 4070/Ollama failures**. Two 4070 attempts ended as OmniRoute 504s at **22:46:30.740Z** and **22:50:30.808Z**, both at ~120.625s. The 4070 connection has a stale per-connection override, `rate_limit_overrides_json={"maxWaitMs":120000}`. `resolveRequestQueueMaxWaitMs()` gives this override precedence, and `executeWithRateLimit()` incorrectly/legacy-semantically passes that queue wait value to Bottleneck as an **after-dispatch execution expiration**. This defeats both the global/pod `300000ms` value and the combo `targetTimeoutMs=600000` (`open-sse/services/rateLimitManager.ts:164-176, 561-570, 633-650`; `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py:176-184`).

Ollama returned HTTP 200 for both affected upstream calls. It completed the first at **22:46:45Z**, only ~14s after OmniRoute gave up, and the second at **22:51:06Z**, ~36s after OmniRoute gave up. There were no input-shape/system-message/tool-grammar errors, context overflows, Ollama queue errors, load/residency failures, network/tunnel failures, stream-readiness failures, idle timeouts, or quality-rejection failures in the window.

### Counts

`call_logs` contains **35 4070 model-attempt rows across 33 logical correlation IDs**:

| Measure | Count | Meaning |
|---|---:|---|
| 4070 attempt/selection rows | 35 | 32 status 200, 1 status 499, 2 status 504. Duplicate attempt rows share two correlation IDs, hence 33 logical requests. |
| Successful 4070 attempt rows | 32 | 30 distinct logical correlations; 2 duplicate/nested rows share correlations. |
| 4070 capacity skips | 6 request-level | 5 reconstructed from later `code-t1-2`/`code-t1-3`/tier-2 selections with no 4070 attempt in that correlation, plus a directly logged max-cap skip at 22:59:09.950Z. Historical pod logs were garbage-collected during repeated rollouts, so this is a request-level count, not a guaranteed count of every repeated internal skip event. |
| Upstream HTTP failures from Ollama | 0 | Every observed Ollama `/v1/chat/completions` ended HTTP 200. |
| OmniRoute-generated attempt failures | 3 | Two local 504 execution expirations and one 499 abort. |
| Stream readiness failures | 0 | No readiness error row/log; configured readiness timeout was not reached. |
| Client cancellations | 1 | 22:21:00.379Z attempt 499; logical request 499 at 22:21:00.391Z, `[499] Client disconnected`. |
| Timeouts | 2 | Both `RATE_LIMIT_EXECUTION_TIMEOUT` at ~120.625s. No 60s cloud, 300s idle, 600s target, 900s fetch, or 1200s readiness timeout fired. |
| Quality failures | 0 | No quality error/rejection in call rows or available routing logs. |

Final outcomes for the **33 logical requests that actually attempted the 4070** were **31 successes**, **1 client-cancelled request**, and **1 request with no persisted fallback success**. The first 504 fell back successfully to Uzu (after one transient Uzu capacity response); the second 504 was followed by an OmniRoute Recreate rollout before a fallback success was persisted.

Current state at cutoff is healthy but does not invalidate the incident. Revision 121 served a naturally occurring 4070 request in **175.186s** (OmniRoute success at 22:59:05Z; Ollama HTTP 200 at 22:59:09Z), despite the stale 120s override still being persisted. This suggests the newest image/startup state no longer exercised the same limiter-expiration path for that request, but the contradictory override remains latent and should be corrected explicitly rather than relying on current probes.

## Evidence

### 1. Exact failed 4070 attempts and classification

Detailed artifacts are stored under `/app/data/call_logs` and read by `readCallArtifact()` (`src/lib/usage/callLogArtifacts.ts:10-13, 234-253`). All three artifacts were `detail_state=ready` with pipeline details.

1. **22:21:00.379Z — 499, 3,421ms**
   - Call ID: `1791757256948-7088b3`
   - Correlation: `b1cea2fc-6206-4bf5-8865-ecfb9de0283e`
   - Exact artifact error: `Request aborted`
   - Exact final logical error at 22:21:00.391Z: `[499] Client disconnected`
   - Artifact response body: `null`; pipeline keys: `clientRawRequest`, `providerRequest`, `error`.
   - Classification: **client disconnect/cancellation**. Ollama continued after the client left and logged HTTP 200 at 22:21:14Z (16.64s total), then released its slot. This is not a model, network, grammar, or timeout failure.

2. **22:46:30.740Z — 504, 120,623ms**
   - Call ID: `1791758670107-18bec4`
   - Correlation: `da7e01c4-fe99-4e91-95db-cec75de18484`
   - Exact `call_logs` and artifact error:
     > `[504]: Request exceeded OmniRoute's local rate-limit execution expiration (legacy resilienceSettings.requestQueue.maxWaitMs=120000ms) for ollama-local/qwen3.8:27b-iq3-code144k. Bottleneck applies this deadline only after dispatch; it does not bound queue wait and is not an upstream-generated timeout.`
   - Artifact response body: `null`; only pipeline key is `error`.
   - Classification: **OmniRoute-local execution timeout**. Ollama logged HTTP 200 at 22:46:45Z after 2m14s, released task 65714, and reported all slots idle. The logical request then hit one Uzu 503 at 22:48:01.924Z but succeeded on Uzu at 22:48:28.837Z. Final request outcome: **fallback success**.

3. **22:50:30.808Z — 504, 120,626ms**
   - Call ID: `1791758910164-2f04e1`
   - Correlation: `03c61aa9-e00e-46e1-9290-f333b43910c5`
   - Exact error body: identical to item 2, including `maxWaitMs=120000ms` and code `RATE_LIMIT_EXECUTION_TIMEOUT` in the SSE error body.
   - Artifact response body: `null`; only pipeline key is `error`.
   - Classification: **OmniRoute-local execution timeout**. Ollama itself returned HTTP 200 at 22:51:06Z after 2m35s, released task 66153, and went idle. No successful fallback row was persisted before the 22:52:31Z OmniRoute rollout. Final request outcome: **timeout/interrupted fallback**, not an Ollama failure.

No failure body referenced message shape, system-message position, tool grammar, token/context limits, model loading, upstream queue saturation, tunnel/network transport, readiness, idle timeout, or quality validation.

### 2. Why 120 seconds won over the intended local timeout

Live state at cutoff:

- Connection `b20e0770-3e14-40c1-87cd-85c34b34381a`: `is_active=1`, `test_status=active`, `backoff_level=0`, `rate_limited_until=null`, `error_code=null`, `last_error=null`, `last_tested=22:55:24.609Z`, `max_concurrent=1`.
- Crucially: `rate_limit_overrides_json={"maxWaitMs":120000}`.
- Pod/global setting: `RATE_LIMIT_MAX_WAIT_MS=300000`; persisted `resilienceSettings.requestQueue.maxWaitMs=300000`.
- `hybrid/code`: `targetTimeoutMs=600000`, `queueTimeoutMs=1000`, `comboTimeoutMs=2700000`.
- `pool/tier1/code`: `targetTimeoutMs=600000`, `queueTimeoutMs=1000`, `queueDepth=0`, `concurrencyPerModel=1`, `failFastOnAccountCapacity=true`, priority order 5090 → 4070 → Uzu → 5090.

The precedence is explicit in `resolveRequestQueueMaxWaitMs()`: connection override first, configured/global value second (`rateLimitManager.ts:164-176`). The resulting value is then assigned to Bottleneck `expiration`, whose clock begins after dispatch (`rateLimitManager.ts:561-570`). The thrown text at `rateLimitManager.ts:633-650` exactly matches both failures.

This is separate from the intended route policy. The durable mode script sets one 4070 connection slot and 600s target timeout while keeping queues disabled (`omniroute-mode.py:131-142, 176-184`). The investigation made no changes to this shared priority pool.

### 3. Ollama/4070 host and endpoint

Finite GET/read-only observations:

- `10.1.1.12` identifies as `gremlin-1`, GPU `NVIDIA GeForce RTX 4070 Ti SUPER` (16,376 MiB).
- `/v1/models` and `/api/tags`: HTTP 200; model present with source context capability 262,144.
- `/api/ps` at 22:59:52Z: `qwen3.8:27b-iq3-code144k` resident, `size_vram=14,439,300,464`, runtime `context_length=147456`, runner `llamacpp`, expiry 23:29:49Z.
- `/api/show`: Modelfile explicitly sets `num_ctx 147456` and `draft_num_predict 0`.
- Ollama Deployment: `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_NUM_PARALLEL=3`, `OLLAMA_MAX_QUEUE=8`, `OLLAMA_MAX_LOADED_MODELS=1`, flash attention on, q4_0 KV cache. The actual 27B runner command has `-c 147456 -np 1`; thus this large resident model is effectively one stream, matching OmniRoute `maxConcurrent=1`.
- Pod `ollama-697b9d686d-v2b86` has run on gremlin-1 since 2026-10-09 19:06:53Z with zero restarts. Runner was continuously resident since 20:54:39Z.
- At a live snapshot, GPU memory was ~14,505 MiB and utilization 100% while serving existing traffic; no OOM/CUDA/load failures appeared.

There was no need for a generation canary. Existing traffic supplied multiple successful requests, including the >120s success on revision 121.

### 4. Network, readiness, and timeout correlation

- Cluster-to-4070 tunnel RTT: 0.68–1.09ms in the sampled pings, 0% loss; TCP 2701 connected.
- Tunnel interface counters showed zero RX/TX errors or drops; peer pings in logs were ~1–2ms.
- `/v1/models` returned HTTP 200 (about 3.14s during load); `/api/ps` returned in ~3ms.
- Ollama chat logs contain HTTP 200 for every observed POST. No network exception, reset, queue-full response, model load failure, or context overflow occurred.
- Deployment values were `STREAM_READINESS_TIMEOUT_MS=1200000`, `STREAM_READINESS_MAX_TIMEOUT_MS=1200000`, `STREAM_IDLE_TIMEOUT_MS=300000`, `FETCH_TIMEOUT_MS=900000`, and `REQUEST_TIMEOUT_MS=2700000`. None matches the exact 120,623/120,626ms failures.
- Therefore the current 60s cloud timeout is not implicated. The 600s route target also did not fire; it was preempted by the 120s per-connection Bottleneck expiration.

### 5. Capacity behavior

The 4070 was selected/attempted frequently and was not forgotten: 35 attempt rows in the window. The priority pool correctly skipped it when its one connection slot was occupied. Five request-level skips are reconstructable from later-tier correlations with no 4070 attempt; another is directly logged at **22:59:09.950Z**:

> `Skipping ollama-local/qwen3.8:27b-iq3-code144k — connection b20e0770-3e14-40c1-87cd-85c34b34381a is at max concurrency cap (1)`

A 4070 semaphore 429 (`Semaphore queue full (0)`) exists at 21:15:09Z, just before the chosen window, on a correlation whose long Uzu fallback completed inside the window. It supports the same fail-open, zero-queue capacity behavior but is excluded from the table counts.

### 6. Active workflow and recent routing changes

Workflow `wf_5742370c2e9eb6e6` (`final-cache-speedups`) was still in its implement/review loop. Its plan changes memory placement/compression and Arc reranking and explicitly says shared 5090/4070/Uzu routing and zero queues must remain unchanged (`.agents/tasks/final-cache-speedups/plan.md`, especially items 2–4, 8, and 12). Arc/Bedrock/GLM changes do not explain the error bodies:

- Arc embedding/memory injection successfully prepared the 4070 requests; the model accepted them and Ollama returned 200.
- Bedrock appeared only as a separate tier-2 success for another correlation.
- GLM/Uzu shares the `llama-cpp` connection, not the 4070 connection. Uzu capacity affected fallback latency once, but did not cause either 4070 failure.

The workflow **did affect final reliability through rollouts**. OmniRoute used Recreate and revisions/images were created at 22:18:22Z, 22:30:36Z, 22:41:07Z, 22:52:31Z, and again 22:54:49Z. At 22:52:03Z the Service temporarily had no endpoints and public `/health` returned 503. The terminating pod reported waiting for two in-flight requests. The rollout at 22:52:31Z overlaps the second 4070 timeout's fallback window and explains why no final fallback success was persisted. Revision 121 was healthy at cutoff.

The rollout series did not create the stale `maxWaitMs=120000` data, but recent images/startup state changed whether that latent override was exercised: the two failures occurred on revision 119, while revision 121 naturally completed a 175s 4070 request. This should be treated as version/startup-path sensitivity until verified, not proof that the underlying mismatch is gone.

## Conclusions and recommendations

### Ranked root causes

1. **High confidence — stale per-connection 120s override is being used as an execution timeout.** This exactly matches both errors and code paths. It cuts off valid 4070 generations shortly before Ollama completes them and bypasses the intended 600s target timeout.
2. **High confidence — repeated single-replica Recreate rollouts amplified one incident.** They caused endpoint gaps and interrupted the second timeout's fallback path. They are not the cause of Ollama behavior but can turn a recoverable model-attempt failure into a final request failure.
3. **Low confidence/minor — fallback Uzu capacity.** One first fallback returned 503 capacity before succeeding. This increases recovery latency but is not a 4070 root cause.
4. **Not supported by evidence:** input/system/tool grammar, context overflow, Ollama queue/load/residency, tunnel/network, readiness/idle timeout, quality rejection, Arc/Bedrock/GLM routing damage, or the 60s cloud timeout.

### Smallest safe corrections (implement nothing during this investigation)

1. **After `wf_5742370c2e9eb6e6` reaches a stable boundary, back up the provider row and remove only the 4070 connection's stale `maxWaitMs:120000` override.** This is reversible by restoring the exact JSON. It does not disable rate limiting, alter `maxConcurrent=1`, enable queues, change priority order, or change reservations; it makes the connection inherit the current 300s setting immediately.
2. **Durably fix timeout semantics rather than relying on override removal.** `requestQueue.maxWaitMs` should not be passed as an after-dispatch execution expiration. Preserve the limiter and hard semaphore, but let the existing combo `targetTimeoutMs=600000` govern local model execution (or introduce a separately named local execution deadline set to 600s). Add a regression test where a local stream exceeds 120s but completes below 600s and must remain successful. Roll back by restoring the prior image digest.
3. **Do one drained rollout, not repeated Recreate rollouts.** Wait for local in-flight counters/streams to reach zero, deploy once, and verify one ready endpoint before resuming changes. If the new image fails, restore `registry.celestium.life/library/omniroute@sha256:6e3c16d63416a3398e013cac8d1001c90ba968ab79afe2c23e7a9a3e1929364d` (the healthy cutoff image) and wait for readiness.
4. **Do not change the current shared priority pool.** Keep queues disabled, `maxConcurrent=1`, one-stream reservation behavior, and fail-open fallback. The observed max-cap skip is correct and protects the GPU from dogpiling.

### Verification after correction

- Read back the provider and require `maxConcurrent=1`, active state, no backoff/cooldown, and no `maxWaitMs:120000` override.
- Read back `hybrid/code` and `pool/tier1/code`; require priority order, `queueDepth=0`, `queueTimeoutMs=1000`, `concurrencyPerModel=1`, and `targetTimeoutMs=600000` unchanged.
- During natural traffic (or one documented minimal canary only if necessary), observe a request lasting >120s and <600s: require 4070 `call_logs.status=200`, Ollama HTTP 200, and no `RATE_LIMIT_EXECUTION_TIMEOUT`.
- Submit/observe two parallel eligible requests: one may use the 4070 and the other must immediately capacity-skip/fall through without queueing; GPU runner remains `-np 1` and OmniRoute never exceeds one 4070 stream.
- Observe at least 30–60 minutes across long prompts; count model attempts separately from final correlation outcomes and require zero new local 120s expirations.
- Confirm `/api/ps` keeps the model resident at context 147456 and tunnel RTT/error counters remain normal.

No changes were implemented.