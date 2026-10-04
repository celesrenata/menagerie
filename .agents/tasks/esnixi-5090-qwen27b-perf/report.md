# esnixi RTX 5090: Qwen3.8-27B NVFP4 coder, before vs after

Re-measured 2026-10-03 02:50-02:58 PDT on esnixi (celes@192.168.42.254), after the user's `nixos-rebuild switch`. Live system `/nix/store/p602jvk0…-nixos-system-esnixi-26.11.20260922.6774f7b`, commit `3601dd8` (plus the pre-existing dirty tree, see closure-diff.md). Nothing in the nix repo was changed by this step.

Live unit (`vllm.service`, MainPID 2783066, EngineCore 2786108, active since 02:44:05, NRestarts 0): `--max-num-seqs 4 --kv-cache-memory=6442450944 --kv-cache-dtype nvfp4 --kv-offloading-size 32 --kv-offloading-backend native --max-num-batched-tokens 5760`, MTP k=3. Startup log: `GPU KV cache size: 243,117 tokens, Maximum concurrency for 131,072 tokens per request: 1.85x`, `num_gpu_blocks=115`, offload mmap 34.36 GB created and unlinked, no OOM.

## Method (same as baseline)

- Path: direct to the vLLM backend at `http://127.0.0.1:8010` from the esnixi host. Discovered the same way as the baseline: `ss -ltnp` shows 8010 listening on 127.0.0.1, `/v1/models` returns `qwen3.8-27b-nvfp4` with `max_model_len` 131072. The authenticated switcher was bypassed, so no bearer token was read or needed.
- Same `bench.py` unchanged: 49,634-token repo corpus + system prompt + 5 tool definitions = 50,288-50,295 prompt tokens per request, unique nonce per request (0 prefix-cache hits in every benchmark phase), thinking off, `tool_choice: "auto"`, `max_tokens = min_tokens = 512`, temperature 0.6, streamed. Phases c=1, 1, 2, 3, 4 at 50K and c=1, 1, 4 (+3 repeat c=1) at 4K.
- New: `offload_probe.py` (plan check 6a). Fixed-prefix 50K prompt A sent cold, again, then evicted by 8 unique 50K prompts at c=4, then sent a third time.
- Clean window: the engine had served 0 requests since startup, and every phase's server request count matched what the benchmark sent. No live OmniRoute traffic was mixed in (the baseline run 2 had some).
- Raw data: `run3-50k-raw.jsonl`, `run3-4k-raw.jsonl`, `run3-4k-repeat-raw.jsonl`, `run3-offload.log`.

## Before / after

| Metric                                          | Before (baseline.md)                                   | After                                                                                                                     | Change                        |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| TTFT, single, ~50.3K prompt, cold               | 16.9 s client, 16.63 s server prefill                  | **8.05-8.09 s** client, 7.94-7.95 s server prefill                                                                        | 2.1× faster                   |
| Prefill tok/s at ~50K                           | ~3,030                                                 | **~6,330** (50,293 / 7.94 s)                                                                                              | 2.1×                          |
| Prefill at ~4K (TTFT)                           | ~3,300 tok/s (1.22-1.30 s)                             | ~9,500 tok/s (0.46-0.47 s)                                                                                                | 2.8×                          |
| Decode tok/s, single, 50K context               | 42.7-43.3                                              | **41.9-43.3**                                                                                                             | unchanged                     |
| Decode tok/s, single, 4K context                | 105-114 (tool-call replies)                            | 104.6 tool-call reply; 76-83 prose replies                                                                                | unchanged (see note 1)        |
| Aggregate output tok/s at 50K, c=1 / 2 / 3 / 4  | 17.9-18.0 / 17.9 / 17.5 / 17.6                         | **25.2-25.8 / 31.0 / 39.1 / 36.8**                                                                                        | 1.7× / 2.2× / 2.1× at c=2/3/4 |
| Wall for N concurrent 50K requests, c=2 / 3 / 4 | 57.3 / 87.6 / 116.1 s                                  | **33.1 / 39.2 / 55.6 s**                                                                                                  | c=4 2.1× faster               |
| Per-request TTFT at c=4, 50K                    | 64.8 / 94.1 / 122.8 / 151.5 s (one live request ahead) | 8.6 / 18.1 / 24.3 / 43.8 s                                                                                                |                               |
| Per-request completion at c=4, 50K              | 29.1 / 58.1 / 87.0 / 115.9 s (strictly serial)         | 35.5 / 43.9 / 46.8 / 55.5 s                                                                                               |                               |
| Server mean queue time at c=4, 50K              | 85.0 s                                                 | 14.5 s                                                                                                                    |                               |
| Engine concurrency observed                     | running max 1, waiting max 4                           | 50K: running max **3**, waiting max 3. 4K: running max **4**                                                              | see note 2                    |
| Aggregate output tok/s at c=4, 4K               | 83 (TTFT 1.2 / 8.5 / 14.2 / 20.0 s)                    | **241** (TTFT 0.86 / 1.24 / 1.62 / 1.60 s)                                                                                | 2.9×                          |
| GPU VRAM used                                   | 27,721 / 32,607 MiB (EngineCore 26,900), 4,886 free    | **31,107-31,115 / 32,607 MiB** (EngineCore 30,222-30,230), **1,087-1,095 free**, flat under c=4 at 100 % util, 582 W peak | +3.3 GiB; see note 3          |
| Host RAM used by KV offload                     | none (vllm.service cgroup 4.2 GiB)                     | **32.1 GiB** pinned shmem (EngineCore `RssShmem` 33,681,368 kB; `/dev/shm` 33 G used of 63 G; `free` shared 32-33 GiB)    | +32 GiB                       |
| Host RAM overall (`free -g`)                    | used 23-32, available 92-102 GiB, swap 2 GiB           | used 55, available 70 GiB, swap 2.5 GiB                                                                                   |                               |
| CPU-tier prefix hit after GPU eviction (A3)     | n/a                                                    | 45,568 of 50,270 tokens from the CPU tier, **TTFT 1.28 s** against 8.09 s cold (GPU hit A2: 1.24 s)                       | works                         |
| MTP mean acceptance length                      | 2.3-3.7                                                | 2.4-3.8                                                                                                                   | unchanged                     |
| Preemptions / restarts / engine errors          | 0 / 0 / 0                                              | 0 / 0 / 0 (no EngineDeadError, AssertionError, Traceback or OOM in `journalctl -u vllm` since 02:44)                      |                               |

Notes:

1. Single-sequence decode depends on the reply type, not the config. MTP accepts more on tool-call XML than on prose. Tool-call replies (about 90-120 SSE chunks) decode at 104-114 tok/s at 4K both before and after. Prose replies (about 180-200 chunks) decode at 76-83 tok/s both before (the one prose reply in baseline c=4 was 82.9) and after. At 50K the prose-reply requests A2/A3 decoded at about 31 tok/s against 42-43 for tool-call replies.
2. At 50K, only 3 requests run at once. KV, not `--max-num-seqs`, is the limit: 3 × 50K takes 76-83 % of the 115-block pool (about 32 blocks each, more than the plan's 23-block estimate). The 4th waits for a slot, which is why its TTFT is 43.8 s. Shorter prompts run 4-wide.
3. Plan deploy gate (free ≥ 1,536 MiB) **fails by about 450 MiB**. Used VRAM is about 500 MiB above the plan's ~30,600 estimate. The practical risk is lower than the gate assumed. Its biggest line was a 700 MiB idle ComfyUI CUDA context, and the new on-demand ComfyUI can't create one while the coder runs (see below). The ~1.09 GiB free is what's left for desktop growth. VRAM stayed flat through c=4 at 100 % util, with no OOM. If the orchestrator wants the gate met, the plan's L1 (`kvCacheMemory = 5905580032`, 5.5 GiB, about 105 blocks) frees about 512 MiB and still fits 3 × 50K.
4. Not run in this step: the plan's 30-minute c=4 soak (check 6b). This step covered about 8 minutes of mixed c=1-4 load including CPU-tier reloads, with no errors.

## ComfyUI share (arcane-atlas-esnixi-worker)

Intact and unchanged in policy. It is a time share through the exclusive lease, the same as before.

- `arcane-atlas-esnixi-worker`: running since the deploy (02:44:05), 0 restarts, running `arcane_worker_launch.py`.
- `comfy-esnixi-gate.socket`: active (listening) on 127.0.0.1:28188.
- `docker-comfy-esnixi.service`: inactive with Result=success. That is the on-demand idle state, and it's no longer the earlier `start-limit-hit`. It starts on the first gate connection.
- Group `vllm` is gid 978, which matches the container's `--group-add`. `/run/arcane-gpu/5090.lock` is `root:vllm 0660`.
- `/proc/locks`: vLLM PID 2783066 holds the exclusive flock, with no waiter.
- `nvidia-smi` lists only VLLM::EngineCore as a compute process, so ComfyUI isn't contending for VRAM.
- Not exercised end to end. I didn't trigger a Comfy job, because by design it would block in `comfy-esnixi-wait-gpu-lease` until the coder unit stops. As before (plan flag F2), ComfyUI can render only while the coder is down. This change doesn't make that worse.

## OmniRoute recommendation (FYI; not applied)

Yes, raise it. OmniRoute currently caps the 5090 at 1 request, so the new engine slots sit idle in production.

- **Change:** on provider connection `e9bd13fb-c6b6-4c18-b42f-3395266348ce` (esnixi-5090, provider `vllm`, serving `vllm/qwen3.8-27b-nvfp4` and `-balanced`), set **`maxConcurrent: 1 → 4`**.
    - This per-connection semaphore is the gate that actually fires (`executeTargetGates.ts:404-405`, `chatCore.ts` account semaphore; see `.agents/tasks/omniroute-tier1-priority/findings.md`).
    - 4 matches the switcher's `max_requests: 4` on both coder aliases and `--max-num-seqs 4`.
    - At ~50K prompts the engine runs 3 at once, and the 4th queues inside vLLM for about 20-35 s instead of overflowing. Use 3 only if overflowing long-prompt traffic to the next target is preferred over that short queue.
- **Persist it, or it reverts.** Both scripts re-apply 1 on every run. They're in `home/programs/` in nix-flakes-refactored on esnixi; both are currently clean in git, and I didn't edit them.
    - `home/programs/omniroute-routing.py:165`: `CONNECTIONS["vllm"]: {"maxConcurrent": 1}` → `4`
    - `home/programs/omniroute-mode.py:107`: `CONNECTIONS['vllm']: {'maxConcurrent': 1}` → `4`, and update the "runs one request slot" comment at :104-105.
- **No change needed for `concurrencyPerModel`.** It's inert for the `priority` strategy that `pool/tier1/code` uses. It's set to `1` for tier 1 in `omniroute-mode.py:210` and in `omniroute-routing.py:53/87`. Change it to 4 only on round-robin combos that include `vllm/qwen3.8-27b-nvfp4`, for consistency.
- **Context limits stay as they are:** `max_model_len` is still 131072.
