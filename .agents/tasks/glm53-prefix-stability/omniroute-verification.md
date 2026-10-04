# OmniRoute GLM-5.3 prefix stability: verification (iteration 1)

Repo: /Users/celes/sources/celesrenata/OmniRoute, branch feat/hybrid-reader-combo, based on bb7a38057 (deployed 3.8.60-r2). Not deployed. No changesets, no CHANGELOG.

## Decisions

Memory: option (a), freeze per conversation.

- New `open-sse/handlers/chatCore/memoryFreeze.ts`: in-process map keyed by `memoryOwnerId + conversationKey`. It has a 6 h idle TTL and is LRU-capped at 1000 entries.
- `injectMemoryAndSkills` takes a new `conversationKey`. The first request of a conversation retrieves memories as before and freezes the result, including an empty result, so memory never appears mid-conversation. Later turns reuse the frozen memories verbatim and skip retrieval.
- `chatCore.ts` passes `sessionAffinityKey || x-omniroute-session-id || conversationId`.
- Conversation id source: Zoo's OpenAI-compatible handler, which the OmniRoute profile uses, sends no task/session header. `X-Zoo-Task-ID` exists only in the zoo-gateway handler and `X-Zoo-Session-ID` only in the litellm handler (checked in the installed zoo-code-3.84.4 dist/extension.js and in menagerie src/api/providers/openai.ts).
- So the effective key is `sessionAffinityKey`. chat.ts derives it from `x-session-id`/`x-codex-session-id`/`x-omniroute-session` headers, body `metadata.session_id`/`conversation_id`/`prompt_cache_key`, or else sha256 of the first user message. The first user message is stable within a Zoo task. The one exception: a Zoo build that still compacts the env-details block in that message changes the key once at turn 2, which costs one re-retrieval; the key is stable after that.
- The freeze applies to every provider, since it helps every prefix cache. The visible effect: memories saved or re-ranked mid-conversation are not injected until the next conversation.

Lite tool-result compression: skip it for prefix-cache-sensitive connections. This is the cleaner of the two options. Truncating at first send would cut the current turn's result, which the model asked for, and re-introduce the re-read loop that the current-turn exemption fixed. The skip touches only sensitive routes.

- `cacheControlPolicy.ts`: new `isPrefixCacheSensitive(provider, override)`. It defaults to true for `llama-cpp`/`llamacpp`. A per-connection override is available as `providerSpecificData.cache.prefixCacheSensitive: boolean`, so vLLM-APC or Ollama connections can opt in and llama-cpp can opt out. The override is validated in `providerSpecificData.ts` and preserved by both `normalizeCacheOverride` copies in `requestDefaults.ts`.
- `resolveCacheAwareConfig` sets a runtime-only `config.prefixCacheSensitive`. `applyLiteCompression` then skips `compressToolResults` regardless of the global or per-step toggle. The flag reaches the compression worker through `options.config`. The other Lite passes (whitespace, dedup, redundant-remove, image placeholder) are unchanged. They are deterministic per message, so they produce the same bytes every turn.
- The ds4 connection 70b82fc9-6f96-41ac-aa16-8da6099dd7ac is provider `llama-cpp`, so it is covered by default with no config change. No combo-level switch was added.

reasoning_content: verified that OmniRoute stripped it. Before the fix, a probe through `translateRequest(openai→openai, provider "llama-cpp")` deleted `reasoning_content` from every assistant history turn. `requiresReasoningReplay` is false for `ds4-glm53`, so the `OPENAI_INCOMPATIBLE_ECHO_FIELDS` strip and the `filterToOpenAIFormat` tool-call strip both applied. Fix in `translator/index.ts`: when `isPrefixCacheSensitive`, keep the client's `reasoning_content` (it is not added or synthesized) and pass `preserveReasoningContent` to `filterToOpenAIFormat`. The other echo fields are still stripped. Generic openai targets are unchanged.

## Tests added

- `tests/unit/glm53-prefix-stability.test.ts`: drives handleChatCore twice for one conversation (provider llama-cpp, memory on with strategy "recent", compression lite with compressToolResults on). A newer memory is created between turns. Turn 2's first N upstream messages are JSON-byte-identical to turn 1's: the frozen memory system message, the 2.4K tool result untruncated, and reasoning_content forwarded. A different conversation key gets a fresh retrieval. Control case: provider openai still truncates the earlier tool result. Confirmed red on the base commit (`message 0 unchanged`, the memory reorder) by stashing src/open-sse changes, and green with the change.
- `tests/unit/prefix-cache-sensitive.test.ts`: provider default and override, override normalization, the Lite gate, resolveCacheAwareConfig flag set/unset, translator reasoning passthrough for llama-cpp versus the generic strip, and freeze hit/miss/empty/TTL.

## Commands run and results

All commands ran from the repo root with `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=4`.

1. Focused run, 169 files, 1466 tests, 1466 pass, 0 fail. Files:
    - the two new files
    - `tests/unit/issue-13429-lite-redundant-remove-tool-call-id.test.ts`, `8169-lite-word-boundary-truncation.test.ts`, `compression-cache-guard-3955.test.ts`, `connection-cache-override-6880.test.ts`, `chatcore-memory-skills-injection.test.ts`, `chatcore-sanitization.test.ts`, `cache-signature-roundtrip.test.ts`, `provider-validation-specialty.test.ts`
    - `tests/unit/compression/{prefix-freeze,cache-aware-preserve-mode,strategySelector-cache-aware,lite,lite-current-turn,preserve-system-prompt-mode-db,db}.test.ts`
    - every `tests/unit/*reasoning*`, `*memory*`, `tests/unit/memory/*`, and `tests/unit/translator/*` file matching reasoning/memory/openai-format/filter (152 files)
2. Every unit test file mentioning llama-cpp (14 files) plus `tests/unit/translator/**/*.test.ts`: 244 tests, 243 pass, 1 fail. The failure is `provider-node-reserved-prefix.test.ts` "shared set size…" (414 !== 412). It is pre-existing and unrelated: it fails identically on the base commit with my changes stashed.
3. Lint: `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0` on all 10 changed source files and both new tests. Exit 0, no output, suppressions not increased.
4. Typecheck:
    - `npm run typecheck:core`: exit 0.
    - `npm run check:open-sse-typecheck`: exit 0, `openSseTypecheckErrors=0`.
    - A full `tsc -p tsconfig.json` ran out of memory (node heap abort, exit 134) before reporting anything. It was not used as evidence.
5. Full suite: not run, to spare the Mac CPU. Focused coverage above.

## Not verified

- Live ds4 behaviour: whether live KV hits actually recover. Deferred to live-verify after deploy. The Zoo-side env-details and preserveReasoning fixes are WIP in menagerie and also required.
- Streaming path: the pipeline test uses stream:false. Memory/compression/translation run before the stream fork, so they are the same code.
