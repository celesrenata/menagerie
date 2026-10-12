# Final Cache Speedups — Deployment Report

## Production outcome

All five requested optimizations are implemented and deployed.

1. Local retrieved-memory injection is automatic-prefix-cache-safe for `vllm`, `llama-cpp`, and `ollama-local`. Production’s strict-system-first setting is preserved by merging dynamic memory into the latest user turn; no-user requests retain the leading fallback.
2. Local Arc reranking is repaired, enabled, and naturally used. One digest-pinned BGE OVMS replica is healthy behind an auth-free upstream node that is restricted to the exact in-cluster hostname. Internal self-calls use a timing-safe, file-backed service token; external rerank calls remain authenticated.
3. vLLM prefix caching is explicit in durable Nix source and the running `ExecStart`. Existing MTP, context, two-sequence, KV/offload, scheduler, sleep, and lease settings are unchanged.
4. Local compression automatically uses the existing LiveZone cache-aligned path when prompt compression runs. Stable prefix reuse, invalidation, fail-open, and hard-budget full-history behavior are covered by the complete compression suite. Reactive large-context safety remains active.
5. Uzu releases its one-stream proxy permit only when a complete SSE event’s data payload equals `[DONE]`, not on marker-like text inside JSON and not on delayed HTTP EOF. Cancellation also releases. Final direct handoff measured `0.059875 ms` with `max_concurrent=1` unchanged.

## Live versions

- OmniRoute: `registry.celestium.life/library/omniroute@sha256:bf691cbd0599aeae67dcef71d7416a06e9897e5105d8f8f4ea88c369d3aaf9e1`
- Arc reranker: `docker.io/openvino/model_server@sha256:a928903fe429f1e3e27107cc45932d30d95febfd2d1159dc50869c3eac76fc58`
- Local proxy: `/nix/store/yy91rwck5cybs8ylk1h3aghbk1xl7597-local-model-proxy-2.0.0`
- NixOS generation: `/nix/store/9xarbl138risd10yq0j7xk8m8fh694qq-nixos-system-esnixi-26.11.20261008.e7439b6`
- Rerank node: `arc-reranker`, `/v3/rerank`, model setting `arc-reranker/bge-reranker-base`

## Canary summary

- OmniRoute `/api/health`: `ok`; one ready replica on final digest.
- Direct Arc rerank: HTTP 200, correct ordering, scores `0.9912` versus `0.1432`, provider/model metadata headers present.
- Natural retrieval: 20 memories returned, 645 tokens, `hybrid`, Qdrant, `rerankApplied:true`, zero new rerank 401s.
- Memory telemetry: live `user-merged-cache-safe` with `cacheSafeReason:"automatic-prefix"`; system-first remains only where there is no user anchor or legacy strict behavior requires it.
- Compression: full suite `1452/1452`; deployed GLM resolves the true `32768` limit and compresses `30,117→22,180`, while the appended turn reports `LiveZone cacheHit=true`, remains `30,144→22,207`, and reuses `12,288` backend-cached tokens.
- vLLM: durable `enable_prefix_caching=True`; repeated prefix increased hits `0→11,392`, and later production readback reported `506,944` hits. The temporary `/run` override is removed.
- Uzu: exact SSE-event parser, two HTTP 200 responses, `0.059875 ms` dispatch gap, permit returned to zero before next acquire; embedded marker text is covered by a negative regression test.
- Routing drift: 77 managed / 94 total; active preset `tiered`.

## Important investigation result

The planned Qwen3 OVMS reranker was not deployable with the current OVMS rerank calculator. A backed-up canary rollout failed readiness and was rolled back. Isolated inference proved the root cause: OVMS requests `token_type_ids`, while the Qwen3 OpenVINO graph has no such tensor, producing HTTP 400. The verified local BGE model was retained instead; this preserves the pre-existing model choice and avoids any cloud reranker.

## Validation

- Final memory/rerank/auth suite: 154 passed, 0 failed.
- Complete compression suite: 1452 passed, 0 failed.
- Local proxy suite: 21 passed, 0 failed.
- vLLM switch/invariant suite: 21 passed, 0 failed.
- ESLint: passed, no suppression increase.
- Core typecheck: passed.
- Open-SSE typecheck gate: passed with only five frozen baseline errors.
- Production build: passed.
- Darwin build: passed.
- Reranker server dry-run and final rollout: passed.

The full esnixi NixOS toplevel now builds and is active. The stale QuickShell replacement was made conditional because upstream already contains the intended `execDetached` behavior; nondeterministic AnyIO package checks were disabled without changing installed runtime code. The active system profile is `/nix/store/9xarbl138risd10yq0j7xk8m8fh694qq-nixos-system-esnixi-26.11.20261008.e7439b6`, and the temporary `/run` vLLM override has been removed.

## Risk and interruptions

Production traffic was continuous during the first review security rollout, so the single-replica interruption risk could not be eliminated; no pacing or capacity controls were changed to manufacture a gap. The final OmniRoute telemetry rollout, Darwin proxy rollout, and durable Nix activation all used measured zero-request boundaries. During the long Nix build, the old-generation vLLM process independently returned one socket-close 502 and auto-restarted; routing failed over, and durable activation occurred afterward without interrupting another active job.

## Rollback

- OmniRoute: set the image back to the immediately prior reviewed security digest `registry.celestium.life/library/omniroute@sha256:76b4721638830fb417f5b1f0d5356dc39517824a38b157f250b518ec5f3b5dbc`, then wait for rollout. The original pre-task baseline remains `sha256:370472e...` in the earlier backups.
- Reranker: apply the subsystem backup from `/home/celes/.local/state/omniroute-routing/20261011T221115Z/reranker-bge` or use the prior Deployment revision.
- Memory settings/node: restore from `/home/celes/.local/state/omniroute-routing/20261011T222004Z/reranker-settings` and `/home/celes/.local/state/omniroute-routing/20261011T221923Z/reranker-routing`.
- vLLM/NixOS: at an idle boundary run `nixos-rebuild switch --rollback` to return from generation 445 to captured generation 444, then verify `vllm.service`; the pre-activation list is `/home/celes/.local/state/omniroute-routing/20261012T032237Z/vllm-nix-review-rollout/generations.txt`.
- Uzu proxy: switch back to the Darwin generation captured under `/Users/celes/.local/state/omniroute-config/20261012T022642Z/uzu-review-rollout`, then prewarm Uzu/GLM.

## Review-fix closure

All four blocking review findings are closed:

1. Protocol-relative/backslash rerank paths are rejected at schema and runtime, and the resolved endpoint must retain the validated base origin. The SSRF regression proves no fetch occurs.
2. A deployed identity-bearing GLM canary reports `LiveZone cacheHit=true` on its appended turn, compresses both turns below `32768`, and shows `12,288` backend-cached tokens.
3. Uzu termination now parses exact SSE events; marker-like JSON content no longer releases the permit.
4. The vLLM flag is active from the tested NixOS generation and survives reboot; the ephemeral override is absent.

Final drift remains 77 managed / 94 total routes with Arc local reranking healthy and zero new rerank 401s. No scheduler, cooldown, queue, model-context, concurrency, or embedding-failover behavior changed.

See `verification.md` for commands, timestamps, backup directories, failures, and detailed evidence.
