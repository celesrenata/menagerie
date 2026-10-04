# Chunked memory embeds, per-item embed cap, and prefix-cache gate on combo fallback compression

The branch fixes the client side of the OVMS i915 watchdog wedge. The internal memory/Qdrant embedder used to send a post-condense `## Conversation Summary` as one 20k-char input (9,276 tokens, more than 20 s on the Arc VF). It now splits any text over 12k chars into at most three chunks on paragraph or line breaks, embeds them sequentially, and mean-pools the chunk vectors into the one vector per memory that the data model stores. `/v1/embeddings` gains a per-item cap for the split providers (`arc-embed`, `ovms-arc`; 4096 estimated tokens, env-configurable). Over-cap items from internal callers are truncated; external callers get a 400 before anything is dispatched. `embedWithRetry` no longer resends after a timeout or 5xx. Separately, combo proactive fallback compression is now skipped when the fallback target is prefix-cache-sensitive, which closes the gap left open in the glm53-prefix-stability review.

Watch for: the cap and the 12k chunk size both assume 3 chars/token, but the incident's own summary measured 2.16 chars/token. A 12k chunk of that text is about 5.5k real tokens (about 10 s on the VF), not ≤4,000 (likely). That is still half the 20 s watchdog and matches the report's "about 12k chars" recommendation, but the "4096-token" cap does not bound real tokens at 4096. Mean pooling weights a 50-char tail chunk the same as a 12k chunk (confirmed).

**Verdict**: APPROVED

## High-level view

Memory texts over 12k chars are cut at the last `\n\n`, then `\n`, then whitespace in the back half of each 12k window, with a hard cut as the last resort. Each chunk is at most 12k chars by construction, and the total is capped at three chunks (36k chars). This replaces the old 20k clip. Chunk vectors are L2-normalized, averaged, and renormalized. That fits the one-vector-per-memory model in both sqlite-vec and Qdrant (which uses Cosine distance, so the change in norm doesn't affect ranking). Texts of 12k chars or less take the unchanged single-request path and keep their raw vectors, so no reindex is needed. The aggregation choice and its rationale are documented in `chunking.ts`.

The per-item cap lives in `resolveEmbeddingSplitLimits`. It is set by `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` (default 4096) or by a third `:maxItemTokens` field per provider. `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` (`auto`/`truncate`/`reject`) chooses what happens to an over-cap item. The cap runs once, right after `prepareEmbeddingRequest` and before any dispatch, so neither split sub-batches nor halved re-splits can carry an over-cap item. `internalCaller` is spread through the embedding combo `handleSingleModel` path as well. The cap is tied to split enablement: setting `OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS=off` also turns the cap off.

Retry behavior is now one shot for poison-shaped failures. The handler already never resends on timeout and halves a 5xx batch only once (a single item is never resent). `embedWithRetry` now returns at once on `timeout` or `status >= 500`, so the memory is marked `needs_reindex` and the sweep retries it later. `EmbeddingError.status` was added to carry that signal.

The combo fallback gate skips `applyCompression` for prefix-cache-sensitive targets rather than passing a cache-aware config. The target's own chatCore pass still applies the gated Lite config, so this is the more conservative option and matches what the primary route does.

<details>
<summary>Issues (4)</summary>

1. **Chars/token estimate is not conservative for the actual workload** (likely, non-blocking). The summary measured 2.16 chars/token, so a 12k chunk is about 5.5k tokens and the 4096-token cap allows about 5.7k real tokens. Correct the "conservative" comments. Either pair this with the OVMS `--max_length` change, or lower the ratio or chunk size if the latency budget needs real ≤4096 tokens. Before deploying `--max_length 4096`, confirm that OVMS truncates over-length input rather than rejecting it. Otherwise dense 12k chunks would start returning 4xx (possible).
2. **Equal-weight pooling of uneven chunks** (confirmed, non-blocking). A 12,050-char text pools a 12k chunk and a 50-char tail with equal weight, so the tail can move the memory vector noticeably. Weight by chunk length, or fold a tail under some minimum size into the previous chunk.
3. **Retrieval latency on the chat path** (likely, non-blocking). A 36k-char query now makes three sequential calls, each about 9–10 s at the measured density, where it used to make one call. That is safe for the watchdog, but it adds up to about 30 s before first token on the first turn after a condense. Consider embedding only the first chunk for retrieval queries, or set a time budget.
4. **Gate depends on target.provider / connectionId** (possible, non-blocking). `isPrefixCacheSensitiveTarget` sees the override only when the combo target carries a `connectionId`. A ds4 backend registered under a custom provider-node prefix, with the override only on its connection, would be missed when the combo target is not pinned to a connection. Check that the real hybrid/planner combo resolves to the `llama-cpp` provider id or pins the connection.

</details>

<details>
<summary>Details</summary>

### Chunk boundaries and the 12k guarantee

`findChunkEnd` searches only `text.slice(start, start + 12000)`, so each boundary lands at or before the hard end and no chunk exceeds 12k. A break is used only if it falls past the window's midpoint, so chunks are never shorter than 6k chars, except the tail. Whitespace-only chunks are dropped without counting toward the three-chunk limit. Tests cover a 20k summary (all chunks but the last end on `\n\n`, and the chunks rejoin to the input), the 50k→3 cap, the whitespace and hard-cut fallbacks, and the ≤12k identity path.

The tail is not bounded below. Mean pooling weights every chunk equally, so a short tail pulls the stored vector toward whatever those few chars say:

```
12,050 chars → [12,000][50]  → pooled = normalize(v12000 + v50) / 2
```

The text before 36k is embedded and anything after it is silently dropped. That is an improvement on the old 20k clip and is documented.

### Token estimate vs. measured density

`ESTIMATED_CHARS_PER_TOKEN = 3` is described as "conservative", and `chunking.ts` says that 12k chars is "≤4,000 tokens". The fence-stall report measured this very summary at 20,000 chars → 9,276 tokens, or 2.16 chars/token. A 12k-char chunk is therefore about 5,560 tokens. The report's latency table puts 6k tokens at 10.1 s. That still leaves roughly 2× headroom under the 20 s i915 watchdog, and 12k chars is what the report and the task asked for. So this does not block, but the comment and the "4096-token cap" label overstate the guarantee. For external callers the cap allows up to 12,288 chars (about 5.7k real tokens).

The two specs can't both be strict with real data. Lowering the ratio to 2 would make the cap truncate every full 12k internal chunk to 8,192 chars. The coder's choice keeps the two consistent with each other. The remaining risk is server-side. If OVMS `--max_length` drops to 4096 (report recommendation #1) and OVMS rejects over-length input instead of truncating it, dense 12k chunks would fail with a 4xx. This is possible and not verified here.

### Retry path

In the handler, the cap is applied before `resolveSplitPlan` and dispatch, so `halveSubBatch` only ever slices already-capped input, and a single-item batch is never resent (`canResplit` requires more than 1 item). `embedRemote` makes no retries and stops at the first failing chunk. `embedWithRetry` short-circuits on `timeout` or `status >= 500`. A `request_failed` with no status (a network reset when OVMS drops the socket) still gets one retry. That retry is a capped chunk of ≤12k, so the required property (no unchanged resend of an oversized item) holds. Tests cover the 503 re-split never carrying the 20k string, a single over-cap 503 being sent once and truncated, a timeout not being retried, and `embedWithRetry` behavior for timeout, 5xx, 429, and 4xx.

An embedding combo with several targets can still send the same capped chunk to the next target after a timeout. That is the combo engine's normal fallback, and the item is no longer oversized.

### Combo fallback gate

The new test drives `handleComboChat` with `provider-a` failing and `llama-cpp/glm-5.3` as the fallback, with zero-latency Lite at threshold 1. It asserts that the 2,500-char tool output arrives unchanged. Per the verification doc, the test fails when the fix is reverted, and the existing non-sensitive case still truncates. The `isPrefixCacheSensitiveTarget` unit test covers only provider defaults. The connection-override branch (a read through `readConnectionForCooldownGate`, with a failed read treated as no override) is untested. That branch is the only path for a ds4 backend that isn't under the `llama-cpp` id (see Issues #4).

Not tested: the connection-override path of `isPrefixCacheSensitiveTarget`, Qdrant `embedText` chunking for texts over 12k (the qdrant-wiring suite passes, but no new case covers pooling there), and `internalCaller` propagation through an embedding combo.

</details>

<details>
<summary>File map</summary>

- `open-sse/handlers/embeddingBatchSplit.ts`: `maxItemTokens` limit, overflow-mode resolver, `capEmbeddingItems`.
- `open-sse/handlers/embeddings.ts`: `applyEmbeddingItemCap` before dispatch, `internalCaller` param.
- `open-sse/services/combo/executeTargetGates.ts`: `isPrefixCacheSensitiveTarget`.
- `open-sse/services/combo/executeTargetAttempt.ts`: skip fallback compression for sensitive targets.
- `src/lib/embeddings/service.ts`: thread `internalCaller`.
- `src/lib/memory/embedding/chunking.ts` (new): chunker, mean pool, `embedTextChunked`.
- `src/lib/memory/embedding/remote.ts`: per-chunk embed, replaces the 20k clip, adds status on errors.
- `src/lib/memory/embedding/index.ts`: no retry on timeout/5xx.
- `src/lib/memory/embedding/types.ts`: `EmbeddingError.status`.
- `src/lib/memory/qdrant.ts`: chunked `embedText`, `internalCaller`.
- `src/lib/memory/store.ts`: log status.
- `.env.example`, `docs/reference/ENVIRONMENT.md`: new env vars.
- Tests: `embeddings-item-cap` (new), `memory-embed-summary-chunking` (new), `13601-embed-retry`, `combo-routing-engine`, `prefix-cache-sensitive`, `embeddings-batch-split`.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute/.worktrees/embed-summary-cap diff c4c83b892..a2169c18f`

</details>
