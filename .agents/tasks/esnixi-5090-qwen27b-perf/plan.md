# esnixi RTX 5090: Qwen3.8-27B NVFP4 coder speed + concurrency plan

Everything happens on `celes@192.168.42.254`, repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `feat/nvfp4-reader-fabric` (HEAD `2b1c1f7`). Only three files change: `esnixi/vllm.nix`, `esnixi/vllm-switch.py` and `esnixi/test_vllm_switch.py`. All three are clean in git today. Don't touch any of the other dirty or untracked files, including `esnixi/comfy_gpu_admission.py`, `esnixi/comfy-worker.nix`, `esnixi/vllm-proxy.nix`, `flake.lock` and `esnixi/__pycache__/`.

## The chosen config (one config)

| Knob                                          | Today                                                                           | Chosen                                                         | Where                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| maxModelLen                                   | 131072                                                                          | **131072** (unchanged)                                         | vllm.nix `systemd.services.vllm`                                  |
| maxNumSeqs                                    | 1                                                                               | **4**                                                          | vllm.nix                                                          |
| kvCacheMemory                                 | 4776620811 (4.45 GiB, 85 blocks)                                                | **6442450944** (6.00 GiB, about 114 blocks, about 240K tokens) | vllm.nix                                                          |
| kvOffloadingSize                              | null                                                                            | **32** (GiB of host RAM, native backend)                       | vllm.nix (mkVllmService appends `--kv-offloading-backend native`) |
| --max-num-batched-tokens                      | 256                                                                             | **5760**                                                       | vllm.nix `extraArgs`                                              |
| MTP                                           | `{"method":"mtp","num_speculative_tokens":3}`                                   | **unchanged (k=3)**                                            | vllm.nix `extraArgs`                                              |
| eager / CUDA graphs                           | graphs on (PIECEWISE, forced by spec-decode + FlashInfer), no `--enforce-eager` | **unchanged**                                                  | none                                                              |
| KV dtype                                      | nvfp4                                                                           | **unchanged** (hard-coded in mkVllmService)                    | none                                                              |
| prefix caching                                | on (mamba `align`, block 2848)                                                  | **unchanged**                                                  | none                                                              |
| switcher `max_requests` (coder + `-balanced`) | 1 / 1                                                                           | **4 / 4**                                                      | vllm-switch.py `MODELS`                                           |
| switcher `context` (coder + `-balanced`)      | 131072                                                                          | **131072** (unchanged, still == `--max-model-len`)             | vllm-switch.py                                                    |
| residency hysteresis                          | 90 s                                                                            | **90 s (unchanged)**                                           | vllm.nix `VLLM_SWITCH_RESIDENCY_SECONDS`                          |

The resulting ExecStart that `nix eval` must print, with the store prefix unchanged:

```
... vllm serve nvidia/Qwen3.8-27B-NVFP4 --served-model-name qwen3.8-27b-nvfp4 --host 127.0.0.1 --port 8010 --max-model-len 131072 --max-num-seqs 4 --kv-cache-memory=6442450944 --kv-cache-dtype nvfp4 --kv-offloading-size 32 --kv-offloading-backend native --language-model-only --linear-backend cutlass --reasoning-parser qwen3 --tool-call-parser qwen3_xml --enable-auto-tool-choice --max-num-batched-tokens 5760 --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

Every flag was checked against the installed build. I ran `vllm serve --help=all` from `/nix/store/97pb7hczrhpiwsqkma7f8dfb00qp5kyw-python3.14-vllm-0.31.0rc3` with the unit's `Environment=` (it works that way; it failed earlier only because the environment was missing).

- `--max-num-seqs`, `--max-num-batched-tokens`, `--kv-cache-memory-bytes` (`--kv-cache-memory=` is the accepted prefix form already in use), `--kv-offloading-size` (GiB, float) and `--kv-offloading-backend {lmcache,native}` all exist.
- With `native`, `config/vllm.py:_post_init_kv_transfer_config` builds `OffloadingConnector` with `cpu_bytes_to_use = size × 2^30`.

## Why it's slow today (evidence)

- **Fully serial.** `--max-num-seqs 1` in vLLM, plus `max_requests: 1` in the switcher, plus OmniRoute connection `maxConcurrent: 1`. The baseline shows c=4 taking exactly 4× one request's service time. The 282 s production TTFTs are pure queueing.
- **Tiny prefill chunks.** `--max-num-batched-tokens 256` gives about 3,030 tok/s prefill, so a 50K prompt takes about 197 steps and 16.6 s. vLLM warns about it itself at startup ("max_num_scheduled_tokens is set to 256 … suboptimal").
- **Hybrid block geometry.** The vLLM log says `Setting attention block size to 2848 tokens` and `Mamba cache mode is set to 'align'`. In align mode, `Scheduler._mamba_block_aligned_split` (`v1/core/sched/scheduler.py:414-480`) rounds every non-final prefill chunk **down to a multiple of 2848** once the budget is ≥ 2848. That puts a 4096 budget at 2848-token chunks, and both 5760 and 8192 at 5696-token chunks. 5760 gets the same chunk as 8192 with about 30 % less activation memory, which goes to KV instead. The extra 64 slots cover the other 3 sequences' MTP decode tokens (4 × (1+3) = 16) with slack.
- **Small KV pool, so prefix cache churns.** 85 blocks of about 53.6 MiB (`num_gpu_blocks="85"` in `vllm:cache_config_info`). The lifetime prefix hit rate is 22.8 % (541,120 / 2,375,696 queried tokens). Each agent conversation's long prefix gets evicted by the others and re-prefilled.
- Not causes: CUDA graphs are on (`cudagraph_mode=PIECEWISE`; FULL is refused with spec-decode on FlashInfer). There are no preemptions (`num_preemptions_total 0`). MTP works: the lifetime mean acceptance length is 1 + 85,869/43,994 = 2.95.

## VRAM budget, alongside ComfyUI

**How sharing actually works.** I read `gpu_launch.py`, `arcane_gpu.py` and `comfy_gpu_admission.py`. Sharing is by **time, not space**.

- `gpu_launch.py` takes an exclusive `flock` on `/run/arcane-gpu/5090.lock` before exec and holds it for the life of the process.
- ComfyUI (`docker-comfy-esnixi`, also launched through `gpu_launch.py`) can only load models while it holds that lease. It releases the lease after 5 s idle, once `torch.cuda.memory_reserved() < 128 MiB`.
- So Comfy models never sit next to the coder. The only Comfy cost that can sit next to the coder is Comfy's **idle CUDA context**: Comfy ran, released the lease, then the coder started. I budget **700 MiB** for that. It's unmeasured, because Comfy isn't running now (see flag F1).
- `--reserve-vram 6.0` is Comfy-internal and irrelevant here.

**Measured today** (`nvidia-smi`, vLLM log 01:09:40):

- The card is 32,607 MiB (torch sees 31.45 GiB = 32,204 MiB).
- At engine start, free is 30.16 GiB = 30,884 MiB. The desktop takes 577 MiB (Hyprland 305, quickshell 264, Xwayland 8) and the EngineCore context about 740 MiB.
- EngineCore uses 26,900 MiB: weights incl. MTP 20,316 (19.84 GiB) + KV 4,555 + graphs 113 + context, workspaces and activations at 256 tokens about 1,916.
- Free now: **4,886 MiB** (nvidia-smi), 4,724 MiB in torch terms.

**Activation estimate for 5760 tokens/step.** With `kv_cache_memory_bytes` set, vLLM skips memory profiling, so this is an estimate.

- Peak per layer is about 150 KB/token: the MLP gate_up is 2×17408 bf16, plus act, quant and residual buffers. The GDN chunk states are similar. Logits only cover sampled positions.
- Times 1.3 for allocator fragmentation, that's about **1,130 MiB** at 5760.
- Cross-check: the 9B reader at 8192 tokens reports "2.02 GiB for peak activation" in its log. That figure includes its vision-encoder profile, and the same model gives about 1.07 GiB text + about 1 GiB encoder, so it's consistent.
- The startup warmup runs a dummy batch at `max_num_batched_tokens`, so an under-estimate fails fast at unit start, not mid-request.

| Line item                                                                  | MiB         |
| -------------------------------------------------------------------------- | ----------- |
| Free headroom today (torch view)                                           | 4,724       |
| − extra KV 6,144 − 4,555                                                   | −1,589      |
| − extra activations 256 → 5760 (est.)                                      | −1,130      |
| − extra CUDA graphs for 4 seqs × 4 tokens, plus offload bookkeeping (est.) | −150        |
| **= free after change**                                                    | **≈ 1,855** |
| reserved from that: idle ComfyUI CUDA context (est.)                       | 700         |
| reserved: desktop growth (quickshell/Hyprland)                             | 256         |
| reserved: fragmentation/runtime slack                                      | ≈ 900       |

Expected nvidia-smi after deploy: about **30,600 MiB used, about 2,000 MiB free**. Deploy gate: free **≥ 1,536 MiB** at idle after warmup _and_ after the c=4 50K run (that's 700 + 256 + about 580 slack). If the gate fails, use fallback L1 below.

**What 114 blocks buys.**

- One 50K request uses about 23 blocks (18 attention blocks of 2848 tokens plus about 5 GDN state blocks; baseline: 27 % of 85), so **4 × 50K = 92 blocks**, with about 22 blocks left for GPU prefix cache.
- One full 131072 context takes about 52 blocks (vLLM's "Maximum concurrency for 131,072 tokens" should read about 1.8x, against 1.37x today).
- 4 × 100K doesn't fit. vLLM then preempts the newest request by recompute, and the CPU tier makes that a reload.

**Host RAM** (`free -g`: 125 total, 102 available; `/dev/shm` tmpfs 63 G):

- The offload region is a 32 GiB `/dev/shm/vllm_offload_<engine_id>.mmap`, pre-faulted and pinned.
- It's unlinked as soon as it's mapped (`shared_offload_region.py:185-200`, barrier always passed from `cpu/spec.py:179`), so no exit path, SIGKILL included, can leak it.
- It holds about 611 blocks, about 1.7M tokens, or roughly 34 resident 50K-token conversations.
- After it, about 65 GiB stays available.
- `LimitMEMLOCK=8M` doesn't apply: CUDA host registration isn't charged to RLIMIT_MEMLOCK.
- PCIe is Gen4 x16, so reloading a 50K prefix (about 1 GB) takes about 40-50 ms, against about 9 s to re-prefill it.

## Levers evaluated

| Lever                                                           | Decision                               | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-num-batched-tokens` 2048 / 4096 / 8192                   | **5760**                               | Align mode cuts chunks to multiples of 2848. 2048 never aligns, 4096 gives 2848-token chunks, and 8192 gives the same 5696 as 5760 for about 500 MiB more activation. Its leftover 2,496 tokens can't even start another long prompt (`scheduler.py:478-480` rounds that to 0).                                                                                                                                                                                                                                                                                                                                                                 |
| maxNumSeqs 2-4 with a bigger KV                                 | **4** at 6 GiB                         | 4 × 50K fits. 4 also matches the Zoo `ParallelTaskPool(4)` worker count. More seqs would over-subscribe a pool that VRAM can't grow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CPU KV offload (`--kv-offloading-size`, native)                 | **32 GiB**                             | This is the "use the 128 GB" lever. `OffloadingConnector` declares `SupportsHMA` and handles `MambaSpec` align mode (`offloading/scheduler.py:145-174`). Block 2848 == hash unit, so `blocks_per_chunk = 1`, which avoids the hash/chunk mismatch that open PR #58413 fixes. The MTP store-but-never-serve bug #52735 is fixed by #52771, which is in rc3 (compare: rc3 is 1,168 commits ahead). **Residual risk:** #50454 (OPEN) is an EngineCore assertion with offload + hybrid + prefix caching + MTP on 0.25.1. Its fix #50344 merged on 2026-08-09 and is in rc3, but the issue isn't closed. Mitigated by the soak gate and fallback L2. |
| Better prefix caching                                           | via the CPU tier                       | GPU-only caching can't keep more than about 4 long sessions. A finer `prefix_match_unit` was rejected: it reintroduces the hash ≠ chunk offload bug (#58413).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MTP token count                                                 | **keep 3**                             | Lifetime per-position acceptance is still high at position 3 (0.30-0.66). Long-context decode is bound by KV and weight reads, so verifying 4 tokens per sequence costs little more than 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--enforce-eager`                                               | **keep off**                           | Graphs are already PIECEWISE. With 4 seqs, vLLM auto-captures decode sizes up to 16 tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| KV dtype                                                        | **keep nvfp4**                         | fp8 doubles bytes per token, which leaves about 120K tokens at the same 6 GiB, so 4 × 50K wouldn't fit. A possible xqa decode-speed win from fp8 isn't worth losing concurrency. Not trialled.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--performance-mode`, `--stream-interval`, `--async-scheduling` | untouched                              | Already default or auto. No evidence they're a bottleneck.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| vLLM sleep mode (orchestrator directive in baseline.md)         | **deferred, needs user approval (F3)** | See flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Flags needing user approval (not planned; don't implement)

- **F1, ComfyUI is down, and that's unrelated to this change.**
    - `docker-comfy-esnixi.service` is `failed (start-limit-hit)` since 2026-10-03 00:24.
    - Cause: `PermissionError: [Errno 13] Permission denied: '/run/arcane-gpu/5090.lock'`. The container runs as uid 1000, and the lock is `root:vllm 0660`, created by `arcane-gpu-lock` in `esnixi/vllm-idle.nix:26-27`.
    - Fixing it means changing lock ownership or permissions, which is a lease/ComfyUI policy change. Ask the user.
    - The VRAM budget above already reserves room for Comfy's idle context once it's fixed.
- **F2, ComfyUI starves while the coder is up.** This policy already exists today: the coder holds the exclusive lease for its whole life. This plan doesn't change it. Releasing the lease while the coder is idle needs sleep mode plus a lease handoff (see F3).
- **F3, sleep mode.** Deferred because:
    - (a) The reader is removed from OmniRoute routing, so coder↔reader swaps are rare and the 52-72 s swap cost is mostly moot.
    - (b) #45268 (OPEN) gives EngineDeadError after the first L1 sleep/wake with `--kv-offloading-backend native`, which directly conflicts with the chosen RAM lever.
    - (c) It needs a switcher redesign (sleep/wake instead of stop/start, per-unit in-flight counting, a lease handoff in `gpu_launch`/`vllm_idle.py`), plus co-resident VRAM for a sleeping 9B against a budget that's now about 2 GiB.
    - If the user wants sleep mode, it's a separate workflow that picks it _instead of_ offload, or soak-tests both together.
- **F4, prefix-cache misses from merged system messages.** vLLM warns that the chat template forces system-first. `normalize_chat_system_messages` in the switcher merges any mid-conversation system message (inserted by OmniRoute compression) into the first message, which changes the prefix and misses the cache for the whole conversation. Fixing it changes prompt content or order, which is visible behaviour. Follow-up only.

## Other units (left intact)

- `vllm-reader.service` (9B): untouched. Its switcher entry stays `context 65536` and `max_requests 8`.
- `vllm-5090-fallback.service`: a dormant, operator-started disaster-recovery fallback (same patched vLLM, `0.75` util, 24576 context, no MTP, same port 8010). It Conflicts= with both other units and isn't in the switcher's `MODELS`. Untouched. The **mkVllmService defaults must not change**, because the fallback relies on them (`maxNumSeqs ? "1"`).

---

# Implementation Plan

All commands run on esnixi: `ssh celes@192.168.42.254`, then `cd /home/celes/sources/celesrenata/nix-flakes-refactored`. The baseline is green: `python3 esnixi/test_vllm_switch.py` gives 13 tests OK, and the current tree evaluates to the running system `/nix/store/s4dh8rhds4108hchlk1yl7blfzi6kybx-nixos-system-esnixi-…`, so a build only rebuilds the changed units.

- [ ]   1. **Edit the coder unit in `esnixi/vllm.nix` (only the `systemd.services.vllm = mkVllmService { … };` block, lines 159-170).**
        - Replace the stale one-line comment on `kvCacheMemory` (line 166) with a short block comment covering three points:
            - 4 concurrent sequences. `maxModelLen` and `maxNumSeqs` are COUPLED to `vllm-switch.py` `MODELS["qwen3.8-27b-nvfp4"]` and `["qwen3.8-27b-nvfp4-balanced"]` (`context` == maxModelLen, `max_requests` == maxNumSeqs), and `test_vllm_switch.py` parses this block and asserts both.
            - 6 GiB nvfp4 KV is about 114 hybrid blocks of 2848 tokens: 4 × ~50K requests, or about 1.8 full 131072 contexts. About 2 GiB of the card stays free for the desktop and an idle ComfyUI CUDA context. The lease is exclusive, so Comfy never runs models while this unit holds it.
            - 32 GiB of host RAM is a pinned CPU tier for evicted prefix-cache blocks.
        - Set:
            - `kvCacheMemory = 6442450944;`
            - add `kvOffloadingSize = 32;`
            - `maxNumSeqs = "4";`
            - keep `maxModelLen = "131072";`
        - In `extraArgs`, change only `--max-num-batched-tokens 256` to `--max-num-batched-tokens 5760`. Add a one-line comment above `extraArgs`: 5760 = 2 × 2848-token blocks, because mamba align mode cuts prefill chunks to block multiples, plus 64 slots for the other sequences' MTP decode tokens.
        - Leave the `--speculative-config` k=3, `leaseWrap`, `conflicts`, the reader block, the fallback block, `mkVllmService` and the switcher env (`VLLM_SWITCH_RESIDENCY_SECONDS = "90"`) unchanged.
          Files: `esnixi/vllm.nix`
          Verify: `nix eval --raw .#nixosConfigurations.esnixi.config.systemd.services.vllm.serviceConfig.ExecStart` prints the exact ExecStart in "The chosen config" (`--max-num-seqs 4 --kv-cache-memory=6442450944 --kv-cache-dtype nvfp4 --kv-offloading-size 32 --kv-offloading-backend native … --max-num-batched-tokens 5760 --speculative-config '{"method":"mtp","num_speculative_tokens":3}'`). Then:
        - `nix eval --raw .#nixosConfigurations.esnixi.config.systemd.services.vllm-reader.serviceConfig.ExecStart` and `…vllm-5090-fallback…` are byte-identical to before the edit. Capture both before editing.
        - `nix eval --json .#nixosConfigurations.esnixi.config.systemd.services.vllm-switcher.environment` still shows `VLLM_SWITCH_RESIDENCY_SECONDS = "90"`.

- [ ]   2. **Raise the switcher's coder slot count in `esnixi/vllm-switch.py`.**
        - In `MODELS`, set `"max_requests": 4` for both `"qwen3.8-27b-nvfp4"` (line 56) and `BALANCED_MODEL_ID` (line 63).
        - Keep both `"context": 131072`.
        - Add a comment above the coder entry, mirroring the reader's coupling comment: COUPLED to `vllm.service` in `esnixi/vllm.nix`, with `context` == `--max-model-len` (otherwise the readiness poll never matches) and `max_requests` == `--max-num-seqs`. Both coder aliases share one engine and the single `active_requests` counter, so they must carry the same `max_requests`. The test asserts this.
        - No logic change is needed. The checks I made:
            - `acquire_model` admits same-unit requests while `active_requests < max_requests`.
            - It only swaps units when `active_requests == 0` and the 90 s residency has expired.
            - `release_model` decrements the counter and re-stamps `last_activity`.
            - The reader idle stop is gated on `READER_UNITS`.
        - So "busy" already means in-flight > 0, and hysteresis is preserved. Leave `RESIDENCY_SECONDS`, `LOCK_WAIT_SECONDS` (3 s, after which a 5th request gets a 409 and goes to the next OmniRoute target) and `MODEL_READY_SECONDS` (540 s, which covers the longer start from pinning 32 GiB) unchanged.
          Files: `esnixi/vllm-switch.py`
          Verify: `python3 esnixi/test_vllm_switch.py`. All 13 existing tests still pass (none depends on coder `max_requests == 1`; (e) seeds `active_requests = 1` against a _reader_ request, which is still a cross-unit 409).

- [ ]   3. **Extend `esnixi/test_vllm_switch.py` with a nix-coupling guard and a concurrency test.** This depends on items 1 and 2.
        - Add `import re` and a helper, `_nix_block(service)`. It reads `vllm.nix` next to the test file and extracts the block with `re.search(r"systemd\.services\.%s = mkVllmService \{(.*?)\n  \};" % re.escape(service), src, re.S)`. The `"vllm = "` with a space-equals form doesn't match `vllm-reader`. A second helper, `_nix_attr(block, name)`, returns `int(re.search(r'%s = "(\d+)";' % name, block).group(1))`. Fail loudly (`assertIsNotNone`) if the block or attribute isn't found.
        - `test_m_coder_coupling_matches_vllm_nix`:
            - For `"qwen3.8-27b-nvfp4"` and `"qwen3.8-27b-nvfp4-balanced"`, assert `unit == "vllm.service"` and `context == _nix_attr(_nix_block("vllm"), "maxModelLen")` (131072).
            - Assert `max_requests == _nix_attr(_nix_block("vllm"), "maxNumSeqs")` (4).
            - Assert both aliases have equal `max_requests`.
            - Also assert the reader's `context == _nix_attr(_nix_block("vllm-reader"), "maxModelLen")` (65536), so guard (f) becomes a real file coupling.
        - `test_n_coder_admits_up_to_max_requests_then_409`:
            - Set `RESIDENCY_SECONDS = 90`, `LOCK_WAIT_SECONDS = 0.2`, and `_seed_active(CODER, age=0)`.
            - Acquire twice with `CODER` and twice with `"qwen3.8-27b-nvfp4-balanced"` from 4 threads. All must return True, with `active_requests == 4`.
            - A 5th `acquire_model(CODER)` returns False.
            - A reader `acquire_model(READER)` with `RESIDENCY_SECONDS = 0` also returns False, because the coder is busy.
            - `verb_unit_sequence()` has no start or stop.
            - Release all 4. `active_requests == 0`, `active_model == CODER`, and `last_activity` is stamped.
        - Update the module docstring list with (m) and (n). Keep tests deterministic: threads joined with a timeout, and the globals restored by the existing `setUp`/`tearDown`.
          Files: `esnixi/test_vllm_switch.py`
          Verify: `python3 esnixi/test_vllm_switch.py` gives `Ran 15 tests … OK`. As a negative check, temporarily set the coder `maxNumSeqs = "1"` in `esnixi/vllm.nix` and confirm `test_m` fails. Then restore `"4"` with the edit tool and confirm `python3 esnixi/test_vllm_switch.py` is OK again.

- [ ]   4. **Full evaluation + build of the system closure (no switch), then commit.**
        - `nix build --no-link .#nixosConfigurations.esnixi.config.system.build.toplevel` succeeds and builds only unit/script derivations. Don't use `nixos-rebuild build`, which drops a `result` symlink in the repo.
        - `git status --short` shows only the three intended files as yours, with all other pre-existing dirty files untouched.
        - Commit with explicit paths only: `git add esnixi/vllm.nix esnixi/vllm-switch.py esnixi/test_vllm_switch.py`, then `git commit -m "perf(esnixi): 5090 coder 4 seqs, 6 GiB KV, 5760-token prefill chunks, 32 GiB CPU KV offload"`, with a body listing the values, the VRAM gate and the fallback ladder. Never `git add -A`. Never stage `esnixi/__pycache__/`. Don't push.
          Files: none new.
          Verify: `git show --stat HEAD` lists exactly those 3 files, and `python3 esnixi/test_vllm_switch.py` is still OK.

- [ ]   5. **Deploy gate (user rebuilds).**
        - The user runs `sudo nixos-rebuild switch --flake .#esnixi`. celes has no passwordless sudo.
        - The switch restarts `vllm.service`, an outage of about 60-80 s (cold start is about 52 s plus pinning 32 GiB), and `vllm-switcher.service` (in-memory state resets, which is harmless).
        - Watch the first start: `journalctl -u vllm -f`. On a startup OOM the unit restart-loops every 10 s (`Restart=on-failure`). Apply fallback L1 immediately rather than letting it loop.
          Verify (read-only, as celes):
        - `systemctl show vllm -p ActiveState -p NRestarts` gives active, with NRestarts 0.
        - The journal shows `non-default args … 'max_num_seqs': 4 … 'kv_cache_memory_bytes': 6442450944`, `Chunked prefill is enabled with max_num_batched_tokens=5760`, `GPU KV cache size: ~240,000 tokens, Maximum concurrency for 131,072 tokens per request: ~1.8x`, `Created mmap file /dev/shm/vllm_offload_….mmap (~34 GB)` and `Unlinked mmap file`, and no `OutOfMemory` / `CUDA out of memory`.
        - `curl -s 127.0.0.1:8010/metrics | grep cache_config_info` shows `kv_offloading_size` = 32, `num_gpu_blocks` about 114, and `kv_offloading_backend="native"`.
        - `curl -s 127.0.0.1:8010/v1/models` shows `max_model_len` 131072, so the switcher readiness still matches.
        - `nvidia-smi --query-gpu=memory.used,memory.free --format=csv` shows free **≥ 1,536 MiB**.
        - `free -g` shows available ≥ 55 GiB.

- [ ]   6. **Re-measure against the baseline (same method as baseline.md).**
       Run `bench.py` and `stream_probe.py` from `.agents/tasks/esnixi-5090-qwen27b-perf/` directly against `127.0.0.1:8010`:
        - 50.3K-token unique-nonce prompts, `tool_choice: "auto"`, thinking off, `max_tokens = min_tokens = 512`.
        - Phases: c=1/2/3/4 at 50K, and c=1/4 at 4K.
        - Wait for the engine to go idle first, as before.

        Then add three new checks:
        - **(a) Offload efficacy.**
            1. Send prompt A (fixed 50K prefix).
            2. Evict A from the GPU with 8 unique 50K prompts at c=4 (8 × 23 = 184 blocks, more than 114).
            3. Resend A's prefix with a new suffix.
            4. Expect `vllm:external_prefix_cache_hits_total` to rise by ≥ 40,000 tokens, and A's TTFT ≤ 3 s (against about 10 s cold).
        - **(b) Soak.** At least 30 min of c=4 mixed traffic with shared system-prompt prefixes. Must hold:
            - `NRestarts` unchanged
            - no `EngineDeadError` or `AssertionError` (especially `offloading/scheduler.py`) in `journalctl -u vllm`
            - `num_preemptions_total` reported
        - **(c)** Sample nvidia-smi free during and after c=4; it must stay ≥ 1,536 MiB.

        Targets:
        - c=1 50K cold TTFT ≤ 12 s (baseline 16.9 s, prefill ≥ 4,500 tok/s).
        - c=4 50K: `num_requests_running` max 4 (baseline 1), wall ≤ 80 s (baseline 116.1 s), aggregate output ≥ 25 tok/s (baseline 17.6).
        - c=4 4K: aggregate output ≥ 150 tok/s (baseline 83).
        - Single-sequence decode at 50K ≥ 38 tok/s (baseline 43; ≤ 10 % regression allowed).
        - MTP mean acceptance length ≥ 2.2.

        Record everything in `.agents/tasks/esnixi-5090-qwen27b-perf/remeasure.md`, side by side with the baseline table. Through the authenticated switcher (needs the root-only bearer token, so likely an orchestrator or OmniRoute check): 4 concurrent requests are admitted, and a 5th gets a 409 after about 3 s.
        Files: `.agents/tasks/esnixi-5090-qwen27b-perf/remeasure.md` (artifact, not in the nix repo).
        Verify: the table is filled in, and every gate is marked PASS or FAIL with evidence.

## Fallback ladder (pre-declared; apply only the step that matches the failure, then rebuild and re-verify)

Each step is a one-value edit in the `systemd.services.vllm` block plus a re-run of `python3 esnixi/test_vllm_switch.py`, then a new commit (don't amend).

- **L1, VRAM.** Triggered by a startup OOM, or free < 1,536 MiB at idle or under c=4. Change `kvCacheMemory = 6442450944` to `5905580032` (5.5 GiB, about 105 blocks, still ≥ 4 × 50K at 92). If that still fails, use L3.
- **L2, offload instability.** Triggered by any EngineCore crash traced to the offload connector, or `external_prefix_cache_hits_total` staying 0 in check 6a. Set `kvOffloadingSize` to `null` (delete the line). Keep everything else. Report to the user that the RAM tier is blocked on upstream #50454 or #58413.
- **L3, activation OOM at runtime.** Change `--max-num-batched-tokens 5760` to `2880` (one 2848 block + 32 slots).

`maxNumSeqs` and `max_requests` stay at 4 on every rung. If the user later wants fewer seqs, both must change together, and `test_m` enforces that.

## OmniRoute note (FYI; the orchestrator applies it, not part of the nix commit)

- **Raise the per-connection semaphore on `e9bd13fb-c6b6-4c18-b42f-3395266348ce`** (esnixi-5090, provider `vllm`, which serves `vllm/qwen3.8-27b-nvfp4` and the `-balanced` alias): `maxConcurrent` **1 → 4**.
    - Per `.agents/tasks/omniroute-tier1-priority/findings.md`, this per-connection `maxConcurrent` is the only gate that fires (`executeTargetGates.ts:404-405`).
    - The combo-level `concurrencyPerModel` is inert for the `priority` strategy, so it doesn't need raising. If it's touched for consistency, use 4 on combos that contain `vllm/qwen3.8-27b-nvfp4`.
    - Apply it only _after_ step 5 passes. Before that, extra requests just get the switcher's 409 and fall through, which is harmless but wasteful.
- **Persisted policy that would revert it:**
    - `home/programs/omniroute-routing.py:165`: `CONNECTIONS["vllm"]: {"maxConcurrent": 1}`
    - `home/programs/omniroute-mode.py:107`: `CONNECTIONS['vllm']: {'maxConcurrent': 1}`, with the comment at :104-105 "runs one request slot"
    - Both files are clean in git. Re-running either script resets the connection to 1 unless they're changed to 4 too.
- **Unchanged context limits:** `max_model_len` stays 131072, so `context_length 131072` and `max_input_tokens 98304` stay as they are.
