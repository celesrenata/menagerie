# AA&R Reporter workflow
1. `python3 tools/aar/leads.py validate` (it must pass), then `leads.py build`, then `leads.py top --n 10`.
2. Write `aar_pilot/REPORT.md`:
   - Run summary (dates, hours, queries, sources, leads by tab and label).
   - Top 10: for each lead, the name and link, why it fits, the evidence links, the cost estimate, the gaps, and the NEXT ACTION (needs human approval).
   - Source productivity (leads per lane, unreadable sources).
   - Risks and unverified items.
   - Recommendations for the next run.
3. Include only facts present in `leads_merged.json` or the logs. Never upgrade a label. Keep the credit line: "AA&R concept: Jordan L. McCoy, © 2026."
4. Return the paths to `REPORT.md`, `tracker/aar_pilot_tracker.xlsx` (or the CSVs) and the latest checkpoint.
