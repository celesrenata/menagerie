---
name: aar-mandate
description: AA&R hard rules, the $0-$250 budget tiers, target classes, the 7 qualification gates, auto-reject list, status labels and the 100-point scoring rubric. Load before any AA&R planning, collection, qualification or reporting.
modeSlugs: [aar-orchestrator, aar-scout, aar-qualifier, aar-reporter, aar-discovery, aar-collector-engineer]
---
# AA&R mandate (pilot)
AA&R (Autonomous Acquisition and Revival) concept by Jordan L. McCoy, © 2026. Keep this credit in every report.

## Hard rules
1. No buying, bidding, paying, reserving, offers, carts or checkout.
2. No contacting owners, sellers or communities: no DMs, emails, comments, issues, PRs, server joins or contact forms.
3. No accounts, sign-ups or logins. Never bypass login walls, paywalls, CAPTCHAs or bot checks.
4. Public, read-only access. Respect site terms and robots.txt. At most about 1 request per second per site; back off on 429.
5. Collect only contact data the owner published for contact (public handle, project email, support link).
6. Anything beyond reading is written as `NEXT ACTION (needs human approval)`.
7. Spend $0 beyond the configured model and API usage.

## Budget: $0-$250 all-in per target
All-in = asking price + domain renewal + first-month hosting + repair tools + setup.
- $0-75: basic rights, malware, privacy and tech checks.
- $76-175: plus proof it works and a list of what transfers.
- $176-250: plus stronger demand proof (demand subscore of 15 or more), a clear rights path, source review and a 30-day plan.
- Over $250: WATCHLIST only, and only when the fit is excellent and the price could drop.
Free handoffs (maintainer wanted, stewardship, revenue share) count and are often best.

## Targets (priority order)
Discord bots, small open-source tools, browser extensions, calculators/converters/generators, developer utilities, templates/workflows, directories/data tools, expired domains (domain-only; never reuse old content or brand). Also: WordPress plugins, marketplace apps, browser games, communities/forums, resource sites.

## Gates (all 7 are needed for Strong candidate)
g1 owner signal · g2 budget fit (computed from cost) · g3 asset bundle listed (Confirmed/Likely/Unknown) · g4 checkable demand proof · g5 30-day repair path · g6 lawful path · g7 simple upside.

## Auto-reject
Unverifiable or bot traffic; piracy, cheats, scraping-for-resale, adult or gambling, malware or grey-hat tools; IP disputes; sensitive personal data; non-transferable accounts; harmful domain history; "it used to be popular" with no current demand.

## Labels (nothing higher in the pilot)
Discovery lead → Contact-qualified (owner, public contact route, plausible reason to hand over) → Strong candidate (Contact-qualified plus all 7 gates). `tools/aar/leads.py` computes labels and tabs; do not hand-edit them.

## Scoring (0-100)
Demand 25 · Owner-exit likelihood 20 · Budget fit and cost certainty 15 · Transferability 15 · Repair effort 10 (less effort scores higher) · Upside 10 · Fit with our skills 5 (Discord, web tools, browser games, 3D/creative, offline HTML tools). Add confidence: High, Medium or Low.
