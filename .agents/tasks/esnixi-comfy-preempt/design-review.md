# Design review: ComfyUI preempts the 5090 coder (revision 3)

Verdict: CHANGES_REQUESTED (3 HIGH, 1 MEDIUM, 2 NIT)

All six revision-2/3 findings (lost drain thread, monitor guard and `_int_prop`, default row, tick throttle, MLX preview string, live maxConcurrent pre-check) are addressed as written. The OmniRoute section is concrete and safe: GET-only, abort on live != 4, no PUT/POST/PATCH, and the backup and sha checks are specified with real paths.

The blocking problem is new. The esnixi working tree changed under the design. At 03:39 PDT (two minutes before this revision was saved), `esnixi/vllm-switch.py`, `esnixi/vllm.nix`, `esnixi/vllm_idle.py` and `esnixi/test_vllm_switch.py` were rewritten, and `esnixi/test_vllm_idle.py` was added. That change is vLLM sleep mode, which is the "take its GPU share out until called" work from user messages 8 and 11. Decisions 3 to 6 are written against code that no longer exists.

## Findings

### 1. HIGH: the design is built on a switcher and vllm.nix that no longer exist

Where: "Verified vs assumed" (vllm-switch.py, gpu_launch, vllm.nix), Decision 3 (residency and generations), Decision 5, test x.

What the working tree has now (read over SSH, `git diff HEAD`):

- The reader idle-stop machinery is gone. `reader_idle_generation`, `READER_UNITS`, `arm_reader_idle_stop` and `_maybe_stop` were all removed. `release_model` now just decrements and notifies ("Idle readers put themselves to sleep (vllm_idle.py VLLM_IDLE_SECONDS)"). The `vllm-reader-idle` service and timer were also deleted from vllm.nix.
- `VLLM_SWITCH_RESIDENCY_SECONDS` is now `"0"` in vllm.nix, not 90.
- Both vLLM units use `sleepMode = true`, with `--enable-sleep-mode --middleware vllm_idle.IdleSleepMiddleware`. The coder has `idleSeconds = "0"` (it sleeps only when asked). The reader has `idleSeconds = "300"`. The lease (`arcane_gpu.GPULease`) is released after every sleep and re-acquired before every wake (`VLLM_LEASE_WAIT_SECONDS=60`). The design's claim that "the lease lasts the whole process lifetime" is no longer true.
- `vllm.service` and `vllm-reader.service` no longer `Conflicts=` each other. Both can be active at once, with one of them asleep.
- `select_model` changed. It now sleeps each other unit (`sleep_unit`: POST `/arcane/sleep`, retried for up to `SLEEP_DRAIN_SECONDS=30` with a 120 s `urlopen` timeout) and falls back to `stop_and_drain`. Then it tries a warm path (`unit_running` + `wait_ready(..., -1)`). Only after that does it reach `reset-failed` → `is-failed` → NRestarts → `start`.
- The sudo `extraRules` are now vllm.nix lines 262-269, not 233-245. `test_vllm_switch.py` has 16 tests, not 15.

Effects on the design:

- Decision 3's "bump `reader_idle_generation`" and "add `and comfy_state == "none"` to `release_model`'s condition" point at code that isn't there.
- Test x cannot be written.
- The brief's "preserve the 90 s hysteresis / reader idle-stop / generation counter" is now owned by the sleep-mode change. Residency is 0 and the generation counter is gone.
- The Implementation rules' list of uncommitted files leaves out `vllm-switch.py`, `vllm.nix`, `vllm_idle.py`, `test_vllm_switch.py` and `test_vllm_idle.py`. Those are the files this design edits, so the in-place rule is most important for them.

Fix:

- Re-read all of the above on esnixi and rebase Decisions 3 to 6 onto the sleep-mode switcher.
- Replace the residency/generations bullets with: "Residency is 0 (sleep mode). Preemption does not touch it. The reader's in-process idle sleep (`VLLM_IDLE_SECONDS=300`) is independent of the switcher and unaffected."
- Drop test x, or replace it with "a reader request finishing during a drain does not wake or start anything".
- Add the five files to the Implementation rules list.
- Correct the sudo line reference to "append after line 269" and the test count to 16.

### 2. HIGH: the "fast 409 for every model, never start vLLM" guarantee is broken by sleeping units and the warm path

Where: Decision 3 abort point 2 (bypass check), Decision 4, Decision 5 (`none` + `running` row, 30 s wait when `none`).

With sleep mode, ComfyUI can get the flock while both vLLM units are `active` but asleep. That happens after the reader's 300 s idle sleep while the coder is asleep. It is now a normal path, not only the client's 60 s fallback. In that state `comfy_state` can be `none` (a switcher restart in which reconcile raced a start, or the bypass), and then:

- A request for the `active_model` unit takes the fast path in `acquire_model` and never enters `select_model`. It is proxied, and `IdleSleepMiddleware.enter()` blocks for up to 60 s on the lease before failing. That is not a fast 409.
- A request for the other unit enters `select_model`. It sleeps the other unit, then takes the warm path, which returns True as soon as `/v1/models` answers (it does not wake the engine). The bypass check placed "immediately before `sudo systemctl start`" is never reached.
- The monitor only notices `none` + `running` every 30 s.

Fix (pick and state all three):

- (a) Put the bypass check at the start of `select_model`, before the sleep-others loop and the warm path, as well as before `start`.
- (b) In `acquire_model`'s fast path, do not add a systemctl call. Instead make the monitor poll every `COMFY_POLL_SECONDS` (2 s) in every state, so `none` + `running` becomes `draining` within 2 s. Accept and document a worst case of one ≤ 60 s middleware lease wait in that window.
- (c) Add a test: `comfy_state == "none"`, Comfy phase `running`, `vllm.service` active-and-asleep. A request for the active model and a request for the reader both return False with no proxy, and no `start` is issued once the monitor has ticked.

### 3. HIGH: drain stops units instead of sleeping them, which discards sleep mode and contradicts the user's intent

Where: Decision 3 `drain_and_stop` / `all_vllm_down()`, the Decision 5 stray check ("held + running → stop every non-down unit"), Decision 6 invariant "no vLLM unit is started", the release text ("~52-72 s cold start").

User messages 8 and 11 ask for the GPU share to be taken out "until called", without cold starts. The sleep-mode change now provides exactly that. The design's held predicate requires every unit to be `inactive`/`failed`, and the monitor stops any unit that is merely asleep on every tick. So every ComfyUI job costs a full coder cold start, and the reader's warm residency is destroyed. The preempt mechanism needs a decision either way.

Fix (recommended, concrete):

- Define `gpu_released(unit) -> bool`. It is True when `unit_state(unit)[0] in ("inactive", "failed")`, or when GET `http://127.0.0.1:{unit_port(unit)}/arcane/state` (3 s timeout) returns `sleeping == true and lease_held == false`. An unreachable endpoint or any error on an active unit returns False (fail closed).
- The drain stop pass calls `sleep_unit(unit, now+150)` for each unit where `not gpu_released(unit)`, and falls back to `stop_and_drain` only if `sleep_unit` returns False.
- `held` requires `all(gpu_released(u) for u in vllm_units())`.
- The monitor's stray row uses the same predicate. It sleeps the unit (stopping it only if sleep fails), and never stops a unit that already passes `gpu_released`.
- Release text: the next coder request takes the warm path and the middleware wakes it in seconds. A cold start happens only if the unit was stopped.
- Update tests o, s, s2 and z to assert sleep-first, and add "sleeping units are left alone while held".

If the author keeps stop-only instead, the design must say so explicitly, with the reason, and the report must tell the user that each Comfy job forces a coder cold start.

### 4. MEDIUM: abort points and the bounded-drain argument no longer hold for the new `select_model`

Where: Decision 3 ("each switch aborts within one poll"; the abort points after the stop-others loop, before `start`, and in the readiness loop).

`drain_and_stop` waits out `switching` with no deadline. In the new `select_model`, a switch can sit inside `sleep_unit` (a retry loop of up to 30 s, each `urlopen` up to 120 s) or inside the warm-path `wait_ready` (up to 540 s). Neither has an abort point in the design. So "≤120 s drain" is not bounded as stated.

Fix:

- Add `if comfy_aborted(): return False` at the top of each iteration of the `sleep_unit` retry loop, and at the top of each `wait_ready` iteration. That covers the warm and cold paths, because both use `wait_ready`. Add another check immediately after the sleep-others loop.
- State the worst case: one in-flight `urlopen` (≤ 120 s for `/arcane/sleep`, ≤ 3 s for `/v1/models`) plus `stop_and_drain` (≤ `TimeoutStopSec=120` + settle).
- Add a test: preempt while `select_model` is inside the `sleep_unit` retry loop aborts within one iteration.

### 5. NIT: release and cold-start wording, plus the Mac/esnixi drift numbers

Once Finding 3 is resolved, update the Overview and Decision 5 text that says the coder "cold-starts" after a hold. The 37-route and 54-drift figures are fine as "report what the dry run prints". No change is needed beyond the wording.

### 6. NIT: host RAM budget with sleep mode plus ComfyUI is unverified

With sleep-first preemption, the host holds all of these at once:

- the coder's weights pinned (~17 GB NVFP4 27B),
- its 32 GiB pinned KV offload tier,
- the reader's weights,
- ComfyUI's model RAM.

128 GB is likely enough, but nothing measures it. Add a manual post-deploy check: `free -g` and the `MemoryCurrent` of `vllm.service`, `vllm-reader.service` and `docker-comfy-esnixi.service` during a held render.

## Verified assumptions (read-only, SSH, HEAD 3601dd8)

- Switcher binds `Server(("127.0.0.1", 8011), Handler)`. `json_response(self, status, payload)` takes no headers argument. The 409 text is "RTX 5090 is busy; use the next OmniRoute fallback".
- `acquire_model` has a `while True:` loop under `switch_condition`, with fast-path and swap-branch structure, and a `finally` that resets `switching`/`active_model` and calls `notify_all()`. Decision 4's placement of the `comfy_state` check as the first loop statement is feasible.
- `unit_state` uses `systemctl show --value` ActiveState/SubState and returns `("", "")` on error. `stop_and_drain` runs `sudo -n systemctl stop` (timeout 120) and polls until inactive/dead, then settles for 2 s.
- vllm.nix: the switcher has `SYSTEMCTL=${pkgs.systemd}/bin/systemctl`, `SUDO=/run/wrappers/bin/sudo`, `Restart=always`, `RestartSec=2s`, `ProtectSystem=strict`, and `RestrictAddressFamilies` including `AF_UNIX`. The sudo rules are explicit per-command NOPASSWD entries, so the proposed `stop docker-comfy-esnixi.service` entry matches the existing style. The vLLM units have `Restart=on-failure` and `TimeoutStopSec=120s`.
- comfy-worker.nix: `comfyIdleExit = "30s"` (line 14), `waitForGpuLease` (line 18), `StopWhenUnneeded` (line 119), `ExecStartPre = lib.mkAfter [ "${waitForGpuLease}" ]` (line 122), `--exit-idle-time=${comfyIdleExit}` (line 142). The comment at line 16 says the unit has `TimeoutStartSec=0`; the post-build check is still worthwhile.
- `test_vllm_switch.py` passes on the current tree (16 tests OK).

## Unverified or wrong assumptions

- WRONG: "vllm-switch.py HEAD = working tree". It is modified (+/-156 lines, mtime 03:39).
- WRONG: the globals `reader_idle_generation`, `READER_UNITS`, `arm_reader_idle_stop`/`_maybe_stop` exist. They were removed.
- WRONG: `VLLM_SWITCH_RESIDENCY_SECONDS="90"`. It is now `"0"`.
- WRONG: "gpu_launch.py … the lease lasts the whole process lifetime". With sleep mode, the middleware releases and re-acquires the inherited lease.
- WRONG: the `select_model` order "stop the other units → reset-failed → …". It is now sleep-or-stop the others → warm path → reset-failed → is-failed → NRestarts → start.
- WRONG: sudo rules at lines 233-245 (now 262-269), and test count 15 (now 16).
- UNVERIFIED: the `/arcane/state` response shape is `{"sleeping","active","lease_held"}` per the `vllm_idle.py` docstring. I did not exercise it live.
- UNVERIFIED (carried over): OmniRoute treats a 409 as a fall-through. `--exit-idle-time` counts only zero-connection time. `start-pre` SubState is held for the whole ExecStartPre.
