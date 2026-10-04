# Implementation Plan: fail-safe esnixi vLLM switcher

## Ground rules (read first)

- All work is on esnixi over SSH: `ssh celes@192.168.42.254 "<cmd>"`. Repo: `/home/celes/sources/celesrenata/nix-flakes-refactored`.
- Branch reality (checked at plan time): the repo is on `main` (not `feat/nvfp4-reader-fabric`, which no longer exists locally), HEAD `e700258`, working tree clean except untracked `distcc-monitor.sh`. The switcher files had NO uncommitted changes, so the plan is based on HEAD. Stay on the checked-out branch; do not create/switch branches.
- Never stash, revert, reset, or commit unrelated files (user WIP such as comfy, wireguard, backup, graphics, flake.lock, `distcc-monitor.sh`, may appear at any time). Re-run `git status` before every commit. Commit ONLY the switcher files you changed, by explicit path: `git add esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix` (plus `esnixi/vllm_idle.py` only if touched; this plan does not touch it). Never push.
- Do not create changesets or CHANGELOG entries.
- Edit remote files with care: copy them to a local scratch dir (`scp`), edit, `scp` back, or use `ssh ... python3 - <<'EOF'` patch scripts. Re-read the remote file after each write.
- Tests: `ssh celes@192.168.42.254 "cd /home/celes/sources/celesrenata/nix-flakes-refactored && python3 esnixi/test_vllm_switch.py"` (stdlib unittest, Python 3.14; currently 16 tests, all pass) and `python3 esnixi/test_vllm_idle.py` (7 tests; must stay green, file untouched).
- Build (from the WORKING TREE, never HEAD-only, which drops vLLM and rolls nixpkgs back):
  `ssh celes@192.168.42.254 "cd /home/celes/sources/celesrenata/nix-flakes-refactored && nixos-rebuild build --flake .#esnixi"` then
  `ssh celes@192.168.42.254 "cd /home/celes/sources/celesrenata/nix-flakes-refactored && nix store diff-closures /run/current-system ./result"`. The diff must touch ONLY `unit-vllm-switcher.service`, `unit-vllm-reader.service` (Restart change) and the `vllm-switch.py` store path / sudo-less env. Anything else (kernel, nvidia, nixpkgs, comfy, other units) = stop and report.

## Root cause of the 2026-10-03 04:01-04:12 incident (from journal + code)

1. Reader start failed on the 0.92 gpu-memory gate (fixed by e700258), but the switcher had no memory of failure: every new reader request ran `select_model` again (`reset-failed` + `start vllm-reader` at 04:03:04, 04:03:59, 04:04:51, 04:05:36, 04:06:14, 04:08:12, 04:08:49, 04:09:35).
2. `VLLM_SWITCH_RESIDENCY_SECONDS = "0"` in vllm.nix, so a reader request evicted the coder the moment it went idle. A coder request did win once (04:06:13 wake 0.84 s) and the coder was re-slept one second later (04:06:14) for another doomed reader attempt.
3. On failure `acquire_model`'s `finally` sets `active_model = None` and nothing restores the coder; it sleeps until a coder request happens to win the race.
4. Failure detection is slow: reader has `Restart=on-failure`/`RestartSec=10s`, so after a crash the unit sits in `activating (auto-restart)` (not `failed`); detection waits for NRestarts to rise, and systemd's auto-restart re-takes the GPU flock (`gpu_launch.py` blocks on `LOCK_EX`) that the coder needs to wake.
5. Unbounded/long operations: `stop` runs with `timeout=120` == `TimeoutStopSec` (04:10:08 stop → SIGKILL 04:12:08, switching=True for 2 min = every request 409); `/arcane/sleep` single attempt can block 120 s; `is-failed` calls have no timeout; `MODEL_READY_SECONDS = 540`.

Measured timings to size deadlines: sleep 35.7 s / 21.9 s / 7.9 s / 0.83 s; wake 0.84-0.86 s; reader cold start 110 s (04:25:32 → 04:27:22); coder cold start 48-174 s.

## Design decisions

- D1 Keep the synchronous switch in the request thread (no background switch worker). Rationale: with fast failure detection (D5) a failed reader start + rollback completes in ~60-70 s, and adding a worker thread changes request semantics broadly. Known limitation: a successful reader cold start (~110 s) may still exceed OmniRoute's ~110 s client timeout for the triggering request; follow-up requests succeed. Note it in the code comment.
- D2 Refactor lifecycle helpers (`unit_state`, `stop_and_drain`, `sleep_unit`, `unit_running`, `select_model`, `wait_ready`, `other_units`) from `Handler` methods into module-level functions so the watchdog thread can use them without a fake Handler. `Handler.acquire_model(model_id) -> bool` and `Handler.release_model()` stay (tests call them) and delegate to module-level `acquire(model_id) -> tuple[bool, str]`; the handler stores the reject reason in `self.reject_reason` for the 409 body. Keep thin `Handler` method aliases only if a test needs them (current tests only use `acquire_model`, `release_model`, `proxy`).
- D3 Primary/secondary: constants `PRIMARY_MODEL = "qwen3.8-27b-nvfp4"`, `PRIMARY_UNIT = MODELS[PRIMARY_MODEL]["unit"]` ("vllm.service"). Residency becomes asymmetric: new `CODER_RESIDENCY_SECONDS = _env_seconds("VLLM_SWITCH_CODER_RESIDENCY_SECONDS", 90.0)` protects the coder from reader eviction (the 90 s hysteresis the user asked to keep); existing `RESIDENCY_SECONDS` (env stays "0") applies when a coder request evicts the idle reader, so the coder can always reclaim the GPU immediately. `residency_remaining(now, target_model)` picks the window from the active model's unit.
- D4 Circuit breaker keyed by UNIT (both coder aliases share one engine). Module dict `breakers: dict[str, dict]` = `{"failures": int, "open_until": float}` guarded by `switch_condition`. On failure: `failures += 1`, `open_until = now + min(BACKOFF_SECONDS * 2 ** (failures - 1), BACKOFF_MAX_SECONDS)`; log `breaker OPEN unit=… failures=… backoff=…s reason=…`. On successful select: if failures > 0 log `breaker CLOSED unit=…` and reset. After `open_until` the next request is a half-open trial. Env: `VLLM_SWITCH_BACKOFF_SECONDS` (300), `VLLM_SWITCH_BACKOFF_MAX_SECONDS` (1800). The breaker is checked in `acquire` BEFORE any eviction and only when the target unit is not the active unit.
- D5 Fast, unambiguous failure detection: add `restart ? "on-failure"` parameter to `mkVllmService` (`Restart = restart;`) and pass `restart = "no";` for `vllm-reader` only. The switcher owns the reader's lifecycle; a crash goes straight to `failed` (detected by the existing `is-failed` poll in ~2 s) and systemd no longer re-grabs the GPU flock behind the switcher's back. The coder keeps `on-failure` (it is the always-on default; NRestarts detection remains for it). In addition, on any target failure the switcher explicitly `stop`s the target (bounded) before rollback.
- D6 Rollback = restore the previous active model (captured as `previous = active_model` before `acquire` clears it; `None` → `PRIMARY_MODEL`) with the normal `select_model` path under a fresh `START_SECONDS` deadline. Warm (unit running, asleep) is ~instant: `/v1/models` answers and the first real request wakes it (0.84 s) via the unchanged `vllm_idle` middleware. Stopped → started. Do not add a wake endpoint to `vllm_idle.py` (keeps reader idle-sleep, the lease/ComfyUI interplay and the idle counters untouched). A restore failure records a breaker failure for that unit, leaves `active_model = None` and the watchdog retries.
- D7 Watchdog: daemon thread started only under `__main__` running `watchdog_loop()`: `while True: try: watchdog_tick() except Exception: LOG.exception(...)` then `time.sleep(WATCHDOG_INTERVAL_SECONDS)` (5 s). `watchdog_tick(now=None)` is directly testable:
    - (a) if `active_model` is set, `active_requests == 0`, not switching and its unit is no longer `active` → log and clear `active_model` (start the no-ready clock).
    - (b) if `active_model is None`, not switching, `active_requests == 0` and `now - no_ready_since >= WATCHDOG_SECONDS` (env `VLLM_SWITCH_WATCHDOG_SECONDS`, 60) and the coder breaker is not open → claim `switching = True` under the lock, then (outside the lock) ADOPT first: if a unit is running and `GET /arcane/state` reports `sleeping == false`, and `/v1/models` matches, adopt it as `active_model` without touching anything (covers switcher restart while the reader is awake); otherwise run `select_model(PRIMARY_MODEL)` (sleeps an idle reader / starts the coder if stopped). Success/failure update the breaker and `no_ready_since`; always reset `switching` and `notify_all` in `finally`.
    - `no_ready_since` is a module global (monotonic), initialised at import and reset whenever `active_model` transitions to `None`.
- D8 Deadlines (all module constants via `_env_seconds`, env set in vllm.nix):
    - `SLEEP_DRAIN_SECONDS` default 90 (env `VLLM_SWITCH_SLEEP_SECONDS`): total budget for `/arcane/sleep` retries; each `urlopen` uses `timeout=max(1, give_up - now)` and `?timeout=` = `min(10, remaining)`. Exceeded/failed → existing stop-and-drain fallback.
    - `STOP_SECONDS` default 150 (env `VLLM_SWITCH_STOP_SECONDS`; > `TimeoutStopSec=120` so systemd's SIGKILL lands): `stop_and_drain` subprocess timeout = remaining; `TimeoutExpired` → keep polling `unit_state` until the deadline rather than returning immediately.
    - `START_SECONDS` default 300 (env `VLLM_SWITCH_START_SECONDS`, replaces `MODEL_READY_SECONDS = 540`): readiness wait for a cold start (coder worst observed 174 s, reader 110 s).
    - All `subprocess.run/check_output` calls get `timeout=5`/`10` and catch `(subprocess.SubprocessError, OSError)`; `is-failed` wrapped in a helper `unit_failed(unit) -> bool`.
    - The `switch_condition` lock is never held during subprocess/HTTP calls (already true; keep it). Other requests during a switch wait at most `LOCK_WAIT_SECONDS` (3) and then get a 409 with reason.
- D9 Response bodies: every switcher reject stays HTTP 409 (OmniRoute already falls back on it), message `f"RTX 5090 is busy; use the next OmniRoute fallback ({reason})"` (keeps the literal test_e asserts), plus `"type": "vllm_switch_unavailable"` and `"code": <slug>`; breaker rejects add a `Retry-After` header (seconds remaining). Reason slugs/texts:
    - `coder_full`: "coder busy: 4/4 requests in flight"
    - `coder_busy`: "coder busy: N request(s) in flight; reader not swapped in"
    - `coder_resident`: "coder resident for N s more; reader not swapped in"
    - `reader_busy` / `reader_resident` (symmetric, for coder requests while the reader is mid-generation)
    - `backoff`: "<model> in backoff for N s after start failure"
    - `switching`: "5090 switching to <model>; retry"
    - `start_failed`: "<model> failed to start (<why>); restored <previous>; backoff N s"
      The 400/401/404/413/502 responses are unchanged. Add `logging` (`logging.basicConfig(level=INFO, format="%(levelname)s %(message)s")`, stderr → journal) and log each switch (target, previous, duration, result), each 409 reason, breaker transitions, rollback and watchdog actions.

## Ordered work items

- [ ]   1. Pre-flight check.
       Run `ssh celes@192.168.42.254 "cd /home/celes/sources/celesrenata/nix-flakes-refactored && git status && git log --oneline -3"`. If `esnixi/vllm-switch.py`, `esnixi/vllm_idle.py`, `esnixi/vllm.nix` or `esnixi/test_vllm_switch.py` are dirty and the changes are not yours, STOP and send_message severity "warning" naming the files. Run both test files to confirm the 16 + 7 baseline passes.
       Files: none.
       Verify: both test commands print `OK`.

- [ ]   2. Refactor lifecycle helpers to module level (no behavior change) and add logging + bounded subprocess helpers.
       Move `other_units`, `unit_state`, `stop_and_drain`, `sleep_unit`, `unit_running`, `select_model`, `wait_ready` out of `Handler` into module functions (D2); add `unit_failed(unit)` and `unit_restarts(unit) -> int` helpers with timeouts (D8); add `LOG = logging.getLogger("vllm.switch")` + `basicConfig`. `Handler.acquire_model/release_model` keep their signatures. Update any test calls if needed (current tests do not call the moved methods).
       Files: esnixi/vllm-switch.py
       Verify: `python3 esnixi/test_vllm_switch.py` — all 16 existing tests pass unchanged.

- [ ]   3. Bounded operations (D8).
       Add `SLEEP_DRAIN_SECONDS` (env `VLLM_SWITCH_SLEEP_SECONDS`, 90), `STOP_SECONDS` (150), `START_SECONDS` (300; remove `MODEL_READY_SECONDS`); bound each `/arcane/sleep` attempt by the remaining budget; make `stop_and_drain` tolerate `TimeoutExpired` and keep polling to its own `STOP_SECONDS` deadline; `select_model(model_id, deadline)` takes the deadline from the caller.
       Files: esnixi/vllm-switch.py, esnixi/test_vllm_switch.py
       Verify: existing tests pass; new test `test_p_sleep_timeout_falls_back_to_stop` passes (see test list).

- [ ]   4. Reject reasons + asymmetric residency (D3, D9).
       `acquire(model_id)` returns `(ok, code, reason)`; `Handler.acquire_model` stores `self.reject_code/self.reject_reason` and returns bool; `do_POST` builds the 409 body/headers from them. Add `PRIMARY_MODEL/PRIMARY_UNIT`, `CODER_RESIDENCY_SECONDS`, and `residency_remaining(now, target_model)`. In `acquire`, a request for a different unit while `active_requests > 0` returns immediately-after-LOCK_WAIT with `coder_busy`/`reader_busy`; within residency with `*_resident`; same-unit full with `coder_full`; during another switch with `switching`.
       Update existing tests for the new coder window: add `"CODER_RESIDENCY_SECONDS"` to the saved/restored names in `setUp`; set `SW.CODER_RESIDENCY_SECONDS = 0` in `test_d`, `= 0.3` in `test_h2`, `= 90` in `test_g`/`test_h` alongside `RESIDENCY_SECONDS` (so both directions keep their current meaning).
       Files: esnixi/vllm-switch.py, esnixi/test_vllm_switch.py
       Verify: all existing tests pass; new tests `test_q_reader_during_coder_inflight_409_no_sleep`, `test_r_reader_during_coder_residency_409_no_sleep`, `test_s_reject_reason_in_body` pass.

- [ ]   5. Circuit breaker + rollback (D4, D6).
       In `acquire`: capture `previous = active_model` before clearing it; check the target unit's breaker before any eviction (open → `backoff` reject, nothing touched). In the post-switch `finally`: on success reset the breaker and set `active_model`; on failure record the breaker failure, `stop_and_drain(target unit, STOP deadline)` if it is not inactive, then `select_model(previous or PRIMARY_MODEL, fresh START deadline)`; set `active_model` to the restored model on success (stamp `last_activity`), else `None` + `no_ready_since = now`; reject with `start_failed`. Keep `switching = True` for the whole failure+rollback so concurrent requests get `switching` 409s, and always clear it + `notify_all` in `finally`. Note: rollback restoring a model to the target unit itself is skipped (if previous unit == failed unit, restore `PRIMARY_MODEL` unless that is the failed unit, else leave None for the watchdog).
       Files: esnixi/vllm-switch.py, esnixi/test_vllm_switch.py
       Verify: new tests `test_t_target_start_fails_restores_coder_and_409`, `test_u_breaker_open_immediate_409_active_untouched`, `test_v_breaker_backoff_doubles_and_caps`, `test_w_breaker_resets_after_success`, `test_x_restart_count_rise_triggers_rollback` pass; all existing tests pass.

- [ ]   6. Liveness watchdog (D7).
       Add `WATCHDOG_SECONDS` (env `VLLM_SWITCH_WATCHDOG_SECONDS`, 60), `WATCHDOG_INTERVAL_SECONDS` (5), `no_ready_since`, `watchdog_tick(now=None)`, `adopt_awake_unit()` (GET `/arcane/state` per running unit; never POSTs, never wakes), and `watchdog_loop()`. Start the thread in `__main__` only, before `serve_forever()`. Extend `FakeHost.urlopen` with `/arcane/state` returning `{"sleeping": unit in asleep, "active": 0, "lease_held": ...}`.
       Files: esnixi/vllm-switch.py, esnixi/test_vllm_switch.py
       Verify: new tests `test_y_watchdog_restores_coder_when_nothing_ready`, `test_y2_watchdog_waits_for_threshold_and_switching`, `test_y3_watchdog_adopts_awake_unit_after_restart`, `test_y4_watchdog_clears_dead_active_model`, `test_y5_watchdog_loop_survives_exception` pass.

- [ ]   7. vllm.nix: reader Restart=no and switcher env.
       In `mkVllmService` add `restart ? "on-failure"` to the argument set and use `Restart = restart;`; pass `restart = "no";` in `systemd.services.vllm-reader` (comment: switcher owns reader lifecycle; failures go to the breaker, auto-restart would re-take the GPU flock). In `systemd.services.vllm-switcher.environment` add `VLLM_SWITCH_CODER_RESIDENCY_SECONDS = "90"`, `VLLM_SWITCH_BACKOFF_SECONDS = "300"`, `VLLM_SWITCH_BACKOFF_MAX_SECONDS = "1800"`, `VLLM_SWITCH_WATCHDOG_SECONDS = "60"`, `VLLM_SWITCH_SLEEP_SECONDS = "90"`, `VLLM_SWITCH_START_SECONDS = "300"`, `VLLM_SWITCH_STOP_SECONDS = "150"`; keep `VLLM_SWITCH_RESIDENCY_SECONDS = "0"` and update its comment (now applies only to reclaiming the GPU from the idle reader). Do NOT change any coder/reader serve flag (`--max-model-len`, `--max-num-seqs 4`, MTP speculative config, kv sizes, gpuMemoryUtilization gates, ports, `idleSeconds`). Add test `test_z_nix_switcher_env_and_reader_restart` parsing vllm.nix: reader block has `restart = "no";`, coder block does not; switcher env contains the new keys and each value parses with `_env_seconds`.
       Files: esnixi/vllm.nix, esnixi/test_vllm_switch.py
       Verify: `python3 esnixi/test_vllm_switch.py` all pass (including `test_m_coupling_matches_vllm_nix` and `test_f_context_matches_served_max_model_len`); `nix-instantiate --parse esnixi/vllm.nix >/dev/null` succeeds on esnixi.

- [ ]   8. Full verification and build.
       Run both test files; run the working-tree build and closure diff from Ground rules. Confirm the diff shows only the switcher script/unit and the vllm-reader unit; record the diff output in the step report.
       Files: none (produces `./result` symlink in the repo; it is gitignored-or-untracked, do not commit it).
       Verify: tests `OK`; `nixos-rebuild build` exits 0; `nix store diff-closures` lists only vllm unit/switcher paths.

- [ ]   9. Commit locally.
       `git status` again; `git add esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix`; `git commit -m "fix(esnixi): fail-safe vLLM switcher (rollback, breaker, watchdog, deadlines)"`. No push, no other files.
       Verify: `git show --stat HEAD` lists exactly those files; `git status` still shows the user's WIP untouched.

(Deploy with `nixos-rebuild switch` and live verification are handled by the workflow's later build-deploy / live-verify steps. Live checks to run there: `systemctl show -p Restart vllm-reader` = `no`; journal shows `vllm.switch` log lines; a reader request while the coder is in use or within 90 s returns 409 `coder_resident`/`coder_busy`; `curl` coder still served with 4-seq admission; reader idle-sleeps after 300 s; coder wake ~0.84 s.)

## Test cases to add to esnixi/test_vllm_switch.py

FakeHost extensions needed: `start_fails: set[str]` (start makes the unit `failed`/`inactive` and `/v1/models` refuses), `restart_on_start: set[str]` (start leaves it `active` but bumps NRestarts on the first readiness poll and never serves), `sleep_hangs: set[str]` (`/arcane/sleep` raises `TimeoutError`/`socket.timeout`), `/arcane/state` support, and a `stop_timeout` option raising `subprocess.TimeoutExpired`. Patch `SW.time.monotonic` only where a test needs to advance the clock (use a small `Clock` helper), never globally.

- `test_p_sleep_timeout_falls_back_to_stop`: `sleep_hangs = {coder}`, `SLEEP_DRAIN_SECONDS` small → acquire reader returns True, lifecycle has `("stop", coder)` before `("start", reader)`, no `("sleep", coder)`.
- `test_p2_stop_timeout_is_bounded`: stop raises `TimeoutExpired`, unit never goes inactive, `STOP_SECONDS` small → acquire returns False within a bounded wall time and `switching` is False afterwards.
- `test_q_reader_during_coder_inflight_409_no_sleep`: coder active with 1 in-flight, `LOCK_WAIT_SECONDS = 0` → reader False, `reject_code == "coder_busy"`, lifecycle empty, coder still awake.
- `test_r_reader_during_coder_residency_409_no_sleep`: coder idle, age 10 s, `CODER_RESIDENCY_SECONDS = 90` → reader False, `coder_resident`, no sleep; with `RESIDENCY_SECONDS = 0` a coder request while the reader is idle at age 0 swaps immediately (coder reclaims).
- `test_s_reject_reason_in_body`: drive `do_POST` with a fake rfile/wfile for a reader request in coder residency → status 409, body JSON `error.code == "coder_resident"`, message contains "RTX 5090 is busy; use the next OmniRoute fallback" and "coder resident for".
- `test_t_target_start_fails_restores_coder_and_409`: coder active idle past residency, `start_fails = {reader}` → reader False with `start_failed`; lifecycle order `sleep coder`, `start reader`, `stop reader` (if not inactive), and afterwards `active_model == CODER`, `fake.gpu_owners()` does not include the reader, a following coder acquire is True with no further lifecycle events.
- `test_x_restart_count_rise_triggers_rollback`: `restart_on_start = {reader}` → same rollback outcome as test_t.
- `test_u_breaker_open_immediate_409_active_untouched`: after test_t's failure, a second reader request returns False immediately (`backoff`, reason contains "in backoff for"), lifecycle has no new events, coder untouched; a `Retry-After` header is set by `do_POST`.
- `test_v_breaker_backoff_doubles_and_caps`: three successive failures (advance the clock past `open_until` each time) give backoffs 300, 600, 1200, and with more failures cap at 1800.
- `test_w_breaker_resets_after_success`: open breaker, advance clock past `open_until`, clear `start_fails` → reader acquire True, breaker failures == 0, and the log contains the CLOSED transition (use `assertLogs("vllm.switch")`).
- `test_y_watchdog_restores_coder_when_nothing_ready`: `active_model = None`, coder running asleep, reader inactive, `no_ready_since = now - 61` → `watchdog_tick()` sets `active_model == CODER` with no start/stop; variant with coder stopped → `("start", coder)`.
- `test_y2_watchdog_waits_for_threshold_and_switching`: `no_ready_since = now - 10` → no action; `switching = True` → no action; coder breaker open → no action.
- `test_y3_watchdog_adopts_awake_unit_after_restart`: fresh state, reader running and awake, coder asleep → tick adopts the reader, no lifecycle events.
- `test_y4_watchdog_clears_dead_active_model`: `active_model = CODER`, coder unit `inactive`, 0 in flight → tick sets `active_model = None` and starts the no-ready clock.
- `test_y5_watchdog_loop_survives_exception`: patch `watchdog_tick` to raise once then set an Event; run `watchdog_loop` in a daemon thread with a tiny interval → the Event is set (loop kept running) and the exception was logged.
- `test_z_nix_switcher_env_and_reader_restart`: see item 7.
- Preserve unchanged: `test_f_context_matches_served_max_model_len`, `test_m_coupling_matches_vllm_nix` (MODELS context == `--max-model-len`, max_requests == maxNumSeqs == 4, ports), `test_n_coder_admits_up_to_max_requests_then_409`, `test_o_proxy_uses_model_port`, and the a-l tests (with the residency setup tweaks in item 4). Update the module docstring's test index to list the new cases.

## Things that must keep working (regression guard)

Sleep/wake fast path (warm swap = sleep only; wake ~0.84 s in vllm_idle), 4-seq coder admission (`max_requests` 4 == `--max-num-seqs 4`, both aliases share one counter), reader idle sleep (`idleSeconds = "300"`, vllm_idle.py untouched — this is the active/last_finished idle-counter logic), MTP speculative decoding and all serve flags, readiness coupling (MODELS context == `--max-model-len`, unit-tested), the sleep→stop fallback, and the `reset-failed` before start. No new sudo rules are needed (only start/stop/reset-failed are privileged; `show`/`is-failed` are not).

## Gaps / assumptions

- "Generation-counter idle logic" does not exist under that name in the switcher; assumed to mean vllm_idle.py's `active`/`last_finished`/`changed` idle controller, which this plan leaves untouched.
- OmniRoute's fallback status set is assumed to include 409 (current production behavior); no new 503s are introduced by the switcher.
- The coder's breaker uses the same backoff parameters; a genuinely broken coder is retried by the watchdog at the breaker cadence (5 → 10 → 20 → 30 min) rather than hammered.
