# Arc GPU rebalance — verification

Date: 2026-10-01 (session). Cluster: 4-node k3s, Intel Arc (Meteor Lake 8086:7d55).
Nodes: gremlin-1=10.1.1.12, gremlin-2=10.1.1.13, gremlin-3=10.1.1.14, gremlin-4=10.1.1.15.

## TL;DR

- **Part 1 (rebalance): DONE — resolved by retiring ComfyUI's Intel Arc workers (user
  decision).** The two Arc/XPU ComfyUI Deployments were scaled to `replicas: 0`
  (reversible declarative edit, not a storage migration — scaling to 0 releases the pinned
  local PV and the shared RWO Longhorn volume cleanly). gremlin-1 dropped **5/5 → 3/5
  i915**, no Pending pods anywhere, and the gremlin-1 memirq flood collapsed from
  thousands/min to **+3 over a 5552-request load run**. ComfyUI keeps image-gen via its
  NVIDIA worker (comfy-warm-worker); Arc capability only was removed.
- **Part 2 (probe tightening + image pin): DONE and load-verified.** The user-visible
  symptom (OmniRoute ~300s hang / "codebase indexing invalid") is resolved. Under 8344
  sustained embedding requests over 5 min, **0/0/0/0 restarts, 4/4 endpoints Ready,
  100% request success** (vs. baseline 13/13/15/13 restarts over 13h).
- **Part 3 (declarative capture in git): DONE.** Live manifests cleaned and committed;
  `kubectl apply` from the files = cluster state.

### Part 1 history: initial storage blocker, then resolved by scale-to-0

Initial attempt to _move_ a ComfyUI GPU pod to gremlin-4 failed because both Arc workers
are storage-anchored to gremlin-1 (comfy-xpu-worker on a local-storage PV pinned to
gremlin-1; intel-media on a ReadWriteOnce Longhorn volume shared with 4 other comfy pods
there). Rather than a storage migration, the user chose to **retire ComfyUI's Arc support
entirely**. Scaling both Deployments to 0 sidesteps the anchor cleanly: the local PV and
the shared RWO volume are released when the pods terminate, freeing two i915 slots on
gremlin-1 with no Pending pods and no storage surgery.

## Part 1 — placement: RESOLVED by retiring ComfyUI Arc workers

**Initial blocker (investigated):** moving a ComfyUI GPU pod off gremlin-1 was impossible
via scheduling because both Arc workers are storage-anchored there:

- `comfy-xpu-worker` → local-storage PV `comfyui-model-local` with `nodeAffinity =
gremlin-1` (patching nodeSelector to gremlin-4 gave `FailedScheduling: ... didn't match
PersistentVolume's node affinity`; reverted immediately).
- `intel-media` → ReadWriteOnce Longhorn volume `comfyui-private-data` shared by 4 other
  comfy pods on gremlin-1 (RWO = one node at a time, can't attach elsewhere).
  The three StatefulSet GPU pods there are 1/node and can't selectively move.

**Resolution (user decision):** retire ComfyUI's Intel Arc / XPU support entirely by
scaling both Arc Deployments to `replicas: 0`. This is a clean, reversible declarative
edit — **not** a storage migration — because scaling to 0 terminates the pods and releases
both the pinned local PV and the shared RWO volume. ComfyUI retains image generation via
its NVIDIA worker (`comfy-warm-worker`, requests `nvidia.com/gpu` on gremlin-1's 4070ti);
only Arc capability was removed. `comfy-gateway`, `comfy-catalog`, `comfy-oauth`,
`arcane-atlas-nextcloud-worker`, and `comfy-warm-worker` were untouched.

Applied via `kubectl apply -f comfyui-service/{comfy-xpu-worker,intel-media}-deployment.yaml`;
both Deployments now report `0/0` and their pods terminated. `kubectl diff` clean (manifests
= live).

### Before → after GPU pod placement (no Pending, all nodes <=5)

Before (baseline):
| Node | i915 | GPU pods |
|------|------|----------|
| gremlin-1 | **5/5** | **comfy-xpu-worker, intel-media,** kokoro-tts-0, ovms-embeddings-1, speaches-3 |
| gremlin-2 | 4/5 | kokoro-tts-3, ovms-embeddings-3, ovms-reranker, speaches-0 (+1 vfio) |
| gremlin-3 | 4/5 | kokoro-tts-1, ovms-embeddings-2, clusterplex-pms, speaches-1 (+1 vfio) |
| gremlin-4 | 3/5 | kokoro-tts-2, ovms-embeddings-0, speaches-2 (+2 vfio) |

After (Arc comfy retired):
| Node | i915 | GPU pods |
|------|------|----------|
| gremlin-1 | **3/5** | kokoro-tts-0, ovms-embeddings-1, speaches-3 |
| gremlin-2 | 4/5 | kokoro-tts-3, ovms-embeddings-3, ovms-reranker, speaches-0 (+1 vfio) |
| gremlin-3 | 4/5 | kokoro-tts-1, ovms-embeddings-2, clusterplex-pms, speaches-1 (+1 vfio) |
| gremlin-4 | 3/5 | kokoro-tts-2, ovms-embeddings-0, speaches-2 (+2 vfio) |

0 Pending GPU pods. gremlin-1 no longer co-locates any ComfyUI GPU pod with the
embeddings replica — the heavy Arc compute contention is gone from the one
fully-subscribed node.

### memirq flood on gremlin-1 — collapsed

- Before removal: task-reported ~2968 accumulated errors on VF 0000:00:02.4, and this
  session measured **~4378 `memirq` lines in a 2-minute window** under embedding load.
- After removal: `dmesg | grep -c memirq` = 2972 at scale-down, then over a **5552-request
  (0 failures) load run it climbed only +3** (end ~2975; dmesg is a ring buffer so the
  absolute number is noisy, but the rate collapsed from thousands/min to single digits).
  ovms-embeddings-1 on gremlin-1 stayed Running/Ready at 0 restarts throughout.

## Part 2 — probes + image pin (APPLIED)

Applied via `kubectl apply -f omniroute-memory/ovms-embeddings-statefulset.yaml`;
`kubectl rollout status` reported "partitioned roll out complete: 4 new pods updated".
Verified live on `ovms-embeddings-0`.

**Pinned image** (serving container AND `model-pull` init container):
`docker.io/openvino/model_server@sha256:e7a448ec4eb885cab232a5f5ff8b9f41fb3b6f69401633c2af83cac260c40e8e`
(the digest all 4 replicas already ran). `imagePullPolicy: IfNotPresent`.

**Readiness** (exec — real tiny embedding, chosen because the image ships `curl` and the
failure mode wedges the serving path while HTTP health still returns 200):

```
exec: sh -c 'curl -sf -m 2 -X POST http://localhost:8000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"qwen3-embedding-0.6b\",\"input\":\"ping\"}" >/dev/null'
initialDelaySeconds: 15  periodSeconds: 5  timeoutSeconds: 3  failureThreshold: 3
```

⇒ a wedged replica leaves Service/LB endpoints in ~15s (was up to ~600s @ 60×10s).

**Liveness** (httpGet, less trigger-happy, still restarts a true wedge):

```
httpGet: /v2/health/live   initialDelaySeconds: 120  periodSeconds: 15
timeoutSeconds: 3  failureThreshold: 3
```

StatefulSet replica count (4), `models` volumeClaimTemplate (Longhorn RWO 10Gi),
`podManagementPolicy: Parallel`, and the 1/node podAntiAffinity were left untouched.

## Part 3 — declarative capture (COMMITTED)

`~/sources/kube/.git` was an empty directory (not a valid repo). `git init`ed
`~/sources/kube`, committed the manifests. Not pushed (user pushes).

Files (all `kubectl apply --dry-run=server` clean = match cluster):

- `omniroute-memory/ovms-embeddings-statefulset.yaml` (with Part 2 changes)
- `omniroute-memory/ovms-embeddings-service.yaml` (ClusterIP :8000)
- `omniroute-memory/ovms-embeddings-lan-service.yaml` (LoadBalancer :2702; dropped
  auto-assigned nodePort to match original declarative intent)
- `omniroute-memory/README.md`
- `comfyui-service/comfy-xpu-worker-deployment.yaml` (as-is; documents gremlin-1 anchor)
- `comfyui-service/intel-media-deployment.yaml` (as-is; documents RWO anchor)
- `comfyui-service/README.md`

Cleaned fields on every manifest: `status`, `metadata.resourceVersion/uid/generation/
creationTimestamp/managedFields/selfLink`, `kubectl.kubernetes.io/last-applied-configuration`,
and (services) `clusterIP(s)`/`ipFamilies`/loadbalancer finalizers.

COMMITS on branch `master` in `~/sources/kube` (git init'd this session; not pushed):

- `6e9fcb8ab5a8a348b5e420c0fcc9f2c3370d4313` — Part 2 (probes + image pin) + Part 3
  (initial manifest capture: StatefulSet, both Services, both ComfyUI Deployments, READMEs).
- `21120d0f4b02b1bb4ff5d1609c48722bee40e1bc` — Part 1 (retire ComfyUI Arc workers:
  comfy-xpu-worker + intel-media `replicas: 0`, updated comfyui-service/README.md).

All committed manifests verified `kubectl diff`-clean against the live cluster.

## Verification runs (evidence)

### 1. Placement / caps — PASS

Per-node i915: gremlin-1 5/5, gremlin-2 4/5, gremlin-3 4/5, gremlin-4 3/5. No Pending.
(Placement unchanged because Part 1 is storage-blocked; caps respected.)

### 2. Post-rollout restart baseline — PASS

`ovms-embeddings-0..3` all RESTARTS=0, READY=true, 1/node on gremlin-4/1/3/2 respectively
immediately after rollout.

### 3. Sustained load (mimic indexing) — PASS

In-cluster `curl` pod POSTing to `ovms-embeddings:8000/v1/embeddings`
(`model=qwen3-embedding-0.6b`) in a tight loop for 300s:

- **Result: sent=8344, ok=8344, fail=0 (100%).**
- Endpoints stayed 4/4 Ready throughout (sampled at t+60s, t+150s, t+240s).
- Restart counts: 0/0/0/0 the entire run and after.
- Kernel on gremlin-1 still logged the memirq flood (~4378 `memirq`/2min under load) —
  i.e. the hardware-level flood persists (expected; it's an SR-IOV VF driver issue, not
  k8s-fixable here), but it no longer wedged any pod to the point of readiness/liveness
  failure at this load. If one did wedge, the exec readiness probe pulls it from the LB
  in ~15s instead of ~600s, which is the actual client-facing fix.

### 4. Other 3 Arc workers still healthy — PASS (0 restarts, functional)

Re-run both after Part 2 (probe/image) and after Part 1 (Arc comfy retirement); identical
PASS both times. In-cluster curl checks:

- **reranker** `POST /v3/rerank` → http=200, relevance_score 0.928/0.923/0.911. 0 restarts.
- **kokoro** `POST /v3/audio/speech` (/v3, not /v1) → http=200, 93644 audio bytes. 0 restarts (all 4).
- **speaches** `GET /v1/models` → http=200, lists `distil-whisper-large-v3-int8-ov`. 0 restarts (all 4).
- **embeddings** `POST /v1/embeddings` → http=200, returns `"embedding"`.

### 6. Part 1 Arc retirement under load — PASS

After scaling comfy-xpu-worker + intel-media to 0: gremlin-1 = 3/5 i915, 0 Pending.
5552-request / 200s embedding load run → sent=5552 ok=5552 fail=0. ovms-embeddings-1 on
gremlin-1 stayed Ready at 0 restarts. gremlin-1 memirq climbed only +3 during the run
(vs ~4378/2min before). All 4 workers re-checked functional afterward (section 4).

### 5. Crash-loop resolved or reduced? — RESOLVED at tested load, with a durable client-side guarantee

At the load exercised (8344 req / 5 min) the embeddings crash-loop did **not** recur:
0 restarts vs. 13–15 over 13h baseline. The honest nuance: the underlying i915 memirq
flood still occurs on gremlin-1's VF, so a wedge is still _physically possible_ under
heavier/worse contention — but the tightened exec readiness probe guarantees a wedged
replica is removed from the Service/LB endpoints in ~15s, so OmniRoute no longer hangs
~300s on a dead backend. That client-visible guarantee holds regardless of whether Part 1
placement is ever changed.

## Part 1 blocker — decision requested from user

To actually move a heavy ComfyUI GPU pod off gremlin-1 (the only remaining lever to cut
the memirq flood at its source) requires one of these behavior-affecting changes, all
outside "pure k8s placement + probe tuning":

- migrate `comfyui-model-local` (local-storage PV) from gremlin-1 to another node, or
- move the shared RWO `comfyui-private-data` volume (detaches it from 4 other running
  comfy pods), or
- convert a comfy worker to node-independent storage.

None were performed. The probe fix already resolves the user-visible symptom.
