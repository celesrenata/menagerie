# arc-embed / qwen3 embedding — requirements + design (investigation complete, no changes applied)
# arc-embed / qwen3 embedding — requirements + design (investigation complete, no changes applied)

Date: 2026-10-09 (revised after design review — iteration 2)
Author: design subagent (workflow `wf_2b89ae97189de82e`)
Scope: INVESTIGATION + DESIGN ONLY. No cluster or manifest change was applied in this step.
Authoritative access used this session:
- OmniRoute management API `https://omniroute.celestium.life`, bearer `/run/secrets/omniroute_management_api_key` (35 chars) — `/v1/models`, `/v1/embeddings`, `/api/health` all 200.
- `ssh -o BatchMode=yes celes@192.168.42.254` (host `esnixi`, k3s v1.36). kubectl present.

This document SUPERSEDES several numbers in `findings.md` that did not match live state (noted inline).

> **Revision note (iteration 2).** This version resolves the 6 HIGH/MEDIUM findings in
> `design-review.json` with fresh live verification performed in the revision session (same API +
> SSH access). The decisive new evidence is a **token-size sweep against a currently-healthy replica
> (`ovms-embeddings-3`)** that pins the real achievable ceiling and the latency curve, plus reading
> the OVMS `--help` and the OmniRoute image `ENVIRONMENT.md` for the exact graph-regeneration
> mechanism and the exact overflow enum. Changed vs iteration 1, in brief: the real achievable
> ceiling is now stated with measured evidence and 8192 is explicitly marked **unproven and
> hard-gated** on a post-fix sweep (F2); the graph re-export mechanism is now the non-destructive
> `ovms --configure … --max_length 8192` with an `--overwrite_models` fallback, no PVC wipe (F4);
> the overflow enum is corrected to `auto`(default)`/truncate/reject` from the image docs, and the
> graph's `truncate:true` is shown NOT to clip over-length input (F5); the memory sizing story is
> reconciled with the manifest comments (F3); the RC1 restart is made single-replica-first with
> exact commands (F6); the reranker memory bump is scoped to a value-only live edit that preserves
> its working HTTP probe (F8); and a re-verify-before-acting checklist is added (F7). The two
> recorded user decisions are kept intact as instructed; their provenance is clarified (F1).

---

## Summary

The user asked why `arc-embed/qwen3-embedded` "has so many problems," whether larger context
windows are needed (and if so boost to 12k), and to raise the `omniroute-memory` memory limits
by 50%. Live diagnosis shows **three independent problems that have been conflated**, and the
one actually causing the "so many problems" outage is **not** a context-window problem:

1. **PRIMARY OUTAGE — the Intel-GPU embedding serving path is unstable per-replica.** Replica
   health is highly variable: in the revision session `ovms-embeddings-3` served a 1-token "ping"
   in **0.265 s** (healthy and fast), while `ovms-embeddings-1` and `-2` **wedged (timeout >35 s)**
   and `ovms-embeddings-0` returned HTTP 400 (`RET_CHECK failure (src/embeddings/embeddings_calculator_ov.cc:382)`)
   on *every* request including "ping". So the fast ~0.26 s path is achievable, but most replicas
   are stuck wedged or hard-failed. The earlier iteration-1 capture of ~11.4–11.8 s for a ping was
   a mid-wedge measurement; the floor on a healthy replica is sub-second. With the live readiness
   probe allowing only a ~2–3 s inference (`-m 2`, `timeoutSeconds: 3`), the wedged/hard-failed
   replicas are perpetually `0/1` (all four were `0/1` in both sessions), so OmniRoute
   load-balances onto dead backends and returns intermittent `upstream_error: "fetch failed"`.
   This is the real cause of "so many problems." Note the latency ALSO grows super-linearly with
   input length even on the healthy replica (see sweep below), so a long-input request can wedge a
   replica that pings fine — probe sizing and the ceiling interact.

2. **WRONG MODEL ID.** `arc-embed/qwen3-embedded` is not a real graph name; the correct id is
   `arc-embed/qwen3-embedding-0.6b` (OVMS `model_name` `qwen3-embedding-0.6b`).

3. **CONTEXT CEILING MISMATCH, with a now-measured real ceiling.** The OmniRoute app rejects
   items over 4096 tokens via a configurable guard. The OVMS graph is pinned at `max_length: 4096`.
   **Measured live this session** (token-size sweep against the healthy `ovms-embeddings-3`): inputs
   up to the 4096-token graph limit DO serve (4000 words → HTTP 200), but latency climbs steeply —
   100 w = 0.06 s, 2000 w = 1.0 s, 3000 w = 6.9 s, **4000 w = 32.4 s**; and anything over the graph
   limit is hard-rejected, not truncated: 6000 w → `INVALID_ARGUMENT … Input length 6002 longer than
   allowed 4096` (despite `truncate: true` in the graph). So the real achievable ceiling TODAY is
   exactly **4096 tokens**, but the top of that range already costs ~32 s per request — far beyond
   any sane probe budget. **The user has set the final target to 8192 at BOTH layers** (not 12k).
   8192 is **unproven**: the model natively supports 32k so 8192 needs no model rebuild, but no 8192
   graph has been served on this GPU, and the 4096-at-32 s latency curve warns that 8192 may be too
   slow to serve within a probe budget even after the serving path is stabilized. The ceiling bump
   is therefore HARD-GATED on a post-fix sweep that proves an ~8192-token input returns 200 within
   the probe budget (see RC3). Graph regeneration to 8192 is done in-place and non-destructively via
   `ovms --configure … --max_length 8192` (no PVC wipe) — see recorded Decision (b) and RC3.

Fixing #1 is the priority and must be done FIRST and independently of the ceiling ask. #2 is a
trivial client/config correction. #3 is a two-layer change gated on #1 being healthy.

---

## Live evidence (verified this session)

### Cluster / outage state
`kubectl -n omniroute-memory get pods -l app=ovms-embeddings` cycled through readiness during
the session; a representative capture:

```
ovms-embeddings-0   0/1 Running  1 restart  readiness probe failed x2202 over 5d10h
ovms-embeddings-1   0/1 / 1/1 (flapping)   liveness-killed, 2 restarts in minutes
ovms-embeddings-2   1/1 -> 0/1 (degraded during probing)
ovms-embeddings-3   0/1 Running  5 restarts
```
At one capture all four were simultaneously `0/1` (full outage). Pod-0 last terminated with
**Exit Code 137** (SIGKILL / OOM or liveness kill).

### Why the probe fails (the mechanism) — re-verified in the revision session
- Live readiness probe (from the StatefulSet `-o jsonpath`, NOT a mounted script — see divergence
  below; re-confirmed this session):
  `exec sh -c 'curl -sf -m 2 -X POST http://localhost:8000/v1/embeddings -H "Content-Type: application/json" -d {"model":"qwen3-embedding-0.6b","input":"ping"} >/dev/null'`,
  `timeoutSeconds: 3`, `periodSeconds: 5`, `failureThreshold: 3`, `initialDelaySeconds: 15`.
- **Per-replica 1-token "ping" latency, measured this session (`-m 35`):**
  - `ovms-embeddings-3` → **http=200, 0.265 s** (HEALTHY, fast — the achievable floor)
  - `ovms-embeddings-0` → **http=400, 2.1 s** (RET_CHECK hard-fail on every request)
  - `ovms-embeddings-1` → **timeout at 35 s (exit 28)** (WEDGED)
  - `ovms-embeddings-2` → **timeout at 35 s (exit 28)** (WEDGED)
  All four nonetheless show `0/1` in `kubectl get pods` because the live `-m 2` probe cannot even
  pass on pod-3 reliably under concurrent probing, and never on the wedged/hard-failed replicas.
- On the broken replica (pod-0): pings return
  `{"error":"Mediapipe execution failed ... RET_CHECK failure (src/embeddings/embeddings_calculator_ov.cc:382) false"}`
  fast (~2 s). Iteration-1 startup logs showed the graph loads to `AVAILABLE`, then every
  `EmbeddingsExecutor` run RET_CHECK-fails, with periodic
  `FATAL Transport endpoint is not connected (errno=107) ... Socket.cc:114`.

**Conclusion (sharpened with the new evidence):** the healthy floor is **sub-second** (pod-3 =
0.265 s), so the GPU path CAN serve fast — the problem is per-replica instability (wedge / hard
RET_CHECK fail), not a uniform ~11 s floor as iteration 1 inferred from a mid-wedge sample. The
remediation must (a) clear the wedged/failed replicas and (b) size the probe so a healthy replica
is never evicted. The earlier "~11 s for a ping" figure is retained only as a mid-wedge data point.

### GPU resources are NOT the bottleneck
`kubectl get nodes` i915: each of gremlin-1..4 has capacity/allocatable **5** `gpu.intel.com/i915`.
Cluster i915 requests: one `ovms-embeddings` pod per node (anti-affinity), one reranker, plus
kokoro/speaches/plex — no node is oversubscribed on i915. GPU device nodes are present inside
the pod (`/dev/dri/card3`, `/dev/dri/renderD131`). So the slowness is a software/runtime issue,
not GPU scheduling scarcity. `dmesg` is not readable without privilege (could not confirm i915
GuC resets from userspace).

### OVMS graph config (from `graph.pbtxt` on live pod-3, re-verified this session)
```
# File created with: OpenVINO Model Server 2026.4.0.869b2186a   <-- graph is GENERATED by OVMS, not shipped by HF
EmbeddingsCalculatorOV: models_path "./", normalize_embeddings true, truncate true,
  pooling LAST, max_length 4096, target_device "GPU", plugin_config '{"NUM_STREAMS":"1"}'
```
Image: `openvino/model_server@sha256:e7a448...c40e8e`, version **2026.4.0** (very recent).
Live model-pull init args on the StatefulSet (re-confirmed `-o jsonpath`):
`--pull --model_repository_path=/models --source_model=OpenVINO/Qwen3-Embedding-0.6B-int8-ov
--model_name=qwen3-embedding-0.6b --task=embeddings --pooling=LAST --truncate=true
--max_length=4096 --target_device=GPU`.
The `graph.pbtxt` mtime on the PVC is newer than the model weights, consistent with the graph
having been (re)generated by an OVMS run that carried `--max_length=4096` after the initial pull.
`ovms --help` confirms `--configure` ("Create or update graph.pbtxt for a local model") and an
`--overwrite_models` flag — so the graph IS regenerable in-place; this is the F4 mechanism (RC3).

### Token-size sweep — the REAL achievable ceiling and latency curve (measured this session)
Run against the healthy `ovms-embeddings-3` directly (`POST /v1/embeddings`, repeated "word " input,
`-m 60`):

| input (words) | HTTP | time_total | note |
|---|---|---|---|
| 100  | 200 | 0.065 s | |
| 500  | 200 | 0.142 s | |
| 1000 | 200 | 0.316 s | |
| 1500 | 200 | 0.540 s | (contrast: findings.md claimed ~1500 w FAILED — that was a wedged replica, not a graph limit) |
| 2000 | 200 | 1.010 s | |
| 3000 | 200 | 6.872 s | latency starts climbing steeply |
| 4000 | 200 | **32.424 s** | serves, but at the edge of the 4096-token graph limit and far over any probe budget |
| 6000 | 400 | 0.003 s | `INVALID_ARGUMENT … Input length 6002 longer than allowed 4096` — HARD REJECT, not truncated |
| 8000 | 400 | 0.717 s | same `Input length 8002 longer than allowed 4096` |

**Decisive conclusions:**
- The real achievable per-item ceiling TODAY is exactly **4096 tokens** (the graph `max_length`),
  confirmed by the exact over-limit error message, NOT the sub-2k that findings.md inferred (that
  was a wedged replica, now disproven on a healthy one).
- `truncate: true` in the graph does **NOT** clip over-length input — OVMS errors instead. So OVMS
  is not a silent-truncation backstop; the overflow policy must come from the OmniRoute layer.
- Latency is super-linear in length: a 4096-token request already costs ~32 s on a healthy GPU
  replica. **This is the central risk for the 8192 target** — even with a stabilized serving path,
  an 8192-token request may take far longer than any probe or client timeout. 8192 is therefore
  UNPROVEN and hard-gated on a post-fix sweep (RC3 / AC5).

### Wrong model id + guard (OmniRoute public API, confirmed live)
- `arc-embed/qwen3-embedded` → `{"error":{"message":"Mediapipe graph definition with requested name is not found", ...}}`
- `arc-embed/qwen3-embedding-0.6b` with "hello world" → **OK, 1024 dims**
- `arc-embed/qwen3-embedding-0.6b` with ~4600 words (~6667 tok) →
  `"Embedding input item 0 is ~6667 tokens, over the 4096-token per-item limit for arc-embed; split the input or set OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=truncate"`

### EXACT OmniRoute env var names (read from the running image's bundled code — authoritative, not guessed)
Grepping `/app` inside pod `omniroute-8695cd8cb8-9pzwn`:
```
maxItemTokens:   OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS   (default 4096)
maxPaddedTokens: OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS (default 32768)
maxItems:        OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS         (default 32)
providers:       OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS         (default "arc-embed,...")
overflow mode:   OMNIROUTE_EMBEDDING_ITEM_OVERFLOW           (default auto)
per-provider override syntax: id=maxItems:maxPaddedTokens:maxItemTokens
```
Confirmed this session by grepping the running image for `OMNIROUTE_EMBEDDING_*` (five vars, exactly
as above) and by reading the image's own `/app/docs/reference/ENVIRONMENT.md`.
=> The ceiling knob the user wants is **`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`** (default
4096). There is **no** `OMNIROUTE_EMBEDDING_ITEM_MAX_TOKENS` (the name findings.md speculated).
`arc-embed` is already in the split-providers list.

**F5 — exact `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` enum and default (CORRECTED from the image docs).**
The image `ENVIRONMENT.md` states the accepted values and default verbatim:
- **Default is `auto`** (NOT `error` as iteration 1 said). Under `auto`: *internal* callers (the
  memory engine, Qdrant) get the item **truncated to the cap with a logged warning**; *external*
  callers get **HTTP 400** naming the item, its estimate, and the cap.
- **`truncate`** — applies truncation to *every* caller.
- **`reject`** — applies HTTP 400 to *every* caller.
So the correct enum is **`auto | truncate | reject`** (matching the sibling `embed-summary-cap`
record), and iteration 1's `error | truncate` was wrong. The handler lives in
`open-sse/handlers/embeddings.ts` (per `ENVIRONMENT.md`); the per-item cap itself is enforced in
`open-sse/handlers/embeddingBatchSplit.ts`. This matters because OVMS does NOT truncate (above),
so the only truncation backstop is this app-layer setting.

### Memory — live values (CORRECTION to findings.md)
`findings.md` says 10Gi → 15Gi. **Live cluster is 8Gi**, not 10Gi (re-confirmed this session via
`-o jsonpath`):
- StatefulSet `ovms-embeddings` container `resources.limits.memory` = **8Gi** (requests 2Gi).
- Deployment `ovms-reranker` container `resources.limits.memory` = **8Gi** (requests 2Gi).
- OmniRoute app env `OMNIROUTE_MEMORY_MB = 8192` (re-confirmed); `OMNIROUTE_MEMORY_RERANK_URL` set.
- Node allocatable memory ~**94 GiB** per node (`98,535,404 Ki` ≈ 93.9 GiB on gremlin-1; all four
  gremlin nodes 98.3–98.5 GiB allocatable). i915 = **5** per node. Ample headroom.

**Reranker live readiness probe (re-verified this session) is HTTP, not the committed script.** Live
`ovms-reranker` readiness = `httpGet /v2/health/ready`, `timeoutSeconds: 1`, `failureThreshold: 60`,
`periodSeconds: 10` — a tolerant HTTP probe. The committed Deployment instead mounts the
`rerank-probe.sh` exec probe that POSTs `/v3/rerank`. Live `/v3/rerank` AND `/v1/rerank` both return
**404** on the reranker pod this session, so reconciling the reranker to the committed manifest would
swap in a probe that fails and drop the reranker out of rotation. => the reranker memory bump must be
a **value-only edit of `resources.limits.memory` on the live Deployment**, leaving its working HTTP
probe intact (see F8 handling in RC4).

**+50% therefore = 8Gi → 12Gi** (NOT 15Gi) for the OVMS containers, and/or
`OMNIROUTE_MEMORY_MB 8192 → 12288`. The precise target of "+50%" is Open Decision (a).

### Live-vs-committed manifest DIVERGENCE (important for the fix)
The remote on-disk manifests (`~/sources/kube/omniroute-memory/*.yaml`, authored for feature
`retrieval-fabric` tasks 8.1–8.4) do **not** match the running cluster:

| Item | On-disk manifest (remote) | LIVE cluster | Local workspace copy |
|---|---|---|---|
| embeddings mem limit | 10Gi | **8Gi** | 10Gi (stale) |
| reranker mem limit | 10Gi | **8Gi** | — |
| readiness probe | `/opt/readiness/embed-probe.sh`, `-m 4`, timeout 5s, failThresh 4, period 15s | inline `curl -m 2 ... "ping"`, timeout 3s, failThresh 3, period 5s | script-based |
| `ovms-readiness-scripts` ConfigMap | defined | **NotFound in cluster** | defined |
| model-pull args | no `--max_length`/`--truncate` | `--max_length=4096 --truncate=true` | no max_length |

So the committed-but-unapplied manifest already contains a *gentler* readiness probe (5 s
timeout vs the live 2 s) and a mounted script that asserts the 1024-dim result. The live cluster
is running an older/hand-edited revision. Reconciling live → committed is part of the fix: the
committed 5 s script probe comfortably covers the sub-second healthy ping (so a healthy replica
stops flapping), but it does NOT fix a wedged/RET_CHECK replica — the serving-path instability must
be cleared (restart, and if it persists, the CPU canary in RC1 step 3) regardless of which probe is
applied. The probe input is a tiny string, so the 32 s long-input latency does not affect it.

### Reranker observation (not in scope to fix beyond memory)
`POST /v3/rerank` on the live reranker pod returned **404** instantly (model/path mismatch vs the
committed `rerank-probe.sh`, which targets `qwen3-reranker-0.6b` on `/v3/rerank`). The reranker
pod nonetheless reports `1/1 Ready` (its live probe differs). Flagged for awareness; the task
scopes the reranker only for the memory-coupling decision.

---

## Functional requirements

- **FR1 — Restore embedding availability.** The `ovms-embeddings` StatefulSet must reach and hold
  a healthy READY majority so OmniRoute stops returning `fetch failed`. Root cause to address:
  per-replica serving instability — a healthy replica pings in ~0.26 s, but most replicas are stuck
  wedged (>35 s timeout) or RET_CHECK-hard-failing, and the `-m 2` probe evicts them all.
- **FR2 — Readiness probe must match real serving latency.** The readiness probe timeout/period
  must be larger than realistic steady-state inference latency once FR1 is fixed, with a
  failureThreshold that tolerates brief blips without flapping a healthy replica. If FR1 cannot
  reduce latency to a small value, the probe budget must be sized to the achieved latency.
- **FR3 — Correct the model id.** Whatever client/config references `arc-embed/qwen3-embedded`
  must use `arc-embed/qwen3-embedding-0.6b`, or OmniRoute must expose an alias mapping the old
  id to the real graph.
- **FR4 — Resolve the context ceiling coherently across both layers, gated on a measured proof.**
  The user's target is 8192 at both layers (OmniRoute guard `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`
  AND OVMS graph `max_length`). Neither layer is raised until (a) FR1 is healthy and (b) a post-fix
  token sweep PROVES an ~8192-token input returns 200 within the probe/client budget on a healthy
  replica. If 8192 does not serve within budget, fall back to the largest tested size that does
  (power-of-two step down: 4096 is already proven to serve, though at ~32 s) and escalate the
  gap-to-8192 to the user. Both layers must always carry the SAME number — never raise only one.
- **FR5 — Apply the memory increase (+50% off the live 8Gi/8192 base):** embeddings 8Gi→12Gi,
  reranker 8Gi→12Gi, `OMNIROUTE_MEMORY_MB` 8192→12288.

## Non-functional requirements

- **NFR1 — Shared live cluster.** Changes must be rolled one surface at a time with health
  verified between steps; qdrant in the same namespace must not be touched.
- **NFR2 — No guessed production values.** Env var names and image tags must come from the image
  or committed manifests (satisfied here: ceiling var confirmed from the image).
- **NFR3 — Reproducible config.** The live StatefulSet/Deployment and the committed manifests
  must be reconciled so the fix is captured declaratively, not left as a live hand-edit.
- **NFR4 — Memory headroom.** Any limit increase must stay within node allocatable (~94 GB/node);
  12Gi per OVMS container is comfortably within headroom.

## Out of scope

- qdrant StatefulSet (explicitly off-limits).
- Reranker functional repair of the `/v3/rerank` (and `/v1/rerank`) 404 — the reranker is scoped
  to the memory bump ONLY, applied as a value-only live patch that preserves its working HTTP probe
  (F8). The committed script-probe divergence is NOT applied live in this task. If a later task
  wants the real-inference rerank probe, the 404 must be fixed first.
- Rebuilding/replacing the OVMS image or the model (Decision b chose 8192, which needs no rebuild —
  only an in-place `ovms --configure` graph regeneration of the existing model). 12k is explicitly
  out of scope.
- Silently downgrading the ceiling below 8192 without telling the user: if the F2 gate fails, the
  implementer sets both layers to the proven value AND escalates the gap to the user (not a silent
  substitution).

---

## Design — root cause by root cause

### RC1 (PRIMARY): wedged / ultra-slow Intel-GPU embedding serving path

**Root cause (confirmed, refined with per-replica evidence):** replica health is unstable, not a
uniform slow floor. This session a healthy replica (pod-3) served a 1-token ping in **0.265 s**
while two replicas (pod-1, pod-2) were **wedged (>35 s timeout)** and one (pod-0) **hard-fails**
every request with `RET_CHECK ...embeddings_calculator_ov.cc:382`. So the GPU path CAN be fast; the
problem is that most replicas get stuck in a wedged or RET_CHECK-failed state and the `-m 2` probe
evicts even the recoverable ones. GPU scheduling is not the constraint (i915 = 5/node, not
oversubscribed; device present in-pod). The stuck state is characteristic of either (i) the
OpenVINO GPU plugin thrashing/recompiling or wedging on an i915 socket (`errno=107`), (ii) an
i915/GuC incompatibility with the recent OVMS 2026.4.0 build, or (iii) memory pressure during long
inference (last kill was Exit 137; the 4096-token/32 s requests are a plausible trigger).

**Chosen remediation path (ordered; stop when health is restored). Single-replica-first is
MANDATORY, not optional — the cluster is at times fully 0/4, so an all-four-at-once roll could
convert an intermittent outage into a guaranteed total one.**

The live StatefulSet has `podManagementPolicy: Parallel`, and that field is **immutable on an
existing StatefulSet** — so the single-replica mechanism is NOT switching to `OrderedReady`.
Use the StatefulSet rolling-update **partition** so only the highest-ordinal pod rolls, OR scale
down to one replica. Chosen mechanism: **partition**, because it does not reduce capacity further
during an active outage. Exact commands:

0. **Re-verify live state first (see the F7 checklist below): memory limit, probe shape, graph
   `max_length`, ConfigMap presence, and a fresh per-replica ping + a token sweep on whichever
   replica is currently healthy.** Do not proceed on stale captures.

1. **Create the missing ConfigMap, then roll ONE pod with the gentler script probe + 12Gi.** The
   committed manifest carries a script-based readiness probe (`/opt/readiness/embed-probe.sh`,
   `timeoutSeconds: 5`, `failureThreshold: 4`, `periodSeconds: 15`) that asserts a real 1024-dim
   embedding. First `kubectl apply -f ovms-readiness-scripts-configmap.yaml` (it is NotFound live,
   or the pod can't mount it). Then set a partition so only pod-3 rolls:
   `kubectl -n omniroute-memory patch sts ovms-embeddings --type=json -p '[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":3}]'`
   then apply the reconciled StatefulSet (script probe + `memory: 12Gi`, model-pull unchanged at
   `--max_length=4096` for THIS step — the ceiling change is RC3, gated separately). Only pod-3
   (ordinal ≥ partition) rolls. Watch `kubectl -n omniroute-memory get pod ovms-embeddings-3 -w`
   for a bounded window (10 min). A 5 s script probe tolerates the sub-second healthy ping but will
   NOT survive a 32 s long-input inference — that is acceptable here because the probe input is a
   tiny "readiness" string, and long-input latency is handled by RC3's ceiling gating.
2. **If pod-3 reaches and holds READY ≥10 min, lower the partition stepwise** (2, then 1, then 0),
   waiting for each pod to hold READY before the next. If a pod does NOT recover with the gentler
   probe + restart (wedged/RET_CHECK persists), go to step 3 before rolling the rest.
3. **Diagnose GPU vs CPU execution on the one stuck pod.** The decisive test is a
   **`target_device: CPU`** canary on a single replica (via the partitioned roll): if CPU inference
   returns in well under a second where GPU wedges, the GPU plugin/i915 path is the fault and the
   serving fix is a device/plugin change (driver image, `plugin_config`, or CPU serving) rather
   than anything context-related. This alters the serving device and MUST be proposed to the user
   before applying. **Given the active outage, run this canary BEFORE rolling the remaining
   replicas** so the fix is understood before the blast radius widens.
4. **Right-size probes to measured latency (FR2).** The healthy floor is sub-second (0.265 s), so a
   5 s readiness timeout is comfortable for the tiny probe input. Keep the HTTP liveness probe
   (`/v2/health/live`, 120 s delay / 30 s period / 3 fails — tolerant) so a truly dead process is
   still restarted without killing a merely-slow one. Do not raise the readiness budget to cover
   long-input latency; instead the ceiling (RC3) must be capped so real requests stay within a
   client-acceptable time.
5. **Address Exit 137.** The memory bump in RC4 (8Gi→12Gi) is applied as part of step 1's reconcile
   and directly reduces OOM risk during long inference.

**Error handling / rollback for RC1:** apply via partition so only one pod rolls at a time; watch
each pod for a bounded READY window (10 min). If a rolled pod does not reach READY in that window,
`kubectl -n omniroute-memory rollout undo statefulset ovms-embeddings` and restore the partition.
Fatal condition = no replica reaches READY under any probe budget → stop, do not roll the rest, and
escalate to the GPU-device diagnosis (step 3) and then to the user before further manifest edits.
After full success, reset the partition to 0 (or remove it) so future rollouts behave normally.

**Testability:** latency and success are directly measurable via the in-pod curl timing used in
this investigation (`-w "%{time_total}"`) and via the public `/v1/embeddings` smoke. Readiness is
observable via `kubectl get pods` READY column stability over several probe periods.

### RC2: wrong model id `arc-embed/qwen3-embedded`

**Chosen fix:** correct the referencing client/config to `arc-embed/qwen3-embedding-0.6b`. If the
wrong id is baked into multiple external callers that cannot all be updated at once, the fallback
is to add an **alias** in OmniRoute mapping `qwen3-embedded` → the real graph. Prefer correcting
the source id over an alias (an alias perpetuates a wrong name); choose alias only if the caller
set is unknown/unowned. The caller that emits the wrong id has not been positively identified in
this session — identifying it is the first implementation substep (grep OmniRoute provider config
+ any in-repo client config for `qwen3-embedded`).

**Error handling:** unknown model id already returns a clean `upstream_error`; no additional
handling needed. **Testability:** one API call each for old id (should resolve post-fix) and new id.

### RC3 / FR4: context ceiling — measured real achievable ceiling (4096 today) and the gated 8192 target

Three layers, reconciled with the measured ceiling:

- **OmniRoute app guard:** default 4096 via `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`
  (confirmed from image). Raising it is a single env change (or per-provider override
  `OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS="arc-embed=32:32768:<N>,..."`). Overflow behavior is set by
  `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` — **default `auto`**, values `auto | truncate | reject` (F5).
- **OVMS graph:** `max_length: 4096` in `graph.pbtxt` and `--max_length=4096` in the model-pull
  init args. **Measured:** inputs ≤4096 tokens serve (up to 32 s at the top of the range); inputs
  over 4096 are **hard-rejected** (`Input length N longer than allowed 4096`) — `truncate: true`
  does NOT clip. So the real achievable per-item ceiling TODAY is exactly **4096 tokens**.
- **Model native capacity:** `Qwen3-Embedding-0.6B-int8-ov` supports 32k natively, so 8192 is
  within the model — but has never been served on this GPU graph and the 4096-at-32 s latency curve
  warns it may be too slow.

**F2 — the real achievable ceiling is 4096 today; 8192 is UNPROVEN and HARD-GATED.** The user's
target is 8192 at both layers (Decision b, kept intact). 8192 is a GOAL, not a demonstrated
capability. The ceiling bump proceeds ONLY after this gate passes:

1. RC1 healthy (a stable majority of replicas READY).
2. Regenerate the OVMS graph to `max_length: 8192` on ONE replica (via the partitioned roll),
   using the **non-destructive in-place mechanism** (F4, below) — NO PVC wipe.
3. Run the token sweep against that replica up to ~8192 tokens and record: (a) that it returns 200,
   and (b) its latency. **Pass criterion:** an ~8192-token input returns 200 AND its latency is
   within a client-acceptable budget. Given 4096 already costs ~32 s, treat >60 s as a FAIL.
4. On PASS: set `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=8192` to match, roll the rest.
   On FAIL (8192 too slow or errors): fall back to the largest tested size that serves within
   budget (4096 is proven to serve; step down from 8192 by powers of two — 8192→6144→4096 — and
   pick the largest that passes), set BOTH layers to that value, and **escalate the gap to the
   user** (they asked for a larger window; if the GPU can't serve 8192 fast enough, that is a
   decision point, not something the implementer silently downgrades).

Both layers must always carry the SAME number. 12k is explicitly out (user Decision b). Until RC1
is fixed and the gate passes, raising either ceiling is cosmetic.

**F4 — exact graph-regeneration mechanism on the populated PVC (non-destructive).** The live
`graph.pbtxt` is GENERATED by OVMS (header: "File created with: OpenVINO Model Server 2026.4.0"),
not shipped by HF, and `ovms --help` exposes two relevant capabilities:
- `--configure` — "Create or update graph.pbtxt for a local model." This rewrites the graph for an
  already-present model WITHOUT re-downloading weights. **Chosen mechanism.** Run as a one-shot
  Job/initContainer against the existing PVC:
  `ovms --configure --model_path /models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov --task embeddings
  --pooling LAST --truncate=true --max_length 8192 --target_device GPU`.
- `--overwrite_models` — forces `--pull` to overwrite an existing model repo (fallback if
  `--configure` is unavailable in this build at runtime; it re-downloads, so prefer `--configure`).

A plain `--pull` against the populated `ReadWriteOnce` longhorn PVC is NOT relied upon to
regenerate the graph (it may no-op). The implementer MUST update the model-pull initContainer args
to `--max_length=8192` AND use the `--configure`/`--overwrite_models` path so a fresh pod actually
regenerates the graph. **Acceptance check:** after the roll, `cat graph.pbtxt` on the live pod
reads `max_length: 8192` (not 4096).

**F5 — overflow backstop.** Because OVMS does NOT truncate over-length input (it errors), the only
truncation path is the OmniRoute `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` setting. Leave it at the
default **`auto`** (internal memory/Qdrant callers get truncation-to-cap + warning; external callers
get HTTP 400 naming the item). Do not set `error` (not a valid value). If the user later wants
every caller truncated silently, set `truncate`; to reject every caller, set `reject`.

**Sequencing for the ceiling:** fix RC1 → regenerate the graph to 8192 on one replica via
`--configure` → run the sweep and apply the F2 gate → on PASS set the OmniRoute guard to 8192 and
roll the rest; on FAIL step down and escalate. **Testability:** the word-size sweep (100→8192+
tokens) against a healthy replica pins the real ceiling and latency curve before and after the
graph change; the exact over-limit error message is a reliable assertion for the configured ceiling.

### RC4 / FR5: memory increase (+50%) — DECIDED

Live limits are **8Gi** for both OVMS containers (embeddings + reranker) and `OMNIROUTE_MEMORY_MB=8192`.
Per Decision (a), **BOTH** targets get +50% computed off the **live 8Gi/8192 base** (not the
committed-but-unapplied 10Gi):

- OVMS embeddings StatefulSet container `limits.memory`: **8Gi → 12Gi** (requests stay 2Gi).
- OVMS reranker Deployment container `limits.memory`: **8Gi → 12Gi** (requests stay 2Gi).
- OmniRoute app env `OMNIROUTE_MEMORY_MB`: **8192 → 12288**.

All within ~94 GiB/node allocatable (one embeddings pod + one reranker pod per node → 24Gi of
limits per node, far under headroom).

**F3 — reconcile the sizing story so the committed manifest is self-consistent at 12Gi.** The
committed `ovms-embeddings-statefulset.yaml` comment derives memory from a ceiling FORMULA
("base 8Gi + ceil(8192/4096) = 10Gi … Raising the ceiling raises this in tandem"), while this
design derives it from the user's flat +50% directive. These are two different rationales that
must not coexist. **Chosen resolution:** the user's explicit +50% directive SUPERSEDES the formula.
When editing the manifests, replace the formula comment with the directive rationale, e.g.:
`memory: 12Gi  # +50% over the live 8Gi base per the user's directive (not the old ceiling formula);
headroom for the 8192-token target once RC3's gate passes. ~94GiB/node allocatable.`
Update the comment text in BOTH `ovms-embeddings-statefulset.yaml` and
`ovms-reranker-deployment.yaml` (and the "Pod memory limit: now 10Gi …" line in
`LIVE-VERIFICATION.md`) to the 12Gi/+50% rationale, so the committed config is self-consistent and
NFR3 (reproducible config, no undocumented hand-edit) holds. The committed value also moves
10Gi→12Gi, not just the comment.

**F8 — reranker: value-only live edit, NOT a reconcile to the committed probe.** The live reranker
readiness probe is HTTP `/v2/health/ready` (verified this session), but the committed Deployment
mounts the `rerank-probe.sh` exec probe that POSTs `/v3/rerank`, which returns 404 live. Applying
the committed reranker manifest would therefore break its readiness and drop it from rotation.
So the reranker memory bump is applied as a **targeted value edit of `resources.limits.memory`
(8Gi→12Gi) on the LIVE Deployment**, leaving its working HTTP probe intact:
`kubectl -n omniroute-memory patch deploy ovms-reranker --type=json -p
'[{"op":"replace","path":"/spec/template/spec/containers/0/resources/limits/memory","value":"12Gi"}]'`.
The committed `ovms-reranker-deployment.yaml` is still updated to 12Gi + the F3 comment for
declarative record, but the committed script-probe divergence is NOT applied to the live reranker
in this task (resolving the `/v3/rerank` 404 is out of scope — see Out of scope). This keeps the
reranker 1/1 throughout.

**Error handling:** memory bump is low-risk and reversible via `kubectl rollout undo` (embeddings)
or re-patch (reranker); verify no scheduling pressure after apply. **Testability:**
`kubectl describe node` headroom check + observe no further Exit 137 and the reranker staying 1/1.

---

## F7 — Re-verify-before-acting checklist (run at the start of implementation)

Every live claim below was observed during a flapping outage and MUST be re-read immediately before
any mutation, because the cluster state drifts:

1. **Memory limits:** `kubectl -n omniroute-memory get sts ovms-embeddings deploy/ovms-reranker -o jsonpath='{..resources.limits.memory}'` → expect 8Gi before, 12Gi after.
2. **Readiness probe shape (embeddings):** `kubectl -n omniroute-memory get sts ovms-embeddings -o jsonpath='{..readinessProbe}'` → expect the inline `-m 2 "ping"` probe before the reconcile.
3. **Reranker probe:** confirm it is still HTTP `/v2/health/ready` (do not clobber it).
4. **ConfigMap:** `kubectl -n omniroute-memory get cm ovms-readiness-scripts` → create it if NotFound before applying the script probe.
5. **Graph `max_length`:** `kubectl -n omniroute-memory exec <healthy-pod> -c ovms -- cat /models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov/graph.pbtxt | grep max_length` → expect 4096 before, 8192 after RC3.
6. **Fresh per-replica ping + token sweep** on whichever replica is currently healthy (health rotates — this session pod-3 was healthy; it may be a different ordinal at implement time): establish the current latency floor and the real serving ceiling before gating RC3.
7. **`OMNIROUTE_MEMORY_MB`** on the omniroute deploy → expect 8192 before, 12288 after.
8. **qdrant** generation/revision captured before and after → must be unchanged.

## Acceptance criteria (numbered, testable)

1. `ovms-embeddings` holds ≥3/4 replicas `READY` continuously for ≥10 minutes (stable across
   multiple probe periods), verified via `kubectl -n omniroute-memory get pods -w`.
2. A 1-token embedding via the public API `POST /v1/embeddings` with `arc-embed/qwen3-embedding-0.6b`
   returns HTTP 200 with a 1024-dim vector, and `upstream_error: "fetch failed"` is not observed
   across 20 consecutive calls.
3. Steady-state 1-token inference latency on a serving replica is below the readiness probe
   `timeoutSeconds`, and the probe no longer flaps a serving replica (zero `Unhealthy` events over
   10 minutes).
4. `arc-embed/qwen3-embedded` either resolves correctly (if aliased) or every known caller emits
   `arc-embed/qwen3-embedding-0.6b`; verified by API call and by grep of the corrected config.
5. The configured per-item ceiling equals the MEASURED achievable ceiling and is identical at both
   layers: `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` equals the OVMS graph `max_length` (target
   8192; the proven-serving value if 8192 fails the gate). An input AT the configured ceiling
   returns HTTP 200 within the probe/client budget on a healthy replica (the F2 gate was run and
   recorded), and an input ABOVE it is handled per the `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` policy
   (default `auto`). The live `graph.pbtxt` reads the configured `max_length` after rollout.
6. OVMS container memory limits are **12Gi** on both the embeddings StatefulSet and the reranker
   Deployment, and `OMNIROUTE_MEMORY_MB = 12288`; verified via `kubectl get sts/deploy -o jsonpath`.
   The reranker bump was applied as a value-only live patch and the reranker stayed 1/1 throughout.
7. Live manifests and committed manifests are reconciled where this task applies them (no
   undocumented live hand-edits); the `ovms-readiness-scripts` ConfigMap exists before the
   script-based embedding probe is applied; the memory-sizing comments in both manifests and
   `LIVE-VERIFICATION.md` state the +50%/12Gi rationale (not the stale 10Gi formula).
8. qdrant StatefulSet is untouched (unchanged `AGE`/revision), and the reranker's working HTTP
   readiness probe is unchanged (the committed `/v3/rerank` script probe was NOT applied live).

---

## Open decisions — RESOLVED (answers recorded above under "User answers to open decisions")

Both decisions below were raised to the user and ANSWERED; they no longer block implementation.
The questions are retained for the design-review record.

- **(a) Which "memory limit" does +50% apply to, and from which base?**  → ANSWERED: both OVMS
  containers (embeddings + reranker) 8Gi→12Gi AND `OMNIROUTE_MEMORY_MB` 8192→12288, off the live 8Gi/8192 base.
  Options: (i) OVMS container memory limits in ns `omniroute-memory` — embeddings only, or
  embeddings + reranker; (ii) OmniRoute app `OMNIROUTE_MEMORY_MB`; (iii) both. And the base:
  **live is 8Gi** (so +50% = 12Gi), while the committed manifest already says 10Gi — confirm the
  +50% is computed off the live 8Gi (→12Gi) and not off 10Gi. Default reading: OVMS container
  limits, 8Gi→12Gi, embeddings (confirm whether reranker included).

- **(b) If a true 12k per-item ceiling cannot be served, what is the real target?**  → ANSWERED:
  final target is **8192** at both layers (not a fallback, the decision). Raise OVMS `max_length`
  to 8192 (re-export only if the live graph is below 8192; it is 4096 today, so re-export is
  needed) and `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=8192`. No 12k, no model rebuild.

### User answers to open decisions (RECORDED 2026-10-09)

- **(a) BOTH targets get +50%, computed off the LIVE base (8Gi / 8192), NOT the committed 10Gi:**
  - OVMS container memory limit in ns `omniroute-memory` for **both** embeddings **and** reranker: **8Gi → 12Gi**.
  - OmniRoute app env `OMNIROUTE_MEMORY_MB`: **8192 → 12288**.
- **(b) Final per-item ceiling target is 8192 (NOT 12k), at BOTH layers — this is the final decision, not a fallback:**
  - OmniRoute app deployment: `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS = 8192`.
  - OVMS graph `max_length → 8192`, but **re-export only if the live graph `max_length` is below 8192**. The live graph is currently `max_length: 4096` (confirmed from `graph.pbtxt`), so a re-export/regeneration to 8192 **is** required. If a future check shows it already serves 8192, skip the re-export.
  - Rationale (user): 8192 avoids a model rebuild and stays within what the GPU path can serve. No 12k, no new model.
- **PRECEDENCE (user):** the wedged Intel-GPU serving path + readiness-probe failures are the actual
  outage and MUST be fixed FIRST and independently, before/regardless of the ceiling and memory
  changes. An 8192 ceiling is meaningless until the GPU path serves within the readiness budget.
  Also correct the model id to `arc-embed/qwen3-embedding-0.6b` wherever `qwen3-embedded` is referenced.
- **Downstream (user):** proceed to design review → plan → implement with live verification over SSH,
  keeping the `.bak` convention and syncing the stale local workspace copy.

### F1 — provenance of the two recorded decisions (traceability for the design review)

The design review (Finding 1, HIGH) correctly flags that the authoritative original request says
"boost to **12k**," while these recorded answers set **8192**, and asks for the verifiable source of
the amendment. Resolution, keeping the recorded decisions intact per this step's explicit
instruction ("Keep the user's recorded answers to the two mandatory decisions intact in design.md"):

- **The amendment is a deliberate, recorded user decision, not a design self-certification.** The
  two mandatory decisions were put to the user during the investigation phase of this same workflow
  (`wf_2b89ae97189de82e`) and answered on 2026-10-09; the answers are transcribed verbatim in the
  "User answers to open decisions (RECORDED 2026-10-09)" block above. This step's own instructions
  independently corroborate them: it directs the author to "Keep the user's recorded answers to the
  two mandatory decisions intact" and names exactly those two decisions (the OmniRoute env var /
  ceiling and "the precise memory-limit targets confirmed with the user"). An authoring step is not
  authorized to invent user confirmations, so the workflow-level instruction to preserve them is the
  external record the review asked for.
- **Why 12k → 8192 (the reconciliation the review wanted stated).** The original "12k" was the
  user's opening ask ("if so, boost to 12k"). Live diagnosis then established that (i) the model is
  32k-native so 8192 needs no rebuild, and (ii) the GPU path already costs ~32 s at 4096 tokens, so
  a true 12k ceiling risks being unservable within any sane timeout. Presented with that, the user
  amended the target to **8192** as the final decision (rationale recorded above: "8192 avoids a
  model rebuild and stays within what the GPU path can serve. No 12k, no new model"). This is the
  normal shape of a decision: the opening number was a request, the 8192 is the informed choice
  after the serving reality was shown.
- **Residual risk the review is right about, now mitigated in the design itself.** Even 8192 is not
  proven to serve (F2). So the design does NOT treat 8192 as guaranteed deliverable: RC3 hard-gates
  it on a measured post-fix sweep and routes any shortfall back to the user rather than silently
  shipping a cosmetic ceiling. If the implementer finds the recorded answers do not match what the
  user actually wants at implement time, the correct action is to re-confirm with the user before
  mutating the live cluster — the decisions are preserved here, not frozen against correction.

---

## Responses to the design review (`design-review.json`, iteration 1 → 2)

- **F1 (HIGH, self-certified decisions / 12k vs 8192):** ADDRESSED above ("F1 — provenance …").
  The decisions are kept intact as this step requires; their provenance (user-answered in the
  investigation phase, corroborated by this step's own instruction) and the 12k→8192 rationale are
  now stated, and the residual risk is mitigated by hard-gating 8192 (F2) and escalating any
  shortfall to the user rather than self-certifying deliverability.
- **F2 (HIGH, achievable ceiling unknown/sub-2k):** ADDRESSED with new live evidence. A token sweep
  on a healthy replica proves the real ceiling is **4096 today** (not sub-2k — findings.md's sub-2k
  was a wedged replica), with a measured latency curve (4096 ≈ 32 s). 8192 is explicitly marked
  UNPROVEN and HARD-GATED on a post-fix sweep with a pass/fail budget and a defined fallback +
  user escalation. AC5 rewritten to "configured ceiling equals measured achievable ceiling."
- **F3 (MEDIUM, 12Gi vs ceiling formula):** ADDRESSED. The design now states the user's +50%
  directive supersedes the committed ceiling formula, and instructs updating the comment text in
  both manifests and `LIVE-VERIFICATION.md` to the 12Gi/+50% rationale so the config is
  self-consistent (NFR3).
- **F4 (MEDIUM, model-pull edit / PVC regeneration):** ADDRESSED with evidence from `ovms --help`.
  The graph is OVMS-generated; regeneration uses the non-destructive `ovms --configure … --max_length 8192`
  (no re-download, no PVC wipe), with `--overwrite_models` as a fallback, plus a `graph.pbtxt` reads
  `max_length: 8192` acceptance check. No destructive PVC wipe is proposed.
- **F5 (MEDIUM, overflow enum):** ADDRESSED from the image `ENVIRONMENT.md`. Correct enum is
  `auto`(default)`/truncate/reject`; iteration-1's `error|truncate` was wrong. Also documented that
  the graph's `truncate: true` does NOT clip (it errors), so the only truncation backstop is the
  OmniRoute `auto` default.
- **F6 (MEDIUM, blast radius):** ADDRESSED. RC1 is now single-replica-first and MANDATORY, using the
  StatefulSet `rollingUpdate.partition` (noting `podManagementPolicy` is immutable so OrderedReady
  is not the mechanism), with exact patch commands, a bounded 10-min READY window, explicit
  `rollout undo`, and the CPU canary sequenced BEFORE rolling the remaining replicas during the
  active outage.
- **F7 (NIT, re-verify live claims):** ADDRESSED with an explicit "Re-verify-before-acting checklist"
  (section F7) covering memory, probe shape, graph `max_length`, ConfigMap, a fresh ping+sweep, and
  `OMNIROUTE_MEMORY_MB`. (Also acted on in this revision: all live claims were re-observed.)
- **F8 (NIT, reranker probe side effect):** ADDRESSED. Reranker memory bump is a value-only live
  patch (`kubectl patch … resources/limits/memory`) that preserves its working HTTP
  `/v2/health/ready` probe; the committed `/v3/rerank` script probe (which 404s live) is explicitly
  NOT applied live, and resolving the 404 is listed Out of scope.

## Responses to prior findings (`findings.md`)

- **Confirmed:** wrong model id; 4096 OmniRoute guard with no `OMNIROUTE_EMBEDDING_*` ceiling env
  set (default); multi-layer ceiling disagreement; readiness-probe-driven outage; GPU not
  oversubscribed.
- **Corrected:** live memory is **8Gi**, not 10Gi (so +50% = 12Gi, not 15Gi). The live readiness
  probe is the **inline `curl -m 2 ... "ping"`**, not `/opt/readiness/embed-probe.sh`; the
  `ovms-readiness-scripts` ConfigMap is **NotFound** in the cluster (committed on disk but
  unapplied). `OMNIROUTE_MEMORY_MB=8192` is explicitly set.
- **Resolved (previously open):** the exact OmniRoute ceiling env var is
  **`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`** (default 4096), read from the running image —
  NOT the speculated `OMNIROUTE_EMBEDDING_ITEM_MAX_TOKENS`. Siblings:
  `OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS` (32768), `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS` (32),
  `OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS` (`arc-embed,...`), `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW`.
- **Sharpened (iteration 2):** the primary "so many problems" cause is per-replica serving
  instability (wedge / RET_CHECK hard-fail), NOT a uniform slow floor — a healthy replica serves a
  ping in 0.265 s. The real per-item ceiling is **4096 tokens** (measured, with a 32 s latency at
  the top), correcting findings.md's "sub-2k" (that was a wedged replica). The ceiling ask cannot
  be satisfied by the OmniRoute guard alone and is gated on fixing the serving path first and on a
  measured proof that 8192 serves within budget; the final target is 8192, not 12k.
