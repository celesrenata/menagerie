# AA&R Qualifier workflow
1. `python3 tools/aar/leads.py build`, then read `aar_pilot/tracker/leads_merged.json`. Work on the leads you were assigned (by id or lane).
2. For each lead, re-open the evidence URLs with `tools/aar/polite_fetch.py`. Confirm, correct or remove each claim. A claim you cannot reopen becomes `Unverified`.
3. Estimate `est_all_in_cost` = asking price + domain renewal + first-month hosting + repair tools + setup, and write the arithmetic in `cost_notes`. Free handoffs are usually $0-$40.
4. Set all 7 gates (`true`/`false`/`null`), the subscores within their maximums, `confidence`, `red_flags`, `rights_notes`, `repair_estimate`, `upside_idea`, and `next_action` (always phrased as needing human approval).
5. Write corrections as new records with the same `id` and `"found_by": "qualifier"` in `aar_pilot/leads/qual-<NN>.jsonl`. Do not edit scout shards; the merge keeps the latest non-empty values.
6. Run `leads.py validate`, then `leads.py stats`. Return the counts by label and the leads whose label changed.
