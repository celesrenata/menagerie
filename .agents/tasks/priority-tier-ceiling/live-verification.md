# Live verification: priority tier ceiling

- Target: https://omniroute.celestium.life
- Auth: the management key (`/run/secrets/omniroute_management_api_key` on esnixi), read into a shell variable and passed only as the Bearer token. The key value was never printed or written anywhere.
- Pod: `omniroute-7fdccb8f64-5pvpc`. Container started at `2026-10-03T08:20:31Z`, which is used as the deploy cutoff. imageID `registry.celestium.life/library/omniroute@sha256:74f472d369c1c471a3eec6075c75f9a7db4862488ebbf6ae5cf374543148b1f6`.
- `hybrid/reader` steps: `hybrid-reader-tier1..5` are combo-refs to `pool/tier1..5/reader`. The leaf step ids logged in call_logs are `reader-tN-*`.

## 1. Tier-1 request

`POST /v1/chat/completions`, `model: hybrid/reader`, `X-OmniRoute-Tier: 1`, `max_tokens: 16`, sent at `2026-10-03T08:21:21.952Z`.

- The request returned HTTP 200 in 7.5s. The model was cold-loading.
- Response headers: `x-omniroute-model: qwen3.5-reader:9b`, `x-omniroute-provider: ollama`, `x-omniroute-decision: strategy=priority; provider=ollama`, `x-omniroute-response-cost: 0.0000000000`, request id `a8e19d89-8972-4c1e-9e3d-ffd7794340e4`.

## 2. call_logs (`/app/data/storage.sqlite`)

These are all rows with a combo after the cutoff:

| timestamp                | status | combo_name    | combo_step_id | model             | provider     |
| ------------------------ | ------ | ------------- | ------------- | ----------------- | ------------ |
| 2026-10-03T08:21:29.198Z | 200    | hybrid/reader | reader-t1-1   | qwen3.5-reader:9b | ollama-local |
| 2026-10-03T08:21:54.274Z | 200    | hybrid/reader | reader-t1-1   | qwen3.5-reader:9b | ollama-local |

- The first row is the tier-1 request, and its step is `reader-t1-1`.
- No row after the deploy has a tier2+ step (`*-t2-*` through `*-t5-*`). The only other rows after the cutoff were dashboard `connection-test` probes and `arc-embed` embeddings, neither of which uses a combo.
- The deploy has been live for a short time, so this sample is small (2 combo requests).

Before the deploy (2026-10-03 00:00 to 08:20:31), `hybrid/*` call_logs show escalation across tiers. This is the behavior being fixed.

- hybrid/reader: tier1 88, tier2 (openai) 25, tier3 (bedrock) 1
- hybrid/planner: tier2 (mistral) 11
- hybrid/research: tier2 (mistral) 6

## 3. No-header request (unchanged behavior)

Same body without `X-OmniRoute-Tier`, sent at 2026-10-03T08:21:52Z.

- It returned HTTP 200 in 1.3s. Response headers: `x-omniroute-model: qwen3.5-reader:9b`, `x-omniroute-provider: ollama`, `strategy=priority`.
- The call_log row is the second one in the table above (`reader-t1-1`).
- Pod logs for the window contain no tier-ceiling or `tier_ceiling_no_targets` messages, so the ceiling was not applied.
- Tier 1 was healthy, so plain priority order served it from tier 1, as it did before.
- Not verified live: no-header escalation to tier 2+ when tier 1 fails. Forcing that would require breaking a tier-1 backend or sending paid traffic. Two things cover it instead. The unit test "no header escalates to tier 5" passes. The pre-deploy call_logs above show the escalation path.
