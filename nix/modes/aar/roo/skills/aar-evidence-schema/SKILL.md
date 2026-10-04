---
name: aar-evidence-schema
description: Exact JSON Lines lead record format, shard naming and the leads.py commands for validating, merging, scoring and exporting AA&R leads to the tracker. Load before writing or reading any lead.
modeSlugs: [aar-orchestrator, aar-scout, aar-qualifier, aar-reporter, aar-discovery, aar-collector-engineer]
---
# AA&R lead record
One JSON object per line in `aar_pilot/leads/<shard>.jsonl`. Shards: `<lane>-b<NN>` for scouts, `qual-<NN>` for the qualifier, `solo` for single-agent runs. Never edit another worker's shard.

```json
{"asset_name":"ExampleBot","asset_type":"discord-bot",
 "urls":["https://github.com/x/examplebot"],"lane":"github","source_platform":"GitHub",
 "owner_handle":"@x","contact_route":"https://github.com/x/examplebot/issues",
 "owner_exit_signal":{"quote":"Looking for a new maintainer","url":"https://github.com/x/examplebot#readme","checked_at":"2026-10-04"},
 "demand_signals":[{"metric":"stars","value":2100,"url":"https://github.com/x/examplebot","checked_at":"2026-10-04"}],
 "last_update_date":"2023-05-02","asking_price":null,"est_all_in_cost":40,"cost_notes":"free handoff + $12 domain + $0 hosting tier + ~$28 tools",
 "asset_bundle":{"source_code":"Confirmed","domain":"Unknown","hosting":"Unknown","app_ownership":"Likely"},
 "rights_notes":"MIT licence","repair_estimate":"update discord.js v13 to v14, ~2 days","upside_idea":"premium tier",
 "gates":{"g1_owner_signal":true,"g3_asset_bundle":true,"g4_demand_proof":true,"g5_repair_path":true,"g6_lawful_path":true,"g7_simple_upside":true},
 "subscores":{"demand":18,"owner_exit":18,"budget_fit":14,"transferability":10,"repair":7,"upside":6,"fit":5},
 "confidence":"Medium","red_flags":[],"auto_reject_reason":null,
 "next_action":"Ask owner about a maintainer handoff (needs human approval)",
 "date_found":"2026-10-04","found_by":"aar-scout github-b01"}
```
Required fields: `asset_name`, `asset_type`, `urls`, `lane`, `date_found`.
- `asset_type`: discord-bot, open-source-tool, browser-extension, calculator-tool, dev-utility, template-workflow, directory-data, expired-domain, wordpress-plugin, marketplace-app, browser-game, community-forum, resource-site, other.
- Bundle keys: source_code, domain, hosting, app_ownership, store_listing, brand, docs, database, community, payment_account. Values: Confirmed, Likely or Unknown.
- Every demand signal and exit signal has a `url` and `checked_at`. Values are copied exactly, never estimated. Use `"Unverified"` in notes instead of guessing.
- `id` is optional; it is derived from the first URL so duplicates across lanes merge automatically. Later non-empty values win; demand signals, URLs and red flags are unioned.

## Commands
- `python3 tools/aar/leads.py validate`: exits 1 on errors. Fix them before finishing.
- `python3 tools/aar/leads.py build`: writes `aar_pilot/tracker/` (qualified, discovery_leads, watchlist, rejected and search_log CSVs, `leads_merged.json`, and `aar_pilot_tracker.xlsx` if openpyxl is installed).
- `python3 tools/aar/leads.py stats` and `top --n 10`.
