# Final Cache Speedups — Deployment and Verification Report

## Outcome

**Healthy.** Final live verification completed at `2026-10-12T04:21Z`; every required gate passed and no rollback was executed. Detailed implementation evidence is in [verification.md](verification.md), and the approved review is in [review.md](review.md).

## Final live health

- **OmniRoute:** Deployment generation `129` is fully observed and rolled out (`1/1` ready). Pod `omniroute-669986b964-vp65b` started at `2026-10-12T04:12:50Z`, has `0` restarts, and reports `{"status":"ok"}`. The live image is `registry.celestium.life/library/omniroute@sha256:bf691cbd0599aeae67dcef71d7416a06e9897e5105d8f8f4ea88c369d3aaf9e1`.
- **Local inference:** NixOS generation `/nix/store/9xarbl138risd10yq0j7xk8m8fh694qq-nixos-system-esnixi-26.11.20261008.e7439b6` is active. The 5090 vLLM service is active and `/v1/models` returns `qwen3.8-27b-nvfp4` with context `163840`. The local proxy reports both `glm53` and `qwen38-uzu` as `RESIDENT`, `generating=0`; both direct model endpoints respond, and both durable proxy entries retain `max_concurrent=1` and `coexist=true`.
- **Routing drift:** Authenticated `omniroute-mode.py --status` reports preset `tiered` and `77` verified managed routes. Its default no-op preview for `tiered` reports `Changes: 0 routes and 0 provider settings; routes: 77`; the API contains `94` total combos. Code/research retain the generated `5090/M5-MLX/4070/M5-DS4` local order, provider caps remain 5090 `2`, 4070 `1`, and M5 aggregate `2`, while the proxy enforces GLM/Uzu `1` each.
- **Arc reranker:** One digest-pinned BGE pod is ready with `0` restarts at `docker.io/openvino/model_server@sha256:a928903fe429f1e3e27107cc45932d30d95febfd2d1159dc50869c3eac76fc58`; Service endpoint is `10.42.0.47:8000`. Memory settings read back `memory-embed-failover`, Qdrant, `maxTokens=2000`, reranking enabled, and `arc-reranker/bge-reranker-base`. A fresh natural hybrid retrieval returned `5` memories / `305` tokens with `rerankApplied=true` and no fallback. Its corresponding Arc call log at `04:21:04.831Z` was HTTP `200` in `52 ms`; rerank 401 count since the current OmniRoute pod started is `0`.
- **Prefix caching:** Running `ExecStart` explicitly includes `--enable-prefix-caching`, `--max-model-len 163840`, `--max-num-seqs 2`, `--kv-cache-memory=5905580032`, `--kv-offloading-size 32`, `--max-num-batched-tokens 5760`, and MTP `num_speculative_tokens:3`. `vllm:cache_config_info` reports `enable_prefix_caching="True"`; live counters are `3,734,200` queries and `541,120` hits. The temporary runtime override is absent, confirming the durable generation supplies the flag.
- **Compression/prefix reuse:** Current-pod logs resolve GLM’s target to `32768`, compress `30,117 → 22,180`, then compress the appended follow-up `30,144 → 22,207` with `entries=1→1 cacheHit=true`. The controlled canary also retained `12,288` backend-cached tokens with only a `160`-token write delta. Concurrent production large-context requests compressed `604,183 → 90,805`, `607,415 → 93,062`, and `610,273 → 95,198`, all below the selected `163840` target.

## Durable changes by goal

- **Cache-safe memory placement:** OmniRoute `open-sse/utils/cacheControlPolicy.ts`, `open-sse/services/compression/cachingAware.ts`, `open-sse/handlers/chatCore/memorySkillsInjection.ts`, and `src/lib/memory/injection.ts`. Placement moved from dynamic `system-first` behavior to automatic-prefix-aware `user-merged-cache-safe` at the latest user boundary for strict local providers; tests prove the preceding stable prefix stays byte-identical while memory remains visible.
- **Cache-aligned compression:** `open-sse/services/compression/{cachingAware,liveZone}.ts` and `open-sse/handlers/chatCore.ts`, including scoped LiveZone reuse telemetry.
- **Secure local reranking:** OmniRoute `src/app/api/v1/rerank/route.ts` and `src/shared/validation/schemas/provider.ts`; mirrored `sources/kube/omniroute-memory/ovms-reranker-{deployment,service}.yaml`, `ovms-readiness-scripts-configmap.yaml`, and `omniroute-arc-reranker-provider.json`.
- **Durable vLLM cache flag:** Nix `esnixi/vllm.nix` and `esnixi/test_vllm_switch.py`; stale build blockers were repaired in `overlays/dots-hyprland-dp3-filter.nix` and `overlays/mcp-servers.nix` without changing their runtime behavior.
- **Immediate Uzu handoff:** `packages/local-model-proxy/model_proxy.py` and `test_model_proxy.py`, using exact complete-SSE-event `[DONE]` recognition before permit release.

## Focused validation and measurements

- Memory/rerank/auth: `154/154` passed; final origin-escape regression subset: `64/64` passed.
- Compression: `1452/1452` passed; focused cache/LiveZone subset: `40/40` passed.
- Local proxy: `21/21` passed; Python compile and Darwin build passed.
- vLLM invariants: `21/21` passed; complete NixOS toplevel build and activation passed.
- ESLint passed without suppression growth; core typecheck passed; Open-SSE typecheck passed with only the five frozen baseline findings; production build and Kubernetes server dry-run passed.
- Repeated-prefix vLLM canary increased hits `0 → 11,392`; final live hit count is `541,120`. Uzu’s two-stream canary returned two HTTP 200 responses and measured `0.059875 ms` completion-to-next-start with no slot overlap.

## Rejected or deferred optimizations

- Qwen3 reranking was rejected after a real-inference HTTP 400 gate: the current OVMS rerank calculator requests `token_type_ids`, which the Qwen3 OpenVINO graph does not expose. The rollout was immediately restored to the proven local BGE model; reranking was neither disabled nor sent to cloud.
- Route-level session stickiness/prompt-cache affinity, wider GLM/Uzu concurrency, scheduler/cooldown changes, and a four-replica reranker topology were not enabled. They would alter established failover, capacity, or Arc contention behavior; stable-prefix reuse and backend prefix caching already provide the verified cache benefit without those risks.

Rollback assets and exact subsystem commands remain documented in [verification.md](verification.md) and [backups.md](backups.md). No rollback was needed during this final verification.
