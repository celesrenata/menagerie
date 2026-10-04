# Deploy report: OmniRoute context-estimate fix

Status: deployed and verified.

- Source: OmniRoute `feat/hybrid-reader-combo` @ `1d48e1cfd` (fix(context): estimate only forwarded reasoning and honor per-target input policy), clean tree
- Build host: celes@192.168.42.254, `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384`, exit 0
- Image: `registry.celestium.life/library/omniroute:3.8.63-context-estimate-20261003`
- Pushed digest: `sha256:362e3a69fe20505cfe040e9dd67239ed835608e0bd8f020df20d7032eb1e61e9`
- Kube commit: `4d30536` on `master` in /Users/celes/sources/kube (`omniroute/omniroute.yaml` image 3.8.62-embed-summary-cap-20261003 -> 3.8.63-context-estimate-20261003). Not pushed.

## Rollout

- `kubectl apply -f omniroute/omniroute.yaml`: deployment configured (PV `omniroute-data` also reported "configured", same as prior applies; other resources unchanged)
- `kubectl -n omniroute rollout status deploy/omniroute`: successfully rolled out (Recreate)
- Pod `omniroute-7df4f85777-mjz6j`: Running, ready=true, restarts=0
- Running imageID: `registry.celestium.life/library/omniroute@sha256:362e3a69fe20505cfe040e9dd67239ed835608e0bd8f020df20d7032eb1e61e9` (matches pushed digest)
- Post-rollout logs show live traffic: memory injection, compression, and combo context limit resolution (`hybrid/code`, 262144, combo-explicit) all working.

Note: the `omniroute-nfs-backup` CronJob still uses 3.8.50-bedrock-flex-openai-guard-20260926; untouched by this deploy.
