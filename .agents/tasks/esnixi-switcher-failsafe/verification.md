# Verification: fail-safe esnixi vLLM switcher (iteration 1)

Host: esnixi, repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `main` (the plan notes `feat/nvfp4-reader-fabric` no longer exists locally). Base HEAD `e700258`. Commit `9fc7375 fix(esnixi): fail-safe vLLM switcher (rollback, breaker, watchdog, deadlines)` touches only `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`, `esnixi/vllm.nix` (891+/236-). `esnixi/vllm_idle.py` was not changed. Pre-edit check: the switcher files were clean; the only other change was the untracked `distcc-monitor.sh`, which is still untracked and was not touched.

## Commands and results (run on esnixi, Python 3.14.7)

| Command                                   | Result                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `python3 esnixi/test_vllm_switch.py`      | Ran 32 tests, OK (32 pass, 0 fail). Before the change: 16 tests, OK |
| `python3 esnixi/test_vllm_idle.py`        | Ran 7 tests, OK (file not changed)                                  |
| `nix-instantiate --parse esnixi/vllm.nix` | parses                                                              |

Each command was run as `ssh celes@192.168.42.254 "cd /home/celes/sources/celesrenata/nix-flakes-refactored && <cmd>"`. No `nixos-rebuild build` or `switch` was run; the build/deploy step owns that.

## Tests (all pass)

The 16 existing tests a–o still pass, including `test_f_context_matches_served_max_model_len` and `test_m_coupling_matches_vllm_nix` (MODELS context == `--max-model-len`, max_requests == `--max-num-seqs` == 4, ports). The only change to them: they now set `CODER_RESIDENCY_SECONDS` next to `RESIDENCY_SECONDS` so they keep their old meaning.

New tests:

- p: a sleep that exceeds its budget falls back to stop. p2: a hung `systemctl stop` (TimeoutExpired) is bounded; `switching` is cleared afterwards.
- q: a reader request while the coder has a request in flight gets 409 `coder_busy`, and nothing is slept.
- r: a reader request inside the 90 s coder residency gets 409 `coder_resident`, and nothing is slept. The coder still takes the GPU back from an idle reader at once.
- s: through `do_POST`, the 409 body has `code`, `type: vllm_switch_unavailable`, and a message with the original text plus the reason.
- t: the target's start fails. Result: 409 `start_failed`, the coder is restored as active, and the next coder request needs no lifecycle action. x: a rise in NRestarts gets the same rollback, and the failed reader is stopped.
- u: with the breaker open, the request gets 409 `backoff` in under 1 s with a `Retry-After` header. No lifecycle events run and the active model is untouched.
- v: backoff steps are 300, 600, 1200, 1800, then stays capped at 1800. w: a successful half-open start resets the breaker and logs `breaker CLOSED`.
- y: the watchdog readies the coder after more than 60 s with nothing ready. If the coder is asleep it does no start/stop; if the coder is stopped it starts it. y2: the watchdog does nothing below the threshold, during a switch, or while the coder's breaker is open. y3: after a restart it adopts an already-awake reader without touching anything. y4: it clears an active model whose unit has died. y5: `watchdog_loop` keeps running after a tick raises, and logs it.
- z: in vllm.nix the reader has `restart = "no"`, the coder does not, and all the new `VLLM_SWITCH_*` env values parse.

Notable test output: the WARNING/ERROR log lines are the expected breaker/rollback/watchdog messages (e.g. `breaker OPEN unit=vllm-reader.service failures=1 backoff=300s reason=unit failed`).

## Notes for the reviewer / deploy step

- Expected closure change: `unit-vllm-reader.service` gets `Restart=no`, and `unit-vllm-switcher.service` gets the new env plus a new `vllm-switch.py` store path. The coder and fallback units should not change (`restart` defaults to `"on-failure"`).
- When the watchdog "readies" an asleep coder, it marks the coder active without waking it. The actual wake (~0.84 s) happens on the first request, through the unchanged `vllm_idle` middleware, so ComfyUI keeps the GPU lease until then.
- A wake error inside `vllm_idle` on the first request after a warm switch is passed back as the backend's error status. It does not trigger a rollback, because the plan chose not to add a wake endpoint. If the backend is unreachable the request gets a 502, and the watchdog clears an active model whose unit has died.
