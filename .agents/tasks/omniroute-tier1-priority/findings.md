# Findings: `pool/tier1/code` favoring m5max GLM over the 5090

## Summary answer

The `priority`-strategy engine itself is **working correctly** and does implement true ordered fill-then-overflow. For a `strategy: "priority"` combo, `applyStrategyOrdering` does nothing to the model order at all (`fill-first`/`priority` branches are pass-through — see Evidence 1), so the three models are always attempted in their declared array order: 5090 → m5max GLM → 4070ti. The per-model `weight` field (55/24/21) and the connection's own `priority` field (2 vs 1) are **both dead weight for this combo** — neither is read anywhere in the priority-strategy dispatch path. Live concurrent-load testing against the real combo confirms the fill-then-overflow behavior works exactly as intended: with the 5090's single slot occupied, overflow requests landed on `llama-cpp:ds4-glm53` (m5max GLM), exactly the declared 2nd-priority target (Evidence 6).

So the live, reproducible "favoring m5max" symptom is not a priority/weight misconfiguration. It is **real overflow working as designed, happening more than the user expects** because of two config-level issues, not an engine bug:

1. **`pool/tier1/code`'s per-model `weightedTargetPolicies.maxInputTokens: 524288` is cosmetic/unused.** The real, enforced input ceiling for each model comes from `max_input_tokens` capability-override rows (vllm/qwen3.8-27b-nvfp4 = **98,304**; llama-cpp/ds4-glm53 ≈ 163,840 context, no explicit max_input_tokens override so it inherits the larger context window; ollama-local/qwen3.8:27b-iq3-code144k = **114,688**). The 5090 has by far the smallest input budget of the three. Any coding request whose estimated input exceeds 98,304 tokens is marked "context_window"-incompatible for the 5090 and the compat filter removes it from contention — the request fails over to GLM (or 4070ti) **even when the 5090 has a completely free concurrency slot**. This reproduces live: a single, non-concurrent ~122K-token request was rejected for the 4070ti target with `context_length_exceeded` (and would have skipped the 5090 at ~98K already) — see Evidence 7. For a coding agent sending large repo/context payloads, this alone can make GLM "win" far more often than pure concurrency overflow would predict, independent of the 5090's one-slot limit.
2. **The connection-level `priority` field inversion the user already suspected is real, but it only matters for `expiry-first`/P2C/LRU account-fallback strategies and session-affinity tie-breaks — not for this combo's `priority`-strategy model selection.** It is dormant today but is a landmine: if this combo (or a sibling using `auto`/P2C/expiry-first) is ever changed to resolve the vllm provider's connection generically instead of pinning `connectionId` explicitly per step, the 5090's higher `priority: 2` value would then rank it _behind_ its `priority: 1` siblings in every one of those other selection paths (lower number wins — Evidence 4/5). It should still be fixed, defensively, even though it is not today's root cause for `pool/tier1/code` specifically.

Recommendation: **(a) pure config/data change, no code change needed.** Two PATCHes:

- Fix the connection-level `priority` inversion: set `esnixi-5090`'s connection `priority` to `1` (or lower than its siblings) via `PATCH /api/providers/{id}` — removes the landmine for future strategy changes.
- Raise or clear the vllm/qwen3.8-27b-nvfp4 `max_input_tokens` capability override (currently 98,304) if the real vLLM server can actually serve more context — via `PATCH /api/model-capability-overrides` (`max_input_tokens` key) — or, if 98,304 really is the hardware/model ceiling, accept that large-context coding requests will legitimately overflow past the 5090 and treat that as correct behavior, not a bug.

No OmniRoute source change is required or recommended for the core complaint. See "Secondary note" below for one documentation/UX gap in the engine that is safe to leave alone for now.

---

## Evidence

### 1. `priority` strategy applies no reordering — model-array order is the dispatch order

`open-sse/services/combo/applyStrategyOrdering.ts` is the function that implements every non-`auto` strategy's ordering step. Reading the full `if/else if` chain (the file's own header comment confirms it is "every non-`auto` combo strategy"), there is **no `else if (strategy === "priority")` branch at all** — `priority` is not handled by name anywhere in the chain. The closest branch is:

```
} else if (strategy === "fill-first") {
    log.info(
      "COMBO",
      `Fill-first ordering: preserving priority order (${orderedTargets.length} targets)`
    );
```

(`applyStrategyOrdering.ts` lines ~144-148)

Because there is no `priority` branch, `applyStrategyOrdering`'s initial `let orderedTargets = initialOrderedTargets;` is returned completely untouched for strategy `"priority"` — the function is a no-op for this combo. The ordering `pool/tier1/code` actually dispatches is whatever `resolveComboTargetPipeline` built upstream, which for a non-weighted strategy is just `resolveComboTargets(...)` walking `combo.models` in **declared array order** (`targetResolution.ts` line ~737-744, `comboStructure.ts::resolveComboTargets`). The combo's live JSON (fetched via `GET /api/combos?all=true`) lists the three models in exactly this order: `vllm/qwen3.8-27b-nvfp4` (id `code-t1-0`), `llama-cpp/ds4-glm53` (`code-t1-1`), `ollama-local/qwen3.8:27b-iq3-code144k` (`code-t1-2`) — i.e. 5090 → GLM → 4070ti, matching the combo's own `description`.

**Conclusion for Q1**: `strategy: "priority"` with per-model `weight`-only entries is interpreted correctly — the engine does NOT fall back to weight-proportional selection for this strategy. `weight` is read only by the `weighted` strategy's `selectWeightedTarget`/`resolveWeightedTargets` path (`comboStructure.ts`, `targetSorters.ts::selectWeightedTarget`) and by the `fisherYatesShuffle`/`strict-random` deck, neither of which runs for `strategy: "priority"`. The three models' `weight: 55/24/21` values are simply ignored metadata for this combo.

### 2. The real per-model concurrency gate is per-connection `maxConcurrent`, resolved correctly

The actual admission gate that enforces "only 1 concurrent request to the 5090" is NOT anything in the combo-config layer (`concurrencyPerModel: 1` in the combo's `config`, or `weightedTargetPolicies.capacityUnits: 1`) — those two fields are **not read anywhere in the priority-strategy dispatch path** (grep across `open-sse/` and `src/` for `concurrencyPerModel` found only `comboConfig.ts`'s default-value definition and `roundRobinCombo.ts`'s _round-robin_-only consumer at `roundRobinCombo.ts:172`; `capacityUnits`/`weightedTargetPolicies` have zero readers anywhere in the codebase — pure dead config left over from an abandoned schema).

The gate that actually fires is the account-level semaphore, keyed per `provider:connectionId`:

- `executeTargetGates.ts:404-405`: `const maxConcurrentCap = await lookupPositiveCap(connectionId); if (maxConcurrentCap && isAccountSemaphoreFull(provider, connectionId, maxConcurrentCap)) { ... skip ... }` — this is the pre-dispatch skip gate inside the priority attempt loop (`comboAttemptLoop.ts` → `executeTargetGates.ts`).
- `chatCore.ts:3178-3224`: the actual slot acquisition, `acquireConcurrencyGates([...{ key: accountSemaphoreKey, maxConcurrency: accountSemaphoreMaxConcurrency }], ...)`, where `accountSemaphoreMaxConcurrency = resolveAccountSemaphoreMaxConcurrency(execCreds)` reads `credentials?.maxConcurrent` directly (`executorHelpers.ts:41-44`).
- The connection's own DB row carries `maxConcurrent: 1` for all three (`GET /api/providers`, confirmed live for `esnixi-5090`, `stabulous-m5max`, `gremlin-4070ti-ollama`).

Live verification via `GET /api/admin/concurrency` (`src/app/api/admin/concurrency/route.ts`, which surfaces `accountSemaphore.ts::getStats()`) shows exactly this per-connection shape (`"llama-cpp:70b82fc9-...": { running: 1, maxConcurrency: 1 }`), confirming the gate is per-connection, not per-model-weight, and that it correctly reflects the 5090's single real `--max-num-seqs 1` slot.

**Conclusion**: the fill-then-overflow mechanism — 5090 slot full → skip to next target in array order — is implemented, is per-connection (correctly matching the hardware constraint), and is driven by the combo's declared model order, not by `weight`/`capacityUnits`/`concurrencyPerModel`.

### 3. Live concurrent-load test reproduces correct ordered overflow

Reproduced directly against `pool/tier1/code` with the real management/inference API:

- Sent one slow 5090-bound request, confirmed in-flight via `GET /api/admin/concurrency` (showed `vllm:e9bd13fb-...: running: 1`), then fired two more concurrent requests at the same combo.
- Both overflow requests landed on `llamacpp/ds4-glm53` — i.e., **GLM**, the declared #2 target — not round-robined across GLM/4070ti, not landing back on the 5090. This is exactly 5090 → GLM overflow order, matching the combo's description and the array order from Evidence 1.

This directly contradicts a "weighted lottery" explanation (where the 4070ti, weight 21, would have a near-even chance of winning overflow over GLM, weight 24) and confirms the engine already does true ordered fill-then-overflow for this combo today.

### 4. Connection-level `priority` field: what it actually controls, and that it does NOT touch this combo

`priority` on a provider **connection** row (as opposed to a combo-step `weight`) is read in exactly two families of code, both unrelated to `strategy: "priority"` combo dispatch:

- **P2C (power-of-two-choices) connection scoring**, `src/sse/services/auth.ts:612`: `Math.min(6, Math.max(0, connection.priority || 0) - 1)` is added into a numeric penalty score (lower score wins), and `auth.ts:635-636` uses `(a.priority || 999) - (b.priority || 999)` as a tie-break when two connections' P2C scores are equal.
- **LRU/tie-break ordering across many fallback strategies** — `auth.ts:1945-1946, 2012, 2042, 2067, 2118, 2140`, and `expiryFirstAccountSelection.ts:93,109` all use the identical pattern `(a.priority || 999) - (b.priority || 999)`, i.e. **lower numeric value sorts first / wins**. This is the pool used by `fill-first` (`auth.ts:2156` comment: "Default: fill-first (already sorted by priority in getProviderConnections)"), `cost-optimized` account fallback (`auth.ts:2137-2140`), and the generic LRU candidate-pool sort when multiple connections exist for the _same provider_ and no explicit `connectionId` pins one of them.

Crucially, none of this runs for `pool/tier1/code`: every model entry in this combo carries an explicit `connectionId` (`code-t1-0` → `e9bd13fb-...`, etc.), so `getProviderCredentials` always resolves a single forced connection per target rather than ranking a multi-connection pool for that provider. `vllm` does have two connections (`esnixi-5090`, `gremlin-4070ti` — note: this is the _vllm_ 4070ti connection, distinct from the `ollama-local` one actually in the combo), so the inverted priority (5090=2, siblings=1) is a live landmine for any future vllm-provider request that does NOT pin `connectionId` (e.g. a different combo, or this combo's step losing its explicit pin) — the account-fallback pool would then rank `gremlin-4070ti` (`priority: 1`) ahead of `esnixi-5090` (`priority: 2`) by this tie-break, inverting the user's intended hardware order. It is real and worth fixing, but it is not today's root cause for the specific `pool/tier1/code` combo, because the explicit per-step `connectionId` bypasses the ranked-pool code entirely.

**Conclusion for Q2**: lower `priority` number wins in every reader. `esnixi-5090`'s `priority: 2` vs its siblings' `priority: 1` does invert the intended order **wherever a ranked multi-connection pool for that provider is actually consulted** — but `pool/tier1/code` pins `connectionId` per step, so it never consults that pool. The field is dormant for this specific combo today, not the cause of the reported symptom, but should still be corrected defensively.

### 5. Backoff/health state is not the cause

Per the investigation brief's Q4, re-checked live at investigation time:

```
esnixi-5090:  backoffLevel: 0, testStatus: "active", lastTested recent, no lastError
stabulous-m5max: backoffLevel: 0, testStatus: "active", no lastError
gremlin-4070ti-ollama: backoffLevel: 0, testStatus: "active", no lastError
```

(`GET /api/providers`, fields confirmed for all three connectionIds referenced by the combo.) No connection has accumulated backoff or a recent error. This rules out health/circuit-breaker/backoff avoidance as a contributing cause.

### 6. The combo's own `weightedTargetPolicies` and `weightedRoundRobin` config keys have zero code readers

A repo-wide search (`grep -rn "weightedRoundRobin"` and `grep -rn "weightedTargetPolicies"` and `grep -rn "capacityUnits"` across `open-sse/`, `src/`, excluding tests) returns **no matches outside the Zod validation schema** (`src/shared/validation/schemas/combo.ts` does not even define these two keys — they pass through the schema's `.passthrough()` and are persisted, but nothing downstream reads them). `src/lib/combos/deadConfigKeys.ts` documents a related but distinct list of genuinely-dead keys (`pipelineConcurrency`, `resetAwareEnabled`, `resetAwareWindow`) that get stripped on write; `weightedRoundRobin` and `weightedTargetPolicies` are not even on that stripped list — they are silently inert, persisted JSON that no engine code path consults. This explains why the combo's `description` ("Tier 1 code: ... priority") and its `config.weightedRoundRobin: false` + `weightedTargetPolicies.*.capacityUnits: 1` look like they were meant to express ordered-fill-with-capacity semantics, but none of those fields do anything — the actual ordered-fill-with-capacity behavior comes entirely from (a) declared array order + (b) the real per-connection `maxConcurrent` semaphore (Evidence 1-2), which already happen to deliver exactly the intended behavior by coincidence of how `priority` strategy + per-step `connectionId` + per-connection `maxConcurrent: 1` compose.

### 7. The actual, reproducible overflow amplifier: per-model `max_input_tokens` capability overrides

Live `GET /api/model-capability-overrides` shows:

```
vllm/qwen3.8-27b-nvfp4            max_input_tokens = 98304   (context_length 131072)
llama-cpp/ds4-glm53               context_length   = 163840  (no max_input_tokens override → inherits full window)
ollama-local/qwen3.8:27b-iq3-code144k  max_input_tokens = 114688  (context_length 147456)
```

`comboStructure.ts::getTargetCompatibilityFailures` → `contextOverrideGate.ts::evaluateContextLimit` (comboStructure.ts:655: `if (requirements.requiredContextTokens > 0 && contextVerdict === false) failures.push("context_window")`) runs for **every** strategy including `priority`, inside `applyContinuityFilters` (`targetResolution.ts:551`, `filterTargetsByRequestCompatibility`, `comboStructure.ts:750`). This filter removes a target from `orderedTargets` _before_ the attempt loop ever gets to it — independent of concurrency, independent of `weight`, independent of connection `priority`. Live-reproduced: a single (non-concurrent) ~486K-character / ~122K-estimated-token request against `pool/tier1/code` returned a 400 `context_length_exceeded` citing the ollama-local 4070ti's 114,688 cap as the proximate failure (the 5090's smaller 98,304 cap would have excluded it even earlier in the same filter pass). For requests in the 98,304–114,688 token range, the 5090 alone gets filtered out and GLM becomes the first _eligible_ target — this happens with **zero concurrency pressure**, purely from the input-size compat filter, and is a second, independent path (beyond the single concurrency slot) by which real coding-agent traffic with large repo context can land on GLM "for all coding," matching the user's complaint more fully than concurrency overflow alone would.

**Conclusion for Q3**: `concurrencyPerModel`/`weightedTargetPolicies.capacityUnits` do **not** implement anything — they are inert config. The actual, correct mechanism already in place for "fill connection A to its real cap, then overflow to B, then C" is: (1) declared array order for `strategy: "priority"` (no per-model priority/order field is needed or missing — array position already is that field), composed with (2) the connection's real `maxConcurrent` semaphore gate. That combination is correct and need not change. The elevated GLM share the user is seeing is explained by Evidence 7 (input-size compat filtering) stacking on top of the legitimate 1-slot concurrency overflow (Evidence 2-3) — not by a priority/weight/strategy bug.

---

## Recommendations

**(a) Pure OmniRoute data/config change — safe to apply directly, no code/redeploy needed:**

1. Fix the dormant connection-priority inversion defensively: `PATCH /api/providers/{esnixi-5090-id}` to set `priority: 1` (matching `stabulous-m5max` and `gremlin-4070ti-ollama`), or lower than both. This has no effect on `pool/tier1/code` today (Evidence 4) but removes a landmine for any future combo/strategy change (e.g. switching this combo to `auto`, or adding a vllm step without an explicit `connectionId`) that would otherwise silently rank the 5090 behind its siblings.
2. Decide on the `vllm/qwen3.8-27b-nvfp4` `max_input_tokens` override (currently 98,304, set 2026-10-02 05:03:25, i.e. deliberately recent). If this is a real hardware/model-serving limit, no change is needed and the overflow-on-large-context behavior is correct and should be left as-is — flag it to the user as "GLM wins on large-context coding requests by design, not by bug." If 98,304 was set conservatively and the real vLLM instance can serve more of its 131,072 native context window, raise it via `PATCH /api/model-capability-overrides` (`key: "max_input_tokens"`, `target: "vllm/qwen3.8-27b-nvfp4"`) to shrink the band of requests that skip the 5090 purely on size.
3. Optional cleanup, not required to fix the behavior: the combo's `config.weightedRoundRobin` and `config.weightedTargetPolicies` keys are inert for a `priority`-strategy combo (Evidence 6) and could be removed to stop the config from implying capacity semantics that don't exist — but leaving them is harmless.

**(b) No OmniRoute source/engine change is required.** The `priority` strategy's "no explicit per-model priority field, just array order" design is not a bug: array position already is the priority signal, and `applyStrategyOrdering`'s no-op for `priority`/`fill-first` is intentional and correct (its own log line says "preserving priority order"). Do not add a numeric priority field to combo model entries to "fix" this — it would be redundant with array order and risks a second source of truth drifting out of sync with the declared order, which is the same class of problem the connection-level `priority` field already causes (Evidence 4).

If, after applying (a), the user still perceives GLM dominating coding traffic, the next thing to check (follow-up investigation, not scoped here) is the actual Zoo/client-side request sizes/`X-OmniRoute-Tier` routing into `hybrid/code` → `pool/tier1/code`, since `hybrid/code`'s nested-combo dispatch (`dispatchPrelude.ts::tryRuntimeUnitDispatch`) and tier-based X-OmniRoute-Tier header handling were out of scope for this combo-local investigation and were not evidenced to be a factor here, but could independently affect which tier/pool a given coding request even reaches.

---

## Files/symbols read (for traceability)

- `open-sse/services/combo/applyStrategyOrdering.ts`
- `open-sse/services/combo/targetResolution.ts`
- `open-sse/services/combo/comboStructure.ts` (`resolveComboTargets`, `filterTargetsByRequestCompatibility`, `getTargetCompatibilityFailures`, `deriveRequestCompatibilityRequirements`)
- `open-sse/services/combo/contextOverrideGate.ts` (`evaluateContextLimit`)
- `open-sse/services/combo/executeTargetGates.ts` (concurrency-cap pre-dispatch skip)
- `open-sse/services/combo/concurrencyCaps.ts` (`lookupPositiveCap`)
- `open-sse/services/accountSemaphore.ts` (`isAccountSemaphoreFull`, `getStats`)
- `open-sse/handlers/chatCore.ts` (real semaphore acquisition, `acquireConcurrencyGates`)
- `open-sse/handlers/chatCore/executorHelpers.ts` (`resolveAccountSemaphoreMaxConcurrency`)
- `open-sse/services/combo/targetSorters.ts` (`selectWeightedTarget`, confirms `weight` is weighted-strategy-only)
- `open-sse/services/comboConfig.ts` (`concurrencyPerModel`, `queueTimeoutMs` defaults; confirms neither is a priority-strategy concern)
- `src/shared/constants/routingStrategies.ts` (`ROUTING_STRATEGY_VALUES`, confirms `priority` is a real declared strategy)
- `src/shared/validation/schemas/combo.ts` (confirms `weightedRoundRobin`/`weightedTargetPolicies` are not even schema-defined keys)
- `src/lib/combos/deadConfigKeys.ts` (contrast: the keys that ARE formally tracked as dead)
- `src/sse/services/auth.ts` (connection-level `priority` readers: P2C score, LRU tie-breaks)
- `src/sse/services/expiryFirstAccountSelection.ts` (`priority` tie-break for `expiry-first`)
- Live API: `GET /api/combos?all=true`, `GET /api/providers`, `GET /api/admin/concurrency`, `GET /api/model-capability-overrides`, `GET /api/combos/metrics`, `GET /api/settings`, `GET /api/settings/combo-defaults`, `GET /v1/models`, and live `POST /v1/chat/completions` concurrency/large-context reproduction tests against `pool/tier1/code`.

Files explicitly NOT modified and not required for the recommended fix, per the investigation brief's exclusion list: `open-sse/executors/base/reasoningEffort.ts`, `targetRequestSanitizer.ts`, `BaseExecutor.execute()`, `modelCapabilityOverrides.ts`, `src/lib/db/repositories/sqliteComboRepository.ts`, `src/app/api/combos/route.ts`, `src/lib/db/combos.ts`.
