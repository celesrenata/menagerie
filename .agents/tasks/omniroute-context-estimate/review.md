# Reasoning-aware input estimate and per-target input policy at the chatCore pre-flight gate

The pre-flight gate was over-counting Zoo agent requests by about 2.2x. Historical assistant `reasoning_content` (about 289K chars in the reference body) was counted at chars/4 even though the translator strips it before the request reaches `vllm/qwen3.8-27b-nvfp4`. The gate also applied the target-wide `max_input_tokens` 98304 override and ignored the combo's `weightedTargetPolicies` 524288. Commit `1d48e1cfd` fixes this in four parts. A shared `resolveReasoningForwarding` predicate now drives both the translator and the estimator. Reasoning is excluded from the estimate when the translator strips it, and counted at 2.8 chars/token when it is forwarded. A configurable ×1.10 margin covers under-estimation. Admission is now `input ≤ window − outputReserve`, where the reserve is the client's max output or 16384, clamped to window/4. A combo per-target policy now outranks the override, bounded by `targetWindow − reserve`. On the reference fixture the estimate moves from 123,739 to 56,370 against a real 53,976 (+4.4%). A 155K body is still rejected, and the breakdown is logged at info. Verification evidence is present and detailed.

Watch for: `reasoning_details` is excluded from the stripped-mode estimate even though the translator's strip pass does not remove it (possible under-count, non-blocking). Forwarded mode sums all three reasoning fields, so a client that echoes duplicate copies is over-counted (likely, safe direction). The new margin and reserve apply to every target, so last-resort compaction now fires within about 16K of the window on prefix-cache paths too (confirmed behavior change, documented).

**Verdict**: APPROVED

## High-level view

The double-counting fix rests on a single strip/forward predicate. `translateRequest` and chatCore both call `resolveReasoningForwarding`, so the estimate and the wire output cannot drift on `reasoning_content`/`reasoning`. Tool-call arguments and tool schemas are each counted once: arguments inside the message JSON, schemas in the `tools` bucket. The JSON-escape overhead on arguments is part of the measured −5.2% raw bias that the 1.10 margin corrects. The one gap is `reasoning_details`, which the estimator treats as stripped but the translator does not strip.

Admission now has two layers. The window check rejects when `estimate × margin > contextLimit − reserve`. The input cap comes from `resolveInputTokenCapForGateWithSource`, where a combo policy ranks first, bounded by the target's own resolved window (131072) rather than the combo's declared `context_length` (262144). That bound keeps the 524288 policy from admitting anything the 5090 cannot hold. The result is 114,688 for combo traffic, while direct traffic keeps the 98304 override. The 57K request (estimate about 59K) passes both layers. The test suite shows a 155K estimate still rejected with `source combo-policy`.

All three tunables are env-configurable, range-checked, and fall back to defaults on bad input. `OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS=0` restores the legacy check. The info-level rejection line includes every bucket, plus raw total, margin, cap and its source, window, reserve, and the forwarding decision, which is what live debugging of the 5090 idling needs.

The last-resort compaction trigger and its target now use the same margin-plus-reserve budget as admission. That fixes a real inconsistency, but it also means near-window prompts on any target, including llama-cpp prefix-cache targets, are now compacted or rejected locally where they used to be sent.

<details>
<summary>Issues (4)</summary>

1. **`reasoning_details` strip asymmetry** (possible): `splitAssistantReasoning` excludes `reasoning_details` in stripped mode, but `OPENAI_INCOMPATIBLE_ECHO_FIELDS` only strips `reasoning_content`/`reasoning`. Either drop `reasoning_details` from the stripped-mode exclusion, or confirm that `reasoningInputPolicy` always removes it for OpenAI targets and note that in a comment.
2. **Duplicate reasoning fields summed in forwarded mode** (likely): clients that echo the same text as both `reasoning` and `reasoning_content` (or `reasoning_details`) are counted two or three times on llama-cpp/replay targets. Consider counting only the field the translator actually forwards, or the max of the three. Over-estimation only, so not blocking.
3. **Near-window compaction on prefix-cache targets** (confirmed behavior change): the margin and the 16K reserve now push last-resort compaction onto llama-cpp/GLM paths within the reserve of the window, which breaks the prefix cache. Watch for this after deploy. If churn shows up, a per-target reserve is the follow-up.
4. **Full suite not re-run after fixes** (informational): the four change-caused failures were re-verified only in focused runs. Let the next CI run be the full-suite confirmation before pushing.

</details>

<details>
<summary>Details</summary>

### Reasoning estimate tied to the translator's strip decision

`willForwardAssistantReasoning` returns `isReasoner || keepClientReasoning || targetFormat !== OPENAI`. That mirrors the `else if (!isReasoner && targetFormat === OPENAI)` branch in `translateRequest`, so for the 5090 the stripped `reasoning_content`/`reasoning` is excluded and reported as `reasoningStripped`. Non-OpenAI formats are treated as forwarding, which errs toward over-counting.

One edge does not match. In the strip branch, `keepClientReasoning` keeps only `reasoning_content` and still deletes `reasoning`. The predicate then treats the whole message as forwarded and counts both fields. That is an over-count and is safe.

The real asymmetry is `reasoning_details`. `ASSISTANT_REASONING_FIELDS` includes it, so stripped mode removes it from the estimate, but the translator's strip list does not:

```ts
const OPENAI_INCOMPATIBLE_ECHO_FIELDS = ["reasoning_content", "reasoning", "refusal", "annotations", "cache_control"]
```

`reasoningInputPolicy.stripChatReasoningDetails` may remove it on some transports. That was not traced. If it survives to vLLM, the effect depends on whether the chat template renders it. Qwen templates most likely ignore it, which is why this is possible rather than likely. Still, it breaks the "single source of truth" claim.

In forwarded mode, `reasoningChars` sums every present field. OpenRouter-style clients echo `reasoning` and `reasoning_details` with the same content, so the reasoning bucket can double. That is safe for admission but could reject llama-cpp requests that would fit.

### Input cap precedence and the policy bound

```
combo request ─► policy (weightedTargetPolicies, nearest ancestor)
                   └─ min(policy, targetWindow − min(reserve, window/4))   source=combo-policy
               ─► else max_input_tokens override                            source=override
               ─► else combo context override                               source=combo-context-override
               ─► else catalog                                              source=catalog
direct request ─► override ─► catalog
```

The policy now outranks an explicit `max_input_tokens` override, which the old docstring called "never bypassed". The user asked for the policy to be honored. The bound to the target's own `getResolvedModelCapabilities().contextWindow` keeps that safe. When the target's window is unknown, the raw policy is returned unbounded, and the separate window check against `finalContextLimit` is the only guard. For a nested combo that declares 262144 in front of a 131072 model, that guard is too loose. Not an issue for the 5090, because its window resolves.

The cap call passes a reserve computed against `POSITIVE_INFINITY` and re-clamps it to window/4 inside, so it agrees with the window check's reserve when the windows match.

### Compaction triggers

The last-resort trigger and target now match admission, which prevents compacting to a budget that is then rejected. `#10503` caught that bug. The proactive trigger subtracts `reasoningStripped`, computed from `adaptBodyForCompression(body).body.messages`, from an `estimatedTokens` that was computed over `allMessages`. If those two arrays differ (Responses `input` shapes), the subtraction is approximate, but it is floored at 0.

### Test coverage

The coverage is strong. It includes a fixture that reproduces the real body's JSON sizes, ±15% calibration assertions against vLLM `/tokenize` ground truth, and black-box `handleChatCore` tests that check 54K/57K admitted, 105K direct-rejected versus combo-admitted, 155K rejected with the info log, and llama-cpp forwarded at 170K rejected.

Not tested:

- `reasoning_details`-only or duplicate-field reasoning
- a combo policy on a target with an unknown window
- a Responses-format body through the proactive-compaction subtraction

</details>

<details>
<summary>File map</summary>

- `open-sse/translator/reasoningForwarding.ts`: new shared strip/forward predicate
- `open-sse/translator/index.ts`: uses the predicate, no wire change
- `open-sse/utils/assistantReasoning.ts`: non-mutating reasoning split
- `open-sse/handlers/chatCore/contextEstimateConfig.ts`: env tunables
- `open-sse/handlers/chatCore/contextEstimation.ts`: forward/strip/margin options, breakdown formatter
- `open-sse/handlers/chatCore/outputTokenBudget.ts`: output reserve resolution and check
- `open-sse/services/combo/targetInputPolicy.ts`: nested `weightedTargetPolicies` lookup
- `src/lib/modelCapabilities.ts`: cap with source, combo policy precedence
- `open-sse/handlers/chatCore.ts`: wiring, compaction alignment, info rejection log
- `open-sse/services/combo/comboStructure.ts`, `capabilityFilter.ts`: advisory filter excludes reasoning and applies the margin
- `.env.example`, `docs/reference/ENVIRONMENT.md`: new env vars
- `tests/unit/*`: new calibration, policy, gate, forwarding, and budget tests; adjusted thresholds in existing tests

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute show 1d48e1cfd`

</details>
