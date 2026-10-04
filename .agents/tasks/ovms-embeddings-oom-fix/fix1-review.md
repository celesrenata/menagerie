# Capped embeddings requests with split-on-5xx for Zoo Code code-index

Commit `6719b9aae` stops a single large file from turning into one huge `/v1/embeddings` request. That kind of request OOM-kills an OVMS replica, and SDK retries then carry it to every other replica. Each wire request is now limited to 32 items and to 16384 padded tokens (items × longest item's chars/4). Texts are sorted by length before grouping and results go back in input order. The file-watcher `FilePreparation` path uses the same planner. The OpenAI SDK client is built with `maxRetries: 0`. On a 5xx or connection error, a multi-item batch is halved and retried up to 5 levels deep instead of being resent, and the 429 backoff is unchanged. Gemini, Mistral and Vercel AI Gateway wrap `OpenAICompatibleEmbedder`, so they get the same behavior. Requirements (a) through (e) are all covered, and the AGENTS.md checks pass.

Watch for: the item cap is a hardcoded constant, so a user who lowers `codeIndex.embeddingBatchSize` doesn't lower the file-watcher request size (likely, non-blocking). Cloud providers routed through the OpenAI-compatible path now send roughly 2–3× more requests per scanner batch (confirmed, non-blocking).

**Verdict**: APPROVED

## High-level view

A new pure module, `shared/embedding-batches.ts`, holds the request planner. It sorts by estimated tokens (stable), then groups greedily under both limits. A single item always forms its own request, so per-item limits stay with each embedder. Two callers use it: `OpenAICompatibleEmbedder.createEmbeddings` per HTTP request, and `FilePreparation.preparePoints` per `createEmbeddings` call. Because of the second caller, the file-watcher path is bounded for every embedder, including native OpenAI, Ollama, Bedrock and OpenRouter, which weren't otherwise touched. The scanner path is still bounded only inside the OpenAI-compatible family.

Failure handling now has two layers. The inner `_embedBatchWithRetries` keeps the 429 loop and rethrows the raw error. The outer `_embedBatchSplittingOnFailure` classifies the error with `isSplittableEmbeddingError`: 5xx, or a status-less connection error by code or message. It splits the batch in half and recurses, and formats the error only at the end. Against a dead server, a 32-item request costs at most 6 calls. Against a server that fails only some halves, the cost is bounded by the 63-node split tree.

The constants are documented in `constants/index.ts`, including why they're separate from `embeddingBatchSize`. The values match the brief: 32 items, 16384 padded tokens, depth 5.

Verification evidence (`fix1-verification.md`) shows 3 targeted spec files passing (144 tests) and the full `services/code-index` suite passing (36 files, 841 tests). `tsc --noEmit` and per-file `eslint --prune-suppressions` were also clean. The diff contains no `as any` or `as unknown as`, and it touches no changeset, CHANGELOG or `eslint-suppressions.json`. I did not re-run any of these.

<details>
<summary>Issues (4)</summary>

1. **embeddingBatchSize not honored by the watcher cap** (likely, non-blocking): `FilePreparation` always plans with the 32-item default. Consider using `min(32, embeddingBatchSize)` there so a user-lowered batch size also shrinks watcher requests, as the investigation report recommended.
2. **More requests for cloud OpenAI-compatible providers** (confirmed, non-blocking): Gemini, Mistral, Vercel AI Gateway and generic hosted endpoints went from ≤100K-token packing to 32-item requests. That raises request count and 429 exposure. Consider a per-embedder override if this shows up in practice.
3. **Partial success discarded on a split leaf failure** (confirmed, non-blocking): if any leaf fails, the whole `createEmbeddings` call throws and the halves that already succeeded are thrown away. This matches the old all-or-nothing behavior; just noting it.
4. **Telemetry fan-out on split** (confirmed, minor): each failed node in the split tree emits its own `CODE_INDEX_ERROR` event, so one dead-server request emits up to 6. Consider tagging split depth if dashboards count these.

</details>

<details><summary>Details</summary>

### Request planner and where it applies

`planEmbeddingRequests` checks `(current.length + 1) * max(currentLongest, tokens[index]) > maxPaddedTokens` before adding an item. Items are visited in ascending length, so the longest item is always the one being added. That makes the check exact for the chars/4 estimate. The incident batch (716 items, 50–1,129 chars, longest ~283 estimated tokens) now becomes about 25 or more requests, each ≤32 items and ≤16384 padded tokens. That is well under the ~55K padded positions known to succeed at 8Gi.

```
file-watcher ─► FilePreparation.preparePoints ─► planEmbeddingRequests ─► embedder.createEmbeddings(group)
scanner (≤ embeddingBatchSize) ──────────────────────────────────────────► embedder.createEmbeddings(batch)
                                                     OpenAICompatibleEmbedder:
                                                     planEmbeddingRequests ─► _embedBatchSplittingOnFailure
                                                                              └► _embedBatchWithRetries (429 loop)
```

Requirement (a) asks for the cap to be "aligned with codeIndex.embeddingBatchSize". The coder interpreted that as an independent, documented constant. That works with the default of 60, since a scanner batch splits into 2 requests. But `FilePreparation` doesn't receive the configured batch size, so a lowered setting is ignored on the watcher path (Issue 1). The padded budget still bounds memory, so this isn't blocking.

### Split-on-failure semantics

`isSplittableEmbeddingError` decides from `extractStatusCode` first. Any status outside 5xx, including 429, is never split. That keeps the 429 backoff the only retry for rate limits, and an exhausted 429 surfaces formatted as before. Errors without a status are matched by `code` on the error or its `cause` (ECONNRESET, UND_ERR_SOCKET and others) or by the SDK/undici message text. The SDK's `APIConnectionError` carries no status, so it lands here as intended. The fetch-path `HttpError` carries its status and is covered by the full-URL 5xx test.

A timeout ("Request timed out") counts as splittable. With `maxRetries: 0` and the SDK's default 10-minute timeout, a stuck server costs up to 6 sequential timeouts before the error surfaces. That's bounded, but slow in the worst case.

When the server dies mid-request, splitting sends halves to the next replica. Each half is at most 16 items and ≤8K padded, so the poison-replay pattern from the incident can't reproduce through this client.

### Pre-existing alignment bug noted by the coder

When the embedder skips an item over the per-item token limit, `createEmbeddings` returns fewer vectors than inputs. `FilePreparation` and the scanner then map vectors to blocks by position. This bug predates the change and is out of scope. The new per-group mapping in `FilePreparation` limits the misalignment to one request group instead of the whole file.

### Test coverage

Tests cover: the 700-item plan bounds and order restoration, in both the embedder and `FilePreparation` (posix and win32); the 32-item cap on short items; `maxRetries: 0` in the constructor; split-on-5xx call counts (8→4,4); repeated splitting on connection errors; bounded leaf failure (32…1 then a formatted 503); no split on 4xx; fetch-path split; and an unchanged 429 backoff.

Not tested: the planner's padded-budget boundary with one item that alone exceeds the budget (only described in docs); `cause.code` classification without a matching message; and Gemini, Mistral or Vercel request counts under the new cap. Their specs pass, but they don't assert batching.

</details>

<details>
<summary>File map</summary>

- `src/services/code-index/constants/index.ts`: new request-cap constants and their documentation.
- `src/services/code-index/shared/embedding-batches.ts`: new planner and splittable-error classifier.
- `src/services/code-index/embedders/openai-compatible.ts`: `maxRetries: 0`, planned requests, split-on-failure wrapper, raw rethrow from the 429 loop.
- `src/services/code-index/processors/file-preparation.ts`: per-group `createEmbeddings` calls with block order restored.
- Specs: `shared/__tests__/embedding-batches.spec.ts` (new), `embedders/__tests__/openai-compatible.spec.ts`, `processors/__tests__/file-preparation.spec.ts`.

Full diff: `git -C /Users/celes/sources/celesrenata/menagerie show 6719b9aae`

</details>
