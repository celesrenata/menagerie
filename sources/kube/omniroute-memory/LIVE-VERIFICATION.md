# Live-Cluster Verification Checklist — Retrieval Fabric

> **⚠️ MANUAL, NON-CI CHECKLIST — NOT AUTO-VERIFIABLE.**
> This document is run by hand against the live Intel GPU cluster **after** the
> committed config in this directory has been applied. It is **not** a CI gate
> and nothing here runs automatically. It verifies live GPU serving behavior
> that no automated test can observe.

> **arc-embed-ceiling-boost / FEAT-001 update (2026-10-09):** embeddings no longer
> serve from the in-cluster SR-IOV-VF StatefulSet (it wedged on the Arc `ccs0`
> compute path and is now SCALED TO 0). Embeddings serve HOST-NATIVE on each
> gremlin's PF Arc device via the NixOS module `modules/ovms-embeddings-host.nix`
> (podman, `/dev/dri/renderD128`, host `:8000`, `max_length=4096`), fronted by the
> in-cluster `ovms-embeddings-proxy` (see `ovms-embeddings-proxy.yaml`) which the
> `ovms-embeddings` Service points at. Memory is `12Gi` (+50% off 8Gi) on the
> reranker and recorded on the (scaled-to-0) embeddings STS; measured OVMS
> footprint is ~4.5–6.6 Gi. Per-item ceiling is `4096` at BOTH layers
> (`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096` + `overflow=auto`, and the
> host-native OVMS graph `max_length=4096` set by FEAT-003) — 8192 failed the
> token sweep because the GPU wedges serving a single near-8192-token item. See
> `.agents/tasks/arc-embed-ceiling-boost/deploy-report.md` + `live-verify.md`.
>
> **FEAT-005 workspace-sync note (2026-10-09):** the manifests in this directory
> now diff-match the live cluster for the fields this task changed (embeddings STS
> + reranker `memory: 12Gi`, embeddings model-pull `--truncate=true
> --max_length=4096`, `embed-probe.sh` POST `/v1/embeddings`). The OmniRoute app
> env change (`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096`,
> `OMNIROUTE_MEMORY_MB=12288`) lives ONLY on the remote `kubectl`-applied copy —
> there is no local `sources/kube/omniroute/` directory in this workspace.

This checklist complements the automated config-assertion gate at
`src/services/code-index/retrieval-fabric/__tests__/committed-manifests.test.ts`.
That test parses the committed manifests and asserts their *shape* (digest pins,
topology, dual-path exec probes, reranker model, sized memory/ceiling). It can
**never** verify live GPU behavior — whether a wedged serving path is actually
removed from rotation, whether real iGPU contention exists, or whether the sized
memory holds under real inference. Those are the three sections below.

Feature: retrieval-fabric — Properties 1 and 9. Requirements 4.2, 4.3, 6.4, 22.9.

## Verified cluster facts (reference)

- **Nodes:** four Intel GPU nodes `gremlin-1`..`gremlin-4` at `10.1.1.12`–`10.1.1.15`
  (`gremlin-4` is cluster-init). One embedding OVMS replica per node via required
  hostname anti-affinity.
- **Namespace:** `omniroute-memory`.
- **Embedding image (digest-pinned):**
  `docker.io/openvino/model_server@sha256:e7a448ec4eb885cab232a5f5ff8b9f41fb3b6f69401633c2af83cac260c40e8e`
  (same digest on the reranker and both `model-pull` init containers).
- **Vector store:** `qdrant-0` in `omniroute-memory`.
- **Node capacity:** ~98.5 GB capacity / ~94 GB allocatable per node. The Arc
  iGPUs draw from **shared system RAM**, so the binding near-term OOM boundary is
  the per-pod memory limit, not dedicated VRAM.
- **Memory limit:** `12Gi` (+50% off the live 8Gi base) on the reranker and
  recorded on the (now scaled-to-0) embeddings STS. The host-native OVMS podman
  service has no explicit cgroup limit (effective ceiling = node RAM). **Measured
  OVMS usage under load is ~4.5–6.6 Gi**, so 12Gi carries headroom — the +50% is
  comfortable but larger than the real footprint requires. Enforced per-item
  ceiling is **4096** at BOTH layers (`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096`
  + `overflow=auto`, and the host-native OVMS graph `max_length=4096` set by
  FEAT-003); 8192 failed the F2 token sweep because serving a single near-8192-token
  item wedges the Arc GPU (>90s, ccs0 fence-timeout).
- **Committed manifests in this directory:**
  - `ovms-embeddings-statefulset.yaml` — 4-replica embedding StatefulSet.
  - `ovms-reranker-deployment.yaml` — Qwen3-Reranker-0.6B INT8 Deployment.
  - `ovms-readiness-scripts-configmap.yaml` — `embed-probe.sh` / `rerank-probe.sh`.

## Prerequisite — apply the committed config

```sh
# From this directory, against the live cluster (gremlin-4 is cluster-init).
kubectl apply -n omniroute-memory -f ovms-readiness-scripts-configmap.yaml
kubectl apply -n omniroute-memory -f ovms-embeddings-statefulset.yaml
kubectl apply -n omniroute-memory -f ovms-reranker-deployment.yaml

# Wait for rollout and confirm one embedding + one reranker pod per node.
kubectl -n omniroute-memory rollout status statefulset/ovms-embeddings --timeout=10m
kubectl -n omniroute-memory rollout status deployment/ovms-reranker --timeout=10m
kubectl -n omniroute-memory get pods -o wide \
  -l 'app in (ovms-embeddings,ovms-reranker)'
```

**Observe:** exactly four `ovms-embeddings-*` pods and four `ovms-reranker-*`
pods, one of each per node `gremlin-1`..`gremlin-4`, all `Running` and `2/2`
Ready-eligible. Confirm the applied image is the digest pin above (never
`latest-gpu`):

```sh
kubectl -n omniroute-memory get statefulset ovms-embeddings \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

**Pass:** all eight pods scheduled one-per-node and the live image equals the
committed digest.

---

## Section 1 — GPU-wedge detection via dual-path readiness

**Property 1, Requirement 22.9.** Confirms that the dual-path real-inference
readiness probe removes a replica whose Intel GPU serving path is wedged, even
while the generic HTTP `/v2/health/ready` endpoint still returns 200 — the
GPU-wedge failure mode that HTTP health alone cannot catch — and that doing so
does not destabilize existing load-spreading.

### 1.1 Confirm the exec readiness probes are configured and running

```sh
# Embedding readiness must be the exec real-inference probe, not httpGet alone.
kubectl -n omniroute-memory get statefulset ovms-embeddings \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.exec.command}{"\n"}'
# Expect: ["/opt/readiness/embed-probe.sh"]

kubectl -n omniroute-memory get deployment ovms-reranker \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.exec.command}{"\n"}'
# Expect: ["/opt/readiness/rerank-probe.sh"]

# Confirm the scripts are present and executable inside a live pod.
EMB_POD="$(kubectl -n omniroute-memory get pod -l app=ovms-embeddings \
  -o jsonpath='{.items[0].metadata.name}')"
kubectl -n omniroute-memory exec "${EMB_POD}" -c ovms -- ls -l /opt/readiness/
kubectl -n omniroute-memory exec "${EMB_POD}" -c ovms -- /opt/readiness/embed-probe.sh; echo "exit=$?"
# Expect exit=0 on a healthy replica (well-formed 1024-dim embedding returned).
```

**Observe:** both probes are `exec` real-inference probes (not `httpGet
/v2/health/ready`), the scripts exist at `/opt/readiness/` and are executable,
and a healthy replica returns exit 0.

### 1.2 Confirm HTTP health and liveness still answer independently

```sh
# HTTP readiness endpoint still returns 200 on a healthy pod (this is the
# endpoint the real-inference probe deliberately does NOT trust alone).
kubectl -n omniroute-memory exec "${EMB_POD}" -c ovms -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/v2/health/ready
# Expect: 200

# Confirm the HTTP liveness probe is retained (keeps the pod alive for recovery
# and keeps load-spreading stable while readiness moves to real-inference).
kubectl -n omniroute-memory get statefulset ovms-embeddings \
  -o jsonpath='{.spec.template.spec.containers[0].livenessProbe.httpGet.path}{"\n"}'
# Expect: /v2/health/live
```

**Observe:** `/v2/health/ready` returns 200 and the HTTP liveness probe on
`/v2/health/live` is still configured.

### 1.3 Simulate or observe a wedged GPU serving path on one replica

Pick one target replica (e.g. the pod on `gremlin-2`) and induce a wedged GPU
serving path while leaving the HTTP server up. Options, least to most invasive:

- **Observe a natural wedge** if one is already occurring (historical replica
  load-imbalance root cause). Confirm `/v2/health/ready` is green on the suspect
  pod but `embed-probe.sh` fails.
- **Induce** by saturating/holding the iGPU so a real embedding request times
  out past the probe `timeoutSeconds: 5` while the HTTP control plane stays
  responsive (for example, drive sustained concurrent inference at the node — see
  Section 2 — against the single target, or temporarily revoke/contend the
  `gpu.intel.com/i915` serving path on that pod).

Confirm the split-brain condition directly:

```sh
TARGET_POD="ovms-embeddings-1"   # the chosen wedged replica
# HTTP health still green:
kubectl -n omniroute-memory exec "${TARGET_POD}" -c ovms -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/v2/health/ready
# Expect: 200  (HTTP alone would keep this replica in rotation)

# Real embedding path wedged:
kubectl -n omniroute-memory exec "${TARGET_POD}" -c ovms -- /opt/readiness/embed-probe.sh; echo "exit=$?"
# Expect: exit!=0  (real-inference probe detects the wedge)
```

**Observe:** on the wedged replica `/v2/health/ready` returns 200 while
`embed-probe.sh` exits non-zero — exactly the case HTTP health alone misses.

### 1.4 Confirm NotReady and removal from Service Endpoints

```sh
# After failureThreshold (4) consecutive probe failures the pod goes NotReady.
watch -n5 "kubectl -n omniroute-memory get pod ${TARGET_POD} \
  -o jsonpath='{range .status.conditions[?(@.type==\"Ready\")]}{.status}{\"\n\"}{end}'"
# Expect the Ready condition to flip to False.

# The wedged pod's IP must be removed from the Service Endpoints (taken out of
# rotation) while HTTP health is still green.
kubectl -n omniroute-memory get endpoints ovms-embeddings -o wide
kubectl -n omniroute-memory get endpointslices -l 'kubernetes.io/service-name=ovms-embeddings' -o yaml \
  | grep -A3 "$(kubectl -n omniroute-memory get pod ${TARGET_POD} -o jsonpath='{.status.podIP}')" || \
  echo "wedged pod IP absent from endpoints — removed from rotation (expected)"
```

**Observe:** the wedged pod's Ready condition becomes `False` and its IP is no
longer listed in the Service Endpoints / EndpointSlice.

### 1.5 Confirm liveness keeps the pod alive and recovery restores readiness

```sh
# The pod must NOT be killed by liveness while merely NotReady — it stays alive
# so the GPU serving path can recover.
kubectl -n omniroute-memory get pod ${TARGET_POD} \
  -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'
# Expect: restartCount unchanged (no liveness-driven restart from the wedge alone).

# Clear the wedge, then confirm the replica returns to Ready and rejoins Endpoints.
kubectl -n omniroute-memory exec ${TARGET_POD} -c ovms -- /opt/readiness/embed-probe.sh; echo "exit=$?"
# Expect: exit=0 once recovered, then Ready flips back to True and the IP returns.
```

**Observe:** `restartCount` does not increase from the wedge alone; after
recovery the probe passes, the pod returns to Ready, and its IP rejoins
Endpoints.

### 1.6 Confirm load-spreading is not destabilized by brief blips

```sh
# A single slow/blipped real-inference request must NOT flap a healthy replica.
# failureThreshold: 4 at periodSeconds: 15 tolerates ~45s of transient slowness.
kubectl -n omniroute-memory describe pod ${EMB_POD} | grep -A6 'Readiness:'
# Confirm: exec embed-probe.sh, timeout 5s, period 15s, failureThreshold 4.
kubectl -n omniroute-memory get events --field-selector involvedObject.name=${EMB_POD} \
  | grep -i readiness || echo "no readiness flapping events (expected)"
```

**Observe:** healthy replicas do not oscillate Ready/NotReady under brief
latency blips; no readiness-flap events on healthy pods.

**PASS CRITERION (Section 1):** readiness correctly removes a wedged replica
that HTTP health alone (`/v2/health/ready` returning 200) would have kept in
rotation, liveness keeps the pod alive for recovery, and healthy replicas are
not destabilized by brief blips.

---

## Section 2 — Per-node vs dedicated reranker contention under real iGPU load

**Requirements 4.2 / 4.3, Property 9 (benchmark-before-fallback gate).** Confirms
whether running the reranker-0.6b on all four nodes alongside the embedding
replica (the initial desired topology) produces meaningful iGPU contention or
instability. The fallback topology (3 embedding + 1 dedicated reranker) **MUST
NOT** be adopted without a documented contention signal from this section.

### 2.1 Confirm the initial desired topology is live

```sh
# Reranker-0.6b must be running on all four nodes alongside embeddings.
kubectl -n omniroute-memory get pods -o wide \
  -l 'app in (ovms-embeddings,ovms-reranker)' --sort-by='.spec.nodeName'
# Expect: one ovms-embeddings AND one ovms-reranker per gremlin-1..gremlin-4.

kubectl -n omniroute-memory get deployment ovms-reranker \
  -o jsonpath='{.spec.replicas}{"\n"}'                     # Expect: 4
kubectl -n omniroute-memory get deployment ovms-reranker \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}' \
  | tr ',' '\n' | grep model_name                          # Expect: qwen3-reranker-0.6b
```

**Observe:** four embedding + four reranker pods, one of each per node, reranker
model `qwen3-reranker-0.6b`.

### 2.2 Capture a per-node baseline (idle)

```sh
# Pod + node memory and (if the metrics endpoint is exposed) OVMS metrics.
kubectl -n omniroute-memory top pods --containers | grep -E 'ovms-(embeddings|reranker)'
kubectl top nodes | grep gremlin

# Baseline OVMS metrics per pod (served-request counts, inference latency).
for p in $(kubectl -n omniroute-memory get pod -l app=ovms-reranker -o name); do
  echo "== $p =="
  kubectl -n omniroute-memory exec "${p##*/}" -c ovms -- \
    curl -s http://127.0.0.1:8000/metrics 2>/dev/null \
    | grep -E 'ovms_(requests|inference_time|current_requests)' | head
done
```

**Observe:** record idle pod memory (expect near the ~5.6 Gi baseline), node RAM
headroom, and baseline inference-latency metrics per node.

### 2.3 Drive real concurrent embedding + rerank load

Use real workload (indexing a real repository through the gateway, or a load
script issuing concurrent `/v1/embeddings` and `/v3/rerank` requests at realistic
batch sizes up to the 4096-token ceiling) so both serving paths are exercised on
the **same** iGPU on each node simultaneously.

```sh
# Sample pod/node memory and OVMS latency repeatedly under sustained load.
for i in $(seq 1 20); do
  date +%T
  kubectl -n omniroute-memory top pods --containers | grep -E 'ovms-(embeddings|reranker)'
  kubectl top nodes | grep gremlin
  for p in $(kubectl -n omniroute-memory get pod \
      -l 'app in (ovms-embeddings,ovms-reranker)' -o name); do
    kubectl -n omniroute-memory exec "${p##*/}" -c ovms -- \
      curl -s http://127.0.0.1:8000/metrics 2>/dev/null \
      | grep -E 'ovms_inference_time|ovms_current_requests'
  done
  sleep 15
done

# Watch for instability during the run: readiness flaps or restarts.
kubectl -n omniroute-memory get events --sort-by=.lastTimestamp \
  | grep -iE 'ovms-(embeddings|reranker)' | grep -iE 'readiness|liveness|OOM|restart'
```

**Observe:** per-node iGPU contention indicators under combined load — rerank
and embedding latency vs the idle baseline, `ovms_current_requests` queue depth,
pod memory headroom vs the 12Gi limit, and any readiness flaps, restarts, or OOM
events that signal instability.

### 2.4 Decide the contention signal

Compare loaded vs baseline latency and stability per node. Document one of:

- **No meaningful contention:** combined embedding+rerank latency and stability
  stay within acceptable bounds on all four nodes. → **Keep** the initial desired
  4-node co-located topology.
- **Meaningful contention/instability:** latency regresses materially or
  readiness flaps/OOM/restarts appear under combined load. → The fabric becomes
  **eligible** to adopt the fallback 3-embedding + 1-dedicated-reranker topology.

**PASS CRITERION (Section 2):** a documented, measured contention signal (per
node, with numbers) that gates the fallback decision. The fallback 3+1 topology
**MUST NOT** be adopted without this signal (Req 4.3, Property 9).

---

## Section 3 — Sized ceiling / pod-memory validation against live real-inference probes

**Requirement 6.4.** Confirms the `12Gi` pod memory limit (+50% off the live 8Gi
base, applied by FEAT-004) and the `4096`-token per-item serving ceiling (applied
by FEAT-003 — 8192 failed the token sweep) hold under a real request at the
ceiling, and that a ceiling-sized request cannot produce a padded GPU batch or
pod footprint exceeding measured safe memory — validated against the live
dual-path real-inference probes **before** adoption.

### 3.1 Confirm the committed limit and ceiling are live

```sh
kubectl -n omniroute-memory get statefulset ovms-embeddings \
  -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}{"\n"}'
# Expect: 12Gi

kubectl -n omniroute-memory get deployment ovms-reranker \
  -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}{"\n"}'
# Expect: 12Gi
```

**Observe:** both pods carry the `12Gi` limit (+50% off the live 8Gi base) sized
with the `4096`-token ceiling.

### 3.2 Issue a real request at the serving ceiling and watch memory

```sh
# Build a request whose per-item token count is at the 4096 serving ceiling and
# send it to a single replica while sampling that pod's memory.
EMB_POD="$(kubectl -n omniroute-memory get pod -l app=ovms-embeddings \
  -o jsonpath='{.items[0].metadata.name}')"

# Sample memory before/during/after the ceiling request.
kubectl -n omniroute-memory top pod "${EMB_POD}" --containers
kubectl -n omniroute-memory exec "${EMB_POD}" -c ovms -- \
  curl -s -o /dev/null -w 'http=%{http_code} t=%{time_total}s\n' \
  -H 'Content-Type: application/json' -X POST \
  http://127.0.0.1:8000/v1/embeddings \
  -d @/path/to/ceiling-request.json      # input sized to ~4096 tokens per item
kubectl -n omniroute-memory top pod "${EMB_POD}" --containers
```

**Observe:** the ceiling request returns a well-formed embedding (`http=200`) and
peak pod memory stays below the `12Gi` limit with headroom above the ~4.5-6.6 Gi
baseline. No OOMKill.

### 3.3 Confirm no OOM / batch blow-up at the ceiling

```sh
kubectl -n omniroute-memory describe pod "${EMB_POD}" \
  | grep -iE 'OOMKilled|Last State|Reason|restart'
kubectl -n omniroute-memory get events --field-selector involvedObject.name="${EMB_POD}" \
  | grep -iE 'OOM|Evicted|FailedScheduling' || echo "no OOM/eviction events (expected)"
```

**Observe:** no `OOMKilled`, eviction, or memory-pressure events from a request
at the ceiling — confirming the ceiling cannot produce a padded GPU batch or pod
footprint exceeding measured safe memory.

### 3.4 Validate against the live dual-path real-inference probes

```sh
# Immediately after the ceiling load, both real-inference probes must still pass
# on the affected pods (serving path healthy at the sized limit).
kubectl -n omniroute-memory exec "${EMB_POD}" -c ovms -- /opt/readiness/embed-probe.sh; echo "embed exit=$?"
RRK_POD="$(kubectl -n omniroute-memory get pod -l app=ovms-reranker \
  -o jsonpath='{.items[0].metadata.name}')"
kubectl -n omniroute-memory exec "${RRK_POD}" -c ovms -- /opt/readiness/rerank-probe.sh; echo "rerank exit=$?"
# Expect both exit=0: the sized ceiling/memory is validated by the live probes.
```

**Observe:** `embed-probe.sh` and `rerank-probe.sh` both exit 0 after the
ceiling-sized load — the sized ceiling and memory are validated against the live
dual-path real-inference probes.

**PASS CRITERION (Section 3):** the `12Gi` limit and 4096-token ceiling hold
under a real ceiling-sized request (measured peak memory below `12Gi`, no OOM),
and the live dual-path probes still pass — i.e. the sizing is validated live
**before** it is adopted (Req 6.4).

---

## Sign-off

| Section | Verifier | Date | Result (pass/fail) | Notes / measured numbers |
|---------|----------|------|--------------------|--------------------------|
| 1 — GPU-wedge dual-path readiness | | | | |
| 2 — Reranker contention gate | | | | |
| 3 — Sized ceiling / pod-memory | | | | |

Record the Section 2 contention numbers here; the fallback 3+1 topology is
adopted only if Section 2 documents meaningful contention.
