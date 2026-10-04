# Verification: embed-summary-cap

Worktree `/Users/celes/sources/celesrenata/OmniRoute/.worktrees/embed-summary-cap`, branch `fix/embed-summary-cap` (base `c4c83b892`). Commits:

- `2226275c8` fix(embeddings): cap per-item tokens for arc-embed/ovms-arc
- `fb41c23f9` fix(memory): chunk long texts before embedding
- `5b30a1ea3` fix(memory): don't resend embeds after timeout/5xx
- `a2169c18f` fix(combo): respect prefix-cache gate on fallback compression

## Design choices (as implemented)

- Memory chunking (`src/lib/memory/embedding/chunking.ts`): the data model keeps one vector per memory (sqlite-vec `vec_memories` and one Qdrant point per memory id). Texts over 12,000 chars are split into at most 3 chunks. Boundaries prefer `\n\n`, then `\n`, then whitespace in the back half of the window, then a hard cut. Each chunk is embedded as its own request, sequentially. The chunk vectors are L2-normalized, mean-pooled, and renormalized. Retrieval queries go through the same path, so query and stored vectors share one space. A text of 12k chars or less takes the unchanged single-request path, and its raw vector is returned as-is (Qdrant keeps raw doubles), so existing vectors need no reindex. Splitting is char-based because the repo has no tokenizer helper. This replaces the old 20k clip in `embedRemote`, and the maximum embedded text is now 36k chars.
- Per-item cap (`open-sse/handlers/embeddingBatchSplit.ts`, `embeddings.ts applyEmbeddingItemCap`): the cap is active for split-enabled providers (`arc-embed`, `ovms-arc` by default). It defaults to 4096 estimated tokens (chars ÷ 3, or one per token id). It is set globally by `OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS` or per provider by the third field of `id=maxItems:maxPaddedTokens:maxItemTokens`. `OMNIROUTE_EMBEDDING_ITEM_OVERFLOW` controls what happens to an item over the cap:
    - `auto` (default): internal callers (`internalCaller: true`, set only by `embedRemote` and Qdrant `embedText`) get the item truncated with a warning. External callers get HTTP 400, which names the item index, the estimate, the cap, and the env var. The 400 does not cool down the connection.
    - `truncate` or `reject` applies that one behavior to every caller.

    The cap runs before any dispatch, so every upstream request, sub-batch, halved re-split, and combo target sees only capped items.

- No unchanged resend: in the handler, timeouts are never resent and a 5xx sub-batch is halved once (existing behavior). With the cap in place, no request can carry the original oversized item. In memory, `EmbeddingError.status` is now set on non-OK responses, and `embedWithRetry` returns immediately on `timeout` or `status >= 500`, which leaves the item to `needs_reindex` and the sweep. `rate_limited`, network errors without a status, and 4xx are still retried once.
- Combo fallback gate: when a proactive fallback compression target is prefix-cache-sensitive (`isPrefixCacheSensitiveTarget`: llama-cpp by default, or a connection `cache.prefixCacheSensitive` override read through the cached connection read), that compression is skipped and an info line is logged. Skipping is used rather than passing a hand-built config. The target's own chatCore compression still applies the gated config.

## Commands run and results

Single test file runner: `DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/<file>.test.ts`

| Command                                                                                                                | Result                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embeddings-item-cap` (new)                                                                                            | 11/11 pass                                                                                                                                                                   |
| `embeddings-batch-split` (limits expectations gain `maxItemTokens`)                                                    | 13/13 pass                                                                                                                                                                   |
| `embeddings-handler`                                                                                                   | 10/10 pass                                                                                                                                                                   |
| `memory-embed-summary-chunking` (new)                                                                                  | 8/8 pass                                                                                                                                                                     |
| `memory-embedding-remote`                                                                                              | 10/10 pass                                                                                                                                                                   |
| `npx vitest run src/lib/memory/__tests__/qdrant-wiring.test.ts`                                                        | 17/17 pass                                                                                                                                                                   |
| `13601-embed-retry` (+4 cases)                                                                                         | 7/7 pass                                                                                                                                                                     |
| `combo-routing-engine` (+1 case)                                                                                       | 92/92 pass. The new case fails (91/92) with the `executeTargetAttempt.ts` fix reverted.                                                                                      |
| `prefix-cache-sensitive` (+1 case)                                                                                     | 8/8 pass                                                                                                                                                                     |
| `glm53-prefix-stability`                                                                                               | 2/2 pass                                                                                                                                                                     |
| `combo-attempt-body-isolation-7847`                                                                                    | 7/7 pass                                                                                                                                                                     |
| `npm run typecheck:core`                                                                                               | clean                                                                                                                                                                        |
| `npm run typecheck:noimplicit:core`                                                                                    | 1 error, `open-sse/services/combo/autoStrategy.ts(519,55) TS7006`. It is pre-existing: that file is untouched, and the error reproduces with my uncommitted changes stashed. |
| `npx eslint --suppressions-location config/quality/eslint-suppressions.json <all 16 changed .ts files>`                | 0 errors, no suppression changes                                                                                                                                             |
| `npx prettier --check <all changed .ts/.md files>`                                                                     | clean                                                                                                                                                                        |
| `npm run check:env-doc-sync`                                                                                           | in sync                                                                                                                                                                      |
| `npm run check:complexity-ratchets` (run with a temporary `node_modules -> ../../node_modules` symlink, since removed) | OK (complexity 2966 against a 3218 baseline, cognitive 1352 against 1437)                                                                                                    |

Coverage of the required tests:

- Summary chunking: a 20k-char summary gives 2 or more chunks, each ≤12k and ending on `\n\n`. `embedRemote` sends every chunk and returns the pooled vector.
- Per-item cap truncates or rejects as designed: internal truncate, external 400 with zero fetches, the env overrides, token arrays, and per-provider and global caps.
- No unchanged retry of an oversized item: a 503 re-split never carries the 20k string, a single over-cap 503 is sent once truncated, a timeout is sent once, and `embedWithRetry` does not resend after a timeout or 5xx.
- Combo fallback respects the gate: a `llama-cpp/glm-5.3` fallback keeps the full tool output, while the existing non-sensitive test still truncates.

Not verified by a spy: "no DB read without connectionId" in `isPrefixCacheSensitiveTarget`. This holds by construction, because the read only sits inside `if (target.connectionId)`. The test covers only the provider-default results.

## Full unit suite (`npm run test:unit`)

The first launch was killed by the tool's 120 s timeout (5,497 tests cancelled), so it was not a valid run. The detached rerun is the one real run. Its first phase reported `tests 45059, pass 45005, fail 25, cancelled 0`. That phase exited 1, so the dashboard and serial phases did not run.

None of the 25 failures involve the changed code (embeddings, memory embedding, combo fallback compression). They fall into four groups:

- **Pre-existing on base `c4c83b892`.** I re-ran these with `open-sse/` and `src/` checked out at base: `memory-tools` (2 tests) and `call-log-file-rotation` (1 test). Also the known `provider-node-reserved-prefix` failure (414 !== 412).
- **Flaky under load.** `usage-history-provider-alias-13459` and `usage-pending-sweep` pass on HEAD when run alone. Rerunning `usage-pending-sweep` twice on HEAD gave one pass and one fail.
- **Build and packaging layout.** The worktree has no local `node_modules` and resolves from `../../node_modules`. These tests check esbuild, tsx, bundles, standalone builds, and the binary layout: `binaryManager`, `build-tool-runner-win-shim`, `colocate-standalone-esm-scope`, `mitm-server-bundle-contents`, `db-health-packaging`, `mcp/bundle-no-sync-esm-await` (2), `tsx-runtime-transform-5757`, `tls-profiles-valid-5591`, `cli-companion-types`, `cli-setup-opencode-nested-alias-7682`, `cli/alias-resolver-12073`, `cli-runtime-detection`, `client-bundle-no-server-only-10692`, `run-eslint-json-suppressions`, `check-provider-asset-provenance`, `provider-translate-path-golden`.
- **Network or timing.** `relay-completions-errors` (Bifrost 404, a 6 s timeout) and `uc-video`, which passes 16/16 when run alone.

None of these touch files changed on this branch. I did not re-run the full suite.

## Integration onto feat/hybrid-reader-combo

Gate checks, all passing:

- (a) `omniroute.yaml:61` image is `registry.celestium.life/library/omniroute:3.8.61-prefix-stable-20261003`.
- (b) `.agents/tasks/glm53-prefix-stability/live-verify.md` exists.
- (c) `feat/hybrid-reader-combo` HEAD was `c4c83b892` on two checks 30s apart.

Steps:

- `git rebase feat/hybrid-reader-combo` in the worktree: already up to date, because the branch base was `c4c83b892`. No conflicts.
- `git merge --ff-only fix/embed-summary-cap` on the main checkout (clean, on `feat/hybrid-reader-combo`): fast-forward `c4c83b892..a2169c18f`, 19 files. Not pushed.

Resulting `feat/hybrid-reader-combo` HEAD: `a2169c18fae93e84ef471469b6d6612077397b22`

Focused tests, run on the main checkout at the merged HEAD:

| Test                                               | Result     |
| -------------------------------------------------- | ---------- |
| `memory-embed-summary-chunking` (summary chunking) | 8/8 pass   |
| `embeddings-item-cap` (per-item cap)               | 11/11 pass |
| `embeddings-batch-split`                           | 13/13 pass |
| `13601-embed-retry` (no unchanged retry)           | 7/7 pass   |
| `combo-routing-engine` (combo fallback gate)       | 92/92 pass |
| `prefix-cache-sensitive`                           | 8/8 pass   |

The full suite was not run, as instructed.
