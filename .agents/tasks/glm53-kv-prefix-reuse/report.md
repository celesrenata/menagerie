# GLM-5.3 (ds4-server :8082) re-prefills from token 0: root cause and fix ranking

Read-only investigation, 2026-10-03. No code, config, or service changes were made.

## Executive summary

Two things combine to make every turn re-prefill from 0.

1. ds4 cannot roll GLM-5.3 back to an arbitrary position. Three of every four GLM-5.3 trunk layers are KDA (Kimi Delta Attention), which is linear attention with a recurrent state and a conv state (`ds4_glm53_layer_is_kda`: `il % 4 != 3`, ds4.c:1003). Attention KV can be truncated. KDA state cannot, unless a snapshot was saved at that exact position. The only rewind ds4 implements for GLM-5.3 is the 2-token MTP rollback (`ds4_session_glm_mtp_rewind`, ds4.c:73944). So when the new prompt shares 95% of its tokens with the live KV but diverges anywhere before the live frontier, ds4 throws the session away. Truncating to `common` is not just unimplemented: it is impossible without state checkpoints. The disk KV cache is the only middle ground, and it is currently thrashing.
2. The client stack rewrites already-sent history on every turn, so every turn diverges. I diffed consecutive raw requests from OmniRoute `call_logs` for the same task and found four independent prefix breakers. The earliest one wins.
    - OmniRoute memory injection prepends `Memory context: …` to the system message. Its content and order are re-ranked per request. I observed a reorder mid-task, which breaks the prefix at about 5K tokens, just after the tool schemas.
    - OmniRoute Lite compression (`compressToolResults`) leaves the current turn's tool results whole. Once a newer assistant turn exists, it truncates them to 2000 chars plus `...[truncated]`. So last turn's full tool result is rewritten on the very next request. This was the breaker in the reported 24051/17429/16624 miss.
    - Zoo's `compactHistoricalEnvironmentDetails` (src/core/task/compactEnvironmentDetails.ts) deletes every `<environment_details>` block except the newest. That rewrites the tail of the previous prompt every turn: about 200–1700 tokens, or about 6K on turn 2 when the first block held the file listing.
    - Zoo drops `reasoning_content` for this profile (`preserveReasoning` is not set, Task.ts:5393). ds4 returned reasoning, but the next request omits it. ds4's GLM renderer then emits `<think></think>` where the live KV has `<think>…reasoning…</think>`.

Impact: since 2026-09-30, 438 of 453 GLM requests (97%) were live-KV misses, against about 34% before. The average re-prefill on a miss is about 36K tokens, or about 100 s at 350 tok/s. The disk cache can't soften this. Four stale checkpoints of 3.1–3.5 GB (13.3 GB) occupy the 16 GB budget, and fresh checkpoints get evicted before they are ever loaded (3552 `disk-cache-full` evictions against 3572 stores).

Fastest durable fix: make the prompt prefix byte-stable from the client side (options c and d below), and fix the ds4 disk cache config. All four client breakers must be fixed together. On GLM-5.3, any single remaining divergence still costs a full rebuild. Once they are fixed, a typical 17–23K-token turn should prefill only the new tail (about 1.5–3K tokens, 4–9 s) instead of 50–65 s.

## Ranked recommendations

Savings are per same-conversation turn at a 20K-token prompt, 350 tok/s prefill.

| #   | Option                                                                                                                                                                                  | Gain/turn                                                                                                                          | Effort                                                               | Notes                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | (c)+(d) together: stop all four rewrites (details below)                                                                                                                                | about 45–55 s (prefill only the new tail, about 1.5–3K tok)                                                                        | Low–medium: two small Zoo changes, two OmniRoute config/code changes | This is what produced 66% live hits before 09-28/09-30. It is all-or-nothing on GLM-5.3: one leftover breaker still means a full rebuild.                                                                                                                                                              |
| 2   | ds4 disk-cache hygiene: delete the 4 stale ~3.3 GB `.kv` files (Sep 25/Oct 1) or raise `--kv-disk-space-mb`; pin PR #1170 (+ #986)                                                      | about 20 s on misses that hit the 7K cold anchor                                                                                   | Trivial (cache file delete or flag change) / low (PR pin)            | Stops fresh checkpoints being evicted before reuse. The cache files are user data, so delete them yourself after confirming.                                                                                                                                                                           |
| 3   | ds4 flag: `--kv-cache-continued-interval-tokens 2048` (with a bigger disk budget)                                                                                                       | Worst-case loss drops to about 2K + tail, e.g. 17429/16624 → load 16384, prefill about 1K tok, about 3 s (saves about 47 s)        | Flag only                                                            | Costs about 50–150 ms and 300–700 MB of SSD writes per 2048 tokens crossed. That works out to roughly 100–300 GB/day of writes at current volume, so watch SSD wear. A stable prefix (option 1) makes this mostly unnecessary. It does not help when the divergence is at about 5K (memory injection). |
| 4   | (a) ds4 patch: in-RAM KDA/indexer-tail snapshots at message boundaries (e.g. last `<\|user\|>`/`<\|observation\|>` marker and prompt end), rewinding to the largest snapshot ≤ `common` | Same as option 3, without disk I/O                                                                                                 | High: engine C/Metal; no upstream PR exists                          | The building block is already there: `glm53_graph_copy_spec_state` copies exactly the KDA conv+recurrent state and the indexer tail into `mtp_state_backup` (ds4.c:51159). Estimated fixed state per snapshot is about 146 MiB, derived from the checkpoint file sizes.                                |
| 5   | (b) pin upstream PRs #1093 (GLM tool-turn visible key) + #727 (strip transient metadata)                                                                                                | Server-side tolerance for breakers 3 and 4 only                                                                                    | Medium: the two conflict mechanically in ds4_server.c                | Pointless while the OmniRoute breakers remain, since they diverge earlier. Use only if you don't want Zoo changes.                                                                                                                                                                                     |
| 6   | `--batched-session 2`                                                                                                                                                                   | Protects against task/mode switches thrashing the single slot (82 of 438 recent misses, plus the tiny 314/778-token side requests) | Flag                                                                 | ds4 disables MTP for GLM-5.3 when session batching is on (docs/SERVER.md). Decode speed cost is unmeasured. It also needs a second KV allocation.                                                                                                                                                      |
| ✗   | PR #1005 (rewind to `common`)                                                                                                                                                           | None for GLM-5.3                                                                                                                   | —                                                                    | Do not pin. It routes more misses into `ds4_session_rewind`, which fails for GLM-5.3 (`requires rebuild`). That path also skips the evict snapshot: `KV payload staging failed: session has no valid checkpoint to stage`.                                                                             |

### Concrete changes for option 1

- Zoo, env details (src/core/task/Task.ts:4994 calls `compactHistoricalEnvironmentDetails`; the function is in src/core/task/compactEnvironmentDetails.ts, added in e863c664f on 2026-09-30): stop compacting already-sent snapshots in the request path. Either keep history verbatim, as upstream Roo does, or compact only at condense time (condense/index.ts:339 already does that). This costs about 200 tokens of context growth per turn, but those tokens are cached.
- Zoo, reasoning: set `preserveReasoning: true` on the OmniRoute/GLM profile's model info. Task.ts:5393 then keeps reasoning blocks, and openai-format.ts:573-584 emits `reasoning_content`. ds4's GLM renderer re-renders it inside `<think>…</think>` for tool-context history (`append_glm_assistant_message_prefix`, ds4_server.c, `preserve_reasoning = think && (tool_context || i > last_user_idx)`). Trade-off: context grows by the reasoning tokens. Unverified: that OmniRoute forwards `reasoning_content` unchanged to llama-cpp.
- OmniRoute, compression: disable Lite `compressToolResults` for the llama-cpp/ds4 connection or combo (`hybrid/planner`). Alternatively, make it cache-stable by truncating the current-turn results too (`index >= currentTurnStart` is exempt today), so the bytes never change after first send. Code: `/app/open-sse/services/compression/compressionWorker.js`, `compressToolResults` (about line 66245), default `maxToolLength` 2000 / `OMNIROUTE_LITE_MAX_TOOL_LENGTH`. Another route is `connectionCacheOverride.supportsPromptCaching=true` on the connection, but I only confirmed that it gates quantum-lock, not Lite truncation.
- OmniRoute, memory: disable memory injection for this combo/connection, or freeze the injected memory text per conversation. Injection currently happens at the start of the system message, so any per-turn re-rank breaks the prefix at about 5K tokens.

## Evidence

### 1. ds4 reuse decision (antirez/ds4 @ 480f2ae, the pinned PR #1140 head)

- Reuse probe tiers, ds4_server.c:11520-11700 (`slot_probe_reuse_locked`): responses/anthropic id tiers, then `memory-rewind` (GLM only), `memory-token` (`common == live_pos`), `thinking-visible`, and `memory-text` (byte prefix of the rendered text).
- `live_prefix_rewind_target`, ds4_server.c:11951: `if (common != prompt_len) return -1; return prompt_len - 1;`. Rewind is only attempted when the prompt is a strict prefix of the live tokens. A mid-stream divergence (`common < prompt_len`) goes straight to miss.
- `trace_cache_miss_reason`, ds4_server.c:11839: `token-mismatch` means `common != old_pos`.
- Even when a rewind is attempted, `ds4_session_rewind`, ds4.c:85173-85230, has `state_ok = !s->glm_graph.glm53 || ds4_session_glm_mtp_rewind(s, pos);`. `ds4_session_glm_mtp_rewind`, ds4.c:73944, only accepts `pos == rollback_pos` or `rollback_pos+1` right after a 2-token MTP cycle. Otherwise `checkpoint_valid = false` and the request rebuilds from 0.
- Why rollback is impossible: GLM-5.3 KDA layers carry `layer_kda_conv_state` and `layer_kda_recurrent_state`, and attention layers carry `layer_indexer_tail_k` (index pool size 4) (`glm53_graph_spec_state_tensors`, ds4.c:51131; `glm53_graph_fixed_state_bytes`, ds4.c:39101). Upstream PR #1093 states the same thing: the GLM KV "cannot be rolled back by truncation".
- Miss path, ds4_server.c:13580-13615: log the miss, then `kv_cache_store_current(..., "evict")`, then `kv_cache_try_load` (the longest rendered-text prefix on disk).
- Disk checkpoint rules (ds4_kvstore.c:33-56, 705-752; ds4_server.c:13695-13730):
    - Cold store happens at the chat anchor (the last user marker before the first assistant, e.g. 7030/7035 here, i.e. system plus tools) when the prompt is ≤ 30000 tokens.
    - Continued store happens at multiples of `ceil(10000/2048)*2048 = 10240`.
    - Defaults: min 512, trim 32, align 2048.
- Eviction score: `(decayed_hits+1) * tokens/file_size`, ×2 for cold/evict/shutdown (ds4_kvstore.c:538-564). Small, fresh checkpoints have lower tokens-per-byte because of the about 146 MiB fixed state, so they lose to big stale files.

Log evidence (/Users/celes/ai/logs/glm53-dwarfstar-server.log):

```
1003 01:57:32 kv cache stored tokens=7035 trimmed=15832 reason=cold ... size=306.84 MiB
1003 01:59:11 live kv cache miss live=24051 prompt=17429 common=16624 vision=match reason=token-mismatch
1003 01:59:11 kv cache evicted reason=disk-cache-full tokens=7035 hits=0 size=306.84 MiB   <- the anchor it needed
1003 01:59:11 kv cache evicted reason=disk-cache-full tokens=17275 hits=0 size=540.67 MiB
1003 01:59:11 kv cache stored tokens=24051 trimmed=0 reason=evict ... size=695.39 MiB
1003 01:59:11 chat ctx=0..17429:17429 TOOLS prompt start                                  <- no disk hit
1003 02:00:01 chat ctx=0..17429:17429 TOOLS prompt done 50.080s
```

Strict-prefix rewind failing and losing the evict snapshot (46 occurrences):

```
1002 14:51:58 GLM live prefix rewind from 89104 to 69542 requires rebuild
1002 14:51:58 live kv cache miss live=89104 prompt=69543 common=69543 ...
1002 14:51:58 kv cache skipped tokens=69542 reason=evict because KV payload staging failed: session has no valid checkpoint to stage
1002 14:51:58 chat ctx=0..69543:69543 TOOLS prompt start
```

Disk cache contents (/Users/celes/ai/kv-cache/glm-5.3-flash, 16 GB of the 16384 MiB budget): `04d3881a…` 3.47 GB (09-25), `7bf941b7…` 3.49 GB (09-25), `cc34498b…` 3.25 GB (10-01), `103724bf…` 3.12 GB (10-01). That is 13.3 GB that never appears in recent hits.

Counts across the whole log: 3572 stores, 3552 `disk-cache-full` evictions, 360 disk hits, 880 `token-mismatch` misses, 46 `requires rebuild`.

Hit rate per period (from `prompt start` and `live kv cache miss` lines):

| Period       | Requests | Live misses | Avg prefill on non-miss |
| ------------ | -------- | ----------- | ----------------------- |
| before 09-30 | 1310     | 442 (34%)   | 3.5K tok                |
| since 09-30  | 453      | 438 (97%)   | —                       |

Daily miss share jumped on 09-28 (79 of 80). The Zoo compaction code was committed on 09-30 (e863c664f). The installed extension (~/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4, built 10-03) contains it. I could not determine exactly which Zoo build ran on 09-28/29.

Miss classification (my heuristic over prompt start and miss pairs):

| Category                       | Before 09-30 | Since 09-30 | Avg re-prefill (since 09-30) |
| ------------------------------ | ------------ | ----------- | ---------------------------- |
| Same-conversation tail rewrite | 236          | 327         | about 36K tok                |
| Task/mode switch               | 189          | 82          | about 38K tok                |
| Strict-prefix (rewind failed)  | 17           | 29          | about 55K tok                |

In same-conversation misses, `prevPrompt − common` averages 1347 tokens. So the divergence lands inside the previous turn's tail, not in the new content.

### 2. Upstream state (github.com/antirez/ds4; main = 0aaea5a, 2026-09-20; pinned 480f2ae = PR #1140 head)

All PRs below are open and unmerged. "Applies on 480f2ae" means a local test merge succeeded.

| PR                                                                                                                               | What it does                                                                                                | Applies on 480f2ae?                                            | Helps GLM-5.3 here?                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [#1005](https://github.com/antirez/ds4/pull/1005) server: live prefix rewind for GLM-5.3, rewind to `common`                     | Lets rewind target `common` instead of only strict prefixes                                                 | Yes                                                            | No. The engine can't restore KDA state, so it just hits `requires rebuild` plus a skipped evict snapshot. |
| [#1093](https://github.com/antirez/ds4/pull/1093) keep the GLM live checkpoint across tool turns                                 | Remembers a visible key so a follow-up that drops reasoning still reuses live KV (measured 765 → 84 tokens) | Yes                                                            | Covers breaker 4 (reasoning dropped) only                                                                 |
| [#727](https://github.com/antirez/ds4/pull/727) keep live KV reusable when clients strip transient metadata blocks               | Handles `<environment_details>` / `<system-reminder>` stripping via a visible key                           | Yes, but conflicts with #1093 (adjacent edits in ds4_server.c) | Covers breaker 3 only                                                                                     |
| [#1170](https://github.com/antirez/ds4/pull/1170) keep the disk checkpoint the next request loads when storing an evict snapshot | Protects the checkpoint the next request will load from eviction                                            | Yes                                                            | Yes, fixes exactly the 01:59:11 eviction above                                                            |
| [#986](https://github.com/antirez/ds4/pull/986) age the eviction value of unused checkpoints                                     | Lets never-hit checkpoints lose value over time                                                             | Yes                                                            | Yes: stale 3 GB files would age out                                                                       |
| [#903](https://github.com/antirez/ds4/pull/903) continued checkpoints after crossed interval frontiers                           | Writes continued checkpoints when an interval boundary is crossed                                           | Not tested                                                     | Possibly; more reliable continued stores                                                                  |

No upstream PR or issue implements arbitrary-position KDA state checkpoints or rollback for GLM-5.3. The related work I found was #1003 (DSpark snapshots, DeepSeek), #1089 (V4.1 rewind), and #1000.

### 3. Client side: raw request diffs (OmniRoute call_logs, combo `hybrid/planner` → `llama-cpp/ds4-glm53`)

Pair A/B, the exact miss above: `2026-10-03T08-59-11.148Z_e3979df8` (in=22867, 17 msgs) → `2026-10-03T09-01-05.066Z_d55630ee` (in=17429, 19 msgs). Both come from the same task.

- clientRawRequest (what Zoo sent): msgs 0–15 are identical. In A, msg 16 is an env-details-only user message; in B it is gone, because Zoo compaction removed it and B has the assistant turn at index 16. In B, the assistant msg 16 has keys `content, role, tool_calls` with no `reasoning_content`, although A's responseBody contained `reasoning_content`.
- providerRequest (what ds4 got): first difference is at msg 15 (tool, `parallel_tasks` result). It was 20935 chars in A (the current turn, so exempt) and 2226 chars in B, ending `...[truncated]`. This is OmniRoute `compressToolResults` with `MAX_TOOL_LENGTH` 2000. That is the `common=16624` point. The summary shows `compressed` tokens rising from 5020 to 9696.
- OmniRoute also prefixes the system message with `Memory context: …` (+225 chars) and rewrites tool messages (+28 chars). Both were identical between A and B in this pair.

Same-task sequence 2026-10-03 05:56–06:02Z (same tools hash, system `912d48`):

- 05:56:50 → 05:57:22: the provider system message changed while the client system message was unchanged. The memory lines were reordered (`reapply an already-integrated patch` moved). ds4 log: `live=12089 prompt=11297 common=5076`. That is a divergence just past the tool schemas.
- 05:57:57 → 05:58:49: the client first diff is at prevLen−1, the env-details message removed by Zoo.
- 05:59:57, 06:00:51, 06:02:00: the provider first diff is at the previous turn's tool message (13, 18, 23). OmniRoute truncated those. The client first diff is at the env message (17, 22, 29).

Code references:

- Zoo: src/core/task/compactEnvironmentDetails.ts (whole file); Task.ts:4994 (applied to every API request); getEnvironmentDetails.ts:240-279 (the first turn includes the workspace file list; every turn includes the current time and reminders); Task.ts:5387-5420 (reasoning stripped unless `preserveReasoning`); openai.ts:115-133 (the OmniRoute profile uses `convertToOpenAiMessages`).
- OmniRoute: compressionWorker.js `compressToolResults` (`if (index >= currentTurnStart) return msg;`), LITE_SCHEMA `maxToolLength` default 2000. Memory docs: `injectMemory` joins memories into `Memory context: …` and prepends it as system. Retrieval sorts by score desc, then createdAt desc, so the result depends on the query.

## What I could not verify

- Whether OmniRoute passes `reasoning_content` through to llama-cpp unchanged once Zoo sends it.
- Whether, once all four breakers are gone, the GLM tool-call re-render matches the live DSML exactly. The `memory-text` and exact-DSML-replay tiers should cover it, and the 66% pre-09-28 hit rate suggests they do, but I did not test it.
- The decode-speed cost of `--batched-session` (MTP off) for GLM-5.3.
- The exact KDA snapshot size. The about 146 MiB figure is extrapolated from checkpoint sizes: 7030 tok = 306.7 MiB, 24051 tok = 695.4 MiB.
