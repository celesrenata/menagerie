# HARD per-(connection, model) concurrency cap for local GPU targets

The process-global per-(connection, model) gate was fail-open on saturation: when a slot could not be acquired within the queue window, `acquireConnectionConcurrencySlot` logged "proceeding without a slot" and returned `null`, and the caller dispatched anyway. Under real upstream latency this let the 5090 27B (cap 2) reach 4 concurrent. This change splits the gate's "no cap" and "saturated" cases into a discriminated `ConnectionSlotResult` so the caller — not the gate — decides dispatch-vs-skip. Local GPU providers (`vllm`, `ollama-local`, `llama-cpp`, env-overridable) now treat `saturated` as a HARD cap and skip to the next ordered target; cloud/subscription providers keep the historical fail-open. The semaphore module and all other lane keying are untouched.

Watch for: nothing blocking. The timeout→skip path is driven by a real bounded wait in tests (confirmed), the semaphore ceiling is never exceeded at the timeout boundary (confirmed), cloud fail-open is preserved (confirmed), and no cap config values changed (confirmed).

**Verdict**: APPROVED

## High-level view

The gate boundary now carries three outcomes instead of a nullable release. `acquired` holds a slot (release-after-stream unchanged), `no-limit` means no cap applies (dispatch, unchanged), and `saturated` is a bare signal with no built-in policy. This is the minimal change that lets one code path serve both cloud fail-open and local hard-cap, and it keeps the semaphore module out of scope entirely.

The policy lives in the caller. `executeTargetAttempt` reads `target.provider` and, on `saturated`, consults `isHardConcurrencyProvider(provider)`. Hard providers log an at-capacity skip, record a `concurrency_cap_hard` decision, bump `fallbackCount` when the skip happens at a fallback index, and `return null` before `handleSingleModelWithTimeout` — the exact "advance to the next target" signal the persisted-retry skip already uses. Non-hard providers fall through to the pre-existing fail-open dispatch. This maps a saturated local target onto overflow (4070 Ti → GLM → tier-2) rather than over-subscribing the GPU, and an all-saturated chain onto the normal combo-exhausted outcome.

The hard set defaults to `vllm,ollama-local,llama-cpp` and is driven by `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` (comma-split, trimmed, lowercased, empties filtered, empty-override falls back to the default). The bounded queue wait (`queueTimeoutMs` / `maxQueueSize`) is preserved so brief bursts still queue rather than instantly overflowing. No cap config values changed; the `conn:`, `combo:`, and `qsconn:` keying and the quota-share early-skip are all untouched.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. All six required invariants were confirmed against the diff and tests.

</details>

<details>
<summary>Details</summary>

## Gate boundary: discriminated outcome, no policy

`acquireConnectionConcurrencySlot` now returns `{ outcome: "acquired"; release } | { outcome: "no-limit" } | { outcome: "saturated" }`. The missing-connection / missing-model / `cap === null` / `cap <= 0` branch returns `no-limit`; a successful `semaphore.acquire` returns `acquired` with the release; the `catch` (which fires on `SEMAPHORE_TIMEOUT` or `SEMAPHORE_QUEUE_FULL`) returns `saturated`. The old unconditional "proceeding without a slot" warning text was removed from the gate — the warning is now a neutral "gate saturated (cap=N)" and the dispatch-vs-skip decision moved to the caller. The semaphore module itself is unmodified, so the bounded-wait semantics (queue up to `queueTimeoutMs`, cap waiters at `maxQueueSize`) are identical to before; only the post-timeout interpretation changed. (confirmed)

## Caller policy: hard-cap skip vs cloud fail-open

In `executeTargetAttempt`, `provider` is `target.provider` (line 128), already available with no new plumbing. The acquire site branches: `acquired` → hold `slot.release`; `saturated && isHardConcurrencyProvider(provider)` → log the skip, `recordComboDecision(..., decision: "skipped_before_dispatch", reason: "concurrency_cap_hard")`, `if (i > 0) state.fallbackCount++`, and `return null` before `handleSingleModelWithTimeout`. Everything else (`no-limit`, or `saturated` on a non-hard provider) leaves `connectionConcurrencyRelease = null` and proceeds to dispatch — the historical fail-open. The `return null` is the same signal the persisted-retry skip uses, so the outer loop advances to the next ordered target and runs its fallback accounting. This is the overflow path: a saturated 5090 27B falls through to 4070 Ti → GLM → tier-2 instead of dispatching anyway. (confirmed)

The `deps.strategy !== "quota-share"` guard around the whole gate is unchanged, so quota-share still early-skips this gate and holds only its own `qsconn:` ceiling — no self-deadlock, no second ceiling. (confirmed)

## Hard-provider policy and env override

`isHardConcurrencyProvider` resolves the set per call from `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` via `resolveHardConcurrencyProviders()`: split on `,`, trim + lowercase + filter empties, fall back to `["vllm","ollama-local","llama-cpp"]` when unset or empty. The check lowercases/trims the incoming provider, so it is case- and whitespace-tolerant, and returns `false` for null/undefined/empty. The default set matches the live local connection providers in the dispatch tests. Cloud providers (`openrouter`, `zai`, `bedrock`) are correctly excluded by default. (confirmed)

## Decision trace reconciliation

`concurrency_cap_hard` was added to `COMBO_SKIP_REASONS`, distinct from the pre-dispatch soft `concurrency_cap`. Since `recordComboDecision` validates `reason` against this allowlist and throws otherwise, the new reason had to be registered or the hard-cap skip would have crashed on its own trace call — the addition is necessary and the two skip kinds remain distinguishable in traces. (confirmed)

## Test coverage

The dispatch suite proves the semaphore never exceeds the cap at the timeout boundary: with a `vllm` cap-2 connection, two holders block inside `handleSingleModel`, and a 3rd dispatch (short `queueTimeoutMs: 50`, non-zero queue so it genuinely waits then times out rather than failing fast on queue-full) returns `null`, `getStats()[key].running` stays at 2, `maxConcurrentHandle <= 2`, and `handleCalls === 2` — the over-cap request never reached the saturated model. A fallback-index variant (saturated target at index 1) asserts `fallbackCount` bumps to 1. The cloud case (`openrouter` cap 2) fires a 3rd dispatch past the timeout window and asserts `handleCalls === 3`, proving fail-open is intact. The all-saturated case (single `vllm` cap-1 target, no overflow target) returns `null` with `handleCalls === 1` and the cap never exceeded, which the outer loop surfaces as the normal combo-exhausted retryable outcome — no crash, no silent drop. (confirmed)

The gate suite pins the `ConnectionSlotResult` shape across every branch (`no-limit` for missing conn/model/cap<=0, `acquired` with a callable release, `saturated` on queue-full), adds a deterministic timeout→`saturated` test that asserts the bounded wait actually elapsed (`elapsed >= 35` against a 40ms `queueTimeoutMs`), and covers `isHardConcurrencyProvider` for defaults, cloud exclusion, case/space tolerance, env override, and empty-override fallback. The existing cap-2 serialization (two combos share one ceiling), per-connection/per-model independence, and release-after-stream behaviors were retained, adjusted only for the new outcome shape. (confirmed)

Not tested at this layer: real upstream-latency integration (the live-verify scenario that originally exposed the 4-concurrent bug) — but that is an extension-host/live concern, and the unit-level timeout→skip test deterministically represents the failure mode, which is the correct layer per the test-placement guidance. (possible, informational)

## Config and other lanes untouched

The commit touches exactly five files (the three source files plus the two test files). No cap numbers changed: reader 9B stays 4, 4070 Ti 27B stays 1 and 9B stays 4, 5090 27B stays 2. The `+` lines mentioning caps are either doc comments, the `cap <= 0` guard, or test constants — no config value edits. Release-after-stream, `conn:<id>:<model>` keying, round-robin (`combo:<name>:<step>`, which never reaches this attempt), and quota-share (`qsconn:<id>`) are all untouched. (confirmed)

## Verification evidence

The coder recorded all commands run once each: touched combo tests (27/27 pass), full combo suite (390/390 pass, 40 files), `npm run typecheck:core` (exit 0 clean), and eslint on the five changed files with `config/quality/eslint-suppressions.json` (exit 0, no new suppressions, no `as any`). The evidence is specific and self-consistent with the diff; no articulable doubt remained that would justify re-running a suite, so no spot-check was needed beyond reading the code and tests.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo/connectionConcurrencyGate.ts` — `ConnectionSlotResult` discriminated return; `isHardConcurrencyProvider` + `resolveHardConcurrencyProviders` env policy; neutral saturated log.
- `open-sse/services/combo/executeTargetAttempt.ts` — consume the new outcome; hard-cap `saturated` → log + `concurrency_cap_hard` trace + conditional `fallbackCount` + `return null` (skip); non-hard → fail-open dispatch; quota-share guard unchanged.
- `open-sse/services/combo/decisionTrace.ts` — add `concurrency_cap_hard` to `COMBO_SKIP_REASONS`.
- `tests/unit/combo/connection-concurrency-dispatch.test.ts` — hard cap-2 timeout→skip (semaphore ≤2), fallback-index bump, cloud fail-open, all-saturated → null.
- `tests/unit/combo/connection-concurrency-gate.test.ts` — outcome-shape assertions, deterministic timeout→saturated, `isHardConcurrencyProvider` policy tests.

Full diff: `git show 42f062246` on `release/v3.8.52` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>
