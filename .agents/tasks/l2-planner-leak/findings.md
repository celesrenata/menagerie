# `hybrid/planner` tier-2 Bedrock "leak" — findings

**Status: ROOT CAUSE IDENTIFIED. The fix is CLIENT-SIDE. No OmniRoute config/code change is required.**

## Summary answer (read this first)

There is **no server-side escalation and no tier-1 skip**. OmniRoute is not bypassing an idle,
healthy GLM. The 62–64 Bedrock calls logged under `hybrid/planner` are **direct, client-requested
dispatches**: the client (the nervcenter AAR orchestrator/spec-lead running on API key `zoo-m5`)
is sending `model: "bedrock/global.openai.gpt-5.6-luna"` — the literal `provider/model` string of
the **tier-2** combo member — as the request model. OmniRoute faithfully routes a combo request
whose `model` names a specific member to that member's step (`planner-t2-2`). GLM is idle on those
calls simply because the client never asked for it.

The discriminator is the **client's requested model string**, nothing else. It is not the
2-token shape, not the `zoo-m5` key, not prompt-caching, not compression, not an `X-OmniRoute-Tier`
header, and not the tier-1 context-length mismatch.

This is exactly the user's own diagnosis: *"the project in ~/sources/celesrenata/nervcenter is
using l2 planners, move it to l1."* The nervcenter planner/orchestrator role is pinned to the
tier-2 model name instead of the tier-1 planner.

---

## Decisive evidence

### 1. The two call classes differ ONLY by requested model (call_logs, last 24h)

Query grouped by step + `requested_model` for `combo_name='hybrid/planner'`:

| step            | requested_model                        | count | resilience_actions |
|-----------------|----------------------------------------|-------|--------------------|
| `planner-t1-0`  | `llama-cpp/ds4-glm53`                  | 77    | —                  |
| `planner-t2-2`  | `bedrock/global.openai.gpt-5.6-luna`   | 64    | **0 of 64**        |
| (null step)     | `hybrid/planner`                       | 5     | —                  |

- Every GLM call explicitly requested `llama-cpp/ds4-glm53` (the tier-1 member).
- Every Bedrock call explicitly requested `bedrock/global.openai.gpt-5.6-luna` (the tier-2 member).
- **0 of the 64 Bedrock calls carry any `resilience_actions`**, and all have
  `resilience_actions = null`, `added_wait_cause = null`, `error_summary = null`,
  `detail_state = "ready"`. A failover/escalation always records a resilience action; these
  recorded none. They were **not** escalations — they were first-choice dispatches.

### 2. Full log bodies confirm the client model (management API `/api/logs/<id>`)

Bedrock call `23027080-7e11-4734-a659-22f6cee87f5f`:
- `requestBody.model = "bedrock/global.openai.gpt-5.6-luna"`
- `comboName = "hybrid/planner"`, `comboStepId = "planner-t2-2"`, `apiKeyName = "zoo-m5"`
- `modelPinned = false`, `provider = "bedrock"`, `connectionId = d4a9a6e4-...`
- `tokens = { in: 2, out: 334, cacheRead: 0, compressed: 58294 }` — the real prompt is ~58K
  tokens (the AAR spec-lead/orchestrator system prompt), **compressed**. `tokens_in = 2` is a
  usage-accounting artifact of the compression/cache path, **not** a tiny request. This corrects
  the earlier "tokens_in=2 shape" hypothesis.

GLM call `f727d123-177d-4066-8401-0acb29162a83` (same key `zoo-m5`, same combo):
- `requestBody.model = "llama-cpp/ds4-glm53"`
- `comboStepId = "planner-t1-0"`, `provider = "llama-cpp"`, `tokens.in = 1313`, `cacheRead = 1309`.

Same key, same combo, GLM idle in both windows — the only difference is the requested model.

### 3. Live reproduction (zoo key, `x-combo: hybrid/planner`, GLM idle in both)

```
# A — requested model = tier-2 member  → routes to Bedrock connection
curl -s -D- -H "Authorization: Bearer $ZOO" -H "x-combo: hybrid/planner" \
  -X POST https://omniroute.celestium.life/v1/chat/completions \
  -d '{"model":"bedrock/global.openai.gpt-5.6-luna","max_tokens":4,
       "messages":[{"role":"user","content":"hi"}]}'
# → x-omniroute-selected-connection-id: d4a9a6e4-...   (the SAME Bedrock connection as the 64 logged calls)

# B — requested model = tier-1 member  → routes to GLM connection
curl -s -D- -H "Authorization: Bearer $ZOO" -H "x-combo: hybrid/planner" \
  -X POST https://omniroute.celestium.life/v1/chat/completions \
  -d '{"model":"llama-cpp/ds4-glm53","max_tokens":4,
       "messages":[{"role":"user","content":"hi"}]}'
# → HTTP 200, x-omniroute-provider: llamacpp, x-omniroute-model: ds4-glm53,
#   x-omniroute-selected-connection-id: 70b82fc9-...  (the tier-1 planner GLM connection)
```

Same key, same `x-combo`, same instant, GLM idle both times. The requested model string alone
decides the connection. (Request A returns 400 only because the 1-token test body trips a
Bedrock-side precheck; the routing had already selected Bedrock — exactly the behavior under
investigation.)

---

## Why each prior hypothesis is ruled out

- **Question A / tier-1 skip code path** — ruled out. The candidate skip paths in
  `open-sse/services/combo/executeTargetAttempt.ts` do not fire:
  - **Predictive TTFT Circuit Breaker** (`executeTargetAttempt.ts:189-213`, predicate
    `shouldSkipForPredictedTtft` at `open-sse/services/combo/comboPredicates.ts:187-196`) is gated
    on `deps.config.zeroLatencyOptimizationsEnabled === true`. The effective config is **false**:
    `DEFAULT_COMBO_CONFIG.zeroLatencyOptimizationsEnabled = false`
    (`open-sse/services/comboConfig.ts:159`), the live global `comboDefaults` has
    `zeroLatencyOptimizationsEnabled: false` and no `predictiveTtftMs`
    (`GET /api/settings/combo-defaults`), and the `hybrid/planner` combo row sets neither. The
    cascade in `resolveComboConfig` (`comboConfig.ts:~290-320`) therefore resolves it to false, so
    the breaker is inert.
  - **Hard concurrency cap skip** (`executeTargetAttempt.ts:388-445`, gate in
    `open-sse/services/combo/connectionConcurrencyGate.ts`) only skips a local GPU target on
    semaphore **saturation**. It cannot fire for an idle GLM, and it records
    `reason: "concurrency_cap_hard"` when it does — absent from all 64 rows.
- **Question B / discriminator** — it is the **request body `model` field**, read as the combo
  member selector. Confirmed by the three evidence blocks above. Not the 2-token shape (that was a
  compression artifact), not `compression_enabled` on the key, not an `X-OmniRoute-Tier` header
  (`open-sse/services/combo/tierCeiling.ts:resolveComboTierCeiling` only *clamps* a ceiling the
  client sends and is absent/`null` here), not prompt caching.
- **Question C / tier-1 context_length 1048576 vs real 163840** — not implicated for these calls.
  `evaluateContextLimit` (`open-sse/services/combo/contextOverrideGate.ts`) only *rejects* a target
  when the request **exceeds** a known limit; a request can never be pushed *off* tier-1 for being
  too small, and the escalations never reached a tier-1 context check because the client didn't ask
  for tier-1. This mismatch is a real latent bug (a true >160K-token planner request to
  `llama-cpp/ds4-glm53` would be admitted by the inflated `maxInputTokens:1048576` and then fail at
  the GLM, which only serves 160K) but it is **not** the cause of the Bedrock routing seen here.
- **Question D / reproduction** — done above; deterministic.

---

## Recommended fix

### Primary (correct) fix — CLIENT-SIDE, in nervcenter

Change the nervcenter agent profile so the planner/orchestrator role requests the **tier-1 planner**
instead of the literal tier-2 model. Options, in order of preference:

1. **Point the planner role at the combo, not a member** — set the planner model to
   `hybrid/planner` (and let the combo's `priority` strategy pick tier-1 GLM first, overflowing to
   tier-2 only on real tier-1 saturation). This is the intended usage and preserves failover.
   *Tradeoff:* none meaningful; this is what the combo exists for.
2. **If the profile must name a concrete model**, change
   `bedrock/global.openai.gpt-5.6-luna` → `llama-cpp/ds4-glm53` for the planner role.
   *Tradeoff:* pins to GLM with no automatic tier-2 overflow if GLM is down; prefer option 1.

This matches the user's instruction ("move it to l1") and is the complete fix. **No OmniRoute change
is needed.**

### Optional server-side hardening (NOT required for this incident)

- **Correct the tier-1 planner context declaration.** In `pool/tier1/planner`
  (`id 961f204a-...`), `weightedTargetPolicies["llama-cpp/ds4-glm53"].maxInputTokens` and
  `context_length` are `1048576`, but the deployed GLM serves only `163840` (160K). Lower both to
  `163840` (or set a `model_context_override` of 163840 for `ds4-glm53`, which
  `contextOverrideGate.ts` treats as authoritative). *Tradeoff:* genuinely large planner prompts
  will then correctly overflow past GLM instead of being sent to it and failing — a correctness
  gain. This is unrelated to the Bedrock routing but worth fixing to prevent a separate class of
  tier-1 failures.
- **Optional guardrail:** if the intent is that `zoo-m5` must never reach tier-2 planners, pin the
  key with `X-OmniRoute-Tier: 1` or set a per-key tier cap. `tierCeiling.applyTierCeilingToCombo`
  (`open-sse/services/combo/tierCeiling.ts`) would then drop tier>1 steps. *Tradeoff:* this clamps
  the combo ladder but does **not** stop a client that directly names a non-tier-1 member model
  outside the combo; direct member requests bypass the ceiling, so this is a weaker backstop than
  the client-side fix.

### Server-side vs client-side verdict

**CLIENT-SIDE.** The authoritative fix is in the nervcenter Zoo profile/mode configuration (point
the planner role at `hybrid/planner` or `llama-cpp/ds4-glm53`). The OmniRoute server behaved
correctly throughout: it routed each request to the member the client explicitly named. The only
server-side item worth doing is the independent context-length correction, which is hardening, not
a fix for this leak.

---

## Appendix — key file references

- `open-sse/services/combo/executeTargetAttempt.ts:189-213` — Predictive TTFT breaker (gated off).
- `open-sse/services/combo/executeTargetAttempt.ts:388-445` — per-(connection,model) hard cap skip.
- `open-sse/services/combo/comboPredicates.ts:178,187-196` — `PREDICTIVE_TTFT_MIN_SAMPLES=5`, `shouldSkipForPredictedTtft`.
- `open-sse/services/combo/connectionConcurrencyGate.ts` — hard-cap semaphore (local GPU providers).
- `open-sse/services/combo/tierCeiling.ts` — `X-OmniRoute-Tier` ceiling (absent for these calls).
- `open-sse/services/combo/contextOverrideGate.ts:evaluateContextLimit` — context-fit check (rejects only oversize).
- `open-sse/services/comboConfig.ts:159,167` and `resolveComboConfig` cascade — resolves `zeroLatencyOptimizationsEnabled=false`.
- Live: `GET /api/settings/combo-defaults` → `zeroLatencyOptimizationsEnabled:false`, no `predictiveTtftMs`.
- Live: `GET /api/combos` → `hybrid/planner` config has no zero-latency/TTFT keys; `pool/tier1/planner` declares `maxInputTokens:1048576` for `ds4-glm53` (real window 163840).
- Call logs: 77× `planner-t1-0`/`llama-cpp/ds4-glm53`; 64× `planner-t2-2`/`bedrock/global.openai.gpt-5.6-luna` (0 with resilience_actions).

*Content from OmniRoute source and live API was summarized/rephrased for this report.*
