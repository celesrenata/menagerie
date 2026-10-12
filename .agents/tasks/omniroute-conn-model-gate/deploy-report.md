# Deploy Report — OmniRoute per-(connection, model) concurrency gate

**Date:** 2026-10-04
**Change:** connection+model concurrency gate (3.8.66 → 3.8.67)
**Review verdict:** APPROVED (`review.json`, no findings)

## Artifacts

| Item | Value |
|---|---|
| OmniRoute repo | `/Users/celes/sources/celesrenata/OmniRoute` |
| OmniRoute branch | `release/v3.8.52` |
| **OmniRoute commit SHA** | `7952001084ed3906adbe6a9f6b7e811279119fd6` |
| **Image tag** | `registry.celestium.life/library/omniroute:3.8.67-conn-model-gate-20261004` |
| **Pushed image digest** | `sha256:f2551b6a3988177bf96e037976b41cb3b4ccf624c94f8a9a0d11416e831eac72` |
| Kube repo | `/Users/celes/sources/kube` (branch `master`) |
| **Kube commit SHA** | `41a1ce070de53e7492e3b74965d2fa54b1815107` |
| **Running pod** | `omniroute-7495ddfc56-pr6pc` |
| **Running pod digest** | `sha256:f2551b6a3988177bf96e037976b41cb3b4ccf624c94f8a9a0d11416e831eac72` |
| **Digest match** | ✅ pushed digest == running pod digest |

## Steps performed

1. **Archive + transfer.** From `release/v3.8.52` (HEAD `7952001`, clean working tree), `git archive HEAD` piped over SSH to esnixi (`celes@192.168.42.254`) into `~/build/omniroute-conn-model-gate`.
2. **Build + push.** On esnixi: `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 -t registry.celestium.life/library/omniroute:3.8.67-conn-model-gate-20261004 .` (exit 0, build log `~/build/build-conn-model-gate.log`). Pushed successfully; registry digest `sha256:f2551b6a3988177bf96e037976b41cb3b4ccf624c94f8a9a0d11416e831eac72`.
3. **Kube image bump.** Bumped `omniroute/omniroute.yaml` line 61 from `3.8.66-global-conn-concurrency-20261004` to `3.8.67-conn-model-gate-20261004`. Staged ONLY the image hunk via `git apply --cached` and committed as `41a1ce0`. The UNRELATED cert-manager annotation edit (line 171: `ca-issuer` → `celestium-le-production`) was deliberately left **uncommitted** in the working tree. No push.
4. **Apply + verify.** `kubectl apply -f omniroute/omniroute.yaml` (context `default`); rollout completed successfully. Running pod `omniroute-7495ddfc56-pr6pc` reports imageID digest matching the pushed digest.

## Notes

- The initial commit attempt used `git commit -- <pathspec>`, which incorrectly captured both hunks (image + cert-manager). This was caught before any push, soft-reset, re-staged image-only, and recommitted as `41a1ce0`. Final commit contains a single-line image change only.
- `kubectl apply` applies the on-disk manifest, which still carries the uncommitted cert-manager annotation edit; that annotation change was therefore also applied to the live `omniroute-https` Ingress (`ingress ... configured`). The cert-manager edit remains uncommitted in git per instruction.
