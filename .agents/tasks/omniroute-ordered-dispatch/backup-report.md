# Backup Report — OmniRoute Ordered-Dispatch Setup

UTC timestamp: `20261004T014458Z`
Live API: https://omniroute.celestium.life
Management auth: Bearer key fetched from `/run/secrets/omniroute_management_api_key` on 192.168.42.254 (never printed/stored).

## Environment note

The OmniRoute working copy at `/Users/celes/sources/celesrenata/OmniRoute` is currently on branch
`release/v3.8.52`, **not** `feat/hybrid-reader-combo` as the step instructions assumed. No branch
switch was performed (instructions said not to switch). This step only reads live API state and
writes backups, so the checked-out branch does not affect correctness here.

Also note: `/api/management/*` routes do not exist on the live server (404). The working management
endpoints are `/api/combos` (combo list) and `/api/providers/<id>` (per-connection detail).
`/api/resilience/connections` is localhost-only (403 remotely), so per-connection detail was pulled
from `/api/providers/<id>` instead.

## Backup file paths

All under `/Users/celes/sources/kube/omniroute/backups/`:

- `all-combos-20261004T014458Z-before-ordered-dispatch.json` — full `/api/combos` response (90158 bytes, HTTP 200)
- `esnixi-5090-connection-20261004T014458Z-before-ordered-dispatch.json` — `/api/providers/e9bd13fb-c6b6-4c18-b42f-3395266348ce` (HTTP 200)
- `gremlin-4070ti-ollama-connection-20261004T014458Z-before-ordered-dispatch.json` — `/api/providers/b20e0770-3e14-40c1-87cd-85c34b34381a` (HTTP 200)
- `stabulous-m5max-glm53-connection-20261004T014458Z-before-ordered-dispatch.json` — `/api/providers/70b82fc9-6f96-41ac-aa16-8da6099dd7ac` (HTTP 200)

## Connection ID resolution

| Role | Full ID | Connection name | Provider |
|------|---------|-----------------|----------|
| esnixi-5090 | `e9bd13fb-c6b6-4c18-b42f-3395266348ce` | esnixi-5090 | vllm |
| 4070 Ti (b20e0770-…) | `b20e0770-3e14-40c1-87cd-85c34b34381a` | gremlin-4070ti-ollama | ollama-local |
| GLM-5.3 llama-cpp (70b82fc9-…) | `70b82fc9-6f96-41ac-aa16-8da6099dd7ac` | stabulous-m5max | llama-cpp |

(There is also a separate vllm connection `d1e3ee59-0182-4cda-932b-c1950f1d5f75` named `gremlin-4070ti`;
the instruction's `b20e0770-…` matches the **ollama-local** one.)

## Current esnixi-5090 maxConcurrent

**`maxConcurrent = 2`** (defaultModel `qwen3.8-27b-nvfp4`, priority 1, isActive true, testStatus active).

## Tier-1 code pool (`pool/tier1/code`)

- Strategy: **priority**
- context_length: 163840
- Model order:
  1. `vllm/qwen3.8-27b-nvfp4` — conn esnixi-5090 — weight 55
  2. `ollama-local/qwen3.8:27b-iq3-code144k` — conn gremlin-4070ti-ollama (b20e0770) — weight 21
  3. `llama-cpp/ds4-glm53` — conn stabulous-m5max/GLM-5.3 (70b82fc9) — weight 20

## Tier-2 27B pools — current first targets

Pools whose **first target is a Bedrock Qwen coder** (strategy `priority`):

| Pool | Strategy | First target [0] |
|------|----------|------------------|
| `pool/tier2/code` | priority | `bedrock/qwen.qwen3-coder-next` (bedrock-cloud) ← Bedrock Qwen |
| `pool/tier2/tester` | priority | `bedrock/qwen.qwen3-coder-next` (bedrock-cloud) ← Bedrock Qwen |
| `pool/tier2/reviewer` | priority | `bedrock/qwen.qwen3-coder-next` (bedrock-cloud) ← Bedrock Qwen |
| `pool/tier2/research` | priority | `bedrock/qwen.qwen3-coder-next` (bedrock-cloud) ← Bedrock Qwen |

For the above four, member [1] is also a Bedrock Qwen coder (`bedrock/qwen.qwen3-coder-30b-a3b-v1:0`),
then Mistral codestral/mistral-code, then `bedrock/global.openai.gpt-5.6-luna`.

Pools whose first target is **not** a Bedrock Qwen coder (strategy `round-robin`):

| Pool | Strategy | First target [0] |
|------|----------|------------------|
| `pool/tier2/any` | round-robin | `mistral/codestral-latest` (mistral-free), weight 25 |
| `pool/tier2/long` | round-robin | `mistral/codestral-latest` (mistral-free), weight 25 |
| `pool/tier2/frontier` | round-robin | `mistral/codestral-latest` (mistral-free), weight 25 |

(any/long/frontier members: codestral 25, mistral-code 25, `bedrock/global.openai.gpt-5.6-luna` 50.)

### Summary: which tier-2 pools start with Bedrock Qwen coders
**code, tester, reviewer, research** start with the Bedrock Qwen coders.
**any, long, frontier** do not — they are round-robin starting with Mistral codestral.
