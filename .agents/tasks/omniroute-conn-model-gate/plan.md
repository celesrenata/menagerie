# Implementation Plan — Per-(connection, model) global concurrency gate

## Context (verified against the branch, not assumed)

Repo `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52`, HEAD `598eedc5e` (confirmed with `git branch --show-current` + `rev-parse HEAD`). Code-only gate-key change; **no config values change.**

3.8.66 added a process-global per-connection concurrency gate on the priority/dispatchSequence/fallback path. The gate currently keys the semaphore on `conn:<connectionId>` **alone**, so BOTH models hosted on the 4070 Ti connection (`b20e0770-3e14-40c1-87cd-85c34b34381a`, gremlin-4070ti-ollama) — the 27B coder `ollama-local/qwen3.8:27b-iq3-code144k` and the 9B reader `ollama-local/qwen3.5-reader:9b` — share ONE ceiling taken from the connection's `maxConcurrent` (4). Live traffic shows the 27B running 4 concurrent; it must be 1. The fix is to key the gate per `(connection, model)` and resolve a per-model cap at dispatch time.

### Facts established by reading the code

- **(a) model string at the wrap site.** `executeTargetAttempt.ts` sets `const target = state.orderedTargets[i];` and `const modelStr = target.modelStr;` near the top (line ~109). The gate block (the `#esnixi-5090` comment, lines ~377–398) runs inside the retry loop where `modelStr` and `target.connectionId` are both in scope. `target.modelStr` is the full `provider/model` string, e.g. `ollama-local/qwen3.8:27b-iq3-code144k` and `vllm/qwen3.8-27b-nvfp4`. This IS the key used in `weightedTargetPolicies`.
- **(b) combo config at the wrap site.** `deps.combo` is `ComboLike` (`types.ts`) with `config?: Record<string, unknown> | null`. `deps.combo.config.weightedTargetPolicies` is the per-target policy map, confirmed by the existing reader `open-sse/services/combo/targetInputPolicy.ts::getPolicies(combo)`, which reads `combo.config.weightedTargetPolicies` first and falls back to top-level `combo.weightedTargetPolicies`, each entry keyed by the full `provider/model` string. That file only reads `.maxInputTokens` today; this change adds a sibling `.maxConcurrent` read using the same shape. (`deps.config` is the *resolved runtime config*, NOT the raw combo config — do not read `weightedTargetPolicies` from `deps.config`; read it from `deps.combo.config`.)
- **(c) current gate signature.** `connectionConcurrencyGate.ts` exports `connectionConcurrencyKey(connectionId): string` → `conn:${connectionId}`, and `acquireConnectionConcurrencySlot(connectionId, cap, opts, log)`. The wrap site resolves the cap today via `lookupPositiveCap(target.connectionId ?? "")` (connection cap only) and passes it in.
- **(d) cap source for `maxConcurrent`.** `concurrencyCaps.ts::lookupPositiveCap(connectionId)` reads `provider_connections.max_concurrent` via `getCachedProviderConnectionById`, returns a positive int or null (fail-open). The per-model override lives in `combo.config.weightedTargetPolicies[modelStr].maxConcurrent`.
- **Stream release.** The release-after-stream `ReadableStream` wrapper (lines ~728–768) and the `finally` guard (`if (!slotHandedToStream) releaseConnectionSlot();`, line ~1349) call `releaseConnectionSlot()`, which calls `connectionConcurrencyRelease?.()`. The semaphore release is key-agnostic (the release fn closes over its own key), so **none of the release logic changes** — only key + cap resolution change.
- **Semaphore.** `rateLimitSemaphore.ts::acquire(key, {maxConcurrency, timeoutMs, maxQueueSize})` creates one FIFO gate per key. Distinct keys = independent gates. `getStats()[key].running/queued` is how tests observe it. `resetAll()` clears gates.
- **quota-share.** The wrap site already skips the gate entirely when `deps.strategy === "quota-share"` (`if (deps.strategy !== "quota-share") { … }`). Round-robin never reaches `executeTargetAttempt`. Both stay untouched.
- **Test harness.** `tests/unit/combo/connection-concurrency-gate.test.ts` (unit, pins the helper contract) and `tests/unit/combo/connection-concurrency-dispatch.test.ts` (drives `executeTargetAttempt`, seeds the isolated SQLite via `seedConnection`, asserts on `semaphore.getStats()`). node:test. These are the files to extend/update. `connection-concurrency-gate.test.ts` currently asserts `connectionConcurrencyKey("abc") === "conn:abc"` — that assertion MUST be updated for the new signature.

### Resulting ceilings to preserve (do NOT change config values)

| target | connection | per-model override | effective cap | gate key |
|---|---|---|---|---|
| 5090 27B `vllm/qwen3.8-27b-nvfp4` | `e9bd13fb` | none | connection cap **2** | `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4`, shared across hybrid/code + hybrid/research (keeps the 5090 double-tap fix) |
| 4070 Ti 27B `ollama-local/qwen3.8:27b-iq3-code144k` | `b20e0770` | **1** | **1** | `conn:b20e0770:ollama-local/qwen3.8:27b-iq3-code144k` |
| 4070 Ti 9B `ollama-local/qwen3.5-reader:9b` | `b20e0770` | none | connection cap **4** | `conn:b20e0770:ollama-local/qwen3.5-reader:9b` — do NOT lower below 4 |
| 5090 9B `vllm/qwen3.5-9b-nvfp4-reader` | `e9bd13fb` | none | connection cap **2** | `conn:e9bd13fb:vllm/qwen3.5-9b-nvfp4-reader` |

Cap-resolution order per (connection, model): (1) `combo.config.weightedTargetPolicies[model].maxConcurrent` when a positive finite int; (2) else `lookupPositiveCap(connectionId)`; (3) else `null` (fail-open). This is a **code-only** change — the 27B pools already set the override to 1 and the gremlin-4070ti-ollama connection `maxConcurrent` is already 4.

---

# Implementation Plan

- [ ] 1. Change the gate key + helper signatures in `connectionConcurrencyGate.ts`.
      Change `connectionConcurrencyKey(connectionId: string, model: string): string` to return `` `conn:${connectionId}:${model}` ``. Add a `model: string` parameter to `acquireConnectionConcurrencySlot(connectionId, model, cap, opts, log)` and pass `connectionConcurrencyKey(connectionId, model)` to `semaphore.acquire`. Keep fail-open identical (`!connectionId || !model || cap === null || cap <= 0 → return null`; saturated/timeout → log.warn + return null). Update the file header doc block: the ceiling is now per `(connection, model)` keyed `conn:<connectionId>:<model>`; note that two models on one connection (4070 Ti 27B vs 9B) now get independent ceilings, which is the bug this closes, while two combos sharing the same (connection, model) (5090 27B across hybrid/code + hybrid/research) still share one ceiling. The warn message should include the model.
      Files: `open-sse/services/combo/connectionConcurrencyGate.ts`
      Verify: `npx tsc --noEmit` reports no new errors in this file (compile-only; callers updated in steps 2–3 — expect the known caller errors there until those steps land).

- [ ] 2. Add the per-(connection, model) cap resolver in `concurrencyCaps.ts`.
      Add `resolveConnectionModelCap(params: { combo: ComboLike; modelStr: string; connectionId: string | null | undefined }): Promise<number | null>`: (a) read the combo policy map with a `getPolicies`-style helper mirroring `targetInputPolicy.ts` — prefer `combo.config.weightedTargetPolicies`, fall back to top-level `combo.weightedTargetPolicies`, guarded by `isRecord` (import from `./comboData.ts`); look up by `modelStr` (full `provider/model`) and accept the bare-model key as a fallback; return `entry.maxConcurrent` when it is a positive finite int (`typeof === "number" && Number.isFinite && > 0`, `Math.floor`); (b) else `return await lookupPositiveCap(connectionId ?? "")`; (c) else `null`. Import `ComboLike` from `./types.ts`. No `as any` (no-explicit-any is an error in `open-sse/`); use `isRecord` narrowing.
      Files: `open-sse/services/combo/concurrencyCaps.ts`
      Verify: build/typecheck clean for this file; covered functionally by step 5's new tests.

- [ ] 3. Rewire the wrap site in `executeTargetAttempt.ts`.
      In the `#esnixi-5090` block (lines ~388–398, inside `if (deps.strategy !== "quota-share")`), replace `const connCap = await lookupPositiveCap(target.connectionId ?? "").catch(() => null);` with `const connCap = await resolveConnectionModelCap({ combo: deps.combo, modelStr, connectionId: target.connectionId }).catch(() => null);`, and change the `acquireConnectionConcurrencySlot(target.connectionId, connCap, {…}, deps.log)` call to pass `modelStr` as the new second arg: `acquireConnectionConcurrencySlot(target.connectionId, modelStr, connCap, {…}, deps.log)`. Update the import on line ~91 to pull `resolveConnectionModelCap` from `./concurrencyCaps.ts` (keep `lookupPositiveCap` only if still used elsewhere in the file — it is used by `executeTargetGates.ts`, not here, so remove the now-unused `lookupPositiveCap` import from `executeTargetAttempt.ts` if nothing else references it; check first). Update the block comment to describe the per-(connection, model) ceiling. Leave `releaseConnectionSlot`, `slotHandedToStream`, the stream wrapper, and the `finally` untouched.
      Files: `open-sse/services/combo/executeTargetAttempt.ts`
      Verify: `node --test` run of the combo suite (see step 5) compiles and runs this file without type errors; the dispatch tests in step 5 exercise this path.

- [ ] 4. Update the existing helper-contract test for the new key + signature.
      In `tests/unit/combo/connection-concurrency-gate.test.ts`: change the `connectionConcurrencyKey` assertions to the two-arg form — `connectionConcurrencyKey("abc", "m") === "conn:abc:m"`, same connection + different model are NOT equal, same (conn, model) ARE equal. Thread a `model` arg through every `acquireConnectionConcurrencySlot(...)` call (e.g. `"m1"`), and in the "cap=2 serializes the THIRD acquire" test use the SAME `(conn, model)` for all three acquires (that is the two-combos-sharing-one-ceiling case). Add one assertion that two DIFFERENT models on the SAME connectionId acquire independent gates (both get a slot at cap=1, no contention).
      Files: `tests/unit/combo/connection-concurrency-gate.test.ts`
      Verify: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo/connection-concurrency-gate.test.ts` — all tests pass.

- [ ] 5. Extend the dispatch test with the per-model-split and 5090 cross-combo cases.
      In `tests/unit/combo/connection-concurrency-dispatch.test.ts` (reuse its `seedConnection`, `emptyState`, `baseDeps`, `modelTarget`, `runAttempt`, `json200`, `wait` helpers; update `connectionConcurrencyKey` call sites to the two-arg form). Add:
      - **Independent AND simultaneous per-model split (the core regression):** seed ONE connection with `maxConcurrent 4`; set `baseDeps` combo to `{ name:"split", models:[], config:{ weightedTargetPolicies: { "ollama-local/qwen3.8:27b-iq3-code144k": { maxConcurrent: 1 } } } }`. Model A = `modelTarget({ connectionId, modelStr:"ollama-local/qwen3.8:27b-iq3-code144k" })`, Model B = `modelTarget({ connectionId, modelStr:"ollama-local/qwen3.5-reader:9b", executionKey:"ek-b" })`. Hold all dispatches on a shared gate promise; fire 2× A and 4× B concurrently. After `wait(80)` assert `getStats()[connectionConcurrencyKey(connectionId,"ollama-local/qwen3.8:27b-iq3-code144k")].running === 1` and `.queued === 1` (A capped at 1) WHILE `getStats()[connectionConcurrencyKey(connectionId,"ollama-local/qwen3.5-reader:9b")].running === 4` (B at 4) — proving A never exceeds 1 while B runs 4 at the same instant. Release; assert all succeed and both keys drain to `undefined`.
      - **5090 27B ≤ 2 across two different combos:** seed `e9bd13fb` with `maxConcurrent 2`, no per-model override. Use two different combo names (`comboA`, `comboB`) targeting the same `(connectionId, "vllm/qwen3.8-27b-nvfp4")`; fire 3 held dispatches; after `wait(80)` assert the single key `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4` has `running===2`, `queued===1` (never 3). Release; all succeed.
      - **Per-model override of 1 beats a connection cap of 4** (dedicated assertion if not already implied above): one connection cap 4, override on model A = 1 → key for A caps at 1.
      - **Fail-open (no cap):** connection not seeded AND no override → dispatch proceeds, no gate key created (adapt the existing fail-open test to the two-arg key).
      - **Release-after-stream:** streaming success holds the `conn:<id>:<model>` slot until the body is fully consumed, then frees (adapt the existing streaming test's key to two-arg).
      - **quota-share not double-counted:** `strategy:"quota-share"` → no `conn:<id>:<model>` key created (adapt the existing test).
      Keep round-robin out of scope here (it never reaches `executeTargetAttempt`; the existing suite already documents this).
      Files: `tests/unit/combo/connection-concurrency-dispatch.test.ts`
      Verify: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo/connection-concurrency-dispatch.test.ts` — all tests pass, including the simultaneous A≤1 / B=4 assertion.

- [ ] 6. Run the broader combo unit suite to confirm no regression in the gate's neighbors.
      Run the whole `tests/unit/combo/` folder (covers `execute-target-attempt.test.ts`, `quota-share-concurrency.test.ts`, `round-robin-combo.test.ts`, `effective-max-concurrency.test.ts`, `account-concurrency-cap`), since they exercise adjacent concurrency paths and the shared `deps`/semaphore wiring.
      Files: none (verification only)
      Verify: `cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=4 "tests/unit/combo/**/*.test.ts"` — all pass.

- [ ] 7. Typecheck + lint the touched files.
      Files: none (verification only)
      Verify: `npx tsc --noEmit` (repo typecheck) reports no new errors; run the repo's lint over the three changed source files and the two test files and confirm zero warnings (no-explicit-any is an error in `open-sse/`). Use the project's configured lint command (check `package.json` scripts, e.g. `npm run lint`); scope to the changed paths if the script supports it.

## Notes / assumptions

- The per-model override key is the full `target.modelStr` (`provider/model`), which equals the `weightedTargetPolicies` entry key per `targetInputPolicy.ts` and the live config (`ollama-local/qwen3.8:27b-iq3-code144k` → `maxConcurrent 1`). The bare-model fallback key is defensive; the primary lookup is `modelStr`.
- No `qsconn:` (quota-share) or `combo:<name>:<step>` (round-robin) keys change. The `qsconn:` vs `conn:` distinction documented in the gate header remains accurate and in scope-excluded.
- No connection-config or combo-config values are edited; the gremlin-4070ti-ollama connection cap stays 4 and the 27B pools' `maxConcurrent 1` override stays. If a reviewer finds either value is NOT already set as stated, that is a separate config task — flag it, do not change it here.
- Single-file node:test runs reuse the exact `--import tsx/esm --import setupPolyfill --import isolateDataDir` prelude from the repo's `test:unit` script (package.json ~L134); the isolated per-file SQLite is required by `seedConnection`.
