# Byte-stable upstream prefix for llama-cpp/ds4 (GLM-5.3) in OmniRoute

Commit c4c83b892 on `feat/hybrid-reader-combo` removes the three OmniRoute-side prefix breakers that the root-cause report identified. Injected memory is frozen per conversation. Lite tool-result truncation is skipped for prefix-cache-sensitive routes. Client `reasoning_content` is forwarded unchanged to those routes. "Prefix-cache-sensitive" is a new provider-level predicate: on by default for `llama-cpp`/`llamacpp`, and overridable per connection through `providerSpecificData.cache.prefixCacheSensitive`. An end-to-end handleChatCore test shows turn 2's upstream messages start with turn 1's exact JSON bytes. The verification doc records that the test was red on the base commit and green with the change, plus lint and both typechecks clean. No changesets or CHANGELOG edits.

Watch for: the new gate covers only Lite's `compressToolResults`. The combo's opt-in fallback compression in `executeTargetAttempt.ts` calls `applyCompression` without the cache context, so a ds4 target reached as a fallback (i > 0) with zero-latency optimizations on would still be truncated (likely, config-dependent). The memory freeze is in-process only, so the first turn after an OmniRoute restart re-retrieves memories and can shift the prefix once (confirmed). Neither issue blocks the stated goal on the primary route.

**Verdict**: APPROVED

## High-level view

Memory takes option (a), freeze per conversation, keyed by `memoryOwnerId + (sessionAffinityKey || x-omniroute-session-id || conversationId)`. Zoo's OpenAI-compatible handler sends no session header, so in practice the key is `sessionAffinityKey`, i.e. the sha256 of the first user message. That message is stable within a Zoo task. The first retrieval is frozen, including an empty result, so memories never appear mid-conversation. The freeze applies to every provider and is documented in the module header and the verification doc. For llama-cpp, memory goes through the strict system-first path (merged into system message 0), so the cache-safe "before last user message" splice, which moves every turn, is never taken on this route.

Tool results take option (b): skip `compressToolResults` when `config.prefixCacheSensitive` is set. `resolveCacheAwareConfig` sets that flag from provider plus connection override. It reaches the in-process Lite path, the worker (through `workerOptions.config`), and stacked Lite steps (through `buildStepOptions` spreading `options`). The other Lite passes are left in place because they are deterministic per message. The documented rationale for not truncating at first send is sound: truncating at first send would cut the current turn's result and bring back the re-read loop.

For reasoning, the coder confirmed by probe that the base commit stripped `reasoning_content` on the `!isReasoner` OpenAI path, via both the echo-field loop and `filterToOpenAIFormat`. The fix skips only `reasoning_content` in the echo-field loop and passes `preserveReasoningContent` for sensitive routes. Nothing is synthesized. Generic OpenAI targets still strip it, and a control test proves that.

<details>
<summary>Issues (4)</summary>

1. **Combo fallback compression bypasses the gate** (likely, non-blocking): `executeTargetAttempt.ts` proactive fallback compression calls `applyCompression(attemptBody, fallbackCompressionMode, { model, bailout })` with no `config`/cache context. If ds4 is a fallback target and `zeroLatencyOptimizationsEnabled` is on, Lite still truncates earlier tool results. Check the hybrid/planner combo config, or pass `prefixCacheSensitive` there as well.
2. **Freeze lost on restart** (confirmed, non-blocking): the map is in-process. After an OmniRoute restart or redeploy, the next turn re-retrieves and may reorder `Memory context:`, which costs one full ds4 re-prefill per active conversation. Accept this as documented, or persist the freeze if restarts are frequent.
3. **Gate is Lite-only** (confirmed, non-blocking): `prefixCacheSensitive` does not neutralize other rewriting engines (caveman/standard/aggressive/stacked non-Lite steps). This is fine while the ds4 route runs `lite`. Document it next to `isPrefixCacheSensitive` so nobody switches the route's mode and expects stability.
4. **Generic session key can pin stale memory** (possible, non-blocking): when the key is the hash of a short, generic first message (e.g. "hi"), unrelated conversations share one frozen entry. Each hit refreshes the 6 h idle TTL, so they can share it indefinitely. This doesn't matter for Zoo tasks, whose first message carries `<task>` plus environment details.

</details>

<details>
<summary>Details</summary>

### Memory freeze keying and semantics

The freeze lives in `open-sse/handlers/chatCore/memoryFreeze.ts`: a Map with a 6 h idle TTL and LRU eviction at 1000 entries. Freezing happens only after a successful retrieval. A thrown retrieval falls into the existing catch and freezes nothing, so a transient DB error does not lock in "no memory" for the conversation. The key resolution in `chatCore.ts` reuses `sessionAffinityKey`, which `chat.ts` builds through `extractSessionAffinityKey` (headers, then body `metadata.session_id`/`conversation_id`/`prompt_cache_key`, then the first-user-message hash) with `sessionId` as the fallback. The verification doc notes one known wobble: a Zoo build that still compacts env-details in the first user message changes the hash once at turn 2. The Zoo-side change in this workflow addresses that.

Because the freeze is global across providers, memories saved mid-conversation (including via the `memory_save` builtin) are not visible until the next conversation. This trade-off is stated in the verification doc. It is a behaviour change for non-ds4 users and should be called out in release notes.

The cache-safe injection path (`injectMemory` with `cacheSafe`) splices the memory message before the last user message. That position moves every turn and would break the prefix even with frozen content. It is not reachable for llama-cpp, because `systemMessageMustBeFirst` routes llama-cpp to `injectSystemFirst`, which matches the report's observation that memory is merged into system message 0. A future opt-in connection on a non-strict provider (vLLM/Ollama with `prefixCacheSensitive: true`) that also sends `cache_control` would still hit the moving splice. That is outside the current target.

### Compression gate plumbing

```
chatCore: resolveCacheAwareConfig(config, body, {provider, connectionCacheOverride})
            └─ config.prefixCacheSensitive = isPrefixCacheSensitive(...)
          applyCompressionAsync(..., {config})
            ├─ worker: workerOptions.config ──► applyCompression ► applyLiteCompression({...options})
            ├─ in-process lite: applyLiteCompression({...options, ...config.lite})
            └─ stacked: buildStepOptions({...options}) ► lite engine adapter
          applyLiteCompression: skip compressToolResults if options.config.prefixCacheSensitive
```

All three primary routes carry `config`. The one caller that doesn't is the combo proactive fallback compression in `open-sse/services/combo/executeTargetAttempt.ts:275`. It is pre-existing code, but it defeats this change's guarantee whenever ds4 is reached as a non-first combo target with zero-latency optimizations enabled. `aggressive.ts`'s internal Lite fallback also omits `config`, but aggressive mode is not prefix-stable to begin with.

The override is validated in `providerSpecificData.ts`, survives both `normalizeCacheOverride` and `resolveConnectionCacheOverride`, and has a unit test for normalization round-trip.

### reasoning_content forwarding

The change in `translator/index.ts` is surgical. `keepClientReasoning` only prevents deletion, and the `isReasoner` replay branch, which can inject cached or placeholder reasoning, is untouched. That branch is not taken for `ds4-glm53`. The end-to-end test asserts both history assistant turns keep their `reasoning_content` byte-for-byte in the captured upstream body. The response-side stream code deletes `delta.reasoning_content` only in textual-tool-call conversion branches, and the report confirmed ds4's reasoning reached Zoo in response bodies, so the round trip depends on the Zoo `preserveReasoning` change, not on OmniRoute.

### Test coverage

`glm53-prefix-stability.test.ts` covers the required properties through the real handleChatCore pipeline with a captured upstream fetch. Across two turns of one conversation the leading messages are JSON-identical, even though a newer memory is created between turns. The 2.4K tool result is not truncated, reasoning is forwarded, a different conversation key gets a fresh retrieval, and an `openai` control still truncates. The verification doc shows red-on-base/green-on-change. `prefix-cache-sensitive.test.ts` covers the predicate, override normalization, the Lite gate, the `resolveCacheAwareConfig` flag set/unset, translator passthrough versus strip, and freeze hit/miss/TTL.

Not tested: the streaming path (the test uses `stream:false`; injection, compression, and translation run before the stream fork, so the risk is low), the worker-dispatched compression path specifically, combo-routed requests (`hybrid/planner` → ds4 via `executeTargetAttempt`), and live ds4 KV hit recovery (deferred to post-deploy verification). The one failing test in the llama-cpp sweep (`provider-node-reserved-prefix`, 414 !== 412) is recorded as failing identically on the base commit. No spot-check was run, since the evidence covered the doubts raised here.

</details>

<details>
<summary>File map</summary>

- `open-sse/handlers/chatCore.ts`: passes `conversationKey` into memory injection.
- `open-sse/handlers/chatCore/memoryFreeze.ts`: new per-conversation memory freeze (TTL + LRU).
- `open-sse/handlers/chatCore/memorySkillsInjection.ts`: reuses frozen memories, freezes the first retrieval.
- `open-sse/services/compression/cacheAwareConfig.ts`: sets runtime `prefixCacheSensitive`.
- `open-sse/services/compression/lite.ts`: skips `compressToolResults` when sensitive.
- `open-sse/services/compression/types.ts`: `prefixCacheSensitive` on `CompressionConfig`.
- `open-sse/translator/index.ts`: keeps client `reasoning_content` for sensitive routes.
- `open-sse/utils/cacheControlPolicy.ts`: `isPrefixCacheSensitive`, override field, resolution.
- `src/lib/providers/requestDefaults.ts`: preserves the override in normalization.
- `src/shared/validation/providerSpecificData.ts`: validates the override as boolean.
- `tests/unit/glm53-prefix-stability.test.ts`, `tests/unit/prefix-cache-sensitive.test.ts`: new tests.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute show c4c83b892`.

</details>
