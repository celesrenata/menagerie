# Fail-safe tenancy for the esnixi RTX 5090 vLLM switcher

The switcher used to retry a broken reader start on every request, evict the coder the moment it went idle, and leave nothing active after a failed switch. That is how the 04:01–04:12 incident took the whole 5090 down. This change makes the coder the protected default. A failed switch now stops the failed target, restores the previous model and returns a 409 with a reason. A per-unit circuit breaker rejects a broken target immediately, with exponential backoff. A watchdog thread readies the coder when nothing has been ready for 60 s. Every sleep, stop, start and readiness wait has a deadline. The lifecycle helpers moved out of `Handler` to module level so the watchdog can share them, and the reader unit now uses `Restart=no` so a crash goes straight to `failed`. The 16 original tests are unchanged apart from the residency setup, and 16 new tests cover the new paths (32/32 pass per verification.md). The commit touches only the three switcher files.

Watch for: a target that hangs instead of crashing still holds `switching` for the full 300 s readiness deadline plus rollback before its 409 (likely). Coder starts are bounded only by START_SECONDS less whatever the sleep/stop of the other unit already used (likely). A restore that fails because the reader will not stop opens the coder's breaker, which keeps the protected default offline for 5+ minutes (possible). A coder start that the watchdog sees fail is left running in its `Restart=on-failure` loop (likely). None of these block the stated requirements. All seven are met, and the required tests exist and are recorded as passing.

**Verdict**: APPROVED

## High-level view

Residency is now asymmetric. `CODER_RESIDENCY_SECONDS` (90) protects the coder from reader requests, and `RESIDENCY_SECONDS` stays 0, so a coder request reclaims the GPU from an idle reader immediately. A reader request gets `coder_busy` while coder requests are in flight and `coder_resident` inside the window. In both cases nothing is slept. This keeps the user's 90 s trigger.

The breaker is keyed by unit, so both coder aliases share one breaker. It is checked before the `switching` and residency checks, so a target in backoff returns a 409 `backoff` with `Retry-After` within microseconds and never touches the active model. Backoff doubles from 300 s and caps at 1800 s. The first request after `open_until` is a half-open trial, and a success logs `breaker CLOSED`. All values are env-configured in vllm.nix.

On failure, rollback stops the target if it is still running and restores `previous`, or the coder if there was none, through the normal `select_model` path. `active_model` is set to the restored model with a fresh `last_activity`. That starts the coder's residency window, so the reader cannot immediately bounce it again. The sync-in-request-thread design means "fast" depends on the failure type. A crash at the gpu-memory gate is caught in about 2 s through `is-failed`. A hung engine burns the whole readiness deadline first.

The watchdog adopts an already-awake unit after a switcher restart, clears an `active_model` whose unit died, and after 60 s with nothing ready runs `select_model(PRIMARY_MODEL)`, with each tick exception-guarded. For an asleep coder, "readying" means marking it active. The actual wake happens on the first request, through the unchanged `vllm_idle` middleware.

vllm_idle.py, the serve flags (MTP, `--max-num-seqs 4`, `--max-model-len`), the sleep→stop fallback and the MODELS/vllm.nix coupling tests are all unchanged.

<details>
<summary>Issues (4)</summary>

1. **Hung target holds the 5090 for up to ~10 min** (likely, non-blocking): if a target never serves but also never fails, `wait_ready` runs the full 300 s, then rollback stops it (up to 150 s) and restores. All other requests get `switching` 409s the whole time. Consider a shorter readiness budget for the reader (cold start measured at 110 s), e.g. a per-model `start_seconds`.
2. **Eviction time is charged to the target's start budget** (likely, non-blocking): `select_model` passes the same `started + START_SECONDS` deadline to `sleep_unit` (up to 90 s), then gives `stop_and_drain` a fresh 150 s. A slow eviction can leave the coder (cold start up to 174 s) less than its worst case, which turns a recoverable switch into a breaker-opening "readiness timeout". Compute the readiness deadline after eviction finishes.
3. **Restore failure blamed on the coder** (possible, non-blocking): `rollback` and `watchdog_tick` call `record_failure(PRIMARY_UNIT, …)` even when `select_model` failed with "could not stop vllm-reader.service". The coder's breaker then also stops the watchdog for 300 s. Only open the restore unit's breaker when the restore unit itself failed to start, not when evicting the other unit failed.
4. **Watchdog leaves a crash-looping coder running** (likely, non-blocking): when the watchdog's coder start fails through NRestarts, it records the failure but does not stop the unit. Unlike the reader, the coder keeps `Restart=on-failure` and keeps re-grabbing the GPU flock every 10 s until the next reader switch stops it. Mirror rollback's bounded `stop_and_drain` of the failed unit.

</details>

<details>
<summary>Details</summary>

### Rollback timing and the synchronous switch

The switch, the failure handling and the rollback all run in the request thread with `switching = True`. A target that hangs is slow (Issue 1). Neither `unit_failed` nor NRestarts fires, so the triggering request holds `switching` for `START_SECONDS` (300 s) plus a bounded stop (≤150 s) plus the restore. OmniRoute will have abandoned that client long before, and every coder request in that window is turned away with `switching`. This is bounded and fails closed, which meets requirement 5. It is the residual way the 5090 can stay unavailable for minutes. Plan D1 accepted the in-thread design for successful cold starts, but did not discuss the hung-failure duration.

The deadline accounting in `select_model` is uneven (Issue 2). `sleep_unit` gets `min(deadline, now + 90)`. A sleep failure falls through to `stop_and_drain(other, now + STOP_SECONDS)`, which is a fresh deadline, not the caller's. The readiness wait then uses whatever is left of the original `started + 300`. In the worst case, a 90 s sleep timeout plus up to 150 s of stop leaves 60 s for a 110–174 s cold start. The result is a "readiness timeout" that opens the target's breaker for 5 minutes even though the target was healthy.

### Breaker attribution on restore

`rollback` records a failure against `restore_unit` whenever `safe_select(restore)` returns False (Issue 3). `watchdog_tick` does the same against `PRIMARY_UNIT`. Some of those failures come from evicting the _other_ unit. For example, a hung reader that survives both `stop_and_drain` attempts produces `could not stop vllm-reader.service`. In that case the coder's breaker opens. Coder requests then get `backoff` 409s, and the watchdog skips its recovery (`breaker_remaining(PRIMARY_UNIT) > 0`) for 300 s, doubling on repeats. The outage of the protected default is caused by the secondary. Systemd's SIGKILL at `TimeoutStopSec=120` makes this rare, but it runs against the user's "switcher needs to not bring down the whole operation". `select_model` already returns distinct reasons, so the attribution can be fixed locally by not recording a restore-unit failure when the reason is an eviction failure.

### Watchdog recovery path

When the coder start fails (Issue 4), the tick records the breaker failure and resets `no_ready_since`, but leaves the unit as it is. For the reader that would not matter (`Restart=no`). The coder still has `Restart=on-failure`/`RestartSec=10s`, so a coder that fails on start keeps cycling and re-taking the GPU flock. That is the incident's root-cause item 4, but now for the primary. The next reader switch does stop it, because `select_model` treats a non-`active` other unit as stop-and-drain. Without one, it loops until systemd's start limit.

The watchdog "readies" an asleep coder without waking it. That matches plan D6/D7 and leaves the ComfyUI lease interplay alone. "Ready" therefore means "admits requests with a ~0.84 s wake", not "awake".

### Test coverage

The plan's required cases p, p2, q–z all exist, and verification.md records 32/32 passing plus 7/7 for test_vllm_idle and a clean `nix-instantiate --parse`. Not tested: a target that hangs until the readiness deadline (only crash-style and restart-count failures are simulated); rollback where the restore fails because the other unit cannot be stopped (the breaker attribution in Issue 3); a watchdog coder-start failure on a unit that keeps auto-restarting; and the deadline split between eviction and readiness. No `nixos-rebuild build`/closure diff is recorded. The plan's item 8 asked for one, but verification.md defers it to the deploy step.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm-switch.py`: lifecycle helpers moved to module level; asymmetric residency; per-unit breaker; rollback; watchdog thread; deadlines; reject code/reason/Retry-After in the 409 body; logging.
- `esnixi/test_vllm_switch.py`: FakeHost extended (start failures, restart-on-start, hanging sleep/stop, `/arcane/state`); residency setup added to the existing tests; new tests p–z.
- `esnixi/vllm.nix`: `restart` parameter on `mkVllmService`; `restart = "no"` for `vllm-reader`; new `VLLM_SWITCH_*` env on the switcher unit.

Full diff: `git diff e700258 -- esnixi/` on esnixi (commit `9fc7375`). The untracked `distcc-monitor.sh` is untouched, and the existing stashes predate this work.

</details>
