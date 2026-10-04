# AA&R Collector Engineer workflow
1. Read `.agents/tasks/noctipede-aar-collector/` (task.json, context.json, plan.md, features). Work in `feature_order` and do one feature per branch commit.
2. Before coding, run the existing tests (`pytest -q`) to record the baseline.
3. Hard constraints for every change:
   - The AA&R profile never starts the Tor or I2P crawlers and never routes clearnet through a proxy.
   - It checks robots.txt, sends an honest User-Agent, keeps per-host delays of at least 2 s, backs off on 429/503, and uses GET only (no forms or logins).
   - Media download is off by default.
   - Secrets come only from env vars. Remove committed sample secrets and replace them with `.env.example` placeholders.
4. Write tests with each feature (fixtures, no live network in unit tests). Run `pytest -q` and keep it green.
5. Update the feature's `status` and `findings`. When everything is done, hand off to `verifier`.
