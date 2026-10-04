# Minimum-residency hysteresis for the esnixi 5090 vLLM switcher

The switcher used to evict the loaded model as soon as a request for the other unit showed up and nothing was in flight. When coder and reader requests interleaved, that meant a cold load every time. This change adds a minimum-residency window (`RESIDENCY_SECONDS`, default 90, read from `VLLM_SWITCH_RESIDENCY_SECONDS`). Inside the window, an idle active model counts as busy for different-unit requests. Those requests wait out `LOCK_WAIT_SECONDS` and get the existing 409, so OmniRoute moves on to its next local target. The change is one extra condition on the swap branch of `acquire_model()`, a single `last_activity` monotonic stamp, and a bounded wake so a window that expires during the lock wait still swaps. The diff matches the plan item for item.

Watch for: `VLLM_SWITCH_RESIDENCY_SECONDS=inf` is accepted and pins the active model until the reader idle stop (non-blocking, confirmed). Items 5 and 6 (commit, deploy) have not run yet. That is expected for this step but still outstanding.

**Verdict**: APPROVED

## High-level view

The gate goes on the swap branch only. The same-unit branch comes first and is unchanged, so same-unit requests, including the `-balanced` alias, never see residency. A blocked different-unit request goes through the existing deadline wait and `return False`, so the 409 contract with OmniRoute is unchanged and nothing gets stopped.

There is no starvation once the window closes. The wait is `min(remaining, hold)`, so a waiter wakes when residency expires and goes through the normal swap path. With zero in-flight and the window expired, behavior is the same as before. `last_activity` is cleared whenever `active_model` becomes `None` (swap start, failed switch, idle stop), so a stopped unit never blocks anything.

The reader idle stop is untouched apart from clearing the stamp. `_maybe_stop` deliberately skips the residency check, and the generation counter logic is unchanged. Tests f through l cover readiness coupling, both swap directions, the boundary, the mid-wait expiry, same-unit concurrency, stamping, idle stop inside the window, and env parsing. The coder's evidence shows 13/13 passing on two runs, plus a build artifact with `Environment="VLLM_SWITCH_RESIDENCY_SECONDS=90"`.

Scope is clean. Only `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`, and `esnixi/vllm.nix` changed. The unrelated dirty set on the host matches setup.md exactly.

<details>
<summary>Issues (3)</summary>

1. **`inf` residency accepted (non-blocking)**: `_env_seconds` rejects only negatives and parse errors (`nan` falls back to the default because `nan >= 0` is false), so `"inf"` pins the active unit indefinitely. If that matters, add an upper clamp or reject `math.isinf`.
2. **"Staged" files are intent-to-add (informational)**: setup.md lists the `A` files as staged, but `git status --short` shows them as ` A` (intent-to-add) and `git diff --cached` is empty. The path-limited commit in item 5 is still the right call, and nothing was changed by this work.
3. **Not committed or deployed (non-blocking)**: plan items 5 and 6 are still open. Commit path-limited, then `nixos-rebuild switch`, then confirm `systemctl show vllm-switcher -p Environment` and the journal shows no swaps closer than 90s apart.

</details>

<details>
<summary>Details</summary>

### Swap gate and the bounded wake

```python
elif not switching and active_requests == 0:
    hold = residency_remaining(time.monotonic())
    if hold <= 0:
        switching = True; active_model = None; last_activity = None
        break
...
switch_condition.wait(min(remaining, hold) if hold > 0 else remaining)
```

`hold` is reset to 0 on every loop iteration. That means a cross-unit request blocked by in-flight work (`active_requests > 0`) keeps the plain `remaining` wait, and residency only shortens the wait when it is the actual blocker. `residency_remaining` returns 0 when `active_model is None`, so a cold switcher (after startup, a failed switch, or an idle stop) swaps immediately. Same-unit traffic re-stamps `last_activity` on both acquire and release. Under steady reader traffic with gaps under 90s, the coder will 409 every time. That is the intended trade-off: OmniRoute takes the next target instead of paying for a cold load.

### Reader idle stop and generation counter

`_maybe_stop` keeps its pre-stop guard (generation, `active_requests`, unit) and adds nothing to it. The post-stop block clears `last_activity` along with `active_model`, which is why test_k can claim the coder right after an idle stop while `RESIDENCY_SECONDS=90`. `release_model` still arms the timer under the same conditions. The extra stamp happens inside the same lock and does not touch `reader_idle_generation`. The systemd `vllm-reader-idle` backstop runs only after 300s idle, well past the 90s window, so a stale stamp never protects a unit that unit stopped behind the switcher's back.

### Evidence review

verification.md records `python3 esnixi/test_vllm_switch.py` passing twice (13 tests, about 2.2s each run), `nixos-rebuild build --flake .#esnixi` exiting 0, the rendered unit containing the env var, and the built script containing `residency_remaining`. test_f (reader `context` == `--max-model-len` 65536) still passes. test_g asserts no stop/start in both directions plus intact state (`switching False`, `active_requests 0`). test_h2 proves the mid-wait wake by timing (<2s with a 3s lock wait). The timing-based tests (h2, k) use generous margins and passed on both runs, so no spot-check was needed. tearDown restores `RESIDENCY_SECONDS`, `LOCK_WAIT_SECONDS`, and `READER_IDLE_SECONDS`, so a failing assertion cannot leak config into later tests.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm-switch.py`: `_env_seconds`, `RESIDENCY_SECONDS`, `last_activity`, `residency_remaining`; swap gate and bounded wait in `acquire_model`; stamping in `release_model` and after a switch; clears the stamp on idle stop; comment update in `select_model`.
- `esnixi/test_vllm_switch.py`: setUp/tearDown save and restore; `_seed_active` helper; tests g, h, h2, i, j, k, l.
- `esnixi/vllm.nix`: `VLLM_SWITCH_RESIDENCY_SECONDS = "90"` in the `vllm-switcher` environment.

Full diff: `git diff -- esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix` on celes@192.168.42.254 in `/home/celes/sources/celesrenata/nix-flakes-refactored`.

</details>
