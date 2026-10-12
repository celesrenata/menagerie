# OmniRoute Deploy Report — hard-concurrency-cap build

**Date:** 2026-10-04
**Workflow:** wf_6dac22ca5b1a5d29

## Source

- **Repo:** `/Users/celes/sources/celesrenata/OmniRoute`
- **Branch:** `release/v3.8.52`
- **OmniRoute commit SHA:** `42f062246a478907e3b0ec1b59c581bd648f5d1f`
  - `fix(combo): hard per-(connection,model) cap for local GPU targets`
- Working tree clean at build time. Branch NOT pushed (per instructions).

## Build & Push (on esnixi — ssh celes@192.168.42.254)

- **Method:** `git archive HEAD` shipped to `~/omniroute-build-3.8.68`, extracted, built.
- **Build command:** `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 -t registry.celestium.life/library/omniroute:3.8.68-hard-conn-cap-20261004 .`
- **Local image id:** `sha256:631376743bf23e3b79c80081057e76f25c1a3d7a7f292480d923c15551881455`
- **Image tag:** `registry.celestium.life/library/omniroute:3.8.68-hard-conn-cap-20261004`
- **Pushed digest:** `sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

## Kube Manifest Change

- **Repo:** `/Users/celes/sources/kube`
- **File:** `omniroute/omniroute.yaml` — image line only
  - `3.8.67-conn-model-gate-20261004` → `3.8.68-hard-conn-cap-20261004`
- **kube commit SHA:** `784aebfe8fee03c6a4b4b1ff9feb209ea08b4850`
  - `chore(omniroute): bump image to 3.8.68-hard-conn-cap-20261004`
  - 1 file changed, 1 insertion(+), 1 deletion(-) — image line ONLY.
- **cert-manager edit:** The uncommitted `cert-manager.io/cluster-issuer: ca-issuer → celestium-le-production` change (line 171) was LEFT untouched in the working tree and was NOT staged or committed. kube branch NOT pushed.

## Rollout & Verification

- `kubectl apply -f omniroute/omniroute.yaml` (context: `default`) → `deployment.apps/omniroute configured`; all other objects unchanged.
- `kubectl -n omniroute rollout status deploy/omniroute` → **successfully rolled out**.
- **Running pod:** `omniroute-7c9f5c5d6d-n9t8b` (1/1 Running)
  - **spec image:** `registry.celestium.life/library/omniroute:3.8.68-hard-conn-cap-20261004`
  - **running imageID digest:** `sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

### Digest match

| | Digest |
|---|---|
| Pushed | `sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87` |
| Running pod | `sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87` |

**RUNNING == PUSHED ✅**

The `omniroute-nfs-backup-*` pods are unrelated completed backup CronJobs on an old image and are not part of this deploy.
