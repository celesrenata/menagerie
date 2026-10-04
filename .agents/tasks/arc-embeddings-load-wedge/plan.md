# Arc Embeddings — Uneven Load + Rotating Wedge: Diagnosis & Implementation Plan

_Live read-only diagnosis run from the workflow shell + read-only SSH to gremlin-1..4 + OmniRoute management API. Nothing was changed on the cluster, nodes, or OmniRoute in this step._

Supersedes/updates the earlier `/Users/celes/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md` with the state **after** the probes were tightened (git `6e9fcb8`) and the ComfyUI Intel-Arc workers were retired to 0 (git `21120d0`).

---

## DIAGNOSIS (answer first, with evidence)

### Fix 1 — Uneven load: **CONFIRMED connection pinning** (fixable here, least-invasive)

OmniRoute proxies embeddings to the **ClusterIP** `ovms-embeddings` (`10.43.56.117:8000`) and holds a small pool of **persistent HTTP keepalive connections**. kube-proxy load-balances **per connection, not per request**, so each long-lived connection is pinned to whichever backend pod it first landed on. A pool of N connections therefore pins all load onto N backends.

Evidence:

- The OmniRoute pod (`omniroute-57ddb94cf-xcsld`, on gremlin-4, pod IP `10.42.0.227`) holds **exactly 4 ESTABLISHED connections** to `10.43.56.117:8000`, read from `/proc/net/tcp` inside the pod netns (port `1F40` = 8000):
    ```
          4 10.43.56.117
    ```
    These are DNAT'd to backend pods at connect time and stay pinned for the connection's lifetime.
- Host-level `conntrack -L` on gremlin-4 did not surface the per-pod flows (flannel VXLAN + DNAT inside the pod netns hides them from the host table; `nf_conntrack` is loaded, `nf_conntrack_count`≈16065), which is why the earlier `conntrack | grep dport=8000` returned empty. The pod-netns `/proc/net/tcp` read is the authoritative evidence and it confirms the pinned keepalive pool.
- Live skew matches: at snapshot the Service endpoints held only **2 of 4** pods (`10.42.1.238`, `10.42.3.181`), and CPU was lopsided (e.g. `888m / 15m / 378m / 12m` across replicas) — consistent with a handful of pinned connections rather than per-request spread.

No OmniRoute setting or provider-node field exists for upstream keepalive / connections-per-host / idle-timeout. `GET /api/settings` has retry/affinity knobs (`requestRetry:3`, `stickyRoundRobinLimit:3`, `idempotencyWindowMs:5000`, `timeoutMs:120000`) but **nothing** for upstream connection reuse. The provider-node schema (`GET /api/provider-nodes`) for both prefixes exposes only `baseUrl`, `apiType`, `chatPath`, `modelsPath`, **`customHeaders`** (currently `null`), `prefix`. So the one usable lever is **`customHeaders` → inject `Connection: close`** on the upstream request to defeat keepalive and force a fresh per-request balancing decision. Do NOT add Service `sessionAffinity` (it pins harder — explicitly ruled out).

Provider nodes confirmed:

- `ovms-arc` (id `openai-compatible-embeddings-8a59c128-2c08-45bb-8aae-554a2440bd00`) → `http://ovms-embeddings.omniroute-memory.svc.cluster.local:8000/v1` — the prefix the Zoo editor indexing uses.
- `arc-embed` (id `openai-compatible-embeddings-1710a12f-6af6-4052-8f0b-a3c17175dabb`) → same host `:8000/v3`.

### Fix 2 — Rotating wedge: **GPU i915 fence-expiration stall (DRIVER-LEVEL)** — NOT a probe false-flap, NOT the stale memirq

This is the critical correction to the symptom brief. Re-diagnosis shows the wedge is a **genuine GPU serving-path stall**, and its root cause is **driver-level**, which triggers the HARD CONSTRAINT (out-of-scope reboot/GuC/driver phase).

Evidence that it is a GENUINE wedge, not a probe being too aggressive:

- A wedged pod **cannot answer a trivial `ping` embedding even with a 30-second timeout**: `pod1: 000/30.002s (curl exit 28)`, `pod3: 000/30.002s`, while sibling pods answer in **20–40 ms** (`pod0: 200/0.038s`, `pod2: 200/0.023s`) at the same instant. No readiness-timeout tuning (3s→5s, failureThreshold 3→5) can rescue a pod that cannot respond in 30 s — and readiness SHOULD eject such a pod. So the probe is correctly reporting a real failure, not false-flapping a healthy pod.
- The wedge is **near-idle on CPU** when stalled (e.g. pod1 at `15m` CPU timing out at 6s) — rules out CPU saturation / batch-pressure competition for a worker thread as the cause.
- The wedge **rotates one pod at a time** across nodes; each cycle: liveness `/v2/health/live` times out (`context deadline exceeded`) → container killed/restarted → serves fast briefly on the new PID → wedges again on some node. `errno=107 FATAL sockets::shutdownWrite` lines in OVMS (e.g. pod0 `00:09:45`, pod3 `00:04:44`/`00:05:09` UTC) are the **symptom** (peer RST while OVMS is blocked mid-response), not the cause.

Root cause — i915 **fence expiration timeouts** on the SR-IOV VF, actively generated under load on **all four nodes** (cluster node clock is PDT; `17:xx PDT` = pod logs' `00:xx UTC`):

```
gremlin-1: Fence expiration time out i915-0000:00:02.4:ovms[811981]:...   last 17:14:44  (now 17:17:42)
gremlin-2: Fence expiration time out i915-0000:00:02.4:ovms[2361972]:...  last 17:16:39  (now 17:17:43)
gremlin-3: Fence expiration time out i915-0000:00:02.4:ovms[2333639]:...  last 17:14:10
gremlin-4: Fence expiration time out i915-0000:00:02.6:ovms[2783620]:...  last 17:11:46
```

A GPU submission from OVMS never signals its completion fence → the OVMS inference thread blocks indefinitely on that fence → the pod wedges until killed. This is the classic Intel Arc **GuC-submission / SR-IOV VF** stall (`enable_guc=3`, patched `i915-sriov-dkms`). Eliminating it requires a GuC/driver change and node reboots.

On the memirq question from the brief: **memirq is NOT the active flood anymore.** Last memirq entries are frozen (gremlin-1 `17:14:44`, gremlin-3 `17:14:10`) ~40–90 s before "now", and the count did not advance across a 20 s sampling window under load (`2974→2974`, `2972→2972`); the earlier `2976→2974` drift is dmesg ring-buffer rotation, not new events. GuC mode confirmed `enable_guc=3`; no `GPU HANG` / `engine reset` / `FLR` events. So the active, current driver signature is **fence expiration**, not memirq.

### Hard-constraint determination

The remaining cause of the rotating wedge is **driver-level** (i915 GuC/VF fence expiration), fixable only via the node-reboot Phase B (GuC `enable_guc=3→1` tuning or `strongtz/i915-sriov-dkms` bump, one-node-at-a-time on `root@gremlin-1:/etc/nixos` branch `dev`). **Reboots / NixOS / VF / GuC / i915 changes are OUT OF SCOPE here.** A `send_message` warning was raised so the user decides on Phase B. This plan therefore implements Fix 1 fully and only the **non-reboot partial mitigations** for Fix 2 (reduce user-visible impact; do not claim to eliminate the wedge).

### Repo / source-of-truth

Manifests are a real git repo at `/Users/celes/sources/kube` (`omniroute-memory/ovms-embeddings-statefulset.yaml` and the two Services). Commit changes there, do **not** push. OmniRoute provider-node config is runtime state changed via the management API (and should be noted in the repo for reproducibility).

---

## IMPLEMENTATION PLAN (ordered by dependency; each item leaves things working and is independently verifiable)

Preconditions for every item: `kubectl` works from the workflow shell; management key at `/run/secrets/omniroute_management_api_key`; OmniRoute at `https://omniroute.celestium.life`. Do not push git. Do not reboot nodes or touch NixOS/VF/GuC/i915.

- [ ]   1. **Capture current OmniRoute provider-node + settings state (rollback baseline).**
       Save the two provider-node JSON objects (`ovms-arc` id `...8a59c128...`, `arc-embed` id `...1710a12f...`) and the relevant `/api/settings` fields to a file in the repo so the config change is reproducible and reversible.
       Files: `/Users/celes/sources/kube/omniroute-memory/omniroute-provider-nodes.baseline.json` (new).
       Verify: `cat` the file and confirm both nodes present with their current `baseUrl` and `customHeaders: null`; `curl -sk -H "Authorization: Bearer $MGMT" https://omniroute.celestium.life/api/provider-nodes` round-trips without error.

- [ ]   2. **Fix 1 — defeat upstream keepalive pinning via `customHeaders: {"Connection":"close"}` on the `ovms-arc` provider node (the prefix the editor uses).**
       PATCH/PUT the `ovms-arc` node (id `openai-compatible-embeddings-8a59c128-2c08-45bb-8aae-554a2440bd00`) via the management API to set `customHeaders` to `{"Connection":"close"}`, leaving `baseUrl`/`apiType` unchanged. This forces OmniRoute's HTTP client to open a fresh upstream connection per request, so each request gets re-balanced by kube-proxy across all ready endpoints instead of being pinned to the ~4 persistent connections. Discover the exact write verb/route first (try `PATCH /api/provider-nodes/<id>`, else the node-create/update route used by the UI); if the API rejects an unknown header-reuse semantic, fall back to a per-request header the editor can send, and document that. Do NOT touch `arc-embed` yet (change one prefix, measure, then mirror).
       Files: OmniRoute runtime config (management API); record the applied change in `/Users/celes/sources/kube/omniroute-memory/omniroute-provider-nodes.baseline.json` as an "after" note.
       Verify: re-GET the node and confirm `customHeaders` now contains `Connection: close`. Then under a sustained embedding burst against `ovms-arc/qwen3-embedding-0.6b`, confirm the OmniRoute pod no longer holds a tiny fixed pool to one or two backends: `kubectl -n omniroute exec <omniroute-pod> -- sh -c 'cat /proc/net/tcp /proc/net/tcp6' | awk 'NR>1{print $3}' | awk -F: '$2=="1F40"'` should show connections churning (short-lived) rather than 4 stable long-lived ones, and `kubectl -n omniroute-memory top pods -l app=ovms-embeddings` should show load spread across all **ready** replicas (goal: all ready replicas carry traffic, not perfect balance). Confirm Qdrant points keep growing (indexing still works): point count on `10.1.1.12:6333` increases.

- [ ]   3. **Fix 1 — mirror the change to the `arc-embed` (`/v3`) provider node once step 2 is validated.**
       Apply the same `customHeaders: {"Connection":"close"}` to id `openai-compatible-embeddings-1710a12f-6af6-4052-8f0b-a3c17175dabb` so both embedding prefixes benefit. Keep it a separate step so step 2 can be measured in isolation.
       Files: OmniRoute runtime config; update the baseline JSON "after" note.
       Verify: re-GET the node confirms the header; a burst via `arc-embed/qwen3-embedding-0.6b` spreads across ready replicas as in step 2.

- [ ]   4. **Fix 2 (partial, non-reboot) — lower the OmniRoute per-request embedding timeout + keep retry so a wedged replica is retried fast on a healthy sibling. GOAL: the wedge becomes fully INVISIBLE to clients.**
       The wedge itself is driver-level (out of scope), but with step 2's `Connection: close` (every request is a fresh connection) + OmniRoute's existing `requestRetry:3`, a request that lands on a wedged/not-ready replica should transparently retry onto a healthy one well within the client's tolerance. Lower the embedding request timeout well below the current `timeoutMs:120000` via the settings/management API — target **10–15 s** per attempt — if a per-route/embedding timeout knob exists; otherwise document the global `timeoutMs` tradeoff and set the smallest safe value that still allows legitimate large batches. The combined budget (per-attempt timeout × retries) must stay inside the Zoo editor's indexing tolerance so a retry completes before the client errors. Note: readiness (step 5) ejects a wedged pod from the Service endpoints in ~15 s, so after that window retries won't even be routed to the wedged pod; the fast per-request timeout covers the brief window before ejection.
       Files: OmniRoute runtime config (management API); record the chosen value + rationale in the baseline JSON file and in `verification.md`.
       Verify (EXPLICIT invisibility test): with one replica deliberately wedged (confirmed via the 30 s-ping test timing out), drive **Zoo-style 60-item embedding batches** against `ovms-arc/qwen3-embedding-0.6b` under sustained load and confirm **0 client-visible errors** — every batch succeeds (via retry on a healthy replica) within the client's tolerance, no 300 000 ms / fetch-timeout errors in OmniRoute logs, and Qdrant point count on `10.1.1.12:6333` keeps climbing throughout. Record the batch count, success rate (must be 100%), and max observed latency in `verification.md`.

- [ ]   5. **Fix 2 (partial, non-reboot) — soften liveness to stop the SIGKILL restart storm WITHOUT disabling it, keep readiness fast-ejecting a dead socket.**
       In `ovms-embeddings-statefulset.yaml`: readiness is a full `/v1/embeddings` POST (`curl -sf -m 2`, probe `timeoutSeconds:3, periodSeconds:5, failureThreshold:3`) → ejects a wedged pod from the Service in ~15 s (keep this fast-ejection property unchanged — do NOT loosen readiness; a 30-s-unresponsive pod MUST leave the LB fast). The problem is **liveness** (`/v2/health/live` httpGet, `timeoutSeconds:3, periodSeconds:15, failureThreshold:3` → kills after ~45 s) SIGKILLs on every transient fence stall, causing the restart churn. Soften it but keep it functional so a GENUINELY dead pod still restarts: set liveness **`failureThreshold: 3→6`** and **`timeoutSeconds: 3→5`**, keep `periodSeconds:15` and `initialDelaySeconds:120`. New liveness kill budget ≈ `periodSeconds 15 × failureThreshold 6 = ~90 s` continuously unresponsive before restart — long enough that a transient fence-timeout wedge (which readiness already ejected at ~15 s, and which often self-clears or gets retried-around) does not trigger a kill, but short enough that a pod wedged hard for ~90 s is still restarted. Document these exact values and the budget math in `verification.md`. Keep `replicas: 4`, the per-replica Longhorn RWO PVCs, and the digest-pinned image unchanged.
       Files: `/Users/celes/sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml`.
       Verify: `kubectl -n omniroute-memory diff -f omniroute-memory/ovms-embeddings-statefulset.yaml` shows ONLY the two liveness field changes (clean diff, no incidental drift); `kubectl apply -f ...` then `kubectl -n omniroute-memory rollout status statefulset/ovms-embeddings`. Under load confirm: (a) a wedged pod still leaves `kubectl -n omniroute-memory get endpoints ovms-embeddings` within ~15 s (readiness unchanged), (b) restart counts climb **substantially slower** than the pre-change baseline (liveness no longer kills on every transient wedge), (c) a pod wedged continuously for >90 s DOES still get restarted (liveness not disabled), (d) `ovms-reranker`/other GPU pods unaffected.

- [ ]   6. **Commit the declarative changes locally to `~/sources/kube` (do NOT push).**
       Stage only the touched files (`omniroute-memory/ovms-embeddings-statefulset.yaml`, `omniroute-memory/omniroute-provider-nodes.baseline.json`). Follow repo convention; do NOT create `.changeset` files or edit any CHANGELOG (per workspace AGENTS.md). Commit message e.g. `fix(arc-embeddings): defeat OmniRoute keepalive pinning + soften liveness restart churn`.
       Files: git repo `/Users/celes/sources/kube`.
       Verify: `cd /Users/celes/sources/kube && git status` shows only the intended files committed and the StatefulSet still has `replicas: 4`, the digest-pinned image, and the volumeClaimTemplate intact (`git show HEAD:omniroute-memory/ovms-embeddings-statefulset.yaml | grep -E 'replicas:|sha256:|storageClassName'`); `git log --oneline -1` shows the new commit; no push occurred (branch is ahead of origin).

- [ ]   7. **Write `verification.md` and record Phase B as the outstanding root-cause fix (no implementation).**
       Create `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/arc-embeddings-load-wedge/verification.md` capturing: the before/after connection-distribution evidence (step 2), the chosen OmniRoute per-request embedding timeout value + rationale (step 4), the invisibility test results (60-item batch, 100% success while a replica wedged — step 4 verify), the exact liveness probe values + budget math (step 5), and the clean `kubectl diff` / commit confirmation (step 6). Then record the **Phase B (OUT OF SCOPE — user will schedule separately)** note: the fence-expiration root cause remains, fixable only via reboots — GuC `enable_guc=3→1` tuning in `modules/i915-sriov.nix` OR a `strongtz/i915-sriov-dkms` bump for the Meteor Lake fence/memirq fix — rolled one node at a time on `root@gremlin-1:/etc/nixos` branch `dev`, **never rebooting gremlin-2/3/4 together** (k3s quorum), **no live VF rebind** (previously caused `-ENXIO` PTE corruption). Documentation only — do not reboot, edit NixOS, or change VFs/GuC/i915 in this workflow.
       Files: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/arc-embeddings-load-wedge/verification.md` (new).
       Verify: the file exists, contains the invisibility-test result and probe values, and clearly states Phase B requires reboots and is out of scope / to be scheduled separately by the user.

---

## Expected outcome

- Fix 1 (steps 1–3): load spreads across **all 4 ready** replicas (modest, not perfect balance) because OmniRoute stops reusing a tiny pinned keepalive pool. Fully achievable in this task.
- Fix 2 (steps 4–5): the rotating wedge is **not eliminated** (its cause is driver-level and out of scope), but it becomes **invisible to clients** — `Connection: close` + a fast per-request embedding timeout + `requestRetry:3` transparently retry a request that lands on a wedged replica onto a healthy sibling within the client's tolerance, and readiness ejects the wedged pod from the LB in ~15 s while softened-but-live liveness stops the SIGKILL restart storm (a genuinely dead pod still restarts at ~90 s). Target: Zoo-style 60-item indexing batches succeed with **0 client-visible errors** even while one replica is wedged. Full root-cause elimination awaits the user-scheduled reboot Phase B.

## Open assumptions / gaps

- The exact OmniRoute management write route for `customHeaders` and any embedding-specific timeout knob must be confirmed at implementation time (the UI uses some PATCH/PUT; the GET routes are confirmed). If `Connection: close` is not honored by OmniRoute's upstream HTTP client, the realistic fallback is: accept the per-request header via the client, or document that only the probe/retry mitigations (steps 4–5) are available and the pinning is inherent to the proxy's connection reuse — recommend an OmniRoute feature request for a connections-per-host / keepalive-disable knob.
