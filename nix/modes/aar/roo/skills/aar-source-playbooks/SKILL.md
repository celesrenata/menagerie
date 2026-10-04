---
name: aar-source-playbooks
description: Per-lane query recipes and public read-only API endpoints for AA&R lead collection (GitHub, Discord bot lists, browser extension stores, WordPress.org, maker communities, Product Hunt, marketplaces, expired domains, old tool sites). Load in scouts before searching.
modeSlugs: [aar-scout, aar-orchestrator, aar-discovery]
---
# Lanes
Search through `tools/aar/omniroute.py search` (providers: `duckduckgo-free` for the web, `context7` for code and docs). Read through `tools/aar/polite_fetch.py`. Cache hits are free; re-running a query is not.

| Lane | Query patterns | Read-only APIs / pages | Demand signals |
|---|---|---|---|
| github | "looking for maintainer" discord bot; "seeking new maintainer"; "no longer maintained" chrome extension; "up for adoption"; "transfer ownership" repo | `https://api.github.com/repos/{o}/{r}` (stars, forks, pushed_at, archived, open_issues), `/repos/{o}/{r}/issues?state=open&sort=created`; unauthenticated limit 60/hour, so fetch each repo once | stars, forks, recent issues, dependents |
| topgg | top.gg bot offline; discord bot shutting down; "looking for new owner" bot | bot pages on top.gg, discord.bots.gg, discordbotlist.com (skip if blocked) | server count, votes, last update |
| amo | firefox addon no longer maintained; site:addons.mozilla.org abandoned | `https://addons.mozilla.org/api/v5/addons/addon/{slug}/` (average_daily_users, last_updated, ratings) | users, rating count, last update |
| chrome | chrome extension not updated since 2023 users; "no longer maintained" chrome extension | listing page (users, updated date) via polite_fetch | users, rating, updated |
| wordpress | "hasn't been tested with the latest 3 major releases"; closed plugin popular | `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]={slug}` | active_installs, last_updated, tested |
| makers | Show HN shutting down; "anyone want my side project"; r/SideProject giving away; "free to a good home" app | HN Algolia `https://hn.algolia.com/api/v1/search?query=...` | upvotes, comments, traffic claims (mark claims as claims) |
| producthunt | product hunt launch 2021 tool site down; founder moved on | product pages via polite_fetch | upvotes, reviews |
| marketplaces | Flippa under $250; SideProjectors free; Tiny Acquisitions; Microns | public listing pages only, logged out | stated metrics (always label them "seller-stated") |
| domains | expired domain {niche} tool; expiring calculator domain | Wayback: `https://archive.org/wayback/available?url={domain}`, CDX `https://web.archive.org/cdx/search/cdx?url={domain}&limit=20&output=json` | history, backlinks if public |
| oldtools | "{niche} calculator" © 2018; "{niche} converter" broken; "{niche} generator" free tool | the page itself, Wayback for history | ranking position, backlinks, last update |

## Rules for every lane
- Prefer APIs to HTML. Respect each API's rate limit and cache everything.
- One lead per asset. When the same asset shows up in another lane, write the same first URL so it merges.
- Follow-ups worth queuing: the author's other repos, forks with traction, "alternatives to X" threads, and directory categories near a hit.
- Skip: anything behind login or CAPTCHA, adult, gambling, cheats, piracy, scraping-for-resale (write an auto-reject record if it looked like a lead).
