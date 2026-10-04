# OVMS embeddings per-item length cap and memory limit rollback

Commit `2af4afd` in `~/sources/kube` changes `omniroute-memory/ovms-embeddings-statefulset.yaml` in two ways. It adds `--truncate=true --max_length=8192` to the `model-pull` init container, which regenerates `graph.pbtxt` on every start. It also returns the ovms container from the temporary 16Gi/4Gi to an 8Gi limit with a 2Gi request. The coder confirmed the flag spelling with `ovms --help`: it is `--max_length`, and `--max_legth` is the docs typo. 8192 is within the model's `max_position_embeddings` of 32768. The rollout reached 4/4 Ready with 0 restarts, rechecked about 3 minutes later. In OVMS 2026.4.0, `truncate: true` does not actually truncate the embeddings path, so `max_length` now works as a hard per-item reject (HTTP 400). That is documented in a manifest comment and was an explicit orchestrator decision.

Watch for: in this build `truncate` does nothing, and `max_length` turns long items into 400s instead of truncating them (confirmed, accepted trade-off). The cap is per item, so it does not bound item count per request; the padded-batch OOM still depends on FIX 1/2 (confirmed). The 2Gi request sits below the measured post-rollout cgroup usage of 2.4–3.4 GiB (likely, non-blocking).

**Verdict**: APPROVED

## High-level view

The change is applied the reproducible way. The flags go on the `model-pull` init container that writes `graph.pbtxt`, and nothing was hand-edited on the live volume. All four regenerated graphs show `truncate: true` and `max_length: 8192`. The live spec matched the manifest after apply (`kubectl diff` exit 0). There is no GitOps controller in this repo that could revert the manually applied state, and the commit is not pushed.

The coder traced the truncation behavior to the OVMS source. The embeddings calculator sets `max_length` but never sets the GenAI tokenizer's `truncation` flag, and `isInputIdSizeOk` then rejects anything over the cap. Functional tests back this up: 7.9K tokens returns 200, and 15K, 25K, and 48K tokens return 400. The result is a stricter per-item bound than the requested truncation. Known callers (Zoo chunks ≤ ~1,150 chars, OmniRoute memory traffic ~400 tokens) are far below it. Clients like the OpenAI SDK don't retry a 400, so a rejected item does not cascade across replicas the way a 5xx did.

Two measurements bear on the memory figures. The 8Gi limit matches the report's recommendation, and peak cgroup usage including the long-input tests was 2.9–3.4 GiB. The 2Gi request follows the task but sits just above the ~1.85 GiB idle working set and below loaded usage. The report itself suggested 3Gi.

<details>
<summary>Issues (3)</summary>

1. **Per-item cap is not batch bound** (confirmed, non-blocking): `max_length` limits each item, not the padded batch. A 700 × 8192 padded batch can still exceed 8Gi, so FIX 1 (Zoo batching) and FIX 2 (OmniRoute split) remain the real OOM guard. Keep them in scope and don't treat FIX 3 as sufficient.
2. **Request below loaded usage** (likely, non-blocking): the 2Gi request is under the measured 2.4–3.4 GiB in-use cgroup memory. Under node memory pressure the kubelet ranks these pods for eviction first. Consider 3Gi as the report recommended, or record why 2Gi is wanted.
3. **Comment overstates Zoo's item cap** (possible, non-blocking): the manifest comment says "Zoo caps items at 8191 tokens", but Zoo estimates tokens as chars/4. Dense content (the hex batch measured ~1.1 chars/token) could exceed 8192 real tokens while passing Zoo's estimate, and that would 400 the whole batch. Zoo's chunker currently keeps items far below this, so the risk is theoretical. Reword the comment to "estimated tokens", and pursue the upstream OVMS truncation issue already listed as a follow-up.

</details>

<details>
<summary>Details</summary>

### Flag placement and reproducibility

```
model-pull (init) --task=embeddings --pooling=LAST --truncate=true --max_length=8192 --target_device=GPU
        │ writes
        ▼
/models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov/graph.pbtxt  (regenerated each start)
        │ loaded by
        ▼
ovms container (8Gi limit / 2Gi request)
```

The original concern was that `graph.pbtxt` gets regenerated, so a hand-edit would be lost. Putting the flags on the generator addresses that. The evidence covers the `ovms --help` output for both flags, the regenerated graphs on all four pods, and a clean `kubectl diff` after the comment-only follow-up edit.

### truncate is a no-op in 2026.4.0, so max_length becomes a reject cap

The task asked for truncation to a bounded length. What shipped bounds input length by rejecting over-cap items, because truncation can't be enabled in this build: the calculator never sets `truncation`, and the request parser ignores extra JSON params. The coder documented three alternatives (32768, dropping the flags, keeping 8192) and recorded the choice in the manifest. Behavior did change: items of 8,193–32,768 tokens used to embed and now return 400. No known caller sends items that size. Third-party callers on the LAN LoadBalancer would see a 400 instead of a truncated embedding. The optional OmniRoute-side truncation follow-up would cover them.

### Memory limit vs. the remaining batch-size risk

8Gi is the pre-incident limit. At that limit, roughly 55K padded positions succeeded, and the 300K+ padded batches OOMed. The per-item cap brings the worst-case longest member down from 32K to 8K tokens. Item count is still uncapped, so a large batch can still pad to millions of positions. With 8Gi, a poison batch kills one container instead of pressuring a ~94 GB node shared with other GPU pods, which is the intended blast-radius trade. Preventing the kill still depends on FIX 1/2.

On the request: memcg `current` includes the unevictable GPU shmem, so it tracks the working set closely. Post-rollout values of 2.4–3.4 GiB mean every pod runs above its 2Gi request whenever there is load. This doesn't affect OOM-kill behavior, which is governed by the limit. It does affect scheduling headroom and eviction ordering.

### Test coverage

The evidence includes direct functional tests for under-cap and over-cap inputs, a confirmation of tokenizer-level truncation via `/v3/tokenize`, and cgroup readings during those tests. Not tested: a multi-item batch near the cap, which is what actually bounds the padded cost; and how the 400 propagates through OmniRoute (whether it fails over to another provider or returns the 400 to the client). The report didn't verify OmniRoute's 4xx fallback behavior.

</details>

<details>
<summary>File map</summary>

- `omniroute-memory/ovms-embeddings-statefulset.yaml`: ovms memory 16Gi/4Gi → 8Gi/2Gi; `model-pull` init args gain `--truncate=true`, `--max_length=8192`, and a comment explaining the 2026.4.0 truncation no-op.

Full diff: `git -C ~/sources/kube show 2af4afd`.

</details>
