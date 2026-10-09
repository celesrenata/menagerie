# arc-embed-ceiling-boost — Live Verification

Date: 2026-10-09. Access: `ssh -o BatchMode=yes celes@192.168.42.254` (k3s) + `root@10.1.1.{12..15}` (gremlin hosts); OmniRoute mgmt API `https://omniroute.celestium.life` (bearer `/run/secrets/omniroute_management_api_key`). qdrant OFF-LIMITS.

## Topology after remediation

Embeddings now serve HOST-NATIVE on each gremlin's physical-function (PF) Intel Arc device, NOT through the in-cluster SR-IOV-VF StatefulSet.

```
OmniRoute (public /v1/embeddings, arc-embed/qwen3-embedding-0.6b)
  -> ovms-embeddings Service (ClusterIP 10.43.56.117:8000, selector app=ovms-embeddings-proxy, targetPort 8001)
    -> ovms-embeddings-proxy (nginx, hostNetwork, 4 replicas, listen :8001, least_conn + failover)
      -> host-native OVMS on each PF: 10.1.1.12:8000, 10.1.1.13:8000, 10.1.1.14:8000, 10.1.1.15:8000
         (NixOS systemd/podman service, /dev/dri/renderD128 = PCI 0000:00:02.0, model max_length=4096)
```

The in-cluster `ovms-embeddings` StatefulSet is SCALED TO 0 (kept for rollback). qdrant StatefulSet unchanged: `generation=1`, `uid=a2c81b89-45b7-407c-bd5b-691eceb47aa8`, `1/1 Ready` (verified before/after every mutating step).

## Serving verification (public API)

- Model id `arc-embed/qwen3-embedding-0.6b` resolves and returns **1024-dim** vectors. The wrong id `arc-embed/qwen3-embedded` is not used by the live path; stale references remain only in OmniRoute's `storage.sqlite` / historical call logs (not active config).
- Isolated / normally-paced public calls: **5/5 HTTP 200, all 1024-dim** (latency 0.07–9.9 s; variable because of concurrent OmniRoute background load + proxy failover).
- Each PF host backend serves 1024-dim and, under light/moderate load, is clean (e.g. gremlin-1/gremlin-4 did 5/5–8/8 clean at ~40 ms, 0 PF errors).
- Over-ceiling input (external caller, single item ~6667 tok > 4096): clean HTTP 400 — `"over the 4096-token per-item limit for arc-embed; split the input or set OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=truncate"`. This is the intended `overflow=auto` protection (external callers get 400; OmniRoute's internal memory/retrieval path splits to <=4096 before embedding). It prevents the giant-single-item request that triggers the GPU wedge.

### Known limitation (NOT fully clean under peak load)
OmniRoute's own memory/retrieval engine emits a sustained background embedding flood (~73–82 arc-embed requests / 60 s observed). Under that continuous concurrent load the Meteor Lake Arc GPUs still intermittently wedge (same `ccs0`/fence-timeout signature as the VFs, now on the PF under enough sustained compute), rotating across whichever nodes absorb the load. nginx failover keeps ~2–3/4 serving, so isolated calls succeed, but a tight back-to-back 20-call public run still shows intermittent 20 s client timeouts (NOT `fetch failed` — slow/hanging, not refused). Mitigations applied (host-native PF, `i915.reset=1` fleet-wide, 4096 cap + overflow=auto, 4-node proxy with least_conn/failover/max_conns) reduced but did not eliminate this. The durable root-cause fix is the GPU driver/firmware remediation (D), documented in deploy-report.md.

## i915 kernel param (all 4 nodes)

`i915.reset=1` (force full-GPU reset; engine-first reset did not recover the VF/PF compute engine) + `i915.request_timeout_ms=10000`, from `modules/i915-sriov.nix` (commit `152b4a2`). Verified active on gremlin-1/2/3/4 (`/sys/module/i915/parameters/reset=1`). SR-IOV config otherwise untouched.

## Memory utilization vs allocation (user-requested)

Measured host-native OVMS podman container memory under load (`podman stats`):

| Node       | Used (under load) |
|------------|-------------------|
| gremlin-1  | ~5.94 GB          |
| gremlin-2  | ~6.56 GB          |
| gremlin-3  | ~4.58 GB          |
| gremlin-4  | ~5.04 GB          |

- **Peak observed: ~6.6 GB; steady: ~4.5–6 GB.**
- The host-native podman OVMS service has **no explicit cgroup memory limit** in the systemd unit, so its effective ceiling is node RAM (~94–100 GB allocatable; ample).
- The `+50%` bump (8Gi -> 12Gi) applied to the kube **reranker** Deployment and recorded on the (now scaled-to-0) embeddings StatefulSet is **oversized vs the real embeddings footprint**: actual OVMS embeddings use is ~4.5–6.6 GB, so even the original 8Gi had headroom; 12Gi is comfortable but not required by measured usage. Keeping 12Gi is harmless (nodes have ~94 GB) and gives margin for larger batches, but the data does not show the +50% was necessary for the embeddings footprint. The reranker 12Gi limit vs its measured footprint should be re-measured once it is Ready (it was still loading its graph under GPU contention at report time).

## OmniRoute env (live, authoritative)

- `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096` (enforced per-item ceiling; the GPU can serve 8192 but WEDGES doing a single ~8192-tok item at 30–300 s, so 4096 is the correct hardware ceiling)
- `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=auto`
- `OMNIROUTE_MEMORY_MB=12288` (was 8192; +50%)
- OVMS graph `max_length=4096` on all 4 PF host-native nodes (10.1.1.12/13/14/15), reconciled by FEAT-003 to MATCH the enforced OmniRoute 4096 guard — both ceiling layers now carry the SAME number (design AC5). The GPU can physically serve 8192 but WEDGES on a single ~8192-tok item (30–300 s), so 4096 is the proven hardware ceiling.

Note: `~/sources/kube/omniroute/omniroute.yaml` on the host is root-owned and NOT writable by `celes`; these env values are set live on the Deployment (authoritative) and the file could not be reconciled — flagged for a manual sudo reconcile.

## Cross-FEAT integration verification (iteration 1, 2026-10-09)

End-to-end re-verification of all five design acceptance criteria together against the LIVE cluster. All seams between FEATs were checked; one stale-doc seam (graph `max_length` recorded as 8192 while live was 4096) was found and reconciled in this file and `deploy-report.md`.

| AC  | Criterion | Live result |
|-----|-----------|-------------|
| AC1 | ovms-embeddings availability, no climbing restarts | PASS (reconciled topology): in-cluster STS scaled to 0; serving is host-native PF via `ovms-embeddings-proxy` 4/4 Running 46m, restarts=0. The design's StatefulSet-replica model was superseded by FEAT-001's host-native PF pivot. |
| AC2 | 20 consecutive public POST /v1/embeddings -> 200 + 1024 dims, no `fetch failed` | 19/20 HTTP 200 + 1024-dim, **0 `fetch failed`**; 1 slow HTTP 504 (not a refused/dead-backend fetch-failed). The lone timeout is the documented, user-escalated GPU-wedge-under-sustained-load limitation (follow-up item D), NOT the original outage symptom. |
| AC4 | model id corrected | PASS: `arc-embed/qwen3-embedding-0.6b` -> 200 + 1024-dim; wrong id `arc-embed/qwen3-embedded` -> clean 404 (`Mediapipe graph definition ... not found`); owned config clean. |
| AC5 | both ceiling layers equal; at-ceiling 200 in budget; over-ceiling cleanly rejected | PASS: graph `max_length=4096` on all 4 PF nodes == OmniRoute guard `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096` (SAME number). At-ceiling input (est ~4090 tok) -> HTTP 200 + 1024-dim in ~2 s; over-ceiling (est ~4100 tok) -> clean HTTP 400 naming item/estimate/cap (overflow=auto). |
| AC6 | both memory limits 12Gi + `OMNIROUTE_MEMORY_MB=12288`; reranker 1/1 | PARTIAL: embeddings STS + reranker Deployment `limits.memory`=12Gi; `OMNIROUTE_MEMORY_MB=12288`. Reranker is **0/1**, a PRE-EXISTING, explicitly out-of-scope OVMS mediapipe graph-load hang (restarts=0, no OOMKill, probe unchanged); the user accepted Option A in FEAT-004 (do not pull the reranker fix into this task). The 12Gi bump and env are correct and live. |
| AC7 | manifests reconciled, correct comments, ConfigMap present | PASS: `cm ovms-readiness-scripts` present; committed workspace manifests under `sources/kube/omniroute-memory/` diff-match live (12Gi, `--max_length=4096`, embed-probe `/v1`) with correct +50%/12Gi and 4096-ceiling comments. Stale 8192-headroom lines in this report + `deploy-report.md` reconciled to 4096 this iteration. |
| AC8 | qdrant untouched; reranker HTTP probe intact | PASS: qdrant `generation=1`, `uid=a2c81b89-45b7-407c-bd5b-691eceb47aa8`, 1/1. Reranker readinessProbe is the live HTTP `httpGet /v2/health/ready` (NOT the committed `/v3/rerank` exec script), restarts=0. |

Seam found + fixed this iteration: the OVMS graph `max_length` had already been reconciled LIVE to 4096 on all 4 PF nodes (matching the enforced guard, satisfying AC5), but this `live-verify.md` and `deploy-report.md` still described it as "8192 kept as headroom" — a documentation seam, not a live mismatch. Both docs corrected to 4096. No live cluster mutation was required: every live value already satisfied the design. qdrant was never touched; the remote `.bak` convention is intact.
