# Design: ComfyUI preempts the 5090 coder (option 1) + OmniRoute maxConcurrent 4

Host: esnixi (`ssh celes@192.168.42.254`), repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `feat/nvfp4-reader-fabric` (HEAD `3601dd8`). Paths below are repo-relative unless stated. Revision 3: it addresses every finding in the revision-2 `design-review.json`; the responses are at the end, after the revision-2 responses.

## Overview

How it works today:

- `comfy-esnixi-gate.socket` (127.0.0.1:28188) socket-activates `comfy-esnixi-gate.service`.
- That service has `Requires=`/`After=` on `docker-comfy-esnixi.service`.
- The container unit's `ExecStartPre` ends with `comfy-esnixi-wait-gpu-lease`, which runs `flock /run/arcane-gpu/5090.lock true` with `TimeoutStartSec=0`.
- So ComfyUI waits forever while `vllm.service` holds the lease through `gpu_launch.py` (leaseWrap). Nothing ever stops the coder.

The change adds a preempt handshake in front of that flock wait. A new `ExecStartPre` step, `comfy-esnixi-request-gpu`, asks the switcher (`esnixi/vllm-switch.py`) for the GPU over a root-only unix socket. The switcher then:

1. Fast-409s every model.
2. Drains in-flight coder/reader requests, bounded at 120 s.
3. Waits out any in-progress model switch (each one aborts within one poll).
4. Stops every vLLM unit in `MODELS` and re-checks that they are all down.
5. Answers `granted`.

The flock wait then passes and ComfyUI starts. While ComfyUI is in the `held` state, the switcher refuses to start vLLM. Its monitor also stops any vLLM unit that comes up by another path.

How the hold ends:

- The gate's `systemd-socket-proxyd --exit-idle-time` (raised from 30 s to 120 s) stops ComfyUI after 120 s with no connections, or
- the switcher's max-hold stop (30 min) fires. It is followed by a 5 min cooldown that gives the coder priority.

The next coder request after the hold ends cold-starts `vllm.service` through the unchanged `select_model` path.

Restart safety: hold state is derived from `docker-comfy-esnixi.service` ActiveState/SubState through one classifier, `comfy_phase`, plus a cooldown file in the switcher's RuntimeDirectory.

Tech stack (locked):

- Python 3 stdlib only (`socketserver`, `socket`, `struct`, `threading`, `logging`) for the switcher and the client.
- NixOS modules for the units.
- `unittest` for tests.
- No new dependencies.

## Verified vs assumed

Verified over SSH (read-only), this revision:

- `git status --short` shows a heavily modified working tree. These files are modified or added and uncommitted:
    - `esnixi/comfy-worker.nix`, `esnixi/comfy_gpu_admission.py`, `esnixi/vllm-proxy.nix`, `esnixi/graphics.nix`, `esnixi/lan-mouse.nix`, `esnixi/remote-desktop.nix`
    - `esnixi/arcane_worker_launch.py` (A), `esnixi/test_comfy_ondemand.py` (A), `esnixi/backup.nix` (A), `esnixi/omniroute-wireguard.nix` (A)
    - `home/programs/omniroute-mode.py`, `home/programs/omniroute-routing.py`, `home/programs/omniroute-editors.nix`, `home/programs/mcp.nix`
    - `home/programs/zoo-*` (A), `home/programs/omniroute-workers.py` (A), `docs/omniroute-*.md`
    - `flake.nix`, `flake.lock`, `overlays/*`, `secrets.nix`, `secrets/secrets.yaml`
    - plus untracked backups and `__pycache__`.

    The design builds on the working tree, and every uncommitted hunk must be preserved (see Implementation rules).

- `esnixi/vllm-switch.py` (HEAD = working tree):
    - Module globals: `switch_condition`, `active_model`, `active_requests`, `switching`, `last_activity`, `reader_idle_generation`.
    - Constants: `LOCK_WAIT_SECONDS = 3`, `MODEL_READY_SECONDS = 540`, `RESIDENCY_SECONDS` (env `VLLM_SWITCH_RESIDENCY_SECONDS="90"` in `vllm.nix`), `READER_UNITS = {"vllm-reader.service"}`, `DRAIN_SETTLE_SECONDS = 2`.
    - `Handler` methods: `json_response(self, status, payload)` (no headers parameter), `do_POST` (409 text "RTX 5090 is busy; use the next OmniRoute fallback"), `acquire_model`, `release_model` (clamps at 0 and arms the reader idle stop when the reader goes idle), `arm_reader_idle_stop`/`_maybe_stop` (generation counter), `other_units`, `unit_state` (`systemctl show --value` ActiveState/SubState), `stop_and_drain`, `select_model`, and `proxy`.
    - The order inside `select_model`: stop the other units, then `reset-failed`, then `is-failed`, then read NRestarts, then `sudo systemctl start`, then the readiness poll (`urlopen` with a 3 s timeout, `is-failed`, NRestarts, `sleep 2`).
    - `__main__` runs `Server(("127.0.0.1", 8011), Handler).serve_forever()`.
- `gpu_launch.py` takes a blocking `flock(LOCK_EX)` and then calls `execvp`, so the lease lasts the whole process lifetime.
- `vllm.nix`:
    - `security.sudo.extraRules` for `vllm-switcher` lists `"${pkgs.systemd}/bin/systemctl {start,stop,reset-failed} {vllm,vllm-reader}.service"` with NOPASSWD (lines 233-245).
    - The switcher environment sets `SYSTEMCTL = "${pkgs.systemd}/bin/systemctl"` and `SUDO = "/run/wrappers/bin/sudo"`.
    - The switcher has `Restart=always`, `RestartSec=2s`, `ProtectSystem=strict`, and `RestrictAddressFamilies` including `AF_UNIX`.
- `comfy-worker.nix` (working tree):
    - `comfyIdleExit = "30s"` (line 14).
    - `waitForGpuLease` (line 18).
    - `docker-comfy-esnixi` has `ExecStartPre = lib.mkAfter [ "${waitForGpuLease}" ]` (line 122) and `StopWhenUnneeded` (line 119).
    - The gate runs `systemd-socket-proxyd --exit-idle-time=${comfyIdleExit}` (line 142).
- Live: `docker-comfy-esnixi` is `Type=simple`, `Restart=on-failure`, currently inactive/dead. `vllm.service` is active and `vllm-reader` is inactive.
- OmniRoute scripts (working tree, uncommitted):
    - `home/programs/omniroute-mode.py:110` already has `CONNECTIONS['vllm']: {'maxConcurrent': 4}` inside `PROVIDER_POLICIES`, and the comment at :106-108 is already rewritten.
    - `home/programs/omniroute-routing.py:166` already has `CONNECTIONS["vllm"]: {"maxConcurrent": 4}`. The task brief said :165; the line moved.
    - The only stale text left is the preview `print` at `omniroute-mode.py:363` (re-checked in revision 3; HEAD still `3601dd8`): `'5090 MTP: one 131072-context request (fixed kvCacheMemory ~4.45 GiB). 4070 IQ3: … M5 MLX: 131072; M5 DS4: 163840; one shared slot.'`.
    - Live provider `esnixi-5090` `maxConcurrent` is 4 (GET only, measured by the design review). esnixi state sha256 still starts `4172ac9f6f4b` (revision 3).
- Deployed copies:
    - `~/.local/share/omniroute-editor/omniroute-mode.py` on esnixi is a home-manager store symlink (`home/programs/zoo-parallel.nix:22`) that still has `maxConcurrent: 1` (line 107). It picks up the working-tree value only when the user deploys home-manager.
    - `omniroute-routing.py:124-131` delegates to that copy.
- OmniRoute drift, measured this revision with GET only (key loaded from `/run/secrets/omniroute_management_api_key` into the environment, never printed):
    - esnixi `~/.local/state/omniroute-routing/tier-switch-state.json`: `active_mode=tiered`, 77 tracked names, all present live, 54 drifted. `providers` holds `e9bd13fb-…` (esnixi-5090) at `maxConcurrent` 1 and `70b82fc9-…` at 1. sha256 `4172ac9f…6c99`.
    - Working-tree `build("tiered", live)`: 77 routes, 37 differ from live. That count includes the uncommitted `CLOUD` edit, so the review's "likely stale" concern does not hold today. The implementer still reports the number the dry run prints.
- Mac `~/.local/state/omniroute-routing/tier-switch-state.json`: sha256 `de46c142…5e09` (stale). Tonight's backups `20261003T101558Z-openai-demote-before.json` and `20261003T102219Z-vllm-maxconcurrent-before.json` are in the same directory.
- Prior revision, still valid:
    - `time.monotonic()` and systemd `*TimestampMonotonic` share CLOCK_MONOTONIC.
    - The switcher's 8011 port is LAN-reachable through nginx `vllm-api` (:2701).
    - Existing tests pass: `test_vllm_switch.py` 15 OK; `test_comfy_ondemand.py` 6 OK with 2 skipped.

Assumed (not verified):

- OmniRoute treats the 409 as a target failure and falls through.
- `--exit-idle-time` counts time with zero open connections. The worker's 2 s keepalive and any open websocket keep the gate alive.
- systemd reports `ActiveState=activating SubState=start-pre` for the whole time `ExecStartPre` runs (documented semantics).
- `docker-vllm-vision-5090` and `vllm-5090-fallback` are not running. If either one is, the flock still serialises it (legacy behaviour).

## Implementation rules

- Never `git checkout`, `git restore`, `git stash`, `git reset` or `git clean` anything. Edit files in place on top of the working tree.
- Do not commit unless the user asks.
- The edits to `comfy-worker.nix` must keep its existing uncommitted content.
- Never print the OmniRoute key or any `/run/secrets` value.

## Decision 1: mechanism (root-only unix socket + systemd ExecStartPre handshake)

Options considered:

- **(a) A localhost HTTP route on 8011.** Rejected. 8011 is LAN-reachable through nginx :2701 with the peer seen as 127.0.0.1. "Local-only" would then rest only on OmniRoute's inference bearer token, which would let any OmniRoute client kill the coder.
- **(b) A pure systemd handoff** (`Conflicts=vllm.service`, or an ExecStartPre that runs `systemctl stop vllm.service`). Rejected.
    - It bypasses `active_requests` and `switching`, so it gives no drain.
    - It leaves the switcher believing the coder is loaded.
    - With `Conflicts=`, the next coder request would kill ComfyUI mid-render.
- **(c) Chosen: a unix stream socket `/run/vllm-switcher/control.sock`** served by the switcher. A new `ExecStartPre` on `docker-comfy-esnixi.service`, placed before `comfy-esnixi-wait-gpu-lease`, calls it.

Why (c) fits the lease design:

- The flock stays the single, kernel-enforced exclusion.
- The handshake only makes the current holder let go, at the one point that already means "Comfy wants the GPU": the container's start.
- Every arrival path converges there: the worker's `/arcane/gpu/acquire` retries, browser connections, and any other client on :28188.
- The switcher stays the single tenancy authority, and its drain uses the same `active_requests`/`switching` state as the request path.

Access control:

- The socket sits in `RuntimeDirectory=vllm-switcher` (mode 0750, owner `vllm-switcher`) and is chmod 0600 after bind.
- The only caller is the container unit's ExecStartPre. It runs as root (the unit has no `User=`), so it passes DAC.
- Defence in depth: `_, peer_uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))`. The tuple order is (pid, uid, gid). Any `peer_uid != 0` is rejected.
- No token is used, so there is no secret handling.

## Decision 2: preempt request contract

The client is a new file, `esnixi/comfy_gpu_request.py`, wired in `esnixi/comfy-worker.nix`:

```nix
requestGpu = pkgs.writeShellScript "comfy-esnixi-request-gpu" ''
  exec ${pkgs.python3}/bin/python3 ${./comfy_gpu_request.py} /run/vllm-switcher/control.sock
'';
```

Change `ExecStartPre = lib.mkAfter [ "${waitForGpuLease}" ];` to `ExecStartPre = lib.mkAfter [ "${requestGpu}" "${waitForGpuLease}" ];`.

Wire protocol: one UTF-8 JSON request line terminated by `\n`, one response line, then the server closes the connection.

Request: `{"op":"preempt"}` or `{"op":"status"}`. Max 1024 bytes, 5 s read timeout.

Responses:

| Response                                                      | Meaning                                                                | Logged                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `{"state":"granted"}`                                         | `comfy_state == "held"` (all `MODELS` units verified inactive/failed). | —                        |
| `{"state":"draining","retry_after":2}`                        | Drain or stop is in progress.                                          | —                        |
| `{"state":"deferred","retry_after":N,"cooldown_remaining":S}` | Cooldown is active and Comfy is only `waiting`. N = min(10, ceil(S)).  | —                        |
| `{"error":"forbidden"}`                                       | `peer_uid != 0`.                                                       | WARNING with the uid     |
| `{"error":"bad request"}`                                     | Oversize, timeout, non-JSON, or unknown op.                            | INFO, payload not echoed |

`status` returns the same shape without changing any state, plus `active_requests`, `active_model` and `comfy_state` for operators.

`preempt` is idempotent. Repeat calls return the current state and never start a second drain.

Client loop:

1. Connect and send `preempt`.
2. On `granted`, exit 0.
3. On `draining`/`deferred`, sleep `clamp(retry_after, 1, 10)` and retry.
4. On `FileNotFoundError`, `ConnectionRefusedError`, any other `OSError`, a malformed reply, or `error`: retry every 2 s. After 60 s of continuous failure, log `switcher unreachable; falling back to the GPU lease wait` and exit 0. The flock still protects VRAM, and a restarted switcher reconciles (Decision 6).
5. The client always exits 0, so a switcher fault never fails the start and never loops `Restart=on-failure`.
6. It logs to stderr only on state transitions.

## Decision 3: switcher state machine, drain and timeout

New module state in `vllm-switch.py`, all guarded by `switch_condition`:

| Name                   | Type and values                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| `comfy_state`          | `"none" \| "draining" \| "held"`                                    |
| `drain_deadline`       | `float \| None` (monotonic)                                         |
| `drain_thread_running` | `bool`; guarantees a single drain thread                            |
| `cooldown_until`       | `float`, CLOCK_MONOTONIC, 0 = none; mirrored to a file (Decision 5) |

Constants:

| Constant                 | Source                                                       | Default                             |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------- |
| `COMFY_UNIT`             | fixed                                                        | `"docker-comfy-esnixi.service"`     |
| `CONTROL_SOCKET`         | env `VLLM_SWITCH_CONTROL_SOCKET`                             | `/run/vllm-switcher/control.sock`   |
| `COOLDOWN_FILE`          | env `VLLM_SWITCH_COOLDOWN_FILE`                              | `/run/vllm-switcher/cooldown-until` |
| `COMFY_DRAIN_SECONDS`    | `_env_seconds("VLLM_SWITCH_COMFY_DRAIN_SECONDS", 120.0)`     | 120                                 |
| `COMFY_MAX_HOLD_SECONDS` | `_env_seconds("VLLM_SWITCH_COMFY_MAX_HOLD_SECONDS", 1800.0)` | 1800; 0 disables the cap            |
| `COMFY_COOLDOWN_SECONDS` | `_env_seconds("VLLM_SWITCH_COMFY_COOLDOWN_SECONDS", 300.0)`  | 300                                 |
| `COMFY_POLL_SECONDS`     | fixed                                                        | 2.0                                 |

Refactor first, with no behaviour change:

- Move `unit_state(unit)` and `stop_and_drain(unit, deadline)` to module level. The `Handler` methods become one-line delegates, so existing tests that call `h.stop_and_drain` and `h.unit_state` still pass.
- Add `unit_props(unit, *names) -> dict[str, str]`. It runs `systemctl show --property=… unit` without `--value` and parses `KEY=VALUE` lines independent of order. On error it returns `{}`.
- Add `vllm_units() -> set[str]`, which returns `{m["unit"] for m in MODELS.values()}`.
- Add `all_vllm_down() -> bool`, which is True when every unit's `unit_state(u)[0]` is in `("inactive", "failed")`. An empty string (systemctl error) counts as not down, so the check fails closed.

`comfy_phase(props) -> "off" | "waiting" | "running"` is a pure function and the only classifier. Reconcile, the monitor and the `select_model` bypass check all use it.

| Phase     | Condition                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | `ActiveState` in {inactive, failed}                                                                                                                                                                                     |
| `waiting` | `ActiveState == "activating"` and `SubState == "start-pre"`. The container does not exist yet: ExecStartPre is running the handshake or the flock wait.                                                                 |
| `running` | Everything else: activating/start, start-post, active, reloading, deactivating, activating/auto-restart. This includes an empty `ActiveState` (systemctl failure), so the check fails closed toward protecting ComfyUI. |

`_start_drain_locked()` is the internal entry, called with the lock held:

1. If `comfy_state != "none"`, return.
2. Set `comfy_state = "draining"` and `drain_deadline = now + COMFY_DRAIN_SECONDS`.
3. Bump `reader_idle_generation`, which cancels any armed reader idle stop.
4. Call `_spawn_drain_thread_locked()`: if `not drain_thread_running`, set it True and start one daemon thread running `_drain_thread_main()`. This helper is the only place a drain thread is created; the monitor's self-heal row (Decision 5) uses it too.
5. Call `notify_all()`, which wakes `acquire_model` waiters (they 409) and the monitor.
6. Log INFO `comfy preempt: draining (active_requests=N, switching=B)`.

`begin_preempt() -> dict` (lock held) is called by the control `preempt` op:

- If `comfy_state == "held"`, return `granted`.
- If `comfy_state == "draining"`, return `draining`.
- If `cooldown_until > now`, return `deferred`.
- Otherwise call `_start_drain_locked()` and return `draining`.

The drain thread runs `_drain_thread_main()`, which wraps `drain_and_stop()`.

Flag rule: `drain_thread_running` is cleared in the same lock hold that decides to exit. Every exit decision in `drain_and_stop()` sets `drain_thread_running = False` and returns without releasing the lock in between. That covers leaving because `comfy_state != "draining"` and the `held` transition. So no window exists where the thread has decided to exit but the flag still reads True. A `preempt` or monitor tick that sees `drain_thread_running == False` can always spawn a replacement, and one that sees True can rely on a live drainer.

```python
def _drain_thread_main() -> None:
    global drain_thread_running
    try:
        drain_and_stop()          # clears the flag itself on every normal exit
    except Exception:
        log.exception("comfy drain thread crashed")
        with switch_condition:
            drain_thread_running = False   # fallback only; monitor respawns (Decision 5)
            switch_condition.notify_all()

def drain_and_stop() -> None:
    global drain_thread_running, comfy_state, drain_deadline, active_model, last_activity
    while True:
        with switch_condition:
            # Only active_requests is bounded by the deadline. A switch in progress is
            # always waited out: select_model aborts within one poll (Decision 3 abort
            # points), or it is inside stop_and_drain of a vLLM unit, bounded by
            # TimeoutStopSec=120.
            while comfy_state == "draining" and (
                switching or (active_requests > 0 and time.monotonic() < drain_deadline)
            ):
                switch_condition.wait(1.0)
            if comfy_state != "draining":
                drain_thread_running = False
                return
            if active_requests > 0:
                log.warning(...)  # once: drain timeout, stopping anyway
        for unit in vllm_units():                          # outside the lock
            if unit_state(unit)[0] not in ("inactive", "failed"):
                if not stop_and_drain(unit, time.monotonic() + 150):
                    log.error(...)
        with switch_condition:
            if comfy_state != "draining":
                drain_thread_running = False
                return
            if switching:
                continue                                   # cannot happen (see below); defensive
        if all_vllm_down():                                # outside the lock
            with switch_condition:
                if comfy_state != "draining":
                    drain_thread_running = False
                    return
                if not switching:
                    active_model = None
                    last_activity = None
                    comfy_state = "held"
                    drain_deadline = None
                    drain_thread_running = False
                    switch_condition.notify_all()
                    log.info(...)  # GPU released to ComfyUI after Xs
                    return
        time.sleep(10)                                     # stop failed or unit came back: retry
```

The `except` branch in `_drain_thread_main` is the only path that clears the flag outside an exit decision. It leaves `comfy_state == "draining"` with no drainer on purpose: the monitor's self-heal row sees `draining` with `not drain_thread_running` on its next tick (≤ `COMFY_POLL_SECONDS`, woken at once by the `notify_all()`) and spawns a fresh thread. A repeating crash therefore retries every tick with a `log.exception` each time instead of wedging silently. That is visible in the journal and still keeps vLLM off, which is the safe side.

Why `held` is safe once set:

- `switching` can only become True inside `acquire_model`'s swap branch, and Decision 4 puts the `comfy_state != "none"` check in front of it, under the same lock.
- So once `draining` is set, no new switch can begin. The drain waits until any switch that began earlier is gone (`not switching`) and only then runs the final `all_vllm_down()` scan.
- A unit that `select_model` started just before it aborted is therefore caught by that scan and stopped on the next pass.
- Starts from outside the switcher (an operator, or `nixos-rebuild switch` restarting `vllm.service`) are handled by the held-state monitor (Decision 5).

Stragglers after a drain timeout:

- `active_requests` is not reset. Their upstream socket dies, `proxy()` raises, and the existing `finally: release_model()` decrements the count, clamped at 0.
- Cutting a stream after 120 s is the bounded-wait trade-off the user approved, and it is logged.

`select_model` abort points (minimal edits; `comfy_aborted()` reads `comfy_state != "none"` under the lock):

1. After the stop-other-units loop: `if comfy_aborted(): return False`.
2. Immediately before `sudo systemctl start`, under one lock acquisition:
    - If `comfy_aborted()`, return False.
    - Bypass check: if `comfy_phase(unit_props(COMFY_UNIT, "ActiveState", "SubState")) == "running"`, call `_start_drain_locked()` and return False. This catches a ComfyUI that got the lease without the handshake, for example after the client's 60 s fallback.

    The `unit_props` call runs before taking the lock; only the decision is made under it. A `waiting` phase does not trigger the bypass, because ComfyUI is not on the GPU yet and its own client will send `preempt`.

3. Inside the readiness poll loop, at the top of each iteration: `if comfy_aborted(): return False`.

`acquire_model`'s existing `finally` resets `switching = False` and `active_model = None` and notifies, which releases the drain's wait. The final scan then stops any unit that got started.

Residency and generations:

- Preemption ignores `RESIDENCY_SECONDS`, because ComfyUI has priority. The 90 s hysteresis is unchanged for model-to-model swaps.
- `active_model` is None when the hold ends, so residency never blocks the coder's return.
- `release_model` arms the reader idle stop only when `comfy_state == "none"`: add `and comfy_state == "none"` to its existing condition.
- `_maybe_stop` is unchanged. A stale generation or `active_model is None` already makes it a no-op.

## Decision 4: 409 for every model while ComfyUI holds the GPU

In `Handler.acquire_model`, inside `with switch_condition:`, add this as the first statement inside the `while True:` loop. That placement runs it on entry and on every wake-up:

```python
if comfy_state != "none":
    self.refusal = "comfy"
    return False
```

It runs before both the fast path and the swap branch, so every model id gets an immediate 409 with no systemctl call. That covers `qwen3.8-27b-nvfp4`, `qwen3.8-27b-nvfp4-balanced`, `qwen3.5-9b-nvfp4-reader` and all `ALIASES`. A `notify_all()` from `_start_drain_locked()` makes current waiters exit at once instead of after `LOCK_WAIT_SECONDS`.

`json_response` gains an optional headers argument: `def json_response(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None`. It sends each extra header before `end_headers()`. Existing callers are unchanged.

In `do_POST`, when `getattr(self, "refusal", None) == "comfy"`, respond with `self.json_response(409, {"error": {"message": "RTX 5090 is reserved for ComfyUI; use the next OmniRoute fallback"}}, {"Retry-After": "30"})`. Other 409s keep their current text. `GET /v1/models` and `/healthz` are unaffected.

## Decision 5: release (idle window, max hold, cooldown) and the monitor

Idle window:

- Change `comfyIdleExit = "30s"` to `"120s"` in `esnixi/comfy-worker.nix` (line 14). Update the comments at lines 11 and 38 to say that the gate exits after 120 s without connections, which stops the container (`StopWhenUnneeded`) and ends the switcher's GPU hold.
- The 120 s window absorbs the gap between queued jobs, so a burst does not re-preempt the coder for each job.
- The in-container 5 s unload (`AA_COMFY_IDLE_UNLOAD_SECONDS`) is unchanged.

The monitor is one daemon thread, started exactly once by `reconcile_at_startup()` under `__main__`. Its loop is:

```python
MONITOR_MIN_TICK_SECONDS = 1.0

def monitor_loop() -> None:
    last_tick = 0.0
    while True:
        now = time.monotonic()
        if now - last_tick >= MONITOR_MIN_TICK_SECONDS:
            last_tick = now
            try:
                monitor_tick()
            except Exception:
                log.exception("comfy monitor tick failed")
        with switch_condition:
            switch_condition.wait(COMFY_POLL_SECONDS if comfy_state != "none" else 30)
```

- The `try/except Exception` keeps the thread alive through any bug or unexpected systemctl output. The only path from `held` back to `none`, and the max-hold stop, both depend on this thread, so it must never die. `KeyboardInterrupt`/`SystemExit` are not caught.
- The 1.0 s throttle: `notify_all()` fires on every `acquire_model`/`release_model`, and each tick forks `systemctl show`. A wake less than 1.0 s after the previous tick skips the tick and goes back to waiting. State changes still get a tick within ~1 s, because the timed wait (`COMFY_POLL_SECONDS` = 2 s while non-`none`) re-enters the loop. `last_tick` is a local, so tests calling `monitor_tick()` directly are unaffected.

`begin_preempt` and `_start_drain_locked` only call `notify_all()`; they never start the monitor. Tests call `monitor_tick()` directly.

Timestamp parsing uses `_int_prop(props: dict[str, str], name: str) -> int`. It returns `int(props[name])`, or 0 when the key is missing, the value is empty, or `int()` raises `ValueError`. `monitor_tick()` never indexes `props[...]` directly for timestamps. `ActiveState`/`SubState` are read with `props.get(name, "")`, so `unit_props` returning `{}` classifies as `running` (fail closed) and raises nothing.

`monitor_tick()` reads `props = unit_props(COMFY_UNIT, "ActiveState", "SubState", "InactiveExitTimestampMonotonic", "ActiveEnterTimestampMonotonic")` and `phase = comfy_phase(props)` outside the lock. It then applies the first matching rule:

| Current state         | Phase               | Cooldown active? | Action                                                                                                                                                                                                                                                |
| --------------------- | ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any                   | `off`               | —                | If `comfy_state != "none"`: set `comfy_state = "none"` and `drain_deadline = None`, `notify_all()`, log INFO `comfy hold released after Xs`. The next coder request goes through the normal `select_model` path (~52-72 s cold start, within 540 s).  |
| `held` or `draining`  | `waiting`           | yes              | Set `comfy_state = "none"` and notify. The container restarted into start-pre during the cooldown, so the coder gets priority and the client sees `deferred`.                                                                                         |
| `none`                | `running`           | no               | `_start_drain_locked()` (bypass safety net).                                                                                                                                                                                                          |
| any                   | `running`           | yes              | Ensure `comfy_state != "none"`; call `_start_drain_locked()` if it is. Then re-issue the max-hold stop (below). This repairs a switcher crash that happened between persisting the cooldown and completing the stop.                                  |
| `held`                | `running`           | no               | Stray check: `if not all_vllm_down()`, log WARNING `vLLM unit active while ComfyUI holds the GPU; stopping`, then `stop_and_drain(u, now+150)` for each non-down unit. Then the max-hold check (below).                                               |
| `draining`            | `running`/`waiting` | no               | If `not drain_thread_running`: log WARNING `drain thread missing; restarting` and call `_spawn_drain_thread_locked()` (self-heal after a drain-thread crash). Otherwise nothing; the drain thread owns stopping.                                      |
| any other combination | —                   | —                | No action. This covers `none`+`waiting` (with or without cooldown: the client's own `preempt` drives that case) and `held`+`waiting` without cooldown (the container is past the handshake and in the flock wait, which passes because vLLM is down). |

The max-hold check runs only when all of these hold:

- `comfy_state == "held"` and `COMFY_MAX_HOLD_SECONDS > 0`;
- the phase is `running` and `props.get("ActiveState") == "active"`;
- `enter = _int_prop(props, "ActiveEnterTimestampMonotonic")` and `exit_ = _int_prop(props, "InactiveExitTimestampMonotonic")` are both non-zero. If either is 0 (missing, unparsable, or never set), skip the check this tick;
- `enter > exit_`, so the timestamp belongs to this activation;
- `now - enter / 1e6 >= COMFY_MAX_HOLD_SECONDS`.

When the check fires:

1. Set `cooldown_until = now + COMFY_COOLDOWN_SECONDS` and persist it.
2. Log WARNING `comfy max hold (1800s) reached; stopping ComfyUI`.
3. Run `[SUDO, "-n", SYSTEMCTL, "stop", COMFY_UNIT]` with timeout 150.

The gate service `Requires=` the container, so it stops too, while the socket keeps listening. The release happens on a later tick through the `off` row. If the stop fails, log ERROR; the "running + cooldown" row retries it on the next tick. Stops run synchronously in the monitor thread, so they never overlap.

Hold time is counted from systemd's `ActiveEnterTimestamp`. `Type=simple` sets that after `ExecStartPost` (`waitForComfy`), so the drain and the container's cold start don't eat the render budget. It also survives switcher restarts. A job still running at 30 min is killed, which is the user-approved hard cap.

Cooldown:

- While `cooldown_until > now` and the phase is `waiting`, `preempt` returns `deferred` and the coder may start.
- The worker's retries re-activate the socket. The container then sits in start-pre with its client polling `deferred`, and after the cooldown the next `preempt` starts a normal drain.
- Persistence: write `"%.3f" % cooldown_until` atomically (temp file in the same directory, `os.replace`, mode 0600) to `COOLDOWN_FILE`.
- `RuntimeDirectoryPreserve = "yes"` keeps the file across switcher restarts. `/run` and CLOCK_MONOTONIC both reset on reboot, so the value never outlives its clock.
- An unreadable or malformed file is treated as no cooldown and logged at WARNING.

## Decision 6: restart-safe reconciliation

Invariant, owned by the switcher with the flock as the kernel backstop: when `comfy_phase` is `running`, the switcher is in `draining` or `held`, and no vLLM unit is started. When the phase is `waiting` and no cooldown is active, a preempt is in progress or granted.

`reconcile_at_startup()` runs in `__main__` before `serve_forever()`:

1. Load `cooldown_until` from `COOLDOWN_FILE`.
2. Read the Comfy props and phase, then decide under the lock:
    - `running`: `_start_drain_locked()`. The cooldown does not matter here. If the cooldown is active, the first `monitor_tick()` re-issues the max-hold stop.
    - `waiting` with no cooldown: `_start_drain_locked()`.
    - `waiting` with a cooldown, or `off`: stay `none`.
3. Start the monitor thread (the only place it starts).
4. Start the control server: `socketserver.ThreadingUnixStreamServer` with `daemon_threads = True`. First `os.unlink` any stale path (ignore `FileNotFoundError`), then bind and `os.chmod(path, 0o600)`, and serve in a daemon thread.

Draining from a fresh process is quick: `active_requests` is 0 and `switching` is False, because the old process's proxied connections died with it. It still stops any running vLLM unit and verifies it is down before moving to `held`.

Nothing starts at import time, so `test_vllm_switch.py` stays side-effect-free. The control handler calls a pure function, `handle_control(line: bytes, peer_uid: int) -> dict`, so tests need no socket.

Failure cases:

| Case                                                                       | Outcome                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Switcher dies mid-drain                                                    | systemd restarts it after 2 s. Reconcile sees `waiting` or `running`, drains again, and finishes the stop.                |
| Switcher dies while held                                                   | Reconcile sees `running` and drains to `held` immediately. A stray vLLM unit is stopped.                                  |
| Switcher dies after the cooldown is persisted but before the max-hold stop | Reconcile sees `running` and goes to `draining`/`held`. The first tick re-issues the stop (Finding 2).                    |
| Switcher dies after ComfyUI stopped                                        | Phase `off`, so state `none`.                                                                                             |
| Switcher down for more than 60 s while ComfyUI starts                      | The client falls back to the flock. On restart, reconcile sees `running` and holds.                                       |
| Control-socket bind fails (`OSError`)                                      | Fatal: log ERROR and exit non-zero, and systemd restarts the switcher. The HTTP side never runs without the control side. |

## Nix changes

`esnixi/vllm.nix`:

- `systemd.services.vllm-switcher.serviceConfig` adds `RuntimeDirectory = "vllm-switcher"; RuntimeDirectoryMode = "0750"; RuntimeDirectoryPreserve = "yes";`. `ProtectSystem=strict` allows writes under RuntimeDirectory.
- `systemd.services.vllm-switcher.environment` adds `VLLM_SWITCH_COMFY_DRAIN_SECONDS = "120"; VLLM_SWITCH_COMFY_MAX_HOLD_SECONDS = "1800"; VLLM_SWITCH_COMFY_COOLDOWN_SECONDS = "300";`, with a one-line comment for each.
- Add one entry to the `commands` list in `security.sudo.extraRules` for `users = [ "vllm-switcher" ]` (after line 242). It must match `SYSTEMCTL` exactly:
    ```nix
    { command = "${pkgs.systemd}/bin/systemctl stop docker-comfy-esnixi.service"; options = [ "NOPASSWD" ]; }
    ```
    This is a narrow new privilege: stopping ComfyUI and nothing else.
- Set `systemd.services.vllm-switcher.before = [ "docker-comfy-esnixi.service" ];`. This is ordering only, so the socket exists before the container's ExecStartPre at boot.

`esnixi/comfy-worker.nix` (in place, keeping the uncommitted content):

- Add the `requestGpu` binding next to `waitForGpuLease`, and use `ExecStartPre = lib.mkAfter [ "${requestGpu}" "${waitForGpuLease}" ];`.
- Add `wants = [ "vllm-switcher.service" ]` and `after = [ "vllm-switcher.service" ]` to `docker-comfy-esnixi`. Use `wants`, not `requires`, so a broken switcher degrades to the flock path.
- Set `comfyIdleExit = "120s"` and update the comments.
- Update the `waitForGpuLease` comment: it normally passes as soon as the switcher has stopped vLLM.

`esnixi/arcane_worker_launch.py` (comment only): change "may wait indefinitely" to "vLLM is preempted (≤120 s drain + stop)".

## OmniRoute maxConcurrent 4 + re-baseline

Code (same branch):

- `maxConcurrent` 4 is already in the working tree of both scripts: `home/programs/omniroute-mode.py:110` (`PROVIDER_POLICIES`, with the comment at :106-108 already updated) and `home/programs/omniroute-routing.py:166`. Verify with `grep -n maxConcurrent home/programs/omniroute-mode.py home/programs/omniroute-routing.py` and do not re-edit.
- The only remaining code edit is the preview `print(...)` in `main()` of `omniroute-mode.py`. It is at line 363 in today's working tree (the review cited :362); locate it by its text, not its number. Current string:
  `'5090 MTP: one 131072-context request (fixed kvCacheMemory ~4.45 GiB). 4070 IQ3: one 147456-context request. M5 MLX: 131072; M5 DS4: 163840; one shared slot.'`
  Replace it with:
  `'5090 MTP: up to 4 concurrent sequences, 131072 max context (kvCacheMemory 6 GiB). 4070 IQ3: one 147456-context request. M5 DS4: 163840; one slot.'`
  This drops the `M5 MLX: 131072;` clause, because tonight's eviction removed the M5 MLX routes (user message 1). "one shared slot" becomes "one slot", because DS4 no longer shares it with MLX. Edit only this string literal.
- Leave `llama-cpp` and the other providers at 1. Preserve the uncommitted `CLOUD` hunk and every other hunk.
- The deployed esnixi copy (`~/.local/share/omniroute-editor/omniroute-mode.py`, a store symlink) still says 1 until the user deploys home-manager. The implementation report must say so.

esnixi re-baseline (state only, FEAT-003 method, GET only). Run as `celes` on esnixi with `OMNIROUTE_API_KEY="$(cat /run/secrets/omniroute_management_api_key)"` set in the command's environment. Never echo it. 0. Pre-check (GET only, before anything is written). Load the module as in step 2 and GET `/api/providers/<m.CONNECTIONS['vllm']>` with the bearer from the environment. Read `maxConcurrent` from the response (the same field `main()` reads into `before`). If it is not exactly `4`, or the GET fails, abort: write no backup and no state, print `esnixi-5090 live maxConcurrent is <value>; expected 4; re-baseline aborted`, and report it to the user. Never PUT to correct it. The review measured live = 4 on 2026-10-03 (`esnixi-5090 4`, `stabulous-m5max 1`); this pre-check guards against it changing before implementation.

1. Back up `~/.local/state/omniroute-routing/tier-switch-state.json` to `~/.local/state/omniroute-routing/<UTCstamp>-tier-switch-state.before-comfy-preempt.json` with `cp -p` and chmod 600. Record its sha256; it should be `4172ac9f…` unless something changed.
2. Run a short Python snippet that loads the working-tree `home/programs/omniroute-mode.py` via `importlib.util.spec_from_file_location`. The module's `main()` is behind `if __name__=='__main__'`, so the import has no side effects. The snippet:
    1. Loads the state and runs `live = m.live_combos(base)`.
    2. Aborts if any `state['last']` name is missing from `live`.
    3. Sets `state['last'] = {n: m.projection(live[n]) for n in state['last']}` (all 77).
    4. Sets `state['providers'][m.CONNECTIONS['vllm']] = {'maxConcurrent': 4}` and leaves the other providers untouched.
    5. Keeps `version`, `active_mode` (`tiered`) and every other key.
    6. Writes with `m.write_json(state_path, state)` (temp file, 0600, replace).
3. Verify with `python3 home/programs/omniroute-mode.py tiered` (dry run, no `--apply`, same env). It must not raise `Routing drift`, and it must print `Provider esnixi-5090 : maxConcurrent 4 -> 4`. The left value is live (step 0 confirmed 4) and the right value is the policy. Report the printed `Changes:` count; it was 37 when this revision was written. Also check `assert_expected(state['last'], live)` drift 0 in the snippet.

Mac re-baseline (copy, no recompute, no key, no script):

1. `ts=$(date -u +%Y%m%dT%H%M%SZ); cp -p ~/.local/state/omniroute-routing/tier-switch-state.json ~/.local/state/omniroute-routing/${ts}-tier-switch-state.before-comfy-preempt.json && chmod 600 ~/.local/state/omniroute-routing/${ts}-tier-switch-state.before-comfy-preempt.json`. The current sha256 is `de46c142…`.
2. `scp celes@192.168.42.254:.local/state/omniroute-routing/tier-switch-state.json ~/.local/state/omniroute-routing/tier-switch-state.json.tmp && chmod 600 ~/.local/state/omniroute-routing/tier-switch-state.json.tmp && mv ~/.local/state/omniroute-routing/tier-switch-state.json.tmp ~/.local/state/omniroute-routing/tier-switch-state.json`.
3. Check that `shasum -a 256` on the Mac matches `sha256sum` on esnixi.
4. Do not run the Mac's unmanaged `~/.local/share/omniroute-editor/omniroute-mode.py`.

None of these steps issues a PUT, POST or PATCH, and no live combo or provider changes.

Known gap, stated in the implementation report: the re-baseline makes the drift guard accept tonight's live layout, but `build("tiered", live)` still differs from live on the reported number of routes (37 today). A future `omniroute-mode.py tiered --apply` would revert three of tonight's changes:

- the MLX/GLM eviction from tier 1,
- the Bedrock Qwen coders in tier 2,
- the tier-1 reader change.

Encoding tonight's layout into `WEIGHTS`/`TIER1_OVERRIDES`/`CLOUD` is backlogged. Until that lands, nobody runs `--apply` with either script.

## Error handling summary

| Operation                    | Failure                                          | Recoverable?                                                                      | Caller sees               | Log                                |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| Control socket bind          | OSError                                          | Fatal (systemd restarts)                                                          | —                         | ERROR                              |
| Control request              | non-root peer                                    | yes                                                                               | `{"error":"forbidden"}`   | WARNING (uid)                      |
| Control request              | bad/oversize/timeout/unknown op                  | yes                                                                               | `{"error":"bad request"}` | INFO                               |
| Drain                        | timeout with requests in flight                  | yes, stop anyway                                                                  | streams cut               | WARNING (once)                     |
| Stop vLLM unit               | sudo/systemctl error or not inactive by deadline | retry every 10 s                                                                  | client keeps `draining`   | ERROR                              |
| `unit_props`/`unit_state`    | systemctl error                                  | yes, fail closed (`running` / not down); retry next tick                          | —                         | DEBUG (one WARNING per 5 min)      |
| Stray vLLM unit while held   | external start                                   | stop it                                                                           | —                         | WARNING                            |
| Max-hold stop                | stop fails                                       | retry next tick                                                                   | —                         | ERROR                              |
| Cooldown file                | unreadable/malformed                             | treat as none                                                                     | —                         | WARNING                            |
| Client                       | switcher unreachable > 60 s                      | fall back to flock                                                                | unit start continues      | stderr once                        |
| Coder request while reserved | —                                                | yes                                                                               | 409 + `Retry-After: 30`   | none (hot path)                    |
| Drain thread                 | unexpected exception                             | yes; the monitor respawns it next tick, and the state stays `draining` (vLLM off) | client keeps `draining`   | `log.exception`                    |
| Monitor tick                 | unexpected exception                             | yes; the loop continues                                                           | —                         | `log.exception` every failing tick |
| Timestamp parse              | missing/empty/non-int                            | yes; `_int_prop` → 0, max-hold skipped that tick                                  | —                         | none                               |

Logging: `log_message` stays a no-op. Add `logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")` (stderr goes to the journal) and use a named logger only in the preempt, monitor and control code. Never log request bodies or headers.

## Testing

Unit tests go in `esnixi/test_vllm_switch.py`. Extend `FakeSystemctl` to model `docker-comfy-esnixi.service` ActiveState/SubState and timestamps, `systemctl show` without `--value` (KEY=VALUE output), and a scriptable hook between the pre-start check and `start`. Reset the new globals and point `COOLDOWN_FILE` at a temp directory in `setUp`.

| Test | Scenario                                                                                                                                       | Expected                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| o    | Preempt with the coder idle                                                                                                                    | `vllm.service` stopped, then `held`/`granted`; no `start` call.                                                                                                                                                               |
| p    | `acquire_model` while draining or held, for all three model ids                                                                                | Returns False well under `LOCK_WAIT_SECONDS` with no systemctl calls; `refusal == "comfy"`.                                                                                                                                   |
| q    | Drain with a request in flight                                                                                                                 | Waits for `active_requests` to reach 0 (released from another thread) before stopping.                                                                                                                                        |
| r    | Drain timeout of 0.2 s with a request still in flight                                                                                          | Stops anyway.                                                                                                                                                                                                                 |
| s    | Preempt during a `select_model` readiness poll                                                                                                 | The poll aborts and the started unit is stopped before `held`.                                                                                                                                                                |
| s2   | Drain timeout 0.2 s; cold start paused (via the hook) after the abort check passes but before `systemctl start`; preempt begins; hook released | `start` happens, the drain's final scan finds the unit active and stops it, and `comfy_state` becomes `held` only after that stop (assert order on the fake's call log).                                                      |
| t    | Comfy phase becomes `off`                                                                                                                      | Hold released; the next coder request runs stop-others → reset-failed → start unchanged.                                                                                                                                      |
| u    | Max hold                                                                                                                                       | `ActiveEnter` in the past → `monitor_tick()` issues `stop docker-comfy-esnixi.service`, sets and writes the cooldown. `preempt` with phase `waiting` returns `deferred`, and a coder request is admitted during the cooldown. |
| v    | `reconcile_at_startup` variants                                                                                                                | `running` → draining/held. `off` → none. `waiting` + cooldown → none, no preempt. Cooldown file + `active`/`running` → held, and the first `monitor_tick()` re-issues the max-hold stop.                                      |
| w    | `handle_control` input                                                                                                                         | Rejects uid 1000, bad JSON and unknown ops; `preempt` is idempotent (one drain thread).                                                                                                                                       |
| x    | Residency and reader timer                                                                                                                     | Residency is bypassed by preempt. A reader request finishing during the drain does not arm the idle stop (generation unchanged, no timer stop issued).                                                                        |
| y    | `comfy_phase` table                                                                                                                            | Every row of the classifier, including empty → `running`.                                                                                                                                                                     |
| z    | Held + a stray active `vllm.service`                                                                                                           | `monitor_tick()` stops it.                                                                                                                                                                                                    |
| aa   | Lost drainer: `comfy_state = "draining"`, `drain_thread_running = False`, coder idle, Comfy phase `running`                                    | `monitor_tick()` logs `drain thread missing` and spawns a drain thread. Joining it gives `held`, with `drain_thread_running == False` afterwards.                                                                             |
| aa2  | Drain-thread crash: patch `stop_and_drain` to raise once                                                                                       | `_drain_thread_main` logs the exception and clears the flag; state stays `draining`. The next `monitor_tick()` respawns the drain, which reaches `held`.                                                                      |
| aa3  | Exit decision clears the flag atomically: run `drain_and_stop()` while the monitor moves `draining → none`                                     | After the thread returns, `drain_thread_running == False`. A following `begin_preempt()` spawns exactly one new thread (count `threading.Thread` starts).                                                                     |
| bb   | `unit_props` returns `{}`                                                                                                                      | `monitor_tick()` raises nothing, `comfy_phase` is `running`, and no stop is issued.                                                                                                                                           |
| bb2  | `held`, phase `running`/`active`, `ActiveEnterTimestampMonotonic` 0, empty or `"n/a"`                                                          | `_int_prop` returns 0, the max-hold check is skipped, and no `stop docker-comfy-esnixi.service` is issued.                                                                                                                    |
| bb3  | `monitor_tick` patched to raise; run `monitor_loop` in a thread for ~3 polls (`COMFY_POLL_SECONDS` patched to 0.05)                            | The thread is still alive, and `log.exception` was called more than once.                                                                                                                                                     |
| cc   | Throttle: patch `monitor_tick` with a counter, then `notify_all()` 20 times within 0.5 s                                                       | `monitor_tick` runs at most once in that 0.5 s window.                                                                                                                                                                        |

Client tests go in `esnixi/test_comfy_ondemand.py`. Use a real `socketserver.UnixStreamServer` in a temp directory with scripted replies:

- retries on `draining`/`deferred`;
- exits 0 on `granted`;
- falls back after the unreachable window (patched to 0.3 s).

Nix check (also in `test_comfy_ondemand.py`): `requestGpu` precedes `waitForGpuLease` in `ExecStartPre`, and `comfyIdleExit = "120s"`.

Post-build check (the review flagged this as unverified): in the built system's `docker-comfy-esnixi.service` unit file (`result/etc/systemd/system/`), confirm `TimeoutStartSec` is `0`/infinity, or that it is absent and the module default is infinite. If it is finite, add `TimeoutStartSec = 0;` to `systemd.services.docker-comfy-esnixi.serviceConfig` in `comfy-worker.nix`, so a 120 s drain plus a stop plus the cold start cannot time out the start. After the user deploys, `systemctl show -p TimeoutStartUSec docker-comfy-esnixi` must print `infinity`.

Build on esnixi: `python3 -m py_compile` on the touched `.py` files, both test files, and `nixos-rebuild build --flake .#esnixi`. Do not run `switch`; the user deploys. Run lint only if the repo already has a Python linter configured. Remove `__pycache__` created by the tests only if it was not already untracked; it already is, so leave it.

Manual integration, documented and run by the user after deploy:

1. Send a coder request, then `curl 127.0.0.1:28188/queue`.
2. The journal shows the drain, `vllm.service` stopping, and ComfyUI coming up. Coder requests get the "reserved for ComfyUI" 409.
3. After 120 s idle the container stops, and the next coder request cold-starts vLLM.

## Out of scope / backlog

- Encoding tonight's live layout in `omniroute-mode.py` `build()`: the MLX/GLM tier-1 eviction, the Bedrock Qwen coders in tier 2, and the tier-1 reader. This is its own task; until then, no `--apply`.
- A graceful pause instead of a kill at max hold. The user asked for a hard cap.
- `AA_VLM_MODEL=qwen2.5-vl-7b-instruct` against the switcher (which returns 400 for that id). This is unrelated and noted separately.
- Lease holders outside `MODELS` (`vllm-5090-fallback`, `docker-vllm-vision-5090`) are not preempted. The flock still serialises them.
- In-process model swapping in vLLM (message 8) is a separate investigation.

## Responses to design review (revision 2)

1. HIGH, vLLM start after held: addressed.
    - `drain_and_stop` bounds only `active_requests` by the deadline and always waits out `switching`.
    - After the stop pass it re-confirms `not switching` and runs `all_vllm_down()` before setting `held`, looping otherwise.
    - The argument that no new switch can begin after `draining` is spelled out.
    - The held-state monitor stops stray units.
    - An extra abort point was added after the stop-others loop. Tests s2 and z were added.
2. MEDIUM, cooldown vs a running container: addressed. The `comfy_phase(off|waiting|running)` classifier, which fails closed to `running`, now drives reconcile, the monitor table and the bypass check. `running` holds regardless of cooldown and re-issues the max-hold stop. Test v was extended and y added.
3. MEDIUM, stale working tree: addressed.
    - The full `git status` was re-verified.
    - The maxConcurrent 4 values were confirmed at `omniroute-mode.py:110` and `omniroute-routing.py:166` (165 in the brief; the line moved). They are verify-only now.
    - The only code edit left is the :362 preview string.
    - Implementation rules forbid checkout/stash/restore.
    - The route-change count was re-measured against the working tree (still 37, including the uncommitted `CLOUD` edit), and the implementer reports the printed value.
4. MEDIUM, Mac re-baseline: addressed. Back up, `scp` the esnixi state, chmod 600, `mv`, and compare sha256. No key and no script run on the Mac.
5. NIT, `json_response` headers: addressed with an optional `headers` parameter.
6. NIT, sudo path: addressed with the exact `extraRules` entry.
7. NIT, reader timer during preempt: addressed. `release_model` arms the timer only when `comfy_state == "none"`, and test x asserts it.
8. NIT, `SO_PEERCRED` order: addressed with `_, peer_uid, _ = struct.unpack(...)`.
9. NIT, monitor start: addressed. It starts once in `reconcile_at_startup`, `begin_preempt` only notifies, and tests call `monitor_tick()`.

## Responses to design review (revision 3)

1. MEDIUM, lost drain thread: addressed.
    - Every exit decision in `drain_and_stop()` clears `drain_thread_running` in the same lock hold. That covers both `comfy_state != "draining"` returns and the `held` transition.
    - `_drain_thread_main` clears the flag only in the exception fallback, with `log.exception`.
    - The monitor's `draining` row now respawns the drainer through `_spawn_drain_thread_locked()` when `not drain_thread_running`.
    - Tests aa, aa2 and aa3 cover this.
2. MEDIUM, monitor exception guard and parsing: addressed.
    - `monitor_loop` wraps `monitor_tick()` in `try/except Exception` with `log.exception`.
    - `_int_prop` returns 0 on a missing, empty or non-int value, and `ActiveState`/`SubState` use `.get(…, "")`.
    - The max-hold check is skipped when either timestamp is 0.
    - Tests bb, bb2 and bb3 cover this, and the error table gained rows.
3. NIT, default row: added "any other combination → no action", which names the uncovered cases.
4. NIT, tick throttle: `monitor_loop` skips `monitor_tick()` within 1.0 s of the last tick (`MONITOR_MIN_TICK_SECONDS`, local `last_tick`). Test cc covers it.
5. NIT, stale MLX preview: chose to drop the clause. The full replacement string is specified, and "one shared slot" becomes "one slot". The line is :363 in today's tree, and the implementer locates it by text.
6. NIT, live maxConcurrent pre-check: added re-baseline step 0. It GETs `CONNECTIONS['vllm']` and aborts without writing anything if the value is not 4. It never PUTs. The verified-facts section now records live = 4.

Also taken from the review's unverified list: a post-build `TimeoutStartSec` check, with a concrete fallback (`TimeoutStartSec = 0`) if it is finite.
