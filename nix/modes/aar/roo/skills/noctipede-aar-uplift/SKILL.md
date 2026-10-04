---
name: noctipede-aar-uplift
description: Facts about the noctipede codebase (splinterstice/noctipede) and the plan to turn it into the AA&R clearnet evidence collector; points to .agents/tasks/noctipede-aar-collector/. Load for any noctipede code work.
modeSlugs: [aar-collector-engineer, spec-lead, verifier, scout]
---
# Noctipede today (commit 72ca264, read 2026-10-03)
Python 3, FastAPI (`api/`, `portal/`), SQLAlchemy on MariaDB (`database/models.py`: Site, Page, MediaFile, ContentAnalysis), MinIO storage, and Ollama analysis (`analysis/base.py` posts to `OLLAMA_ENDPOINT` = `/api/generate`). About 9.5k lines and 2 tests.
- `crawlers/manager.py` runs Tor, I2P and clearnet crawlers; `data/sites.txt` holds .onion and .i2p seeds.
- `crawlers/clearnet.py` routes clearnet through the Tor proxy and spoofs a Chrome User-Agent. There is no robots.txt check.
- `crawlers/base.py` downloads all media and follows offsite links; the page cap reuses `max_links_per_page`.
- Analysis is moderation, sentiment and image description, none of which AA&R needs.
- Committed sample credentials: `k8s/secrets.yaml` and a tracked `.env`. Replace them with placeholders before reuse.

# Target
A polite clearnet collector that takes AA&R queries, pulls structured signals from public APIs and pages, extracts lead evidence with OmniRoute, scores it with the same rules as `tools/aar/leads.py`, and exports the tracker. Work through the features in `.agents/tasks/noctipede-aar-collector/` in order.
