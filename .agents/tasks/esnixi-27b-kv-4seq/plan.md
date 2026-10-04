# Plan: more 27B coder concurrency on the RTX 5090 (esnixi)

Raw measurements are in `measurements.md` (same directory). Repo:
`/home/celes/sources/celesrenata/nix-flakes-refactored` on esnixi, branch main, HEAD 9fc7375.

## Decision summary

- Set `--kv-cache-memory` to **5905580032 (5.5 GiB)**, up from 5368709120 (5 GiB). That is 105 blocks (104 usable) instead of 96 (95), and leaves about 1033 MiB free at the coder's measured peak with the reader not resident.
- Reader strategy: **non-resident whenever the coder is awake.** The switcher stops the reader, rather than sleeping it, every time it selects the coder. Shrinking the reader does not help: its 1.56 GiB sleep residual is CUDA context and workspaces, independent of model and KV size. The reader keeps its 300 s self-sleep for the ComfyUI handoff, which only happens while the coder is already asleep.
- Raise the coder startup gate `gpuMemoryUtilization` from "0.80" to "0.92", so a cold start fails fast instead of OOMing late.
- 4 x 57K is **not reachable with MTP num_speculative_tokens=3** on this card. Each sequence carries 15 GDN state blocks (about 0.78 GiB), so 4 x 57K needs 145 blocks = 7.55 GiB of KV. That needs +2.55 GiB, and only 1.51 GiB is free even with the reader stopped. The brief's 6.5-7 GiB target leaves 9 MiB at 6.5 GiB and OOMs by 503 MiB at 7 GiB, so it is rejected.
- Getting true 4 x 57K means turning MTP off (Option B below). That trades away per-request decode speed, so it is a product decision for the user and is not part of this plan.

## Why 5.5 GiB

- Coder footprint is the allocator high-water mark after vLLM warmup at `max_num_batched_tokens` 5760 and `max_num_seqs` 4: 29708 MiB. It held flat across 2 h of R=3 serving. Activations are bounded by batched tokens, not concurrency, so c=4 adds nothing beyond KV, which is fixed.
- Free at peak = 1545 - (X - 5120) MiB. Keeping >= 1024 MiB free gives X <= 5641 MiB. The largest round value is 5.5 GiB = 5632 MiB = 5905580032 B, which leaves 1033 MiB free.
- Blocks = floor(X / 53.33 MiB), so 5.5 GiB gives 105 (104 usable). Each sequence costs ceil((L+3)/2848) + 15 blocks, where +3 covers MTP lookahead and +15 is GDN state for 3 groups x (2 + 3 spec).
    - 2 x 57K = 72 blocks: fits.
    - 3 x 54K = 102 blocks: fits. 3 x 57K = 108: does not.
    - 4 x 31K = 104 blocks: fits. Four longer requests fit only with a shared Zoo prefix. For example, 4 x 57K with 40K shared needs 15 + 4 x 6 + 60 = 99 blocks.
    - Today (95 usable) the most is 3 x 45K.
- 6.0 GiB (114 usable, 3 x 57K) would leave only 521 MiB free. It is rejected under the >= 1 GiB rule.

## Why the reader must be non-resident

- Coder awake (29708) + reader asleep (1597) + desktop (949) = 32254 MiB, against 32202 usable. That is 52 MiB short at the coder's peak. Today's 5 GiB config is already over budget whenever the reader has run since the coder last started. It survived 04:27-04:58 only because the coder woke with an empty activation cache and served c=1.
- With the reader resident-asleep, the most KV that keeps 1 GiB free is 4044 MiB, below the current 5120.
- Stopping is also faster for the coder. Stopping the reader took 4 s (04:58:55 to 04:58:59), while sleeping an awake reader took 7.95 s.
- Cost: the first reader request after a coder session pays a cold start (about 110 s measured, including 32 s of compilation, which should be cached on later starts) instead of a ~1 s wake. That is within `VLLM_SWITCH_START_SECONDS` = 300. The OmniRoute reader-tier timeout must allow for it, or the request falls through to the next tier.

## Startup gates after the change (usable 31.45 GiB)

- Reader 0.50 = 15.72 GiB. With the coder asleep (3.23 GiB device-wide in use), observed free is 27.72 GiB, so it passes. It is unaffected by coder KV, because sleep discards the KV.
- Coder cold start, gate 0.92 = 28.93 GiB:
    - Reader stopped: about 30.16 GiB free, so it passes with 1.23 GiB margin.
    - Reader asleep: about 28.60 GiB, so it is rejected (fail fast rather than OOM after loading).
    - The new awake footprint is about 29.51 GiB (29708 + 512 MiB).
- Coder wake is not gated by vLLM. With the switcher rule below, the reader is always stopped before the coder is selected, so the wake runs with: residual 2.30 + cumem 20.11 + 5.5 + regrowth about 1.61 + desktop 0.93 = 30.45 GiB. That is about 1.0 GiB free.

## Edits

### esnixi/vllm.nix (coder block, `systemd.services.vllm`)

1. Change `kvCacheMemory = 5368709120;` to `kvCacheMemory = 5905580032;`. Replace the comment at lines 195-197 with the arithmetic: 5.5 GiB = 105 blocks of 2848 tokens (104 usable); 15 GDN state blocks per sequence (MTP 3); 3 x 54K or 2 x 57K without shared prefix; peak free about 1.0 GiB with the reader stopped (29708 + 512 MiB of 32202 usable).
2. Change `gpuMemoryUtilization = "0.80";` to `"0.92"`. Comment: the awake footprint is about 29.5 GiB, and 0.92 x 31.45 = 28.93 GiB. A sleeping reader leaves 28.60 GiB, so the coder refuses to start instead of OOMing.
3. Update the generic comment at lines 127-130 ("a sleeping neighbour keeps ~3 GiB"). The measured residuals are 2.30 GiB for the coder and 1.56 GiB for the reader, plus 0.93 GiB desktop.

### esnixi/vllm.nix (reader block, `systemd.services.vllm-reader`)

4. No functional change: keep `restart = "no"`, `idleSeconds = "300"`, `kvCacheMemory = 4294967296`, `gpuMemoryUtilization = "0.50"`. Rewrite the comment at lines 211-213: the reader is no longer co-resident with an awake coder. The switcher stops it whenever it selects the coder, and the reader self-sleeps after 5 minutes idle only to free the lease for ComfyUI while the coder is asleep.
5. Update the trailing comment at lines 328-329 to match.

### esnixi/vllm-switch.py

6. In `select_model`, sleep the other unit only when the target is not the primary (coder). When the target is the coder, every other unit is stopped and drained:
    ```python
    # The coder's KV budget assumes no resident neighbour (a sleeping reader keeps
    # 1.56 GiB): sleep others only to make room for a non-primary target.
    if active == "active" and target_unit != PRIMARY_UNIT and sleep_unit(other, deadline):
    ```
    This covers the acquire, rollback (restore to coder) and watchdog paths, because all of them go through `select_model`/`safe_select`.
7. Update the comment in `release()` (lines 627-628) and the module docstring if it describes reader sleep on a coder swap.
8. MODELS needs **no change**. `context`, `max_requests` and `port` are unchanged (131072 / 4 / 8010, and 65536 / 8 / 8012). The `test_m` coupling parses only maxModelLen, maxNumSeqs and port, so the KV change does not touch it.

### esnixi/test_vllm_switch.py

9. `test_d_warm_swap_is_sleep_only`: split the loop. Coder to reader stays `[("sleep", CODER_UNIT)]`. Reader to coder becomes `[("stop", READER_UNIT)]`, and the coder is not slept or started.
10. `test_r_reader_during_coder_residency_409_no_sleep`, line 577: expect `[("stop", READER_UNIT)]`.
11. Add `test_a2_coder_stops_reader_instead_of_sleeping`. Cover the reader both running-awake and running-asleep. Acquiring the coder must emit `("stop", READER_UNIT)`, never `("sleep", READER_UNIT)`, and `gpu_owners()` must be `[CODER_UNIT]`.
12. Extend `test_z` (or add a test) to assert the coder block contains `kvCacheMemory = 5905580032;` and `gpuMemoryUtilization = "0.92";`, so a later edit cannot silently grow the KV.
13. Update the module docstring entries (a) and (d) to describe the new semantics.

No changeset or CHANGELOG entries.

## Verification

On esnixi, in `esnixi/`:

- `python3 test_vllm_switch.py` (32 tests now, plus the new ones)
- `python3 test_vllm_idle.py` (7 tests; vllm_idle.py is unchanged)
- From the repo root: `nix eval`/`nixos-rebuild build --flake .#esnixi` to confirm the ExecStart renders `--kv-cache-memory=5905580032 --gpu-memory-utilization 0.92`.

After deploying (`nixos-rebuild switch`, operator-run):

- `sudo systemctl stop vllm-reader`. Its launcher is currently blocked on the coder's lease since the gen-437 restart. Restart `vllm.service` so the new KV and gate take effect.
- Confirm the startup log shows "reserved 5.5 GiB" and about 105 blocks. Calculation: `GPU KV cache size` / 131072 x 62 = blocks, so expect a "Maximum concurrency" of about 1.69x.
- Under Zoo c=4 load, nvidia-smi free should be >= ~1000 MiB.
- Trigger one reader request and then a coder request. The switcher log should say "stopping vllm-reader.service" (not "slept"), the reader should be gone from nvidia-smi, and the coder should wake.

## Option B (needs user sign-off, not in this plan): true 4 x 57K

Set `num_speculative_tokens` to 0 (drop MTP). Each sequence then needs 6 GDN blocks instead of 15, and blocks shrink by 16/17 (no MTP layer) to about 50.2 MiB. 4 x 57K = 4 x 27 + 1 = 109 blocks = 5.34 GiB, and 5.5 GiB gives 112 blocks, so it fits with >= 1 GiB free plus the freed MTP weights. The cost is losing MTP's per-request decode speedup. MTP 1 token is not enough: 121 blocks = 6.30 GiB, which leaves about 214 MiB free.
