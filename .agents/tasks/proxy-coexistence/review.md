# Resident-set coexistence rework for local-model-proxy

The change replaces the proxy's single-`active_backend` / single global `generating`-counter model with a per-alias resident set. Each resident launchctl alias carries its own `BackendRecord` (in-flight counter plus `ready`/`drained`/`gone` events); `glm53` and `qwen38-uzu` are config-tagged `coexist` and may be resident at the same time, while every other launchctl backend is exclusive and evicts the entire resident set before starting solo. Ollama is Class-1: untracked, uncounted, never evicted. The hard part is the lock discipline — `_lock` guards only synchronous reads/writes of `resident` and never spans a `health_wait`, drain, stop, or forward — and the implementation matches the design's "lock guards the state machine, awaits happen outside, events signal completion" contract across all three acquire classes. The three finalized iteration-4 fixes (slot bound to acquire success, coalesced-waiter timeout = `LAUNCHCTL_START_TIMEOUT + startup_timeout`, warm-up-only `/admin/select`) are all present and correctly wired.

Watch for: `release()` runs outside `_lock`, a deliberate deviation from the design's "release under `_lock`" wording — safe because the body is synchronous with no await, confirmed non-blocking. No blocking concern was found against the nine named hazards or the checklist.

**Verdict**: APPROVED

## High-level view

The resident-set data model is faithful to the design. `ProxyState.resident` is the sole residency representation, there is no `ABSENT` literal, and record identity is the dataclass instance — every commit after a lock-free await re-reads `resident.get(alias) is my_record` before mutating. The three acquire classes dispatch on alias type and coexist membership exactly as specified: Class 1 returns an `OllamaSentinel` with no tracking, Class 2 (`_acquire_coexist`) evicts only exclusive residents and never the sibling coexist backend, Class 3 (`_acquire_exclusive`) evicts every other resident.

Lock discipline is the correctness spine and it holds. Every `async with self._lock` block in `acquire`, `drain_and_stop`, `_cold_start`, and `_wait_for_starter` contains only synchronous state reads/writes; the long awaits (`launchctl_start`, `health_wait`, `drain_and_stop`, `deactivate_backend`, forwarding) all run with the lock released. Cross-alias waiting uses per-record `ready`/`gone` events, never a nested lock acquisition, so there is one lock, never held across an await, and no lock-ordering cycle.

The drain-before-evict primitive `drain_and_stop` is the single stop chokepoint with the step-0 idempotency+identity guard, the aborted-drain `DRAINING → RESIDENT` recovery on timeout, and the confirmed-exit poll via `confirm_exit` before removal. The `del resident[alias]` and `gone.set()` happen in the same critical section, so a `gone`-waiter always wakes to a freed key.

The two 503 shapes (`backend_unavailable` with `Retry-After: 5`, `model_switch_queue_timeout` with `Retry-After: 2`) and the 400 `model_not_resolved` replace the old unstructured 500, routed through one `_error_response` mapper shared by the single `proxy_request` helper that all four POST handlers call. `models.json` adds `qwen38-uzu`, tags both pair members `coexist: true`, and leaves `models.json.new` untouched (confirmed absent from `git status`).

The release-under-lock requirement is the one deliberate deviation: `release()` mutates `generating`/`drained` without taking `_lock`. The code is purely synchronous with no await between the decrement and `drained.set()`, so the single-threaded loop cannot interleave another coroutine; the deviation is safe and documented in-line.

<details>
<summary>Issues (3)</summary>

1. **release() outside _lock (informational)** — design specifies release under `_lock`; implementation runs it lock-free with an in-line justification. Safe under single-threaded asyncio because the body has no await; no action required.
2. **Verification is uncommitted working-tree state (informational)** — the diff is `git diff` of unstaged changes, not a commit; `test_model_proxy.py` is untracked. Evidence in verification.md is specific (11 passed, seam mocks named). No action required for correctness; ensure the commit lands with the test file.
3. **Catchall counter-exempt asymmetry (informational, by design)** — `handle_v1_catchall` forwards without an acquire slot and maps forwarding `ClientError` to 503 rather than 502, per finding 9. Correct and intended.

</details>

<details>
<summary>Details</summary>

## Resident-set replaces single active_backend

`ProxyState` drops `active_backend`/`switching`/global `generating`/dead `_gen_event` and keeps `resident: dict[str, BackendRecord]`, `coexist_aliases`, `last_used`, and `_lock`. The set of keys whose `state == "RESIDENT"` is "what is up now," and the pair can occupy two of those keys simultaneously. `_acquire_coexist` only ever marks *exclusive* residents `DRAINING` (step 1a's `exclusive_residents` list is filtered through `exclusive_launchctl_aliases()`), so a GLM request never touches a resident Uzu and vice versa. Per-alias `generating` + `drained` make the drain target precise: an evictor waits on exactly the victim's counter, so GLM's in-flight work cannot block a Uzu eviction and the two counters are fully decoupled.

The anti-serialization guarantee is structural: `_cold_start` holds `_lock` only to flip the record to `STARTING` and insert it, then releases before `launchctl_start` + `health_wait`. A concurrent request for an already-`RESIDENT` sibling takes the step-1 fast path (`rec.generating += 1; rec.drained.clear(); return rec`) under a microsecond-scale lock hold and forwards without touching the cold-starting alias. Test (d) gates GLM health on an event and asserts a Uzu acquire returns while GLM is still `STARTING` — the exact serialization-freedom trace the design calls for.

## Exclusive eviction and ollama exemption

`_acquire_exclusive` marks *every other* resident `DRAINING` (both coexist members and any other exclusive) and drains+stops them before starting solo. Test (b) confirms a `deepseek-v41-uncensored` request deactivates both `glm53` and `qwen38-uzu` and leaves only ds4 resident. Class 1 (`entry.type != "launchctl"`) returns `OllamaSentinel` immediately — no record, no counter, no health check — and `release()` is a no-op for it. Test (g) confirms the ollama alias is never started/stopped/deactivated/tracked even when an exclusive request evicts the pair. The deliberate behavior change (ollama can now co-reside with the pair, operator owns that footprint) is documented in the design and correctly realized as "untracked."

## Lock-free await discipline and record identity

Every commit that mutates based on work done during a lock-free await re-reads `resident.get(alias)` and compares by `is`:
`_cold_start` success asserts `resident.get(alias) is my_record` before setting `RESIDENT`; its failure path only records `start_error`/removes/sets `gone`+`ready` when still the resident instance; `_wait_for_starter` increments only when `cur is rec and rec.state == "RESIDENT"` (and, for `require_solo`, no other key is resident), otherwise returns `None` to re-drive the loop; `drain_and_stop` step 0 and step 4 both guard the `del` by identity. This is the design's record-identity invariant applied in exactly the four places it names, which is what makes the key-reuse cycle (`DRAINING → gone → fresh STARTING`) safe — key presence alone is never trusted.

The coalesced-waiter commit sequence in `_wait_for_starter` is the subtle one and it is correct: it checks `start_error` first (raise), then identity+`RESIDENT` (commit), else `None` (continue). A waiter woken by a `ready.set()` from a failed start re-reads `start_error` and raises `BackendUnavailable` rather than incrementing a dead record — closing the counter-leak wedge (hazard 7). Test (f) exercises the slow-but-successful path (both requesters coalesce onto one start, both slots counted, exactly one `launchctl_start`); the thundering-herd test extends it to N=5.

## Coalesced-waiter timeout (iteration-4 fix 2)

`_wait_for_starter` computes `waiter_timeout = LAUNCHCTL_START_TIMEOUT + startup_timeout` using the same `startup_timeout` the starter reads from the entry, so a parked waiter cannot time out before the starter's whole worst-case budget (`launchctl kickstart` bound + `health_wait`) is exhausted. The design is explicit that correctness rests on the `start_error`/`gone` give-up signals, not on this bound racing the starter; the generous ceiling is a last-resort. Test (f) monkeypatches `LAUNCHCTL_START_TIMEOUT` and the entry's `startup_timeout` small and confirms no spurious 503.

## Slot bound to acquire success (iteration-4 fix 1)

`proxy_request` resolves the alias, calls `await state.acquire(alias)` inside its own `try` that maps `BackendUnavailable`/`ModelSwitchQueueTimeout` to a 503 and returns — and only *after* a successful acquire opens the `try/finally` that owns `release(record)`. A raising acquire therefore never reaches `release`, so a 503 from acquire cannot underflow a counter. `acquire` increments the slot only on the success path (fast path, cold-start success commit, coalesced commit). Test (e) proves a GLM start/health failure leaves a resident Uzu's `generating` at 0 and never deactivates Uzu. `release()` also floors at 0 defensively.

## drain_and_stop: the single stop chokepoint

Step 0 bails if `resident.get(alias) is not record` or `record.state == "STOPPING"`, so two evictors targeting the same victim resolve to exactly one stop (hazard 5). Step 2 waits on `drained` bounded by `QUEUE_TIMEOUT`; on `TimeoutError` it performs the aborted-drain recovery — under `_lock`, if still the resident instance and still `DRAINING` (so no `launchctl kill` was issued), it reverts `DRAINING → RESIDENT` and re-sets `ready`, then raises `ModelSwitchQueueTimeout`. This closes the permanent-liveness-wedge (hazard 7 / finding 1): a 45-second completion colliding with a switch leaves the victim serving, not bricked `DRAINING`. Test `test_drain_timeout_leaves_victim_running` confirms the victim stays `RESIDENT` and is never deactivated. Step 3 marks `STOPPING` then calls `deactivate_backend` lock-free; step 4 does `del resident[alias]` + `gone.set()` in one critical section.

The exclusive coldstart branch adds the one piece of extra cleanup the design requires: if `_evict_targets` raises `ModelSwitchQueueTimeout` mid-eviction, the orphan `STARTING` `my_record` is removed (identity-checked) and its `gone` set before the 503 propagates, so a retry re-evaluates cleanly (hazard 6). The coexist evict-exclusives branch needs no such cleanup because it creates no `my_record` before evicting — the asymmetry is correct, not a gap.

## Confirmed-exit before restart

`deactivate_backend` for launchctl does `launchctl_stop` (SIGTERM, tolerant of a non-zero "already stopped" return) then `confirm_exit`, which polls `launchctl print <service>` with the three-way parse: exit 0 with a `pid =` line → still running (keep polling); non-zero "could not find service"/"service not found" → confirmed gone; anything else (argument-format/usage error) → not gone, keep polling until `EXIT_CONFIRM_TIMEOUT` then raise. `launchctl_print` is passed the already-`$UID`-expanded `service` with no extra `gui/$UID/` prefix, avoiding the double-prefix mis-detection the design warns about. A failure to confirm raises `RuntimeError`, so `drain_and_stop` never reaches step 4 and the record stays `STOPPING` — no phantom "stopped but live" state, preserving ds4 single-process-lock safety.

## Error mapping and forwarding resolution

`resolve_forward_alias` implements the uniform rule across all POST handlers and the catchall: explicit model resolves via `backend_for_model`; else zero launchctl residents → `BackendUnavailable` (503); exactly one → use it; more than one bare → `ModelNotResolved` (400). The old `active_backend` fallback is gone. `_error_response` centralizes the three structured shapes with the two `Retry-After` values. The catchall is counter-exempt by design and maps a forwarding `ClientError` to 503 `backend_unavailable` (tolerating mid-request eviction) rather than 502 — the one documented, justified asymmetry. Test `test_resolve_forward_alias_rules` covers all four resolution branches.

## models.json and the config classification

`qwen38-uzu` is present (`:8073`, `startup_timeout: 180`, `coexist: true`, with `qwen3.8-27b-uzu` in `model_names` so resolution works); `glm53` carries `startup_timeout: 600` + `coexist: true`; `qwen38-mlx` keeps `startup_timeout: 300` (now actually honored since `_cold_start` passes the entry value to `health_wait`); `deepseek-v41-uncensored` and `qwen35-reader-262k` carry no `coexist` (exclusive / untracked). `models.json.new` is absent from `git status`, confirming it was left untouched. `load_config` validates `coexist` is a bool (SystemExit on malformed), applies `DEFAULT_COEXIST_ALIASES` only when zero entries declare the field, warns on a partial migration where a pair member resolves exclusive, and warns+ignores `coexist: true` on an ollama entry.

## Test coverage and the verification evidence

verification.md records `py_compile` OK, `json.tool` OK with programmatic content assertions, and the pytest-asyncio suite at 11 passed in 0.26s under an ephemeral `uv` env, with every OS/subprocess/HTTP seam monkeypatched (`launchctl_start`/`launchctl_stop`/`health_wait`/`deactivate_backend`) so no real service is touched. The seven required tests (a)-(g) all exist and map to their requirements, plus four extras (drain-timeout recovery, release floor, thundering herd, resolve rules). The tests gate cold starts on `asyncio.Event`s rather than real sleeps, so they are deterministic. Per the review mandate I did not re-run the suites; the evidence is specific and the test file content corroborates it.

Not tested (acknowledged as manual/e2e in verification.md): real `launchctl kickstart`/`kill` timing, real `launchctl print` exit confirmation, and real memory headroom (83 GiB pair fits / 90 GiB ds4 solo). These sit behind the two mocked seams and are correctly out of automated scope.

</details>

<details>
<summary>File map</summary>

- `packages/local-model-proxy/model_proxy.py` — full rewrite to the resident-set model: `BackendRecord`/`OllamaSentinel` dataclasses, rewritten `ProxyState` with `acquire`/`release`/`drain_and_stop`/`_cold_start`/`_wait_for_starter`/`_evict_targets`/`_wait_for_gone`, `confirm_exit` three-way parse, shared `proxy_request` + `_error_response`, typed exceptions, `load_config` coexist parsing, adapted admin/status/models/select/stop and catchall.
- `packages/local-model-proxy/models.json` — adds `qwen38-uzu`; adds `startup_timeout: 600` + `coexist: true` to `glm53`.
- `packages/local-model-proxy/test_model_proxy.py` — new async unit suite (11 tests, all seams mocked).

Full diff: `git -C /Users/celes/sources/m5max-darwin-flake/.worktrees/proxy-coexistence diff` plus the new untracked test file.

</details>
