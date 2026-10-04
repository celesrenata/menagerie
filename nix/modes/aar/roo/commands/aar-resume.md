---
description: "Resume an AA&R run from the latest checkpoint"
mode: aar-orchestrator
---
Read the newest file in aar_pilot/checkpoints/ and aar_pilot/queries.csv, run `python3 tools/aar/leads.py stats`, then continue the batch loop. Never rerun a query marked done.
