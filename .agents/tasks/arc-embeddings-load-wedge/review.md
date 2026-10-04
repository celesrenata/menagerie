# Soften ovms-embeddings liveness to stop the Arc fence-stall restart storm

The coder was asked to fix two things on the Intel Arc k3s `ovms-embeddings` tier: uneven load across the four replicas (the historical 120/249/263/587 CPU skew) and a rotating readiness/liveness wedge that was restart-storming pods. The shipped change is a single, minimal StatefulSet edit — liveness `failureThreshold 3→6` and `timeoutSeconds 3→5` — plus a committed rollback-baseline JSON documenting that no OmniRoute provider-node change was applied. The coder's central claim is that both symptoms share one root cause chain: the readiness wedge was ejecting pods from the Service, which concentrated all load on whichever ~2 pods stayed ready; softening liveness keeps all four pods ready, which both stops the restart storm and lets load spread naturally. The driver-level fence-expiration root cause is correctly scoped out to a user-scheduled reboot Phase B.

Watch for: the plan asserted Fix 1 was "CONFIRMED connection pinning" and prescribed a `Connection: close` header, but the coder reversed that diagnosis during implementation — the header is schema-rejected and the pinning did not reproduce under measurement (confirmed by reading the verification data and the committed baseline note). This is a diagnosis reversal, not a gap: the acceptance criterion for Fix 1 is load-spread, and the post-change evidence meets it regardless of mechanism.

**Verdict**: APPROVED

## High-level view

The whole change is two liveness probe fields on `ovms-embeddings-statefulset.yaml`. The kill budget moves from ~45s (`15×3`) to ~90s (`15×6`), so a transient Intel Arc i915 fence-expiration stall — which readiness already ejects at ~15s and which often self-clears — no longer trips a SIGKILL, while a genuinely dead socket wedged for >90s still restarts. Readiness is deliberately untouched, preserving the ~15s fast-ejection of a dead serving socket. This is minimal, declarative, and reversible by reverting two numbers.

Fix 1 (load spread) was re-diagnosed during implementation. The plan's keepalive-pinning theory did not hold: the coder measured even spread across all four replicas at concurrency 1 and 6 before the change, and the `Connection: close` lever is both schema-rejected (HTTP 400) and a no-op hop-by-hop header. The coder's reframing — the 120/249/263/587 skew was a downstream symptom of the wedge ejecting pods, not independent connection pinning — is coherent and is supported by the post-fix 7-minute run where all four replicas carry traffic with max/min well under 2x. No OmniRoute runtime state was changed; both provider nodes stay `customHeaders: null`, recorded in a committed baseline.

The hard constraints hold: applied StatefulSet confirms `replicas:4`, image digest `sha256:e7a448ec…`, and the Longhorn RWO 10Gi PVC template all unchanged; the StatefulSet was rolled, not deleted. The applied liveness probe equals the committed manifest (spot-checked), and the commit `d76ace9` lives in `~/sources/kube` with no remote configured, so nothing was pushed.

The driver-level fence-expiration cause remains and is explicitly deferred to the reboot Phase B. The residual tail — 3 of 3792 requests (0.08%) hitting the client's 60s ceiling, all still returning 200 via retry — is that cause's residue, honestly characterized rather than hidden.

<details>
<summary>Issues (2)</summary>

1. **Diagnosis reversal vs. plan (non-blocking)** — The plan's "CONFIRMED connection pinning" diagnosis for Fix 1 was overturned at implementation time; the committed baseline and verification document why (did not reproduce, header schema-rejected and hop-by-hop). The load-spread acceptance criterion is still met by the post-change evidence, so this is a documentation/judgment note, not a blocker.
2. **Residual latency tail persists (out of scope, non-blocking)** — 0.08% of requests hit the 60s client ceiling due to the un-fixed driver-level fence stall; all still succeed via retry. Elimination requires the reboot Phase B, which is correctly scoped out.

</details>

<details>
<summary>Details</summary>

## Both symptoms, one root cause

The shipped change is one manifest edit, argued to address both symptoms through a shared causal chain.

The readiness probe is a full `/v1/embeddings` POST with `-m 2`, `periodSeconds:5`, `failureThreshold:3` — a wedged pod leaves the Service endpoints in ~15s. When a pod wedges, the Service drops to ~2–3 ready endpoints and kube-proxy concentrates traffic on the survivors; that is the 120/249/263/587 skew. The old liveness (`15×3 ≈ 45s`) then SIGKILLed the wedged pod, and the fence stall rotated to the next node, producing a continuous restart storm (observed RESTARTS 3/2/2/2 with `Liveness probe failed: context deadline exceeded` and readiness-failed x89). Softening liveness to `15×6 ≈ 90s` means a transient stall — already ejected from the LB by readiness at ~15s, and self-clearing before 90s — no longer kills the pod. Pods stay ready, the endpoint set stays at four, and load spreads.

The post-change 7-minute run (14 samples at 30s) shows every sample carrying load on all four replicas, max/min within each sample well under 2x (e.g. `164/224/159/232`, `187/306/153/156`). Materially flatter than the historical skew, satisfying the Fix 1 criterion. Over the same window: 0 new restarts on all four pods, all ready=1/1 throughout, no Unhealthy/Killing events — satisfying the Fix 2 criterion that the probe stops false flaps while still ejecting a dead socket (readiness unchanged at ~15s).

## The Fix 1 diagnosis reversal

The plan diagnosed Fix 1 as connection pinning ("the OmniRoute pod holds exactly 4 ESTABLISHED connections … pinned per connection") and prescribed `customHeaders: {"Connection":"close"}`. The implementation reversed this, for two reasons that both check out. First, the lever does not exist: `POST /api/provider-nodes` with that header returns HTTP 400 `customHeaders.Connection: Invalid key in record`, and `Connection` is a hop-by-hop header the proxy's HTTP client strips, so even if accepted it would not defeat keepalive. Second, the pinning did not reproduce: pre-change measurement at both concurrency=1 and concurrency=6 already showed even spread (`269/232/313/324`, `50/76/31/51`), inconsistent with a tiny pinned pool.

A reviewer should note this is a diagnosis the plan got wrong, not an unimplemented step. The coder substituted a measurement-backed explanation (skew is a wedge symptom) and the acceptance criterion for Fix 1 is defined by outcome (load spread, no pod >2x), which the evidence meets. No OmniRoute runtime state was mutated; two duplicate provider nodes accidentally created while probing the write route were deleted and the set restored to the original two with `customHeaders: null`, documented in the baseline. The decision to leave global `timeoutMs:120000` alone (no per-route embedding knob; lowering it is user-visible for chat routes) is the right conservative call.

## Hard constraints

Applied StatefulSet (spot-checked via `kubectl get statefulset ovms-embeddings`) reports `replicas:4`, liveness `failureThreshold:6`/`timeoutSeconds:5`, image `sha256:e7a448ec…` — matching the committed manifest, so the applied state equals committed (corroborating the clean-diff claim). The committed YAML retains the RWO/longhorn/10Gi volumeClaimTemplate and the digest-pinned image unchanged; readiness probe untouched. No node reboot, NixOS, VF, GuC, or i915 change appears anywhere in the diff — the only files touched are `ovms-embeddings-statefulset.yaml` and the new baseline JSON. The StatefulSet was rolled (`rollout status`), not deleted. Commit `d76ace91dcc5…` (`d76ace9`) is HEAD on `master`; `git remote -v` is empty and no upstream is configured, confirming nothing was pushed.

## Driver-level cause and the residual tail

The verification is honest that the fix does not eliminate the wedge. The root cause — Intel Arc SR-IOV VF i915 fence-expiration timeouts under GPU load, observed on all four nodes — is driver-level and requires GuC tuning or an `i915-sriov-dkms` bump plus one-node-at-a-time reboots, correctly deferred to Phase B as out of scope. The residue is 3 of 3792 requests (0.08%) hitting the client's 60s ceiling, all still returning 200 via OmniRoute's `requestRetry:3`. Under the old liveness a 60s stall would also have restarted the pod; under the new config it does not. This is the correct "partial mitigation sound, root cause deferred" outcome the task anticipated.

## Other workers and indexing

The evidence shows the other three Arc workers healthy with 0 restarts: `ovms-reranker` (route responds), `kokoro-tts-0..3` (2/2 Running), `speaches-0..3` (3/3 Running, `/v1/models` via OmniRoute HTTP 200). Qdrant `ws-` collections were identical before and after (total 45943) — expected, since the synthetic load driver exercises the embedding endpoint only and does not run the Zoo indexer. The 100% HTTP 200 rate (3792/3792) on the embedding path the indexer depends on demonstrates indexing is not blocked by the embedding tier; actual `ws-` growth resumes when the real indexer runs. This is a reasonable reading of the evidence rather than a claim of observed vector growth.

</details>

<details>
<summary>File map</summary>

- `omniroute-memory/ovms-embeddings-statefulset.yaml` — liveness `failureThreshold 3→6`, `timeoutSeconds 3→5`; readiness, replicas, image digest, PVC template unchanged.
- `omniroute-memory/omniroute-provider-nodes.baseline.json` (new) — rollback baseline for the two embedding provider nodes plus an "after" note recording that no provider-node change was applied and why.

Full diff: `git show d76ace9` in `/Users/celes/sources/kube`.

</details>
