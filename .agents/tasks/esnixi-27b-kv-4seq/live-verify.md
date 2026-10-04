# Live verify: esnixi coder KV 5.5 GiB (partial, c=4 bench skipped)

Checked 2026-10-03 06:55-07:38 PDT on esnixi (celes@192.168.42.254). Read-only apart from one small OmniRoute request. No Zoo session was interrupted.

**Status:** c=4 was **not demonstrated**. The orchestrator skipped the 4 × 55K benchmark because the user is moving the coder to 3 concurrent sequences (OmniRoute is already capped at 3, and a follow-up workflow will set vLLM to 3). The sleep/wake and reader checks are deferred because the coder was never idle.

## Deployed config

- Commit `7b0531d` on esnixi `main` (the production change is `e789922`). Generation 438, toplevel `/nix/store/14avxdr4vhk9mb7jmb0230vhcpimfxc5-nixos-system-esnixi-26.11.20260922.6774f7b`.
- `vllm.service` has been active since 06:51:21. The engine restarted at 06:55. ExecStart has `--kv-cache-memory=5905580032 --gpu-memory-utilization 0.92 --max-num-seqs 4`, with MTP k=3.
- Startup log: `reserved 5.5 GiB memory for KV Cache`, `GPU KV cache size: 221,976 tokens, Maximum concurrency for 131,072 tokens per request: 1.69x`.
- `/metrics` `cache_config_info`: `num_gpu_blocks="105"`, `kv_cache_memory_bytes="5905580032"`, `gpu_memory_utilization="0.92"`. These match the plan (105 blocks, 104 usable).

## OmniRoute tier-1 check: PASS

`POST https://omniroute.celestium.life/v1/chat/completions` with model `hybrid/code`, header `X-OmniRoute-Tier: 1`, max_tokens 64. The request ran on esnixi using the `omniroute_management_api_key` secret as the Bearer token. The key was not printed.

- **HTTP 200 in 6.76 s** (07:37:38).
- `x-omniroute-decision: strategy=priority; provider=vllm`, `x-omniroute-model: qwen3.8-27b-nvfp4`, `x-omniroute-selected-connection-id: e9bd13fb-…` (esnixi-5090).
- 1009 prompt / 10 completion tokens. The reply was correct (`s[::-1]`).

## Live load observed (real Zoo traffic, not a benchmark)

The coder had no idle stretch of 20 s or more between 07:01 and 07:38. A 25-minute idle wait (07:12-07:37) timed out. Zoo ran 1-2 long sessions throughout. Two at once used 90-97 % KV, about 48-50 blocks each, roughly 95-100K tokens per session.

Running / Waiting transitions from the `vllm.service` journal:

| Time              | Running | Waiting | KV %                 |
| ----------------- | ------- | ------- | -------------------- |
| 07:01:24          | 2       | 0       | 72.1                 |
| 07:07:24          | 2       | 0       | 91.3                 |
| 07:12:04          | 1       | 0       | 47.1                 |
| 07:12:34          | 2       | 0       | 90.4                 |
| 07:20:14-07:21:04 | 1-2     | 0       | 42-90                |
| 07:31:44          | 1       | 0       | 50.0                 |
| 07:32:04          | 0       | 0       | 0.0 (about 10 s gap) |
| 07:32:14          | 2       | 0       | 95.2                 |
| 07:37:14          | 2       | 0       | 97.1                 |

Since the 06:55 engine start, the journal has 244 throughput samples. Max Running was 2 and max Waiting was 0. `vllm:num_preemptions_total` is 0. There is no OOM, `EngineDeadError` or Traceback in the journal.

**No `Running: 4, Waiting: 0` evidence exists.** Zoo never offered more than 2 concurrent requests, and the benchmark was not run.

### VRAM under this load

nvidia-smi at 07:38:13, 5 samples 2 s apart, at 95-100 % util with Running 2 and KV 95 %: **30,527 MiB used, 1,675 MiB free**, flat. EngineCore is 29,642 MiB. That is above the 1 GiB floor, but it is 2-sequence load, not c=4. The plan predicts about 1.0 GiB free at the coder's activation peak. Activations are bounded by `max_num_batched_tokens`, not concurrency, so c=3 should land between these two figures. This was not measured.

## Block math: why 4 distinct 55K requests do not fit

- 105 blocks of 2848 tokens, 104 usable. Each sequence costs `ceil((L+3)/2848) + 15` blocks. The +15 is GDN state: 3 groups × (2 + 3 MTP spec).
- A ~55.7K prompt (55K corpus plus system prompt and tools) takes 20 + 15 = **35 blocks**.
- 4 distinct requests need **140 blocks**, against 104. Expect Running 2 at 70 blocks, since 3 need 105. Running 3 needs prompts of about 54K or less (102 blocks).
- 4 × 55K fits only with a shared prefix S where 140 − 3·S ≤ 104, so S ≥ 12 blocks, about **34K shared tokens**. A 30K shared prefix (10 blocks) gives 110 blocks, which is still Running 3, Waiting 1.
- For the planned move to 3 sequences: 3 distinct ~54K requests fit (102 blocks). 3 × 55.7K (105 blocks) needs about 1 block of shared prefix (≥ 2848 tokens), and the Zoo system prompt plus tools already exceeds that.

## Before / after

| Metric                             | Before (6 GiB, 115 blocks, 2026-10-03 02:58) | Now (5.5 GiB, 105 blocks)                                                    |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| c=4 at 50K: aggregate tok/s / wall | 36.8 tok/s / 55.6 s                          | not measured (bench skipped)                                                 |
| Engine concurrency at ~50K         | Running 3, Waiting 1                         | predicted Running 2 at 55.7K distinct (math above); live Zoo max 2/0 at ~95K |
| TTFT                               | 8.6 / 18.1 / 24.3 / 43.8 s at c=4            | not measured                                                                 |
| VRAM free                          | 1,087-1,095 MiB under c=4                    | 1,675 MiB under live c=2 (07:38)                                             |
| Preemptions / OOM                  | 0 / 0                                        | 0 / 0 since 06:55                                                            |

## Deferred checks

- **Coder sleep/wake round trip (~1 s wake):** not run. The coder's idle sleep is disabled (`VLLM_IDLE_SECONDS=0`), so the only trigger is `POST /arcane/sleep`. That drains in-flight requests first, which would have stalled live Zoo sessions.
- **Reader cold start and its 0.50 gate:** not run. It needs a reader switch, which the switcher refuses while the coder has requests in flight. `vllm-reader.service` is still `failed (Result: timeout)` from the 06:52 stop at deploy time (see deploy-report.md). `select_model` runs `reset-failed` before starting it, so the stale state should not block the next reader switch. This is not verified live.
- **4 × 55K benchmark:** `bench_kv4.py` in this directory, also copied to `/tmp/bench_kv4.py` on esnixi, runs it once the coder is quiet. It is `bench.py` from esnixi-5090-qwen27b-perf with `BENCH_TOKENS=55000` by default, plus `BENCH_SHARED_TOKENS` for a shared-prefix case, plus free-VRAM and preemption sampling. Example: `python3 /tmp/bench_kv4.py 3`.
