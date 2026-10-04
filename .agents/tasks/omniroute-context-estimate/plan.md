# OmniRoute context estimate / input cap — Implementation Plan

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo` (HEAD a2169c18f). Work on the branch directly. No changesets, no CHANGELOG edits, no push.

## Findings (measured, 2026-10-03)

### Where the rejection happens

- Message built in `open-sse/handlers/chatCore.ts` ~L2270 (`Input exceeds maximum input tokens for …`, `log.warn("CONTEXT", …)`, HTTP 400 `context_length_exceeded`), after `enforceOutputTokenBudget()` (`open-sse/handlers/chatCore/outputTokenBudget.ts`) returns `ok:false` with `maxInputTokens` set.
- Estimate: `estimateFinalInputTokens(body)` (`open-sse/handlers/chatCore/contextEstimation.ts`) = `estimateTokens(messages) + estimateTokens(tools) + system + instructions`; `estimateTokens` (`open-sse/services/contextManager.ts:316`) = `ceil(jsonLength(node) / 4)` (`CHARS_PER_TOKEN = 4`, L70) over the whole serialized message array. It runs on the client-shaped body BEFORE `translateRequest()` (~L2644).
- Cap: `resolveInputTokenCapForGate({provider, model}, {isCombo})` (`src/lib/modelCapabilities.ts:1014`). Step 1, an explicit `max_input_tokens` capability override, always wins. The live DB has `vllm/qwen3.8-27b-nvfp4 → context_length 131072, max_input_tokens 98304`.
- 98304 does not come from a 0.75 factor in OmniRoute. It's an operator capability override written by the esnixi switcher / `home/programs/omniroute-routing.py` layouts as `context − 32768` (131072 − 32768; see `.agents/tasks/reader-fabric-coder-context/plan.md`). The 32768 reserve just happens to be 25% of 131072.
- `pool/tier1/code` `config.weightedTargetPolicies.*.maxInputTokens: 524288` has zero readers in `open-sse/` or `src/`. It's inert passthrough JSON, outside the combo Zod schema (also documented in `.agents/tasks/omniroute-tier1-priority/findings.md` §1/§6). That's why it never applies.
- The same inflated estimate also feeds the advisory combo compatibility filter: `estimateRequestInputTokens()` in `open-sse/services/combo/comboStructure.ts:500` (and its twin in `src/shared/constants/capabilities/capabilityFilter.ts:59`) → `evaluateContextLimit` (`open-sse/services/combo/contextOverrideGate.ts`). It also feeds the proactive-compression trigger `estimateTokens(allMessages)` (chatCore L1430).

### Root cause of the 2.2x over-estimate: historical `reasoning_content`

Call log `/app/data/call_logs/2026-10-03/2026-10-03T12-44-10.465Z_7e4b7bcb-….json` (hybrid/code → Bedrock code-t2-qcn, `tokens.in 52489`):

- 113 messages, 22 tools. JSON chars: messages 455,359 total, of which **assistant `reasoning_content` = 289,377 (64%)** across 26 assistant turns. System 54,255; tool results 57,634; user 18,989; tool_calls 16,640; tools 39,640.
- Ground truth from the 5090's own tokenizer (vLLM `POST /tokenize` on esnixi `127.0.0.1:8010`, chat template applied, mid-conversation memory system message merged into system[0]):

| payload                                                                           | real tokens (vLLM) | chars/4 estimate               |
| --------------------------------------------------------------------------------- | ------------------ | ------------------------------ |
| full body as sent by Zoo (`reasoning_content` present)                            | **53,976**         | ~123.7K (gate logged 128–130K) |
| same, `reasoning_content` removed                                                 | **53,976**         | ~51.2K (−5.2%)                 |
| same, no tools                                                                    | 44,497             | ~41.2K (−7.3%)                 |
| tools alone (diff)                                                                | 9,479              | 9,910 (+4.5%)                  |
| all reasoning renamed to `reasoning` (field this vLLM's Qwen3.8 template renders) | 154,252            | —                              |

- Conclusion: the translator strips `reasoning_content`/`reasoning` for non-reasoner OpenAI targets (`open-sse/translator/index.ts` ~L842, `OPENAI_INCOMPATIBLE_ECHO_FIELDS`, gated by `!isReasoner` and `keepClientReasoning = isPrefixCacheSensitive(...)`). vLLM/qwen3.8 and Bedrock never see the reasoning, so the real prompt is ~54K. The gate counts it anyway because it estimates before translation. chars/4 itself is fine (−5% on this payload). Nothing else is double-counted: tools are counted once in the gate, and the proactive check counts them only as a reserve.
- When reasoning IS forwarded and rendered (llama-cpp GLM prefix-cache path, DeepSeek/Kimi replay targets), it tokenizes densely: 289,377 chars → 100,276 tokens (2.89 chars/token), and one 31,738-char block → 12,473 tokens (2.54). chars/4 under-counts forwarded reasoning by ~28–37%, which is dangerous.
- Separate note: the Bedrock-bound body had a mid-conversation `Memory context:` system message, and vLLM's Qwen3.8 template rejects that ("System message must be at the beginning"). Live logs show memory injection for `vllm/qwen3.8-27b-nvfp4` uses `strategy:"system-first"`, so it shouldn't hit the 5090. Live-verify must still confirm a 5090 success after deploy.

## Design decisions

1. **Estimate the reasoning the target will actually receive.** Move the translator's strip/forward decision into one exported pure predicate, `willForwardAssistantReasoning()`, used by both `translateRequest` and the estimator so they can't drift. Stripped reasoning counts as 0. Forwarded reasoning counts at a denser ratio (default 2.8 chars/token, measured). This is behavior-preserving on the wire. We don't strip anything new, and Zoo's preserveReasoning and the prefix-cache forwarding from c4c83b892 stay intact.
2. **Modest safety margin on the admission estimate only.** Multiply the gate/compat-filter estimate by `OMNIROUTE_CONTEXT_ESTIMATE_MARGIN` (default 1.10). chars/4 measured −5.2% on the real payload, so ×1.10 lands at about +4% (≈56.3K vs 53,976 real), inside the ±15% target and biased high. Compression thresholds stay unchanged and don't get the multiplier, to avoid new compression churn.
3. **Output reserve instead of a flat static cap.** Admission requires `input ≤ contextLimit − outputReserve`. `outputReserve` = the client's `max_tokens`/`max_completion_tokens`/`max_output_tokens` when present, clamped to the model output cap; otherwise `OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS` (default 16384). The reserve is always clamped to `floor(contextLimit / 4)` so small-window models keep at least 75% for input. Setting the env to `0` restores today's `≥1 token` behavior. For the 5090 with no `max_tokens` (Zoo sends none), that gives 131072 − 16384 = 114688.
4. **Honor the per-target combo policy.** Add a reader for `config.weightedTargetPolicies[<modelStr>].maxInputTokens` on the dispatching combo and any nested combo that contains the target (hybrid/code → pool/tier1/code). For combo requests the precedence is: combo per-target policy > explicit `max_input_tokens` capability override > existing chain. The result is always also bounded by decision 3 (`contextLimit − reserve`), so 524288 can never admit more than the real window. Rationale: the combo policy is the most specific operator declaration for this target. Direct (non-combo) requests are unchanged, so the override stays "never bypassed" for them. Update the `resolveInputTokenCapForGate` docstring accordingly.
5. **Info-level breakdown on rejection.** Extend `FinalInputTokenBreakdown` with `reasoning` (counted), `reasoningStripped` (raw chars/4 of excluded reasoning), `margin`, and `rawTotal`. When the gate rejects, log `log.info("CONTEXT", …)` with messages/tools/system/instructions/reasoning/reasoningStripped/margin/cap/contextLimit/outputReserve/capSource. Keep the existing warn line.

Env vars (all read per call through a small helper with validated parsing and fallback to defaults on invalid values):

- `OMNIROUTE_CONTEXT_ESTIMATE_MARGIN`: float in [1.0, 2.0], default 1.10.
- `OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN`: float in [1.0, 8.0], default 2.8.
- `OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS`: int ≥ 0, default 16384.

## Implementation Plan

- [ ]   1. Extract the reasoning strip/forward predicate from the translator.
       Add `export function willForwardAssistantReasoning(params: { provider; model; targetFormat; body; credentials? }): boolean` in `open-sse/translator/index.ts`, or better in a new `open-sse/translator/reasoningForwarding.ts` that index.ts imports. It returns true when `isReasoner` (via `requiresReasoningReplay` with the same `replayRequirements` built at L400–410: `hasThinkingConfig(body)`, `supportsReasoning`, `interleavedField`), when `isPrefixCacheSensitive(provider, resolveConnectionCacheOverride(credentials?.providerSpecificData))`, or when `targetFormat !== FORMATS.OPENAI` (Claude/Gemini/Responses targets keep reasoning as thinking blocks, so stay conservative). Refactor `translateRequest` to compute `isReasoner`/`keepClientReasoning` through the same helper with no output change.
       Files: `open-sse/translator/index.ts`, new `open-sse/translator/reasoningForwarding.ts`, new test `tests/unit/translator-reasoning-forwarding.test.ts`.
       Verify: new test proves `vllm`/`qwen3.8-27b-nvfp4` OpenAI target → false; `bedrock`/`qwen.qwen3-coder-next` → false; `llama-cpp`/`ds4-glm53` (prefix-cache sensitive) → true; `deepseek`/`deepseek-v4-flash` with thinking → true. Run `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/translator-reasoning-forwarding.test.ts` plus the existing reasoning-replay translator tests (`ls tests/unit | grep -i reasoning` and run the replay/forwarding ones, including `tests/unit/prefix-cache-sensitive.test.ts` and `tests/unit/glm53-prefix-stability.test.ts`). All pass.

- [ ]   2. Make the estimator reasoning-aware, calibrated, and margin-bearing.
       In `open-sse/handlers/chatCore/contextEstimation.ts`, add an options arg `{ forwardReasoning?: boolean; applyMargin?: boolean }` to `estimateFinalInputTokenBreakdown`/`estimateFinalInputTokens`. Measure assistant-message `reasoning_content`, `reasoning`, and `reasoning_details` separately: clone each message without those keys for the `messages` bucket (don't mutate the body). If `forwardReasoning`, `reasoning = ceil(chars / OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN)`; otherwise 0, with the raw value recorded as `reasoningStripped`. `total = ceil((messages + tools + system + instructions + reasoning) × margin)` when `applyMargin`, and `rawTotal` = the sum without margin. The default when options are omitted must be `forwardReasoning: true, applyMargin: false`, so existing callers and tests stay byte-identical. Put the env helpers (`getContextEstimateMargin`, `getReasoningCharsPerToken`, `getContextOutputReserveTokens`) in a new `open-sse/handlers/chatCore/contextEstimateConfig.ts`.
       Files: `open-sse/handlers/chatCore/contextEstimation.ts`, new `open-sse/handlers/chatCore/contextEstimateConfig.ts`, extend `tests/unit/chatcore-context-estimation.test.ts`.
       Verify: run `tests/unit/chatcore-context-estimation.test.ts` (same node command as item 1). Existing cases pass unchanged. New cases cover the env helpers' defaults and invalid-value fallback, stripped vs forwarded reasoning, and that the margin applies only when requested.

- [ ]   3. Add a calibration fixture test against measured ground truth.
       New `tests/unit/context-estimate-calibration.test.ts` with a deterministic builder `buildZooLikeBody()` (keep it in the test file or `tests/unit/fixtures/zooLikeBody.ts`). It reproduces the real 12:44Z request's shape and per-component char lengths with synthetic, non-private prose and code-like filler (no real user content): 1 system of 54,255 chars, 112 more messages in the same role sequence (u/a/t pattern with 26 assistant turns carrying reasoning_content totalling 289,377 chars), tool results totalling ~57,600, user ~19,000, tool_calls ~16,600, and 22 tool schemas totalling ~39,640. Hardcode the ground truth from vLLM `/tokenize`: `REAL_TOKENS_FULL = 53976`, `REAL_TOKENS_NO_TOOLS = 44497`, plus a comment recording the method and date. Assertions:
       (a) `estimateFinalInputTokens(body, { forwardReasoning:false, applyMargin:true })` is within ±15% of 53,976 and ≥ 53,976 × 0.97, so it's biased high;
       (b) with `forwardReasoning:true` the estimate is ≥ 154,252 × 0.85, covering the forwarded-and-rendered case;
       (c) the old pre-fix behavior (`estimateFinalInputTokens(body)` with defaults) is > 98304, documenting the bug.
       Files: new test (and optional fixture builder).
       Verify: run the new test file. It passes.

- [ ]   4. Output-reserve-aware budget check.
       In `open-sse/handlers/chatCore/outputTokenBudget.ts`, add an optional trailing param `outputReserveTokens?: number | null` to `enforceOutputTokenBudget`. After the input-cap check, reject (`ok:false`, include `outputReserveTokens` in the result) when `input > contextLimit − reserve`. Compute the reserve in a new exported helper `resolveOutputReserveTokens(body, contextLimit, modelOutputCap)`: max of the positive client output fields when present, else `getContextOutputReserveTokens()`, then clamp to `modelOutputCap` and to `floor(contextLimit / 4)`. Null/0 keeps legacy behavior byte-identical. Keep the existing `availableOutputTokens < 1` check and the output-field clamping.
       Files: `open-sse/handlers/chatCore/outputTokenBudget.ts`, extend `tests/unit/output-token-budget.test.ts`.
       Verify: run `tests/unit/output-token-budget.test.ts` and `tests/unit/output-token-budget-model-cap.test.ts`. Existing tests pass. New tests cover: 57,000 input at contextLimit 131072 with default reserve → ok; 120,000 input at 131072 → rejected (exceeds 131072 − 16384); client `max_tokens: 4096` → reserve 4096; reserve clamped to contextLimit/4 on a 32768 model; env `0` → legacy.

- [ ]   5. Per-target combo input policy reader and cap precedence.
       Add `resolveComboTargetInputPolicy({ comboConfig, allCombos, provider, model }): number | null` in new `open-sse/services/combo/targetInputPolicy.ts`. It reads `config.weightedTargetPolicies` (accepting either `combo.config.weightedTargetPolicies` or top-level `combo.weightedTargetPolicies`; check the live shape with `GET /api/combos` or the DB row for `pool/tier1/code` and support the real one), matching keys `${provider}/${model}` and the step `modelStr`, recursing through nested combo references with cycle protection (Set of visited names). It returns the positive integer `maxInputTokens` or null. Extend `resolveInputTokenCapForGate` in `src/lib/modelCapabilities.ts` with an optional `{ comboTargetInputPolicy?: number | null }`: when `isCombo` and the policy is set, return `min(policy, contextWindow-if-known)` ahead of the explicit override. Update the docstring to give the new precedence and the reason. Also extend the advisory combo filter: thread the policy into `contextOverrideGate.evaluateContextLimit`'s capabilities via `comboStructure.ts` `hasKnownCompatibleContextLimit`/`getTargetCompatibilityFailures`, so the policy also stops the filter from dropping the target. Keep this minimal and pass `maxInputTokens: policy` when present.
       Files: new `open-sse/services/combo/targetInputPolicy.ts`, `src/lib/modelCapabilities.ts`, `open-sse/services/combo/comboStructure.ts`, new `tests/unit/combo-target-input-policy.test.ts`, and update `tests/unit/chatcore-combo-context-override-rescue.test.ts` only if its assertions encode the old precedence.
       Verify: run the new test, `tests/unit/chatcore-combo-context-override-rescue.test.ts`, `tests/unit/combo-catalog-max-input-tokens.test.ts`, `tests/unit/model-capability-overrides.test.ts`, and `tests/unit/combo-effort-suffix-context-override-12475.test.ts`. They pass. The new test proves: a nested hybrid → pool policy 524288 on a 131072 target with override 98304 resolves the cap to 131072 for combo and 98304 for direct; no policy → 98304 (unchanged); cycles terminate.

- [ ]   6. Wire it into chatCore and the combo filter, with the info breakdown log.
       In `open-sse/handlers/chatCore.ts`:
       (a) Compute `forwardReasoning = willForwardAssistantReasoning({ provider, model: effectiveModel, targetFormat, body, credentials })` once before the gate.
       (b) Final gate (~L2210/L2240): use `estimateFinalInputTokenBreakdown(body, { forwardReasoning, applyMargin: true })` for `finalEstimatedInputTokens`. Keep the last-resort compaction trigger on the raw (no-margin) reasoning-aware total.
       (c) In the existing combo-limit block (~L2060–2112), where `comboConfig` and `getCombosCached()` are already loaded, also compute `comboTargetInputPolicy` via item 5, hoisted to function scope like `contextLimit`, and pass it to `resolveInputTokenCapForGate`.
       (d) Pass `resolveOutputReserveTokens(body, finalContextLimit, modelOutputCap)` to `enforceOutputTokenBudget`, honoring `contextWindowChecksDisabled` (null when disabled).
       (e) On `ok:false`, keep the warn message (wording may add `reserve N` when the reserve caused it) and add `log.info("CONTEXT", "Pre-flight rejected <provider>/<model>: estimate <total> (raw <rawTotal> × margin <m>) = messages <n> + tools <n> + system <n> + instructions <n> + reasoning <n> (stripped <n>); cap <cap> (source policy|override|catalog), context <limit>, output reserve <r>")`.
       (f) Proactive compression (L1430/L1720): estimate messages without stripped reasoning, i.e. `estimateFinalInputTokenBreakdown({messages: allMessages}, { forwardReasoning }).messages + .reasoning`, so stripped reasoning no longer triggers compression. Also update `estimateRequestInputTokens` in `open-sse/services/combo/comboStructure.ts` and `src/shared/constants/capabilities/capabilityFilter.ts` to exclude assistant reasoning fields with ×margin. The filter is advisory and per-target forwarding isn't known there, so excluding reasoning is acceptable (the hard gate stays authoritative). Note this choice in a comment.
       Files: `open-sse/handlers/chatCore.ts`, `open-sse/services/combo/comboStructure.ts`, `src/shared/constants/capabilities/capabilityFilter.ts`, new `tests/unit/chatcore-preflight-reasoning-gate.test.ts`. Model it on `tests/unit/chatcore-combo-context-override-rescue.test.ts`'s harness, using `src/test-utils` helpers where they fit.
       Verify: run the new test plus the item 5 test list and `tests/unit/chatcore-context-estimation.test.ts`. The new chatCore-level test proves:
       (1) the Zoo-like ~54K-real fixture with 289K chars of reasoning_content, routed to `vllm/qwen3.8-27b-nvfp4` (context 131072, override 98304), is admitted, with no 400 and the request reaching the mocked executor;
       (2) the same with a combo per-target policy 524288 is admitted;
       (3) a genuinely oversized body (~140K real-sized non-reasoning content) is still rejected with 400 `context_length_exceeded`, and the info breakdown line is logged with the reasoning bucket;
       (4) a `llama-cpp` prefix-cache target with forwarded reasoning still counts it, so a reasoning-heavy body over the window is rejected.

- [ ]   7. Static checks and one full run.
       From the OmniRoute root: `npm run typecheck:core`, `npm run typecheck:noimplicit:core`, then `npx eslint --suppressions-location config/quality/eslint-suppressions.json <each changed/new file>` with zero new warnings or suppressions (counts must not increase). Run the full `npm run test:unit` exactly once at the end, since it pegs the Mac CPU. Run focused files individually before that. Pre-existing unrelated failures must be compared against a `git stash` baseline only if any appear, and reported rather than fixed.
       Files: none new.
       Verify: both typechecks exit 0, eslint is clean on the changed files, and the full unit suite has no new failures.

- [ ]   8. Commit locally (no push) and record numbers.
       Make one or two conventional commits, e.g. `fix(context): estimate only forwarded reasoning in pre-flight gate` and `feat(combo): honor per-target maxInputTokens policy with output reserve`. In the step report, record: estimate vs real for the fixture (forwardReasoning false/true), the 5090 effective cap before/after (98304 → 114688 via policy+reserve; 98304 via override when no policy), and the env defaults.
       Verify: `git log --oneline -3` shows the commits and `git status` is clean, apart from untracked files that predate the work.

## Live verification guidance (for the deploy / live-verify steps)

- After deploy, `kubectl -n omniroute logs deploy/omniroute --since=15m | grep -E "CONTEXT|code-t1-0"` should show no `Input exceeds maximum input tokens for vllm/qwen3.8-27b-nvfp4` for Zoo requests around 55K real tokens. Any pre-flight rejection should come with the new info breakdown. The 5090 should get `code-t1-0` attempts that succeed (call_logs `provider: vllm`, `tokens.in` near the vLLM count).
- Ground-truth check method: take a call log `requestBody`, merge any mid-conversation system message into system[0], scp it to esnixi, and run `curl -s -H 'content-type: application/json' --data @body.json 127.0.0.1:8010/tokenize` (payload `{model:"qwen3.8-27b-nvfp4", messages, tools, add_generation_prompt:true}`). The returned `count` is the real prompt size.
- Watch for a vLLM 400 "System message must be at the beginning". It means memory injection placed a mid-conversation system message on the vLLM path, which is a separate bug and should be reported, not masked.

## Workflow note

The tail was not restructured. The change is one tightly coupled code path (estimator → cap → chatCore gate), and the existing `build-loop` → `deploy` → `live-verify` steps already fit it. The loop's stop contract is unchanged: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/omniroute-context-estimate/review.json`, `verdict` = `APPROVED`.
