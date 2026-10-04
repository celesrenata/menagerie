# AA&R Orchestrator workflow
Concept credit: Jordan L. McCoy (© 2026). Discovery only: no buying, bidding, outreach, account creation or logins.

## Setup (first 15 minutes)
1. Confirm that the workspace is a git repo with a commit (`git rev-parse HEAD`); parallel workers need it. `aar_pilot/cache/` stays gitignored, and `aar_pilot/leads/` and `aar_pilot/logs/` stay tracked.
2. `python3 tools/aar/omniroute.py health > aar_pilot/01_environment.json`. If the gateway or every search provider fails, write `aar_pilot/BLOCKED.md` and stop.
3. Write `aar_pilot/queries.csv` (columns: `query_id,lane,provider,query,status,batch`) with 100+ queries across the lanes in the aar-source-playbooks skill. Commit.

## Batch loop (repeat until the time box ends or lanes run dry)
1. Choose up to 3 lanes (the worker pool runs 3 at once; a fourth task queues). Give each worker 10-20 queries with `status=todo` from its lane.
2. Call `parallel_tasks` with mode `aar-scout` for each worker. The message must contain: lane, shard name `<lane>-b<NN>`, the query ids and text, the command prefix `AAR_SHARD=<shard>`, a time box of 20 minutes, the hard rules, and "Return: leads written, queries run, unreadable sources, best follow-up leads."
3. Integrate: for each patch run `git apply --stat` (it must touch only `aar_pilot/leads/<shard>.jsonl`, `aar_pilot/logs/*.<shard>.jsonl`, and notes or queries), then `git apply`. Mark the queries `done` in `queries.csv`. Run `python3 tools/aar/leads.py validate` and send any errors back to a fix-up worker. Commit `aar: batch NN`.
4. Write a checkpoint to `aar_pilot/checkpoints/<NN>.md`: lanes, queries done, lead counts (`leads.py stats`), productive lanes, and the next batch. Rebalance toward productive lanes and add follow-up queries (author profiles, related repos).
5. Every 3 batches, or once 40+ new leads exist, run one `aar-qualifier` worker on the newest leads (shard `qual-b<NN>`).

## Finish
1. Run a final `aar-qualifier` pass, then `new_task` with mode `aar-reporter`.
2. On restart, read the latest checkpoint and `queries.csv`, and never rerun a `done` query.
