# arc-embed-ceiling-boost — Deploy Report (FEAT-001)

Date: 2026-10-09. Scope: restore `arc-embed/qwen3-embedding-0.6b` embedding availability, land the token ceiling + memory asks, over a LIVE k3s cluster + the gremlin NixOS hosts. qdrant OFF-LIMITS (untouched throughout: `gen=1`, `uid=a2c81b89-45b7-407c-bd5b-691eceb47aa8`).

## Root cause (the full story)

The "so many problems" outage was NOT a context-window problem. It was an **Intel Meteor Lake Arc GPU compute hang** on the embedding serving path:

1. The in-cluster OVMS embedding StatefulSet ran on **SR-IOV virtual functions (VFs)**. Under sustained embedding inference the VF **compute command streamer (ccs0)** wedged, flooding `i915 ... *ERROR* GT0: Unexpected memirq status 0x0 from ccs0` and timing out GPU fences (`Fence expiration time out i915-0000:00:02.X:ovms[...]`). Wedged replicas sat `0/1`, OmniRoute load-balanced onto dead backends, and clients saw `fetch failed`. The original inline `-m 2 ping` readiness probe could not survive this.
2. Isolation testing proved the hang was **not node-local and not probe/memory-related**: it reproduced on gremlin-2 and gremlin-3, independent of pod revision. A gentler script probe + a 12Gi memory bump + a full-GPU-reset kernel param (`i915.reset=1`) all helped recovery but did NOT cure the wedge.
3. Moving to the **physical function (PF)** instead of a VF was decisive for light/moderate load: a host-native OVMS on the PF (`/dev/dri/renderD128`, PCI `0000:00:02.0`) served 40/40 clean at ~40 ms with zero PF `ccs0`/fence errors — where the VF wedged. **However**, under OmniRoute's heavy continuous background embedding load the PF ALSO wedges with the same `ccs0`/fence signature; it simply needs more sustained compute to trigger on the PF than on a VF. So the hang is a GPU driver/firmware-level defect of this MTL Arc + i915-SR-IOV stack, not specific to VFs.

## What was deployed

### Host-native OVMS on all 4 PF Arc devices (the new serving path)
- Shared NixOS module `modules/ovms-embeddings-host.nix`, wired via `modules/common.nix`, applied to all Intel-GPU gremlins. Runs `openvino/model_server` (same digest as the old STS) via **podman** (daemonless, uniform), bound to the PF render node, REST on host `:8000`, model pulled with `--max_length=8192`. Resolves the per-host `video` group GID at RUNTIME (it differs 26 vs 500 across nodes and a live GID is not changed by a rebuild).
- Commits on branch `dev` of `git@github.com:celesrenata/nixos-k3s-configs` (only our files staged; pre-existing drift `flake.lock`/`flake.nix`/`modules/common.nix` + the gremlin-2 `xe-sriov.nix` unmerged entry left untouched; `.bak` kept):
  - `152b4a2` i915.reset=1 + request_timeout_ms (modules/i915-sriov.nix)
  - `97ea36e` / `7ff94fa` / `c2e217e` gremlin-1 canary (docker)
  - `4b2a931` shared module for all 4 (podman)
  - `260de4a` runtime-resolved device GID
- `i915.reset=1` + `request_timeout_ms=10000` now active on ALL 4 nodes (fleet reboot). SR-IOV config otherwise untouched.

### Got off the broken kube path
- In-cluster `ovms-embeddings` StatefulSet **scaled to 0** (reversible; object kept) so the VF-wedging pods stop contending for the GPUs.

### OmniRoute routing to all 4 hosts
- OmniRoute reaches arc-embed via the `ovms-embeddings` Service DNS (`.../v3/embeddings`, confirmed from call logs).
- A direct ClusterIP->node-IP endpoint hit a kube-proxy **hairpin** (a pod cannot reliably reach the host OVMS on its OWN node). Fixed by an in-cluster **nginx reverse-proxy** `ovms-embeddings-proxy` (hostNetwork, 4 replicas one per node, listen `:8001`, `least_conn` + per-backend `max_conns` + fast `max_fails`/short read-timeout failover) that fans out to all four PF backends. The `ovms-embeddings` Service points at the proxy. OmniRoute backend calls flipped from 504 to 200.

### Ceiling + memory (the original asks)
- `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096` with `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=auto` (live). **4096, NOT 8192, is the enforced ceiling** — the GPU CAN serve 8192 but WEDGES doing a single ~8192-token item (30–300 s), so 4096 + auto-split is the correct per-item ceiling for this hardware. OVMS graph `max_length=8192` kept as harmless headroom.
- `OMNIROUTE_MEMORY_MB=8192 -> 12288` (live).
- Reranker container memory `8Gi -> 12Gi`, value-only live patch preserving its working HTTP `/v2/health/ready` probe (the committed exec `rerank-probe.sh` was NOT applied live because `/v3/rerank` 404s there).
- Memory utilization measured: host-native OVMS uses ~4.5–6.6 GB (peak ~6.6 GB). The +50% bump is comfortable but oversized vs the real footprint — see live-verify.md.

## Verification summary
- Isolated/normal public calls: 5/5 HTTP 200, 1024-dim.
- Over-ceiling single item: clean HTTP 400 with split guidance (intended overflow=auto protection).
- Under OmniRoute's heavy background flood: intermittent 20 s client timeouts as GPUs rotate through the wedge; nginx failover keeps ~2–3/4 serving. Not perfectly clean under peak concurrency.
- qdrant untouched. All 4 nodes `i915.reset=1`. OVMS footprint well under 12Gi.

## FEAT-003 — context ceiling resolved coherently at 4096 (8192 failed the gate)

The user's target was 8192 at both layers, hard-gated on a post-fix token sweep. The sweep was re-run this session against the REAL serving path (host-native PF; the in-cluster StatefulSet is scaled to 0, so there was no replica to roll — the host-native graph was already built at 8192):

| input | HTTP | time | note |
| 100 w | 200 | 4.46 s | |
| 1000 w | 200 | 0.64 s | |
| 2000 w | 200 | 1.44 s | |
| 4000 w | 200 | 7.95 s | |
| 6144 w | 200 | 13.19 s | largest power-of-two step passing <60s on an IDLE backend |
| ~7900 tok (near 8192) | 000 | **>90 s TIMEOUT, GPU WEDGED** | ccs0 fence-timeout; the healthy backend went to a 12s ping timeout afterwards |
| 8192 w (~8194 tok) | 400 | 14.3 s | over cap: `Input length 8194 longer than allowed 8192` |

**8192 FAILED the F2 gate** (>60s = FAIL; a near-8192-token single item does not return within 90s and wedges the Arc GPU). This independently reproduces the FEAT-001 finding. The gap-to-8192 was escalated to the user via send_message (warning); 6144 was rejected because, though it passes an idle-backend latency sweep, under OmniRoute's real concurrent background load (~73–82 req/60s) a 6144-token single item pushes the PF Arc back into the wedge regime — the exact failure this effort escaped.

**Decision (user-confirmed): 4096 at BOTH layers.**
- Enforced guard `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=4096` (FEAT-001 already set it live; confirmed, not thrashed). `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=auto` left as-is.
- Host-native OVMS graph `max_length` lowered 8192→4096 on all 4 PF nodes (10.1.1.12–15), reconciled one node at a time behind nginx failover (edit graph.pbtxt + `systemctl restart ovms-embeddings-host`, `.bak` kept per node; each verified serving a 1024-dim vector before the next). The NixOS module `modules/ovms-embeddings-host.nix` `maxLength` binding was set to 4096 with a rationale comment and committed isolated on branch `dev` (`.bak` kept; flake/SR-IOV drift untouched; NOT pushed).

**Verification:** all 4 host graphs read `max_length: 4096`; the guard reads 4096 (both layers carry the SAME number); public API small input → 200 + 1024-dim; over-ceiling single item → clean HTTP 400 naming the item/cap (overflow=auto); qdrant untouched (gen=1, uid a2c81b89). A larger window than 4096 requires follow-up D below plus a source-side embedding concurrency cap.

## Recommended follow-up (D — root-cause GPU fix, future maintenance window)
The remaining intermittent wedge under heavy load is a GPU driver/firmware limit of the MTL Arc + i915-SR-IOV stack. Recommended durable fix:
- Bump the pinned `i915-sriov-dkms` (currently strongtz ref `2026.09.16`) and/or the GuC/HuC firmware (`mtl_guc_70.bin` / `mtl_huc`) to a revision that addresses the `ccs0` "Unexpected memirq status 0x0" + fence-timeout compute hang on Meteor Lake.
- Build on one node first, canary under sustained load, then roll node-by-node (cordon/drain, rebuild, reboot, verify no `ccs0` recurrence) — same propagation discipline used here.
- Complementary source-side lever: cap OmniRoute embedding **concurrency/rate** (not just per-item tokens) so the aggregate background load never drives a PF GPU into the multi-hundred-second regime that triggers the wedge.

## FEAT-004 — memory +50% / env bump reconcile (completed 2026-10-09T20Z)

Scope: the two remaining +50% targets off the live 8Gi/8192 base (reranker Deployment, OmniRoute app env) plus reconciling the declarative sizing comments. embeddings 8Gi->12Gi already shipped in FEAT-001.

**Live state (authoritative) — all verified:**
- embeddings StatefulSet `limits.memory` = **12Gi** (FEAT-001 bump confirmed took).
- reranker Deployment `limits.memory` = **12Gi**, applied as a VALUE-ONLY patch; readiness probe is the live HTTP `httpGet /v2/health/ready` (NOT the committed `/v3/rerank` exec script); restarts=0, no OOMKill. gen=6/observed=6, spec.replicas=1.
- `OMNIROUTE_MEMORY_MB` = **12288** (kubectl set env); omniroute app pod 1/1, restarts=0, rollout successful.
- No Pending/OOMKilled pods; qdrant untouched (gen=1, uid a2c81b89); gremlin-2 at 57% mem-limits / 13% requests, ample headroom.

**Declarative-file reconcile (remote host, fresh timestamped `.bak` each):**
- `~/sources/kube/omniroute-memory/ovms-reranker-deployment.yaml`: `10Gi -> 12Gi` + ceiling-formula comment replaced with the +50%/12Gi directive rationale (bak `...bak-feat004-mem12gi-20261009T201835Z`). NOT applied live (value-only patch already in place; the committed manifest would swap in the `/v3/rerank` exec probe that 404s live). kubectl client dry-run parses clean.
- `~/sources/kube/omniroute-memory/LIVE-VERIFICATION.md`: stale "Pod memory limit: now 10Gi …" summary line updated to the 12Gi/+50% rationale incl. `OMNIROUTE_MEMORY_MB=12288` (bak `...bak-feat004-mem12gi-20261009T201835Z`).
- `~/sources/kube/omniroute/omniroute.yaml`: `OMNIROUTE_MEMORY_MB 8192 -> 12288` reconciled in-file (bak `...bak-memorymb-12288-20261009T201901Z`). The live kubectl value is authoritative regardless.

**AC note — "reranker stays 1/1" is NOT APPLICABLE (user decision: Option A).** The reranker was ALREADY `0/1` before this step and stayed `0/1`, for the PRE-EXISTING, explicitly out-of-scope `/v3/rerank` OVMS mediapipe graph-load hang (`/v1/config` returns `{}`, `/v2/health/ready` 503 for 35+ min). This change neither caused it nor touched the probe — evidence: restarts=0, no OOMKill, empty lastState, probe unchanged (HTTP `/v2/health/ready`), and the 12Gi limit + env were already live before this step began. Not pulling the reranker fix into FEAT-004 (scope creep on a live service).

**Bookkeeping / follow-ups for the user:**
1. **omniroute.yaml ownership changed root -> celes** as a side effect of the in-file rewrite (the dir was writable, so the reconcile created a new inode owned by celes; passwordless sudo was unavailable). If the original root ownership was intentional, restore it with `sudo chown root:root ~/sources/kube/omniroute/omniroute.yaml`. NOT done here (no sudo; re-touching could compound drift). The `.bak` files are retained as the record.
2. **reranker 0/1** — the `/v3/rerank` 404 / OVMS mediapipe graph-load hang remains a SEPARATE, already-identified out-of-scope follow-up, alongside D (GPU driver/firmware fix). Not fixed here.

## Rollback notes
- Re-scale `ovms-embeddings` StatefulSet > 0 to restore the kube/VF path (not recommended — it wedges).
- Remove the shared NixOS module import from `common.nix` + rebuild to stop the host-native services.
- Restore the `ovms-embeddings` Service selector/targetPort and delete the proxy to revert routing (backups in `~/feat001-bak/` on the k3s host).
- All remote manifest/`/etc/nixos` edits kept `.bak` copies.
