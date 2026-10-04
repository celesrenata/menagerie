# Sequential sub-batch splitting for arc-embed / ovms-arc embeddings (pass 2)

This pass reviews OmniRoute `bb7a38057` on top of `e16735ba1`, which pass 1 already reviewed. The new commit addresses the three non-blocking findings from pass 1. A split request now charges one quota request (`requestCount = 1`). A failed split request writes the prompt tokens of the sub-batches that already succeeded onto its single `call_logs` failure row. The split loop checks the client's `request.signal` before each sub-batch and ends with a 499 once the signal has aborted. The 499 is not in `HARD_ERROR_STATUSES`, so it causes no cooldown. Image `3.8.60-embed-split-r2-20261003` (digest `sha256:995e03a0…29435d4`) is running in the OmniRoute pod, and the imageID matches the pushed digest. Kube commit `2fc8d37` points at that tag. The 700-input live run returned 200 with every index in place and wrote one `call_logs` row (`tokens_in 114351`). Peak cgroup memory per pod was 2.7–3.3 GiB against a 16 Gi limit, there were 0 OOMKilled terminations, and no pod restarted or changed Ready state during the 10:18:01–10:20:10Z verify window.

Watch for: the restart gate is met only for the verify window. Two pods were liveness-killed 2–5 minutes after the test, at 10:21:36Z and 10:24:34Z (confirmed). These restarts match the fleet's idle restart rate from the i915 fence stall: about 11 kills between 09:46 and 10:18Z with no test load. The verification report says the orchestrator scoped those kills out of this gate. Separately, a failed split request now writes partial tokens to `call_logs`, but its live-request `failed` event still carries no tokens (confirmed, non-blocking).

**Verdict**: APPROVED

## High-level view

The quota change is a single constant on the split path. One logical call now uses one unit of a key's request quota, whatever the number of sub-requests or re-split halves. The unsplit path and CLOVA single-text still count `singleTexts.length`.

Partial-usage tracking uses a mutable `progress` object owned by `executeEmbedding`. Each successful sub-batch adds its usage to it, and both failure exits read it: the upstream non-2xx branch and the thrown-error branch. A failure row records tokens only when the total is above zero, so unsplit failures still log the same row as before. The live-dashboard `failed` event does not get these tokens.

Client abort is cooperative and only acts between sub-batches. A sub-request that is already in flight runs until it finishes or its own `FETCH_TIMEOUT_MS` expires. After an abort, the remaining queue is skipped, and the request ends as one 499 `call_logs` row with partial tokens and no account cooldown. The signal enters at the `/v1/embeddings` route and passes through `createEmbeddingResponse`. Internal callers such as the memory/qdrant embedder pass no signal, so their behavior is unchanged.

On the live gate, the change does what it targets: no pod is OOMKilled, and memory stays at about 3 GiB. The liveness restarts that remain are the separate, already-present i915 VF fence stall. They happen at the same rate while the fleet is idle, and none happened during the verify window.

<details>
<summary>Issues (2)</summary>

1. **Live `failed` event drops partial tokens** (confirmed, non-blocking). `handleEmbedding` calls `live.finish({ status, error })` on failure, so the dashboard shows 0 tokens for a split request that used, for example, 21 sub-batches of GPU work, while `call_logs` records them. If dashboard token totals should match `call_logs`, add the partial token count to the failure result and pass it into `live.finish`.
2. **Restart gate met only for the verify window** (confirmed, non-blocking per the orchestrator's scoping). Pod 3 (10:21:36Z) and pod 2 (10:24:34Z) were liveness-killed within 5 minutes after the run. They match the i915 fence-stall rate seen with no load, with 0 OOMKilled. Track the cause in `ovms-embeddings-crashloop.md`. Judge later memory-limit changes, such as FIX 3, by OOMKilled count.

</details>

<details>
<summary>Details</summary>

### Partial-usage accounting across failure exits

`progress.promptTokens` increases only after a sub-batch's `response.json()` has been parsed. A failed sub-batch adds nothing, and neither do re-split halves before they succeed. With 32 items succeeding and then `[32,40)`, `[32,36)` both returning 503, the row records 32, which matches the new test.

The live-request lifecycle in `handleEmbedding` reads only `result.status` and `result.error` on failure. `EmbeddingFailure` has no tokens field, so the dashboard's failed event cannot show the partial spend (Issue 1). The brief's "summed tokens in call_logs and live-request events" requirement covers the success path, and the success path does report summed tokens to both.

### Client abort semantics

```
route.ts  request.signal ──> createEmbeddingResponse(options.signal)
                                └─> handleEmbedding(params.signal) ──> runtime.signal (spread)
fetchSplitEmbeddingBatches:
  for each queued sub-batch:
    signal.aborted? ── yes ──> throw EmbeddingClientAbortError ──> 499, call_logs(partial tokens)
         └─ no ──> dispatch (own AbortSignal.timeout, client signal NOT merged)
```

Not merging the signal into the in-flight fetch is a deliberate choice. It avoids abandoning a GPU sub-batch halfway and misreporting it as a timeout: `handleEmbeddingException` treats `AbortError` as 504, and an abort error raised inside the fetch would be classified that way and then cooled down. A disconnected client can therefore still use one full sub-batch of upstream time. The abort is logged through the generic `"fetch error"` error-level path, so a client disconnect looks like an upstream fault in the logs. That is cosmetic.

### Live verification and the restart gate

The deploy chain is complete: commit `bb7a38057` → tag `-r2` → digest `995e03a0…` → running pod imageID. Kube commit `2fc8d37` holds the tag. The 700-input run (22 sub-requests, 65.7 s) and a real client batch from `zoo-m5` (709 items, 23 sub-requests) each produced exactly one `call_logs` row with summed tokens. Pass 1 asked for all four pods to be Ready before the run. The verification shows that this was not achievable: only one 5-second sample over 32 minutes of polling had all four Ready. Pod 3 was unready when the test started. The fleet's liveness kills (about 11 between 09:46 and 10:18Z with no test load) and 13 i915 `Fence expiration time out` events since 09:45Z, none inside the test window, put the cause of the restarts outside this change. The verification report now lists the iteration-1 restarts and probe failures it had left out.

### Test coverage

There are two new tests: a partial terminal failure (call sizes 32, 8, 4; one 503 row; `tokens.in 32`) and a client abort after the first sub-batch (one upstream call; one 499 row; `tokens.in 32`). The split suite passes 13/13, and the surrounding embedding suites pass 147/147 and 106/106. `typecheck:core`, eslint, prettier, and pre-commit hooks are clean, and the full `tsc` run has 0 errors in the 5 touched files.

Not tested: the quota `requests: 1` value on the split path, the live `failed` event's token payload, a client disconnect through the real Next.js route (whether `request.signal` actually aborts on disconnect in this deployment), and a sub-batch timeout producing a 504 row with partial tokens.

</details>

<details>
<summary>File map</summary>

- `open-sse/handlers/embeddings.ts`: `signal` param, `SplitProgress`, `EmbeddingClientAbortError`, abort check per sub-batch, constant `requestCount = 1`, partial tokens on both failure rows, 499 status mapping.
- `src/lib/embeddings/service.ts`: `signal` option forwarded to `handleEmbedding`.
- `src/app/api/v1/embeddings/route.ts`: passes `request.signal`.
- `tests/unit/embeddings-batch-split.test.ts`: `signal` arg on the helper, partial-failure and client-abort tests.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute show bb7a38057` (pass 1 reviewed `e16735ba1`).

</details>
