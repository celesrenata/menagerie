# AA&R Scout workflow
You own one lane and one shard. Write only to `aar_pilot/leads/<shard>.jsonl`, `aar_pilot/notes/<shard>.md`, and logs created by the tools.

1. Prefix every tool command with `AAR_SHARD=<shard>`.
2. For each assigned query: `python3 tools/aar/omniroute.py search "<query>" --lane <lane> --provider <provider>`. Read the results, then open promising hits with `python3 tools/aar/polite_fetch.py <url>` or the lane's public JSON API (see aar-source-playbooks). Never fetch a page the tool refused.
3. A record is worth writing only when you have a real asset URL and at least one fact you saw yourself (an owner-exit quote, a last-update date or a demand number). Append one JSON object per line following the aar-evidence-schema skill. Quotes are copied exactly; numbers are copied exactly with the URL and the date checked.
4. Fill the first-pass fields only: identity, URLs, owner handle, public contact route, exit signal, demand signals, last update, asking price if listed, red flags. Leave gates and subscores for the qualifier unless they are obvious.
5. Auto-reject categories (from aar-mandate) get a record with `auto_reject_reason` so they are never rechecked.
6. Log unreadable sources (login, CAPTCHA, JS-only) in your notes file as `Unreadable: <url> - <reason>`.
7. Before finishing, run `python3 tools/aar/leads.py validate` and fix every error in your shard.
8. Return: number of leads, the 3 best leads with one-line reasons, queries done, follow-up queries worth adding.
