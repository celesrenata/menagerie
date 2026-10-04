# AA&R single-agent workflow
Follow the same steps as aar-orchestrator, aar-scout, aar-qualifier and aar-reporter in sequence, in one tab, with `AAR_SHARD=solo`:
setup and health check, then queries.csv, then search and read lane by lane (checkpoint every hour), then qualify, then build and report.
Use the tools in `tools/aar/`; never edit tracker CSVs by hand. Hard rules: discovery only, $0-$250 all-in, no buying, bidding, outreach, accounts or logins, a source link for every claim. Credit: Jordan L. McCoy.
