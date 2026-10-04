# esnixi 5090 coder: 4 concurrent sequences, 6 GiB KV, 5760-token prefill chunks, 32 GiB CPU KV tier

Commit `3601dd8` on `feat/nvfp4-reader-fabric` takes the Qwen3.8-27B NVFP4 coder (`vllm.service`) off fully serial operation. It raises `--max-num-seqs` from 1 to 4, grows the fixed KV pool from 4.45 to 6 GiB, raises `--max-num-batched-tokens` from 256 to 5760 to match mamba align-mode chunking, and adds a 32 GiB native CPU KV-offload tier. The switcher's coder slots go from 1 to 4 on both aliases, and a new unit test parses `vllm.nix` so switcher `context`/`max_requests` can't drift from `--max-model-len`/`--max-num-seqs` again. Implementation matches the plan exactly: the ExecStart was eval-checked, the reader and fallback units are byte-identical, and residency stays at 90 s. Watch for: the post-deploy VRAM gate can't exercise the ComfyUI idle-context case while ComfyUI is down (F1), and the OmniRoute per-connection `maxConcurrent: 1` (plus two scripts that persist it) still caps real traffic at one request until it's changed.

**Verdict**: APPROVED

## High-level view

On the engine side, only the `systemd.services.vllm` block changed. `mkVllmService` already supported `kvOffloadingSize` and expands it to `--kv-offloading-size 32 --kv-offloading-backend native`. Its defaults (`maxNumSeqs ? "1"`) are unchanged, so the dormant fallback unit keeps its behaviour. All four flags exist in the installed `python3.14-vllm-0.31.0rc3` (spot-checked in `arg_utils.py`), and the built system's `vllm.service` points at that same store path.

The switcher change is data only: `max_requests` 1 → 4 on `qwen3.8-27b-nvfp4` and `-balanced`, with `context` still 131072. The existing `acquire_model` admits same-unit requests up to `max_requests` and only swaps units at zero in-flight requests after residency expires, so hysteresis semantics carry over to concurrent load. The server is already a `ThreadingHTTPServer`.

The VRAM budget leaves about 1.85 GiB estimated free and gates on ≥ 1,536 MiB free after warmup and under c=4. Activation memory at 5760 tokens is an estimate, because a fixed `kv_cache_memory_bytes` skips profiling. The warmup dummy batch makes an under-estimate fail at unit start, and L1/L3 are pre-declared. The ComfyUI reservation is a 700 MiB guess for an idle CUDA context. Comfy is currently failed, so the deploy gate will measure a card without it.

Coverage is solid. `test_m` ties both coder aliases and the reader context to the parsed nix blocks, and a negative check confirmed it fails when `maxNumSeqs` diverges. `test_n` covers 4-way admission, a 409 on the 5th request, no cross-unit swap while busy even past residency, and release bookkeeping. Git hygiene is clean: the commit lists exactly the three files, and the pre-existing modified, staged and untracked files (including `secrets/secrets.yaml`, `comfy_gpu_admission.py`, `flake.lock` and `__pycache__/`) are still uncommitted and unchanged.

<details>
<summary>Issues (3)</summary>

1. **ComfyUI coexistence unvalidated** (likely, non-blocking). The 700 MiB idle-Comfy-context reservation is unmeasured, and the ≥ 1,536 MiB deploy gate will run while `docker-comfy-esnixi` is in `start-limit-hit` (F1). Once F1 is fixed, re-run the free-VRAM gate with Comfy having run and released the lease before the coder starts. Apply L1 if free drops below the gate.
2. **OmniRoute still serializes** (confirmed per plan, non-blocking for this diff). Connection `e9bd13fb…` has `maxConcurrent: 1`, and `home/programs/omniroute-routing.py:165` and `omniroute-mode.py:107` re-persist 1. Raise all three to 4 after step 5 passes, or the 4 engine slots stay idle in production.
3. **Offload + hybrid + MTP upstream risk** (possible, non-blocking). Upstream #50454 is still open (EngineCore assertion with offload, hybrid, prefix caching and MTP). Don't call the change done until the 30-minute c=4 soak (6b) and offload-efficacy (6a) checks pass. Fall back to L2 on any connector assertion.

</details>

<details>
<summary>Details</summary>

### Switcher admission vs. engine slots

`acquire_model` treats both coder aliases as one unit and checks `active_requests < MODELS[model_id]["max_requests"]`. Giving both aliases 4 keeps the shared counter consistent no matter which alias arrives first, and `test_m` asserts they're equal. A 5th request waits `LOCK_WAIT_SECONDS` (3 s) and then gets a 409, which lets OmniRoute fall through to the next target instead of queueing inside vLLM. That matches the engine's 4 slots, so vLLM's own waiting queue shouldn't build up through the switcher.

`test_n` drives this with real threads against the shared condition variable. It also checks that `RESIDENCY_SECONDS = 0` doesn't let a reader request evict a busy coder, which is the property that matters once "busy" means more than one request.

### VRAM and host RAM

```
card 32,204 MiB (torch)  free today 4,724
  - KV  +1,589   (6,144 - 4,555)
  - act +1,130   (5760 tok/step, estimated; profiling skipped)
  - graphs/offload bookkeeping +150 (est.)
  = ~1,855 free  -> gate >= 1,536 (700 Comfy ctx + 256 desktop + ~580 slack)
```

The arithmetic is consistent with the baseline measurements (25,534 B/token at nvfp4 gives about 252K tokens at 6 GiB, against the plan's ~240K). The weak link is the Comfy line. Comfy can only hold a residual context, never models, while the coder owns the exclusive flock. But that context's size is unmeasured, and F1 means the gate won't see it. If it's bigger than the reservation, the coder is the side that fails: it starts with a fixed KV allocation and restart-loops every 10 s. ComfyUI itself isn't at risk from this change.

The 32 GiB offload region is pinned host memory in `/dev/shm`, which is a 63 G tmpfs. With 102 GiB available today, about 65 GiB remains.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm.nix`: coder block only. `kvCacheMemory` 6 GiB, `kvOffloadingSize = 32`, `maxNumSeqs = "4"`, `--max-num-batched-tokens 5760`, plus coupling/budget comments.
- `esnixi/vllm-switch.py`: `max_requests` 4 on both coder aliases, plus a coupling comment.
- `esnixi/test_vllm_switch.py`: `_nix_block`/`_nix_attr` helpers, `test_m` coupling guard, `test_n` 4-way admission/409 test.

Full diff: `git show 3601dd8` in `/home/celes/sources/celesrenata/nix-flakes-refactored` on esnixi.

</details>
