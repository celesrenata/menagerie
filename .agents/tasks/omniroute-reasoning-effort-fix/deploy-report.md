# OmniRoute reasoning_effort fix — Deploy Report

Date: 2026-10-03

## Summary

Built and deployed the backend-aware `reasoning_effort` `high -> xhigh` normalization
fix (for ollama-local qwen3.5/qwen3.8 restricted thinking vocab) to the live
`omniroute` namespace.

## Source

- Repo: `/Users/celes/sources/celesrenata/OmniRoute`
- Branch: `feat/hybrid-reader-combo`
- Fix commit: `62c15ee22d26f0e0a54673b1297bd8dbf87ba01f`
  — `fix(reasoning-effort): backend-aware high->xhigh normalization for ollama-local`
- NOT pushed to any git remote (per instruction).

## Build (native on esnixi)

- Host: `celes@192.168.42.254` (esnixi), Docker 29.8.0, 24 cores / 125 GB RAM.
- Build dir: `~/sources/omniroute-reasoning-effort-build` (rsynced from the committed
  Mac tree; excluded `.git/`, `node_modules/`, `.next/`, `.build/`, `dist/` to match
  `.dockerignore`).
- Command:
    ```
    docker build --target runner-cli \
      --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 \
      --build-arg OMNIROUTE_BUILD_WORKERS=4 \
      -t registry.celestium.life/library/omniroute:3.8.54-reasoning-effort-fix-20261003 .
    ```
- Build result: success (no OOM). Local image ID `sha256:52fdbb21d6ea`, size 3.57 GB.

## Pushed Image

- Tag: `registry.celestium.life/library/omniroute:3.8.54-reasoning-effort-fix-20261003`
- Registry digest: `sha256:4799966cfee0241a844679b7205ab0f15ffa1d462424578ca0057dd5968ed465`

## Kube YAML Change

- File: `/Users/celes/sources/kube/omniroute/omniroute.yaml`
- Image tag updated:
  `3.8.53-combos-fix-20261002` -> `3.8.54-reasoning-effort-fix-20261003`
- Commit (local, NOT pushed): `c0b8300658b0adbe6a934fee41e793ed4b6d748b`
  — `chore(omniroute): deploy 3.8.54-reasoning-effort-fix-20261003`

## Deploy & Rollout Verification

- `kubectl apply -f omniroute.yaml` -> `deployment.apps/omniroute configured`.
- Strategy: `Recreate` (replicas: 1).
- `kubectl rollout status deployment/omniroute` -> successfully rolled out.
- Pod: `omniroute-649d6f547b-jlv2s` on `gremlin-1`
    - Status: **1/1 Running**, ready=true
    - **Restart count: 0** (stable, not crash-looping — rechecked after 25s)
    - Running image: `registry.celestium.life/library/omniroute:3.8.54-reasoning-effort-fix-20261003`
    - **Running imageID digest: `sha256:4799966cfee0241a844679b7205ab0f15ffa1d462424578ca0057dd5968ed465`**
      — matches the pushed digest exactly.

## Live Health Probe (https://omniroute.celestium.life)

- `/readyz` -> 200
- `/v1/models` (Bearer mgmt key) -> 200
- `/api/healthz` (no auth) -> 401 (expected; endpoint requires auth)

## Status

HEALTHY — deployed image verified by digest, pod running with 0 restarts, service serving.
