# Arc GPU rebalance + ovms-embeddings probe tightening

The change targets a 4-node k3s cluster (Intel Arc / Meteor Lake) where sustained embedding load wedged `ovms-embeddings` on the one fully-subscribed node (gremlin-1), producing an i915 SR-IOV VF `memirq` flood and a client-visible ~300s OmniRoute hang / "codebase indexing invalid". The implementer freed GPU slots on gremlin-1 by retiring ComfyUI's two Intel Arc workers (`comfy-xpu-worker`, `intel-media`) to `replicas: 0`, tightened the embeddings readiness/liveness probes, pinned the serving + init image to the running digest, and captured the live manifests into a freshly `git init`-ed repo at `~/sources/kube`. The approach deviates from the literal PART 1 mechanism (affinity-based steering) because both Arc workers are storage-anchored to gremlin-1 and could not be rescheduled without storage surgery the guardrails forbid; the user elected to retire Arc capability instead.

Watch for: the PART 1 mechanism is scale-to-0 retirement, not the podAntiAffinity/nodeAffinity preference the brief names (confirmed) — but this traces back to an authentic storage-anchor blocker and an explicit user decision in the original messages, and the stated goal (gremlin-1 no longer co-locating both ComfyUI GPU pods with the embeddings replica, no Pending, all nodes ≤5 i915) is met. The crash-loop is resolved at the tested load but the underlying memirq flood persists at the hardware level (confirmed, author-acknowledged); the probe tightening is the durable client-facing guarantee, not a root-cause fix.

**Verdict**: APPROVED

## High-level view

PART 1's goal is satisfied through a different, defensible mechanism. The brief asked for least-invasive affinity steering, but the verification note documents — with reproduced error output (`FailedScheduling: didn't match PersistentVolume's node affinity`) — that `comfy-xpu-worker` is pinned to gremlin-1 by a local-storage PV `nodeAffinity`, and `intel-media` holds a ReadWriteOnce Longhorn volume shared with other comfy pods on that node. Affinity steering cannot move a pod whose PV is anchored elsewhere, so the only guardrail-compliant lever was to stop running the Arc workers. Scaling to 0 (Deployments kept, not deleted) is reversible, releases both the pinned PV and the shared RWO volume, and drops gremlin-1 from 5/5 to 3/5 i915 with no Pending pods. The embeddings StatefulSet's own 1/node required podAntiAffinity is untouched.

PART 2 matches the brief closely. The readiness probe is an exec that POSTs a real tiny embedding (periodSeconds 5, failureThreshold 3, timeoutSeconds 3, drops a wedged replica from endpoints in ~15s); the liveness is httpGet on `/v2/health/live` (initialDelaySeconds 120, periodSeconds 15, timeoutSeconds 3, failureThreshold 3). The image is digest-pinned on both the serving and `model-pull` init containers to the digest all four replicas already ran, with `imagePullPolicy: IfNotPresent`. Replica count (4), the `models` Longhorn RWO volumeClaimTemplate, `podManagementPolicy: Parallel`, and the retention policy are unchanged; the StatefulSet was not deleted. The exec-readiness choice is well-reasoned: the failure mode leaves HTTP health returning 200 while the serving path is wedged, so an httpGet readiness probe would keep a dead replica in the LB.

PART 3 is a clean declarative capture. All seven committed files (StatefulSet, both Services, both ComfyUI Deployments, two READMEs) carry no `status`, `resourceVersion`, `uid`, `generation`, `creationTimestamp`, `managedFields`, `selfLink`, `last-applied-configuration`, or Service `clusterIP`/finalizer cruft — confirmed by direct grep across the files. Commits are on `master`, not pushed, with descriptive messages and READMEs explaining the retire decision, the digest pin, and the probe design. The author states `kubectl diff`/`--dry-run=server` is clean against the live cluster.

The guardrails hold: no node reboots, NixOS edits, or VF/driver/GuC changes — the only cluster mutations are k8s declarative edits (two Deployment replica counts, one StatefulSet spec).

<details>
<summary>Issues (2)</summary>

1. **PART 1 mechanism differs from the brief (non-blocking)** — The brief specified affinity-based steering; the implementation retires Arc workers via `replicas: 0`. This is justified by a confirmed storage-anchor blocker and an explicit user decision, achieves the stated placement goal, and is reversible. No action required; noted so a reviewer isn't surprised the manifests contain no new affinity rules.
2. **memirq root cause persists (non-blocking, acknowledged)** — The i915 VF memirq flood is a hardware/SR-IOV issue not fixable in k8s; the crash-loop is resolved only at the tested load. The tightened exec readiness probe is the durable mitigation (wedged replica leaves the LB in ~15s). Acceptable per the brief's "reduced not eliminated but invisible to clients" clause; keep an eye on it under heavier contention.

</details>

<details>
<summary>Details</summary>

### PART 1: retirement instead of affinity steering

The brief names podAntiAffinity / nodeAffinity preference as the mechanism, and the committed manifests contain no such new rules — the lever is `replicas: 0` on both Arc Deployments. The verification note explains why affinity could not work: `comfy-xpu-worker` mounts a local-storage PV (`comfyui-model-local`) whose `nodeAffinity` pins it to gremlin-1, and patching its nodeSelector to gremlin-4 reproduced `FailedScheduling: ... didn't match PersistentVolume's node affinity` (reverted). `intel-media` holds a ReadWriteOnce Longhorn volume (`comfyui-private-data`) shared with other comfy pods already on gremlin-1, so RWO semantics forbid attaching it elsewhere. Moving either pod would require a storage migration — outside the k8s-only guardrail. The original user messages back the chosen path ("then lets do that", "just do it properly", "redistribute the load and validate these workers work at all"): the user accepted retiring Arc capability. ComfyUI keeps image generation via its NVIDIA worker (`comfy-warm-worker`), so the retirement is scoped to Arc only.

The outcome satisfies PART 1's substance: gremlin-1 goes 5/5 → 3/5 i915 and no longer co-locates any ComfyUI GPU pod with the embeddings replica, no node exceeds 5 i915, there are no Pending GPU pods, the change is reversible (Deployments kept at 0, re-enable with `replicas: 1`), and the embeddings StatefulSet's 1/node required podAntiAffinity is preserved in the committed manifest. The mechanism is more invasive than preference-based scheduling in the sense that it removes a capability, but given the storage anchor it is the _least_-invasive option that actually clears gremlin-1 without touching storage or drivers.

### PART 2: probes, digest pin, no storage disturbance

The committed StatefulSet matches the target probe shape. Readiness is an exec that curls a real embedding POST against `localhost:8000/v1/embeddings` with a 2s client timeout, `initialDelaySeconds 15 / periodSeconds 5 / timeoutSeconds 3 / failureThreshold 3` — a wedged serving socket leaves the Service/LB endpoints in roughly 15s. Liveness stays httpGet on `/v2/health/live` with `initialDelaySeconds 120 / periodSeconds 15 / timeoutSeconds 3 / failureThreshold 3`, deliberately less trigger-happy so transient slowness doesn't SIGKILL-flap a pod. The exec-readiness rationale is sound and the key reason the fix works: under the memirq wedge the HTTP health endpoints keep returning 200 while the serving path is dead, so only a real inference probe detects the wedge.

Both the serving container and the `model-pull` init container pin `openvino/model_server@sha256:e7a448ec…c40e8e` — the digest the four replicas already ran — with `imagePullPolicy: IfNotPresent`, eliminating the `:latest-gpu` drift risk. The round-trip-sensitive fields are untouched: `replicas: 4`, the `models` volumeClaimTemplate (Longhorn RWO 10Gi), `podManagementPolicy: Parallel`, `persistentVolumeClaimRetentionPolicy: Retain/Retain`, and the StatefulSet was patched in place, not deleted.

### PART 3: clean manifests, committed not pushed

A grep across all seven committed YAMLs returns no live-only fields (`status`, `resourceVersion`, `uid`, `generation`, `creationTimestamp`, `managedFields`, `selfLink`, `last-applied-configuration`) and no Service `clusterIP`/`ipFamilies`/finalizer residue. The lan Service correctly dropped its auto-assigned nodePort to match declarative intent. Two commits on `master` (`6e9fcb8` capture + Part 2, `21120d0` Part 1 retire) carry clear messages; the repo was `git init`-ed this session and is not pushed, as required. READMEs document the retire decision and re-enable path, the digest-pin rationale, the probe design, and explicit "do not change replica count / do not delete the StatefulSet" guidance. The author asserts `kubectl diff`-clean parity between committed files and the live cluster; I did not re-run the cluster (correctly out of scope for this review) and rely on that assertion plus the manifest inspection.

### Verification credibility

The note carries before/after per-node i915 counts (gremlin-1 5/5→3/5; 2/3/4 unchanged at 4/4/3), a sustained-load run (8344 requests / 5 min, 0 failures, 0/0/0/0 restarts vs. a 13/13/15/13-over-13h baseline, endpoints sampled 4/4 Ready at t+60/150/240s), a second post-retire load run (5552 requests, 0 failures, gremlin-1 memirq climb +3 vs. ~4378/2min before), and the 4-worker functional re-check (reranker `/v3/rerank` 200 with scores ~0.91–0.93, kokoro `/v3/audio/speech` 200 with 93644 bytes, speaches `/v1/models` 200 listing the whisper model, embeddings `/v1/embeddings` 200). The crash-loop claim is honest: resolved at tested load, memirq flood persists at the hardware level, probe tightening is the durable client-side guarantee. This matches the brief's explicit "reduced not eliminated but invisible to clients" allowance and is not a hand-waved load test.

</details>

<details>
<summary>File map</summary>

- `omniroute-memory/ovms-embeddings-statefulset.yaml` — digest-pinned image, exec readiness + httpGet liveness, replicas/PVC/antiAffinity preserved.
- `omniroute-memory/ovms-embeddings-service.yaml` — ClusterIP :8000, cleaned.
- `omniroute-memory/ovms-embeddings-lan-service.yaml` — LoadBalancer :2702, nodePort dropped.
- `omniroute-memory/README.md` — digest-pin + probe-design rationale, do-not list.
- `comfyui-service/comfy-xpu-worker-deployment.yaml` — `replicas: 0` (retired, local-PV anchor documented).
- `comfyui-service/intel-media-deployment.yaml` — `replicas: 0` (retired, RWO anchor documented).
- `comfyui-service/README.md` — retire decision + re-enable path.

Full diff: `git -C ~/sources/kube show 6e9fcb8` and `git -C ~/sources/kube show 21120d0`.

</details>
