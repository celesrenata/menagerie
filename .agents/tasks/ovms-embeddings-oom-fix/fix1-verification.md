# Fix 1 verification: capped embeddings requests (Zoo Code)

Iteration 1 (no fix1-review.json existed). Branch `feat/omniroute-tier-dropdown-feat005`.

## What changed

- `src/services/code-index/constants/index.ts`: `MAX_EMBEDDING_REQUEST_ITEMS = 32`, `MAX_EMBEDDING_REQUEST_PADDED_TOKENS = 16384`, `MAX_EMBEDDING_SPLIT_DEPTH = 5`. The comment explains why these are separate from `codeIndex.embeddingBatchSize` (default 60). That setting sets how many segments the scanner gathers per `createEmbeddings()` call and how many points go into each Qdrant upsert. The new constants limit each wire request inside that call, so a 60-segment scanner batch goes out as 2 requests.
- New `src/services/code-index/shared/embedding-batches.ts`:
    - `planEmbeddingRequests(texts, limits)` does a stable sort by estimated tokens (chars/4) and then groups greedily, keeping each group at ≤ maxItems and items × longest ≤ maxPaddedTokens. It returns original indices so callers can restore order. A single item is always allowed to form a request on its own.
    - `isSplittableEmbeddingError(error)` returns true for HTTP 5xx or a status-less connection failure (SDK "Connection error." / "Request timed out.", `fetch failed`, `socket hang up`, ECONNRESET/ECONNREFUSED/ETIMEDOUT/EPIPE etc. on the error or its cause). It returns false for 4xx, including 429.
- `src/services/code-index/embedders/openai-compatible.ts`:
    - (c) `new OpenAI({ baseURL, apiKey, maxRetries: 0 })`.
    - (a) `createEmbeddings` skips oversized items as before, then sends one request per `planEmbeddingRequests` group and puts results back in input order. The old 100K-token packing with no item cap is gone.
    - (d) New `_embedBatchSplittingOnFailure`: on a splittable error with more than 1 item and depth < 5, it splits the batch in half and embeds the halves one after the other. The first unrecoverable failure is formatted with `formatEmbeddingError` and thrown, so a dead server costs at most 6 requests (32→16→8→4→2→1). `_embedBatchWithRetries` keeps the 429 backoff loop unchanged and now rethrows the raw error so the splitter can see its status. The final error text is unchanged.
    - (e) Gemini, Mistral and Vercel AI Gateway wrap `OpenAICompatibleEmbedder`, so they inherit all of the above.
- (b) `src/services/code-index/processors/file-preparation.ts`: `preparePoints` makes one `createEmbeddings` call per `planEmbeddingRequests` group instead of one call for the whole file, then restores block order. This caps the file-watcher path for every embedder, including OpenAI, OpenRouter, Ollama and Bedrock, which were not otherwise changed.
- Tests:
    - New `shared/__tests__/embedding-batches.spec.ts`.
    - New cases in `openai-compatible.spec.ts` (describe "request caps and split-on-failure").
    - New 700-block case in `file-preparation.spec.ts`.
    - Existing assertions updated: the constructor tests now expect `maxRetries: 0`. The file-preparation order test's mock is now keyed by input text, and its expected request is now in length-sorted order.

## Commands run (cwd `src/`) and results

1. `npx vitest run services/code-index/embedders/__tests__/openai-compatible.spec.ts services/code-index/processors/__tests__/file-preparation.spec.ts services/code-index/shared/__tests__/embedding-batches.spec.ts` gave `Test Files 3 passed (3)`, `Tests 144 passed (144)`.
    - 700 items → every request ≤ 32 items and items × longest ≤ 16384, embeddings in input order, usage summed: `sends a 700-item file as requests of at most 32 items within the padded budget, in order` ✓. Also `caps short items at 32 per request` ✓ (21×32 + 28), and file-preparation `embeds a 700-block file in capped requests and keeps block order` ✓ (posix and win32).
    - maxRetries 0: `constructor > should create embedder with valid configuration` and `should use default model when modelId is not provided` ✓, both asserting `{ baseURL, apiKey, maxRetries: 0 }`.
    - split-on-5xx:
        - `splits a request in half on a 5xx instead of resending it` ✓ (calls 8, 4, 4)
        - `splits on connection errors and keeps splitting until requests succeed` ✓ (8, 4, 2, 2, 4, 2, 2)
        - `stops at the first unrecoverable single-item failure with bounded requests` ✓ (32, 16, 8, 4, 2, 1, then throws the formatted HTTP 503 error)
        - `does not split on 4xx errors` ✓ (1 call)
        - `splits full-URL (fetch) requests on a 5xx response` ✓ (3 fetches)
    - The existing 429 backoff test still passes, and so do the existing single-item 500 tests (1 call, same message).
2. `npx vitest run services/code-index` gave `Test Files 36 passed (36)`, `Tests 841 passed (841)`. This includes the gemini, mistral, vercel-ai-gateway, scanner and file-watcher specs.
3. `npx tsc --noEmit` exited 0.
4. `pnpm exec eslint --prune-suppressions --max-warnings=0` on the 7 touched or new files (`embedders/openai-compatible.ts`, its spec, `processors/file-preparation.ts`, its spec, `constants/index.ts`, `shared/embedding-batches.ts`, its spec) exited 0.
    - Suppression counts before (HEAD): `openai-compatible.ts` no-explicit-any 1, `openai-compatible.spec.ts` no-explicit-any 28, the others none. The pruned file was semantically identical (`diff <(jq -S .) <(jq -S .)` showed no differences), so the counts did not increase.
    - The rewrite was formatting-only churn, so `src/eslint-suppressions.json` was restored with `git checkout`.
    - No `as any` was added.

## Commit and packaging

- Commit `6719b9aae` on `feat/omniroute-tier-dropdown-feat005` ("fix(code-index): cap embeddings requests and split on 5xx instead of replaying"), 7 files. The pre-commit hook ran prettier and `turbo lint` (11/11 successful). Not pushed.
- `pnpm vsix` (repo root) produced `bin/zoo-code-3.84.4.vsix` (1932 files, 33 MB). `extension/dist/extension.js` in the vsix contains the split-on-failure log string (grep count 1).
- `code --install-extension .../bin/zoo-code-3.84.4.vsix --force` reported that it installed successfully.
- Copied to `/Users/celes/sources/m5max-darwin-flake/packages/vscode-extensions/zoo-code-3.84.4-omniroute.vsix`. Both files have sha256 `163aa735b633ceee61c9810deef6ebde0ec44b0ec2865418e750d34b357de0a3`. The flake was not committed.

## Not verified here

- I did not test against a live OVMS server. The request sizes are proven only by the unit tests above.
- If an embedder skips an oversized item, `preparePoints` still misaligns vectors to blocks. That bug existed before this change and is out of scope here.
