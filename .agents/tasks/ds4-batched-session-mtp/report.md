# ds4 `--batched-session 2` vs GLM-5.3 MTP: why it's off, what it costs, how to get both

Read-only investigation, 2026-10-03. Source: antirez/ds4 @ `480f2ae` (the pinned PR #1140 head, cloned to /tmp/ds4-inv). Nothing was changed. Line numbers refer to that rev.

## Executive summary

1. **It's unimplemented, not a fundamental limit.** In batched mode the server only takes the speculative path when `s->qwen4_batch_mtp` is true, and that flag is hard-coded to Qwen3.8 (ds4_server.c:15966-15967). For GLM, every decode then goes through plain `server_eval_token`. All the GLM MTP state lives per session: `ds4_session` embeds its own `ds4_glm_gpu_graph glm_graph` (ds4.c:60232), and `mtp_state_backup` plus the MTP caches are allocated per graph (ds4.c:51194-51213). The engine also already has a sequential per-session speculative fallback inside the batch API, and for GLM it calls `ds4_session_glm_spec_cycle` (ds4.c:80066-80081 → 84199). The server just never sends GLM there.
2. **Stock `--batched-session 2` with `--mtp` is the worst combination for GLM-5.3.** MTP goes off for every request, even when only the orchestrator is active (the gate is `!s->batched_mode`, ds4_server.c:14001). Native row batching is also refused whenever `--mtp` is loaded (`e->glm_mtp`, ds4.c:79037), and past 2051 tokens it's unsupported anyway. Our prompts are 17-35K tokens. So two active slots run in the ordered fallback: no MTP and no batching gain. Expected speed: about 17-22 tok/s solo (down from 20-28), about 9-11 tok/s each with two active. Memory: about +5.5 GB for the second slot, because GLM gets no shared prefill workspace. The box is already about 10 GB into swap.
3. **No upstream PR adds GLM batched MTP.** The nearest work is Qwen-only (#1062, effectively merged as `qwen4_batch_mtp`) or DeepSeek-only (#604, #799). Reuse-aware slot routing (#765, fixed by 4067320) is already in our pin, so a second slot really would keep the orchestrator resident.
4. **Recommendation:** a small local patch (about 5-10 lines in ds4_server.c, layered on #1140) that extends the batched-MTP flag to GLM-5.3 on Metal. With one active request, speed stays at today's 20-28 tok/s. With two active, each gets about 10-14 tok/s (aggregate ≈ one stream), both with MTP. The cost is about +5.5 GB unified memory. The cheaper alternative needs no code: drop `--batched-session` and rely on the disk KV evict→restore that already exists. Restores take 30 ms-1.4 s even at 133K tokens. To make that work, fix the disk-cache thrash (prior report, option 2 / PR #1170). That covers "don't lose the orchestrator" without the memory cost. It just doesn't give concurrency.

## 1. Why batched mode disables MTP for GLM-5.3

Docs, docs/SERVER.md:88-91 (paraphrased): session-batched serving uses ordinary target decoding, except Qwen3.8 on Metal, whose `--mtp` also batches speculative decoding. Other models don't use MTP/DSpark while session batching is active. docs/SPECULATIVE_DECODING.md:106 repeats this. The startup log line is "MTP speculative decoding is disabled while native session batching is active" (ds4_server.c:16023-16026).

Code path:

- `s.qwen4_batch_mtp = backend == METAL && ds4_engine_is_qwen4(engine) && ds4_engine_mtp_draft_tokens(engine) > 1;` (ds4_server.c:15966-15967).
- Decode loop (ds4_server.c:14001-14035):
    - Branch 1: `if (!s->batched_mode && mtp_draft_tokens > 1 && !DS4_MTP_SPEC_DISABLE)` → `ds4_session_eval_speculative` (the path we use today).
    - Branch 2: `else if (s->batched_mode && s->qwen4_batch_mtp && room >= 2 && !ignore_eos && (!exact_sampling || temp == 0))` → `server_eval_tokens(..., speculative=true)`.
    - Otherwise: `server_eval_token` (plain).
    - For GLM in batched mode, branch 2 is never taken. The gate is static (`batched_mode`), not "more than one generation active", so a lone orchestrator also loses MTP.
- The decode coordinator (`decode_worker_main`, ds4_server.c:13298-13392) already splits each tick into a plain group (`ds4_sessions_eval_batch`) and a speculative group (`ds4_sessions_eval_batch_speculative_argmax`).
- `ds4_sessions_eval_batch_speculative_argmax` (ds4.c:79895) has a Qwen-native batched-MTP block under `#ifdef DS4_HAS_QWEN4_METAL`. Every other model falls to "Sequential fallback: one speculative cycle per session" (ds4.c:80066-80081). That fallback calls `ds4_session_eval_speculative_argmax`, which for GLM runs `ds4_session_glm_spec_cycle` (ds4.c:84199).

Is it fundamental? No.

- GLM MTP state is per session. `struct ds4_session` holds `ds4_glm_gpu_graph glm_graph` by value (ds4.c:60232). `mtp_state_backup`, `mtp_kv_lora_cache` and `mtp_selected` are graph members allocated in `glm_graph_mtp_ensure` (ds4.c:51194-51213). `glm53_graph_copy_spec_state` (ds4.c:51159) saves and restores only that graph's KDA conv/recurrent and indexer-tail tensors. Two sessions never share rollback state.
- All backend calls are serialized under the recursive `inference_mu`. So per-session spec cycles interleave safely, just as plain ordered-fallback decodes do today.
- What is genuinely unimplemented is _native_ batched GLM MTP: one forward over both sessions' verify rows. That would need multi-session KDA/indexer verify kernels. GLM native batching is also capped at 2051 visible tokens (docs/SERVER.md:76; QA_BEFORE_RELEASES.md:562-569 requires the ordered fallback past 2051 until a sparse batch oracle exists). At our prompt lengths, native batching wouldn't apply even without `--mtp`.

Semantics of the fallback: it uses the argmax verifier with the server's already-sampled first token. Drafts are accepted when they match the target's greedy continuation. That is the same "opportunistic" scheme the docs describe for non-exact sampling (docs/SPECULATIVE_DECODING.md "Sampling and reproducibility"). We don't run `--mtp-exact-sampling`, so temperature>0 requests would still take the speculative group. Commit width is 2, the same as today's GLM cycle (docs/SPECULATIVE_DECODING.md:57).

## 2. What `--batched-session 2` changes (stock code)

| Feature                  | Effect at pinned rev                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MTP                      | Off for all requests, including a lone active one (ds4_server.c:14001). The PR #892 bring-up on M5 Max (ctx 8192) measured serial 33.0 vs MTP 40.5 tok/s, so MTP is about +23%. Our 20-28 tok/s at 17-35K would drop to about 17-22 tok/s (estimate, not measured here).                                               |
| Native session batching  | Refused for GLM with `--mtp` (`e->glm_mtp`, ds4.c:79037), and beyond 2051 tokens in any case. Result: ordered fallback (ds4.c:80139-80150), which docs/SERVER.md:81 says gives fairness, not aggregate speedup. Two active slots get about half each.                                                                  |
| Prefill chunking         | Unchanged when idle (quantum 2048, ds4_server.c `server_prefill_quantum_for`). While another slot decodes, prefill yields every 1024 tokens (GLM-5.3 floor) instead of 128. The decoding slot stalls up to about 3 s per prefill slice at 350 tok/s.                                                                   |
| Shared prefill workspace | Doesn't apply to GLM. `share_session_prefill_workspace` (ds4_server.c:15884) is used only by the Qwen arena (ds4.c:72887) and the DeepSeek `metal_graph` path (ds4.c:73103-73135). The GLM branch allocates a full private `glm_graph_alloc_slice` and returns first (ds4.c:72995, 73086).                             |
| Metal graph / kernels    | Same kernels. Ordered fallback runs the normal single-session decode per row.                                                                                                                                                                                                                                          |
| Disk KV cache            | Still works. Each slot keeps its own live state, and disk is the shared persistence layer (docs/SERVER.md disk section).                                                                                                                                                                                               |
| Vision                   | Engine-level encoder, shared. GLM is already in ordered fallback, so no extra penalty.                                                                                                                                                                                                                                 |
| Slot routing             | Reuse-aware at our pin (`job_slot_score`, ds4_server.c:14837; commit 4067320 is an ancestor of 480f2ae; test `test_dispatch_routes_alien_request_to_empty_slot`, ds4_server.c:16705). A worker request that shares only the system prompt goes to the empty or stale slot, not the orchestrator's (fixes issue #1069). |

Memory:

- From the log at the latest start: "context buffers 5110.50 MiB (ctx=163840…)". That is KV 1.83 GiB compact DSA plus 3.16 GiB buffers, plus 256 MiB score scratch. MTP adds about 160 MiB `mtp_kv_lora_cache` (163840×512×f16) plus about 146 MiB `mtp_state_backup` per session.
- So a second slot at `--ctx 163840` costs about **+5.4-5.6 GB**. All slots share one `--ctx`, so we can't give the worker a smaller context in the same process.
- Live process (pid 51607, `footprint`): 5,645 MB physical footprint (5,411 MB IOAccelerator). The 92,026 MiB model is MAP_SHARED, file-backed and wired via the Metal residency set, so it doesn't show in footprint.
- System state right now:
    - wired 6,415,674 pages ≈ 97.9 GiB
    - compressor ≈ 8.6 GiB
    - swap 10.18 GB used of 11.26 GB
    - free ≈ 100 MiB, `memory_pressure` "free percentage 15%"
- +5.5 GB more wired/GPU memory will push other processes harder into swap and compression. It fits, but it is the main risk.

## 3. Alternatives that keep MTP

a) **Two ds4-server processes** (e.g. :8083, no `--vision`, `--ctx 65536`, no `--batched-session`).

- Weights: ds4 maps the GGUF `MAP_SHARED`/`PROT_READ` on Metal (ds4.c:2880-2881). File pages in the unified buffer cache are shared physical pages, so the 90 GiB should not double. This is unverified: each process builds its own `MTLResidencySet` (ds4_metal.m:2142-2161), and I didn't confirm whether IOGPU accounts or wires the shared pages twice. Test it with `vm_stat` wired-page deltas before relying on it.
- Extra cost: about 3.5-4.5 GB at ctx 65536 (≈0.75 GiB KV plus about 3 GiB buffers plus MTP), and about 1 GB more if it also loads vision. Startup residency takes about 13 s.
- Pros: both instances keep full MTP, no patch, and routing is explicit. OmniRoute sends workers to :8083, so the orchestrator is never touched (true session pinning).
- Cons: two processes compete for the GPU without coordination. Each likely drops to about half speed when both decode; PR #799's multi-queue overlap result hints there may be some overlap, but that's unmeasured. They also keep separate disk caches (use a different `--kv-disk-dir`) and need a second launchd service. Risk: medium (memory accounting unknown).

b) **Session pinning / affinity.** Not needed as a feature. Reuse-aware routing is already in the pin (see §2). PR #930 `--max-active-requests` (OPEN, CONFLICTING) only does admission control.

c) **Snapshot/restore via the existing disk cache (no second slot).** This already exists. When a worker request takes the single slot, the miss path stores the orchestrator's live state (`reason=evict`) and the next orchestrator request reloads it (prior report: ds4_server.c:13580-13615).

- Measured restore times in our log: 30-180 ms at 4-25K tokens, worst 1.39 s at 30K, 541 ms at 133K tokens. Evict saves take 100-500 ms.
- It currently fails for two reasons:
    - The 16 GB budget thrashes: 3,554 `disk-cache-full` evictions.
    - The evict snapshot is skipped when the session is invalid after a failed GLM rewind (46 cases).
- Fixing those (prior report option 2: bigger budget, delete stale files, PR #1170/#986) gives orchestrator protection with no RAM cost and no MTP loss. The only thing it doesn't give is concurrency.

d) **Patched batched mode (recommended if concurrency is wanted).** See §5.

## 4. Upstream survey (antirez/ds4)

antirez lands most work by cherry-pick, so many PRs stay "OPEN" even after their code ships.

| #          | State                                                          | What                                                            | Relevance / composes with #1140 + #1170/#986/#1093/#727                                                   | Pin?                                     |
| ---------- | -------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1062       | OPEN (code effectively in main as `qwen4_batch_mtp`, via #991) | Qwen3.8 batched decode plus batched MTP on Metal                | Qwen-only. It's the template for the GLM extension.                                                       | No (already in)                          |
| 765        | CLOSED, routing merged as 4067320                              | Reuse-aware slot routing                                        | Already in our pin                                                                                        | n/a                                      |
| issue 1069 | OPEN (fixed by 4067320)                                        | Shared system prompt evicted the live slot                      | Fixed at our pin                                                                                          | n/a                                      |
| 930        | OPEN, CONFLICTING                                              | `--max-active-requests` (resident slots ≠ active slots)         | Admission control only. Doesn't help MTP.                                                                 | No                                       |
| 604        | OPEN, CONFLICTING, +3.5K                                       | CUDA single-GPU fused batched decode                            | CUDA/DeepSeek only                                                                                        | No                                       |
| 799        | OPEN, CONFLICTING                                              | Metal per-stream command queues for batched decode (about 1.7×) | Explicitly leaves GLM on the single-queue path                                                            | No                                       |
| 892        | OPEN                                                           | GLM-5.3 M5 Max bring-up plus K-width MTP                        | Single-session MTP. Width >2 measured slower. Gives the M5 Max MTP/serial ratio used above.               | No                                       |
| 920        | OPEN                                                           | Faster exact width-2 GLM-5.3 MTP verify on Metal (+19% claimed) | Single-session speedup. Would also speed up the patched batched fallback. Overlap with #1140 not checked. | Maybe later; needs its own exactness run |
| 1005       | OPEN, MERGEABLE                                                | GLM-5.3 live prefix rewind to `common`                          | Prior report: harmful for GLM-5.3 (rewind fails and skips the evict snapshot)                             | Do not pin                               |
| 972        | OPEN                                                           | ds4-agent `/fork` KV session                                    | Agent CLI only, not the server                                                                            | No                                       |
| 1170 / 986 | OPEN                                                           | Disk-KV evict-snapshot retention / eviction aging               | Directly helps option c. Server/kvstore only, no conflict with a batched-MTP flag patch.                  | Yes (see prior report)                   |
| 1093 / 727 | OPEN                                                           | GLM tool-turn visible checkpoint / strip transient metadata     | Orthogonal. They conflict mechanically with each other in ds4_server.c, not with the patch below.         | Per prior report                         |

No PR, issue or branch implements GLM MTP under `--batched-session`. The upstream `glm-5.3-flash` branch (b1b4ea0) is already an ancestor of our pin, and main has no commits past 0aaea5a beyond what #1140 sits on.

## 5. Recommendation

**Primary: local patch, GLM-5.3 batched MTP through the existing sequential fallback.** Layer it on #1140 like the other pins.

- ds4_server.c:15966-15967: rename `qwen4_batch_mtp` to `batch_mtp`, defined as `backend == METAL && (ds4_engine_is_qwen4(engine) || ds4_engine_is_glm53(engine)) && ds4_engine_mtp_draft_tokens(engine) > 1`. `ds4_engine_is_glm53` is already exported (ds4.c:71835) and used in the server.
- ds4_server.c:14022 and 16023: use the renamed flag. The log line then only fires when MTP is really off.
- No engine change. `ds4_sessions_eval_batch_speculative_argmax` already falls back per session (ds4.c:80066), and the GLM spec cycle and its rollback state are per session.
- Optional, about 10 more lines: when `active_generations == 1`, call `ds4_session_eval_speculative` directly with the sampling parameters. That makes the solo path byte-identical to today's non-batched path.
- Size: about 5-10 lines plus a doc line, and about 30-60 lines if it adds a server unit test for the flag.
- Verify:
    - Greedy (`temp 0`) output from one active slot in `--batched-session 2` must match non-batched `--mtp` byte for byte.
    - Run with `DS4_MTP_SPEC_LOG=1` and confirm accept/partial cycles in both slots with two concurrent requests, and no `glm mtp … failed`.
    - Run the QA item for the GLM-5.3 session snapshot with `DS4_TEST_GLM_MTP=1` (QA_BEFORE_RELEASES.md:584).
- Expected:
    - One active request: 20-28 tok/s (unchanged).
    - Two active: about 10-14 tok/s each (≈ one stream in aggregate, ordered), plus up to 2 ms coalesce wait per tick (`DS4_SERVER_DECODE_COALESCE_US`).
    - Worker prefill bursts can stall orchestrator decode for up to about 3 s per 1024-token slice.
- Memory: about +5.5 GB (second full GLM graph at ctx 163840). Consider lowering `--ctx` for both slots, e.g. 131072 saves about 1 GB per slot, if orchestrator conversations allow.
- Risk: low-to-medium. Code risk is small because the path already exists and is exercised for non-Qwen models. The real risk is memory pressure (already about 10 GB into swap). It also isn't upstream-tested for GLM: the QA gates cover GLM batching only without MTP.

**Cheaper first step, no code:** keep a single slot, fix disk-cache thrash (bigger `--kv-disk-space-mb`, delete the 4 stale 3.3 GB files, pin #1170 + #986) and the client-side prefix breakers from the prior report. Then an overflow request costs the orchestrator one evict save (≤0.5 s) plus a restore (≤1.4 s) instead of a re-prefill, with MTP intact and no extra RAM. Add the patched second slot only if you want real concurrency.

**Avoid:** stock `--batched-session 2` with `--mtp`. It loses MTP everywhere, gets no batching gain for GLM-5.3, and costs about 5.5 GB.

Unverified: non-MTP decode speed at our context lengths (extrapolated from PR #892's ratio), and whether two processes double-count wired weight pages.
