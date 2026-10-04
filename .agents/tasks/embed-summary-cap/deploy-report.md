# OmniRoute deploy: 3.8.62-embed-summary-cap-20261003

## Source

- Repo: /Users/celes/sources/celesrenata/OmniRoute, branch `feat/hybrid-reader-combo`
- HEAD: `a2169c18f` fix(combo): respect prefix-cache gate on fallback compression (same commit as `fix/embed-summary-cap`)
- `git archive feat/hybrid-reader-combo` → esnixi `~/build/omniroute-a2169c18f/` (removed after build)

## Build (esnixi, 192.168.42.254)

```
docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 \
  -t registry.celestium.life/library/omniroute:3.8.62-embed-summary-cap-20261003 .
```

- Next.js build stage `#18 DONE 232.6s` (618/618 static pages)
- Local image ID: `sha256:65a654dc2ef680e4f9409265b19058d285ea0b70d99c2435a38c3ab63e8ce5a0`
- Push: `3.8.62-embed-summary-cap-20261003: digest: sha256:0b7f7b71bd57edadfe6beb152577e3a3339754941275d4e902e524a45f69c50e size: 3885`
- Exit 0. Full log: esnixi `~/build/build-a2169c18f.log`

## Manifest

- File: /Users/celes/sources/kube/omniroute/omniroute.yaml (line 61)
- Old: `registry.celestium.life/library/omniroute:3.8.61-prefix-stable-20261003`
- New: `registry.celestium.life/library/omniroute:3.8.62-embed-summary-cap-20261003`
- Kube repo commit: `dc8c1c3` chore(omniroute): deploy 3.8.62-embed-summary-cap-20261003 (not pushed)

## Rollout

- `kubectl apply`: deployment.apps/omniroute configured; persistentvolume/omniroute-data "configured" (same recurring apply-time PV diff as prior deploys); rest unchanged
- `rollout status` → `deployment "omniroute" successfully rolled out` (revision 58)
- Pod `omniroute-5f67c57c69-s2drr` on gremlin-1, Running, 0 restarts

## Digest verification

- Pod image: `registry.celestium.life/library/omniroute:3.8.62-embed-summary-cap-20261003`
- Pod imageID: `registry.celestium.life/library/omniroute@sha256:0b7f7b71bd57edadfe6beb152577e3a3339754941275d4e902e524a45f69c50e`
- Matches pushed digest: yes

## Post-deploy observation

- Serving traffic: `hybrid/code` combo → `vllm/qwen3.8-27b-nvfp4` succeeded (200, 0 fallbacks); embeddings via `arc-embed/qwen3-embedding-0.6b`, memory injection, and stacked compression (168068 → 90244 tokens) all logging normally.
- `memory.rerank.http_fail {"status":400,"model":"bge-reranker-base"}` still appears; it was already present before the 3.8.61 deploy and has nothing to do with this change.

## OVMS embeddings max_length 8192 -> 4096

- Kube repo commit: `67a40942d59165fa21e4dac7049425be474c8c00` (`fix: ovms-embeddings max_length 4096 (OmniRoute caps/chunks inputs)`), not pushed.
- File: `omniroute-memory/ovms-embeddings-statefulset.yaml`, init container `model-pull`: `--max_length=4096`, `--truncate=true` kept; the comment explaining that truncate does not truncate in OVMS 2026.4.0 was kept, with its numbers updated to 4096 / OmniRoute caps.
- `kubectl apply` -> `statefulset.apps/ovms-embeddings configured` (namespace `omniroute-memory`).
- `kubectl -n omniroute-memory rollout status sts/ovms-embeddings` -> `partitioned roll out complete: 4 new pods have been updated`.
- `ovms-embeddings` 4/4 Ready (pods 0-3 Running 1/1, 0 restarts, on gremlin-1..4). The live spec shows `--max_length=4096`.
