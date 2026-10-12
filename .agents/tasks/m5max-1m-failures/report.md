# M5 Max GLM-5.3 1M-Context Regression — Per-Failure Root-Cause Report

Read-only investigation. No config, model, flake, k8s, or server state was changed.

Scope: OmniRoute requests routed to `stabulous-m5max` (`llama-cpp/ds4-glm53`, connection `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`) since the GLM-5.3 context window was raised from 163840 to 1048576 (`--ctx 1048576`, `--kv-disk-space-mb 307200`). Window examined: ~last 6 h (cluster UTC 2026-10-04 15:43Z–21:43Z = Mac local PDT 08:43–14:43). Note the 7 h offset: cluster `call_logs` timestamps are UTC; ds4/proxy logs are PDT (UTC−7).

---

## Executive summary — one line per failure

All five M5-routed non-200s trace to one root cause (the 1M-ctx switch thrashing a 128 GB machine), expressed through two different timeout/abort layers:

1. **21:36:12Z `502 terminated`, 1,202,372 ms (20.04 min), code-t1-glm** — cluster **STREAM_READINESS/headers timeout (1,200,000 ms = 20 min)** fired because the 1M-era prefill never produced a first byte within 20 min. Prefill for ~155K tokens now takes ~8.5–9 min and decode runs at <5 t/s; a real large turn blows past 20 min TTFB. **Layer: cluster OmniRoute headers/stream-readiness timeout.**
2. **18:16:06Z `504` "Stream failed before producing a non-ping SSE event: hedge-cancelled", 215,777 ms, code-t1-glm** — the GLM target was too slow to first byte, so the combo's **hedge/failover cancelled this sibling** in favor of a faster tier target. **Layer: cluster combo hedging + slow M5.**
3. **18:47:12Z `502 terminated`, 130,041 ms, compressed=18 tokens, code-t1-glm** — tiny input, yet 502. The proxy logged **200** for both requests in that window; this was a **cluster-side cancelled hedge/overflow sibling** (`pool/tier1b/code` GLM overflow raced against tier1), not an ds4 failure. **Layer: cluster combo hedging.**
4 & 5. **20:18:03Z and 20:24:03Z `499` "Client disconnected: request_signal_aborted", 377,218 / 384,580 ms (~6.3 min), planner-t1-0, compressed=1454 tokens** — `hybrid/planner` tier-1 has **only one target, `ds4-glm53`, `concurrencyPerModel:1`** and the connection is `max_concurrent:1`. With the single GLM slot occupied by a slow decode, these small planner turns **queued, produced no first byte, and the Zoo/outer client aborted** after ~6 min. The proxy recorded these as `502 0 "Cannot write to closing transport"` (downstream closed the socket first → abort originates upstream, not ds4/proxy). **Layer: client/outer abort while blocked behind the single busy M5 slot.**

Underlying cause for all five: raising `--ctx` to 1,048,576 added ~20 GB of resident allocation (context buffers 5,110→15,209 MiB; DSA KV graph 1.83→11.69 GiB) on a 128 GB machine, driving it into severe swap (12.95 GB of 14 GB used). This collapsed decode throughput ~5× (≈21–28 t/s → <5 t/s) and stretched prefill to ~8.5 min even for ~155K-token turns. The model has **never actually run above ~161K ctx** (OmniRoute compresses input to ~160K), so the 1M window delivers zero benefit while causing the thrash. The 300 GB SSD KV cache is net-negative: it is constantly full and evicts blocks with **`hits=0`**.

---

## Evidence

### The failures (cluster `call_logs`, read read-only via `kubectl -n omniroute exec deploy/omniroute -- node … better-sqlite3 /app/data/storage.sqlite`)

M5-routed non-200s (`provider=llama-cpp`, `model=ds4-glm53`, `account=stabulous-m5max`, `connectionId=70b82fc9-…`):

| UTC timestamp | PDT | status | duration ms | combo / step | tokens_in | compressed | error_summary |
|---|---|---|---|---|---|---|---|
| 21:36:12.953Z | 14:36 | 502 | 1,202,372 | hybrid/code / code-t1-glm | 0 | 27,388 | terminated |
| 20:24:03.680Z | 13:24 | 499 | 384,580 | hybrid/planner / planner-t1-0 | 0 | 1,454 | Client disconnected: request_signal_aborted |
| 20:18:03.959Z | 13:18 | 499 | 377,218 | hybrid/planner / planner-t1-0 | 0 | 1,454 | Client disconnected: request_signal_aborted |
| 18:47:12.753Z | 11:47 | 502 | 130,041 | hybrid/code / code-t1-glm | 0 | 18 | terminated |
| 18:16:06.597Z | 11:16 | 504 | 215,777 | hybrid/code / code-t1-glm | 0 | 7,557 | Stream failed before producing a non-ping SSE event: hedge-cancelled |

All five carry `tokens_in:0`, `tokens_out:0`, `ttft_ms:null` → not one produced a first byte. The `compressed` field (post-compression input size) shows the cluster never sent the M5 more than ~27K tokens — large turns are already compressed well below 1M.

(Separate, non-M5 noise in the same window — a different box at `10.1.1.12`: ollama `qwen3.8:27b` 504s "Fetch timeout after 110000ms", reader `qwen3.5-reader:9b` 499 "Request aborted" ×8 and one 429 "Semaphore timeout after 120000ms". These are the ollama node, not the M5, and are out of scope beyond noting the cluster was under broad load.)

### The timeout ladder actually in force on the CLUSTER (kubectl get deploy omniroute env)

```
REQUEST_TIMEOUT_MS               = 2700000   (45 min)
OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = 1200000 (20 min)
STREAM_READINESS_TIMEOUT_MS      = 1200000   (20 min)   <-- fires first on TTFB
STREAM_READINESS_MAX_TIMEOUT_MS  = 1200000   (20 min)
STREAM_IDLE_TIMEOUT_MS           = 300000    (5 min)
```
Connection `stabulous-m5max` `provider_specific_data`: `{ baseUrl: http://192.168.133.2:7777/v1, passthroughModels: true, timeoutMs: 2700000 }`, `max_concurrent: 1`, `test_status: active`, no `last_error`.

The connection `timeoutMs` was correctly raised to 45 min, **but the headers / stream-readiness ceiling is still 20 min**. The 21:36:12Z failure duration of 1,202,372 ms = **20.04 min** matches `STREAM_READINESS_TIMEOUT_MS`/`OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS` to the second. This is the single clearest fingerprint in the data.

### Proxy-side correlation (`/Users/celes/ai/logs/local-model-proxy.log`, PDT)

The proxy logs request **start** time; the cluster logs **end** time. Matching them:

- `13:17:48 [ERROR] Upstream error: Cannot write to closing transport` / `502 0` started `13:11:46` (~6 m) → cluster 499 at 20:18:03Z (planner).
- `13:23:33 … Cannot write to closing transport / 502 0` started `13:17:39` (~5m54s) → cluster 499 at 20:24:03Z (planner).
- `11:16:07 … Cannot write to closing transport / 502 0` started `11:12:32` (~3m35s) → cluster 504 at 18:16:06Z (hedge-cancelled).
- `14:16:03 … Cannot write to closing transport / 502 0` started `14:05:32`, then `14:36:12 [ERROR] Error handling request from 10.1.1.12` — the 20-min window `14:16→14:36` → cluster 502 at 21:36:12Z. The distinct "Error handling request" (vs "closing transport") marks the readiness-timeout cut.
- `11:47` window: proxy returned **200** (`11:45:03→200`, `11:46:23→200`). The cluster's 18:47:12Z 502 (compressed=18) had **no matching proxy failure** → it was a cancelled cluster hedge sibling, not an ds4/proxy error.

"Cannot write to closing transport" = ds4/proxy was still streaming when the **downstream (cluster/Zoo) closed the socket** → the abort originates at or above the cluster, confirming the 499s are outer-client aborts, not local timeouts. There are **no** `Cannot connect to host 127.0.0.1:8082`, SIGTERM, OOM-kill, or restart markers for ds4 in the window → **the ds4 server did not crash; it was alive but too slow.**

### Throughput regression (`/Users/celes/ai/logs/glm53-dwarfstar-server.log`, PDT)

- 1M-ctx reconfigure happened at **02:35:55**: `context buffers 5110.50 MiB → 15209.40 MiB`; `GLM graph … DSA cache … f16 1.83 GiB → 11.69 GiB` (ctx 163840 → 1048576). ~**+20 GB resident**.
- Pre-change baseline decode (00:44, 01:26, ctx 65–134K): **21–28 t/s**.
- Post-change sustained decode at ~155–160K ctx: **0.97–5 t/s** (log minimum `avg=0.31 t/s`; many chunks 1.8–3.1 t/s). ≈**5–20× collapse.**
- Prefill `prompt done` for ~144–157K tokens: **506–547 s (~8.5–9 min)**. Linear extrapolation to a real 1M prefill ≈ 55–60 min — far beyond the 20-min headers ceiling, so a genuine large turn can never return headers in time.
- **Max ctx ever observed in the entire log = 161,111.** The model has never run above ~161K; OmniRoute compression caps effective input near 160K. The 1M window is unused.

### KV disk cache is net-negative (same log)

- Dir size **300 GB** (= `--kv-disk-space-mb 307200`), disk **83% full, 663 GB free**.
- Counts over the log: `disk-cache-full` evictions **4,246**; `reason=evict` **986**; `live kv cache miss` **1,032**; `kv cache hit` **413**.
- Representative evictions carry **`hits=0`** (e.g. `14:23:47 … evicted reason=disk-cache-full tokens=133120 hits=0 size=3185.95 MiB`) — multi-GB blocks written then discarded unused.
- Live prefix invalidation is frequent, e.g. `14:36:23 live kv cache miss … reason=token-mismatch` → `kv cache skipped … reason=evict because KV payload staging failed: session has no valid checkpoint to stage` → forced rebuild. The cache is churning, not accelerating.

### Memory pressure (vm_stat / sysctl at investigation time)

`hw.memsize` 137,438,953,472 (128 GiB). `vm.swapusage total 14,336 MB, used 12,955.25 MB` (90%+). `vm_stat`: pages free ~4,488 (×16 KiB ≈ 70 MB free), wired ~110 GB, compressor occupying ~8.4 GB. The machine is thrashing.

---

## Conclusions (per investigation question)

1. **Which layer failed, per failure** — see the executive summary table. Two mechanisms: (a) cluster **headers/stream-readiness 20-min timeout** (21:36:12Z 502); (b) **combo hedge-cancel** of a slow GLM sibling (18:16:06Z 504, 18:47:12Z 502); (c) **outer-client abort while queued behind the single `max_concurrent:1` GLM slot** (both planner 499s). None was an ds4 crash, proxy 30-min ceiling, or connect failure.
2. **Are the 499s Zoo or upstream aborts?** Zoo/outer client. The proxy logged "Cannot write to closing transport" (downstream closed first) and ds4 was mid-decode on another turn; the planner requests never got the single GLM slot and the client gave up at ~6 min.
3. **Regression quantified:** decode 21–28 t/s → <5 t/s (~5–20×); prefill ~8.5–9 min for ~155K tokens. Cause is **memory-pressure thrash**, not SSD-KV latency: the KV *graph* is allocated for 1,048,576 rows (11.69 GiB) regardless of actual turn size, so every decode step walks a 1M-row structure that doesn't fit RAM and spills to swap/compressor. SSD streaming adds load latency on misses but the dominant factor is swap thrash. The model stays resident (no reload), but its working set exceeds physical RAM.
4. **Does the 300 GB KV cache help?** It hurts. 4,246 disk-cache-full evictions, many `hits=0`, hit:miss ≈ 413:1032. It fills the disk, forces constant eviction/re-prefill, and competes for I/O — all cost, little reuse.
5. **Capacity reality check:** No. 128 GB unified memory cannot hold GLM-5.3 weights + a 1M-row KV graph without swapping. The 160K config fit (context buffers 5.1 GB, DSA 1.83 GiB) and ran at 21–28 t/s. **A resident-safe ceiling is ≈160K (the prior value); somewhat higher may fit but 1M does not.** Effective input is already compressed to ~160K anyway, so nothing is lost by capping there.

---

## Recommendations (ranked — not applied)

1. **Revert `--ctx` to a resident-safe value (~163840, i.e. the prior 160K).** Highest impact, lowest effort. Restores 21–28 t/s decode and ~sub-minute prefill for typical turns, eliminates swap thrash, and directly removes the TTFB that triggered the 20-min 502 and the hedge-cancel 504. Since real turns never exceed ~161K, no capability is lost. If more than 160K is truly wanted, bisect upward (e.g. 256K) only while watching `vm.swapusage` stay near 0.
2. **Cap OmniRoute `maxInputTokens` for `ds4-glm53` to a value the hardware serves within the 20-min TTFB budget (≈160K).** Currently `pool/tier1/planner` sets `maxInputTokens:1048576` and `pool/tier1/code`/`tier1b` set `524288` for the GLM target — both above what the box can prefill in time. Lowering to ~160K makes the router shed oversized turns to faster tiers instead of parking them on the M5 until a timeout fires. Pairs with #1.
3. **Shrink or disable the 300 GB KV disk cache.** With `hits=0` evictions dominating, it is pure overhead. Drop `--kv-disk-space-mb` to a small value (e.g. 20–40 GB) or disable; frees SSD I/O and stops the churn. Independent of #1/#2.
4. **Give planner a fallback target.** `hybrid/planner` tier-1 is GLM-only with `concurrencyPerModel:1` behind a `max_concurrent:1` connection, so one slow turn blocks all planner traffic (the two 499s). Add a second tier-1 planner target (e.g. the vllm 27B already listed in its `weightedTargetPolicies`) or shorten `targetTimeoutMs`/`queueTimeoutMs` so queued planner turns fail over fast instead of waiting ~6 min for a client abort.
5. **Only if 1M TTFB is genuinely required:** raise the cluster `STREAM_READINESS_TIMEOUT_MS` / `OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS` above 20 min (the briefing's "headers ≥ 20 min" is satisfied but a true 1M prefill needs ~55–60 min at current speed). This only masks the symptom — without #1 the box still thrashes and decode stays <5 t/s — so prefer #1–#3 first. If adopted, keep the ladder ordered: headers < proxy 30 min < provider/connection 45 min < Zoo 45 min, which means the proxy ceiling would also need review.
6. **Routing policy:** send only small-context turns to the M5 and large ones to GPU/cloud tiers. The dispatch sequence in `pool/tier1/code` already lists faster targets first; enforcing the `maxInputTokens` cap (#2) effectively implements this.

Expected combined effect of #1+#2+#3: the 20-min 502 and the hedge-cancel 504/502 disappear (TTFB back to seconds–minutes); the planner 499s disappear once decode is fast enough that the single slot frees quickly (further hardened by #4); swap returns toward 0 and the SSD stops thrashing.

---

## Method / provenance

- Cluster DB: `kubectl -n omniroute exec deploy/omniroute -- node /app/<script>.js` using the pod's `better-sqlite3` against `/app/data/storage.sqlite` (readonly). Tables: `call_logs`, `provider_connections`, `combos`, `model_context_overrides`. Raw artifacts under `/app/data/call_logs/2026-10-04/*.json` (8,435 files; summaries extracted by timestamp).
- Cluster env: `kubectl -n omniroute get deploy omniroute -o json`.
- Mac logs (readonly): `/Users/celes/ai/logs/glm53-dwarfstar-server.log`, `/Users/celes/ai/logs/local-model-proxy.log`.
- Host state: `vm_stat`, `sysctl vm.swapusage hw.memsize`, `du -sh`, `df -h`.
- No writes, restarts, or config changes were performed.
