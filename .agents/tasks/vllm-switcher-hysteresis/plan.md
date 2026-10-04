# Implementation Plan: vllm-switcher minimum-residency hysteresis

All work is on the live host over SSH: `ssh celes@192.168.42.254`, repo
`/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `feat/nvfp4-reader-fabric`
(HEAD 1d1059e). Only touch `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`, `esnixi/vllm.nix`
(all three are clean). The tree has many dirty and STAGED unrelated files (see setup.md), so never
`git add -A`, never stage `flake.nix`, and commit path-limited only.

Test command (repo root, pytest is not installed): `python3 esnixi/test_vllm_switch.py`.
Baseline: Ran 6 tests, OK.
Build: `nixos-rebuild build --flake .#esnixi`

## Design decisions

- State: one module global `last_activity: float | None = None`, a `time.monotonic()` stamp for the
  currently active model's unit, guarded by `switch_condition`. There is only ever one active unit,
  so one stamp is enough; a per-unit dict adds nothing. It is stamped on every successful acquire
  (same-unit fast path and post-switch) and on every release. It is cleared to `None` whenever
  `active_model` becomes `None` (switch start, failed switch, reader idle stop), because a stopped
  unit has nothing left to protect.
- Where the check goes: it is an extra conjunct on the existing swap branch (`elif not switching and
active_requests == 0`) in `acquire_model()`. That branch is only reached for a different unit or
  when `active_model is None`. The same-unit branch comes first and is untouched, so same-unit
  requests are unaffected by construction. A within-window idle unit then falls through to the
  existing deadline wait and `return False`, which gives the same 409 that OmniRoute already handles.
- Wait granularity: nothing notifies when the window expires, so the wait becomes
  `switch_condition.wait(min(remaining, residency_left))` while residency is the only blocker. A
  window that expires during the 3s lock wait then swaps instead of 409ing, matching "after the
  window, swapping works exactly as today" with no starvation.
- Idle stop: `_maybe_stop` does not consult residency at all. READER_IDLE_SECONDS (300) is far
  above RESIDENCY_SECONDS (90), and the stop path clears `last_activity` along with `active_model`,
  so the coder can claim the GPU immediately after an idle stop. The generation counter logic is
  unchanged.
- Config: `RESIDENCY_SECONDS = _env_seconds("VLLM_SWITCH_RESIDENCY_SECONDS", 90.0)`. A missing,
  unparsable, or negative value falls back to 90. `0` disables hysteresis, which gives the old
  behavior. The value is set explicitly in the `vllm-switcher` service's `environment = { ... }`
  attrset in vllm.nix, next to SYSTEMCTL/SUDO. That attrset is the switcher's existing env pattern;
  `vllmEnvironment` belongs to the vLLM engine units, not the switcher.

## Items

- [ ]   1. Add the residency config and state to `esnixi/vllm-switch.py` (module level).
        - Under the `READER_IDLE_SECONDS` block, add a helper and a constant:

            ```python
            def _env_seconds(name: str, default: float) -> float:
                try:
                    value = float(os.environ.get(name, default))
                except ValueError:
                    return default
                return value if value >= 0 else default

            # Minimum residency (hysteresis): an idle model used within this window is
            # treated as busy for requests that need a DIFFERENT unit (fast 409 ->
            # next OmniRoute target) instead of being evicted. 0 disables.
            RESIDENCY_SECONDS = _env_seconds("VLLM_SWITCH_RESIDENCY_SECONDS", 90.0)
            ```

            (`_env_seconds` must be defined above its first use, before the `MODELS` dict is fine.)

        - Next to `reader_idle_generation`, add
          `last_activity: float | None = None  # monotonic; last acquire/release on active_model. Guarded by switch_condition.`
        - Add a module function (it must read the module globals at call time, so tests can patch
          `SW.RESIDENCY_SECONDS` and `SW.last_activity`):
            ```python
            def residency_remaining(now: float) -> float:
                """Seconds the idle active model is still protected; 0 when swappable. Hold switch_condition."""
                if active_model is None or last_activity is None or RESIDENCY_SECONDS <= 0:
                    return 0.0
                return max(0.0, last_activity + RESIDENCY_SECONDS - now)
            ```
            Files: esnixi/vllm-switch.py
            Verify: `python3 esnixi/test_vllm_switch.py`. All 6 existing tests still pass (no behavior change yet).

- [ ]   2. Wire residency into `acquire_model()`, `release_model()`, and the idle stop in
       `esnixi/vllm-switch.py`.
        - `acquire_model`: add `last_activity` to the `global` line. In the same-unit branch, set
          `last_activity = time.monotonic()` right before `active_requests += 1; return True`. Change
          the swap branch to:
            ```python
            elif not switching and active_requests == 0:
                hold = residency_remaining(time.monotonic())
                if hold <= 0:
                    switching = True
                    active_model = None
                    last_activity = None
                    break
            ```
            In the wait step, compute `remaining = deadline - time.monotonic()`, `return False` if it is
            `<= 0` (unchanged), then wait `min(remaining, hold)` when residency was the blocker, otherwise
            `remaining`. Initialize `hold = 0.0` at the top of each loop iteration so the other paths
            keep the plain `remaining` wait. A `hold` of exactly 0 must never be passed to
            `wait()`; that case already broke out of the loop above.
        - In the `finally` after `select_model`, set `last_activity = time.monotonic() if ready else None`
          alongside `active_model = model_id if ready else None`.
        - `release_model`: add `last_activity` to `global`. After decrementing, set
          `last_activity = time.monotonic()` if `active_model is not None`. Leave the reader idle-arm
          logic exactly as is.
        - `arm_reader_idle_stop._maybe_stop`: add `last_activity` to its `global` line. In the
          post-stop block where `active_model = None` is set, also set `last_activity = None`. Do NOT
          add any residency check to the pre-stop guard.
        - Update the `select_model` comment ("Only ever reached with active_requests == 0") to also
          say "and the residency window has expired".
          Files: esnixi/vllm-switch.py
          Verify: `python3 esnixi/test_vllm_switch.py`. The 6 existing tests pass. Existing tests start
          from `active_model = None` or with `active_requests = 1`, so residency does not change their
          outcome.

- [ ]   3. Add hysteresis tests to `esnixi/test_vllm_switch.py`.
        - `setUp`: also reset `SW.last_activity = None` inside the `with SW.switch_condition` block. Save
          `SW.RESIDENCY_SECONDS`, `SW.LOCK_WAIT_SECONDS`, and `SW.READER_IDLE_SECONDS` and restore all
          three in `tearDown`. This makes tests that change them safe even when an assertion fails.
          Update the module docstring with cases (g) through (l).
        - Helper `_seed_active(self, model_id, age)`: under the lock, set `SW.active_model = model_id`,
          `SW.active_requests = 0`, `SW.last_activity = time.monotonic() - age`, and set the
          FakeSystemctl so that unit is `active`/`running` and the other is `inactive`/`dead`.
        - `test_g_residency_blocks_swap_within_window`: `_seed_active("qwen3.8-27b-nvfp4", age=0)`,
          `RESIDENCY_SECONDS=90`, `LOCK_WAIT_SECONDS=0.2`. `acquire_model("qwen3.5-9b-nvfp4-reader")`
          returns False. Then assert: `verb_unit_sequence()` has no `stop` and no `start` entries (no
          systemctl stop of vllm.service), `fake.active["vllm.service"] == "active"`,
          `SW.active_model == "qwen3.8-27b-nvfp4"`, `SW.switching is False`, `SW.active_requests == 0`.
          Run the same check in reverse (reader seeded, coder requested). Both return False with no
          stop of `vllm-reader.service`.
        - `test_h_swaps_after_window`: `_seed_active("qwen3.8-27b-nvfp4", age=91)`, `RESIDENCY_SECONDS=90`.
          Reader acquire returns True. The sequence contains `stop vllm.service` before
          `start vllm-reader.service`. `SW.active_model` is the reader. Call `release_model()` after.
        - `test_h2_window_expiring_during_lock_wait_swaps`: `_seed_active(coder, age=0)`,
          `RESIDENCY_SECONDS=0.3`, `LOCK_WAIT_SECONDS=3`. Time the reader acquire: it returns True and
          takes less than 2s, which proves the `min(remaining, hold)` wake. Release after.
        - `test_i_same_unit_unaffected`: `_seed_active(coder, age=0)`, `RESIDENCY_SECONDS=90`.
          `acquire_model("qwen3.8-27b-nvfp4")` returns True, then release. The balanced alias
          `acquire_model("qwen3.8-27b-nvfp4-balanced")` also returns True. Neither produces any
          stop/start/reset-failed call. Separately seed the reader with age=0: two concurrent reader
          acquires both return True with no systemctl calls. Release both.
        - `test_j_release_and_acquire_stamp_last_activity`: from `None`, acquire the reader. Assert
          `SW.last_activity` is not None and within 1s of `time.monotonic()`. Set it to `0.0`, call
          `release_model()`, and assert it is restamped to within 1s of now.
        - `test_k_idle_stop_fires_despite_residency_and_frees_gpu`: `RESIDENCY_SECONDS=90`,
          `READER_IDLE_SECONDS=0.2`. Acquire the reader, release (the timer is armed), then `sleep(0.6)`.
          Assert `("stop", "vllm-reader.service")` is in the sequence, `SW.active_model is None`, and
          `SW.last_activity is None`. Then with `LOCK_WAIT_SECONDS=0.2`, a coder acquire returns True
          (residency does not block after the idle stop) and `start vllm.service` appears. Release after.
        - `test_l_env_seconds_parsing`: `SW._env_seconds` returns the default when the var is unset,
          `"abc"`, or `"-5"`, and returns 45.0 for `"45"` and 0.0 for `"0"`. Use `unittest.mock.patch.dict(os.environ, ...)`.
        - Keep `test_f_context_matches_served_max_model_len` unchanged.
          Files: esnixi/test_vllm_switch.py
          Verify: `python3 esnixi/test_vllm_switch.py`. Ran 13 tests, OK, including test_f. Run it twice
          to check the timing-based tests are not flaky.

- [ ]   4. Wire the env var in `esnixi/vllm.nix`. In `systemd.services.vllm-switcher.environment`
       (around line 239, next to `SYSTEMCTL`/`SUDO`), add
       `VLLM_SWITCH_RESIDENCY_SECONDS = "90";` with a one-line comment: an idle model used within
       this many seconds is not evicted for the other unit (the request gets a 409 and goes to the
       next OmniRoute target).
       Files: esnixi/vllm.nix
       Verify: `nixos-rebuild build --flake .#esnixi` succeeds. Then confirm the rendered unit has the
       value: `grep RESIDENCY result/etc/systemd/system/vllm-switcher.service` shows
       `Environment="VLLM_SWITCH_RESIDENCY_SECONDS=90"`. This checks a build artifact, not just source.
       Note: the flake build includes the pre-existing dirty tracked files (flake.nix, etc.), the same
       as the currently deployed system. Do not modify them.

- [ ]   5. Commit path-limited on the branch, without pushing:
       `git commit -m "fix(esnixi): add minimum-residency hysteresis to vllm switcher" -- esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix`.
       Files: (git)
       Verify: `git show --stat HEAD` lists exactly those 3 files. `git diff --cached --name-only`
       still shows the pre-existing staged files (the A list in setup.md), unchanged.

- [ ]   6. Deploy and observe. This restarts `vllm-switcher.service`, which drops any in-flight
       proxied request. The vLLM engine units are unchanged and are not restarted. Run
       `sudo nixos-rebuild switch --flake .#esnixi`, then check
       `systemctl show vllm-switcher -p Environment` (it includes VLLM_SWITCH_RESIDENCY_SECONDS=90) and
       `systemctl is-active vllm-switcher`.
       Files: none
       Verify: during the next mastermind/hybrid-research run,
       `journalctl -u vllm.service -u vllm-reader.service --since "-15 min" | grep -E "Start|Stopp"`
       shows no swap less than 90s after the previous unit's last use. OmniRoute call_logs show 409 then
       fallthrough to the next local target instead of a cold load. If the host must not be switched
       right now, stop after item 5 and report it as not deployed.

## Gaps / assumptions

- "Last request release (or acquire)": both are stamped, so the window runs from the last moment the
  model was touched. A long in-flight generation is already protected by `active_requests > 0`.
- A same-unit request at `max_requests` still waits and 409s as before. Residency does not change it.
- Single feature, so the workflow tail is not restructured. The existing implement/review loop runs
  this plan.
