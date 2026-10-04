# esnixi RTX 5090 VRAM measurements (2026-10-03, gen 437, HEAD 9fc7375)

Measurement only. No files were edited, built or deployed on esnixi.

## 0. Safety check

```
$ git -C /home/celes/sources/celesrenata/nix-flakes-refactored status
On branch main
Your branch is ahead of 'origin/main' by 1 commit.
Untracked files:
	distcc-monitor.sh
nothing added to commit but untracked files present (use "git add" to track)

$ git ... log --oneline -5
9fc7375 fix(esnixi): fail-safe vLLM switcher (rollback, breaker, watchdog, deadlines)
e700258 fix(esnixi): sleep-mode units pass a startup gpu-memory-utilization gate
c9be093 chore: add Spec Kit 1.0.11 scaffold used by the Zoo speckit commands
a95f938 feat(home): Zoo parallel workers, OmniRoute editor/MCP config, model records
5075e89 feat(esnixi): wire vLLM switcher, on-demand ComfyUI, backups, OmniRoute WireGuard
```

HEAD is 9fc7375. The tree is clean apart from the untracked distcc-monitor.sh. Baseline tests pass:
`test_vllm_switch.py` ran 32 tests OK and `test_vllm_idle.py` ran 7 tests OK.

## 1. Current live state: coder awake, reader NOT resident

The live state was not "coder awake + reader asleep". The gen-437 deploy (04:58:55)
stopped the sleeping reader. systemd then restarted it at 04:59:04 because the unit
was active. Its `gpu_launch.py` is now blocked in `flock()` on the lease the awake
coder holds, so it has not initialised CUDA and holds 0 MiB:

```
$ grep $(stat -c %i /run/arcane-gpu/5090.lock) /proc/locks
37: FLOCK  ADVISORY  WRITE 3540474 00:1b:994238 0 EOF        <- vllm.service (coder) holds it
37: -> FLOCK  ADVISORY  WRITE 3855876 00:1b:994238 0 EOF     <- vllm-reader launcher, waiting
```

```
$ nvidia-smi   (06:20:01, coder serving Running 2-3, 94% util)
| 34%   56C    P1    189W /  575W |   30657MiB /  32607MiB |     94%      Default |
|    0   N/A  N/A          525644      G   ...26-09-23_e368c13/bin/Hyprland        305MiB |
|    0   N/A  N/A          525757      G   ...ickshell-0.3.1/bin/quickshell         64MiB |
|    0   N/A  N/A          525775      G   quickshell                              200MiB |
|    0   N/A  N/A          525832      G   Xwayland                                  8MiB |
|    0   N/A  N/A         3543111      C   VLLM::EngineCore                      29708MiB |
memory.total [MiB], memory.used [MiB], memory.free [MiB]
32607 MiB, 30657 MiB, 1545 MiB
```

Six samples taken 5 s apart (06:25:46 to 06:26:11) all read 30657 used / 1545 free,
at 95-96% util with `{"sleeping": false, "active": 3, "lease_held": true}`.

Coder startup log (04:18:26 start, reader not resident at the time):

```
Model loading took 19.84 GiB memory and 12.823029 seconds
Setting attention block size to 2848 tokens to ensure that attention page size is >= mamba page size.
Initial free memory 30.16 GiB, reserved 5.0 GiB memory for KV Cache as specified by kv_cache_memory_bytes config and skipped memory profiling.
Add 3 padding layers, may waste at most 6.25% KV cache memory
GPU KV cache size: 202,950 tokens, Maximum concurrency for 131,072 tokens per request: 1.55x
kv cache group sizes [2848, 2848, 2848, 2848]
Graph capturing finished in 2 secs, took 0.20 GiB
KV offloading: EAGLE/MTP draft attention groups [3] detected.
```

Coder sleep (04:25:32, when handing the GPU to the reader):

```
CuMemAllocator: sleep freed 25.10 GiB memory in total, of which 20.11 GiB is backed up in CPU and the rest 4.99 GiB is discarded directly.
Sleep mode freed 25.17 GiB memory, 3.23 GiB memory is still in use.
```

Reader (cold start at 04:25:32, ready at 04:27:21, about 110 s):

```
Model loading took 8.41 GiB memory and 9.352493 seconds
Initial free memory 27.72 GiB, reserved 4.0 GiB memory for KV Cache ...
GPU KV cache size: 386,974 tokens, Maximum concurrency for 65,536 tokens per request: 5.90x
Graph capturing finished in 2 secs, took 0.11 GiB
init engine (profile, create kv cache, warmup model) took 71.75 s (compilation: 32.33 s)
```

Reader sleep (04:27:23, with the coder already asleep):

```
CuMemAllocator: sleep freed 12.52 GiB memory in total, of which 8.54 GiB is backed up in CPU and the rest 3.99 GiB is discarded directly.
Sleep mode freed 12.55 GiB memory, 4.79 GiB memory is still in use.
```

"still in use" is device-wide (total minus free), not per process.

## 2. Coder awake + reader stopped

The reader holds 0 MiB right now and does not appear in nvidia-smi (section 1), so
the live numbers above already are the "reader stopped" measurement. I did not run
`systemctl stop vllm-reader`. celes has no non-interactive sudo (`sudo -n true`
fails with "a password is required"), and a stop/start cycle would only re-create
the same blocked launcher. The box was left exactly as found.

## 3. Derived breakdown (MiB unless noted)

| Item                                                | Value                                  | Source               |
| --------------------------------------------------- | -------------------------------------- | -------------------- |
| Card total                                          | 32607                                  | nvidia-smi           |
| Driver-reserved (never free)                        | 405                                    | 32607 - 30657 - 1545 |
| Usable device total                                 | 32202 = 31.45 GiB                      | matches vLLM's total |
| Desktop + unattributed                              | 949 (577 processes + 372 unattributed) | 30657 - 29708        |
| Coder awake (warmup high-water)                     | 29708 = 29.01 GiB                      | nvidia-smi           |
| of which cumem (weights 20.11 + KV 4.99 GiB)        | 25.10 GiB                              | sleep log            |
| of which non-cumem                                  | 3.91 GiB                               |                      |
| Coder sleep residual                                | 2.30 GiB                               | 3.23 - 0.93          |
| Activation cache freed on sleep, regrown after wake | ~1.61 GiB                              | 3.91 - 2.30          |
| Reader sleep residual                               | 1.56 GiB                               | 4.79 - 3.23          |
| Reader awake                                        | ~14.1 GiB                              | 12.55 + 1.56         |
| Free, coder awake, reader stopped                   | 1545                                   | measured             |
| Free, coder awake, reader asleep                    | 1545 - 1597 = -52                      | reconstructed        |

The reader's sleep residual is CUDA context plus non-cumem workspaces. Sleep frees
its weights and KV, so shrinking the reader's model or KV does not reduce it.

Coder awake + reader asleep was not reproduced live. Doing that would mean forcing a
reader switch, which sleeps the coder while it serves three Zoo requests. In
04:27-04:58 both units were resident and the coder ran at Running 1 only, with no
OOM. It woke with its activation cache emptied, and c=1 serving regrew less than
the 1.56 GiB of headroom that was left.

## 4. KV block accounting (hybrid GDN + attention, MTP 3)

- Groups: 4 groups of 17 layers each. Group 3 is attention: 16 full-attention layers plus 1 MTP draft layer. The other 3 groups are GDN: 48 layers + 3 padding layers = 3 x 17.
- 5 GiB holds 96 blocks, 95 usable (KV usage 0.768421 = 73/95). One block is about 53.3 MiB (55.9 MB) and holds 2848 tokens of attention, which is 19,636 B/token for attention alone.
- GDN state per running sequence in mamba align mode (vLLM `MambaSpec.max_memory_usage_bytes`) is 2 + num_speculative_blocks per group. num_speculative_blocks = num_speculative_tokens = 3, so that is 5 x 3 groups = 15 blocks/seq (about 0.78 GiB per sequence).
- Blocks per sequence of L tokens = ceil((L+3)/2848) + 15. Check: 131072 -> 47 + 15 = 62, and 96/62 = 1.548 = vLLM's "Maximum concurrency 1.55x".
- 55K -> 35 blocks, 57K -> 36 blocks.
- 25,534 B/token amortizes the fixed 15 blocks only at about 147K-token sequences. The real cost is 35,320 B/token at 57K.
- The brief's figure 4 x 57K x 25,534 = 5.82e9 B is 5.42 GiB, not 5.8 GiB.

### How many ~55K sequences does the current 5 GiB hold?

95 usable / 35 = 2.7, so 2 sequences without prefix sharing. Three need 105 blocks.

Observed peaks: Running 3 at 91/95 blocks (95.8%) and "Running: 3, Waiting: 1". Taking
the 45 GDN blocks out of 91 leaves 46 attention blocks, about 15.3 per sequence (about
43.7K unique tokens each). Three ~55K requests therefore coexist only with roughly
10+ blocks (~28K+ tokens) of shared prefix (Zoo system prompt and tools; prefix
hit rate is 21.7%). The 4th request waits. Prompt metrics: 119 requests, mean 41.5K
tokens, 65 above 20K, 40 in the 50-100K bucket.

### Budget vs KV size (reader stopped; free = 1545 - (X - 5 GiB))

| --kv-cache-memory | blocks (usable) | free at peak    | fits                      |
| ----------------- | --------------- | --------------- | ------------------------- |
| 5.0 GiB (current) | 96 (95)         | 1545 MiB        | 2 x 57K                   |
| 5.5 GiB           | 105 (104)       | 1033 MiB        | 2 x 57K, 3 x 54K, 4 x 31K |
| 6.0 GiB           | 115 (114)       | 521 MiB         | 3 x 57K                   |
| 6.5 GiB           | 124 (123)       | 9 MiB           | 3 x 57K                   |
| 7.0 GiB           | 134 (133)       | -503 MiB (OOM)  | 3 x 57K                   |
| 7.55 GiB          | 145 (144)       | -1035 MiB (OOM) | 4 x 57K                   |

With the reader asleep and resident, subtract another 1597 MiB from every "free" value.

The blocks column assumes no prefix sharing. Shared Zoo prefixes stretch it.

## 5. Startup gates (usable total 31.45 GiB)

- Reader 0.50 = 15.72 GiB. Its gate is checked with the coder asleep: observed initial free was 27.72 GiB, so it passes with about 12 GiB to spare. Coder KV size does not change this, because sleep discards the KV.
- Coder 0.80 = 25.16 GiB. The gate is checked only on a cold start. A sleep-mode wake is not gated: it maps memory and OOMs if there is no room.
    - Cold start with the reader stopped: initial free about 30.16 GiB, which passes.
    - Cold start with the reader asleep: about 28.60 GiB, which also passes. But the coder then needs about 29.15 GiB (29.01 awake, +0.5 at 5.5 GiB KV, minus 0.36 own context already counted). It OOMs late instead of failing fast, so the 0.80 gate does not protect anything.
    - 0.92 = 28.93 GiB would reject the reader-asleep case (28.60) and accept the clean case (30.16, 1.23 GiB margin).
