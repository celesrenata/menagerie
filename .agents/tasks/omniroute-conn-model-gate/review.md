# Key the global concurrency gate per (connection, model)

The priority-path concurrency gate (`#esnixi-5090`) previously keyed its process-global semaphore on `conn:<connectionId>` alone. That fixed cross-combo over-admission on the 5090 27B, but it made every model hosted on one connection share a single ceiling — so on the 4070 Ti, which hosts both a 27B coder (cap 1) and a 9B reader (cap 4), the 27B inherited the connection's cap of 4 and could run 4 concurrent. This change re-keys the semaphore to `conn:<connectionId>:<model>` and resolves the cap per (connection, model): a positive `weightedTargetPolicies[model].maxConcurrent` override wins, else the connection's own `maxConcurrent` (`lookupPositiveCap`), else null (fail-open). The result preserves the 3.8.66 5090 double-tap fix while giving the 4070 Ti 27B and 9B independent ceilings. Code-only; no connection or combo config values were touched.

Watch for: nothing blocking. The one notable behavioral change — a model-missing dispatch now fails open with no slot (confirmed) — is correct and matches the existing connectionId-missing branch.

**Verdict**: APPROVED

## High-level view

The gate key moves from connection-scoped to (connection, model)-scoped in `connectionConcurrencyKey`, and `acquireConnectionConcurrencySlot` gains a `model` parameter that is folded into both the key and the early-return guard. Two combos hitting the same (connection, model) still contend for one ceiling; two different models on one connection no longer do.

Cap resolution moves from `lookupPositiveCap(connectionId)` to a new `resolveConnectionModelCap({combo, modelStr, connectionId})` in `concurrencyCaps.ts`. It reads `combo.config.weightedTargetPolicies` (falling back to the top-level `combo.weightedTargetPolicies`), looks up the full `provider/model` key then the bare model key, and accepts only a positive finite integer as an override; otherwise it defers to the connection cap, otherwise null. The override is floored, so a fractional policy value degrades gracefully rather than feeding a non-integer into the semaphore.

The 5090 double-tap guarantee is intact: both hybrid/code and hybrid/research resolve to the same `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4` key with cap 2, so the third concurrent request waits. The 4070 Ti 1-vs-4 split is enforced on distinct keys that are proven to hold simultaneously. The quota-share skip, round-robin exclusion, fail-open posture, and release-after-stream handoff are all preserved untouched by this diff.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking issues surfaced. All five required confirmations hold against the diff and tests.

</details>

<details>
<summary>Details</summary>

## Gate key is now connection+model, not connectionId alone

Confirmed. `connectionConcurrencyKey` changed from `conn:${connectionId}` to `conn:${connectionId}:${model}` and now takes both arguments. `acquireConnectionConcurrencySlot` gained a `model` parameter threaded into both the key construction and the guard (`if (!connectionId || !model || cap === null || cap <= 0) return null;`). The gate test `connectionConcurrencyKey is stable and (connection, model)-scoped` asserts `connectionConcurrencyKey("abc","m") === "conn:abc:m"` and that same connection + different model produces different keys. The call site in `executeTargetAttempt` passes `modelStr` (defined at line 123 as `target.modelStr`) as the second argument.

A new guard case — model missing (`""` or `null`) returns null — is added and tested (`no slot when model is missing`). This fails open, consistent with the pre-existing connectionId-missing branch.

## Per-model cap resolution order

Confirmed. `resolveConnectionModelCap` resolves in exactly the required order:

```
override = readPerModelCap(getWeightedTargetPolicies(combo), modelStr)
if (override !== null) return override            // (1) weightedTargetPolicies[model].maxConcurrent
return await lookupPositiveCap(connectionId ?? "") // (2) connection maxConcurrent, else (3) null
```

`readPerModelCap` only treats a value as an override when it is `typeof === "number" && Number.isFinite(value) && value > 0`, returning `Math.floor(value)`. A zero, negative, non-finite, or non-numeric policy value is ignored and resolution falls through to the connection cap — correct, since a non-positive override should not silently throttle to zero. `getWeightedTargetPolicies` prefers `combo.config.weightedTargetPolicies` and falls back to top-level `combo.weightedTargetPolicies`, mirroring `targetInputPolicy.ts`. Key lookup tries the full `provider/model` string first, then the bare model, matching the same convention. `executeTargetAttempt` wires `resolveConnectionModelCap({combo, modelStr, connectionId})` in place of the old `lookupPositiveCap`, with `.catch(() => null)` preserving fail-open on a resolution error.

## 1-vs-4 split on the shared 4070 Ti connection

Confirmed, and proven simultaneously. The dispatch test `per-model split: A (override cap 1) ≤ 1 WHILE B (connection cap 4) runs 4 at once` seeds one connection at cap 4, applies a `weightedTargetPolicies[MODEL_4070_27B].maxConcurrent = 1` override, fires 2× the 27B and 4× the 9B concurrently against a shared gate, then asserts at the same instant:

- `conn:<id>:ollama-local/qwen3.8:27b-iq3-code144k` running === 1, queued === 1 (override beats connection cap)
- `conn:<id>:ollama-local/qwen3.5-reader:9b` running === 4 (connection cap, independent of A)

Because both assertions run while the shared gate is still held, this proves A ≤ 1 WHILE B runs 4 at the same time — not merely in isolation. The verification evidence records this case passing. A dedicated single-model test (`per-model override of 1 beats a connection cap of 4`) corroborates the override path, and the gate-level test `two different models on ONE connection acquire independent gates` proves the keys do not contend.

## 5090 27B stays ≤ 2 across hybrid/code + hybrid/research

Confirmed. The dispatch test `5090 27B ≤ 2 across two DIFFERENT combos (never 3)` uses connectionId `e9bd13fb`, model `vllm/qwen3.8-27b-nvfp4`, two different combo names (comboA/comboB) with no per-model override, fires three concurrent dispatches, and asserts `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4` running === 2 and queued === 1. Both combos resolve to the identical key (same connection, same model), so they share one ceiling of 2 — the 3.8.66 double-tap fix is preserved under the new key scheme. The original `cap=2 ... third dispatch WAITS (never 3)` test was retained and updated to the model-scoped key.

## No lowered caps, config untouched, other paths intact

Confirmed on each point:

- The 4070 Ti 9B inherits the connection cap of 4 (no override), and nothing in the diff lowers `gremlin-4070ti-ollama`'s `maxConcurrent`. The diff touches only three source files and two test files; `git diff --name-only` shows no connection or combo config files.
- Round-robin is untouched: it never reaches `executeTargetAttempt` (combo.ts early-returns into the dispatch loop), as documented in the gate header. No `combo:<name>:<step>` logic appears in the diff.
- Quota-share still skips this gate: the guard `if (deps.strategy !== "quota-share")` around the acquire is unchanged, so no `conn:` slot is taken for quota-share and no double-acquire against its own `qsconn:<id>` gate occurs. The dispatch test `quota-share does NOT acquire a conn: slot` asserts the key stays undefined.
- Fail-open preserved: null/≤0 cap, missing connection, missing model, resolution error, and saturated queue all proceed without a slot. Tested by `fail-open: no positive cap → dispatch proceeds without a slot` and the gate-level fail-open cases.
- Release-after-stream preserved: the idempotent `releaseConnectionSlot` guard and the `slotHandedToStream` handoff to the body wrapper are unchanged by this diff — only the acquire signature changed. The dispatch test `streaming success: slot is held until the body stream is fully consumed` covers it.

## Verification evidence

The coder's `verification.md` records the touched-test run (19/19 pass, including the simultaneous per-model split and the 5090 ≤ 2 cases with their explicit key assertions), the broader combo suite (382/382 pass), `typecheck:core` exit 0, and ESLint on the five changed files with zero warnings and no suppression-count increase. The evidence is complete and internally consistent with the diff — commands, keys, and running/queued counts match what the test source asserts. No re-run was warranted and none was performed.

## Types

The top-level `combo.weightedTargetPolicies` fallback relies on `ComboLike`'s `[key: string]: unknown` index signature, so it typechecks without a cast; the helpers use the imported `isRecord` guard rather than `as any`.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo/connectionConcurrencyGate.ts` — key changed to `conn:<id>:<model>`; `acquireConnectionConcurrencySlot` gains `model` param and guard; header rewritten.
- `open-sse/services/combo/concurrencyCaps.ts` — new `resolveConnectionModelCap`, `getWeightedTargetPolicies`, `readPerModelCap`; `lookupPositiveCap` retained as the connection-cap fallback.
- `open-sse/services/combo/executeTargetAttempt.ts` — call site switched to `resolveConnectionModelCap` and passes `modelStr` into the acquire; quota-share skip and release/stream handoff unchanged.
- `tests/unit/combo/connection-concurrency-gate.test.ts` — gate-level tests updated to the model-scoped key; adds model-missing and independent-model cases.
- `tests/unit/combo/connection-concurrency-dispatch.test.ts` — adds the simultaneous 1-vs-4 split, the 5090 ≤ 2 cross-combo case, and the override-beats-connection-cap case; existing cases re-keyed.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute diff 598eedc5e..HEAD`

</details>
