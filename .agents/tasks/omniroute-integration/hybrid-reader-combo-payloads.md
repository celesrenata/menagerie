# hybrid/reader combo — ready-to-run OmniRoute wiring

## Why this is operator-gated

`POST /api/combos` is gated by `requireManagementAuth` (src/lib/api/requireManagementAuth.ts).
Our `omniroute_zoo_api_key` is a VALID API key but got **403 = lacks the `manage` scope**
(the read-only tokenized GET at `/api/v1/vscode/<token>/combos` works; create does not).

To run the POSTs below, use ONE of (in order of least change):

1. **Grant the zoo key `manage` scope** in the OmniRoute API Keys dashboard, then run the curls
   from anywhere with `Authorization: Bearer <zoo key>`.
2. Run them **on the gateway host over loopback** (trusted-loopback internal-service path), or
3. Use a dashboard session / an `oma_` CLI access token with manage scope.

## Verified facts (live gateway, read-only)

- `hybrid/reader` does NOT exist yet (90 combos listed; `hybrid/{planner,code,long,reviewer,...}` do).
- Tier building blocks that DO exist: `local/4070ti` (ollama-local/ornith-1.5:9b-262k),
  `local/5090` (vllm/qwen3.8-27b-nvfp4 — the CODER), `local/m5-reader` (ollama-local/qwen3.5-reader:9b).
- Combo schema (modeled from live `hybrid/code`, `local/5090`, `local/m5-reader`):
  `{ name, strategy, models:[{kind:"model",model,providerId,accountPinned}|{kind:"combo-ref",comboName}], description, capabilities }`.
- The NEW esnixi 5090 reader is served by vLLM as `qwen3.5-9b-nvfp4-reader` (switcher proxy :2701 →
  :8010). Its gateway model id is therefore `vllm/qwen3.5-9b-nvfp4-reader`, providerId `vllm`
  (mirrors how `local/5090` references `vllm/qwen3.8-27b-nvfp4`). CONFIRM this id resolves once the
  reader is registered on the gateway's vllm provider (see step 0).

## Step 0 — confirm the reader model id on the gateway (read-only, do first)

After the reader is reachable via :2701, confirm the gateway sees it:

```
KEY=$(sudo cat /run/secrets/omniroute_zoo_api_key)   # or your usage key
curl -s -H "Authorization: Bearer $KEY" \
  "https://omniroute.celestium.life/api/v1/vscode/$KEY/models?prefix=alias" \
  | python3 -c 'import sys,json;print([m["id"] for m in json.load(sys.stdin)["data"] if "qwen3.5-9b" in m["id"] or "reader" in m["id"]])'
```

If the id differs from `vllm/qwen3.5-9b-nvfp4-reader`, substitute it in the payloads below.

## Step 1 — create local/5090-reader (the 5090 reader tier)

```
MGMT=<manage-scoped key or run on gateway loopback>
curl -s -X POST https://omniroute.celestium.life/api/combos \
  -H "Authorization: Bearer $MGMT" -H "Content-Type: application/json" -d '{
  "name": "local/5090-reader",
  "strategy": "priority",
  "models": [
    { "kind": "model", "model": "vllm/qwen3.5-9b-nvfp4-reader", "providerId": "vllm", "accountPinned": true }
  ],
  "description": "NVFP4 9B reader on the esnixi RTX 5090 (switcher :2701; coding-gated via arcane-gpu lease + switcher 409)",
  "capabilities": { "multimodal": false, "reasoning": true, "caching": false }
}'
```

## Step 2 — create hybrid/reader (the tiered combo)

Priority order per the spec: 4070 Ti Super → 5090 (coding-gated) → M5 Max.

```
curl -s -X POST https://omniroute.celestium.life/api/combos \
  -H "Authorization: Bearer $MGMT" -H "Content-Type: application/json" -d '{
  "name": "hybrid/reader",
  "strategy": "priority",
  "models": [
    { "kind": "combo-ref", "comboName": "local/4070ti" },
    { "kind": "combo-ref", "comboName": "local/5090-reader" },
    { "kind": "combo-ref", "comboName": "local/m5-reader" }
  ],
  "description": "Bounded read-only fan-out: gremlin 4070 Ti Super first, overflow to the 5090 reader when it is not running a coding job, then the M5 Max. The 5090 reader is naturally coding-gated: the arcane-gpu lease + switcher 409 keep it from evicting an active qwen3.8 coder.",
  "capabilities": { "multimodal": false, "reasoning": true, "caching": false }
}'
```

### Tiering note (coding-gated 5090 — HONEST limitation, confirm before relying on tier-1→tier-2 overflow)

- `priority`/`fill-first` combos advance to the next tier on an ERROR from the current one (the
  reviewer verified: fill-first does NOT advance on a concurrency cap, only on error).
- 5090 "coding wins" is REAL: when the coder holds the arcane-gpu lease, the switcher returns 409
  for the reader → the combo falls through to the next tier (M5). This part works regardless.
- 4070ti→5090 _busyness_ overflow only works if the gremlin returns a retriable status (429/503/5xx)
  when at capacity. If gremlin SILENTLY QUEUES instead, fill-first won't overflow. OPERATOR: probe
  the gremlin at-capacity behavior before claiming busyness-overflow (documented in §22 of
  reader-fabric-verification.md). The 5090-only-when-not-coding gate is unaffected by this.

## Step 3 — verify hybrid/reader resolves

```
KEY=$(sudo cat /run/secrets/omniroute_zoo_api_key)
curl -s --max-time 120 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"hybrid/reader","messages":[{"role":"user","content":"Reply: hello world"}],"max_tokens":256,"stream":false}' \
  https://omniroute.celestium.life/v1/chat/completions \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("served:",d.get("model"));print("content:",d["choices"][0]["message"].get("content"))'
```

Then stop the coder and repeat — should still answer via a reader tier (fallthrough works).

menagerie already points its reader route at `hybrid/reader` (user confirmed "looks fine"), so once
this combo exists and resolves, the reader-route delegation is fully live end to end.
