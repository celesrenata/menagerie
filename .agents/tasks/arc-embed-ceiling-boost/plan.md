# Implementation Plan — arc-embed ceiling + memory boost (LIVE k3s cluster)

Applies the APPROVED design at `design.md` to the LIVE cluster over SSH. ALL cluster changes are
on the remote host `esnixi` via `ssh -o BatchMode=yes celes@192.168.42.254` — NOT this workspace's
git repo. The local workspace copy under `sources/kube/omniroute-memory/` is STALE and is synced
only AFTER each remote change is live and verified.

## Environment facts verified this session (grounding — re-verify per design F7 before mutating)

- SSH `celes@192.168.42.254` (host `esnixi`, k3s) works with `BatchMode=yes`.
- Live outage CONFIRMED: all four `ovms-embeddings-{0..3}` are `0/1 Running` with climbing restarts.
- `kubectl auth can-i` = **yes** for: patch `deployments` (ns `omniroute`), patch `statefulsets`
  and create `configmaps` (ns `omniroute-memory`). So live cluster mutations need NO sudo.
- Live embeddings memory limit = **8Gi**; reranker = **8Gi**; `OMNIROUTE_MEMORY_MB = 8192`.
- `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` is **NOT set** on the omniroute deploy (default 4096).
- Live embeddings readiness probe = inline `curl -sf -m 2 -X POST http://localhost:8000/v1/embeddings
  ... "ping"`, `timeoutSeconds:3 periodSeconds:5 failureThreshold:3 initialDelaySeconds:15`.
- Live model-pull args already include `--truncate=true --max_length=4096`.
- `ovms-readiness-scripts` ConfigMap is **NotFound** in the cluster.
- Reranker live readiness probe = tolerant HTTP `/v2/health/ready` (do NOT clobber).
- StatefulSet `updateStrategy.rollingUpdate.partition = 0`, `podManagementPolicy = Parallel`
  (immutable — single-replica rolls use the **partition**, not OrderedReady).
- Both `/v1/embeddings` and `/v3/embeddings` endpoints exist on the pod (returned HTTP 412 on the
  broken pod-0 this session; 412 = serving path not ready). The design's live probe uses `/v1`;
  the committed `embed-probe.sh` uses `/v3`. The script must be reconciled to the endpoint that
  actually serves a 1024-dim vector on a HEALTHY replica (verify at implement time, step 1).
- **BLOCKER for the OmniRoute manifest FILE edit:** remote `~/sources/kube/omniroute/omniroute.yaml`
  is **root-owned** and passwordless `sudo` is **NOT** available for `celes`. The `.bak` copy and
  the live `kubectl patch` both work without sudo (the dir is writable; patch needs no file write),
  but overwriting `omniroute.yaml` in place requires sudo. The live env change is applied via
  `kubectl patch`/`set env`; reconciling the on-disk `omniroute.yaml` file is attempted via a
  writable temp + `sudo tee`/`mv`, and if sudo is unavailable the file reconcile is reported to the
  user to finish manually (the live patch is the source of truth either way).

## Ordering rationale

Strict dependency order, one surface at a time with live verification between each, per the user's
recorded precedence: **(1) serving-path + readiness outage FIRST and independently**, then (2) model
id, then (3) context ceiling (gated on #1 healthy + a measured 8192 sweep), then (4) memory. qdrant
is never touched. The local workspace sync is last, after the live state is proven.

---

- [ ] 1. **RC1 — restore embedding availability (readiness/serving outage), single-replica-first.**
      Re-run the design F7 checklist first (capture live mem limit, probe shape, graph `max_length`,
      ConfigMap presence, qdrant revision, and a fresh per-replica ping). Create the missing
      `ovms-readiness-scripts` ConfigMap, reconciling `embed-probe.sh` to the endpoint that serves a
      1024-dim vector on a healthy replica (verify `/v1` vs `/v3` live; the live inline probe uses
      `/v1`). Set `rollingUpdate.partition=3` so ONLY the highest-ordinal pod rolls, then apply the
      reconciled StatefulSet carrying the gentler script probe (`timeoutSeconds:5 failureThreshold:4
      periodSeconds:15`) AND `memory: 12Gi` (RC4 embeddings bump folded in here; model-pull stays
      `--max_length=4096` for this step). Watch `ovms-embeddings-3` for a bounded 10-min window; if
      it holds READY, lower the partition stepwise 2→1→0. If a rolled pod does NOT recover
      (wedge/RET_CHECK persists), STOP before rolling the rest and run the single-pod CPU canary
      (`target_device: CPU` via the partitioned roll) to localize GPU-vs-CPU; a device change must be
      proposed to the user before applying. On any pod failing to reach READY in its window,
      `kubectl -n omniroute-memory rollout undo statefulset ovms-embeddings` and restore the partition.
      Files (remote): `~/sources/kube/omniroute-memory/ovms-readiness-scripts-configmap.yaml`,
      `~/sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml`.
      Verify: `kubectl -n omniroute-memory get pods -l app=ovms-embeddings -w` shows ≥3/4 READY held
      ≥10 min with no climbing restarts and zero `Unhealthy` events; public `POST /v1/embeddings`
      with `arc-embed/qwen3-embedding-0.6b` returns HTTP 200 + 1024-dim across 20 consecutive calls
      with no `fetch failed`. (Design AC1, AC2, AC3.) Reset partition to 0 after full success.

- [ ] 2. **RC2 — correct the wrong model id `qwen3-embedded` → `qwen3-embedding-0.6b`.**
      Grep the OmniRoute provider/model config and any in-repo client config for `qwen3-embedded`
      to identify the emitter; correct the source id. Only if the caller set is unknown/unowned,
      fall back to an OmniRoute alias mapping `qwen3-embedded` → the real graph (prefer correcting
      the source over perpetuating a wrong name). Keep the `.bak` convention before any file edit on
      the remote host.
      Files (remote): whichever config references the id (identified by grep); possibly the OmniRoute
      model/provider config.
      Verify: public API call with `arc-embed/qwen3-embedding-0.6b` returns 200 + 1024-dim; a call
      with `arc-embed/qwen3-embedded` either resolves (if aliased) or no known caller emits it
      (confirmed by grep). (Design AC4.)

- [ ] 3. **RC3 — raise the context ceiling to 8192 across BOTH layers, HARD-GATED on a measured sweep.**
      Only after step 1 is healthy. Regenerate the OVMS graph to `max_length: 8192` on ONE replica
      via the partitioned roll using the non-destructive `ovms --configure … --max_length 8192` (no
      PVC wipe); update the model-pull initContainer args to `--max_length=8192` and use the
      `--configure`/`--overwrite_models` path so a fresh pod regenerates the graph. Run a token sweep
      up to ~8192 tokens against that replica. PASS = an ~8192-token input returns HTTP 200 within
      budget (treat >60 s as FAIL, since 4096 already costs ~32 s). On PASS: set
      `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS=8192` on the omniroute deploy to MATCH, then roll
      the rest. On FAIL: step down by powers of two (8192→6144→4096), set BOTH layers to the largest
      proven value, and `send_message` (warning) escalating the 8192 gap to the user — never silently
      downgrade. Leave `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` at its `auto` default. Both layers MUST
      always carry the SAME number.
      Files (remote): `~/sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml` (model-pull
      `--max_length`), live omniroute deploy env (via `kubectl set env`/`patch`), and — for the file
      reconcile of the env — `~/sources/kube/omniroute/omniroute.yaml` behind a fresh `.bak`
      (needs sudo; see BLOCKER note).
      Verify: `kubectl -n omniroute-memory exec <healthy-pod> -c ovms -- grep max_length
      graph.pbtxt` reads `8192` (or the proven fallback); an input AT the configured ceiling returns
      200 within budget; an input ABOVE it is handled per `auto` (external caller → HTTP 400 naming
      the item); `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` equals the graph `max_length`.
      (Design AC5, F2 gate, F4 mechanism.)

- [ ] 4. **RC4 — raise memory limits +50% off the live 8Gi/8192 base.**
      Embeddings container `limits.memory` 8Gi→12Gi is applied as part of step 1's StatefulSet
      reconcile (verify it took). Reranker: apply a VALUE-ONLY live patch
      `kubectl -n omniroute-memory patch deploy ovms-reranker --type=json -p
      '[{"op":"replace","path":"/spec/template/spec/containers/0/resources/limits/memory","value":"12Gi"}]'`
      — do NOT apply the committed reranker manifest (its `/v3/rerank` script probe 404s live and
      would drop it from rotation; preserve the live HTTP probe). Set `OMNIROUTE_MEMORY_MB`
      8192→12288 on the omniroute deploy (via `kubectl set env`/`patch`). Replace the stale ceiling-
      formula sizing comments with the +50%/12Gi directive rationale in the manifests + `LIVE-VERIFICATION.md`.
      Files (remote): `~/sources/kube/omniroute-memory/ovms-reranker-deployment.yaml` (declarative
      record only), live `ovms-reranker` Deployment (value patch), live `omniroute` Deployment
      (`OMNIROUTE_MEMORY_MB`), `~/sources/kube/omniroute/omniroute.yaml` behind `.bak` (sudo caveat).
      Verify: `kubectl -n omniroute-memory get sts ovms-embeddings deploy/ovms-reranker -o
      jsonpath='{..resources.limits.memory}'` → 12Gi for both; `OMNIROUTE_MEMORY_MB=12288`;
      reranker stays 1/1 throughout; `kubectl describe node` shows headroom (24Gi limits/node ≪ ~94GiB);
      no new Exit 137/OOMKill, no Pending pods. (Design AC6, F3, F8.)

- [ ] 5. **Sync the STALE local workspace copy to match the now-live, verified state.**
      After the remote changes are live and verified, update the local workspace manifests to match:
      embeddings/reranker `memory: 12Gi`, the reconciled probe + `--max_length=8192` (or proven
      fallback), the `embed-probe.sh` endpoint reconciliation, and the +50%/12Gi comment rationale;
      and record the OmniRoute env changes (`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`,
      `OMNIROUTE_MEMORY_MB`) where the workspace tracks them. Do NOT touch qdrant.
      Files (local): `sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml`,
      `sources/kube/omniroute-memory/ovms-reranker-deployment.yaml`,
      `sources/kube/omniroute-memory/ovms-readiness-scripts-configmap.yaml`,
      `sources/kube/omniroute-memory/LIVE-VERIFICATION.md`.
      Verify: local manifests diff-match the live `kubectl get -o yaml` for the fields this task
      changed (memory, probe, max_length); `git status` shows only intended files changed; qdrant
      manifests untouched. (Design AC7.)

## Qdrant / safety guardrails (apply to every step)

- NEVER touch the qdrant StatefulSet. Capture its revision before and after (design F7 item 8) and
  confirm it is unchanged.
- Keep the `.bak` convention on the remote host before editing any manifest file (established
  pattern: `omniroute.yaml.bak-<desc>-<UTC>`), especially `omniroute.yaml`.
- Roll one surface at a time; verify health between steps; use the partition for single-replica rolls.
- Any device-level change (CPU canary) or any sub-8192 ceiling fallback must be escalated to the
  user before/after as specified, not applied silently.
