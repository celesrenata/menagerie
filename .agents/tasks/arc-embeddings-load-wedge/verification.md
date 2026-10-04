# Arc Embeddings — Load Wedge Fix: Verification Note

Scope reminder (HARD CONSTRAINTS honored): no node reboots, no NixOS/VF/GuC/i915 changes, replica count stayed 4, PVCs/storage/image-digest-pin unchanged, StatefulSet not deleted. Changes are minimal and reversible; committed manifests equal what is applied (`kubectl diff` clean, see below).

## TL;DR

- **Fix 2 (rotating readiness/liveness wedge): FIXED in-scope.** Softened the liveness probe in `omniroute-memory/ovms-embeddings-statefulset.yaml` (`failureThreshold 3 -> 6`, `timeoutSeconds 3 -> 5`; `periodSeconds 15` and `initialDelaySeconds 120` unchanged). This stops the SIGKILL restart storm on transient GPU fence-stalls while still restarting a genuinely dead pod (~90 s budget). Readiness probe left UNCHANGED so a wedged pod still leaves the LB in ~15 s.
- **Fix 1 (uneven load): already healthy once pods stay ready — no OmniRoute change needed or possible.** The plan's keepalive-pinning hypothesis did NOT reproduce under measurement (load spreads evenly across all 4 replicas at both concurrency=1 and concurrency=6). The plan's primary lever `customHeaders:{"Connection":"close"}` is **rejected by the OmniRoute schema** and is a no-op hop-by-hop header anyway. The historical 120/249/263/587 skew was a _symptom_ of the wedge ejecting pods from Service endpoints — fixing the wedge (Fix 2) keeps all 4 ready, so load stays spread.

## What was applied

### Manifest change (committed, applied, clean diff)

`omniroute-memory/ovms-embeddings-statefulset.yaml`, container `ovms` livenessProbe:

| field                 | before | after           |
| --------------------- | ------ | --------------- |
| `failureThreshold`    | 3      | 6               |
| `timeoutSeconds`      | 3      | 5               |
| `periodSeconds`       | 15     | 15 (unchanged)  |
| `initialDelaySeconds` | 120    | 120 (unchanged) |

Liveness kill budget: `periodSeconds 15 x failureThreshold 6 = ~90 s` continuously-unresponsive before restart (was `15 x 3 = ~45 s`). A transient fence-stall (readiness already ejects at ~15 s, and the stall often self-clears) no longer trips a kill; a pod wedged hard for >90 s is still restarted. Readiness probe (`curl -sf -m 2 POST /v1/embeddings`, `periodSeconds:5 x failureThreshold:3 = ~15 s`) is UNCHANGED, preserving fast ejection of a dead serving socket.

`kubectl diff -f omniroute-memory/ovms-embeddings-statefulset.yaml` after apply: **clean (exit 0)**. The only live-vs-manifest delta before apply was those two liveness fields (plus the expected generation bump). Replica count = 4, image `sha256:e7a448ec...`, and the longhorn RWO volumeClaimTemplate all unchanged.

### OmniRoute provider nodes: NO change applied

- Confirmed both embedding provider nodes (`ovms-arc` id `...8a59c128...` -> `:8000/v1`; `arc-embed` id `...1710a12f...` -> `:8000/v3`) with `customHeaders: null`. Baseline captured in `omniroute-memory/omniroute-provider-nodes.baseline.json`.
- Attempted the plan's Fix 1 lever. `POST /api/provider-nodes` with `customHeaders:{"Connection":"close"}` returns **HTTP 400: `customHeaders.Connection: Invalid key in record`** — the schema forbids the hop-by-hop `Connection` header. (A benign header like `X-Test` IS accepted, confirming the route works and the rejection is `Connection`-specific.) Even if accepted, `Connection` is a hop-by-hop header the proxy HTTP client strips, so it would not defeat keepalive. Two duplicate nodes accidentally created while probing the write route (POST creates-by-id, not upsert) were **deleted** via `DELETE /api/provider-nodes/<id>` (HTTP 200); provider-node set restored to the original two with `customHeaders: null`.
- `/api/settings` `timeoutMs` left at **120000** (global per-request timeout). There is no per-route/per-embedding timeout knob; lowering the global value is user-visible for non-embedding LLM routes, so it was not changed unilaterally. OmniRoute `requestRetry: 3` is already enabled and transparently retries a failed attempt onto a healthy sibling.

## Measurements

### Load spread (the Fix 1 deliverable)

Driver: Zoo-style 60-input embedding batches via OmniRoute `POST /v1/embeddings` model `ovms-arc/qwen3-embedding-0.6b`, inference key.

Pre-change baseline, concurrency=6, 150 s (`kubectl top` mcores, sampled every 15 s): all 4 replicas carried load evenly, e.g. `269/232/313/324`, `193/195/182/183`, `203/170/163/231` — no single pod > 2x another. Serial (concurrency=1), 90 s: `50/76/31/51`, `48/55/45/64`, `75/45/42/61` — still evenly spread. The pinning/skew of 120/249/263/587 did **not** reproduce.

Post-change sustained run, concurrency=6, **7 minutes** (14 samples @30 s), mcores:

```
sample  pod0  pod1  pod2  pod3
2       222   266   187   193
3       207   186   241   228
4       184   224   198   264
5       309   170   204   172
6       253   274   187   217
7       228   273   183   242
8       193   250   181   250
9       189   264   222   240
10      232   178   209   159
11      233   196   191   199
12      164   224   159   232
13      187   306   153   156
14      201   213   191   176
```

All 4 replicas share load every sample; max/min ratio within each sample stays well under 2x. Materially flatter than 120/249/263/587.

### Restarts and readiness (the Fix 2 deliverable)

- Immediately before the fix, over ~50 min the pods had churned to RESTARTS 3/2/2/2 with `Liveness probe failed: context deadline exceeded` -> `Killing ... failed liveness probe (x3)` and readiness-failed x89 on the rotating-wedge pod. A pre-change request run showed a wedged pod that could not answer within the client ceiling.
- After `kubectl apply` + `rollout status` (partitioned rollout completed, all 4 updated), restart counters reset to 0.
- During the full 7-minute post-change load run: **0 new restarts on all 4 pods**, all stayed **ready=1/1 the entire run**, and `kubectl describe` showed **no Unhealthy/Killing events** in the window. The transient fence-stalls that previously tripped the ~45 s liveness kill now fall inside the ~90 s budget and self-recover without a restart — exactly the intended effect.
- Other 3 Arc workers unaffected, all **0 restarts**: `ovms-reranker` (route `/vN/rerank` responds, service up), `kokoro-tts-0..3` (2/2 Running), `speaches-0..3` (3/3 Running), speaches `/v1/models` via OmniRoute = HTTP 200.

### Request success and residual latency tail

- Post-change: **3792 embedding requests, 3792 HTTP 200 (100%)**, avg 0.646 s.
- Residual tail: **3 of 3792 (0.08%)** requests hit the client `--max-time 60 s` ceiling (all still returned 200 via retry). These correspond to the intermittent GPU fence-stall catching an in-flight request. Under the OLD liveness config a 60 s stall would also have triggered a restart; under the new config it does not. Making these last few truly invisible would require lowering OmniRoute's global `timeoutMs` (user-visible for chat) or the driver-level Phase B fix below.

### Qdrant / indexing

- `ws-` collection point counts on `http://10.1.1.12:6333` were identical before and after (total **45943**: ws-70b9... 25584, ws-b652... 8397, ws-7197... 1386, ws-2861... 10495, ws-a92d... 80, ws-a701... 1).
- This is EXPECTED: the synthetic load generator exercises the embedding endpoint (OmniRoute -> OVMS) only; it does not run the Zoo indexer, so it does not write vectors to Qdrant. The 100% HTTP 200 rate from the embedding service demonstrates the path the indexer depends on is healthy; actual `ws-` growth will resume when the real Zoo editor indexing runs. No embedding call failed, so indexing is not blocked by the embedding tier.

## Reproducibility / rollback

- Manifest change is declarative in git (`~/sources/kube`), reversible by reverting the two liveness fields and re-applying.
- No OmniRoute runtime state was changed; `omniroute-provider-nodes.baseline.json` records the two embedding nodes as `customHeaders: null` (their current, unchanged state).

## Commit

Local commit in `~/sources/kube` (NOT pushed): SHA recorded below.

- SHA: `d76ace91dcc51cf2979ff222ce7caec6d7a476d5` (`d76ace9`), branch `master`, not pushed.

## Phase B — OUTSTANDING ROOT CAUSE (OUT OF SCOPE — user to schedule separately)

The rotating wedge's root cause is **driver-level**: Intel Arc SR-IOV VF `i915` **fence-expiration timeouts** under GPU load (a GuC-submission / SR-IOV VF stall; `enable_guc=3`, patched `i915-sriov-dkms`), observed on all four nodes. A GPU submission never signals its completion fence, so the OVMS inference thread blocks until liveness/readiness act. The in-scope changes here make the wedge **non-disruptive** (no restart storm, all replicas stay ready, load stays spread, ~100% request success) but do **not eliminate** it — the rare 60 s latency tail is its residue.

Eliminating it requires a GuC/driver change plus node reboots, which are explicitly OUT OF SCOPE for this task:

- GuC tuning `enable_guc=3 -> 1` in `modules/i915-sriov.nix`, OR a `strongtz/i915-sriov-dkms` bump for the Meteor Lake fence/memirq fix.
- Rolled **one node at a time** on `root@gremlin-1:/etc/nixos` branch `dev`; **never reboot gremlin-2/3/4 together** (k3s etcd quorum); **no live VF rebind** (previously caused `-ENXIO` PTE corruption).

Documentation only — do not reboot, edit NixOS, or change VFs/GuC/i915 in this workflow.
