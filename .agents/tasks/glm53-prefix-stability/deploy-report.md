# OmniRoute deploy: 3.8.61-prefix-stable-20261003

Context: [glm53-kv-prefix-reuse root-cause report](../glm53-kv-prefix-reuse/report.md)

## Source

- Repo: /Users/celes/sources/celesrenata/OmniRoute, branch `feat/hybrid-reader-combo`
- HEAD: `c4c83b892` fix(prefix-cache): keep upstream prompt prefix byte-stable for llama-cpp/ds4
- Working tree clean; `git archive HEAD` → esnixi `~/build/omniroute-c4c83b892/` (tarball removed after extract)

## Build (esnixi, 192.168.42.254)

```
docker build --target runner-cli --build-arg OMNIROUTE_BUILD_MEMORY_MB=16384 \
  -t registry.celestium.life/library/omniroute:3.8.61-prefix-stable-20261003 .
```

- Next.js build stage `#18 DONE 254.3s` (618/618 static pages, standalone colocate OK)
- Local image ID: `sha256:bc36fead53109313828f00c01ef75f2b40ae412c52760a7b57a927668d7e9c55`
- Push: `3.8.61-prefix-stable-20261003: digest: sha256:a1f0b66f4babda0e3bfa7dfedb9081da05387adf842022cef417de1a2f840210 size: 3885`
- Exit 0. Full log: esnixi `~/build/build-c4c83b892.log`

## Manifest

- File: /Users/celes/sources/kube/omniroute/omniroute.yaml (line 61)
- Old: `registry.celestium.life/library/omniroute:3.8.60-embed-split-r2-20261003`
- New: `registry.celestium.life/library/omniroute:3.8.61-prefix-stable-20261003`
- Kube repo commit: `498605c` chore(omniroute): deploy 3.8.61-prefix-stable-20261003 (not pushed)

## Rollout

- `kubectl apply`: deployment.apps/omniroute configured; persistentvolume/omniroute-data reported "configured" (apply-time diff on the PV object; everything else unchanged)
- `kubectl -n omniroute rollout status deploy/omniroute` → `deployment "omniroute" successfully rolled out` (revision 57)
- Pod `omniroute-557cbd7449-wclk5` on gremlin-1, 1/1 Running, 0 restarts

## Digest verification

- Pod image: `registry.celestium.life/library/omniroute:3.8.61-prefix-stable-20261003`
- Pod imageID: `registry.celestium.life/library/omniroute@sha256:a1f0b66f4babda0e3bfa7dfedb9081da05387adf842022cef417de1a2f840210`
- Matches pushed digest: yes

## Post-deploy observation

- Pod serving traffic immediately (combo routing to `vllm/qwen3.8-27b-nvfp4`, embeddings, memory injection all logging normally).
- Seen in logs: `memory.rerank.http_fail {"status":400,"model":"bge-reranker-base"}`. Not related to this change; not checked whether it predates this deploy.
