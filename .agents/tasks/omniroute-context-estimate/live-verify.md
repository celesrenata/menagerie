# Live verify: OmniRoute context-estimate fix

Verdict: PASS. The fix is live, and no CONTEXT 400 has hit a real prompt since rollout. A ~53K-real-token hybrid/code request with `X-OmniRoute-Tier: 1` was served by code-t1-0 (vllm/qwen3.8-27b-nvfp4). Zoo requests of 86K–105K real tokens now land on the 5090.

## Deployed build

- Commit: OmniRoute `feat/hybrid-reader-combo` @ `1d48e1cfd` (fix(context): estimate only forwarded reasoning and honor per-target input policy)
- Image: `registry.celestium.life/library/omniroute:3.8.63-context-estimate-20261003`
- Pushed digest: `sha256:362e3a69fe20505cfe040e9dd67239ed835608e0bd8f020df20d7032eb1e61e9`. The pod `omniroute-7df4f85777-mjz6j` imageID matches it (checked live).
- Kube commit: `4d30536` (local, not pushed)

## Root cause (from plan/review)

The pre-flight gate ran `chars/4` on the client-shaped body before translation. That counted historical assistant `reasoning_content`, which the translator strips for non-reasoner OpenAI targets like vllm/qwen3.8 and Bedrock, so the target never sees it. In the reference Zoo request, reasoning was 289,377 of 455,359 message chars (64%). The real prompt was 53,976 tokens (vLLM `/tokenize`), but the gate estimated ~124K (logged 128–130K). It compared that to the `max_input_tokens` override of 98,304 and returned a 400. The `pool/tier1/code` `weightedTargetPolicies.maxInputTokens: 524288` had no reader and was ignored.

## Before / after estimate (reference payload, real = 53,976)

|                                                                     | estimate                | error                     |
| ------------------------------------------------------------------- | ----------------------- | ------------------------- |
| before (legacy gate)                                                | 123,739 (live 128–130K) | +129% → 400 vs cap 98,304 |
| after (reasoning stripped, ×1.10 margin)                            | 56,370                  | +4.4%                     |
| after, reasoning forwarded (llama-cpp/replay targets; real 154,252) | 170,054                 | +10.2%                    |

5090 effective cap: before 98,304. After, for a combo request via hybrid/code → pool/tier1/code, it is 114,688 (`min(policy 524288, 131072 − 16384 reserve)`, source `combo-policy`). For a direct request it stays at 98,304 from the override, by design.

## Live test request (~55K)

- Body: the real 12:44:10Z Zoo request (113 msgs, 22 tools, 289K chars `reasoning_content`) with `model: hybrid/code`, the mid-conversation memory system message removed (memory injection re-adds it system-first), and a final user message: "reply with only the word OK". Sent with the management key and `X-OmniRoute-Tier: 1`, streaming, no `max_tokens`.
- Attempt 1 (13:50:41Z): the gate admitted it, with no CONTEXT rejection, and it was dispatched to code-t1-0 vllm. Then an unrelated `nixos-rebuild switch` on esnixi (`switch-to-configuration test` from the user's pts/0 session at 13:50:57Z) stopped vllm.service and vllm-switcher, so the stream died with a 502. It fell back to code-t1-2 `ollama-local/qwen3.8:27b-iq3-code144k`, which returned 200 with 52,472 prompt tokens. That failure was the 5090 restarting, not the gate. vLLM returned at 13:55:44Z.
- Attempt 2 (13:55:49Z, request id `d8121a6a-…`): HTTP 200, served by code-t1-0 `vllm/qwen3.8-27b-nvfp4` with 0 fallbacks. `prompt_tokens 53,375`, completion 20, 10.4s. Call log: `provider vllm`, `comboStepId code-t1-0`, `tokens.in 53375`. Before the fix, this payload was rejected with a CONTEXT 400.

## Zoo traffic (zoo-m5, hybrid/code), 13:56–14:11Z (15 min)

Call logs are named at completion. Start time is completion minus duration.
| completed | target | step | tokens.in | started |
|---|---|---|---|---|
| 13:57:27 | llama-cpp/ds4-glm53 | code-t1-glm | 105,469 | 13:51:10 (vllm down) |
| 13:58:11 | vllm/qwen3.8-27b-nvfp4 | code-t1-0 | 85,972 | 13:57:28 |
| 13:59:07 | vllm/qwen3.8-27b-nvfp4 | code-t1-0 | 92,142 | 13:58:12 |
| 14:00:28 | vllm/qwen3.8-27b-nvfp4 | code-t1-0 | 89,036 | 13:59:08 |
| 14:01:16 | ollama-local/qwen3.8:27b-iq3-code144k | code-t1-2 | 99,658 | 13:50:57 (vllm down) |
| 14:02:19 | vllm/qwen3.8-27b-nvfp4 | code-t1-0 | 102,049 | 14:01:17 |
| 14:10:04 | vllm/qwen3.8-27b-nvfp4 | code-t1-0 | 88,275 | 14:00:29 |

- Every Zoo request that started after vLLM came back landed on code-t1-0/vllm first and succeeded: 5 of 5, at 86K–102K real tokens. Several are above the old 98,304 cap, and all of them would have been 400'd by the old ~2.2x estimate. Two more vllm successes (105,352 and 94,274 in) finished at 13:50:57–58, just after rollout.
- The only non-vllm landings (GLM, ollama, plus a code-t2 codestral at 13:51:22) started between 13:50:57 and 13:55:44. In that window vllm was restarting (`Model-only lockout … 502 server_error`) and the other t1 connections were at their concurrency cap (1).
- No call log in the window has status 400, and none has a CONTEXT error.

## `kubectl logs | grep CONTEXT`

- Full pod lifetime since rollout (~13:49Z): Zoo traffic shows no `Input exceeds maximum input tokens` and no `Pre-flight rejected`. The only other CONTEXT lines are routine combo-limit resolution and one proactive compression (231K → 103K) on a GLM-bound request.
- Oversized control (14:11:52Z, direct `vllm/qwen3.8-27b-nvfp4`, ~150K-token filler, no reasoning): rejected with 400 `context_length_exceeded`, as expected. The new info-level breakdown is logged ahead of the existing warn:
    ```
    CONTEXT Pre-flight rejected vllm/qwen3.8-27b-nvfp4: estimate 165836 (raw 150760 × margin 1.1) = messages 150022 + tools 738 + system 0 + instructions 0 + reasoning 0 (stripped 0); cap 98304 (source override), context 131072, output reserve 16384, forwardReasoning false
    ```
    As designed, a direct request still uses the 98,304 override. The 114,688 policy cap applies only through the combo.

## Notes

- No vLLM "System message must be at the beginning" errors were seen. Memory injection stays system-first on the vllm path.
- The esnixi `nixos-rebuild switch` restarts vllm with no drain, so in-flight 5090 streams get a 502 and fall back. This is not related to this fix, but it's worth knowing for switcher-resilience work.
