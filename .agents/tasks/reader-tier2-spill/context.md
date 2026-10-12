# Reader/overflow spilling to paid Bedrock — context to fix

Date: 2026-10-04 ~03:25Z. Written by the orchestrator for the user to finish in the Zoo settings UI.

## Symptom
OmniRoute call_logs show a flood of requests whose `combo_name = pool/tier2/reader`, served by step `reader-t2-qc30` on **bedrock** (paid). ~100 per 15 min, avg ~20–23K input tokens, `api_key_name = zoo-m5`, `source_format = openai`, spread across many `conv_*` session tags. The local 4070 Ti 9B reader (`hybrid/reader` → `reader-t1-1`, ollama-local) is barely used.

## Why the earlier concurrency fix did NOT help
`pool/tier2/reader` is being named **directly as the model id** on the request. OmniRoute therefore enters the combo at tier 2 and never considers tier 1, so the local 9B is skipped by construction. Raising `pool/tier1/reader` concurrency (done: cpm 1→4, kube a120b35) and the 4070 Ti connection maxConcurrent (done: 1→4, kube 14575b6) is correct and worth keeping, but it cannot catch traffic that never enters at tier 1.

## What it is NOT (ruled out)
- NOT the codebase indexer. `codebaseIndexConfig` is correct: `codebaseIndexEmbedderModelId = arc-embed/qwen3-embedding-0.6b`, base `http://10.1.1.12:2702` (LAN OVMS), Qdrant `http://10.1.1.12:6333`. That path is local and fine.
- NOT the flake template. `modules/home/zoo/omniroute-zoo-profiles.template.json` uses `hybrid/reader` and `hybrid/research`, never `pool/tier2/reader`.
- A sampled `pool/tier2/reader` call body actually had `model: llama-cpp/ds4-glm53`, 123 msgs, tools — i.e. OmniRoute received `model: pool/tier2/reader`, resolved the combo, and the chosen step/upstream was recorded. The point stands: the **client is sending `pool/tier2/reader` as the model**.

## Root cause (to confirm in the UI)
A saved Zoo **API profile** has its model/route (`openAiModelId`, and/or the reader-route override `openAiOmniRouteReaderRouteId`) set to `pool/tier2/reader` instead of `hybrid/reader`. The saved profiles live in the encrypted secret `roo_cline_config_api_config` (VS Code secret storage), which can't be read from disk — so the exact profile must be found in the UI.

The one profile I could read from plaintext global state (`ZooCodeOrganization.zoo-code`) showed:
- `openAiModelId = hybrid/planner`
- `openAiOmniRouteReaderRouteId = hybrid/research`
That is the *active* profile only; the offending value is on a *different* saved profile used by a mode (e.g. a reader/scout mode's `apiConfigName`).

## Fix (Zoo settings UI)
1. Zoo panel → gear/Settings → **Providers / API Configuration profiles**.
2. For each profile (especially any reader/scout/"fast"/"low reader" profile), check:
   - **Model** (`openAiModelId`)
   - the **OmniRoute reader route** override field (`openAiOmniRouteReaderRouteId`)
3. Any profile set to `pool/tier2/reader` (or any `pool/tierN/*`) → change to the hybrid entrypoint:
   - reader lane → `hybrid/reader`
   - research/high-reader → `hybrid/research`
   - never target a `pool/tierN/*` combo directly; always a `hybrid/*` route so tier 1 (local) is tried first.
4. Save. Also check **Modes**: each mode's `apiConfigName` should map to a profile whose route is a `hybrid/*` entrypoint.

## How to verify after the change
Watch the split; local should win and Bedrock reader calls should stop:
```
kubectl -n omniroute exec deploy/omniroute -- node -e '
const D=require("better-sqlite3");const db=new D("/app/data/storage.sqlite",{readonly:true});
const since=new Date(Date.now()-5*60e3).toISOString();
for(const x of db.prepare("select combo_name c, combo_step_id s, provider p, count(*) n from call_logs where timestamp>=? and combo_name like ? group by 1,2,3 order by n desc").all(since,"%reader%")) console.log(Object.values(x).join(" | "));'
```
Expect `hybrid/reader | reader-t1-1 | ollama-local` and no `pool/tier2/reader | ... | bedrock`.

## Make it durable (flake)
The offending profile is a live/saved profile not represented in the flake. Once the correct value is known, encode it in `modules/home/zoo/omniroute-zoo-profiles.template.json` so `darwin-rebuild` reasserts it. The codebase-index config is also UI-only today; consider adding it to the flake too.

## Immediate stop available without the UI (declined so far — option 1)
Add the local 4070 Ti 9B as the FIRST target of `pool/tier2/reader` so even tier-2-entry traffic hits local first, then Bedrock. One management-API change, reversible, backup on hand. Say the word and the orchestrator will apply it.

## Changes already applied tonight (kept)
- `pool/tier1/reader` concurrencyPerModel 1→4 (kube a120b35)
- `gremlin-4070ti-ollama` connection maxConcurrent 1→4 (kube 14575b6)
Backups for both are committed under `omniroute/backups/` (not pushed).

---

## UPDATE 2026-10-04 (confirmed via call_logs + combo def) — root cause refined

The earlier theory (a profile set literally to `pool/tier2/reader`) was close but wrong on the exact value. Verified from live data:

### What the client actually sends
`model: bedrock/qwen.qwen3-coder-30b-a3b-v1:0` — a **raw Bedrock model id**, not `pool/tier2/reader` and not `hybrid/reader`.
- `requested_model = bedrock/qwen.qwen3-coder-30b-a3b-v1:0` on 100% of the offending rows
- `source_format = openai`, `api_key_name = zoo-m5`, `model_pinned = 0`
- Last 2h: **230 calls, ~5.0M input tokens, 51 distinct `conv_*` sessions**, all on paid Bedrock.

### Why it lands in `pool/tier2/reader` on Bedrock
The combo `pool/tier2/reader` (id `22a01a02-…`, `strategy: priority`) has as its **first step**:
```
reader-t2-qc30 → model bedrock/qwen.qwen3-coder-30b-a3b-v1:0, providerId bedrock,
                 connectionId d4a9a6e4-d054-498a-8fde-aa35dc4dc506, weight 0
```
So a request whose model id *is* `bedrock/qwen.qwen3-coder-30b-a3b-v1:0` resolves straight into that combo at the paid Bedrock step. Tier 1 (local 9B via `hybrid/reader`) is never considered because the request never names a `hybrid/*` route. No `model_combo_mappings` row is involved — it matches by the step's own model id.

### Who is generating it — the AA&R scout mode (NOT the Zoo code reader lane)
A sampled request body (artifact `…T03-15-31.719Z_3d519dc6….json`): 102 messages, 13 tools, and a system prompt beginning:
> "You collect AA&R leads from one assigned source lane … append evidence-backed lead records to your own shard file."
That is the **`aar-scout`** mode from `Menagerie-Modes-v2-AAR/.roomodes`. These scout agents fan out across many sessions, each ~20–32K input tokens, which is the token flood.

### Exact fix target
`.roomodes` does NOT pin a model (confirmed — no model id in the file). Model routing is per-mode via the Zoo **API profile** bound through each mode's `apiConfigName`, stored in the encrypted `roo_cline_config_api_config` secret (UI-only, not on disk). The offending profile — the one bound to **`aar-scout`** (and probably the other AA&R worker modes: `aar-qualifier`, `aar-collector-engineer`, `scout`, `researcher`) — has:
- `openAiModelId = bedrock/qwen.qwen3-coder-30b-a3b-v1:0`  ← **change this to `hybrid/reader`**

In the Zoo settings UI:
1. Settings → Providers / API Configuration profiles.
2. Find the profile(s) bound to the AA&R scout/qualifier/collector modes (check Modes → each mode's `apiConfigName`).
3. Any profile whose Model (`openAiModelId`) is `bedrock/qwen.qwen3-coder-30b-a3b-v1:0` (or any raw `bedrock/*` / `pool/tierN/*`) → set to `hybrid/reader` (research-heavy → `hybrid/research`). Also clear/sanity-check `openAiOmniRouteReaderRouteId`.
4. Save. Rebalancing concurrency can't help here — the traffic never enters at tier 1 by construction.

### Verify after change (same query, by requested_model)
```
kubectl -n omniroute exec deploy/omniroute -- node -e '
const D=require("better-sqlite3");const db=new D("/app/data/storage.sqlite",{readonly:true});
const since=new Date(Date.now()-5*60e3).toISOString();
for(const x of db.prepare("select requested_model rm, combo_name c, provider p, count(*) n from call_logs where timestamp>=? and combo_name like ? group by 1,2,3 order by n desc").all(since,"%reader%")) console.log(Object.values(x).join(" | "));'
```
Expect the `bedrock/qwen.qwen3-coder-30b-a3b-v1:0 | pool/tier2/reader | bedrock` line to go to zero and `hybrid/reader | … | ollama-local` to appear.

### Tier ladder is an escalation ladder, NOT a size mapping (clarified 2026-10-04)
The reader tiers are a priority escalation chain, not "tier N = model size N". Confirmed from the combo defs:
- tier 1 → local 9B (`ollama-local/qwen3.5-reader:9b`)
- tier 2 → first cloud escalation (`bedrock/qwen.qwen3-coder-30b`, `mistral/codestral-latest`, `mistral/mistral-code-latest`, `bedrock/.../gpt-5.6-luna`)
- tier 3/4/5 → progressively larger cloud/Bedrock models
`hybrid/reader` is a `priority` chain of combo-refs tier1→tier2→…→tier5, so a client using `hybrid/reader` hits the local 9B first and only escalates to tier-2 cloud when tier 1 is saturated/unavailable. The combo structure is **correct as designed** — do NOT inject a local model into tier 2. (Earlier note about tier 2 "missing a local 27B" was based on a mistaken tier=size assumption and is retracted.)

### Fix is client-side only
The real and only durable fix is the AA&R mode profile change above (`openAiModelId` → `hybrid/reader`). No combo edit is warranted. A combos-table workaround (forcing a local model into tier 2) would corrupt the intended escalation ladder and affect every `hybrid/reader` consumer, not just the AA&R scouts — do not do it.

---

## UPDATE 2026-10-04 ~03:50Z — ACTUAL root cause found (earlier theories were WRONG)

Not a Zoo API profile, not config drift. It is a **hardcoded route list in the AA&R tool**.

### The real culprit
`Menagerie-Modes-v2-AAR/tools/aar/omniroute.py`, `ROLES` dict, `extract` role was:
```python
"extract": ["pool/tier2/reader", "hybrid/reader", "hybrid/tiny"],
```
`aar-scout` runs the `extract` role, which tries route **`pool/tier2/reader` first**. Naming a `pool/tierN/*` combo directly as the model id enters OmniRoute's escalation ladder *at that tier*, so it lands straight on the paid Bedrock step (`reader-t2-qc30` = `bedrock/qwen.qwen3-coder-30b-a3b-v1:0`) and never tries tier 1 (local 9B). This was a deliberate choice — the skill doc `.roo/skills/omniroute-routing/SKILL.md` even documented `aar-scout → pool/tier2/reader → "qwen3-coder-30b, good tool use, fast"` and told people to *avoid* `pool/tier1/reader` ("often at capacity").

### Why the Zoo-profile / flake theories were wrong
- The flake (`m5max-darwin-flake`) `omniroute-zoo-profiles.template.json` is correct — all reader profiles point at `hybrid/reader`/`hybrid/research`. The AA&R modes aren't even in its `modeApiConfigs`.
- The flake's `scripts/configure-omniroute.sh` builds a FLAT zero-cost `hybrid/reader` (local-first), and does NOT build the `pool/tierN/*` tier combos at all. The live tiered `pool/*` architecture (reader/code/tester/planner/… × 5 tiers) was built out-of-band by a different generator not in these two repos. It is intentional and internally consistent — NOT drift. Do not flatten it by re-running the flake script.

### Fix applied (source-level, committed to repo files)
- `tools/aar/omniroute.py`: `extract` → `["hybrid/reader", "hybrid/tiny"]` (dropped the direct `pool/tier2/reader`). `hybrid/reader` is the tier1→5 chain, so it tries local 9B/27B first and only escalates to cloud on capacity.
- `.roo/skills/omniroute-routing/SKILL.md`: `aar-scout` row → `hybrid/reader`; replaced the "avoid tier1" note with a rule: never name a `pool/tierN/*` combo directly; always use a `hybrid/*` route. Noted tier1/reader concurrency is now 4.
- Python syntax verified OK.

### Still required to STOP the live bleed
The running scout processes loaded the OLD `ROLES` into memory. The file edit only affects processes started AFTER it. **Restart the AA&R scout run** to pick up the fix. Until then Bedrock calls continue.

### Verify after scout restart
```
kubectl -n omniroute exec deploy/omniroute -- node -e '
const D=require("better-sqlite3");const db=new D("/app/data/storage.sqlite",{readonly:true});
const since=new Date(Date.now()-5*60e3).toISOString();
for(const x of db.prepare("select requested_model rm, combo_name c, provider p, count(*) n from call_logs where timestamp>=? and combo_name like ? group by 1,2,3 order by n desc").all(since,"%reader%")) console.log(Object.values(x).join(" | "));'
```
Expect `bedrock/qwen.qwen3-coder-30b | pool/tier2/reader | bedrock` to fall to zero and tier1 `ollama-local` rows to appear.

### Combo-level backstop (optional, server-side)
The orphan risk remains: anything that names `pool/tier2/reader` directly still hits paid Bedrock. If you want defense-in-depth independent of client code, reorder `pool/tier2/reader`'s priority steps to put a local model first, OR drop the bedrock step from tier 2. Not applied — the client fix is the correct primary fix and the tiered architecture is owned elsewhere.
