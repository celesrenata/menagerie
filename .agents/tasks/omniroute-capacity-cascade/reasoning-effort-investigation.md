# OmniRoute 4070 reasoning-effort regression investigation

## Summary answer

The current release forwards `reasoning_effort: "high"` unchanged to `ollama-local/qwen3.8:27b-iq3-code144k`. That model's Ollama Jinja template accepts only `xhigh`, `medium`, and `low`, with omitted effort defaulting to `xhigh`; the upstream therefore returns HTTP 500 before generation. OmniRoute does have a final provider sanitizer, but the released candidate has no `ollama-local` registry entry or model effort ceiling for this model, unknown models default to pass-through, and reactive capability learning only runs after HTTP 400/422—not this HTTP 500.

This is primarily an integration/base-snapshot regression, not a defect introduced by the capacity-cascade algorithm itself. The capacity-cascade diff does not modify the sanitizer or its model lookup. The released image was built from candidate revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658` plus its dirty candidate tree, which lacks a separately developed and previously deployed Ollama reasoning-effort fix. The new routing makes the defect visible and repeatable because the intended `5090, 4070, 5090` tier-1 round robin now reaches the 4070 regularly.

The safest fix is to restore the previously validated behavior for the `ollama-local` Qwen 3.5/3.8 template family: preserve explicit `low` and `medium`, but **remove** above-ceiling `high`, `xhigh`, or `max` so Ollama applies its own top-tier `xhigh` default. Do not map `high -> xhigh`: the surviving prior fix records a live probe where explicit `xhigh` was internally rewritten to `max` and still failed, while omission succeeded. Rejecting `high` would also be unnecessary because omission preserves top-tier intent.

A data/config-only production fix is not available in the current release. The live catalog and database have no reasoning-effort vocabulary for this model, and the current sanitizer does not consume a live override capable of expressing “omit above the ceiling.” Adding only `supportedThinkingEfforts: ["low", "medium"]` to the current static model list would map `high` down to `medium`, silently reducing requested reasoning. A narrow metadata-backed source restoration is required.

## Evidence

### 1. Client request field and end-to-end request path

1. Menagerie resolves the selected model effort and emits the OpenAI Chat Completions field literally:
   - `src/api/transform/model-params.ts:130-172`, `getModelParams()`, resolves `reasoningEffort` and delegates to `getOpenAiReasoning()`.
   - `src/api/transform/reasoning.ts:127-158`, `getOpenAiReasoning()`, returns `{ reasoning_effort: reasoningEffort }` for `low`, `medium`, or `high`.
   - `src/api/providers/openai.ts:96-190`, `OpenAiHandler.createMessage()`, spreads `reasoning` into `requestOptions` before `chat.completions.create()`.
   - `src/api/providers/openai.ts:302-334`, `OpenAiHandler.getModel()`, derives the route model's OpenAI parameters. OmniRoute profiles use the selected route ID but otherwise use this ordinary OpenAI-compatible request path.

2. The redacted call artifact for the first confirmed failure (`2026-10-11T04:00:50.023Z`) contains these safe fields:
   - requested route target: `ollama-local/qwen3.8:27b-iq3-code144k`
   - provider/model: `ollama-local` / `qwen3.8:27b-iq3-code144k`
   - source and target formats: `openai` / `openai`
   - inbound field: `reasoning_effort: high`
   - combo context: `hybrid/code`, step `code-t1-1`
   - connection: `gremlin-4070ti-ollama`, `max_concurrent=1`

3. In OmniRoute, same-format OpenAI translation preserves this field:
   - Candidate `open-sse/handlers/chatCore.ts:2360-2427` clones the body and invokes `translateRequest(sourceFormat, targetFormat, ...)`.
   - Candidate `open-sse/translator/index.ts:435-436` skips hub-and-spoke conversion when source and target formats are equal.
   - Candidate `open-sse/executors/base.ts:537-588`, `BaseExecutor.transformRequest()`, clones and cleans unrelated optional fields but does not remove `reasoning_effort`.
   - Candidate `open-sse/executors/default.ts:709-874`, `DefaultExecutor.transformRequest()`, applies provider defaults and unsupported-parameter rules; there is no Ollama-local effort transform.

4. The final sanitizer does run before fetch:
   - Candidate `open-sse/executors/base.ts:880-891` calls `transformRequest()` and then `sanitizeReasoningEffortForProvider(rawTransformedBody, provider, model, log)`.
   - The resulting body is sent to the Ollama OpenAI-compatible `/v1/chat/completions` endpoint by the default executor.

### 2. Why the current sanitizer does nothing

The sanitizer is `sanitizeReasoningEffortForProvider()` in candidate `open-sse/executors/base/reasoningEffort.ts:253-430`.

- It reads all supported carriers (`reasoning_effort`, `reasoning.effort`, and `output_config.effort`) at lines 176-250.
- Learned capabilities are consulted at lines 344-359.
- Static `RegistryModel.supportedThinkingEfforts` are consulted at lines 361-396.
- `supportsXHighEffort()` defaults an unknown/unflagged model to `true` in `open-sse/config/providerModels.ts:328-343`.
- The special xhigh/max branches begin only at lines 398-430. They do not affect an ordinary `high` request.

For this live target, every capability source misses:

- The candidate has no `open-sse/config/providers/registry/ollama-local/index.ts` at all.
- `getProviderModels("ollama-local")` therefore has no exact or family model declaration to supply `supportedThinkingEfforts`.
- The live `provider_connections` record has only `apiKeyHealth`, `autoSync`, `baseUrl`, and `passthroughModels`; it contains no matching model capability metadata.
- The live `model_capabilities` table has no row for this model.
- The only live `model_capability_overrides` rows for this model are `max_input_tokens=114688` and `max_output_tokens=16384`; there is no reasoning vocabulary or omission policy.
- The backend `/v1/models` catalog publishes only the model ID, object type, creation time, and owner. It does not publish supported reasoning efforts.

Reactive learning cannot rescue the request. Candidate `open-sse/executors/base.ts:1539-1576` parses advertised enums and retries only when the upstream status is `BAD_REQUEST` (400) or `UNPROCESSABLE_ENTITY` (422). Ollama returns 500 for this template exception, so `parseReasoningEffortEnum()` is never called and no process-local learned set is recorded. Even if later requests repeat the same failure, the current process remains unaware.

### 3. Backend/template semantics

A read-only `POST /api/show` against the actual 4070 Ollama endpoint for `qwen3.8:27b-iq3-code144k` returned:

- capabilities: `tools`, `thinking`, `completion`
- configured `num_ctx`: 147456
- template line 47: omitted `reasoning_effort` resolves to `xhigh`
- template line 48: accepted template values are `xhigh`, `medium`, and `low`
- template line 49: every other value raises `Unexpected reasoning effort ...`
- template line 51 onward: `xhigh` selects the strongest reasoning instructions

This proves that omission is not a downgrade: it selects the backend's documented top tier. It also proves that literal `high` must not reach the template.

The surviving prior fix contains stronger runtime evidence than template text alone. `/home/celes/sources/omniroute-reasoning-effort-build/open-sse/config/providers/registry/ollama-local/index.ts:32-54` records a live 2026-10-03 probe:

- `low` -> 200
- `medium` -> 200
- `high` -> 500, unexpected `high`
- explicit `xhigh` -> 500 after being rewritten to `max`
- omitted field -> 200 with the template's `xhigh` default

Accordingly, that implementation declared an effective explicit ceiling of `low/medium` plus `omitEffortAboveDeclaredCeiling: true`. Its sanitizer branch at `/home/celes/sources/omniroute-reasoning-effort-build/open-sse/executors/base/reasoningEffort.ts:579-652` strips an above-ceiling value instead of clamping it down. The focused test file `/home/celes/sources/omniroute-reasoning-effort-build/tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts:1-155` pins `high`, `xhigh`, and `max` omission; `low`/`medium` preservation; Qwen family matching; unrelated-family opt-outs; operator override precedence; and non-Ollama isolation.

Because the previous live probe showed explicit `xhigh` still failing, the current template source alone is insufficient evidence to reintroduce `high -> xhigh`. Omission is the proven behavior.

### 4. Live failure and lane context

The current pod logs show this sequence three times in the requested window:

- `04:00:33.355Z`: `pool/tier1/code` selects `[RR #1] -> ollama-local/qwen3.8:27b-iq3-code144k`.
- `04:00:49.966Z`: upstream returns 500 with `Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.`
- `04:00:50.031Z`: `COMBO-RR` records the 500 and falls back to `vllm/qwen3.8-27b-nvfp4`.
- Equivalent failures occur at `04:01:51.430Z` and `04:02:48.601Z`, followed by successful 5090 fallback.
- There is no `REASONING_SANITIZE` event in the current pod logs for these requests.

The live combo configuration matches the requested capacity lanes:

- `pool/tier1/code`: 5090 vLLM, 4070 Ollama, 5090 vLLM, round robin.
- `pool/tier1/research`: the same 5090, 4070, 5090 target sequence.
- `pool/tier1/tester`: the same effective 5090, 4070, 5090 target sequence (step IDs differ).
- All three root routes (`hybrid/code`, `hybrid/research`, `hybrid/tester`) reference their corresponding tier-1 pool before later local/cloud tiers.

Observed effort by lane:

- **Code:** confirmed affected now. The three incident artifacts are `hybrid/code` requests with inbound `high`.
- **Research:** historical artifacts confirm `hybrid/research` sends `high` to this same model. Those requests predate the regression and normally succeeded while the old omission sanitizer was active. No post-release research request occurred in the inspected current window, but the same model/executor path means the next research `high` assigned to the 4070 will fail identically.
- **Tester:** the live tester pool contains the same model, so the defect is route-independent and tester is affected whenever its inbound request carries `high`. The inspected historical tester records had effort unset, and there was no post-release tester sample, so the logs do not prove that the current tester client actually selects `high`.

Thus code and research are proven high-sending lanes; tester is structurally vulnerable but not proven to send high from the available records. `low` and `medium` are not affected by this Jinja enum mismatch.

### 5. Old versus current source/image

- Live digest: `sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`.
- Image label revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`.
- Image candidate-tree label: `dfa5ef0b9142c57aee9915869620a47eea3bd310`.
- Kubernetes rollout creation time for this digest: `2026-10-11T03:37:52Z`.
- Candidate worktree: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z` on `feat/omniroute-capacity-cascade-20261010T222530Z`.

The candidate's capacity-cascade changes modify combo dispatch, semaphore capacity, tier routing, quality response cleanup, and tests. They do not modify:

- `open-sse/executors/base/reasoningEffort.ts`
- `open-sse/config/providerModels.ts`
- `open-sse/config/providerRegistry.ts`
- a provider registry entry for `ollama-local` (none exists in the candidate)

The candidate working-tree blob hashes for `reasoningEffort.ts` and `providerModels.ts` exactly equal their `HEAD` blobs, confirming these files were not changed by the capacity work.

By contrast, persistent prior-runtime logs contain 1,772 entries across 2026-10-03 through 2026-10-11 with the exact message:

`ollama-local/qwen3.8:27b-iq3-code144k: dropped reasoning_effort high (above declared ceiling low/medium; backend applies its own top-tier default)`

The source that generated this behavior survives under `/home/celes/sources/omniroute-reasoning-effort-build`, but that directory is not a Git worktree and its changes are absent from the candidate base. Relative to the candidate, the surviving snapshot adds the Ollama-local registry, omission policy, family-aware effort resolution, and focused tests. This establishes that the incompatibility was previously known and handled but was not integrated into the candidate used for the capacity-cascade release.

## Conclusions

1. **Immediate technical cause:** `high` passes through because current model metadata is absent and unknown models are deliberately trusted.
2. **Why no self-healing occurs:** Ollama reports the enum problem as HTTP 500, while the learner is gated to 400/422.
3. **Regression origin:** the released candidate base/snapshot omitted the previously deployed reasoning-effort patch. Capacity-cascade code itself did not remove or alter the sanitizer.
4. **Routing contribution:** capacity routing activates the latent path by correctly scheduling job 2 on the 4070. It exposes the missing patch but is not the field-transform bug.
5. **Metadata diagnosis:** the live catalog is not merely stale; it has no schema/field consumed by the current sanitizer to express the required omit-at-top behavior. Token-limit overrides cannot fix it.
6. **Correct semantic action:** preserve `low` and `medium`; omit `high`, `xhigh`, and `max` for this validated Ollama Qwen template family so omission selects backend-default `xhigh`. Do not clamp to `medium`, reject, or retry after the 500.

## Recommendations

### Smallest safe fix

Restore the proven omission behavior as a narrow, model-family-scoped source transform in `sanitizeReasoningEffortForProvider()` after effort-carrier extraction and before generic learned/static clamping:

- scope to provider `ollama-local`;
- scope to Ollama family IDs `qwen3.5:*` and `qwen3.8:*` (not broad `qwen3:*`);
- leave `low` and `medium` unchanged;
- strip the effort carrier for `high`, `xhigh`, and `max`;
- log `REASONING_SANITIZE` without request content;
- preserve unrelated fields in `reasoning`, `output_config`, and the request body.

A durable metadata-backed version may selectively port the previous `omitEffortAboveDeclaredCeiling` registry capability and family-prefix lookup, but declare the policy specifically for Qwen 3.5/3.8 rather than as an unrestricted default for every future `ollama-local` model. Reuse the existing carrier helpers so Chat Completions, Responses, and Claude-shaped carriers behave consistently.

Do not change the lane order or remove the 4070 target; the lane configuration is correct. Do not broaden 500-based reactive learning globally: arbitrary server errors are not reliable capability declarations. If reactive learning is later extended, it must recognize this exact sanitized template-enum error shape and remain provider/model scoped.

### Required regression tests

Add/restore a focused unit test file, preferably `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts`, covering:

1. `ollama-local/qwen3.8:27b-iq3-code144k` with `high` removes the field entirely.
2. Explicit `xhigh` and `max` also remove the field so backend-default xhigh is used.
3. `low` and `medium` pass through unchanged.
4. The same behavior applies to a tagged Qwen 3.5 model.
5. Qwen 3, Qwen3-VL, Gemma, non-Ollama providers, and unrelated Ollama models are unchanged.
6. All three effort carriers are covered and sibling fields survive stripping.
7. A `chatCore`/executor-path regression test proves an OpenAI `high` request bound to this provider/model is sanitized before fetch.
8. A combo test proves code/research/tester routing does not alter the sanitizer result and fallback is no longer burned on the 4070.

### Verification steps for an implementation (not run during this read-only investigation)

From the OmniRoute worktree:

1. `node --import tsx/esm --test tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts` — all Qwen-family and isolation cases pass.
2. `node --import tsx/esm --test tests/unit/base-executor-sanitize-effort.test.ts` — existing provider normalization behavior remains green.
3. Run the focused executor/chat pipeline and combo tests changed by the patch, including `tests/unit/chatcore-translation-paths.test.ts` and the relevant combo strategy test — all pass.
4. `npm run lint` — no lint errors.
5. `npm run build` — production build succeeds.
6. In staging, issue sanitized minimal requests for `low`, `medium`, `high`, `xhigh`, and omitted effort. Confirm low/medium remain explicit, high/xhigh are omitted outbound, every request returns non-500, and high/xhigh produce a `REASONING_SANITIZE` event. Do not use production prompts or credentials in verification output.
7. After deployment, inspect only metadata-safe logs: 4070 selections should no longer emit the Jinja enum 500, no fallback should be burned for this reason, and code/research/tester lane order should remain 5090/4070/5090.

No source, deployment, server, database, model, or configuration was modified during this investigation. Queries were read-only, and credentials, prompts, message content, account values, and authorization headers were not included in this report.
