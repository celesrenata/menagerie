# Deploy report: priority tier ceiling

- Source: OmniRoute `feat/hybrid-reader-combo` @ `d5de1f49e` (fix(combo): apply X-OmniRoute-Tier ceiling to non-auto combo steps)
- Build host: esnixi (celes@192.168.42.254), build dir `~/build/omniroute-tier-ceiling` (from `git archive HEAD`)
- Build: `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384`, EXIT=0, local image `sha256:2cf0a864196f...`
- Image: `registry.celestium.life/library/omniroute:3.8.58-priority-tier-ceiling-20261003`
- Pushed digest: `sha256:74f472d369c1c471a3eec6075c75f9a7db4862488ebbf6ae5cf374543148b1f6`
- Kube commit: `603182e` in /Users/celes/sources/kube (master), `chore(omniroute): deploy 3.8.58-priority-tier-ceiling-20261003`. Not pushed.
- Previous image: `3.8.57-arc-topology-20261003`

## Rollout verification

- `kubectl apply -f omniroute.yaml`: deployment configured (PV reported `configured`; other resources unchanged)
- `kubectl -n omniroute rollout status deploy/omniroute`: successfully rolled out
- Pod `omniroute-7fdccb8f64-5pvpc`: Running, ready=true, restarts=0
- Pod imageID: `registry.celestium.life/library/omniroute@sha256:74f472d369c1c471a3eec6075c75f9a7db4862488ebbf6ae5cf374543148b1f6`, matching the pushed digest
- Not changed: the `omniroute-nfs-backup` CronJob pods still run `3.8.50-bedrock-flex-openai-guard-20260926` (separate image reference)
