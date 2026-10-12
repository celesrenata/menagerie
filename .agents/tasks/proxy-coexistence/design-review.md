# Design Review: local-model-proxy coexistence rework (GLM-5.3 + Uzu resident concurrently)

Reviewed document: `.agents/tasks/proxy-coexistence/design.md`
Target source verified: `/Users/celes/sources/m5max-darwin-flake/.worktrees/proxy-coexistence/packages/local-model-proxy/model_proxy.py` (21317 bytes — matches design claim exactly), `models.json`, `models.json.new`.

This is a fresh, standalone review. I read the actual target source to verify the design's claims rather than taking its word. The design is unusually thorough on its central concern — lock discipline around await points — and the core anti-serialization architecture is sound. I found two blocking issues (one HIGH, one MEDIUM) that live in the handler/`release` contract and the coalesced-waiter timeout bound, plus several NITs. The verdict is CHANGES_REQUESTED.

---

## Verified Assumptions

Each of these design claims was checked against the on-disk source and holds:

- **The brief's "CURRENT behavior" machinery does not exist on disk.** Grep for `acquire_backend|reconcile_launchctl|launchctl_is_running|QUEUE_TIMEOUT` against `model_proxy.py` returns zero matches. The design's reconciliation section is accurate; it correctly rebuilds the drain machinery rather than editing a nonexistent one.
- **`_gen_event` is dead code.** Source lines 66–67 create it and `.set()` it once in `ProxyState.__init__`; it is never awaited, cleared, or read elsewhere. The design's claim to drop it is correct.
- **`activate_backend` evicts with no drain today.** Source (`activate_backend`) does `if state.active_backend: await deactivate_backend(state.active_backend)` with no in-flight check. The design's claim that drain-before-stop is net-new (not pre-existing) is correct.
- **`deactivate_backend` only logs on failed stop today.** Source wraps the stop in `try/except Exception as e: log.warning(...)` and never re-raises. The design's claim to change this to re-raise for launchctl is a real behavior change, correctly identified.
- **Error mapping today.** Source: `aiohttp.ClientError → 502`; the `async with state._lock: await activate_backend(alias)` block sits BEFORE each handler's `try`, so a `health_wait`/`launchctl` `RuntimeError` escapes as an unstructured 500; `asyncio.TimeoutError` is caught nowhere. All three claims verified.
- **`upstream_model` is documentation-only.** Grep for `upstream_model` in `model_proxy.py` returns zero matches. The proxy forwards `body_bytes` verbatim (handler lines 299/363/424/485 build `upstream_url` from `base_url`; the body is passed as `data=body_bytes`). The design's claim that it adds no model rewriting is correct.
- **`qwen38-uzu` is absent from `models.json`.** Confirmed: current config has `qwen38-mlx` (:8070), `glm53` (:8082), `deepseek-v41-uncensored` (:8084), `qwen35-reader-262k` (ollama). The design's new entry is additive.
- **`service` is stored as a complete `$UID`-expanded domain-target.** `load_config()` (source) replaces `$UID` in place; `models.json` carries `gui/$UID/com.celes.<name>`. The design's "do not double-prefix `gui/$UID/`" warning for `launchctl print` is correct and well-founded.
- **`startup_timeout: 300` on `qwen38-mlx` is silently ignored today.** Source `activate_backend` calls `health_wait(entry["health_url"])` with no `timeout` kwarg, so `health_wait`'s hardcoded `timeout: float = 60.0` default applies. The design's finding-4 claim is verified against source.
- **`qwen3.8-27b-uzu` appears in the proposed Uzu `model_names`.** Confirmed in the design's JSON block, so `backend_for_model` resolution will work.
- **Four near-duplicate POST handlers + a catchall.** Source confirms `handle_chat_completions`, `handle_responses`, `handle_messages`, `handle_completions` are near-identical, and `handle_v1_catchall` uses `state.active_backend` with an unguarded `state.backends[state.active_backend]` index. The design's refactor-to-one-helper motivation is justified.
- **ollama uses `ollama_url`/`ollama_model`, not `base_url`, in the lifecycle calls.** Source `activate_backend`/`deactivate_backend` call `ollama_load_model(entry["ollama_url"], entry["ollama_model"])`. (See NIT 4 — the design's Class 1 prose says ollama forwards to `base_url`, which is true for *request forwarding* but the lifecycle load/unload uses `ollama_url`; harmless since Class 1 does no lifecycle management, but the field names should be stated precisely.)

## Unverified / Wrong Assumptions

- **`models.json.new` exists in the worktree and is NOT addressed by the design.** It defines different aliases (`ds4` :8080, `evocua` ollama) than `models.json`. The design states `models.json` is the config target and never mentions `.new`. This is almost certainly a stale scratch file, but the design should explicitly note it is out of scope so the implementer does not edit the wrong file or get confused about which is deployed. (See NIT 5.)
- **The claim that `launchctl print` on a non-running on-demand (`KeepAlive=false`) agent returns a "Could not find service" non-zero result** is a runtime behavior of `launchctl` that I could not verify from the repo (no launchd fixtures/tests exist). The design itself flags this as manual/e2e-only, which is the right disposition, but the exact stderr string and exit semantics are an unverified OS assumption that the confirmed-exit parse depends on. Not a blocking finding because the design already routes "argument-format/usage error → unconfirmed → keep polling" defensively; still, the implementer must validate the real `launchctl print` output format on the Mac before trusting the parse.

---

## Findings

### 1. HIGH — `release(alias)` in `finally` will underflow the counter when `acquire` raises

Location: "The acquire/evict state machine" intro ("Handlers then forward and, in `finally`, call `release(alias)`") and Hazard 7 ("the single shared `proxy_request` helper guarantees a matching `release(alias)` in `finally` on every exit path (success, 502, 503, 400, cancellation)").

Problem: `acquire` increments `record.generating` **only on success** (fast path, cold-start-success commit, coalesced-waiter commit). On failure it raises `BackendUnavailable` or `ModelSwitchQueueTimeout` **without** having incremented. But the stated contract calls `release(alias)` in `finally` on **every** exit path including 503 — and the design explicitly lists "503" among the paths that run `release`. A 503 raised by `acquire` means no increment happened, so the unconditional `release` decrements a counter that was never incremented. For a coexistence backend that is `RESIDENT` with `generating == 0`, this drives `generating` to `-1`, which permanently breaks the drain predicate: `release`'s "`if generating reaches 0: drained.set()`" never fires again at the right time, and `drained.wait()` logic (which assumes `generating >= 0` and `== 0` means idle) is corrupted. This is the exact mirror of the leak the design works hard to prevent, and it is introduced by the very contract meant to prevent the leak.

Worse, the 503 case is the dangerous one: a `ModelSwitchQueueTimeout` during an eviction of backend A can cause a spurious `release("A")` even though this request never counted a slot on A, decrementing A's live counter while A is still serving real in-flight work — potentially letting a later evictor see a premature `drained`.

Concrete fix: specify that the slot bookkeeping is bound to acquire **success**, not to the handler's `finally`. Two acceptable mechanisms, pick one and write it into the design:

- (preferred) `acquire` returns the `record` (or sentinel) only on success with the slot already counted; the handler binds release to that return value, not to the alias string:

  ```python
  record = await state.acquire(alias)   # raises on failure -> no release owed
  try:
      ... forward ...
  finally:
      state.release(record)             # no-op for sentinel; decrements only a counted slot
  ```

  i.e. the `try/finally` that owns `release` must start **after** `acquire` returns, so a raising `acquire` never reaches the `finally`. Update Hazard 7 to drop "503" from the "every exit path" list, or qualify it as "every exit path *after a successful acquire*."

- (alternative) make `release` idempotent/guarded so a release without a prior counted increment is a no-op, by having `acquire` hand back an explicit "slot token" that `release` consumes exactly once. This is more machinery than needed; the first option is cleaner.

Either way, the design must state unambiguously: **a `finally: release` must not run when `acquire` raised.** As written, it says the opposite.

### 2. MEDIUM — Coalesced waiter's `ready.wait()` timeout is shorter than the starter's worst-case cold start, causing spurious 503s under load

Location: Class 2 STARTING branch ("`await asyncio.wait_for(rec.ready.wait(), timeout=startup_timeout)`") and Class 3's inherited copy; finding-7 response ("both share one bound").

Problem: the design asserts the coalesced waiter and the in-flight starter "share one bound and neither times out early or late relative to the actual cold start." That is not true as specified. The starter's total wall time is `launchctl_start` (bounded by its own `timeout=15.0` on the kickstart subprocess) **plus** `health_wait(..., timeout=startup_timeout)` — i.e. up to `15 + startup_timeout` seconds before `ready.set()` fires. The waiter parks with `timeout=startup_timeout` measured from when **it** starts waiting, which (for a herd arriving at cold-start time) is at best the same instant the starter began. So the waiter's deadline can elapse up to ~15s *before* the starter completes a legitimately slow-but-successful cold start, raising `BackendUnavailable` (503) on a request whose backend is seconds away from `RESIDENT`. For GLM with `startup_timeout: 600` the window is small relative to the whole, but it is a real, order-dependent false negative, and it is exactly the finding-4 regression class ("503 on a normal heavy cold start") reappearing for coalesced waiters specifically.

Concrete fix: give the waiter headroom over the starter, or make the bound explicitly the starter's whole budget. Simplest: `waiter_timeout = launchctl_start_timeout + startup_timeout` (e.g. a module constant `LAUNCHCTL_START_TIMEOUT = 15.0` reused as the kickstart bound and added here), or set the waiter bound to `startup_timeout` **but** have the starter's failure path (which already sets `ready` + `start_error` on failure) be the authoritative "give up" signal so the waiter never needs to out-wait the starter — i.e. make the waiter bound generously larger than the starter's total and rely on `start_error`/`gone` for correctness rather than on the timeout racing the starter. State the chosen number and where it is defined.

### 3. MEDIUM — `/admin/select` holding then immediately releasing a slot can defeat its own eviction and leaves a race window

Location: Admin paths — "`/admin/select`: calls `acquire(alias)` ... and immediately `release(alias)` so it does not hold a slot."

Problem: `acquire` increments the slot, and the design's own drain logic treats a `RESIDENT` record with `generating > 0` as un-evictable until drained. `/admin/select` does `acquire` (count=1) then `release` (count=0). Between those two synchronous-looking calls there is no await the design pins down, but `release` is specified to run under `_lock` separately from `acquire`'s final commit — so there IS a scheduling point between them. That is benign for `select` itself. The real ambiguity is the **purpose contract**: `/admin/select` is meant to *make a backend resident* (a durable intent), but by releasing its slot immediately it creates a backend that is `RESIDENT` with `generating == 0`, i.e. immediately eligible for eviction by the very next request for a different exclusive backend. The design does not say whether `/admin/select` is "pin until replaced" or "warm up then release." Given the user's stated intent ("glm and uzu are default", "evict both"), an admin `select` that can be evicted a millisecond later by an unrelated request is probably not what is wanted, and the design never resolves it.

Concrete fix: specify the intended semantics explicitly. Either (a) document that `/admin/select` is a *warm-up only* (returns the resident set after ensuring the alias started; no pinning — eviction rules then apply normally), which is defensible and matches "fresh start on next request"; or (b) if select is meant to pin, add an explicit pin mechanism (not a counter slot) and state how it is cleared. Pick one and write it down; today the behavior is undefined.

### 4. NIT — Class 1 prose conflates `base_url` with the ollama lifecycle fields

Location: "Class 1 — ollama / non-launchctl ... The handler forwards to the ollama `base_url` as today."

The request *forwarding* path does use `base_url` (correct). But the design elsewhere describes ollama activation as "`ollama_load_model` + `health_wait`," and the source `ollama_load_model`/`ollama_unload_model` are called with `entry["ollama_url"]` + `entry["ollama_model"]`, not `base_url`. Since Class 1 removes ollama from residency management entirely (no activation), this is harmless, but the prose should state precisely that Class 1 does **no** load/unload (so `ollama_url`/`ollama_model`/`keep_alive` lifecycle is dropped for the untracked path) and only forwards to `base_url`. As written it is easy to misread as "still call `ollama_load_model`."

Concrete fix: change to "The handler forwards the request to the ollama `base_url` as today; Class 1 performs **no** `ollama_load_model`/`ollama_unload_model` and no `health_wait` — ollama residency is entirely untracked."

### 5. NIT — `models.json.new` scratch file is unaddressed

Location: "Files to modify."

A sibling `models.json.new` exists in the worktree with entirely different aliases (`ds4` :8080, `evocua`). The design never mentions it. An implementer could edit or deploy the wrong file.

Concrete fix: add one line to "Files to modify": "`models.json.new` in the same directory is a stale scratch file (different aliases, not the deploy target) and must be left untouched / may be deleted separately; this change edits only `models.json`."

### 6. NIT — `handle_models` "active" semantics change is a client-visible contract change not called out as such

Location: Admin paths — "`/v1/models` ... the per-alias `active` flag becomes '`alias in resident and resident[alias].state == RESIDENT`'."

Today exactly one alias (and its `model_names`) reports `active: true`. After the change, two can be `active: true` simultaneously (GLM + Uzu). Any downstream consumer that assumes "exactly one active model" (e.g. OmniRoute route selection, a UI that picks the single active) will see two. The design treats this as a mechanical flag change but does not flag the semantic shift for consumers.

Concrete fix: note explicitly that `/v1/models` can now report multiple `active: true` entries and confirm no consumer relies on single-active (or scope that verification to the integration layer). This is a NIT only because it is likely benign, but it should be stated.

---

## Focus-area assessment (per the review brief)

- **(a) GLM cold start must not block a resident Uzu (and vice versa):** SATISFIED. Verified against the lock-hold boundaries: lock acquisition #1 flips the record to `STARTING` in microseconds and releases; `health_wait` runs lock-free; a concurrent Uzu request takes the step-1 fast path, increments its own per-alias counter, forwards. Per-alias counters/events are the correct decoupling. No finding here.
- **(b) evict-both-on-exclusive-request, drain-before-stop, ds4 confirm-exited:** MOSTLY SATISFIED. The drain-before-stop sequencing, the single-chokepoint stop via `drain_and_stop`, the step-0 idempotency guard, and the confirmed-exit poll (with the double-prefix warning and three-way parse) are all well specified. The confirmed-exit parse rests on an unverified `launchctl print` OS behavior (see Unverified Assumptions) but is defensively coded. No blocking finding.
- **(c) concurrent same-backend vs different-backend paths:** SATISFIED for different-backend; same-backend coalescing is correct in structure but has the timeout-bound defect in Finding 2.
- **(d) structured-fail-up 503 + Retry-After without tearing down a healthy OTHER backend:** SATISFIED on the "don't tear down other" guarantee (cold-start failure path explicitly never touches another record; Hazard 6/start-failure-isolation verified). But the error-return bookkeeping has the counter-underflow defect in Finding 1, which is in this same path (a 503 from `acquire` + blanket `finally: release`).
- **(e) ollama/non-launchctl excluded from residency:** SATISFIED. Class 1 removes them from `resident` entirely; the behavior change (possible ollama+pair co-residency) is explicitly documented and consciously scoped to the operator. Finding 4 is only a prose-precision NIT.

No ambiguity remains about WHEN `_lock` is held vs released around awaits — that contract is explicit and correct. The blocking issues are in the slot-release contract (Finding 1) and the coalesced-waiter timeout bound (Finding 2), not in the lock discipline itself.

---

## Verdict

HIGH findings: 1 (Finding 1).
MEDIUM findings: 2 (Findings 2, 3).
NIT findings: 3 (Findings 4, 5, 6).

HIGH + MEDIUM = 3 > 0 → **CHANGES_REQUESTED**.
