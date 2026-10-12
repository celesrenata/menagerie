# Verification — HARD per-(connection, model) concurrency cap for local GPU targets

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52` (confirmed via `git branch --show-current` → `release/v3.8.52`). First iteration (no `review.json` present).

## What changed (code-only behavior change on the fail-open-on-saturation branch for local providers)

1. `open-sse/services/combo/connectionConcurrencyGate.ts`
   - `acquireConnectionConcurrencySlot` now returns a discriminated `ConnectionSlotResult`:
     `{ outcome: "acquired"; release } | { outcome: "no-limit" } | { outcome: "saturated" }`
     instead of `release | null`. The gate no longer decides dispatch-vs-skip; the CALLER does.
   - Added `isHardConcurrencyProvider(provider)` + module-private `resolveHardConcurrencyProviders()`
     reading `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` (comma-separated, trim/lowercase/filter-empty),
     defaulting to `vllm,ollama-local,llama-cpp`.
   - Bounded wait preserved: still queues up to `queueTimeoutMs` / `maxQueueSize` before `saturated`.
   - Semaphore module (`rateLimitSemaphore.ts`) UNTOUCHED.

2. `open-sse/services/combo/executeTargetAttempt.ts`
   - Consumes the new outcome. `acquired` → hold release (release-after-stream unchanged).
     `no-limit` → dispatch with no slot (unchanged). `saturated` + `isHardConcurrencyProvider(provider)`
     → log an at-capacity skip, `recordComboDecision(... skipped_before_dispatch, reason: concurrency_cap_hard)`,
     `if (i > 0) state.fallbackCount++`, and `return null` BEFORE `handleSingleModelWithTimeout` — the same
     "skip to next target" signal used by the persisted-retry skip. `saturated` on a non-hard (cloud) provider
     → unchanged FAIL-OPEN (dispatch anyway). `quota-share` early-skip of the whole gate unchanged.

3. `open-sse/services/combo/decisionTrace.ts`
   - Added `concurrency_cap_hard` to `COMBO_SKIP_REASONS` so the in-dispatch hard-cap skip is
     distinguishable from the pre-dispatch `concurrency_cap` soft skip in decision traces.
     (`recordComboDecision` validates `reason` against this allowlist and throws otherwise.)

4. Tests:
   - `tests/unit/combo/connection-concurrency-gate.test.ts` — updated to the `ConnectionSlotResult`
     shape; added a deterministic timeout→`saturated` test (held slot, short `queueTimeoutMs`, non-zero
     queue, asserts the bounded wait elapses) and `isHardConcurrencyProvider` policy tests (defaults,
     cloud, env override).
   - `tests/unit/combo/connection-concurrency-dispatch.test.ts` — added: HARD cap cap=2 with 3 dispatches
     where the 3rd TIMES OUT and SKIPS to the next target (semaphore never exceeds 2 even at timeout,
     `handleSingleModel` called exactly twice, 3rd returns null); HARD skip at i>0 bumps `fallbackCount`;
     cloud provider still FAILS OPEN and dispatches the 3rd on saturation; all-saturated single hard
     target → skip (null), no dispatch, no crash. Existing per-model split (9B cap 4 / 4070 Ti 27B cap 1),
     release-after-stream, single-combo, and quota-share tests retained and passing.

No config values changed: reader 9B cap stays 4, 4070 Ti 27B cap stays 1 and 9B stays 4, 5090 27B cap stays 2.

## Commands run (each ONCE) + results

### 1. Touched combo tests
```
cd /Users/celes/sources/celesrenata/OmniRoute
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit \
  tests/unit/combo/connection-concurrency-gate.test.ts \
  tests/unit/combo/connection-concurrency-dispatch.test.ts
```
Result: **27 tests, 27 pass, 0 fail** (duration ~1.77s). Includes the HARD-cap skip, timeout→skip,
cloud fail-open, all-saturated, per-model split, release-after-stream, and quota-share cases.
(`cross-env` is not on PATH as a bare command in this shell; inlining `DISABLE_SQLITE_AUTO_BACKUP=true`
is equivalent to the plan's `cross-env DISABLE_SQLITE_AUTO_BACKUP=true` prefix.)

### 2. Full combo suite
```
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit --test-concurrency=4 "tests/unit/combo/**/*.test.ts"
```
Result: **390 tests, 390 pass, 0 fail** (40 test files, duration ~7.4s). No regressions.

### 3. Typecheck
```
npm run typecheck:core   # tsc --pretty false -p tsconfig.typecheck-core.json
```
Result: **exit 0, clean** (no type errors).

### 4. Lint changed files (no new suppressions, no `any` in open-sse/)
```
npx eslint --suppressions-location config/quality/eslint-suppressions.json \
  open-sse/services/combo/connectionConcurrencyGate.ts \
  open-sse/services/combo/executeTargetAttempt.ts \
  open-sse/services/combo/decisionTrace.ts \
  tests/unit/combo/connection-concurrency-gate.test.ts \
  tests/unit/combo/connection-concurrency-dispatch.test.ts
```
Result: **exit 0, clean**. None of the five changed files have any entry in
`config/quality/eslint-suppressions.json` (grep found 0 matches), so the suppression count for each
remains 0 — it did NOT increase. No `as any` introduced.

## Commit

Branch: `release/v3.8.52` (no push, no --amend, no .changeset, no CHANGELOG edit).
Commit SHA: `42f062246` — "fix(combo): hard per-(connection,model) cap for local GPU targets"
(5 files changed, 481 insertions(+), 108 deletions(-)). Pre-commit hooks (any-budget,
tracked-artifacts, ai-attribution) passed.
