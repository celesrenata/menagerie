# OmniRoute 3.8.65 Deploy Report — Ordered Dispatch (PART 1 = ENGINE_CODE)

## Summary

PART 1 PATH was `ENGINE_CODE`, so a new image was built and deployed. The ordered-dispatch
engine change shipped and is now live and healthy.

## Source

- **Repo:** `/Users/celes/sources/celesrenata/OmniRoute`
- **Branch built from:** `release/v3.8.52` (current HEAD) — confirmed by parent as the correct branch.
  It contains the squashed hybrid-reader-combo work (`c02725a41`) PLUS the ordered-dispatch
  engine commit on top. `feat/hybrid-reader-combo` was explicitly NOT used (it lacks the engine change).
- **Engine commit:** `94ca490d891fd67741c821ab9cfdf758e0f26ad5`
  `feat: ordered dispatchSequence for priority combos`
  - Files: `open-sse/services/combo/applyStrategyOrdering.ts`, `open-sse/services/combo/rrState.ts`,
    `src/shared/validation/schemas/combo.ts`, `tests/unit/combo-dispatch-sequence.test.ts`
- **Pre-deploy gate run:** `tests/unit/combo-dispatch-sequence.test.ts` — 3/3 passing
  (interleave 5090→4070Ti→5090→GLM; at-capacity head skip; whole-sequence fall-through to tier-2).

## Image

- **Tag:** `registry.celestium.life/library/omniroute:3.8.65-ordered-dispatch-20261003`
- **Build:** on esnixi (Docker 29.8.0) from `git archive HEAD` → `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384`
- **Local build image id:** `sha256:85075d397dc0c92d527cfdc470408fc2373894640bd5b8064b901158f3f528ba`
- **Pushed registry (manifest) digest:** `sha256:86c2f9b02e24ccecb1ac20a9159df59e66162916dd9064bf973f86b2961d78ae`

## Kube

- **Repo:** `/Users/celes/sources/kube` (not pushed, per instructions)
- **Manifest:** `omniroute/omniroute.yaml`
- **Change:** image `3.8.64-usage-chart-legend-20261003` → `3.8.65-ordered-dispatch-20261003`
- **Commit:** `73912600f00e8b2ee843fd1b53ecc822648dc023` `chore: bump omniroute to 3.8.65-ordered-dispatch-20261003`
  - Commit contains ONLY the image-bump line. A pre-existing, unrelated uncommitted working-tree edit
    (`cert-manager.io/cluster-issuer: ca-issuer` → `celestium-le-production`) was deliberately kept out
    of this commit and out of the applied manifest.
- **Applied:** `git show HEAD:omniroute/omniroute.yaml | kubectl apply -f -` (applied the committed
  version, not the dirty working tree).

## Verification

- `kubectl rollout status deployment/omniroute` → **successfully rolled out**
- Pod `omniroute-58b88f4c6f-fvbwt` → **1/1 Running** on `gremlin-1`
- Pod spec image: `registry.celestium.life/library/omniroute:3.8.65-ordered-dispatch-20261003`
- Running pod imageID digest: `sha256:86c2f9b02e24ccecb1ac20a9159df59e66162916dd9064bf973f86b2961d78ae`
  — **matches the pushed registry digest.**
- `GET https://omniroute.celestium.life/healthz` → `ok`

## Cleanup

- esnixi build dir `/tmp/omniroute-build-94ca490d8` removed.

Not done (per instructions): no `.changeset` created, no `CHANGELOG` edit, no git push.
