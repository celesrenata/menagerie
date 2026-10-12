# arc-embed / qwen3 embedding investigation + ceiling/memory boost

Date: 2026-10-09
Investigator: orchestrator (live diagnosis via https://omniroute.celestium.life management API
and kubectl on ssh://celes@192.168.42.254 / host `esnixi`, k3s v1.36).
Auth: `/run/secrets/omniroute_management_api_key` (35-char bearer; authenticates to the
management API, confirmed `/v1/models` and `/api/*` return 200).

## User request
1. Review omniroute, find out why `arc-embed/qwen3-embedded` is having so many problems.
2. Do we need larger context windows? If so, boost to 12k.
3. Increase `ssh://celes@192.168.42.254:sources/kube/omniroute-memory` memory limits by 50%.

## Verified findings

### A. LIVE INCIDENT — embedding replicas are unhealthy (primary cause of "so many problems")
`kubectl -n omniroute-memory get pods -l app=ovms-embeddings`:
```
ovms-embeddings-0   0/1 Running  1 restart   readiness probe failing x2202 over 5d10h
ovms-embeddings-1   0/1 Running  1 restart (6m)
ovms-embeddings-2   0/1 Running  4 restarts (4m)
ovms-embeddings-3   1/1 Running  5 restarts (46s)
```
StatefulSet shows `1/4` (often 0/4) READY. The failing probe is the real-inference exec
probe `/opt/readiness/embed-probe.sh` (configmap `ovms-readiness-scripts`). Because 3/4
backends are not Ready, requests load-balanced to them return
`upstream_error: "fetch failed"` intermittently — reproduced live against the API.

### B. Wrong model id
- `arc-embed/qwen3-embedded`  -> `upstream_error: "Mediapipe graph definition with requested name is not found"` (that graph name does not exist in OVMS).
- `arc-embed/qwen3-embedding-0.6b` -> SUCCESS, returns 1024-dim vector.
OVMS `model_name` is `qwen3-embedding-0.6b`. Whatever client/config uses
`arc-embed/qwen3-embedded` is using a non-existent model id and should be corrected to
`arc-embed/qwen3-embedding-0.6b`.

### C. Context / token ceilings DISAGREE across three layers
Measured live against `arc-embed/qwen3-embedding-0.6b`:
- ~1000-word input: OK (1024 dims)
- ~1500-word input: `Mediapipe execution failed ... INVALID_ARGUMENT: EmbeddingsExecutor` — the OVMS model's own max sequence length is exceeded here (well under 4096 tokens).
- ~2500-word input (~4630 tok): rejected by OmniRoute guard: `"over the 4096-token per-item limit for arc-embed; split the input or set OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=truncate"`.

Three different ceilings:
1. **OmniRoute app guard = 4096 tokens/item** (hard-coded DEFAULT — no `OMNIROUTE_EMBEDDING_*` env is set on the `omniroute` deployment; env list confirmed below).
2. **OVMS/Mediapipe graph actual capacity** fails around ~1500 words — the deployed model
   graph does NOT support anywhere near 8192 tokens today.
3. **Repo/manifest docs claim an 8192-token serving ceiling** (`ovms-embeddings-statefulset.yaml`
   memory comment; `LIVE-VERIFICATION.md`). This matches neither (1) nor (2).

=> "Do we need larger context windows?" YES at the app-guard layer (4096 rejects real
chunks), BUT raising the OmniRoute guard to 12k alone will NOT work: the OVMS model graph
must also be configured/replaced to accept the longer sequence (it currently chokes ~<2k
tokens). This tension MUST be resolved in design before claiming 12k works.

### D. Memory config — two distinct "memory limits"
- OVMS embeddings container `resources.limits.memory` = **10Gi** (statefulset), reranker similar.
  +50% => **15Gi**. Requests currently 2Gi. Node allocatable ~94GB shared RAM (per comment).
- OmniRoute app deployment has env `OMNIROUTE_MEMORY_MB` and `OMNIROUTE_MEMORY_RERANK_URL`
  — the "omniroute-memory" subsystem. "omniroute-memory memory limits" may mean the OVMS
  container limits (namespace `omniroute-memory`) and/or `OMNIROUTE_MEMORY_MB`. NEEDS a
  decision on exactly which limit the user means; default read = the OVMS container memory
  limits in the `omniroute-memory` namespace (10Gi -> 15Gi).

## Where things live
- Remote host: `celes@192.168.42.254` (hostname `esnixi`), k3s, kubectl present.
- OVMS manifests: `~/sources/kube/omniroute-memory/` (statefulset, reranker, readiness configmap, LIVE-VERIFICATION.md). Local snapshot in this repo under `sources/kube/omniroute-memory/` is STALE (says 8Gi/8192 in comments vs live 10Gi).
- OmniRoute app: namespace `omniroute`, deploy `omniroute`,
  image `registry.celestium.life/library/omniroute:3.8.68-hard-conn-cap-20261004`,
  manifest `~/sources/kube/omniroute/omniroute.yaml` (plus timestamped .bak files).
  Current env (no embedding ceiling present):
  AUTH_COOKIE_SECURE, BASE_URL, CORS_*, DATA_DIR, FETCH_*_TIMEOUT_MS, JWT_SECRET,
  MCP_TOOL_ALLOW, NEXT_PUBLIC_BASE_URL, OMNIROUTE_CHAT_*, OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS,
  OMNIROUTE_HARD_CONCURRENCY_PROVIDERS, OMNIROUTE_LOCAL_AUDIO_HOSTS, OMNIROUTE_MCP_*,
  OMNIROUTE_MEMORY_MB, OMNIROUTE_MEMORY_RERANK_URL, RATE_LIMIT_MAX_WAIT_MS,
  REQUEST_TIMEOUT_MS, REQUIRE_API_KEY, STREAM_*.

## Open decisions for design phase
1. Which "memory limit" does +50% apply to? (OVMS container memory 10Gi->15Gi, and/or
   `OMNIROUTE_MEMORY_MB`.) Default assumption: OVMS container limits in omniroute-memory ns.
2. Exact env var name to set the OmniRoute per-item ceiling to 12288 — confirm from the
   image/docs (error text only reveals `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW`).
3. OVMS model graph max sequence length: can `Qwen3-Embedding-0.6B-int8-ov` serve 12k
   tokens? If not, 12k app-ceiling is cosmetic. May need model reconfig (max_tokens /
   pooling / graph) or accept a lower real ceiling. Model native context is 32k but the
   deployed OVMS graph currently fails ~<2k — must investigate the graph config.
4. Fix the readiness-probe failures (the actual outage) FIRST / independently.
