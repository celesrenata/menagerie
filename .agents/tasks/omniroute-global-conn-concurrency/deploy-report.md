# OmniRoute Global Per-Connection Concurrency — Deploy Report

**Date:** 2026-10-04
**Status:** ✅ Success — deployed and verified on esnixi / cluster

## Summary

Built and deployed the process-global per-connection concurrency ceiling fix
(the "double-tap the 5090" cross research/coder fix) to the cluster. The running
pod is serving the newly built image and its digest matches the image that was
pushed to the registry.

## Artifacts

| Item | Value |
|------|-------|
| OmniRoute branch | `release/v3.8.52` |
| OmniRoute commit SHA | `598eedc5eb5b41021ccf4713a1260596d78da203` |
| Commit subject | `fix(combo): process-global per-connection concurrency ceiling for priority path` |
| Image repository | `registry.celestium.life/library/omniroute` |
| Pushed image tag | `3.8.66-global-conn-concurrency-20261004` |
| Pushed image digest | `sha256:de4b2c582bcdc815d7c2f06bedbb539e3bb834c8c93dcff8b990d3a23a16a3cc` |
| Local build image ID | `sha256:a3c74c87631357f6d48266fd5a46d47e29820bb4775f36d457f571e7c5513f51` |
| Kube repo commit SHA | `68dbeb7ccb646ae0dbcc579ec70ecce5724012f9` |
| Previous image tag (replaced) | `3.8.65-ordered-dispatch-20261003` |

## Running pod verification

| Field | Value |
|-------|-------|
| Pod | `omniroute-cd59b9765-hmnkk` (namespace `omniroute`, node `gremlin-1`) |
| Status | `1/1 Running` |
| Pod spec image | `registry.celestium.life/library/omniroute:3.8.66-global-conn-concurrency-20261004` |
| Pod imageID (digest) | `registry.celestium.life/library/omniroute@sha256:de4b2c582bcdc815d7c2f06bedbb539e3bb834c8c93dcff8b990d3a23a16a3cc` |
| Digest match | ✅ Running pod digest == pushed digest (`sha256:de4b2c58...a16a3cc`) |

## Steps performed

1. **Archive + copy.** `git archive HEAD` from
   `/Users/celes/sources/celesrenata/OmniRoute` (commit
   `598eedc5eb5b41021ccf4713a1260596d78da203`) → `scp` to esnixi
   (`celes@192.168.42.254`) → extracted to `~/build/omniroute-598eedc`.
2. **Build.** On esnixi:
   `docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 -t registry.celestium.life/library/omniroute:3.8.66-global-conn-concurrency-20261004 .`
   → built image `sha256:a3c74c87...`.
3. **Push.** `docker push registry.celestium.life/library/omniroute:3.8.66-global-conn-concurrency-20261004`
   → registry digest `sha256:de4b2c582bcdc815d7c2f06bedbb539e3bb834c8c93dcff8b990d3a23a16a3cc`.
4. **Manifest bump.** Updated
   `/Users/celes/sources/kube/omniroute/omniroute.yaml` image reference from
   `3.8.65-ordered-dispatch-20261003` to
   `3.8.66-global-conn-concurrency-20261004` and committed in
   `/Users/celes/sources/kube` as `68dbeb7` (image line only).
5. **Apply + rollout.** `kubectl apply` of the committed manifest; rollout
   completed successfully (`deployment "omniroute" successfully rolled out`).
6. **Verify.** Confirmed the running pod's `imageID` digest equals the pushed
   digest.

## Notes / deviations

- **Tag normalization.** The deploy instruction specified a malformed tag with a
  doubled registry prefix
  (`registry.celestium.life/library/omniroute:registry.celestium.life/library/omniroute:3.8.66-global-conn-concurrency-20261004`),
  which is not a valid Docker reference (a tag cannot contain `/` or `:`). The
  clear intent, matching the existing manifest pattern, was image
  `registry.celestium.life/library/omniroute` with tag
  `3.8.66-global-conn-concurrency-20261004`; that normalized reference was used
  throughout.
- **Isolated commit.** The kube working tree already contained an unrelated
  pre-existing uncommitted edit in the same file
  (`cert-manager.io/cluster-issuer: ca-issuer` → `celestium-le-production` on an
  Ingress). The deploy commit (`68dbeb7`) contains **only** the image-line
  change. The `kubectl apply` was performed from the committed file content, so
  the unrelated cert-manager edit was neither committed nor applied to the
  cluster; it remains as a pending working-tree change for the user to handle.
- **Git branch not pushed.** As instructed, `release/v3.8.52` was not pushed and
  no PR was created. The kube commit was likewise not pushed.
- A single transient `kubectl` API read-timeout occurred during verification; the
  retried query returned successfully and confirmed the digest match.
