# Verification — Process-global per-connection concurrency ceiling (#esnixi-5090)

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52`.

## What changed

- **New gate helper** `open-sse/services/combo/connectionConcurrencyGate.ts`
  - `connectionConcurrencyKey(connectionId)` → `conn:<connectionId>`.
  - `acquireConnectionConcurrencySlot(connectionId, cap, {queueTimeoutMs, maxQueueSize}, log)`:
    acquires one slot on the process-global `conn:<id>` semaphore
    (`rateLimitSemaphore.ts`). Fail-open at the exact edges of
    `acquireQuotaShareConcurrencySlot`: no connectionId / `cap === null` /
    `cap <= 0` → `null`; a saturated queue / timeout → warn + `null` (never
    reject a dispatchable request).
- **Wrap site** `open-sse/services/combo/executeTargetAttempt.ts`
  - Around the single upstream chokepoint
    `const result = await deps.handleSingleModelWithTimeout(...)`.
  - Acquire BEFORE the dispatch when `deps.strategy !== "quota-share"`, with the
    cap resolved via `lookupPositiveCap(target.connectionId)`,
    `queueTimeoutMs = deps.config.queueTimeoutMs ?? 120000`,
    `maxQueueSize = resolveComboQueueDepth(deps.config)`.
  - The whole post-dispatch body of the retry-loop iteration is wrapped in
    `try { … } finally { if (!slotHandedToStream) releaseConnectionSlot(); }`,
    so EVERY exit path (JSON success, error, retry `continue`, early `return`,
    throw) releases exactly once. `releaseConnectionSlot()` is idempotent
    (`slotReleased` guard, plus the semaphore's own release guard).
  - **Release-after-stream**: on a streaming success
    (`deps.clientRequestedStream` + readable `result.body`), the body is wrapped
    in a `ReadableStream` (mirrors `buildReplayResponse` in `validateQuality.ts`)
    whose `pull` close/error and `cancel` paths call `releaseConnectionSlot()`.
    Ownership is handed to the stream (`slotHandedToStream = true`) so the
    `finally` does not free the slot while the model is still generating.
    Non-streaming successes and all failure/skip paths release immediately.

## Reconciliation decision — exactly ONE global ceiling per connection, no double-acquire

- **Round-robin**: never reaches `executeTargetAttempt` (combo.ts early-returns
  into `handleRoundRobinCombo`); its semaphore key is `combo:<name>:<step>`, not
  connection-scoped. The new `conn:` gate never fires for it → no double-acquire,
  round-robin behavior untouched.
- **Quota-share**: DOES reach `executeTargetAttempt` but already holds its own
  per-connection slot keyed `qsconn:<connectionId>` around the whole
  cooldown-aware dispatch (`combo.ts`, `acquireQuotaShareConcurrencySlot`). To
  avoid a second ceiling on the same request (and a self-deadlock across its
  re-dispatch), the new gate is **skipped when `deps.strategy === "quota-share"`**.
  Quota-share keeps its proven single `qsconn:` gate.
- **Priority / weighted / fill-first / dispatchSequence / fallback**: had NO
  per-connection gate before; they now share the new `conn:<id>` ceiling. This is
  the lane the reported bug lives in (`hybrid/code` + `hybrid/research` both
  targeting the 5090 27B), so one semaphore here makes two different combos share
  one ceiling.
- **Documented caveat** (in the helper header): `qsconn:` and `conn:` are
  distinct keys, so a quota-share request and a priority-path request to the SAME
  physical connection count against two separate gates. Acceptable and out of
  scope — the reported bug is cross-combo among priority-path combos, which all
  use `conn:`. Unifying quota-share onto `conn:` is deliberately NOT done to
  avoid changing quota-share's proven behavior / other lanes.

## No behavior changes to routing values

Concurrency-ceiling plumbing only. No routing value, dispatchSequence order,
context window, cap, or timeout was changed. The cap is read from the connection
row's existing `max_concurrent`; the gate only paces dispatch and fails open.

## Commands run and results

Each command below was run from `/Users/celes/sources/celesrenata/OmniRoute`.
The full unit suite was NOT run (it pegs the CPU); only the touched/closest tests.

1. Gate unit test
   `node --import tsx/esm --import ./tests/_setup/isolateDataDir.ts --test tests/unit/combo/connection-concurrency-gate.test.ts`
   → **9 pass, 0 fail**.

2. Dispatch integration test
   `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test tests/unit/combo/connection-concurrency-dispatch.test.ts`
   → **5 pass, 0 fail**. Covers: cross-combo cap=2 never-3 (two combos share one
   `conn:` ceiling, third waits); fail-open with no cap; single-combo
   acquire+release once; streaming slot held until body fully consumed then
   freed; quota-share does not touch the `conn:` gate.

3. Closest existing suites (regression check)
   `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test tests/unit/combo/quota-share-concurrency.test.ts tests/unit/combo/execute-target-attempt.test.ts`
   → **23 pass, 0 fail**.

4. Typecheck
   `npm run typecheck:core`
   → **clean (exit 0)**.

5. Lint + suppressions on changed files
   `npx eslint --no-error-on-unmatched-pattern --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0 open-sse/services/combo/connectionConcurrencyGate.ts open-sse/services/combo/executeTargetAttempt.ts tests/unit/combo/connection-concurrency-gate.test.ts tests/unit/combo/connection-concurrency-dispatch.test.ts`
   → **0 errors, exit 0**. None of the touched files have entries in
   `config/quality/eslint-suppressions.json`, so no suppression count increased
   (there is nothing suppressed for these files; no new `no-explicit-any`).
