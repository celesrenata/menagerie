# Verification: OmniRoute context estimate / input cap

Repo `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`. First iteration (no review.json existed). Committed as `1d48e1cfd` (parent `a2169c18f`), not pushed; the commit hooks (lint-staged prettier/eslint, docs-sync, any-budget) passed. No changeset or CHANGELOG edits.

## Before / after numbers (realistic ~55K-token payload)

Fixture: `tests/unit/fixtures/zooLikeBody.ts`. It is a deterministic, synthetic reproduction of the 12:44:10Z Zoo request: 113 messages, 22 tools, and 26 reasoning turns carrying 289,377 chars of `reasoning_content`. It reproduces the real body's JSON sizes (messages 455,322 vs 455,359 real; tools 39,629 vs 39,640). Ground truth comes from vLLM `/tokenize` on the 5090 (see plan).

| payload                                                      | real (vLLM) | before (legacy gate estimate)           | after (gate estimate)                       | error after |
| ------------------------------------------------------------ | ----------- | --------------------------------------- | ------------------------------------------- | ----------- |
| full body, target strips reasoning (vllm/qwen3.8)            | 53,976      | **123,739** (live gate logged 128–130K) | **56,370** (raw 51,245 × 1.10)              | +4.4%       |
| same, no tools                                               | 44,497      | —                                       | 45,471                                      | +2.2%       |
| tools alone                                                  | 9,479       | 9,908                                   | 9,908                                       | +4.5%       |
| reasoning forwarded and rendered (llama-cpp, replay targets) | 154,252     | 123,739 (−20%, under-count)             | 170,054 (reasoning at 2.8 chars/tok, ×1.10) | +10.2%      |
| fixture scaled to ~57K real                                  | ~57,000     | —                                       | 59,273                                      | +4.0%       |

5090 (`vllm/qwen3.8-27b-nvfp4`, window 131072, `max_input_tokens` override 98304) effective input cap:

- Before: 98,304 for combo and direct requests. The `weightedTargetPolicies` 524288 was ignored.
- After, combo request through hybrid/code → pool/tier1/code: **114,688**, from `min(policy 524288, window 131072 − reserve 16384)` with source `combo-policy`. This holds even though hybrid/code declares `context_length 262144`, because the policy is bounded by the target's own window.
- After, direct request (or a combo with no policy): 98,304, from the override (unchanged).
- Window check: `input ≤ contextLimit − outputReserve`. The reserve is the client's `max_tokens`/`max_completion_tokens`/`max_output_tokens`, or 16384 when none is sent. It is clamped to the model output cap and to `window/4`.

Env defaults (new, documented in `.env.example` and `docs/reference/ENVIRONMENT.md`):

- `OMNIROUTE_CONTEXT_ESTIMATE_MARGIN=1.10` (range [1, 2])
- `OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN=2.8` (range [1, 8])
- `OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS=16384` (`0` restores the legacy ≥1-token check)
- Invalid values fall back to the defaults.

Example rejection log, now at info level from the chatCore test run:

```
CONTEXT Pre-flight rejected vllm/qwen3.8-27b-nvfp4: estimate 155401 (raw 141273 × margin 1.1) = messages 141273 + tools 0 + system 0 + instructions 0 + reasoning 0 (stripped 0); cap 114688 (source combo-policy), context 262144, output reserve 16384, forwardReasoning false
```

## What changed

- `open-sse/translator/reasoningForwarding.ts` (new): `resolveReasoningForwarding` and `willForwardAssistantReasoning`, the single strip/forward predicate. `translateRequest` now computes `isReasoner`/`requiresExplicitReasoningReplay` through it, with no wire change.
- `open-sse/utils/assistantReasoning.ts` (new): `splitAssistantReasoning`, a non-mutating split of `reasoning_content`/`reasoning`/`reasoning_details` out of assistant messages.
- `open-sse/handlers/chatCore/contextEstimateConfig.ts` (new): the env tunables.
- `contextEstimation.ts`: options `{ forwardReasoning, applyMargin }`. The breakdown gains `reasoning`, `reasoningStripped`, `margin`, and `rawTotal`, plus `formatFinalInputTokenBreakdown`. With options omitted the estimate is legacy and byte-identical.
- `outputTokenBudget.ts`: `resolveOutputReserveTokens`, plus a trailing `outputReserveTokens` param on `enforceOutputTokenBudget`. A null/0 reserve keeps legacy behavior.
- `open-sse/services/combo/targetInputPolicy.ts` (new): `resolveComboTargetInputPolicy` reads `config.weightedTargetPolicies[...]` (or the top-level shape). It walks nested combo-refs with nearest-ancestor precedence, protects against cycles, and stops at the depth limit. Matching the live DB shape was checked against `storage.sqlite` in the pod.
- `src/lib/modelCapabilities.ts`: `resolveInputTokenCapForGateWithSource` returns `{cap, source}`. A combo per-target policy now outranks the `max_input_tokens` override, bounded by `window − min(reserve, window/4)`. The old `resolveInputTokenCapForGate` is a wrapper. The docstring is updated.
- `chatCore.ts`:
    - `forwardReasoning` is computed once.
    - The combo policy is resolved in the existing combo-limit block.
    - The final gate uses the reasoning-aware estimate with the margin.
    - The reserve is passed to the gate.
    - The info breakdown is logged on rejection.
    - The warn message mentions the reserve when the reserve caused the rejection.
    - The proactive-compaction trigger subtracts stripped reasoning.
- `comboStructure.ts` and `capabilityFilter.ts` (advisory compat filter): the estimate excludes assistant reasoning and applies the margin.

## Deviations from the plan (and why)

1. The estimator's default (options omitted) is legacy mode, not `forwardReasoning:true`. Defaulting to true would change totals for existing callers, which contradicts the plan's "byte-identical" requirement.
2. The last-resort compaction trigger is aligned to the admission budget. It now fires when the margin-bearing total exceeds `window − reserve`, and compacts to `floor((window − reserve)/margin) − tools − 1`. Keeping it on the raw total let a compacted request be rejected on the margin/reserve it wasn't compacted for. `#10503 real chatCore path` caught this. With window checks disabled the old trigger and target are kept.
3. Proactive compaction only subtracts stripped reasoning. Forwarded reasoning keeps the legacy chars/4 count so prefix-cache (llama-cpp) paths get no new compaction churn.
4. The combo policy is not threaded into the advisory compat filter. `ResolvedComboTarget` carries no parent-combo config. With reasoning excluded, the filter no longer demotes the 5090 for these requests (about 56K estimate vs the 131072 context override verdict). The hard gate is authoritative.

## Existing tests adjusted (margin/reserve or source-shape, intent unchanged)

- `chatcore-context-estimation.test.ts`: the breakdown `deepEqual` now includes the new fields.
- `chatcore-combo-context-override-rescue.test.ts`: the prompt is 3.3M chars instead of 3.7M, so it stays between the catalog hint and the 1M override after ×1.10.
- `combo-context-window-filter.test.ts` (#7039): input is 240K instead of 256K. That is still between the buggy allowance and the 272K cap after ×1.10.
- `reactive-context-compaction-policy.test.mjs` and `codex-prompt-compression-passthrough.test.ts`: the source regex now matches `finalInputOverBudget && body`. The gate order (`reactiveContextCompactionEnabled && !nativeCodexPassthrough && …`) is preserved.

## New tests

- `tests/unit/translator-reasoning-forwarding.test.ts` (7 tests):
    - vllm/qwen3.8 → false
    - bedrock/qwen3-coder-next → false
    - llama-cpp/ds4-glm53 → true
    - connection prefix-cache override → true
    - deepseek-v4-flash with thinking → true
    - Claude target → true
    - predicate matches the `translateRequest` wire output
- `tests/unit/context-estimate-calibration.test.ts` (5 tests):
    - fixture self-check
    - stripped estimate within ±15% of 53,976 and ≥97% of it
    - no-tools within ±15% of 44,497
    - forwarded ≥85% of 154,252 and within ±15%
    - legacy estimate > 98304 (documents the bug)
- `chatcore-context-estimation.test.ts` (+6 tests): env defaults and invalid fallback, stripped vs forwarded reasoning, margin only when requested, legacy mode.
- `output-token-budget.test.ts` (+6 tests):
    - 57K at 131072 admitted
    - 120K rejected (boundary at 114688)
    - client `max_tokens` used as the reserve
    - clamp to the output cap and to window/4
    - env `0` gives legacy behavior
    - null reserve is byte-identical
- `tests/unit/combo-target-input-policy.test.ts` (8 tests):
    - direct policy and nested hybrid → pool policy
    - top-level shape
    - no policy → null
    - cycles terminate
    - combo cap 114688 (131072 without a reserve, 64000 when the policy is smaller)
    - direct request → 98304 (override)
    - combo with no policy → 98304
- `tests/unit/chatcore-preflight-reasoning-gate.test.ts` (5 tests, black-box `handleChatCore` with a temp DB and fetch stub; combos mirror the live config including `context_length` 262144/163840):
    1. The Zoo-like ~54K body reaches the 5090 upstream.
    2. The ~57K-real body is admitted to the 131072 target.
    3. A ~105K-estimate body: the direct request is rejected on override 98304, and the same body through hybrid/code is admitted via the policy.
    4. A ~155K-estimate body is still rejected with 400 `context_length_exceeded`, and the info breakdown is logged with `source combo-policy`.
    5. llama-cpp with forwarded reasoning is rejected at 170K vs 131072, with the reasoning bucket counted.

## Commands run and results

All commands ran from the OmniRoute root.

- `npm run typecheck:core` → exit 0.
- `npm run typecheck:noimplicit:core` → one error: `open-sse/services/combo/autoStrategy.ts(519,55) TS7006`. It is pre-existing: the identical error appears at baseline with my changes stashed. The file is untouched.
- ESLint on all 22 changed/new files exited 0 with zero warnings:
    ```
    npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0 <22 changed/new files>
    ```
    `config/quality/eslint-suppressions.json` is unchanged, so no new suppressions.
- `npx prettier --write` on the changed files.
- Focused runs used:
    ```
    DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=2 <files>
    ```
    - Broad related set: 31 files, 207/207 pass. It covered the new tests, output-token-budget*, combo-context-* (window-filter, requirements, length, generic-default, overflow-compression-probe), the rescue test, 8378, catalog-max-input, model-capability-overrides, 12475, prefix-cache-sensitive, glm53-prefix-stability, mistral/echo-field strip, the reasoning-replay suites, capability-filter, 8488, 6191, 12339, 6238, and integration `chatcore-context-window-boundary`.
    - Final re-run after the last edits: 18 files, 118/118 pass.
- Full `npm run test:unit`, run exactly once: 45,096 tests, 45,053 pass, 14 fail, 29 skipped.
    - 4 failures were caused by this change and are now fixed and re-verified in the focused runs:
        - `issue-7793-env-doc-sync-repro` and `check-env-doc-sync`: the new env var needed documenting.
        - `reactive-context-compaction-policy` and `codex-prompt-compression-passthrough`: the source regexes.
    - 9 are pre-existing and fail identically at baseline (`git stash -u`, same files):
        - provider-translate-path GOLDEN
        - provider asset manifest
        - reserved-prefix set size
        - binaryManager Windows rollback (2)
        - Continue CLI detection
        - memory-tools (2)
        - call-log orphan cleanup
        - relay Bifrost 404
    - 1 is flaky under suite concurrency: `usage-history-provider-alias-13459` passes alone with this change.
    - The full suite was not re-run after the fixes, per the "at most once" rule.

## Not verified here (for live-verify)

- No deploy and no live traffic. After deploy, check the following:
    - `kubectl -n omniroute logs deploy/omniroute --since=15m | grep -E "CONTEXT|code-t1-0"` should show no `Input exceeds maximum input tokens for vllm/qwen3.8-27b-nvfp4` for Zoo requests around 55K real tokens.
    - The 5090 should take `code-t1-0` attempts.
    - Watch for a vLLM 400 "System message must be at the beginning", which would point at a memory-injection placement issue (see plan).
- Behavior change to watch: the 1.10 margin and the output reserve apply to every target. Prompts within the reserve (16384, or the client's `max_tokens`) of a target's window are now compacted (if compaction is enabled) or rejected locally so the combo falls through, instead of being sent. The user asked for this in requirement 3.
