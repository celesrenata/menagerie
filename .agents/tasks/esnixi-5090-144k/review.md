# 144K context for the 5090 coder, plus coder fast-retry in the switcher

Commit `b1869ed` on esnixi `main` raises the 27B coder's `--max-model-len` from 131072 to 147456. It also raises the switcher's `MODELS` context for `qwen3.8-27b-nvfp4` and its `-balanced` alias to 147456, so the readiness check (served `max_model_len == context`) still matches. The switcher gains `select_with_fast_retry()`, which replaces `safe_select` in `acquire()`, `rollback()` and `watchdog_tick()`:

- A coder start that fails with "unit failed", "unit restarted", "systemctl start failed" or an exception is stopped and retried up to 2 times, 15 s apart.
- If every attempt fails, the coder is stopped and its breaker records one failure.
- Reader targets get one attempt, exactly as before.

The closure diff from the coder's evidence touches only `vllm.service`, `vllm-switcher.service` and their aggregators. Commits used explicit paths, nothing was pushed (`main...origin/main [ahead 5]`), and nothing was activated.

Watch for: a coder acquire can now run longer before it answers (**likely**, non-blocking). Readiness timeouts are deliberately not fast-retried (**confirmed**, non-blocking).

**Verdict**: APPROVED

## High-level view

The vllm.nix change is a one-value edit plus a comment line. The built `vllm.service` ExecStart differs only in `--max-model-len`. These flags are byte-identical: `--max-num-seqs 3`, `--kv-cache-memory=5905580032`, gate 0.92, nvfp4 KV, offload 32 native, sleep mode, `--max-num-batched-tokens 5760` and MTP with 3 tokens. The comment's block math holds: 147456 / 2848 rounds up to 52 blocks, plus 15 GDN state blocks gives 67 of the 104 usable. Upstream `max_position_embeddings` is 262144. The local snapshot check is correctly left as the deploy-step gate.

Fast retry is gated on `unit == PRIMARY_UNIT`, so it covers the coder and its balanced alias, which share `vllm.service`. Everything else returns after one attempt. `record_failure` still runs once per outer operation, so the 300→1800 s backoff schedule is unchanged for both units. Stopping the coder after the last failed attempt replaces the old behavior, where systemd `Restart=on-failure` kept restarting it during the breaker window. Routing the restore in `rollback()` through the fast retry means a transient restore failure after a reader failure no longer opens the coder breaker.

The tests cover all three required cases: ff1/ff1b (fail once, then the retry succeeds, no breaker), ff2 (every attempt fails, breaker opens once at about 300 s, coder ends stopped) and ff5 (a reader failure gets one start and one breaker failure, with no fast-retry sleep). They also cover the watchdog (ff3/ff4) and the restore-blame fix (ff6). The coder reports 41/41 passing. A negative control with `CODER_FAST_RETRIES=0` fails ff1/ff1b/ff3/ff6, so those tests depend on the new code.

<details>
<summary>Issues (2)</summary>

1. **Longer coder acquire latency** — a coder that crashes late in startup now holds the requesting client for up to three start attempts plus two stop+15 s gaps. Before, it held the client for one. Check that the OmniRoute and client timeouts on the coder route tolerate this, or reduce `VLLM_SWITCH_CODER_FAST_RETRIES` in the unit env if they don't. Non-blocking.
2. **Readiness timeouts skip fast retry** — a coder that never becomes ready, for example from a context-coupling mismatch or a wedged load, goes straight to the breaker. This is defensible because the attempt already used `START_SECONDS`, but it is a narrowing of "fast retry before the breaker". Document it in the deploy notes. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Fast-retry gating and failure semantics

`select_with_fast_retry` stops retrying in three cases: a success, a non-coder unit, or a failure reason without one of the retryable prefixes. It excludes `could not stop …`, which means a wedged neighbour, and `readiness timeout`. If the stop before a retry fails, it returns the original failure without the final stop. That leaves a wedged coder to the existing rollback/stop path rather than adding another stop attempt (**confirmed**, acceptable). The final stop after exhausting retries means the coder stays down until its breaker expires. The watchdog already skips while the coder breaker is open (test y2), so recovery waits for the 300 s backoff instead of relying on systemd restarts (**confirmed**, matches the intended crash-loop cap).

### Acquire latency

Before this change, `acquire()` bounded the switch at `started + START_SECONDS` (300 s). Now each attempt gets a fresh `START_SECONDS`, and each retry adds up to `STOP_SECONDS` (150 s) plus 15 s. Fast failures such as an immediate unit failure stay cheap. A vLLM crash after weight load or during warmup (around 1–2 min per attempt) can stretch a single coder request to 5–7 minutes before it gets a 409 (**likely**). The switch lock is not held during this time, and other requests get fast 409s, so the only exposure is the original caller's timeout.

### Restore-blame fix

Before this change, a reader failure followed by a single flaky coder restore start recorded a coder breaker failure, which made the watchdog stand down. ff6 pins the new behavior: two coder starts, the coder becomes active, no coder breaker, and the reader breaker shows failures == 1 (**confirmed**).

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm.nix` — coder `maxModelLen` 131072 → 147456 and one KV-budget comment line.
- `esnixi/vllm-switch.py` — `MODELS` context 147456 for the coder and balanced alias; `CODER_FAST_RETRIES` / `CODER_FAST_RETRY_DELAY_SECONDS`; `_fast_retryable`, `select_with_fast_retry`; three call sites switched over; docstring.
- `esnixi/test_vllm_switch.py` — FakeHost `start_fail_times` / `restart_once`, recorded sleeps, tests ff1–ff6.

Full diff: `git show b1869ed` in `/home/celes/sources/celesrenata/nix-flakes-refactored` on esnixi.

</details>
