# Cache-aligned local inference with repaired Arc reranking

The change aligns retrieved-memory placement and compression with local automatic prefix caches, repairs reranking through a dedicated auth-free Arc node, makes prefix caching explicit in the durable 5090 service, and removes delayed Uzu permit release. The final image and active generations are backed by live memory, rerank, compression, vLLM, and proxy canaries without routing or capacity-control drift. The four blockers from the prior pass now trace to corrected source and production readbacks. No blocking correctness, security, durability, or deployment finding remains.

Watch for: **confirmed** Qwen3 remains incompatible with the current OVMS rerank calculator because its graph lacks the requested `token_type_ids`; the deployed local BGE fallback intentionally keeps reranking enabled rather than moving to cloud or disabling it.

**Verdict**: APPROVED

## High-level view

`vllm`, `llama-cpp`, and `ollama-local` share one automatic-prefix-cache classification. Retrieved memory is anchored at the latest user turn, or merged into that turn for strict-system providers, preserving the preceding prefix without losing memory visibility.

Arc reranking uses a typed `apiType:"rerank"` node for the exact in-cluster OVMS service and `/v3/rerank`. Origin-changing paths are rejected, auth-free behavior is restricted to the approved Arc hostname, and natural hybrid retrieval returns BGE scores with no rerank 401s.

The active 5090 generation declares `--enable-prefix-caching` durably and produces repeated-prefix hits. Its context, two-sequence scheduler, fixed KV/offload sizing, MTP, batched-token ceiling, sleep behavior, and lease wrapper remain coupled to the same service.

Local compression automatically enters LiveZone when identity is available, while identity-less and hard-budget behavior is preserved. A deployed GLM pair resolves the authoritative 32768 limit, compresses both turns below it, and reports transformed-prefix reuse on the appended turn.

Uzu now releases its existing one-stream permit only for a complete SSE event whose joined data payload is exactly `[DONE]`. Embedded marker text does not terminate the stream, and GLM/Uzu concurrency remains one each.

<details>
<summary>Issues (0)</summary>

No actionable concerns remain.

</details>

<details>
<summary>Details</summary>

## Retrieved memory stays visible without invalidating local prefixes

`providerUsesLocalAutomaticPrefixCaching()` is the shared authority for caching detection, compression selection, and memory placement. `resolveMemoryCacheSafeReason()` distinguishes explicit markers from automatic local caching, so local requests get cache-safe placement without `cache_control`.

Ordinary providers receive the memory message immediately before the latest user turn. Strict-system local providers use `user-merged-cache-safe` to fold memory into current user content rather than introducing a non-leading system message. The preceding system/history bytes stay identical and memory remains adjacent to the current query. Recorded coverage retains Claude server-tool-result handling, GLM/user-role fallbacks, non-local strict behavior, and the no-user leading fallback; live telemetry confirms `cacheSafeReason:"automatic-prefix"` and the merged production strategy.

## Arc BGE reranking is repaired behind a narrow trust boundary

Qwen3 failed the required real-inference gate with HTTP 400 because OVMS requested a tensor absent from its graph. The rollback and final digest-pinned `bge-reranker-base` deployment retain one replica, real-inference readiness, a dedicated Service, and a durable provider payload without changing the four-node embedding topology.

Only typed rerank nodes are eligible, and credentials may be omitted only for `ovms-reranker.omniroute-memory.svc.cluster.local`. Paths must begin with one slash, cannot be protocol-relative or contain backslashes, and must retain the validated base origin. The former `//example.invalid/rerank` escape is rejected in schema and runtime, with regression evidence that no fetch occurs. Loopback self-calls also require server-derived loopback locality and the timing-safe file-backed internal token; unrelated private/DNS nodes, external clients, and credentialed/cloud routes retain authentication and quota handling.

Settings keep reranking enabled on `arc-reranker/bge-reranker-base`; embeddings remain `memory-embed-failover`, storage remains Qdrant, hybrid retrieval remains active, and the memory budget remains 2000. Direct rerank returned HTTP 200, Arc provider/model headers, numeric BGE scores, and correct ordering. Natural retrieval returned memories with `rerankApplied=true`, `fallbackReason=null`, and zero rerank 401s.

## Prefix caching is explicit in the active 5090 generation

The durable Nix service adds `--enable-prefix-caching`. Build blockers were repaired without changing runtime application behavior, the complete NixOS toplevel built, and generation 445 activated at a measured idle boundary. The temporary `/run` override is absent, making the explicit flag reboot- and generation-persistent.

Source and `ExecStart` retain `max-model-len 163840`, `max-num-seqs 2`, `kv-cache-memory=5905580032`, offload 32, `max-num-batched-tokens 5760`, MTP `num_speculative_tokens:3`, sleep middleware, idle-seconds-zero behavior, and the lease wrapper. No unsupported speculative flag was added. `cache_config_info` reports prefix caching true; the repeated-prefix canary increased hits from 0 to 11,392, with later production readback at 506,944 hits.

## GLM LiveZone reuse respects the real context ceiling

`shouldUseLiveZoneCompression()` activates the existing LiveZone path for all three local automatic-prefix providers without changing non-local configuration. Principal/session/variant keying, raw-prefix invalidation, deterministic transformed-prefix reuse, identity fail-open, and complete-history fallback under hard token/ratio budgets remain intact.

The identity-bearing GLM canary resolved the target limit as 32768 and compressed 30,117 tokens to 22,180 with a new LiveZone entry. Its appended turn compressed 30,144 to 22,207, reported `entries=1->1 cacheHit=true`, and reused 12,288 backend-cached tokens with a 160-token write delta. Both turns stayed below the unchanged GLM ceiling; separate natural traffic compressed 321,631 to 8,795 against the same target-derived limit. The temporary canary key was deleted after use.

## Uzu completion releases capacity without broad marker matching

The parser buffers complete SSE events across chunk boundaries and terminates only when the joined `data` payload equals `[DONE]`; marker-like JSON content is forwarded. Recorded coverage includes split markers, both spacing forms, delayed or absent HTTP EOF, cancellation, and the negative embedded-marker regression.

The Darwin proxy switched at zero GLM/Uzu generation count and both backends were prewarmed. Two sequential Uzu streams returned HTTP 200 and complete terminal events, with release to zero before the next acquire and a 0.059875 ms completion-to-next-start gap. `qwen38-uzu max_concurrent=1`, `glm53 max_concurrent=1`, coexistence, cooldowns, and shared capacity were not widened.

## Routing, embedding failover, pacing, and rollback state remain intact

Final authenticated readbacks show the `tiered` preset, 77 managed routes, and 94 total combinations. Capacity remains 5090 x2, 4070 x1, and Uzu x1; GLM and Uzu remain one-stream. The four-node Arc embedding proxy, Arc POST retry, Bedrock Titan fallback, `memory-embed-failover`, zero-queue behavior, cooldowns, pacing safeguards, and capacity-pool fields are unchanged.

Timestamped backups precede source edits and the failed Qwen/successful BGE rollouts, provider and settings mutations, OmniRoute image rollouts, internal-token changes, vLLM activation, Uzu deployments, GLM canary keys, and final telemetry rollout. Spot-checked final directories contain the expected deployment/API/log/image or Nix generation/service/source readbacks. Rollback digests, resource backups, prior generation details, and subsystem commands are recorded.

No coder suite, build, image build, or deployment was rerun in this pass. Review used the plan, full verification ledger, deployment report, prior review, targeted final source and manifest inspection, active vLLM readback, and narrow backup checks. Recorded gates include focused and complete tests, lint without suppression growth, type checks, production builds, immutable amd64 digest, server dry-runs, live retrieval/compression canaries, vLLM metrics, and proxy handoff proof.

</details>

<details>
<summary>File map</summary>

- `open-sse/utils/cacheControlPolicy.ts` — defines local automatic-prefix-cache providers.
- `open-sse/services/compression/{cachingAware,liveZone}.ts` and `open-sse/handlers/chatCore.ts` — select and run identity-aware LiveZone compression.
- `open-sse/handlers/chatCore/memorySkillsInjection.ts` and `src/lib/memory/injection.ts` — place memory at the current-turn cache boundary.
- `src/app/api/v1/rerank/route.ts` and `src/shared/validation/schemas/provider.ts` — constrain and route the auth-free Arc node.
- `sources/kube/omniroute-memory/ovms-reranker-*` and `omniroute-arc-reranker-provider.json` — deploy BGE and its provider payload.
- `esnixi/vllm.nix`, `esnixi/test_vllm_switch.py`, and two build-blocker overlays — make the cache flag durable and activatable.
- `packages/local-model-proxy/model_proxy.py` and `test_model_proxy.py` — release Uzu at exact SSE completion.
- `.agents/tasks/final-cache-speedups/{plan,verification,deployment-report,backups}.md` — record validation, deployment, drift, and rollback evidence.

Full changes remain in the targeted checkout diffs; this review isolates the task’s behavioral surfaces from earlier cumulative capacity, embedding, and cooldown work.

</details>
