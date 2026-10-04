# Implementation Plan: esnixi 5090 coder 144K + switcher fast-retry + OmniRoute cap

Host: `ssh celes@192.168.42.254`. Repo: `/home/celes/sources/celesrenata/nix-flakes-refactored` (call it `$R`), branch `main`, HEAD `f947fbc` (generation 439). Leave untracked `distcc-monitor.sh` alone. All artifacts go under `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/esnixi-5090-144k/` on the Mac.

Workflow mapping: items 1-5 = `build-loop` (repo edits, tests, `nixos-rebuild build`, local commit, no activation). Item 6 = `deploy` (needs interactive user sudo). Item 7 = `omniroute-cap` (only after item 6 is live). Item 8 = `live-verify`.

## Findings (confirmed during planning)

- Files are under `$R/esnixi/`, not the repo root: `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`.
- `esnixi/vllm.nix` L176-214, `systemd.services.vllm`: `maxModelLen = "131072";` (L208), `maxNumSeqs = "3"`, `kvCacheMemory = 5905580032`, `kvOffloadingSize = 32`, `gpuMemoryUtilization = "0.92"`, sleepMode, MTP and `--max-num-batched-tokens 5760` in `extraArgs`. Only `maxModelLen` changes.
- KV fit: per the block comment, 105 hybrid blocks of 2848 tokens (104 usable), plus 15 GDN state blocks per sequence. One 147456-token sequence = 52 blocks + 15 = 67 of 104, so it fits. vLLM's startup check (one max-length sequence must fit in KV) passes.
- Model support: `/var/lib/vllm` is `drwx------ vllm`, so celes cannot read the local snapshot without sudo. The upstream `config.json` for `nvidia/Qwen3.8-27B-NVFP4` (HF main, sha `482ca0f3…`) has `text_config.max_position_embeddings = 262144` and `rope_parameters.rope_type = "default"` (no YaRN needed). 147456 < 262144. The local-snapshot read is folded into the item 6 sudo handoff as a gate. vLLM also refuses to start if max_model_len > max_position_embeddings, so a mismatch fails loudly, not silently.
- `esnixi/vllm-switch.py` `MODELS["qwen3.8-27b-nvfp4"]` and `["qwen3.8-27b-nvfp4-balanced"]` have `"context": 131072`. Test (m) parses the nix block and asserts equality, so the two must change together.
- Switcher failure path today: `acquire()` → `safe_select()` once → `record_failure()` (300 s breaker, doubling to 1800 s) → `rollback()`. `watchdog_tick()` → `safe_select(PRIMARY_MODEL)` once → `record_failure(PRIMARY_UNIT)`. It does NOT stop the failed coder, so systemd `Restart=on-failure` (the coder's default `restart`) keeps crash-looping it while the breaker is open. `rollback()` restores the coder once, then on failure calls `record_failure(coder, "restore failed: …")`.
- Baseline: `cd $R/esnixi && python3 test_vllm_switch.py` → 34 tests OK in about 2 s. `time.sleep` is patched to a no-op in `SwitcherTests.setUp`.
- OmniRoute cap source (live, read-only GET with the mgmt key): config only, not a code constant. 114688 = min(combo policy, context window − 16384 reserve), from `resolveInputTokenCapForGateWithSource` in `src/lib/modelCapabilities.ts`. The live inputs are:
    - `pool/tier1/*` `config.weightedTargetPolicies["vllm/qwen3.8-27b-nvfp4"].maxInputTokens` = 524288 (planner 1048576). It is NOT binding, so leave it.
    - Capability overrides (`GET /api/model-capability-overrides`): `vllm/qwen3.8-27b-nvfp4` `context_length` = 131072 (the binding term: 131072 − 16384 = 114688) and `max_input_tokens` = 98304 (direct, non-combo requests). `vllm/qwen3.8-27b-nvfp4-balanced`: `context_length` 131072, `max_input_tokens` 65536.
    - The declarative source of those overrides is `$R/home/programs/omniroute-routing.py` L207-210 `layouts` (`(131072, 98304)` and `(131072, 65536)`). A future `--apply` would revert a hand-made API change, so the script must change too. Its `--full-context-only --apply` mode skips combos and providers and applies only these overrides, with backup and readback.
- The mgmt key `/run/secrets/omniroute_management_api_key` is `root:wheel 0440`, so celes can read it without sudo. Read it into a shell variable. Never print it.
- Zoo profile `local/5090` hard-codes `contextWindow: 131072` in `$R/home/programs/zoo-spec-setup.py` L49. Hybrid profiles use 262144, so only the direct 5090 profile is affected.

## Design decisions

- **Fast-retry scope.** Retry only the primary coder unit, and only when the reason is a start/readiness failure that a fresh start can fix: `"unit failed"`, `"unit restarted (…)"`, `"systemctl start failed (…)"`, `"error …"`. The two exclusions:
    - `"could not stop <other>"`: another unit is wedged, and test p3's one-coder-failure semantics from commit 7b0531d stay as they are.
    - `"readiness timeout"`: it already burned the full 300 s START_SECONDS, and two more would add 10 minutes.
    - Rationale: the observed OOM-on-cold-compile shows up as failed or restarted within about 1-2 min, and that is the case the user wants fixed.
- **One helper, three call sites.** `select_with_fast_retry(model_id)` replaces the single `safe_select` call in `acquire()`, `rollback()` (the restore) and `watchdog_tick()`. It allows `1 + CODER_FAST_RETRIES` attempts for the coder (default 2 retries) and 1 for anything else. Each attempt gets its own `START_SECONDS` deadline. Between attempts it runs `stop_and_drain(coder)` so systemd's own auto-restart cannot race the next start, then `time.sleep(CODER_FAST_RETRY_DELAY_SECONDS)` (default 15 s, inside the 10-20 s range). Callers record exactly ONE breaker failure after all attempts fail, so the backoff schedule (300 → 600 → … 1800) is unchanged.
- **Crash-loop cap.** When the coder's final attempt fails with a retryable reason, the helper `stop_and_drain`s the coder before returning. systemd then stops crash-looping it during the breaker window, which covers the watchdog path (acquire's `rollback()` already stops the failed target). The next watchdog attempt after backoff issues `reset-failed` + `start` as today.
- **Restore blame.** Restoring the coder in `rollback()` goes through the same helper. A transient coder restore failure (the "blamed on the coder" case) now gets the fast retries before `record_failure(coder, "restore failed…")`. "could not stop X" is still attributed as today, for consistency with p3.
- **Tunables.** Use module constants via `_env_seconds`: `VLLM_SWITCH_CODER_FAST_RETRIES` (default 2.0, cast to int) and `VLLM_SWITCH_CODER_FAST_RETRY_DELAY_SECONDS` (default 15.0). Do NOT add them to the vllm.nix switcher env. Defaults are correct, and test (z)'s expected-env list stays untouched.
- **OmniRoute values.** Coder `context_length` 147456 and `max_input_tokens` 131072. Combo cap = min(524288, 147456 − 16384) = 131072, and direct cap = 131072. Balanced `context_length` 147456 (same engine), with `max_input_tokens` staying 65536 by design.
- **Out of scope.** Leave the switcher's advertised `max_input_tokens = context − 32768` (becomes 114688) alone; overrides outrank synced limits. The `omniroute-mode.py` status strings and `docs/omniroute-routing.md` prose also stay as they are.

---

- [ ]   1. Raise the coder max-model-len and the coupled switcher contexts.
       In `esnixi/vllm.nix`, `systemd.services.vllm` only: `maxModelLen = "131072";` → `"147456";`. Do not touch the `mkVllmService` default (L132), the reader (65536) or the fallback (24576). Append one line to the KV block comment: one 147456 sequence = 52 blocks + 15 GDN state = 67 of 104 usable blocks.
       In `esnixi/vllm-switch.py`: `"context": 131072` → `147456` for both `qwen3.8-27b-nvfp4` and `qwen3.8-27b-nvfp4-balanced`. Keep `max_requests: 3`.
       In `home/programs/zoo-spec-setup.py` L49: change `local/5090` `contextWindow` from 131072 to 147456.
       Files: `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `home/programs/zoo-spec-setup.py`
       Verify: `cd $R/esnixi && python3 test_vllm_switch.py` shows 34 OK. Test (m) proves the nix↔MODELS coupling; (z) proves KV 5905580032 and gate 0.92 are unchanged. `python3 -m py_compile $R/home/programs/zoo-spec-setup.py` exits 0.

- [ ]   2. Implement the coder fast-retry in the switcher (depends on nothing; can follow 1).
       In `esnixi/vllm-switch.py`:
        - Add constants after `BACKOFF_MAX_SECONDS`: `CODER_FAST_RETRIES = int(_env_seconds("VLLM_SWITCH_CODER_FAST_RETRIES", 2.0))` and `CODER_FAST_RETRY_DELAY_SECONDS = _env_seconds("VLLM_SWITCH_CODER_FAST_RETRY_DELAY_SECONDS", 15.0)`, each with a one-line comment.
        - Add `_fast_retryable(why) -> bool`, true for the prefixes `"unit failed"`, `"unit restarted"`, `"systemctl start failed"`, `"error "`.
        - Add `select_with_fast_retry(model_id) -> tuple[bool, str]` next to `safe_select`. The lock is NOT held, and it never raises. Behavior is per the Design section: per-attempt `time.monotonic() + START_SECONDS`, and `LOG.warning("coder start failed (%s); fast retry %d/%d in %.0fs", …)`. Between attempts: `stop_and_drain(unit, now + STOP_SECONDS)` + `time.sleep(CODER_FAST_RETRY_DELAY_SECONDS)`. After a final retryable coder failure, `stop_and_drain` the coder and log "stopping crash-looping coder".
        - Replace the `safe_select` calls in `acquire()` (the `ready, why = safe_select(model_id, started + START_SECONDS)` line), `rollback()` (the restore select) and `watchdog_tick()` (the `ok, why = safe_select(PRIMARY_MODEL, …)` line) with `select_with_fast_retry(...)`. Keep every `record_failure`/`reset_breaker` call exactly once per outer operation.
        - Update the module docstring bullet on the breaker to mention the coder's fast retries.
          Files: `esnixi/vllm-switch.py`
          Verify: `cd $R/esnixi && python3 test_vllm_switch.py`. All 34 existing tests pass unchanged (reader paths make one attempt; p3's "could not stop" is not retried).

- [ ]   3. Add the fast-retry tests.
       In `esnixi/test_vllm_switch.py`:
        - Extend `FakeHost` with `self.start_fail_times = {}` (unit → remaining failures). In `run()`, a `start` while the count is > 0 decrements it and behaves like `start_fails`.
        - Make the `time.sleep` patch record calls in `self.sleeps` (still no real sleeping).
        - Add `SW.CODER_FAST_RETRIES` and `SW.CODER_FAST_RETRY_DELAY_SECONDS` to the `_saved` restore list.
        - Add tests, and document them in the module docstring under "Fail-safe switching" as (ff1)-(ff5):
            - (ff1) Reader active and idle (`RESIDENCY_SECONDS = 0`), coder `start_fail_times = {CODER_UNIT: 1}` → `acquire_model(CODER)` is True. Exactly 2 `("start", CODER_UNIT)` events, with a `("stop", CODER_UNIT)` between them. `CODER_UNIT not in SW.breakers`, `breaker_remaining == 0`, and `CODER_FAST_RETRY_DELAY_SECONDS in self.sleeps`.
            - (ff2) `start_fails = {CODER_UNIT}` → acquire is False with `reject_code == "start_failed"`. 3 coder starts, `SW.breakers[CODER_UNIT]["failures"] == 1`, breaker remaining ≈ `BACKOFF_SECONDS`, and the coder ends inactive (last coder lifecycle event is stop).
            - (ff3) Watchdog with nothing ready and the coder failing once → returns `"ready qwen3.8-27b-nvfp4"` with no breaker.
            - (ff4) Watchdog with the coder always failing → returns `"failed"`, failures == 1, coder stopped, `active_model is None`.
            - (ff5) Reader unchanged: `_fail_reader_once()` makes exactly 1 `("start", READER_UNIT)` event, `SW.breakers[READER_UNIT]["failures"] == 1`, and no reader-delay sleep.
        - Optionally add an NRestarts variant of ff1 using a one-shot `restart_on_start`.
          Files: `esnixi/test_vllm_switch.py`
          Verify: `cd $R/esnixi && python3 test_vllm_switch.py` shows 39+ OK, and `python3 test_vllm_idle.py` still OK.

- [ ]   4. Update the declarative OmniRoute 5090 layout (no live change yet).
       In `home/programs/omniroute-routing.py` `layouts` (L207-210): `"vllm/qwen3.8-27b-nvfp4": (147456, 131072)` and `"vllm/qwen3.8-27b-nvfp4-balanced": (147456, 65536)`. Add a short comment: 131072 = 147456 − 16384 output reserve; COUPLED to esnixi/vllm.nix maxModelLen.
       Then run a read-only preview on esnixi: `OMNIROUTE_API_KEY="$(cat /run/secrets/omniroute_management_api_key)" python3 home/programs/omniroute-routing.py --full-context-only` (NO `--apply`). Record the `modelOverrides` plan in `verification.md`. It should list exactly three entries: coder context_length 131072→147456, coder max_input_tokens 98304→131072, and balanced context_length 131072→147456. `changes` and `providerChanges` should be empty.
       Files: `home/programs/omniroute-routing.py`
       Verify: `python3 -m py_compile home/programs/omniroute-routing.py` exits 0, and the preview output matches the above.

- [ ]   5. Build the system, check the closure diff, commit locally.
       In `$R`: `nixos-rebuild build --flake .#esnixi` (no sudo), then `nix store diff-closures /run/current-system ./result`. Expected changes: the vllm.service unit/scripts (ExecStart `--max-model-len 147456`), the vllm-switch script, and home-manager files carrying `omniroute-routing.py` / `zoo-spec-setup.py`. If anything else changes (package versions, unrelated units), STOP and `send_message` with severity warning listing them. Confirm the built unit: `grep -o -- '--max-model-len [0-9]*' $(readlink -f result)/etc/systemd/system/vllm.service` → `--max-model-len 147456`. Do not activate.
       Commit only the 5 changed files (`git add` by name; never `distcc-monitor.sh`; do not commit `result`): `esnixi: 144K 5090 coder context, coder fast-retry in switcher, OmniRoute layout`. Do not push. Write `verification.md` with the test output, closure diff summary, preview output and the commit hash.
       Files: `verification.md` (artifact dir)
       Verify: the build exits 0, `git status --short` shows only `?? distcc-monitor.sh` (plus `result` if not ignored), and both test files pass.

- [ ]   6. Deploy (pause point; user runs sudo interactively).
       Do not attempt a non-tty sudo. Call `send_message` severity `warning` asking the user to run, in an interactive terminal on esnixi:
        ```
        sudo -u vllm sh -c 'grep -ho "\"max_position_embeddings\": *[0-9]*" /var/lib/vllm/.cache/huggingface/hub/models--nvidia--Qwen3.8-27B-NVFP4/snapshots/*/config.json; grep -ho "\"rope_type\": *\"[a-z]*\"" /var/lib/vllm/.cache/huggingface/hub/models--nvidia--Qwen3.8-27B-NVFP4/snapshots/*/config.json'
        cd /home/celes/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi
        ```
        Gate: if the local snapshot reports `max_position_embeddings` < 147456 (or a non-default rope that caps it), the user must NOT run the switch. Report and stop.
        After the user confirms, verify without sudo:
        - `systemctl show vllm.service -p ActiveState,SubState,NRestarts`
        - `curl -s 127.0.0.1:8010/v1/models` shows `max_model_len: 147456` (wait up to ~6 min for the cold compile)
        - `systemctl show vllm-switch.service -p ActiveState`, then `journalctl -u vllm-switch -u vllm --since -15min` if the journal is readable. Otherwise ask the user to paste it. Look for "fast retry" / "breaker OPEN" lines; a first-start OOM is the exact case the fast retry targets.
        - The new generation number (`readlink /nix/var/nix/profiles/system`).
          Write `deploy-report.md`.
          Verify: `/v1/models` on 8010 reports 147456 and the coder is active/running.

- [ ]   7. Raise the OmniRoute cap live (only after item 6 shows 147456 on :8010).
       On esnixi: `OMNIROUTE_API_KEY="$(cat /run/secrets/omniroute_management_api_key)" python3 /home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-routing.py --full-context-only` (preview, same 3 entries as item 4), then the same command with `--apply`. The script backs up the before-values to `~/.local/state/omniroute-routing/*-model-overrides-before.json` and reads each one back. Then `GET /api/model-capability-overrides` and confirm: `vllm/qwen3.8-27b-nvfp4` context_length 147456 and max_input_tokens 131072; `vllm/qwen3.8-27b-nvfp4-balanced` context_length 147456 and max_input_tokens 65536. Do NOT change `weightedTargetPolicies` (524288 is not binding). Never print the key. Append to `deploy-report.md`.
       Rollback if needed: PATCH the backed-up values (131072/98304, 131072) via `/api/model-capability-overrides`.
       Verify: readback shows the values above.

- [ ]   8. Live verification.
        - Watch OmniRoute pod logs (`kubectl -n omniroute logs deploy/omniroute --since=30m | grep -i "qwen3.8-27b-nvfp4"`) for pre-flight lines showing `max input 131072` for the 5090. Expect no more "max input 114688" rejections for 115-131K-token requests.
        - Check the switcher journal / `curl 127.0.0.1:8011` traffic for Zoo `hybrid/code` requests landing on the 5090 again.
        - Optionally send one direct ~120K-token request to confirm vLLM accepts it (or reuse a call log body with `/tokenize` on :8010 per the context-estimate task's method).
        - Note that 3 concurrent long requests do not all fit in KV (104 blocks), so vLLM queues or preempts the extra ones. That is expected.
          Write `live-verify.md`.
          Verify: at least one ≥115K Zoo request served by `vllm/qwen3.8-27b-nvfp4` after the change, and no new `breaker OPEN unit=vllm.service` lines.

## Gaps / assumptions

- The local HF snapshot could not be read without sudo. Planning relied on the upstream config (262144), and item 6 gates the switch on the local read.
- **Margin caveat (needs the user's awareness, not a plan change).** OmniRoute's pre-flight multiplies the raw estimate by 1.10. With a 131072 cap, only requests up to about 119K raw are admitted (131072 / 1.1 ≈ 119156). The logged example (raw 123180 → 135498) would STILL be rejected after this change. The 121-124K raw requests seen today mostly keep falling to the 4070 Ti; only the ~115-119K band gains.
    - To admit 124K raw, the cap would need about 136.5K. That means a 5090 context of at least 152.9K (for example 163840: 58 + 15 = 73 of 104 KV blocks, so it fits).
    - Alternatively, a lower `OMNIROUTE_CONTEXT_ESTIMATE_MARGIN`.
    - The user approved 147456/131072, so the plan implements that. Item 8 must report the admitted-size band honestly. The build-loop must not silently change the target.
- If the journal is not readable by celes, the deploy step asks the user to paste the relevant `journalctl` lines.
