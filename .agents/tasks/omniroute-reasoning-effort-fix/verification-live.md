# Live Verification — OmniRoute reasoning_effort fix (drop-above-ceiling, fix2)

Date: 2026-10-03
Live endpoint: `https://omniroute.celestium.life`
Running pod: `omniroute-58f57587d-tf9b5` (0 restarts)
Running imageID digest: `sha256:4060b50bd35c1e23887aedba0ac4017314ca4eba39bcb427e846115b5a671a95`
(matches pushed digest of tag `3.8.54-reasoning-effort-fix2-20261003` exactly)
Target connection: `b20e0770-3e14-40c1-87cd-85c34b34381a` (gremlin-4070ti-ollama, ollama-local, `http://10.1.1.12:2701/v1`)

OmniRoute fix commit (local, NOT pushed): `9ac4f2f842bc8475b212c63a3ecbf24f853ffe31` on `feat/hybrid-reader-combo`
Kube deploy commit (local, NOT pushed): `5e7f5f57f4b36ec84e048867b158b2e2e49666ef`

---

## Root cause (corrected — template self-inconsistency)

Direct backend probes of qwen3.8:27b-iq3-90k (`http://10.1.1.12:2701/v1`, 2026-10-03):

| reasoning_effort forwarded | HTTP | Backend result                                                                                   |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `high`                     | 500  | Jinja: `Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.` |
| `xhigh`                    | 500  | Jinja: `Unexpected reasoning effort max. Supported types are xhigh (default), medium, and low.`  |
| `medium`                   | 200  | OK                                                                                               |
| `low`                      | 200  | OK                                                                                               |
| (omitted)                  | 200  | OK (template default = xhigh)                                                                    |

The qwen3.5/qwen3.8 Jinja template is SELF-INCONSISTENT: it names `xhigh` as its
(default) top tier, but when `xhigh` is sent EXPLICITLY it internally rewrites it to
`max` and then raises `Unexpected reasoning effort max`. The only explicit values that
succeed are `low`/`medium`; the top tier is reachable ONLY by OMITTING the field. The
earlier `high → xhigh` mapping therefore swapped one 500 for a different 500.

## Implemented fix (drop above ceiling)

Declare the ollama-local qwen family ceiling as `["low","medium"]` and add a new
`omitEffortAboveDeclaredCeiling` policy so the forwarding clamp DROPS any above-ceiling
request (high/xhigh/max) instead of clamping to a literal value. The backend then
applies its own `xhigh` default — delivering max reasoning, which is the caller's intent.
`low`/`medium` still pass through verbatim; opt-out families (qwen3/qwen3-vl/gemma4) and
all other providers are unchanged; operator overrides still clamp (never drop).

---

## 1. FIX CASE — ollama-local qwen3.8 with reasoning_effort: high

### Request (through OmniRoute)

```
POST https://omniroute.celestium.life/v1/chat/completions
{
  "model": "ollama-local/qwen3.8:27b-iq3-90k",
  "messages": [{"role":"user","content":"Reply with the single word: ok"}],
  "reasoning_effort": "high",
  "max_tokens": 64,
  "stream": false
}
```

### HTTP status: **200** (was 500)

Response: real completion — `content: "ok"`, with a populated `reasoning` field
(backend ran at its own xhigh default), `total_tokens: 1014`.

### Pod log lines (correlationId 60895daf-dc01-4dcb-ab9e-85186c58ebe8)

```
HTTP  POST /v1/chat/completions | ollama-local/qwen3.8:27b-iq3-90k | 1 msgs | effort=high
ROUTING  Provider: ollama-local, Model: qwen3.8:27b-iq3-90k
REASONING_SANITIZE  ollama-local/qwen3.8:27b-iq3-90k: dropped reasoning_effort high (above declared ceiling low/medium; backend applies its own top-tier default)
```

- The fix fires: the field is **dropped** (not rewritten to a literal).
- **NO `Unexpected reasoning effort` Jinja error** anywhere in the logs for this request.
- Request returns **200** with real content.

---

## 2. NO-REGRESSION CASE — healthy non-ollama connection with reasoning_effort: high

### Request (through OmniRoute)

```
POST https://omniroute.celestium.life/v1/chat/completions
{
  "model": "vllm/qwen3.8-27b-nvfp4",
  "messages": [{"role":"user","content":"Reply with the single word: ok"}],
  "reasoning_effort": "high",
  "max_tokens": 64,
  "stream": false
}
```

(vllm/esnixi-5090 — self-hosted, legitimately accepts `high`)

### HTTP status: **200**, body a normal completion (`content: "ok"`).

### Pod log lines (correlationId b315b705-c944-4add-9d64-7f59352cf79a)

```
HTTP  POST /v1/chat/completions | vllm/qwen3.8-27b-nvfp4 | 1 msgs | effort=high
ROUTING  Provider: vllm, Model: qwen3.8-27b-nvfp4
AUTH  Using vllm account: ***...
[ProxyEgress] vllm status=success
```

- **No `REASONING_SANITIZE` line** for the vllm request → `high` forwarded unchanged
  (still `high`), 200. The drop/clamp is correctly scoped to ollama-local. No regression.

---

## 3. HEALTH — gremlin-4070ti-ollama connection after the fix case

`GET /api/providers` → connection `b20e0770-3e14-40c1-87cd-85c34b34381a`:

```
testStatus:    active
backoffLevel:  0
isActive:      true
lastError:     None
```

- **backoffLevel 0**, active, and `lastError` has cleared to **None** (the stale
  "server_error" annotation from the earlier broken path is gone). No new 500.

---

## 4. CLEANUP

No debug pods were created (verification used only `curl` and `kubectl logs`).
`kubectl -n omniroute get pods` shows only the running `omniroute-58f57587d-tf9b5`
pod and the pre-existing completed `omniroute-nfs-backup` cron job. Nothing to remove.

---

## Live verification verdict

- Fix deployed and active (digest match `sha256:4060b50b…`, drop-above-ceiling firing).
- FIX CASE: ollama qwen3.8 + `high` → **200** (field dropped, backend default xhigh, no Jinja error).
- NO-REGRESSION: vllm + `high` → **200**, `high` NOT rewritten.
- HEALTH: ollama connection healthy — backoffLevel 0, lastError None.
