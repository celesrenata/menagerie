# Design review — arc-embed/qwen3 embedding ceiling + memory boost (iteration 2)

Reviewer: design-review subagent (fresh context, independent live verification)
Date: 2026-10-09
Design under review: `.agents/tasks/arc-embed-ceiling-boost/design.md` (revision "iteration 2")
Context: `.agents/tasks/arc-embed-ceiling-boost/findings.md`
Prior review: `design-review.json` iteration 1 (2 HIGH, 4 MEDIUM, 2 NIT)

This design drives changes to a LIVE shared k3s cluster, so I did not take the design's
word for its live claims. I re-verified the decisive facts directly over
`ssh celes@192.168.42.254` (kubectl) and by grepping the running OmniRoute image. The
findings below separate what I confirmed from what I could not.

---

## Verdict summary

The iteration-2 design resolves all six HIGH/MEDIUM findings from iteration 1, and every
high-risk factual claim I could reach is independently confirmed against the live cluster
and the running image. The remaining issues are NITs (internal wording inconsistency and a
residual-risk acknowledgement), none of which force an operator to guess at the live
cluster. Verdict: **APPROVED** (0 HIGH, 0 MEDIUM).

---

## What I independently verified this session (live)

All of the following were read directly from the cluster / image, not taken from the design:

1. **Memory limits** — `kubectl -n omniroute-memory get sts ovms-embeddings -o jsonpath='{..resources.limits.memory}'` → **8Gi**; reranker Deployment → **8Gi**. Matches the design's "live is 8Gi" correction to findings.md (which said 10Gi). ✓
2. **Embeddings readiness probe** — live is the inline `exec curl -sf -m 2 ... '{"model":"qwen3-embedding-0.6b","input":"ping"}'`, `timeoutSeconds: 3`, `periodSeconds: 5`, `failureThreshold: 3`, `initialDelaySeconds: 15`. Exactly as the design states (and NOT the committed `/opt/readiness/embed-probe.sh` script probe). ✓
3. **Reranker readiness probe** — live is HTTP `httpGet /v2/health/ready`, `timeoutSeconds: 1`, `failureThreshold: 60`, `periodSeconds: 10`. Matches the design's F8 claim that the live probe is HTTP and tolerant (so a value-only patch must preserve it). ✓
4. **ConfigMap** — `kubectl -n omniroute-memory get cm ovms-readiness-scripts` → `NotFound`. Matches the design's claim that the script probe cannot be applied until the ConfigMap is created. ✓
5. **`podManagementPolicy`** → `Parallel`; `updateStrategy` → `RollingUpdate` with `rollingUpdate.partition: 0`. This confirms both that the partition mechanism the design chose is available AND that `podManagementPolicy` is what it is (the design correctly avoids proposing to flip it to OrderedReady). ✓
6. **Graph `max_length`** — `cat graph.pbtxt` on all four pods (0–3) → `max_length: 4096`. Confirms the real ceiling is 4096 today on every replica (so re-export to 8192 is genuinely required, matching Decision (b)). ✓
7. **`OMNIROUTE_MEMORY_MB`** on the omniroute deployment → `8192`. Matches the design's +50%→12288 target base. ✓
8. **OmniRoute embedding env var names** — grep of `/app` in pod `omniroute-8695cd8cb8-9pzwn` returns exactly the five vars the design lists, including the ceiling knob **`OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`**. There is no `OMNIROUTE_EMBEDDING_ITEM_MAX_TOKENS` (the name findings.md speculated). ✓
9. **Overflow enum + default** — `ENVIRONMENT.md` in the running image states `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` default **`auto`**, with the exact behavior the design quotes (`auto`: internal callers truncated-to-cap + warning, external callers HTTP 400; `truncate`/`reject` apply one behavior to all). This confirms the F5 correction of iteration 1's wrong `error|truncate`. ✓ Also confirms `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` default `4096` and the two handler file paths (`embeddings.ts`, `embeddingBatchSplit.ts`). ✓
10. **PVC access mode** — `volumeClaimTemplates` accessModes → `ReadWriteOnce` (one PVC per ordinal). This supports the design's reasoning that the graph must be regenerated per-replica and that updating the model-pull init args makes each fresh pod regenerate. ✓
11. **Committed vs live model-pull args** — the committed `ovms-embeddings-statefulset.yaml` model-pull initContainer (lines 105–116) has **no `--max_length` and no `--truncate`**, while live has `--max_length=4096 --truncate=true`. Confirms the live-vs-committed divergence table and the F4 instruction that the implementer must add `--max_length=8192`. ✓
12. **Committed memory formula comment** — `ovms-embeddings-statefulset.yaml` lines 71–75 carry `memory: 10Gi` with the comment "base 8Gi + ceil(8192/4096) = 10Gi … Raising the ceiling raises this in tandem"; reranker committed is 10Gi. Confirms the F3 conflict the design resolves. ✓

Every single live claim the design makes that I could reach checked out. That is a strong
signal the design was authored against the real cluster, not guessed.

---

## Resolution of the five mandatory scrutiny points

1. **Is the readiness-probe/outage root cause actually diagnosed, not guessed?**
   Mostly yes, and honestly bounded. The design pins the *mechanism* with per-replica
   evidence: a healthy replica serves a 1-token ping in 0.265 s while others are wedged
   (>35 s) or hard-fail with `RET_CHECK ...embeddings_calculator_ov.cc:382`, and the `-m 2`
   probe evicts them. I confirmed all four pods are `0/1` and churning restarts, consistent
   with that mechanism. The design is explicit that the *underlying* cause of the wedge is
   still one of three hypotheses (GPU plugin thrash / i915-GuC incompatibility / OOM during
   long inference) and sequences a `target_device: CPU` canary to decide between them before
   widening blast radius. That is the correct posture for a design: the failure mode is
   diagnosed, the fix is gated on a decisive canary rather than a guess. Not a blocking gap.

2. **Is the exact OmniRoute per-item ceiling env var confirmed, not invented?**
   Yes. Independently confirmed from the running image: `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS`
   (default 4096), plus the four siblings. The design explicitly rejects the speculated
   `OMNIROUTE_EMBEDDING_ITEM_MAX_TOKENS`.

3. **Is the real achievable OVMS graph ceiling stated with evidence?**
   Yes. The design states the real achievable ceiling TODAY is exactly **4096 tokens**
   (graph `max_length`, which I confirmed is 4096 on all pods), backed by a measured sweep
   (4000 w → 200 at ~32 s; 6000 w → HTTP 400 `Input length 6002 longer than allowed 4096`,
   i.e. `truncate:true` does NOT clip). **8192 is explicitly marked UNPROVEN and HARD-GATED**
   on a post-fix sweep (RC3/F2) with a pass/fail budget (>60 s = FAIL), a power-of-two
   step-down fallback, and mandatory user escalation on shortfall. This is exactly the
   treatment the live-cluster risk demands.

4. **Are the memory-limit targets unambiguous and matching the user's recorded decision?**
   Yes. 8Gi→12Gi on both OVMS containers, `OMNIROUTE_MEMORY_MB` 8192→12288, computed off the
   live 8Gi/8192 base — matching the recorded Decision (a) verbatim. I confirmed the live
   base is 8Gi/8192. The reranker bump is correctly scoped to a value-only live patch that
   preserves its working HTTP probe (F8), which my probe-shape check supports.

5. **Are both mandatory user decisions recorded as answered?**
   Yes. Decision (a) memory and Decision (b) ceiling=8192 are both in the "User answers to
   open decisions (RECORDED 2026-10-09)" block, with a PRECEDENCE note (fix the serving path
   first) and the 12k→8192 provenance narrative in F1. See NIT 1 for the one residual caveat.

---

## Findings

### 1. NIT — Fallback step-down is described as "powers of two" but lists a non-power-of-two (6144)
**Where:** `design.md` RC3/F2 ("step down from 8192 by powers of two — 8192→6144→4096") and
Out-of-scope.
**Problem:** 6144 is not a power of two (it is 4096 + 2048). The prose "powers of two" and the
enumerated sequence disagree. An operator following "powers of two" literally would try
8192→4096 and skip 6144; an operator following the list would try 6144. Both are safe (both
are gated by the same measured sweep), so this cannot ship a wrong ceiling — hence NIT, not
MEDIUM — but it is an avoidable ambiguity in a live-cluster runbook.
**Fix:** Pick one. Either call it a "binary/stepwise search between the proven 4096 and the
target 8192 (e.g. 8192 → 6144 → 4096)" and drop the "powers of two" phrasing, or keep strict
powers of two (8192 → 4096) and drop 6144. Recommended: keep 6144 as a midpoint and reword to
"step down toward the proven 4096 (8192 → 6144 → 4096), picking the largest size that passes
the gate."

### 2. NIT — The 12k→8192 amendment's external record is the step instruction itself; design should name that as the audit trail, not an inferred corroboration
**Where:** `design.md` F1 ("provenance of the two recorded decisions") and "User answers to
open decisions (RECORDED 2026-10-09)"; original user request literally says "boost to 12k."
**Problem:** The only authoritative verbatim user statement in scope says 12k; the design
sets 8192. The design keeps the recorded answers intact (as its own step requires) and argues
provenance partly from "this step's own instruction independently corroborates them." That is
somewhat self-referential: the design is citing the workflow instruction to validate a user
decision the workflow instruction told it to preserve. The residual risk — that 8192 is not
what the user actually wants — is real but the design already mitigates it correctly: 8192 is
hard-gated (F2), any shortfall escalates to the user, and the design explicitly says "if the
implementer finds the recorded answers do not match what the user actually wants at implement
time, re-confirm before mutating the live cluster." Because the mutation is gated and a
re-confirm path exists, this does not force an operator to guess — hence NIT. It would be a
HIGH if the design treated 8192 as a committed deliverable with no re-confirm gate.
**Fix:** State plainly that the authoritative record of the 12k→8192 amendment is the
workflow decision block transcribed in the "User answers" section (answered 2026-10-09 in
`wf_2b89ae97189de82e`), and that implementation must re-confirm the 8192 target with the user
as the first live step if any ambiguity remains — rather than framing the step instruction as
independent corroboration of itself.

### 3. NIT — `ovms --configure` runtime availability in THIS image is asserted from `--help`, not demonstrated end-to-end
**Where:** `design.md` F4 ("`ovms --help` confirms `--configure` … Chosen mechanism").
**Problem:** The design's chosen non-destructive regeneration mechanism depends on
`ovms --configure` working at runtime against the populated PVC in the deployed 2026.4.0
image. The evidence is `--help` listing the flag, which proves the flag is parsed but not that
`--configure` regenerates `graph.pbtxt` to `max_length: 8192` on this build without side
effects. The design does provide a fallback (`--overwrite_models`) and a hard acceptance check
(`cat graph.pbtxt` reads 8192 after rollout), so a failed `--configure` is caught before the
guard is raised — which is why this is a NIT and not a MEDIUM. The gate makes it safe.
**Fix:** Keep the acceptance check as the authority. Optionally add one line that the first
RC3 action is a dry-run of `ovms --configure … --max_length 8192` on a single replica with the
`graph.pbtxt`-reads-8192 check BEFORE committing to the mechanism, falling back to
`--overwrite_models` only if `--configure` no-ops.

---

## Unverified / could-not-verify assumptions

- **Latency sweep numbers** (100 w = 0.065 s … 4000 w = 32.4 s; healthy ping 0.265 s). I did
  not re-run the token sweep this session; all four replicas are currently `0/1` so a clean
  healthy-replica sweep was not reproducible at review time. These numbers are plausible and,
  critically, the design does NOT rely on their exact values — it hard-gates the ceiling on a
  fresh post-fix sweep and has an explicit F7 "re-verify before acting" checklist. So the risk
  of staleness is already absorbed by the gate. Not a finding.
- **Exit Code 137 / OOM attribution.** The design treats the memory bump as reducing OOM risk;
  I confirmed restarts are churning but did not confirm the terminated-pod exit code this
  session. The 8Gi→12Gi bump is low-risk and reversible regardless, so attribution precision
  is not load-bearing.
- **`--configure` end-to-end behavior** — see NIT 3; asserted from `--help`, caught by the
  acceptance check.

## Verified assumptions (confirmed accurate)

- Live memory 8Gi (embeddings + reranker); `OMNIROUTE_MEMORY_MB=8192`.
- Embeddings inline `-m 2 "ping"` readiness probe; reranker HTTP `/v2/health/ready` probe.
- `ovms-readiness-scripts` ConfigMap NotFound live.
- `podManagementPolicy: Parallel`; `updateStrategy` RollingUpdate + partition available.
- Graph `max_length: 4096` on all four replicas.
- Five `OMNIROUTE_EMBEDDING_*` env var names, including the ceiling knob
  `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` (default 4096).
- `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` default `auto`, enum `auto|truncate|reject`, with the
  exact internal-vs-external behavior quoted.
- ReadWriteOnce per-ordinal PVCs.
- Committed model-pull initContainer lacks `--max_length`/`--truncate`; committed memory 10Gi
  with the ceiling-formula comment.

---

## Verdict

0 HIGH, 0 MEDIUM, 3 NIT. The design is internally consistent, every reachable live claim is
independently confirmed, both mandatory decisions are recorded, the ceiling is correctly
gated on a measured proof with a defined fallback and user escalation, blast radius is
controlled single-replica-first via a mechanism that actually exists on the live StatefulSet,
and no NIT forces an operator to guess at the live cluster. **APPROVED.**
