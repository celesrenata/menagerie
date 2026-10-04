# OmniRoute System-Prompt Destruction Fix — Deploy Report

Date: 2026-10-02 (esnixi build-host date)

## Summary

Built and deployed the shape-aware `injectSystemFirst()` merge fix (preserves
array-shaped system content instead of coercing it to `"[object Object]"`, which was
destroying the Zoo/Roo orchestrator system prompt under strict system-first providers)
to the live `omniroute` namespace.

## Source

- Repo: `/Users/celes/sources/celesrenata/OmniRoute`
- Branch: `feat/hybrid-reader-combo`
- Fix commit: `f31c19682` — `fix(memory): shape-aware injectSystemFirst merge preserves array-shaped system content`
- NOT pushed to any git remote (per instruction).
- Review: APPROVED (`.agents/tasks/omniroute-sysprompt-destroyed/review.json`),
  verification `.agents/tasks/omniroute-sysprompt-destroyed/verification.md`.

## Build (native on esnixi)

- Host: `celes@192.168.42.254` (esnixi), Docker 29.8.0.
- Build dir: `~/sources/omniroute-sysprompt-fix-build` (rsynced from the committed Mac
  tree; excluded `.git/`, `node_modules/`, `.next/`, `.build/`, `dist/` to match
  `.dockerignore`). Fix presence confirmed in build tree before building
  (`src/lib/memory/injection.ts` array-content branch + `toText` helper).
- Command:
    ```
    docker build --target runner-cli \
      --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 \
      --build-arg OMNIROUTE_BUILD_WORKERS=4 \
      -t registry.celestium.life/library/omniroute:3.8.55-sysprompt-fix-20261002 .
    ```
- Build result: success (no OOM). Local image ID `sha256:f322747559cf`.

## Pushed Image

- Tag: `registry.celestium.life/library/omniroute:3.8.55-sysprompt-fix-20261002`
- Registry digest: `sha256:99bc612fb1c05ed8ae097eeff15d50abb09a8d721d5ba0e35715dadfe78a7028`

## Kube YAML Change

- File: `/Users/celes/sources/kube/omniroute/omniroute.yaml`
- Image tag updated:
  `3.8.54-reasoning-effort-fix2-20261003` -> `3.8.55-sysprompt-fix-20261002`
- Commit (local, NOT pushed): `034c7bd20b98530c51f77fe82f83b233e2a551f0`
  — `chore(omniroute): deploy 3.8.55-sysprompt-fix-20261002`

## Deploy & Rollout Verification

- `kubectl apply -f omniroute/omniroute.yaml` -> `deployment.apps/omniroute configured`.
- Strategy: `Recreate` (replicas: 1).
- `kubectl rollout status deployment/omniroute -n omniroute` -> successfully rolled out.
- Pod: `omniroute-67466d9798-fjcmj`
    - Status: **1/1 Running**, ready=true
    - **Restart count: 0** (stable — rechecked after 20s, still 0)
    - Running image: `registry.celestium.life/library/omniroute:3.8.55-sysprompt-fix-20261002`
    - **Running imageID digest: `sha256:99bc612fb1c05ed8ae097eeff15d50abb09a8d721d5ba0e35715dadfe78a7028`**
      — matches the pushed digest EXACTLY.

## Live Health Probe (https://omniroute.celestium.life)

- `/readyz` -> 200
- `/v1/models` (Bearer mgmt key from `/run/secrets/omniroute_management_api_key`) -> 200

## Status

HEALTHY — deployed image verified by digest, pod running with 0 restarts, service serving.
