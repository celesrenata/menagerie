# Verification: esnixi 5090 coder 144K + switcher fast-retry (build-loop, iteration 1)

Host `celes@192.168.42.254`, repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `main`.
Base `f947fbc`. Commit **`b1869ed`** `feat(esnixi): 144K 5090 coder context, coder fast-retry in switcher` (not pushed, not activated).

## Pre-work guard

`git status --short` before editing: only `?? distcc-monitor.sh`. No uncommitted changes in `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`.

## Model-support guard

- Local snapshot: NOT readable without sudo. `ls -ld /var/lib/vllm` gives `drwx------ vllm vllm`, `ls .../huggingface/hub/` gives `Permission denied`, and `sudo -n true` needs a password. Per the plan, the local read is the gate in the deploy step (item 6, interactive sudo).
- Upstream `https://huggingface.co/nvidia/Qwen3.8-27B-NVFP4/resolve/main/config.json` shows `text_config.max_position_embeddings = 262144` and `rope_parameters.rope_type = "default"` (no YaRN). 147456 < 262144, so the change is supported.
- vLLM refuses to start if max_model_len > max_position_embeddings. A local mismatch therefore fails loudly, and the new fast-retry plus breaker contains it.

## Changes (3 files)

- `esnixi/vllm.nix` (`systemd.services.vllm` only): `maxModelLen "131072"` → `"147456"`, plus one KV-comment line: one 147456 sequence = 52 + 15 GDN = 67 of 104 usable blocks. These are unchanged: `maxNumSeqs "3"`, `kvCacheMemory = 5905580032`, `kvOffloadingSize = 32`, `gpuMemoryUtilization "0.92"`, `sleepMode`, MTP, nvfp4 KV, `--max-num-batched-tokens 5760`. The reader (65536) and the fallback are untouched.
- `esnixi/vllm-switch.py`:
    - `MODELS` context is 147456 for both `qwen3.8-27b-nvfp4` and `qwen3.8-27b-nvfp4-balanced`. `max_requests` stays 3.
    - New `CODER_FAST_RETRIES` (env `VLLM_SWITCH_CODER_FAST_RETRIES`, default 2) and `CODER_FAST_RETRY_DELAY_SECONDS` (env `..._DELAY_SECONDS`, default 15 s). Neither is added to the vllm.nix env.
    - New `_fast_retryable()`, which matches the prefixes `unit failed`, `unit restarted`, `systemctl start failed`, `error `. It excludes `could not stop …` (p3 semantics) and `readiness timeout`.
    - New `select_with_fast_retry(model_id)`:
        - The coder gets 1 + 2 attempts, each with its own START_SECONDS. Between attempts it runs `stop_and_drain(coder)` and then sleeps 15 s.
        - After the final retryable failure it stops the coder. This is the crash-loop cap: systemd `Restart=on-failure` no longer loops during the breaker window.
        - Non-coder targets get exactly one attempt.
    - It replaces `safe_select` at the three call sites:
        - `acquire()`
        - `rollback()`: the restore, which fixes restore failures being blamed on the coder.
        - `watchdog_tick()`
    - `record_failure` is still called once per outer operation, so the backoff schedule (300 → 600 → … 1800) is unchanged. The module docstring is updated.
- `esnixi/test_vllm_switch.py`:
    - FakeHost gains `start_fail_times` (N failing starts) and `restart_once` (one NRestarts rise).
    - The `time.sleep` patch now records calls in `self.sleeps`.
    - The new constants are added to the save/restore list.
    - New tests, documented in the docstring:
        - ff1: coder fails once, fast retry succeeds, 2 starts with a stop between, delay slept, no breaker.
        - ff1b: same for a one-off NRestarts rise.
        - ff2: coder fails all 3, breaker opens once (failures == 1, ≈300 s), and the coder ends stopped.
        - ff3: the watchdog fast retry succeeds.
        - ff4: the watchdog fails all attempts, failures == 1, the coder is stopped, active_model is None.
        - ff5: a reader failure gets 1 start, 1 breaker failure, and no fast-retry delay.
        - ff6: the coder restore after a reader failure succeeds via fast retry, with no coder breaker.

## Tests (run on esnixi from the repo root)

```
$ python3 esnixi/test_vllm_switch.py
Ran 41 tests in 2.024s
OK
$ python3 esnixi/test_vllm_idle.py
Ran 7 tests in 0.719s
OK
```

Baseline was 34 tests; 7 are new.

Negative control: `VLLM_SWITCH_CODER_FAST_RETRIES=0 python3 test_vllm_switch.py` fails ff1, ff1b, ff3 and ff6 (4 failures). The new tests therefore depend on the retry. ff2 and ff4 pass either way because they assert `1 + CODER_FAST_RETRIES` starts.

Test (m) (nix↔MODELS coupling) and (z) (KV 5905580032 / gate 0.92 pinned, switcher env list) pass unchanged.

## Build and closure diff

```
$ nixos-rebuild build --flake .#esnixi        # exit 0
these 7 derivations will be built:
  unit-vllm.service.drv, vllm-switch.py.drv, unit-vllm-switcher.service.drv,
  system-units.drv, etc.drv, activate.drv, nixos-system-esnixi-26.11.20260922.6774f7b.drv
result -> /nix/store/il8xbpf9q7ww3xwx3h99rhmzalcsbgdp-nixos-system-esnixi-26.11.20260922.6774f7b

$ nix store diff-closures /run/current-system ./result
(empty: no package version or size changes)
```

diff-closures only reports versioned or size changes, so scope was confirmed with three more checks:

- Full closure diff by store path (`nix-store -qR`): only `unit-vllm.service`, `vllm-switch.py`, `unit-vllm-switcher.service` and the aggregators `system-units`, `etc` and `nixos-system-esnixi` differ. The sorted set of closure names is identical (`diff` exit 0), so no packages were added or removed.
- `diff -rq` of the two `system-units` dirs: only `vllm.service`, `vllm-switcher.service` and the `multi-user.target.wants/vllm-switcher.service` link differ.
- Unit text diff:
    - `vllm.service` ExecStart changes only `--max-model-len 131072` → `--max-model-len 147456`. Every other flag is byte-identical: `--max-num-seqs 3 --kv-cache-memory=5905580032 --gpu-memory-utilization 0.92 --kv-cache-dtype nvfp4 --kv-offloading-size 32 --kv-offloading-backend native --enable-sleep-mode … --max-num-batched-tokens 5760 --speculative-config '{"method":"mtp","num_speculative_tokens":3}'`.
    - `vllm-switcher.service` changes only the `vllm-switch.py` store path.

`grep -o -- '--max-model-len [0-9]*' result/etc/systemd/system/vllm.service` → `--max-model-len 147456`.

## Git

`git add esnixi/vllm.nix esnixi/vllm-switch.py esnixi/test_vllm_switch.py` (explicit paths), then commit `b1869ed`. After that, `git status --short` shows only `?? distcc-monitor.sh`, and `result` is ignored. Not pushed. `nixos-rebuild switch` was NOT run.

## Not done in this step (per the step's scope; diff must touch only vllm units and the switcher)

- Plan item 1's `home/programs/zoo-spec-setup.py` (`local/5090` contextWindow 131072 → 147456) and item 4's `home/programs/omniroute-routing.py` layouts (147456/131072, 147456/65536). Both are home-manager files and would have widened the closure diff beyond the vllm units and the switcher. They are left for the omniroute-cap step.
- The local HF snapshot read is still pending as the deploy-step gate.
- Live state at build time: `:8010/v1/models` reports `max_model_len: 131072`, and the coder is active/running (generation unchanged).
