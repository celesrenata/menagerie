# Implementation Plan — Process-global per-(connection,model) concurrency ceiling (priority/dispatchSequence path)

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52` (confirmed `git branch --show-current` → `release/v3.8.52`). Work directly on this branch — no worktree, no branch switch. Do NOT create `.changeset` files or edit any CHANGELOG.

## Bug & root cause (confirmed by reading the code)

The RTX 5090 27B connection (`esnixi-5090`, `vllm/qwen3.8-27b-nvfp4`, `maxConcurrent=2`) is hit by 3 concurrent requests. The connection-level ceiling is enforced PER COMBO DISPATCH, not globally:

- In the priority/dispatchSequence/fallback path, each combo dispatch builds its own per-dispatch resolver via `makeConnectionConcurrencyResolver` (`open-sse/services/combo/concurrencyCaps.ts` — "The cache lives for the resolver's lifetime (one combo dispatch)"). That resolver only feeds the round-robin loop's semaphore; the priority path has NO per-connection semaphore at all around the actual upstream dispatch.
- When `hybrid/code` and `hybrid/research` (two different combos that both list the 5090 model) run at once, each admits up to 2 against the same connection → 2+2, and 3 observed.

## Why the key is (connection, model), not connection alone

A single physical connection can host MORE THAN ONE model, each with its own ceiling. The `gremlin-4070ti-ollama` connection (`b20e0770-3e14-40c1-87cd-85c34b34381a`) hosts BOTH:

- the 27B coder `ollama-local/qwen3.8:27b-iq3-code144k` — cap **1**, and
- the 9B reader `ollama-local/qwen3.5-reader:9b` — cap **4**.

A per-connection-only semaphore would collapse these into one number and break the split. The gate therefore keys on **`conn:<connectionId>:<model>`** so each (connection, model) pair has an independent ceiling that two different combos still share.

### Required caps and how they resolve

Cap resolution per (connection, model), highest-priority source first:

1. The combo's per-target policy `combo.config.weightedTargetPolicies["<provider>/<model>"].maxConcurrent` (positive finite int) — the operator's model-specific override.
2. else the connection's `maxConcurrent` (via `lookupPositiveCap(connectionId)`).
3. else no limit (fail-open).

| Target | connection | per-model override | effective cap | key |
| --- | --- | --- | --- | --- |
| 5090 27B `vllm/qwen3.8-27b-nvfp4` | `e9bd13fb` | none | connection cap **2** | `conn:e9bd13fb-…:vllm/qwen3.8-27b-nvfp4` — shared across hybrid/code + hybrid/research → fixes the double-tap |
| 4070 Ti 27B `qwen3.8:27b-iq3-code144k` | `b20e0770` | **1** | **1** | per-model override, independent of the 9B |
| 4070 Ti 9B reader `qwen3.5-reader:9b` | `b20e0770` | none | connection cap **4** | needs the `gremlin-4070ti-ollama` connection `maxConcurrent` = **4**; the 27B stays at 1 via its own override |
| 5090 9B reader `vllm/qwen3.5-9b-nvfp4-reader` | `e9bd13fb` | none | connection cap **2** | shares connection `e9bd13fb` with the 5090 27B but a distinct model key, so each has its own ceiling; leave at the connection cap (2) for now |

IMPORTANT about the 4070 Ti connection cap: the `gremlin-4070ti-ollama` connection `maxConcurrent` must be **4** so the 9B reader gets 4; the 27B is independently held at 1 by its per-model override. Keep/set that connection cap at 4; do NOT lower it. This is a connection-config value, not code — if it is already 4, change nothing; if it is lower, raising it to 4 is required for the reader lane and is explicitly in scope for THIS task only (it does not affect any other lane because the 27B on the same connection is capped independently at 1).

## Routing facts established during exploration (anchor every change to these)

- `open-sse/services/combo.ts:863–865` — `strategy === "round-robin"` early-returns into `handleRoundRobinCombo`; it NEVER reaches `executeTargetAttempt`. Its semaphore key is `combo:${combo.name}:${target.executionKey}` (`roundRobinCombo.ts:488`), i.e. per-combo+step — out of scope here.
- All other strategies (priority, weighted, fill-first, dispatchSequence, quota-share, …) flow through `dispatchWithCooldownRetry` → `executeTargetAttempt` (`combo.ts:1134,1162`).
- Quota-share additionally acquires a per-connection slot keyed `qsconn:${connectionId}` ONCE around the whole dispatch (`combo.ts:1138–1162`, via `acquireQuotaShareConcurrencySlot`), then releases in the `finally`.
- The single upstream chokepoint in the priority path is `executeTargetAttempt.ts:374`: `const result = await deps.handleSingleModelWithTimeout(attemptBody, modelStr, {...})`.
- `deps` (`AttemptLoopDeps` in `attemptLoopTypes.ts`) exposes `strategy`, `combo` (`ComboLike`, with `combo.config: Record<string, unknown>` holding `weightedTargetPolicies`), `config` (has `queueTimeoutMs`), `log`, and `clientRequestedStream`. `target.modelStr` is the `<provider>/<model>` key used both for dispatch and policy lookup.
- Per-target policy map shape is confirmed in `open-sse/services/combo/targetInputPolicy.ts` (`getPolicies` reads `combo.config.weightedTargetPolicies["<provider>/<model>"]`, today only `.maxInputTokens`). The new resolver adds a sibling `.maxConcurrent` reader using the same lookup.
- Semaphore primitive: `open-sse/services/rateLimitSemaphore.ts` `acquire(key, {maxConcurrency, timeoutMs, maxQueueSize})` returns a release fn; throws `SEMAPHORE_TIMEOUT`/`SEMAPHORE_QUEUE_FULL` on saturation.
- Cap lookup: `lookupPositiveCap(connectionId)` in `concurrencyCaps.ts` returns the connection's positive `maxConcurrent` or `null` (fail-open on unset/<=0/error).

## Design decisions (made here, grounded in the above)

1. **New gate helper**, mirroring `quotaShareConcurrency.ts`, with semaphore key **`conn:<connectionId>:<model>`**. Fail-open at the same edges (`!connectionId || cap === null || cap <= 0` → `null`; saturated queue / timeout → `null` with a warn log, never reject a dispatchable request).

2. **New per-(connection,model) cap resolver** in the gate helper (or in `concurrencyCaps.ts` next to `lookupPositiveCap`): `resolveConnectionModelCap({ combo, modelStr, connectionId })` returns `number | null` using the priority order above. It reads the per-model `maxConcurrent` from `combo.config.weightedTargetPolicies[modelStr]` (reuse the `getPolicies`-style lookup from `targetInputPolicy.ts`; accept the `<provider>/<model>` and bare-model key variants), falling back to `lookupPositiveCap(connectionId)`, else `null`.

3. **Wrap site**: `executeTargetAttempt.ts`, around the `handleSingleModelWithTimeout` call at line ~374 — the single common chokepoint every priority-path strategy inherits. Two different combos targeting the same (connection, model) converge here, so one process-global semaphore makes them share one ceiling while a different model on the SAME connection keeps its own key and its own ceiling.

4. **Reconciliation — exactly ONE global ceiling per (connection, model), no double-acquire:**
   - Round-robin never reaches `executeTargetAttempt` → the new gate never fires for it; its `combo:<name>:<step>` key is untouched.
   - Quota-share DOES reach `executeTargetAttempt` and already holds `qsconn:<connectionId>` around the whole dispatch. To avoid a second ceiling, the new gate is **skipped when `deps.strategy === "quota-share"`** — quota-share keeps its existing single `qsconn:` ceiling (acquired once around the cooldown-aware re-dispatch; layering a model-keyed gate on top would be redundant and could deadlock against its own retries). The priority/dispatchSequence/fallback strategies (no per-connection gate today) get the new `conn:<id>:<model>` ceiling.
   - Documented caveat (record in the helper header): `qsconn:` is connection-scoped while `conn:` is (connection,model)-scoped, so a quota-share request and a priority-path request to the same physical connection count against different gates. Acceptable and out of scope: the reported bug is cross-combo among priority-path combos (`hybrid/code` + `hybrid/research`) on the SAME model, which all use the identical `conn:<id>:<model>` key and therefore share one ceiling. Quota-share is intentionally left unchanged.

5. **Release-after-stream** (streaming responses only): a slot must not free while the model is still generating. Existing nvidia/round-robin/quota-share gates release in a `finally` the moment the executor returns — for a streaming `Response` that is before the body is consumed. For the new gate, release only after the stream is fully consumed/aborted by wrapping the successful `Response.body` in a `ReadableStream` (same pattern as `buildReplayResponse` in `validateQuality.ts:522`) whose `close`/`cancel`/`error` paths call `release()` exactly once. Non-streaming (JSON) responses and all error/skip paths release immediately in a `finally`. Release is idempotent (`released` flag plus the semaphore's own guard).

## Ordered implementation items

- [ ] 1. Add the per-(connection,model) cap resolver.
      In `open-sse/services/combo/concurrencyCaps.ts`, add `resolveConnectionModelCap(params: { combo: ComboLike; modelStr: string; connectionId: string | null | undefined }): Promise<number | null>` that (a) reads `combo.config.weightedTargetPolicies[modelStr]?.maxConcurrent` (and the bare-model key variant), returning it when it is a positive finite int; (b) else returns `await lookupPositiveCap(connectionId)`; (c) else `null`. Reuse the `getPolicies`/`isRecord` style from `targetInputPolicy.ts`; no `as any` (no-explicit-any is an error in `open-sse/`).
      Files: `open-sse/services/combo/concurrencyCaps.ts` (edit)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-model-cap.test.ts` passes (test added in item 4).

- [ ] 2. Add the global per-(connection,model) gate helper.
      Create `connectionConcurrencyGate.ts` modeled on `quotaShareConcurrency.ts`: export `connectionConcurrencyKey(connectionId: string, model: string): string` returning `` `conn:${connectionId}:${model}` ``, and `acquireConnectionConcurrencySlot(connectionId, model, cap, opts, log)` returning `(() => void) | null`. Same fail-open contract as `acquireQuotaShareConcurrencySlot` (no connection / no model / `cap === null` / `cap <= 0` → `null`; wrap `semaphore.acquire(connectionConcurrencyKey(connectionId, model), {maxConcurrency: cap, timeoutMs: opts.queueTimeoutMs, maxQueueSize: opts.maxQueueSize})` in try/catch; on throw log a `COMBO` warn and return `null`). Header comment documents the `qsconn:` vs `conn:` reconciliation, the quota-share skip, and WHY the key includes the model (one connection, many models, independent ceilings — gremlin-4070ti example).
      Files: `open-sse/services/combo/connectionConcurrencyGate.ts` (new)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-concurrency-gate.test.ts` passes (test added in item 5).

- [ ] 3. Wrap the upstream dispatch chokepoint in `executeTargetAttempt`.
      Around `const result = await deps.handleSingleModelWithTimeout(attemptBody, modelStr, {...})` (line ~374): (a) if `deps.strategy !== "quota-share"`, resolve the cap via `resolveConnectionModelCap({ combo: deps.combo, modelStr, connectionId: target.connectionId })` and call `acquireConnectionConcurrencySlot(target.connectionId, modelStr, cap, {queueTimeoutMs: deps.config.queueTimeoutMs ?? 120000, maxQueueSize: <reuse resolveComboQueueDepth or a sane default>}, deps.log)` BEFORE the call; (b) on a successful STREAMING response (`deps.clientRequestedStream` and `result.ok` with a readable `result.body`), replace `result` with a new `Response` whose body is a `ReadableStream` wrapper forwarding bytes and calling `release()` once on close/cancel/error (mirror `buildReplayResponse` in `validateQuality.ts:522`), preserving status/statusText/headers; (c) for non-streaming success and EVERY error/retry/skip/early-return path out of this attempt, release immediately. Single `release` variable per attempt plus a `released` guard so the wrapper and any `finally` cannot double-release. Acquire inside the retry loop body so each upstream attempt holds exactly one slot and releases before the next retry sleeps. Do NOT change routing values, dispatchSequence order, context windows, caps, or timeouts — concurrency-ceiling plumbing only.
      Files: `open-sse/services/combo/executeTargetAttempt.ts` (edit; import `acquireConnectionConcurrencySlot` and `resolveConnectionModelCap`)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-concurrency-dispatch.test.ts` passes (test added in item 6); `npm run typecheck:core` is clean.

- [ ] 4. Unit-test the cap resolver.
      Cover: per-model override wins (`weightedTargetPolicies["ollama-local/qwen3.8:27b-iq3-code144k"].maxConcurrent = 1` → 1 even when the connection cap is 4); no override → falls back to the connection cap (reader 9B on a connection whose `maxConcurrent=4` → 4); 5090 27B no override → connection cap 2; neither set → `null`; non-positive/non-finite override ignored → falls through. Use `node:test` + `node:assert/strict`; stub the connection lookup (set `maxConcurrent` via the DB test helper used by `account-concurrency-cap.test.ts`, or inject a cap) so the resolver reads real values.
      Files: `tests/unit/combo/connection-model-cap.test.ts` (new)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-model-cap.test.ts` — all tests pass.

- [ ] 5. Unit-test the gate helper (mirror `tests/unit/combo/quota-share-concurrency.test.ts`).
      Cover: key is stable and (connection,model)-scoped (`conn:abc:p/m`; same connection + different model → different key); `null` for no connection / no model / `cap === null` / `cap <= 0`; acquires on a positive cap; `cap=2` serializes a THIRD concurrent acquire on the SAME key (models the two-combo 5090 bug — never 3 held); **two DIFFERENT models on the SAME connection enforce independently AND simultaneously — model A `cap=1` never exceeds 1 while model B `cap=4` holds 4 at once** (the gremlin-4070ti requirement); fail-open when the queue is saturated (`maxQueueSize: 0` → `null`); release frees the slot for the next waiter. `node:test` + `node:assert/strict` + `semaphore.resetAll()` per test.
      Files: `tests/unit/combo/connection-concurrency-gate.test.ts` (new)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-concurrency-gate.test.ts` — all tests pass.

- [ ] 6. Integration-style test for the dispatch wrap in `executeTargetAttempt`.
      Drive `executeTargetAttempt` (or a thin seam over its acquire/release logic) with a stubbed `deps.handleSingleModelWithTimeout` to assert: (a) two concurrent dispatches to the SAME (connection, model) via two DIFFERENT combos share one `conn:<id>:<model>` semaphore and the second WAITS at `cap=2` (never 3 in flight — the 5090 27B code+research case); (b) model A (`cap=1`) and model B (`cap=4`) on ONE shared connection enforce independently and simultaneously (A never >1 while B runs 4); (c) fail-open when cap is null/<=0 or the queue is saturated (dispatch proceeds); (d) streaming success releases only AFTER the returned body stream is fully consumed/cancelled, not before (gate shows the slot held while bytes remain, freed after the reader hits `done`); (e) single-combo behavior unchanged (acquire+release once); (f) `strategy === "quota-share"` does NOT acquire a `conn:` slot (no double-count); round-robin never routes here. Assert via `semaphore.getStats()` on the `conn:<id>:<model>` keys. Keep provider payloads/stubs inline.
      Files: `tests/unit/combo/connection-concurrency-dispatch.test.ts` (new)
      Verify: `node --import tsx/esm --test tests/unit/combo/connection-concurrency-dispatch.test.ts` — all tests pass.

- [ ] 7. Focused verification (run the touched tests once, then static checks). Do NOT run the full unit suite more than once.
      Files: none
      Verify, in order:
      - `node --import tsx/esm --test tests/unit/combo/connection-model-cap.test.ts tests/unit/combo/connection-concurrency-gate.test.ts tests/unit/combo/connection-concurrency-dispatch.test.ts tests/unit/combo/quota-share-concurrency.test.ts tests/unit/rateLimitSemaphore.test.ts` — all pass (new tests + closest existing suites to catch regressions).
      - `npm run typecheck:core` — clean.
      - `npx eslint --no-error-on-unmatched-pattern --suppressions-location config/quality/eslint-suppressions.json open-sse/services/combo/connectionConcurrencyGate.ts open-sse/services/combo/concurrencyCaps.ts open-sse/services/combo/executeTargetAttempt.ts tests/unit/combo/connection-model-cap.test.ts tests/unit/combo/connection-concurrency-gate.test.ts tests/unit/combo/connection-concurrency-dispatch.test.ts` — 0 errors, no new `no-explicit-any`, suppression count for touched files not increased.

## Guardrails (restate before committing)

- Concurrency-ceiling plumbing ONLY. No change to routing values, dispatchSequence order, context windows, per-model caps, or timeouts beyond what this task specifies. The only connection-config value in scope is the `gremlin-4070ti-ollama` connection `maxConcurrent` = 4 (keep/raise, never lower) so the 9B reader lane gets 4 while the 27B stays at 1 via its per-model override.
- Fail-open everywhere: missing connectionId/model, non-positive cap, or saturated queue must let the request proceed, never fail it.
- Exactly one global ceiling per (connection, model) on the priority path: `conn:<id>:<model>`; `qsconn:<id>` retained for quota-share (skip the new gate there); `combo:<name>:<step>` untouched for round-robin. No double-acquire.
- Each model on a shared connection has its OWN ceiling: 4070 Ti 27B = 1 and 9B reader = 4 enforce independently and simultaneously.
- Release-after-stream for streaming successes; immediate release for JSON successes and all failure/skip paths; idempotent release.
- Do not create `.changeset` files; do not edit CHANGELOG.
