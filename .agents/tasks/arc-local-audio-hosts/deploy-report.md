# Deploy report: OMNIROUTE_LOCAL_AUDIO_HOSTS (3.8.59)

- OmniRoute commit: `c2bd104a24867598594b34ec4728964611d5efe9` (branch `feat/hybrid-reader-combo`, "fix(audio): honor OMNIROUTE_LOCAL_AUDIO_HOSTS for cluster audio nodes")
- Image: `registry.celestium.life/library/omniroute:3.8.59-local-audio-hosts-20261003`
- Pushed digest: `sha256:42f32da56b5c63eb6bbebd5d5c07518f91cc59c0ec49b324c921cb99ffd90fe4`
- Built on esnixi from a `git archive HEAD` of that commit (`--target runner-cli`, `OMNIROUTE_BUILD_MEMORY_MB=16384`). Build dir removed afterward.
- Kube commit: `5eb32afd5e1bc36d2a53d12178ece4d966563241` in `/Users/celes/sources/kube` (not pushed)
    - Image tag bumped from `3.8.58-priority-tier-ceiling-20261003`.
    - Added `OMNIROUTE_LOCAL_AUDIO_HOSTS=kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local`. Bare hostnames (no ports) because the parser matches a bare host on any port, matching `.env.example`. The live deployment already had this exact value set out-of-band, so the manifest now just matches reality.

## Rollout

- `kubectl apply` then `rollout status deployment/omniroute`: successfully rolled out (Recreate).
- Pod `omniroute-fbf85dcb-4nrrv`: Running, 0 restarts.
- Pod imageID `registry.celestium.life/library/omniroute@sha256:42f32da56b5c63eb6bbebd5d5c07518f91cc59c0ec49b324c921cb99ffd90fe4`, which matches the pushed digest.
- `printenv OMNIROUTE_LOCAL_AUDIO_HOSTS` in the pod returns the expected two hosts.

## Note

`kubectl apply` reports `persistentvolume/omniroute-data configured` on every apply, including the dry-run before this change. It's existing drift unrelated to this deploy.
