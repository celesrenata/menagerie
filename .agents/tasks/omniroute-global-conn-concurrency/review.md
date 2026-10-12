# Process-global per-connection concurrency ceiling for the priority path

Commit `598eedc5e` adds a process-global semaphore keyed `conn:<connectionId>`, acquired once around the single upstream dispatch chokepoint in `executeTargetAttempt`, so two different combos that both target the same connection (the reported `hybrid/code` + `hybrid/research` both hitting the 5090 27B at cap 2) now share one ceiling instead of each admitting up to the cap independently. The gate fails open at every edge, holds the slot across a streamed body, and skips quota-share so there is exactly one ceiling per request path. The 5090 cross-combo double-tap — the actual bug in user message #12 — is closed.

Watch for: the implementation keys the gate on **connection only** (`conn:<id>`), not on `conn:<id>:<model>` as `plan.md` designed (**confirmed**). On any connection that hosts more than one model with different intended ceilings, the two models now share ONE ceiling at the connection's `max_concurrent`. Per `plan.md` the 4070 Ti connection `b20e0770` hosts both the 27B coder (intended cap 1) and the 9B reader (intended cap 4), and the 5090 connection `e9bd13fb` hosts both the 27B (cap 2) and the 9B reader (cap 2) — so the gate cannot keep those per-model ceilings independent (**likely**, topology asserted by the plan, not confirmable from the repo). This is a deviation from the plan's design but not from this review's gate criteria, which explicitly accept `conn:<connectionId>` keying.

**Verdict**: APPROVED

## High-level view

The gate is a single process-global semaphore acquired at the common chokepoint every priority-path strategy inherits. Because the key is the connection id, two distinct combos converging on the same connection genuinely share one ceiling — the first two acquire, the third waits. This is verified both at the helper level and by driving `executeTargetAttempt` with three concurrent dispatches at cap 2. The reported 5090 double-tap is fixed.

Release timing for streams is correct: a streaming success hands slot ownership to a `ReadableStream` wrapper whose `close`/`cancel`/`error` paths release exactly once, so the slot stays held while the model is still generating and frees only after the body is fully drained. Non-streaming successes and every error/retry/early-return path release immediately via a `finally`, guarded by an idempotent `released` flag so the wrapper and the `finally` cannot double-free.

Fail-open is preserved and matches `acquireQuotaShareConcurrencySlot` exactly: no connection id, `cap === null`, or `cap <= 0` returns no limit, and a saturated queue or timeout warns and proceeds without a slot rather than failing a dispatchable request.

Reconciliation yields exactly one ceiling per request path with no double-acquire: round-robin never reaches this chokepoint and keeps its `combo:<name>:<step>` key; quota-share keeps its own `qsconn:<id>` gate and is explicitly skipped here; priority/weighted/fill-first/dispatchSequence/fallback — which had no per-connection gate before — now share the new `conn:<id>` ceiling. The decision and the `qsconn:`-vs-`conn:` caveat are documented in the helper header.

No routing value, dispatchSequence order, or context window changed. A whitespace-insensitive diff of `executeTargetAttempt.ts` shows the only logic additions are the gate plumbing; the large line count is prettier reindentation from wrapping the retry-loop body in `try/finally`.

The one substantive gap is the key granularity. The plan argued for `conn:<id>:<model>` so that two models on one physical connection keep independent ceilings; the implementation keys on connection only and resolves the cap from the connection's `max_concurrent`. That collapses co-located models onto one ceiling and does not enforce the "4070 Ti = 1 concurrent 27B and 4× 9B" split that user message #3 asked for. It is still strictly better than the pre-change state (no gate at all), and this review's criteria sanction connection keying, so it does not block — but it is a real follow-up.

<details>
<summary>Issues (3)</summary>

1. **Connection-only key collapses co-located models** — the gate keys `conn:<id>` with the connection's `max_concurrent`, so on a connection hosting both a 27B and a 9B (4070 Ti `b20e0770`; 5090 `e9bd13fb`) the two models share one ceiling instead of the per-model 1/4 and 2/2 splits the plan designed. Non-blocking (improves on no gate, and this review accepts connection keying), but revisit with `conn:<id>:<model>` if the per-model split must hold. Confidence: confirmed (keying) / likely (topology, asserted by the plan).
2. **Missing per-model-independence test** — plan items 5 and 6(b) required a test proving model A (cap 1) and model B (cap 4) on one shared connection enforce independently and simultaneously. It is absent because connection-only keying cannot express it. Add it if the design moves to `conn:<id>:<model>`. Confidence: confirmed.
3. **Verification doc understates the deviation** — `verification.md` records the connection-only key and the reconciliation but does not note that co-located models now share one ceiling (the 4070 Ti 27B/9B and 5090 27B/9B split from the plan is silently dropped). Document the trade-off so a later reader does not assume the per-model split holds. Confidence: confirmed.

</details>

<details>
<summary>Details</summary>

### Global cap across combos — connection-keyed, acquired at the chokepoint

`acquireConnectionConcurrencySlot` acquires on `semaphore.acquire(conn:<connectionId>, {maxConcurrency: cap, ...})`, and the acquire sits in `executeTargetAttempt.ts` immediately before `const result = await deps.handleSingleModelWithTimeout(...)` — the single upstream chokepoint every priority-path strategy funnels through. Two different combos targeting the same connection converge here on the identical key, so they share one ceiling. The dispatch test drives three concurrent `executeTargetAttempt` calls (three independent "combos") against one seeded connection at cap 2 and asserts `getStats()[key].running === 2` with `queued === 1` — exactly two in flight, the third waiting, never three. This closes the reported 5090 double-tap.

The acquire lives inside the `for (let retry = 0; retry <= deps.maxRetries; retry++)` loop, so each upstream attempt takes and releases exactly one slot and does not hold a slot across the inter-retry sleep.

The deviation worth stating plainly: the key omits the model. The cap comes from `lookupPositiveCap(target.connectionId)` — the connection row's `max_concurrent`. On a connection that fronts two models (per the plan, the 4070 Ti connection `b20e0770` hosts the 27B coder and the 9B reader; the 5090 connection `e9bd13fb` hosts the 27B and the 9B reader), both models now contend for one ceiling set to the connection's `max_concurrent`. The plan raised the 4070 Ti connection to `max_concurrent = 4` for the reader lane and intended the 27B to stay at 1 via a per-model `weightedTargetPolicies[...].maxConcurrent` override; the implementation never reads that override, so the 27B coder on that card can now run up to 4 concurrently, and on the 5090 the 27B and 9B reader share a combined ceiling of 2 rather than 2 each. This matches the codebase's existing connection-scoped `isAccountSemaphoreFull` pattern in `executeTargetGates.ts`, which is also connection-only — so the per-model split was not enforced anywhere before this change either. It is a plan-vs-implementation gap, not a regression against prior behavior.

### Release timing for streams — held until the body drains

On a streaming success (`deps.clientRequestedStream`, readable `result.body`), the body is wrapped in a `ReadableStream` whose `pull` releases on `done`, whose `cancel` releases on abort, and whose `catch` releases on error — each through the idempotent `releaseConnectionSlot()`. Ownership is handed to the wrapper via `slotHandedToStream = true`, so the attempt's `finally` does not free the slot early. The dispatch test confirms the slot shows `running === 1` after `executeTargetAttempt` returns but before the caller reads the body, and drops to released only after the reader reaches `done`. This matches the release-after-stream requirement: a slot must not free while the model is still generating.

### Fail-open — matches the quota-share contract

`acquireConnectionConcurrencySlot` returns `null` (no limit) when there is no connection id, `cap === null`, or `cap <= 0`, and on a thrown `SEMAPHORE_TIMEOUT`/`SEMAPHORE_QUEUE_FULL` it logs a `COMBO` warn and returns `null` rather than rejecting. The caller additionally wraps `lookupPositiveCap(...).catch(() => null)`, so a cap-lookup error also fails open. The gate tests cover null cap, `cap <= 0`, missing connection id, and queue saturation (`maxQueueSize: 0` → `null`); the dispatch test confirms an unseeded connection dispatches with no gate created. Edges line up with `acquireQuotaShareConcurrencySlot`.

### No double-acquire — reconciliation documented

Round-robin never reaches `executeTargetAttempt` (combo.ts early-returns into `handleRoundRobinCombo`) and keeps its `combo:<name>:<step>` key, so the new gate never fires for it. Quota-share reaches the chokepoint but already holds `qsconn:<connectionId>` around its whole cooldown-aware dispatch, so the caller skips the new gate when `deps.strategy === "quota-share"` — the dispatch test confirms a quota-share dispatch creates no `conn:` gate. Priority/weighted/fill-first/dispatchSequence/fallback had no per-connection gate before and now share `conn:<id>`. The helper header documents the decision and the caveat that `qsconn:` and `conn:` are distinct keys, so a quota-share request and a priority-path request to the same physical connection count against separate gates — acceptable because the reported bug is cross-combo among priority-path combos, which all use `conn:`.

### No other-lane impact on routing values

A whitespace-insensitive diff of `executeTargetAttempt.ts` for this commit shows the only logic changes are the three new imports, the gate acquire block, the idempotent `releaseConnectionSlot` helper, the streaming-body wrapper, and the `finally`. Everything else in the 867/768 churn is prettier line-wrapping of unchanged statements. No `contextWindow`, `maxTokens`, `dispatchSequence`, weight, cap, or timeout literal was altered. The dispatchSequence ordering and the `src/shared/validation/schemas/combo.ts` change belong to the separate prior commit `94ca490d8`, not to this one. The one behavioral change beyond the 5090 fix — co-located models now sharing a connection ceiling — is a consequence of the gate's connection keying, not a routing/sequence/window edit.

### Test coverage

The gate helper has nine tests: stable connection-scoped key, null/`<=0`/missing-connection fail-open, positive-cap acquire, the cap=2 "third waits, never three" serialization, queue-saturation fail-open, independent gates per connection id, and release-frees-next-waiter. The dispatch integration has five: cross-combo cap=2 never-three, no-cap fail-open, single-combo acquire-and-release-once, streaming held-until-drained, and quota-share-skips-the-gate. The coder's recorded run shows gate 9/0, dispatch 5/0, closest existing suites (`quota-share-concurrency`, `execute-target-attempt`) 23/0, `typecheck:core` clean, and eslint 0 errors with no touched-file suppression entries. I re-ran the dispatch suite as a spot-check of the streaming release-timing assertion: 5 pass, 0 fail.

Not tested: two different models on one shared connection enforcing independent ceilings simultaneously (plan items 5 and 6(b)) — this case cannot exist under connection-only keying, so its absence is a direct symptom of the design deviation rather than a test oversight.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo/connectionConcurrencyGate.ts` (new) — `connectionConcurrencyKey(connectionId)` → `conn:<id>` and `acquireConnectionConcurrencySlot(...)` with the quota-share-matching fail-open contract; header documents the reconciliation and the `qsconn:`-vs-`conn:` caveat.
- `open-sse/services/combo/executeTargetAttempt.ts` (edit) — acquire before the dispatch chokepoint (skipped for quota-share), idempotent release, streaming-body wrapper releasing after drain, `finally` release on all other paths. Bulk of the diff is reindentation.
- `tests/unit/combo/connection-concurrency-gate.test.ts` (new) — nine helper-contract tests.
- `tests/unit/combo/connection-concurrency-dispatch.test.ts` (new) — five integration tests over `executeTargetAttempt`.

Not part of this commit (prior commit `94ca490d8`): `applyStrategyOrdering.ts`, `rrState.ts`, `src/shared/validation/schemas/combo.ts`, `tests/unit/combo-dispatch-sequence.test.ts`.

Full diff: `git show 598eedc5e` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>
