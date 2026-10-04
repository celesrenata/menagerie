# GLM-5.3 live KV reuse: live verification after the OmniRoute prefix-stability deploy

Date: 2026-10-03, 04:27 PDT. OmniRoute `3.8.61-prefix-stable-20261003` (pod `omniroute-557cbd7449-wclk5`). ds4 log: `/Users/celes/ai/logs/glm53-dwarfstar-server.log`.

Result: the OmniRoute path now reuses the live KV. All 3 follow-up turns in an append-only tool conversation prefilled only the new tail (`ctx=N..`, N = previous prompt + generated tokens). The log shows no `live kv cache miss`, no `token-mismatch`, and no `requires rebuild`.

## Before vs after

Before = every `prompt done` in the log up to the last pre-deploy request (03:32:59; ds4 shut down at 03:58:27, deploy was about 04:17). After = the test conversation below. A miss is a `live kv cache miss` line before a prompt. Every miss in the log was `reason=token-mismatch`.

| Window                      | Prompts | Live-KV miss rate      | `ctx=0..` full prefills | `ctx=N..` incremental (live / disk hit) | Avg prefill               | Avg tokens prefilled |
| --------------------------- | ------- | ---------------------- | ----------------------- | --------------------------------------- | ------------------------- | -------------------- |
| Before, up to 09-29         | 1285    | 34% (437)              | 279                     | 1006 (836 / 170)                        | 45.6 s                    | 15,555               |
| Before, 09-30 → 10-03 03:33 | 449     | 98% (438)              | 263                     | 186 (1 / 185)                           | 106.6 s                   | 37,484               |
| Before, 10-03 only          | 8       | 75% (6)                | 8                       | 0 (0 / 0)                               | 50.0 s                    | 16,203               |
| After, test conversation    | 4       | 0% (0 of 3 follow-ups) | 1 (turn 1, cold)        | 3 (3 / 0)                               | 9.3 s (turns 2–4: 10.6 s) | 3,259                |

Before 09-30 the window is mixed. Its 836 live hits were real, but 437 tail rewrites still missed.

## Test conversation (per turn)

Client: a scratch Python harness, deleted after the run. It sent a streaming `POST /v1/chat/completions` to `https://omniroute.celestium.life` with `model: hybrid/planner` and the management key as Bearer. Each request is the previous request's messages plus the assistant message ds4 returned (`content`, `reasoning_content`, `tool_calls`), then a `tool` result of about 13 KB and an `<environment_details>` user message. That is Zoo's shape once compaction is off and `preserveReasoning` is on. A script check confirmed that request N+1's first messages are byte-identical to request N. Payload: a 4.9 KB system prompt, 5 tools, and a first user message with a task plus an env-details file listing.

| Turn                                                        | Msgs sent | ds4 `prompt done`      | Tail prefilled | Prefill | Est. prefill if from 0 (about 345 tok/s) | Live miss | Assistant reply                  |
| ----------------------------------------------------------- | --------- | ---------------------- | -------------- | ------- | ---------------------------------------- | --------- | -------------------------------- |
| 1 (cold: ds4 just started, cold disk anchor stored at 1446) | 2         | `ctx=0..2061:2061`     | 2061           | 5.33 s  | —                                        | —         | reasoning + `read_file`          |
| 2                                                           | 5         | `ctx=2089..5749:3660`  | 3660           | 10.04 s | about 16.7 s                             | none      | `read_file`                      |
| 3                                                           | 8         | `ctx=5766..9426:3660`  | 3660           | 10.53 s | about 27.3 s                             | none      | `attempt_completion`             |
| 4                                                           | 11        | `ctx=9747..13401:3654` | 3654           | 11.33 s | about 38.8 s                             | none      | reasoning + `attempt_completion` |

- Each turn starts exactly at the previous live frontier: 2061+28=2089, 5749+17=5766, 9426+321=9747. Turn 1's assistant message carried `reasoning_content`, and turn 2 still hit, so OmniRoute now forwards reasoning in a form ds4 re-renders identically.
- The tail is all new content: a roughly 13 KB tool result plus the env block, about 3.65K tokens. The 13 KB result reached ds4 whole on its first send. On later turns it sits inside the reused prefix. Before the deploy, it would have been cut to 2000 chars and caused the miss.
- OmniRoute's reported usage agrees: `cached_tokens` was 2089 / 5766 / 9747 on turns 2–4.
- The savings grow with context. At Zoo's typical 17–27K-token prompts, a follow-up with a 1.5–3K tail should take about 4–9 s instead of the 50–70 s seen today.

## Scope and caveats

- This verifies the OmniRoute side (memory freeze, no Lite tool-result truncation for llama-cpp, `reasoning_content` passthrough) with a client that already behaves like fixed Zoo. Real Zoo traffic reuses the KV only after the Zoo change is installed (env-details compaction off in the request path, `preserveReasoning`). Until then, Zoo still rewrites the previous tail every turn.
- I did not test task/mode switches between different conversations. The single ds4 slot still thrashes on those, which is the `--batched-session` question.
- Not covered here: reuse after a turn whose reasoning is long, or after a plain-text (non-tool) assistant reply.

## Incidents during verification

- The first attempt (04:23) never reached GLM. The ds4 launchd job had exited cleanly at 03:58:27, outside the proxy, but the local-model-proxy (:7777) still reported `active: glm53`. Its requests therefore got `Cannot connect to 127.0.0.1:8082`, and OmniRoute fell back to `pool/tier2/planner` → `mistral/codestral-latest`, using 4 small cloud requests (about 23K prompt tokens total). The planner request did not kickstart GLM, because the proxy believed GLM was already resident. I re-synced the proxy with its own `POST /admin/stop` and `POST /admin/select {"alias":"glm53"}`, which ran the existing launchd job unchanged. ds4 was listening 14 s later (04:25:31).
- Observed, not changed by me: ds4's startup line now shows `--kv-disk-space-mb` budget=49152 MiB. Starts at 00:56 and 01:57 showed 16384. The plist was changed between 01:57 and 04:25, probably by the rebuild that stopped ds4 at 03:58.
- Nothing under `/Users/celes/ai/kv-cache` was deleted. ds4 flags were not changed.
