---
name: omniroute-routing
description: How Menagerie modes map to OmniRoute routes and profiles, verified route ids, search providers, and error handling (503/429/empty replies). Load when choosing a parallel_tasks route, configuring profiles, or debugging model failures.
modeSlugs: []
---
# OmniRoute in Menagerie
- Provider: OpenAI-compatible profile with "This profile uses OmniRoute" turned on. Base URL is the OmniRoute OpenAI endpoint including `/v1` (the deployed menagerie-flake profiles use `https://omniroute.celestium.life/v1`; a local fabric is `http://127.0.0.1:20128/v1`). Model ids are full route ids such as `hybrid/research`.
- The `tools/aar/omniroute.py` helper reads `OMNIROUTE_BASE_URL` (default `https://omniroute.celestium.life/v1`, same `/v1` endpoint) and derives the gateway `/api/health` path from it, so point both at the same base.
- Each mode keeps a sticky profile. A `parallel_tasks` worker inherits its mode's profile unless `route` is set.

## Suggested mode-to-route map (checked 2026-10-04; re-check with `tools/aar/omniroute.py health`)
| Modes | Route | Notes |
|---|---|---|
| spec-lead, aar-orchestrator | hybrid/planner | resolved to ds4-glm53 |
| scout | local/m5-reader | 32k reader; give 512+ max tokens (reasoning model) |
| researcher, issue-investigator, docs-extractor | hybrid/research | fallback pool/tier1/research |
| issue-fixer, pr-fixer, merge-resolver, aar-collector-engineer | hybrid/code | |
| verifier | hybrid/tester | |
| aar-scout | hybrid/reader | zero-cost local-first (9B tier1 → 27B tier2), escalates to cloud only on capacity. NEVER pin pool/tier2/reader directly: it enters the ladder at the paid Bedrock step and skips local. |
| aar-qualifier | hybrid/reviewer | |
| aar-reporter, issue-writer, translate | hybrid/frontier | |
Avoid in this pilot: auto/best-free (fails), auto/best-reasoning (weak). Never name a `pool/tierN/*` combo directly as the model id — doing so enters the escalation ladder at that tier and skips the cheaper lower tiers (e.g. `pool/tier2/reader` lands straight on paid Bedrock). Always use a `hybrid/*` route so tier 1 (local) is tried first. (tier1/reader concurrency raised to 4 on 2026-10-04; the earlier "tier1 at capacity" caveat no longer applies.)

## Search
`POST /v1/search` with `{"query","provider","max_results"}`. Working providers: duckduckgo-free and context7. Keep 3-5 s between searches and pause 60 s when throttled. `/v1/web/fetch` has no provider; read pages directly with `polite_fetch.py`.

## Errors
503/502/429: wait 5 s and retry once, then switch to the role's fallback and log it. An empty reply from a reasoning model means max_tokens was too small; raise it to 512 or more. Never loop on a failing route.
