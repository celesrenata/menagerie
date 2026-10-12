# Implementation Plan — HARD per-(connection, model) concurrency cap for local GPU targets

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52` (confirm with `git branch --show-current`). No worktree, no branch switch, no push. Do NOT create `.changeset` files and do NOT edit `CHANGELOG.md`.

## Problem (verified against source at commit 7952001 + live-verify.md)

The process-global per-(connection, model) gate (`open-sse/services/combo/connectionConcurrencyGate.ts`) is **fail-open on saturation**. `acquireConnectionConcurrencySlot` wraps `semaphore.acquire(...)` and, on a `SEMAPHORE_TIMEOUT` (queue wait exceeded `queueTimeoutMs`, default 120000) or `SEMAPHORE_QUEUE_FULL` (`maxQueueSize` reached), catches the error, logs `… gate saturated (cap=N) — proceeding without a slot`, and returns `null`. In `executeTargetAttempt.ts` a `null` release means "no slot held" but the code **dispatches anyway**. Under real upstream latency this let the 5090 27B (`vllm/qwen3.8-27b-nvfp4`, conn `e9bd13fb`, cap 2) reach 4 concurrent (live-verify.md Evidence, 19:57:21 fail-open lines).

## Design decisions (grounded in the code read)

1. **Reuse the existing "skip to next target" outcome, do NOT invent a new one.** In `executeTargetAttempt.ts` a plain `return null` (e.g. line 246 persisted-retry skip, line 1361 loop fall-through) is exactly how an attempt signals "this target produced nothing — advance to the next ordered target"; the outer loop then runs its `bumpFallback`/advance logic. The hard-cap timeout path will `return null` **before** calling `handleSingleModelWithTimeout`, mirroring the pre-dispatch "Skipping … is at max concurrency cap" skip in `executeTargetGates.ts`. This makes the request fall through to the next `dispatchSequence`/priority target (4070 Ti → GLM → tier-2) with no dispatch and no hard-fail.

2. **Distinguish "saturated" from "no limit" at the gate boundary.** Today `acquireConnectionConcurrencySlot` returns `null` for BOTH "no cap applies" (fail-open, correct to dispatch) and "saturated" (currently fail-open, must become skip for hard providers). A single `null` cannot carry that distinction. Change the function to return a small discriminated result: `{ outcome: "acquired"; release } | { outcome: "no-limit" } | { outcome: "saturated" }`. The caller dispatches on `acquired`/`no-limit` and skips on `saturated` **only when the target is a hard-cap provider**; for non-hard providers `saturated` is treated exactly like today (dispatch anyway → fail-open preserved). This is the minimal change that keeps cloud fail-open and local hard-cap in one code path. The semaphore module itself is UNTOUCHED (it already rejects on timeout/queue-full with distinct codes).

3. **`hardConcurrency` is derived from provider, env-configurable.** Add a helper `isHardConcurrencyProvider(provider)` resolving the set from `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` (comma-separated), defaulting to `vllm,ollama-local,llama-cpp`. Parsed per call (cheap; env is read elsewhere inline in this codebase, e.g. `OMNIROUTE_QUOTA_AWARE_ROUTING` in `executeTargetGates.ts`) with trim + lowercase + empty-filter. This keeps it tunable without redeploy and defaults ON for the local single-GPU backends where over-subscription causes OOM/thrash.

4. **Keep the bounded wait.** The `queueTimeoutMs` wait and `maxQueueSize` are preserved — brief bursts still queue and wait rather than instantly overflowing. Only the *post-timeout / queue-full* behavior changes (skip instead of dispatch) and only for hard providers.

5. **Leave untouched:** release-after-stream wrapper, the `conn:<connectionId>:<model>` keying, round-robin (`combo:<name>:<step>` — never reaches `executeTargetAttempt`), and quota-share (`qsconn:<id>` — already `strategy === "quota-share"` early-skips this gate). No config values that affect other lanes change: reader 9B cap stays 4, 4070 Ti 27B cap stays 1, 5090 27B cap stays 2. Only the fail-open-on-saturation branch for local providers changes.

6. **Suppressions file is `config/quality/eslint-suppressions.json`** in THIS repo (per OmniRoute `AGENTS.md` line 296), not `src/eslint-suppressions.json`. New code must introduce no `any` in `open-sse/` and no new suppressions.

---

## Steps

- [ ] 1. Add the hard-cap provider policy helper and env resolution.
      Add `isHardConcurrencyProvider(provider: string | null | undefined): boolean` and a module-private `resolveHardConcurrencyProviders()` that reads `process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS`, splits on `,`, trims/lowercases/filters empties, and falls back to `["vllm","ollama-local","llama-cpp"]` when unset or empty. Place in `open-sse/services/combo/connectionConcurrencyGate.ts` (same module as the gate, so caller imports one place). Export `isHardConcurrencyProvider`.
      Files: `open-sse/services/combo/connectionConcurrencyGate.ts`
      Verify: `npm run typecheck:core` is clean (new exported fn compiles). Covered by tests in step 4.

- [ ] 2. Change `acquireConnectionConcurrencySlot` to return a discriminated outcome instead of `release | null`.
      New return type `ConnectionSlotResult = { outcome: "acquired"; release: () => void } | { outcome: "no-limit" } | { outcome: "saturated" }`. Map: missing connection/model or `cap === null`/`cap <= 0` → `{ outcome: "no-limit" }`; successful `semaphore.acquire` → `{ outcome: "acquired", release }`; caught `SEMAPHORE_TIMEOUT`/`SEMAPHORE_QUEUE_FULL` (or any throw) → `{ outcome: "saturated" }`. Keep the existing saturated `log.warn` message text but let the CALLER decide dispatch vs skip (do not log "proceeding without a slot" unconditionally — move the fail-open vs skip wording to the caller, or make the log reflect the decision). Export the `ConnectionSlotResult` type.
      Files: `open-sse/services/combo/connectionConcurrencyGate.ts`
      Verify: `npm run typecheck:core` clean. Full behavior asserted in step 4/5 tests.

- [ ] 3. Update `executeTargetAttempt.ts` to consume the new outcome and HARD-skip saturated local targets.
      At the gate acquire site (currently `connectionConcurrencyRelease = await acquireConnectionConcurrencySlot(...)`, ~line 436): branch on the result. `acquired` → set `connectionConcurrencyRelease = result.release` (release-after-stream path unchanged). `no-limit` → `connectionConcurrencyRelease = null`, dispatch (unchanged fail-open). `saturated` → if `isHardConcurrencyProvider(provider)` is true: log an info line mirroring the existing `Skipping ${modelStr} — connection … is at max concurrency cap`, record a `recordComboDecision(... decision: "skipped_before_dispatch", reason: "concurrency_cap_hard")`, do `if (i > 0) state.fallbackCount++`, and `return null` BEFORE `handleSingleModelWithTimeout` so the outer loop advances to the next target; else (non-hard/cloud) keep today's behavior: `connectionConcurrencyRelease = null` and dispatch anyway (fail-open). Keep `strategy === "quota-share"` early-skip of the whole gate exactly as-is. Ensure no floating promise and no `any`.
      Files: `open-sse/services/combo/executeTargetAttempt.ts`
      Verify: `npm run typecheck:core` clean; dispatch tests in step 5 pass.

- [ ] 4. Extend the gate unit tests for the new outcome shape and the provider-policy helper.
      In `tests/unit/combo/connection-concurrency-gate.test.ts`: update existing assertions that expect `release | null` to the new `ConnectionSlotResult` (`outcome` discriminator) — `no-limit` for missing conn/model/cap<=0, `acquired` with a callable `release`, and `saturated` on queue-full/timeout (set `maxQueueSize: 0` to force saturation, and a short `queueTimeoutMs` to prove the bounded wait still elapses before `saturated`). Add tests for `isHardConcurrencyProvider`: true for `vllm`/`ollama-local`/`llama-cpp` by default, false for a cloud provider (e.g. `openrouter`), and that `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` override is honored (set/restore `process.env` within the test).
      Files: `tests/unit/combo/connection-concurrency-gate.test.ts`
      Verify: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo/connection-concurrency-gate.test.ts` — all tests pass.

- [ ] 5. Extend the dispatch integration tests for HARD skip-to-next-target and preserved fail-open.
      In `tests/unit/combo/connection-concurrency-dispatch.test.ts`: add a test seeding a `vllm` connection cap 2, with `queueTimeoutMs` short and `maxQueueSize: 0`, firing 3 simultaneous dispatches where 2 hold the gate (blocked `handleSingleModel`) and the 3rd must be SKIPPED — assert `semaphore.getStats()[key].running` never exceeds 2 (poll at timeout), assert the 3rd attempt dispatches to a NEXT target (give the state ≥2 ordered targets so the 3rd falls through; assert the next target's `handleSingleModel` is invoked / 3rd `executeTargetAttempt` returns via next-target, NOT a dispatch to the saturated model). Add a non-hard (cloud, e.g. `openrouter`/`zai`) cap-2 case proving the 3rd still fails open and dispatches on saturation. Add an all-saturated case: single hard target, cap filled, saturated 3rd → `return null` (no dispatch, no crash) so the outer combo surfaces the normal combo-exhausted retryable error. Keep the existing cap-2-share, per-model-split (9B cap 4 / 4070 Ti 27B cap 1 simultaneous), streaming release-after-stream, single-combo, and quota-share tests passing unchanged (adjust only for the new outcome shape where they inspect the gate return).
      Files: `tests/unit/combo/connection-concurrency-dispatch.test.ts`
      Verify: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo/connection-concurrency-dispatch.test.ts` — all tests pass (release-after-stream and quota-share included).

- [ ] 6. Run the full combo suite, typecheck, and lint; record evidence.
      Run the two touched test files once (step 4 & 5 commands), then the full combo suite once, then `npm run typecheck:core`, then eslint on changed files. Confirm `config/quality/eslint-suppressions.json` counts do NOT increase (no new suppressions; no `any` in `open-sse/`). Record exact commands and results in `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/omniroute-hard-conn-cap/verification.md`.
      Files: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/omniroute-hard-conn-cap/verification.md`
      Verify (exact commands):
      - Touched tests: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo/connection-concurrency-gate.test.ts tests/unit/combo/connection-concurrency-dispatch.test.ts`
      - Full combo suite: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=4 "tests/unit/combo/**/*.test.ts"`
      - Typecheck: `npm run typecheck:core`
      - Lint changed files: `npx eslint --cache --cache-location .eslintcache --suppressions-location config/quality/eslint-suppressions.json open-sse/services/combo/connectionConcurrencyGate.ts open-sse/services/combo/executeTargetAttempt.ts tests/unit/combo/connection-concurrency-gate.test.ts tests/unit/combo/connection-concurrency-dispatch.test.ts`
      Expected outcome: all tests pass, typecheck clean, eslint clean with no new suppressions.

## Notes / assumptions

- The semaphore module (`rateLimitSemaphore.ts`) is intentionally NOT modified: it already surfaces `SEMAPHORE_TIMEOUT` and `SEMAPHORE_QUEUE_FULL` distinctly, and the bounded-wait semantics (queue up to `queueTimeoutMs`, cap waiters at `maxQueueSize`) are exactly what the design wants to keep.
- `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` default `vllm,ollama-local,llama-cpp` matches the live connection providers in the dispatch tests (`vllm`, `ollama-local`).
- `provider` is already available on the target in `executeTargetAttempt` (`target.provider`), so no new plumbing through `AttemptLoopDeps` is required for the policy check.
- Pre-dispatch gate `executeTargetGates.ts` already has a soft "Skipping … is at max concurrency cap" using `isAccountSemaphoreFull`; the new hard-timeout skip is the in-dispatch counterpart (a slot could not be acquired within the queue window) and uses a distinct trace reason (`concurrency_cap_hard`) so the two are reconciled and distinguishable in decision traces.
