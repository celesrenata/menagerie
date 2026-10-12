# OmniRoute input cap raise for the 5090 (vllm/qwen3.8-27b-nvfp4)

Result: the combo input cap for the 5090 is now 131072, up from 114688. I made one config change, a context-length override in the management API. No code changed.

## Where 114688 came from

It is config, not a code constant. It is also not stored anywhere as 114688. The value comes from:

    cap = min(combo policy maxInputTokens, contextWindow - min(16384, contextWindow/4))
        = min(524288, 131072 - 16384) = 114688

(`resolveInputTokenCapForGateWithSource`, src/lib/modelCapabilities.ts, step 0 "combo-policy")

- Combo `config.weightedTargetPolicies["vllm/qwen3.8-27b-nvfp4"].maxInputTokens` is 524288 in every pool/tier1/* combo
  (1048576 in pool/tier1/planner). These values are much larger than the limit, so they never set the cap and I did not change them.
- The limit comes from the capability override `vllm/qwen3.8-27b-nvfp4` `context_length` = 131072 (contextWindow). The 16384
  default output reserve is the OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS default.

## Change

| Override (vllm/qwen3.8-27b-nvfp4) | Before | After |
|---|---|---|
| context_length | 131072 | 147456 (matches vLLM `--max-model-len 147456`) |
| effective combo input cap | 114688 | 131072 (147456 - 16384) |
| max_input_tokens (direct, non-combo requests only) | 98304 | 98304 (unchanged, out of scope) |

## API calls (Bearer = management key from /run/secrets/omniroute_management_api_key, never printed or stored)

1. `GET  https://omniroute.celestium.life/api/combos` (200). Read the weightedTargetPolicies.
2. `GET  https://omniroute.celestium.life/api/model-capability-overrides` (200). Captured the before state.
3. `PATCH https://omniroute.celestium.life/api/model-capability-overrides`
   body `{"target":"vllm/qwen3.8-27b-nvfp4","key":"context_length","value":147456}` (200)
4. `GET  https://omniroute.celestium.life/api/model-capability-overrides` (200). Shows `context_length` 147456,
   refreshedAt 2026-10-04 00:38:22.
5. `GET  https://omniroute.celestium.life/v1/models` (200). The runtime reports `vllm/qwen3.8-27b-nvfp4`
   `context_length: 147456`, `max_input_tokens: 98304`. The live resolver picked up the change, since context overrides are read from the DB without a cache.

With window 147456, the reserve is min(16384, 36864) = 16384, so the combo cap is min(524288, 131072) = 131072.
I worked this out from the code path and the live window value. The API does not expose the cap directly.

## Backup / commit

- Backup (pre-change, includes the full override list plus the target's combo policies):
  `/Users/celes/sources/kube/omniroute/backups/model-capability-overrides-vllm-qwen3.8-27b-nvfp4-20261004T003816Z-before-144k.json`
- Committed in /Users/celes/sources/kube by explicit path: `25ae99b chore(omniroute): back up vllm/qwen3.8-27b-nvfp4
  capability overrides before 144k context raise`. Not pushed.
- Rollback: PATCH the same body with `"value":131072`.

## Note

Direct (non-combo) requests to `vllm/qwen3.8-27b-nvfp4` are still capped at 98304 by the `max_input_tokens` override.
This change only affects routing through combos (coder/reader classes).

---

# Final live verification: 5090 coder at 144K (2026-10-04, UTC)

Verdict: PASS. A ~125K-real-token hybrid/code request with `X-OmniRoute-Tier: 1` was served by code-t1-0 (vllm/qwen3.8-27b-nvfp4) with HTTP 200 and no CONTEXT rejection. In the 10-minute watch, Zoo traffic showed no CONTEXT 400s for vllm. 7 of the 8 Zoo hybrid/code requests landed on the 5090, at 75K–120K real tokens.

## What is deployed

| Item | Value |
|---|---|
| esnixi commit (nix-flakes-refactored, main, not pushed) | `b1869ed` feat(esnixi): 144K 5090 coder context, coder fast-retry in switcher (base `f947fbc`) |
| esnixi generation | `system-440-link`. vllm.service is active/running, NRestarts=0, and has been up since 17:08:16 PDT |
| vLLM `max_model_len` (live `GET :8010/v1/models`) | 147456 |
| OmniRoute override `vllm/qwen3.8-27b-nvfp4` `context_length` | 147456 |
| OmniRoute combo input cap for the 5090 | 131072 (min(policy 524288, 147456 − 16384 reserve)) |
| kube backup commit (/Users/celes/sources/kube, not pushed) | `25ae99b` chore(omniroute): back up vllm/qwen3.8-27b-nvfp4 capability overrides before 144k context raise |

There is a later kube commit, `1bd28f6` "backup combos+connections before ordered-dispatch". It came from separate work and is not part of this change. During this step, the esnixi-5090 connection's `maxConcurrent` changed from 1 to 2 (connection `updatedAt` 01:28:36Z). This step did not make that change.

## 1. Live ~125K hybrid/code request

- Payload: real TypeScript from `OmniRoute/open-sse` (397,676 chars) and the instruction "Reply with only the word OK". It has `model: hybrid/code`, streaming, no `max_tokens`, `X-OmniRoute-Tier: 1`, and the management key as Bearer (never printed).
- Real size per vLLM `/tokenize` on esnixi: 125,772 tokens. The code averages about 3.2 chars/token, so OmniRoute's chars/4 × 1.10 gate estimate falls below the 131072 cap.
- Result: request `568eb1a1-9f77-4e73-b9f9-acbfe9855bd8`, started 01:37:43Z.
    - HTTP 200 in 36.6 s.
    - Response model `qwen3.8-27b-nvfp4`, `prompt_tokens 125,895`, completion 45.
    - Call log 01:38:20Z: `comboName hybrid/code`, `comboStepId code-t1-0`, `provider vllm`, `tokens.in 125895`, status 200, 36,520 ms. Pod log: `Model vllm/qwen3.8-27b-nvfp4 succeeded (33537ms, 0 fallbacks)`.
    - No `Pre-flight rejected vllm/…` and no `Input exceeds … vllm` lines for this request, or for any request in the pod's lifetime.
- Earlier attempts overflowed because of concurrency. None hit a context limit. All returned 200:
    - 00:42Z, 01:08Z and 01:19Z went to GLM (code-t1-glm). The log shows `Skipping vllm/qwen3.8-27b-nvfp4 — … at max concurrency cap (1)` each time: a Zoo request took the single 5090 slot within about 1 s of the idle check. The 4070 was also at its cap of 1.
    - 01:30Z: the 5090 was at cap (2). The 4070 returned a 504 fetch timeout after 110 s on a cold 125K prefill, and the request fell back to GLM.
    - 01:36Z: the 5090 was at cap (2), and the request was served by code-t1-2 (4070, 125,772 in).
    - This is the intended overflow order: 5090, then 4070, then M5 GLM.

## 2. Zoo call logs, 10-minute watch (01:39:19Z–01:49:19Z)

| completed | key | step | target | tokens.in | status |
|---|---|---|---|---|---|
| 01:39:33 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 118,257 | 200 |
| 01:39:50 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 119,729 | 200 |
| 01:42:37 | zoo-m5 | code-t1-2 | ollama-local/qwen3.8:27b-iq3-code144k | 73,821 | 200 |
| 01:45:56 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 75,052 | 200 |
| 01:46:10 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 78,195 | 200 |
| 01:47:38 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 77,963 | 200 |
| 01:49:10 | zoo-m5 | code-t1-0 | vllm/qwen3.8-27b-nvfp4 | 118,629 | 200 |

- There were 8 Zoo hybrid/code calls in the window. 7 went to vllm (code-t1-0), 1 to the 4070, and 0 to GLM. The only other calls were 3 small non-Zoo openrouter calls.
- No call log in the window has status 400, and none has a CONTEXT error. The pod log shows no vllm pre-flight rejection and no `Skipping vllm` concurrency skips.
- Several vllm requests were 118K–120K real tokens. These sizes were above what the old 114,688 cap admitted. Just before the window, there were also 01:37:43 (115,942) and 01:38:52 (117,955).
- The only CONTEXT 400s in the window were for `llama-cpp/ds4-glm53` (01:42:38, 01:45:57, 01:46:11). The estimates were 239K–254K vs cap 147456, with `forwardReasoning true` because GLM receives historical reasoning. Those were internal pre-flight fallbacks: each request moved to the next target in the same combo and the client got 200. GLM was tried first only because of session affinity (`session_key=… has no available affinity target`, then `Trying model 1/3: llama-cpp/ds4-glm53`). Sessions that overflowed to GLM earlier keep trying it first. This is outside this change, but it means the M5 is not strictly overflow-only for those sessions.
- esnixi switcher journal since 17:10 PDT (29 lines): no `breaker OPEN`, `fast retry` or failure lines.

## Cold start and fast retry (from deploy-report.md)

The fast retry was needed once, and it recovered on its first retry:

- 17:06:06: first start (cold torch.compile).
- 17:07:52: EngineCore OOM while allocating the 5.46 GiB KV cache. The unit failed at 17:07:58.
- 17:07:59: the switcher logged `fast retry 1/2 in 15s`.
- 17:08:16: retry start, with the compile cache now warm.
- 17:09:47: `Application startup complete`.

Recovery took about 91 s from the retry start and about 109 s from the failure. First start to serving took about 3m41s. Clients got 409 "switching … retry" responses during that window. The second retry was not used, and the breaker never opened.

## Notes

- The 5090 connection cap (now 2) is the main reason large requests overflow. Zoo traffic keeps the 5090 slots mostly full. A third concurrent 125K sequence would not fit in KV anyway: 59 + 49 + 49 > 104 blocks.
- Margin caveat from the plan: admission is decided by the chars/4 × 1.10 estimate, not by real tokens. Code averages about 3.2 chars/token, so it gets through at 125K real tokens. Prose-heavy requests (about 4+ chars/token) are admitted only up to about 119K estimated raw.
