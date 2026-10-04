# esnixi RTX 5090: Qwen3.8-27B NVFP4 coder baseline (before any change)

Measured 2026-10-03 01:57 to 02:17 PDT on esnixi (celes@192.168.42.254). No nix, unit, or switcher change was made.

Live config (from the running unit's argv, `vllm.service`, PID 2028597, vLLM 0.31.0rc3):
`--max-model-len 131072 --max-num-seqs 1 --kv-cache-memory=4776620811 --kv-cache-dtype nvfp4 --language-model-only --linear-backend cutlass --reasoning-parser qwen3 --tool-call-parser qwen3_xml --enable-auto-tool-choice --max-num-batched-tokens 256 --speculative-config {"method":"mtp","num_speculative_tokens":3}`

## Method

- Path: direct to the vLLM backend at `http://127.0.0.1:8010` from the esnixi host. The authenticated switcher (`vllm-switcher.service`, bearer token) was bypassed and no token was read. 8010 is the live 27B port (`ss -ltnp`; `/v1/models` returns `qwen3.8-27b-nvfp4`, max_model_len 131072).
- Bypassing the switcher also bypasses its `max_requests: 1` gate. The serial behavior below therefore comes from vLLM itself (`--max-num-seqs 1`), not from the switcher.
- Prompt: 49,663 tokens of real repo source (`git ls-files *.nix *.py *.sh` from nix-flakes-refactored, trimmed with `/tokenize`), plus a system prompt and 5 OpenAI tool definitions. That comes to 50,301-50,325 prompt tokens per request. A short-context reference run used about 4,040 tokens.
- Each request starts with a unique nonce, so prefix caching can't hide prefill. Confirmed: 0 prefix-cache hits across 201K queried tokens. Thinking was disabled. `max_tokens = min_tokens = 512`, temperature 0.6, streamed with `include_usage`.
- Timings are client-side (TTFT = first content or tool_call delta) and cross-checked against server histogram deltas from `/metrics` (`request_prefill_time`, `request_decode_time`, `request_queue_time`).
- Scripts: `bench.py` (load generator plus nvidia-smi and /metrics sampler every 2 s) and `stream_probe.py`. Raw data: `run1-raw.jsonl`, `run2-50k-raw.jsonl`, `run2-4k-raw.jsonl`.
- Caveats:
    - Live OmniRoute traffic was hitting the same backend. Before the run, the script waited 347 s for the engine to go idle.
    - Run 2's second c=1, c=2 and c=4 phases each had one live request ahead of the benchmark (server `count` deltas 2, 3 and 5 against 1, 2 and 4 sent). Their TTFTs include that wait.
    - Run 1 concurrency phases were clean, with exact multiples of one request's service time.
- Run 1 sent `tool_choice: "none"`. On this build that buffers the whole reply into one SSE chunk: the probe returned 2 chunks for 64 tokens, against 20+ with no tools or with `auto`. Run 1 TTFT is therefore invalid, but its end-to-end totals are valid. Run 2 used `tool_choice: "auto"`.
    - The model still emitted `tool_calls` in most run-2 replies. That doesn't affect token counts because `min_tokens = 512` holds.
    - Side finding: clients that send `tool_choice: "none"` see zero streaming until the reply completes.

## Baseline table

| Metric                                                    | Value                                                                                                                                                                                                                                                                                                                          | Source                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| TTFT, single request, ~50.3K prompt, cold (no prefix hit) | 16.9 s client; 16.63 s server prefill; queue 0                                                                                                                                                                                                                                                                                 | run2 c=1 #1 (clean)      |
| Prefill throughput at ~50K                                | ~3,030 tok/s (50,323 / 16.63 s)                                                                                                                                                                                                                                                                                                | server prefill histogram |
| Prefill throughput at ~4K                                 | ~3,300 tok/s (TTFT 1.22-1.30 s)                                                                                                                                                                                                                                                                                                | run2-4k                  |
| Decode, single request, at 50K context                    | 42.7-43.3 tok/s (512 tokens in ~12 s)                                                                                                                                                                                                                                                                                          | run2, all 50K requests   |
| Decode, single request, at 4K context                     | 105-114 tok/s                                                                                                                                                                                                                                                                                                                  | run2-4k                  |
| End-to-end per request at 50K, 512 out                    | 28.4-29.4 s                                                                                                                                                                                                                                                                                                                    | run1 and run2            |
| Aggregate output tok/s, c=1 / 2 / 3 / 4 at 50K            | 17.9-18.0 / 17.9 / 17.5 / 17.6                                                                                                                                                                                                                                                                                                 | run1 (clean)             |
| Aggregate prompt tok/s, c=1 / 2 / 3 / 4                   | 1,756-1,771 / 1,756 / 1,722 / 1,733 (prefill plus decode wall)                                                                                                                                                                                                                                                                 | run1                     |
| Wall time for N concurrent 50K requests                   | c=2 57.3 s, c=3 87.6 s, c=4 116.1 s (exactly N × 28.6-29 s)                                                                                                                                                                                                                                                                    | run1                     |
| Per-request completion at c=4                             | 29.1 / 58.1 / 87.0 / 115.9 s (strictly serial)                                                                                                                                                                                                                                                                                 | run1                     |
| Per-request TTFT at c=4                                   | 64.8 / 94.1 / 122.8 / 151.5 s; step = 28.7 s, one full request; one live request was ahead                                                                                                                                                                                                                                     | run2                     |
| Server mean queue time at c=4                             | 85.0 s (prefill mean 14.8 s)                                                                                                                                                                                                                                                                                                   | /metrics delta           |
| Engine concurrency observed                               | `num_requests_running` max 1, `waiting` max 4                                                                                                                                                                                                                                                                                  | 2 s sampler              |
| Aggregate at c=4, 4K prompts                              | 83 tok/s (same as c=1, 84-86 tok/s), TTFT 1.2 / 8.5 / 14.2 / 20.0 s                                                                                                                                                                                                                                                            | run2-4k                  |
| MTP acceptance (live window)                              | mean acceptance length 2.3-3.7 (per-position ~0.67 / 0.47 / 0.30 typical on these prompts, up to 0.94 / 0.90 / 0.85)                                                                                                                                                                                                           | vLLM SpecDecoding log    |
| GPU VRAM used                                             | 27,721 / 32,607 MiB, flat during the run (VLLM::EngineCore 26,900 MiB; Hyprland 305, quickshell 264, Xwayland 8 MiB). About 4.9 GB free.                                                                                                                                                                                       | nvidia-smi               |
| GPU util / power under load                               | 52-97 % util, peak 467 W of 575 W                                                                                                                                                                                                                                                                                              | sampler                  |
| GPU KV cache usage                                        | one 50K request about 27 % of the ~187K-token pool; peak sampled 36.9 %                                                                                                                                                                                                                                                        | /metrics                 |
| Prefix cache hit rate                                     | lifetime 16.5-34 % (vLLM log; falls as unique benchmark prompts dilute it); benchmark itself 0 % by design                                                                                                                                                                                                                     | vLLM log, /metrics       |
| Host RAM (`free -g`)                                      | 125 GiB total; used 23-32 GiB; available 92-102 GiB; swap 2 / 63 GiB; vllm.service cgroup 4.2 GiB                                                                                                                                                                                                                              | free, systemctl          |
| ComfyUI VRAM share                                        | 0 MiB. Container `arcane-atlas-esnixi-worker` is up but has no GPU process. `/proc/locks` shows vllm.service PID 2028597 holding the exclusive flock on `/run/arcane-gpu/5090.lock` and no blocked waiter. ComfyUI can't touch the GPU while the coder runs, because gpu_launch.py holds the lease for the whole process life. | nvidia-smi, /proc/locks  |
| Port / token path                                         | `127.0.0.1:8010` direct, no bearer token, switcher bypassed                                                                                                                                                                                                                                                                    |                          |

## Readings for the planner

- The engine is fully serial. Throughput is flat from c=1 to c=4 (about 17.7 output tok/s at 50K) and every extra request adds one full service time, about 28.7 s, to everyone behind it. The cause is `--max-num-seqs 1` in vLLM; the switcher's `max_requests: 1` sits on top. KV capacity is not the limit: one 50K request uses about 27 % of the pool, so 3 such requests fit today.
- Prefill: about 3,000 tok/s with `--max-num-batched-tokens 256` (a 50K prompt takes about 197 scheduler steps of 256). That accounts for about 17 s of every 50K TTFT. The production 19-20 s TTFT matches.
- Decode falls from about 110 tok/s at 4K context to about 43 tok/s at 50K for a single sequence (attention and KV-read bound, nvfp4 KV, MTP k=3). Batching should raise aggregate tok/s well above 43 at long context.
- Production TTFTs of 282 s are pure queueing: about 10 requests' worth of 28.7 s service each.

## Cold swap cost (current stop/start switcher)

Taken from `journalctl -u vllm-switcher / vllm / vllm-reader`, 2026-10-03 00:05-01:09.

| Transition            | Swap (switcher `systemctl stop` of the old unit → new unit "Application startup complete") | Unit `systemctl start` → ready |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| 9B reader → 27B coder | 53 s (00:15:38→00:16:31), 53 s (00:20:37→00:21:30), 52 s (01:08:53→01:09:45)               | 48-57 s (4 samples)            |
| 27B coder → 9B reader | 70 s (00:18:12→00:19:22), 71 s (00:22:24→00:23:35), 72 s (00:54:42→00:55:54)               | 68 s (3 samples)               |

The stop plus drain plus 2 s settle takes about 4 s.

27B start breakdown (01:08:57 start):

| Phase                                         | Time |
| --------------------------------------------- | ---- |
| Python/vLLM import and arg parse              | 8 s  |
| EngineCore init                               | 13 s |
| Weights load (19.84 GiB including MTP head)   | 9 s  |
| Profiling and warmup                          | 12 s |
| KV allocation, CUDA graphs (0.11 GiB), API up | 6 s  |

9B start: about 33 s of process start plus 5.4-6 s of weights (8.41 GiB), then init engine at 32-34 s (two graph captures, one of 7 s).

The earlier 70-90 s observation matches 27B→9B. 9B→27B is about 52 s. Clients see more than that because of switcher queueing and the 90 s residency hold.

## Orchestrator directive for planner: vLLM sleep mode

Directive, from the orchestrator and the user: evaluate replacing stop/start swapping with vLLM sleep mode.

- Both units stay running. The inactive one sleeps at level 1, which keeps its weights in pinned host RAM.
- The switcher sleeps one and wakes the other instead of calling `systemctl stop/start`.
- Upstream reports wakes of about 0.1-2.6 s against multi-minute cold starts ([vLLM blog](https://vllm.ai/blog/2025-10-26-sleep-mode), [docs](https://docs.vllm.ai/en/v0.17.1/features/sleep_mode/)).
- If sleep mode works on this build, it's in scope for this workflow, together with the batched-tokens, concurrency and KV-offload changes.

### Support in the installed build (python3.14-vllm-0.31.0rc3). Verified by source inspection only; not exercised.

- `--enable-sleep-mode` exists: `vllm/engine/arg_utils.py:1004`, `ModelConfig.enable_sleep_mode`.
    - `is_sleep_mode_available()` returns True for CUDA.
    - Enabling it forces the cumem allocator (`config/model.py:621`).
    - Default backend `sleep_mode_backend="cumem"`. Level 1 = `allocator.sleep(offload_tags=("weights",))`, which copies weights to pinned CPU memory and discards KV. Level 2 discards weights.
- `vllm serve --help` couldn't be run as `celes` outside the unit: device-type inference fails without the unit's environment.
- Endpoints are in `vllm/entrypoints/serve/dev/sleep/api_router.py`:
    - `POST /sleep?level=1&mode=abort|wait`
    - `POST /wake_up[?tags=weights&tags=kv_cache]`
    - `GET /is_sleeping`
    - `POST /release_kv_cache_memory`
    - They're registered only when `VLLM_SERVER_DEV_MODE=1` (`launchers/api_server/routers.py:34`), and that also turns on every other dev route (rlhf, rpc, cache, server_info) with a "SECURITY WARNING". The backend binds 127.0.0.1, which limits exposure.
- The `mode=wait` drain fixes upstream #45520 (sleep with in-flight decode crashed the engine; closed 2026-06-14).
- Compatibility with this unit's features: there is no config-time guard rejecting sleep mode with NVFP4 weights, nvfp4 KV, MTP speculative decoding, CUDA graphs, or `--linear-backend cutlass`.
    - Level 1 wake restores weights in place and re-allocates KV under the cumem pool. The level-2-only buffer save/restore paths include the draft model.
    - Known upstream issues:
        - [#52479](https://github.com/vllm-project/vllm/issues/52479) (OPEN): level 2 wake does not reload spec-decode draft weights, giving about 2× slower decode and acceptance near 0. Level 1 is not reported affected. Use level 1 and check MTP acceptance after a wake.
        - [#45268](https://github.com/vllm-project/vllm/issues/45268) (OPEN): `--kv-offloading-backend native` plus `--enable-sleep-mode` gives EngineDeadError after the first L1 sleep/wake. Root cause discussed: unfenced cuMemUnmap against in-flight offload DMA, and load-waiting requests never answered. Sleep mode alone passed 10/10 cycles on Qwen3.6-27B. This build's `v1/kv_offload/tiering/manager.py:911` has a hook "called during sleep, weight update, or resume", so some reset exists, but there's no evidence the race is fixed. Don't combine KV offload with sleep mode without a soak test; pick one or test both together.
        - [#44395](https://github.com/vllm-project/vllm/issues/44395) (closed): weights-only wake then forward gives an illegal memory access. Always wake all tags.
        - [#53888](https://github.com/vllm-project/vllm/issues/53888) (closed 2026-09-01): L1 wake corrupted LoRA state on NVFP4/Marlin. No LoRA here.
- Not empirically tested. Testing needs restarting the 27B with `--enable-sleep-mode` plus `VLLM_SERVER_DEV_MODE=1`, which is a config change and out of scope for this step. The GPU has about 4.9 GB free, which is not enough for a side test with the 9B (8.4 GiB of weights).
    - Measure in the implementation step: wake latency, MTP acceptance after a wake (catches a #52479-style regression), and VRAM after `/sleep`. The worker logs "Sleep mode freed X GiB, Y GiB still in use".

### Things the plan must handle

- Prior art already in the repo. `esnixi/vllm_idle.py` (`IdleSleepMiddleware`, loaded with `--middleware vllm_idle.IdleSleepMiddleware --api-server-count 1`):
    - Sleeps at level 1 with `mode="wait"` after `VLLM_IDLE_SECONDS`, wakes on the first engine-using POST, and returns 503 + Retry-After if a wake fails.
    - Releases and re-acquires the shared `arcane_gpu.GPULease` around sleep and wake.
    - Needs no dev routes, because it calls `engine_client.sleep/wake_up` in-process.
    - It ran on the retired v0.29 vision container (`modules/profiles/ai.nix` `vllm-vision-5090`). The 300 s idle there was chosen because 5 s raced with OmniRoute health checks.
    - Reusing it avoids enabling `VLLM_SERVER_DEV_MODE` entirely. It needs a check that its exemptions (GET, `/tokenize`, `/detokenize` don't wake the engine) and its `engine_client` API compatibility still hold on 0.31.0rc3.
- GPU lease (blocking issue for "both units stay running"). `gpu_launch.py` takes an exclusive `flock` on `/run/arcane-gpu/5090.lock` before exec and never releases it.
    - A second leaseWrap'd unit started while the first runs blocks in gpu_launch forever.
    - Sleep-mode co-residency needs lease handoff: release after sleep completes, acquire before wake (what vllm_idle does).
    - The switcher must sequence sleep(A), lease released, then wake(B) or start(B).
- Residual VRAM of a sleeping process. CUDA context plus the non-cumem allocations stay resident: torch/FlashInfer workspaces, the CUDA-graph pool (0.11 GiB for the 27B and 0.14 + 0.07 GiB for the 9B by capture size), and the NCCL comms unless `enable_nccl_comm_suspend`. Expect several hundred MiB to about 1+ GiB per sleeper (unmeasured). Budget it against the 32,607 MiB card: desktop takes about 577 MiB, and the awake 27B currently takes 26,900 MiB.
- Startup ordering and profiling. The second process must load weights and profile while the first is asleep, so its profiler sees the freed memory.
    - Fixed `--kv-cache-memory` (the 27B already uses it) makes KV sizing deterministic. The 9B currently self-sizes to 15.89 GiB of KV and needs a fixed `--kv-cache-memory` too.
    - Under co-residency, the first-ever start of each unit must happen with the other asleep, and a wake must never race the other's start. That's a systemd `After=`/`ExecStartPre` handshake or switcher-owned sequencing.
- Pinned host RAM: 19.84 GiB (27B incl. MTP) + 8.41 GiB (9B), about 28.3 GiB of non-swappable pinned memory if both sleep. The real sizes are larger than the 17-18 / 7-9 GB estimates. That fits in 92-102 GiB available. A planned CPU KV offload pool (`--kv-offloading-size`) is also pinned and adds on top.
- ComfyUI: today ComfyUI is starved whenever the coder is up (the coder holds the lease for its whole life). With sleep plus lease release:
    - ComfyUI can run while both LLMs sleep.
    - A wake then blocks on `lease.acquire()` until Comfy's admission idle-unloads (`AA_COMFY_IDLE_UNLOAD_SECONDS`, default 5 s, plus up to 30 s unload deadline).
    - Wake latency then includes Comfy's unload time. The switcher's `MODEL_READY_SECONDS` 540 must cover it.
- The idle-stop backstop should become sleep. `READER_IDLE_SECONDS` 300 (switcher fast path) and the restart-safe `vllm-reader-idle` timer (polls `num_requests_running`) currently `systemctl stop` the reader. They should call sleep, through the middleware or an authenticated in-process trigger, instead.
    - The stop must remain as a fallback when sleep fails or when an operator wants VRAM fully back. Sleep still holds the CUDA context.
- Hysteresis. `RESIDENCY_SECONDS` 90 exists to avoid paying about 50-70 s cold swaps.
    - With wake in about 1-3 s, the swap cost becomes the lost KV/prefix cache: level-1 sleep discards KV, so a re-woken 27B must re-prefill 50K prompts at about 17 s each.
    - Keep a residency window, likely shorter, sized against prefix-cache loss rather than load time. Make sure "busy" still means in-flight requests > 0 once `max_requests` goes above 1.
    - `release_model` and residency bookkeeping must count concurrent requests per unit.
