# FIX 2 verification: OmniRoute embedding input-array split

## Iteration 2 (fix2-review.json findings), 2026-10-03 ~09:35–10:30Z

### Code changes: OmniRoute `bb7a38057` (parent `e16735ba1`), not pushed

- Finding 2 (quota): a split request now passes `requests: 1` to `recordEmbeddingConsumption`, so one logical call uses one unit of request quota, the same as the unsplit request it replaces. CLOVA single-text is unchanged.
- Finding 3 (partial usage): `fetchSplitEmbeddingBatches` adds up prompt tokens from sub-batches that succeeded. If a later sub-batch then fails, the single failure `call_logs` row records them as `tokens.in`. This covers both upstream non-2xx responses and thrown errors such as timeouts. Unsplit failures still record no tokens.
- Finding 4 (client abort):
    - `signal` was added to `HandleEmbeddingParams` and `EmbeddingHandlerOptions`. `/v1/embeddings` passes `request.signal` through `createEmbeddingResponse` to `handleEmbedding`.
    - The split loop checks the signal before each sub-batch. Once it has aborted, no more sub-batches are sent and the request ends as status 499, with one `call_logs` row that records partial tokens.
    - 499 is not in `HARD_ERROR_STATUSES`, and `handleEmbeddingException` does not cool accounts down, so a client disconnect never cools the connection.
    - A sub-request already in flight still runs until it finishes or hits its own timeout. The signal is not merged into that fetch.
- Files: `open-sse/handlers/embeddings.ts`, `src/lib/embeddings/service.ts`, `src/app/api/v1/embeddings/route.ts`, `tests/unit/embeddings-batch-split.test.ts`.

### Tests and checks (from `/Users/celes/sources/celesrenata/OmniRoute`, same common prefix as iteration 1)

| Command                                                                                                              | Result                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/embeddings-batch-split.test.ts`                                                                          | 13/13 pass (2 new tests)                                                                                               |
| `--test-concurrency=4` with the same embedding glob set as iteration 1, row 2                                        | 147/147 pass                                                                                                           |
| `--test-concurrency=4` with the same memory/provider embedding set as iteration 1, row 3                             | 106/106 pass                                                                                                           |
| `npm run -s typecheck:core`                                                                                          | exit 0                                                                                                                 |
| `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit --pretty false -p tsconfig.json`                           | exit 2. Same 5,860 pre-existing `error TS` lines as iteration 1, and 0 in any touched file (grep checked all 5 files). |
| `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0` on the 4 touched files | exit 0                                                                                                                 |
| `npx prettier --check` on the 4 touched files                                                                        | exit 0                                                                                                                 |
| pre-commit hooks (lint-staged, docs-sync, any-budget, tracked-artifacts, ai-attribution)                             | pass                                                                                                                   |

New tests:

- In the partial-failure test, `[0,32)` succeeds and `[32,40)` returns 503. It is split once and the `[32,36)` half also returns 503. The sub-request sizes are 32, 8, 4. The result is 503 with one `call_logs` row, status 503, and `tokens.in 32`.
- In the client-abort test, the client aborts after the first sub-batch of 100 items. Only 1 upstream call is made, the result is 499, and there is one `call_logs` row with status 499 and `tokens.in 32`.

Not unit-tested: the quota `requests: 1` value. It is a constant on the split path, and checking it needs a quota pool fixture. The full `npm test` suite was not run.

### Deploy

- `git archive --format=tar.gz HEAD` (`bb7a38057`) was copied by scp to `esnixi:~/omniroute-build-embed-split-r2`.
- `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 -t registry.celestium.life/library/omniroute:3.8.60-embed-split-r2-20261003 .` and then `docker push`, with `BUILD_PUSH_EXIT=0`. The digest is `sha256:995e03a01408b01c309a08e81c15f566fdf99de78b52f83e8b4d44bcb29435d4`, and the log is `esnixi:/tmp/omniroute-embed-split-r2-build.log`.
- I used a new tag (`-r2`) instead of re-pushing `3.8.60-embed-split-20261003`. With the same tag, `kubectl apply` would not have changed the pod spec, so it would not have rolled out.
- kube `omniroute/omniroute.yaml` was changed from `3.8.60-embed-split-20261003` to `3.8.60-embed-split-r2-20261003`, committed as kube `2fc8d37`, and not pushed.
- `kubectl apply` reported `successfully rolled out`. Pod `omniroute-79565bf8c-pqxcn` has imageID `…@sha256:995e03a0…29435d4`, which matches the pushed digest.

### Live verification (request 10:18:38–10:19:44Z)

The request was a `curl` `POST https://omniroute.celestium.life/v1/embeddings` with the management key as a Bearer token. The key was never printed. It used model `arc-embed/qwen3-embedding-0.6b` and 700 varied strings of 51–1,100 chars.

- The response was HTTP 200 in 65.7 s, with 700 embeddings, every `index == position`, dimension 1024, `model: arc-embed/qwen3-embedding-0.6b`, and usage `prompt_tokens = total_tokens = 114351`.
- The OmniRoute log shows `splitting 700 items into 22 sub-requests`.
- `call_logs` has exactly one row: 10:19:43Z, status 200, arc-embed, duration 64,139 ms, `tokens_in 114351`, `api_key_name sops-management`.
- Another real client sent an oversized batch through the new code at 09:47:50Z. `zoo-m5` sent 709 items, which were split into 23 sub-requests. That returned 200 in 88.4 s with `tokens_in 72792` in one `call_logs` row.
- Memory peak was measured as `kubectl top` every 5 s from 10:16:50Z (log `/tmp/ovms-monitor-r2b.log`), plus each container's cgroup `memory.peak` read after the test. Every container had restarted before the test, so `memory.peak` covers the test window. The limit is 16 Gi. Before the fix, a ~700-item batch went above 15 GB and was OOMKilled.

    | Pod               | `kubectl top` max during the test | cgroup `memory.peak` |
    | ----------------- | --------------------------------- | -------------------- |
    | ovms-embeddings-0 | 2914 Mi                           | 2954 MiB             |
    | ovms-embeddings-1 | 2817 Mi                           | 2834 MiB             |
    | ovms-embeddings-2 | 2971 Mi                           | 3322 MiB             |
    | ovms-embeddings-3 | 2720 Mi                           | 2741 MiB             |

### Gate (finding 1), as rewritten by the orchestrator: 0 OOMKilled; liveness restarts attributable to i915 fence stalls are tracked separately. Result: met

The orchestrator decided on 2026-10-03 that the i915 fence-stall liveness restarts are out of scope for the FIX 2 gate.

- FIX 2's own criteria are met: 700 inputs returned 200 in order, peak memory was about 3.3 GiB, and there were 0 OOMKilled terminations.
- The i915 problem below is separate and was already there before this change. The orchestrator is opening its own investigation for it.
- Evidence: about 11 `Error/137` liveness kills between 09:46 and 10:18Z with no test load, and 13 kernel `Fence expiration time out` errors since 09:45Z.
- Details are below.

### Separate, pre-existing issue: i915 fence-stall liveness restarts (not caused by FIX 2)

**All four pods Ready before the test:**

- I could never get all four ovms-embeddings pods Ready at the same moment, except for one 5-second sample at 09:48:22Z. In that sample pod 2 had restarted 18 s earlier.
- I polled for that every 10–15 s from 09:46 to 10:18Z.
- The live test ran with pods 0, 1, and 2 Ready and pod 3 already unready (0/1). There were no restarts and no Ready transitions between 10:18:01 and 10:20:10Z.

**Restarts with no test load running (09:46 → 10:18Z):**

- About 11 restarts happened in this window: pod 0 went from 2 to 3, pod 1 from 1 to 5, pod 2 from 4 to 7, and pod 3 from 4 to 6.
- All were `Error/137` liveness kills.
- The only traffic in that window was 1–5-item requests plus the zoo-m5 batch above.

**Restarts after the test:**

- Pod 3 restarted at 10:21:36Z. It had been unready since before the test started.
- Pod 2 restarted at 10:24:34Z, about 5 min after the test ended.

**OOM kills:** none. No pod has `OOMKilled` as its last termination reason, and the kernel logs on gremlin-1..4 since 09:45Z have 0 `oom-kill` or `Memory cgroup out of memory` lines.

**i915 `Fence expiration time out` in the kernel logs since 09:45Z:**

- 13 in total: gremlin-1 had 5, gremlin-2 had 3, gremlin-3 had 4, gremlin-4 had 1.
- None fell inside the test window. The nearest were 10:20:37Z on gremlin-3 and 10:24:54Z on gremlin-1.

**Iteration-1 report corrections:**

- Iteration 1 left out events in its window.
- Pod 2 was liveness-killed at 09:31:34Z.
- Pod 1, which served the request, had a readiness failure at about 09:26:49Z.
- Pod 0, which also served the request, was failing liveness at 09:32Z and was killed at about 09:35Z.
- Pod 3 was killed at 09:28:06Z, as already reported.

**Conclusion:**

- The original zero-restart condition cannot be met on this fleet right now, whether or not this change is deployed.
- The i915 VF fence stall (`~/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md`) causes liveness kills about every 3 minutes across the fleet while idle.
- Per the orchestrator, the gate is now "0 OOMKilled". That gate is met, and the i915 restarts are tracked separately.
- Future memory-limit changes, such as FIX 3 lowering the limit back to 8Gi, should be judged by OOMKilled counts, not total restarts.

---

## Iteration 1 (no fix2-review.json existed). 2026-10-03, ~09:00–09:30Z.

## Change

OmniRoute commit `e16735ba1` on `feat/hybrid-reader-combo` (parent `193fbfb3c`), not pushed.

- `open-sse/handlers/embeddingBatchSplit.ts` (new):
    - `resolveEmbeddingSplitLimits(provider)` reads the env config.
    - `planEmbeddingBatches(input, limits)` plans contiguous ranges. A batch closes when it would exceed `maxItems`, or when `count × longest item` would exceed `maxPaddedTokens`. Tokens are estimated as chars ÷ 3, and token arrays count by their length.
    - `mergeEmbeddingBatchResponses(parts)` remaps `data[].index` to original positions, sorts by index, sums `usage`, and keeps the first `model`.
- `open-sse/handlers/embeddings.ts`:
    - `executeEmbedding` makes a split plan only when the input is a plain string or token array, there is no native/structured transport, the provider is not CLOVA single-text, and the provider has splitting enabled.
    - `fetchSplitEmbeddingBatches` sends sub-batches one at a time. If a sub-batch fails with 5xx or a non-timeout connection error, it is split in half once, and each half is tried once. Halves are never split again, and a sub-batch is never resent unchanged. A 4xx, a timeout, or a failed half ends the request.
    - The merged result goes through the existing success and failure paths, so it produces exactly one `saveCallLog` row and one `beginLiveRequest` started/finished pair, with summed tokens.
- The `src/app/api/v1/embeddings/route.ts` route needed no change. It calls `createEmbeddingResponse` → `handleEmbedding`, so every caller goes through the split, including combos and the internal memory/qdrant embedder.
- Config: provider_nodes have no per-node config bag (schema columns: id/type/name/prefix/api_type/base_url/chat_path/models_path/custom_headers_json), so env vars are used instead:
    - `OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS`. If unset, the default is `arc-embed,ovms-arc`, both live provider_node prefixes. Each entry is `id` or `id=maxItems:maxPaddedTokens` (a per-provider override). `*` matches every provider. An empty value, `none`, or `off` disables splitting. Providers not in the list are forwarded unchanged.
    - `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS` defaults to `32`.
    - `OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS` defaults to `32768`.
    - Documented in `docs/reference/ENVIRONMENT.md` and `.env.example`. No kube env change was needed, because the defaults already cover arc-embed and ovms-arc.

## Tests (run from `/Users/celes/sources/celesrenata/OmniRoute`)

Common prefix: `DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit`

| Command (after prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Result                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tests/unit/embeddings-batch-split.test.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 11/11 pass                                                         |
| `--test-concurrency=4 tests/unit/embeddings-*.test.ts tests/unit/embedding-*.test.ts tests/unit/13601-embed-retry.test.ts tests/unit/10347-embed-402-cooldown.test.ts tests/unit/12441-embeddings-credits-402.test.ts tests/unit/ollama-local-embedding-2824.test.ts tests/unit/lemonade-embedding-provider.test.ts tests/unit/local-provider-embedding-override.test.ts`                                                                                                                                                                     | 145/145 pass                                                       |
| `--test-concurrency=4 tests/unit/memory-embedding-*.test.ts tests/unit/gemini-embedding-2-multimodal.test.ts tests/unit/multimodal-embeddings-alias.test.ts tests/unit/mixedbread-embedding-provider-6660.test.ts tests/unit/lmstudio-embedding-provider-7601.test.ts tests/unit/alibaba-embedding-rerank-endpoints-13030.test.ts tests/unit/issue-13234-embeddings-auth.test.ts tests/unit/auth-policy-embeddings-webfetch-7785.test.ts tests/unit/ninerouter-embed-port-6205.test.ts tests/unit/openrouter-embeddings-catalog-6976.test.ts` | 106/106 pass                                                       |
| `tests/unit/check-env-doc-sync.test.ts tests/unit/embeddings-batch-split.test.ts` (after the doc edits)                                                                                                                                                                                                                                                                                                                                                                                                                                       | 29/29 pass, including "repository contract is in sync (live data)" |

What the new test file covers:

- Default limits apply only to arc-embed and ovms-arc. The env list, per-provider override, wildcard, and off switches all work.
- Plan item cap, padded-token budget, and structured input skipped.
- 700 inputs to arc-embed:
    - at least 22 sub-requests, each ≤32 items, covering every input once and in order;
    - upstream returns each sub-batch in reverse order, and the merged result is still `index == position` with the right vectors;
    - usage is summed to 700/700 and the model is kept;
    - exactly one live `request.started`/`request.completed` pair with `tokensInput 700`;
    - exactly one `call_logs` row with status 200 and `tokens.in 700`.
- A single-string input is untouched (1 call, same string).
- A 32-item array is untouched (1 call).
- A non-configured provider with 100 items is untouched (1 call).
- A 5xx sub-batch is split once (sizes 32→16+16, then 8) and order is preserved.
- A sub-batch that still fails after one split ends the request: calls are 32 then 16, with no further retries, and one failed `call_logs` row with status 500.
- A connection reset is split once, like a 5xx.
- A 4xx is returned as-is after 1 call.

Not run: the full `npm test` suite. All embedding-related suites above were run instead.

## Typecheck / lint / format

- `npm run -s typecheck:core` exited 0. Its file list does not include the embeddings handler.
- `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit --pretty false -p tsconfig.json` exited 2 with 5,860 `error TS` lines. Those errors were already in the repo, and none are in `embeddingBatchSplit.ts`, `handlers/embeddings.ts`, or `embeddings-batch-split.test.ts` (grep found 0 matches). The run without the larger heap aborted from running out of memory.
- `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0 open-sse/handlers/embeddingBatchSplit.ts open-sse/handlers/embeddings.ts tests/unit/embeddings-batch-split.test.ts` exited 0 with no new suppressions.
- `npx prettier --check` on those 3 files exited 0.
- Pre-commit hooks passed: lint-staged prettier and eslint, docs-sync, any-budget (`embeddings.ts` explicit any 0/0), tracked-artifacts, ai-attribution.

## Deploy

- `git archive --format=tar.gz HEAD` (`e16735ba1`) was copied to `esnixi:~/omniroute-build-embed-split`.
- On esnixi: `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 -t registry.celestium.life/library/omniroute:3.8.60-embed-split-20261003 .` followed by `docker push`. `BUILD_PUSH_EXIT=0`, digest `sha256:a60f64791b2bcf414da391dba18625003a554f67099afffc34053eaf417bb7f9`. The log is in `esnixi:/tmp/omniroute-embed-split-build.log`.
- Another workflow committed and deployed in this repo during this run:
    - It committed `193fbfb3c` (audio sniff).
    - It deployed `3.8.61-audio-sniff-20261003` in kube commit `09b454a`.
    - My image is built on top of `193fbfb3c`, so it includes that audio change and nothing was rolled back.
- `/Users/celes/sources/kube/omniroute/omniroute.yaml` changed from image `3.8.61-audio-sniff-20261003` to `3.8.60-embed-split-20261003`. The task text said the current image was 3.8.59; it had changed since. Committed as kube `8672d4b`, not pushed.
- `kubectl apply -f omniroute/omniroute.yaml` → `deployment "omniroute" successfully rolled out`.
- Pod `omniroute-7bb7c5c88b-mtg2f` imageID is `registry.celestium.life/library/omniroute@sha256:a60f64791b2bcf414da391dba18625003a554f67099afffc34053eaf417bb7f9`, which matches the pushed digest.

## Live verification (09:26:02–09:27:06Z)

The request was `POST https://omniroute.celestium.life/v1/embeddings`, using the management key as a Bearer token (the key was never printed). It used model `arc-embed/qwen3-embedding-0.6b` and 700 varied strings of 50–1,098 chars.

- The response was 200 in 63.4 s, with 700 embeddings, every `index == position`, dimension 1024, `model: arc-embed/qwen3-embedding-0.6b`, and usage `prompt_tokens = total_tokens = 114136`.
- The OmniRoute log shows `splitting 700 items into 22 sub-requests`.
- `call_logs` has exactly one row: status 200, provider arc-embed, duration 63,001 ms, `tokens_in 114136`, `api_key_name sops-management`.
- Memory peak: the cgroup `memory.current` was sampled every ~1.5 s, and `memory.peak` was read afterwards. Pods 0 and 1 served the request.
    - Pod 0 went from 2775 Mi to a peak of 3434 Mi.
    - Pod 1 went from 2489 Mi to a peak of 3516 Mi.
    - The highest `kubectl top` reading was 2883 Mi.
    - The limit is 16 Gi. Before this fix, a ~700-item batch went above 15 GB and was OOMKilled.
- Restarts:
    - No OOM kills. Kernel logs on gremlin-1..4 since 09:15Z have 0 `oom-kill` / `memory cgroup out of memory` lines. Pods 0, 1, and 2 still show restartCount 1, from the 08:47Z OOMs before the fix.
    - Pod 3 (gremlin-2) restarted once at 09:28:06Z with `Error/137`, which is a liveness kill. Its gremlin-2 kernel log shows an i915 `Fence expiration time out` at 09:22:47Z, before the test. It was unready and not taking traffic during the test (memory flat at 3422 Mi).
    - Pod 2 (gremlin-3) went unready with the same i915 fence-stall: a `Fence expiration time out` at 09:25:53Z, 9 s before the test started. Its memory stayed flat at 3890 Mi throughout the test.
    - Both match the separate i915 VF fence-stall issue (`~/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md`), not memory. That stall is still recurring and is not fixed by this change.
- Latency trade-off: 22 sequential sub-requests took 63 s. Before the fix, the same request crashed the pod instead.
