# Verification: proxy-coexistence implementation (iteration 1)

Branch: `proxy-coexistence` in worktree
`/Users/celes/sources/m5max-darwin-flake/.worktrees/proxy-coexistence`.

Scope note: **logic-only** verification. No `darwin-rebuild`, no live
ds4/uzu/ollama servers, no network to `:8082` / `:8073` / `:7777`. Every OS /
subprocess / HTTP seam (`launchctl_start`, `launchctl_stop`, `health_wait`,
`deactivate_backend`/`confirm_exit`, `launchctl print`) is mocked in the test
suite, so the suite touches no real service.

## Files changed

- `packages/local-model-proxy/model_proxy.py` — rewritten to the resident-set
  model (BackendRecord, resident map, coexist set; `acquire`/`release`/
  `drain_and_stop`; confirmed-exit `deactivate_backend`; shared `proxy_request`
  helper + four thin POST handlers; typed errors + structured 503/400 mapping;
  `load_config` parses/validates `coexist`; admin/status/models/select/stop and
  catchall adapted).
- `packages/local-model-proxy/models.json` — added `qwen38-uzu`
  (`:8073`, `startup_timeout: 180`, `coexist: true`), added
  `startup_timeout: 600` + `coexist: true` to `glm53`. `qwen38-mlx`,
  `deepseek-v41-uncensored`, `qwen35-reader-262k` left without `coexist`
  (exclusive / untracked).
- `packages/local-model-proxy/test_model_proxy.py` — **new** focused async
  unit tests (did not exist on this branch).
- `packages/local-model-proxy/models.json.new` — **left untouched** (confirmed
  via `git status`), per the design's iteration-4 nit.

## Commands run and results

### 1. `python3 -m py_compile`
```
$ python3 -m py_compile model_proxy.py test_model_proxy.py
OK: model_proxy.py compiles   (exit 0, no output)
```
Python 3.13.15 (system) for py_compile; 3.14.6 under the uv test env.

### 2. `python3 -m json.tool models.json`
```
$ python3 -m json.tool models.json > /dev/null
OK: models.json valid JSON   (exit 0)
```
Content assertions (programmatic):
```
OK: qwen38-uzu present; glm53 + qwen38-uzu coexist=true;
    ds4/ollama exclusive/untracked
```
- `qwen38-uzu` present.
- `glm53.coexist == true` and `qwen38-uzu.coexist == true`.
- `deepseek-v41-uncensored` and `qwen35-reader-262k` carry no `coexist`
  (⇒ exclusive / untracked).

### 3. Test suite (pytest / pytest-asyncio, all seams mocked)
Runner (system Python lacks pytest/aiohttp; used the project's available `uv`
to provision an ephemeral env — no repo deps modified):
```
$ uv run --with pytest --with pytest-asyncio --with aiohttp \
      python3 -m pytest test_model_proxy.py -v -o asyncio_mode=auto
```
Result:
```
11 passed in 0.26s
```
Deterministic (no real sleeps; cold starts gated on `asyncio.Event`s;
timeouts shrunk via monkeypatch). A guard run with `--timeout=20` (pytest-
timeout) also passed with no hangs.

Test → design-requirement mapping:

| Test | Covers |
|------|--------|
| `test_coexistence_pair_both_resident_no_mutual_eviction` | (a) pair both resident, neither evicts the other (2 starts, 0 stops) |
| `test_exclusive_evicts_both_coexistence` | (b) exclusive request evicts BOTH coexistence backends |
| `test_concurrent_coexistence_requests_no_block_no_evict` | (c) concurrent requests to the two proceed, no eviction/mutual block |
| `test_glm_coldstart_does_not_block_resident_uzu` | (d) GLM cold start (gated health) does not block an already-resident Uzu |
| `test_start_failure_structured_and_no_counter_underflow` | (e) start/health failure → `BackendUnavailable` (503, not 500); resident Uzu untouched; counter not underflowed (finding iter4/1) |
| `test_coalesced_waiter_slow_coldstart_no_spurious_503` | (f) coalesced waiter on a slow-but-successful cold start does not spuriously 503 (finding iter4/2); exactly one start; both slots counted |
| `test_ollama_untracked_and_untouched` | (g) ollama backend never started/stopped/tracked; not evicted when exclusive requested |
| `test_drain_timeout_leaves_victim_running` | drain-before-evict blocks on in-flight gen, times out `ModelSwitchQueueTimeout`, victim left RESIDENT (aborted-drain recovery, hazard 7/finding 1) |
| `test_release_counter_floor` | release resets `generating`→0 and sets `drained` |
| `test_thundering_herd_single_start` | N concurrent cold acquires → exactly one `launchctl_start`, all share one record |
| `test_resolve_forward_alias_rules` | forwarding resolution: 0 residents→503, 1→use it, explicit model resolves, >1 bare→`ModelNotResolved` (400) |

## Finalized iteration-4 fixes applied

1. **Slot bound to acquire success, not handler `finally`.** `acquire`
   increments only on the success path; `proxy_request`'s `try/finally` owning
   `release` begins **after** `acquire` returns, so a raising `acquire` never
   reaches `release`. Verified by `test_start_failure_...` (Uzu counter stays
   0 after GLM start failure).
2. **Coalesced-waiter timeout = `LAUNCHCTL_START_TIMEOUT + startup_timeout`**,
   with `start_error`/`gone` as the authoritative give-up signals. Verified by
   `test_coalesced_waiter_slow_coldstart_no_spurious_503`.
3. **`/admin/select` is warm-up-only** — runs full `acquire` then immediately
   `release`s (RESIDENT, `generating == 0`, normal eviction applies, no pin).

## Not covered here (manual / e2e on the Mac, out of automated scope)

Real `launchctl kickstart`/`kill` timing, real `launchctl print` exit
confirmation, and real memory headroom (83 GiB pair fits / 90 GiB ds4 solo).
These depend on live launchd agents and are isolated behind the two mocked
seams; the logic above is fully unit-tested.
