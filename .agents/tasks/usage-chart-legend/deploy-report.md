# OmniRoute usage-chart-legend — Deploy Report

Date: 2026-10-03

## Summary

Deployed the reviewed (APPROVED) top-N Model Usage Over Time chart / compact legend change to the live `omniroute` namespace.

## Source

- Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo` (clean tree)
- HEAD: `f98cea204` — `fix(i18n): translate model usage chart keys in vi locale`
  (on top of `76dec5550` — `feat(analytics): top-N model usage chart with compact legend`)
- NOT pushed to any git remote.

## Build (native on esnixi, celes@192.168.42.254)

- Build dir: `~/sources/omniroute-usage-chart-legend-build` (rsynced; excluded `.git/ node_modules/ .next/ .build/ dist/`)
- `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 --build-arg OMNIROUTE_BUILD_WORKERS=4 -t registry.celestium.life/library/omniroute:3.8.64-usage-chart-legend-20261003 .`
- Result: success. Local image ID `sha256:45f01ec373e8`, ~3.57 GB.

## Pushed Image

- Tag: `registry.celestium.life/library/omniroute:3.8.64-usage-chart-legend-20261003`
- Registry digest: `sha256:41ff44b9f1ab49dd701ccc97d954329903d8416e18114963970e6e9e3346ae58`

## Kube YAML Change

- File: `/Users/celes/sources/kube/omniroute/omniroute.yaml`
- `3.8.63-context-estimate-20261003` -> `3.8.64-usage-chart-legend-20261003`
- Commit (local, NOT pushed): `cb166bc206fae1ed4c254c8aa7d0a344b139c488` — `chore(omniroute): deploy 3.8.64-usage-chart-legend-20261003` (only that file staged)

## Deploy & Rollout Verification

- `kubectl apply -f omniroute.yaml` -> `deployment.apps/omniroute configured`
- `kubectl -n omniroute rollout status deployment/omniroute` -> successfully rolled out
- Pod `omniroute-86d54dd6b4-ls9jp` on `gremlin-1`: 1/1 Running, restarts 0 (rechecked after ~70s)
- Running imageID: `sha256:41ff44b9f1ab49dd701ccc97d954329903d8416e18114963970e6e9e3346ae58` — matches pushed digest

## Live Health Probe (https://omniroute.celestium.life)

- `/readyz` -> 200
- `/v1/models` (Bearer management key, not printed) -> 200

## Status

HEALTHY
