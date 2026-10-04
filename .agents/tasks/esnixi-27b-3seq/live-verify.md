# Live verify: esnixi 27B coder at 3 concurrent sequences

Checked 2026-10-03 08:04-08:15 PDT on esnixi (celes@192.168.42.254). Deployed commit **`f947fbc`** (`f947fbccc2f16a640bbab022b3ef71a9a6902aff`, "esnixi: serve 27B coder with 3 concurrent sequences (vllm, switcher, OmniRoute)"). Generation 439, `/run/current-system` → `/nix/store/qsnq8v0ajaa7wb04yw9wxirxhcsyqpbm-nixos-system-esnixi-26.11.20260922.6774f7b`.

**Result: PASS.** The engine ran 3 × 55K-token tool requests as `Running: 3 reqs, Waiting: 0 reqs` with 0 preemptions and 1,697 MiB free VRAM. OmniRoute tier 1 returned HTTP 200 from esnixi. One problem came up after the deploy: the first coder start ran out of GPU memory. The switcher watchdog recovered it on its own (details below).

## 1. Live config

- `vllm.service` ExecStart and its running process both show `--max-num-seqs 3`. The engine's non-default args log `'max_num_seqs': 3`, `kv_cache_memory_bytes: 5905580032`, `max_num_batched_tokens: 5760`, and MTP k=3.
- The switcher script `/nix/store/cxdlrkdjldjyd7da65viv93a4fpiq461-vllm-switch.py` sets `"max_requests": 3` on both coder entries (lines 95 and 103). The 9B reader is still 8 (line 117).
- KV pool is unchanged from the 4-seq deploy: `GPU KV cache size: 221,976 tokens` (105 × 2848-token blocks).
- The engine has been active since 08:11:07 with NRestarts 0. There is no OOM, Traceback or EngineDeadError since then, and `vllm:num_preemptions_total` is 0.

### First start after deploy failed and recovered on its own

- deploy-report.md says vllm.service was "active since 08:04:12". That was written before the engine finished loading. The 08:04 start **failed at 08:05:58** with an OOM while allocating the KV cache: `trying to allocate 5857345536 bytes (free: 5304418304)`.
- The likely cause is a cold torch.compile. The new `max_num_seqs` changed the compile cache key, so Dynamo and Inductor recompiled for 57.5 s, then a 12.7 s warmup ran. The 06:55 start hit the warm cache and its warmup took 0.09 s. Weights were the same (19.84 GiB) and initial free memory was the same (30.16 GiB). Even so, only about 5.3 GB was free when the KV allocation ran, against the 5.86 GB it needed. This is inferred from the logs and was not reproduced.
- The switcher opened its breaker for 300 s. Its watchdog restarted the coder at 08:11:07. With the compile cache now warm (`torch.compile took 0.62 s`), the KV allocation fit and the switcher logged `breaker CLOSED` at 08:12:40.
- **The coder was down from 08:06:04 to 08:12:38, about 6.5 minutes.** Requests fell through to other tiers during that window. I made no changes. Any future flag change that invalidates the compile cache could hit this once more.

## 2. Backend load test (3 × 55K with tools, run on esnixi against 127.0.0.1:8010)

Command: `BENCH_TOKENS=55000 BENCH_SHARED_TOKENS=8000 BENCH_OUT=/tmp/qwen27b-bench-3seq.jsonl python3 /tmp/bench_kv4.py 3`. The coder was idle (Running 0) at the start.

- Each request had 5 tool definitions, `tool_choice: auto`, and streamed 512 output tokens. Prompts were 55,541-55,545 tokens. All three returned `tool_call_seen: true` and no errors.
- The shared prefix landed at 2,205 tokens because the corpus is cut at file boundaries, and the prefix cache hit rate was 0 %. So these were effectively 3 distinct 55.5K prompts. They still fit, with KV peaking at 97.1 %.
- Raw results are in `/tmp/qwen27b-bench-3seq.jsonl` on esnixi.

The engine journal (10 s logger) shows the expected state:

```
Running: 2 reqs, Waiting: 1 reqs, GPU KV cache usage: 64.4%   (3rd request still in prefill queue)
Running: 3 reqs, Waiting: 0 reqs, GPU KV cache usage: 93.3%
Running: 3 reqs, Waiting: 0 reqs, GPU KV cache usage: 92.3%   Avg generation throughput: 89.0 tokens/s
Running: 0 reqs, Waiting: 0 reqs
```

The 1 s metrics samples showed the same sequence: 1/2 → 2/1 → **3/0 for about 20 s**, with KV at 80.8-97.1 % → 1/0. Requests queue while an earlier prompt is still prefilling, because prefill is chunked one request at a time at 5,760 tokens. All three then run together.

| Request       | TTFT   | Decode tok/s (first token → end)            | Total  |
| ------------- | ------ | ------------------------------------------- | ------ |
| r0            | 9.7 s  | 16.3                                        | 41.0 s |
| r1            | 20.5 s | 25.0                                        | 40.9 s |
| r2            | 29.2 s | 38.3                                        | 42.5 s |
| **Aggregate** |        | **36.1 tok/s** (1,536 tokens / 42.6 s wall) |        |

- Prefill ran at about 5,550 tok/s (engine log). r0 and r1 decode slower because their decode stalls while the later prompts prefill. r2 decodes almost entirely with 3 sequences running, so 38.3 tok/s is the cleanest per-request 3-way decode figure.
- **Free VRAM:** 2,777 MiB idle before the run, **1,697-1,701 MiB under c=3** at 100 % util (30,501-30,505 / 32,607 MiB used), flat. That is above the 1 GiB floor.

## 3. Before / after (4-seq vs 3-seq)

The only measured 4-seq benchmark is the 02:52 run in `esnixi-5090-qwen27b-perf/run3-50k-raw.jsonl`. The `esnixi-27b-kv-4seq/live-verify.md` table cites it as "before". That run differs from today's in three ways: 6 GiB KV (115 blocks) instead of 5.5 GiB (105), 50K prompts instead of 55K, and tools sent but not counted the same way. The 4-seq at 5.5 GiB benchmark was never run.

| Metric                       | Before: 4-seq, c=4, 50K (6 GiB KV) | After: 3-seq, c=3, 55K (5.5 GiB KV) |
| ---------------------------- | ---------------------------------- | ----------------------------------- |
| Engine concurrency           | Running 3, Waiting 1 (4th queued)  | **Running 3, Waiting 0**            |
| TTFT                         | 8.6 / 18.1 / 24.3 / **43.8 s**     | 9.7 / 20.5 / **29.2 s**             |
| Per-request decode tok/s     | 13.4 / 29.3 / 26.2 / 43.9          | 16.3 / 25.0 / 38.3                  |
| Aggregate decode tok/s       | 36.8 (55.6 s wall)                 | 36.1 (42.6 s wall)                  |
| Free VRAM under load         | 1,087-1,095 MiB                    | **1,697-1,701 MiB**                 |
| Preemptions / OOM during run | 0 / 0                              | 0 / 0                               |

For a like-for-like reference, c=3 at 50K on the old 4-seq config (same 02:52 run) had TTFT 10.0 / 16.6 / 24.4 s, decode 20.6 / 22.7 / 44.3 tok/s and 39.1 tok/s aggregate.

**Takeaway:** aggregate throughput is unchanged at about 36 tok/s, because the GPU was already saturated at 3. The worst-case TTFT drops from 43.8 s to 29.2 s since there is no 4th request queued behind the KV pool. Per-request numbers are similar despite 10 % longer prompts. Free VRAM goes up about 600 MiB, mostly from the 5.5 GiB KV change in the previous deploy.

## 4. OmniRoute check: PASS

`POST https://omniroute.celestium.life/v1/chat/completions` with model `hybrid/code`, header `X-OmniRoute-Tier: 1`, max_tokens 64. The Bearer token was the `omniroute_management_api_key` secret, read into a shell variable and passed to curl on stdin. It was never printed or written anywhere.

- **HTTP 200** in 0.65 s (08:14:44).
- `x-omniroute-decision: strategy=priority; provider=vllm`, `x-omniroute-model: qwen3.8-27b-nvfp4`, connection `e9bd13fb-…` (esnixi-5090). The reply was `s[::-1]`.
