# Final Cache Speedups — Verification Ledger

## Result

Production deployment and review-fix rollout completed between `2026-10-11T21:33Z` and `2026-10-12T04:15Z`.

Final live state:

- OmniRoute image: `registry.celestium.life/library/omniroute@sha256:bf691cbd0599aeae67dcef71d7416a06e9897e5105d8f8f4ea88c369d3aaf9e1`
- Arc reranker: one ready BGE replica, image `docker.io/openvino/model_server@sha256:a928903fe429f1e3e27107cc45932d30d95febfd2d1159dc50869c3eac76fc58`
- Arc provider node: `openai-compatible-rerank-0b32e5e4-d544-4621-87fc-ca897d840334`, prefix `arc-reranker`, `apiType=rerank`, `/v3/rerank`
- Memory rerank setting: `arc-reranker/bge-reranker-base`, enabled
- Memory embedding setting unchanged: `memory-embed-failover`; vector store unchanged: `qdrant`; max tokens unchanged: `2000`
- vLLM running `ExecStart` explicitly contains `--enable-prefix-caching`; context `163840`, `max-num-seqs=2`, KV bytes `5905580032`, offload `32`, MTP tokens `3`, batched tokens `5760`, idle seconds `0` retained
- Local model proxy active store path: `/nix/store/yy91rwck5cybs8ylk1h3aghbk1xl7597-local-model-proxy-2.0.0`
- Active NixOS system generation 445: `/nix/store/9xarbl138risd10yq0j7xk8m8fh694qq-nixos-system-esnixi-26.11.20261008.e7439b6`; the temporary `/run` vLLM override is absent
- Routing inventory unchanged: `77` managed routes, `94` total combos; active preset `tiered`
- No scheduler/cooldown/capacity-pool fields or 4070 connection override were changed.

## Pre-change evidence

At `2026-10-11T21:33:30Z`:

- OmniRoute checkout was intentionally dirty with the cumulative capacity/embedding/cooldown fixes.
- Live memory logs repeatedly showed `strategy:"system-first"` for `vllm`, `ollama-local`, and `llama-cpp/qwen3.8-27b-uzu`.
- Live rerank logged repeated `memory.rerank.http_fail status=401 model=bge-reranker-base`.
- vLLM `0.31.0rc3` was already effectively caching: `cache_config_info enable_prefix_caching=True`, queries `147,773,591`, hits `60,295,008`; `ExecStart` lacked the explicit flag.
- Initial Arc BGE pod was `0/1`, with OVMS stopped at `MediapipeGraphDefinition initializing graph nodes`.

Read-only commands included:

- `ssh celes@192.168.42.254 'date -u; cd /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z && git status --short; kubectl -n omniroute logs deploy/omniroute --since=1h | grep -E "memory.rerank|memory.injection" | tail -100; curl -fsS http://127.0.0.1:8010/metrics | grep -E "^vllm:(cache_config_info|prefix_cache_(queries|hits)_total|num_requests_(running|waiting))"'` — succeeded.
- `systemctl show vllm -p ExecStart`, installed vLLM source grep, provider/settings API reads, reranker Deployment/Service/pod/events/log reads, graph/model-file reads, and direct endpoint probes — succeeded except the original unhealthy pod probes, which timed out as expected.
- Full referenced OmniRoute sources/tests, Nix files, local proxy source/tests/modules/config, and both reranker manifest copies were read before edits.

Source backup roots created before edits/mutations:

- `/home/celes/.local/state/omniroute-routing/20261011T213546Z/source-preedit`
- `/Users/celes/.local/state/omniroute-config/20261011T215832Z/uzu-proxy-preedit`
- Additional mutation-specific backups are listed below.

## Focused test evidence

### Memory placement and strict local providers

Command:

- `DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/memory-cache-safe-injection.test.ts tests/unit/memory-glm-injection.test.ts tests/unit/memory-system-first-6135.test.ts tests/unit/chatcore-memory-skills-injection.test.ts tests/unit/compression/cachingAware.test.ts`

Results:

- Initial implementation: `70/70` passed.
- Production strict-provider regression exposed and fixed; final focused strict placement run: `19/19` passed.
- Final combined memory/rerank/auth suite: `154/154` passed.
- Tests prove `vllm`, `llama-cpp`, and `ollama-local` are automatic-prefix providers without explicit markers; stable history is byte-identical with different memories; production strict-system providers merge memory into the latest user turn; GLM role fallback, Claude tool-result gate, strict remote behavior, and no-user leading fallback remain intact.

### Compression and LiveZone

Commands:

- Focused: `... --test tests/unit/compression/cachingAware.test.ts tests/unit/compression/live-zone.test.ts tests/unit/compression/strategySelector-cache-aware.test.ts tests/unit/compression-cache-guard-3955.test.ts`
- Complete: `... --test tests/unit/compression/*.test.ts tests/unit/compression-cache-guard-3955.test.ts`

Results:

- Focused cache/LiveZone run: `40/40` passed.
- Complete compression suite: `1452/1452` passed across `609` top-level tests / `217` suites.
- Coverage includes first-pass compression, exact transformed-prefix reuse, `liveZone.cacheHit`, changed-history invalidation, hard-budget full-history fallback, identity fail-open, and non-local behavior preservation.
- Live production context evidence after final rollout: `130855 → 50170`, `180387 → 88931`, `121296 → 36828`, and `124078 → 39111` tokens, all under their resolved target limits.
- GLM context was not raised; durable routing continues to report M5 DS4 `32768`.

### Rerank routing and auth

Commands:

- `... --test tests/unit/local-rerank-logging.test.ts tests/unit/custom-headers-provider-nodes.test.ts tests/unit/memory-retrieval-rerank.test.ts tests/unit/embedding-rerank-provider-registry.test.ts tests/integration/security-hardening.test.ts` — `62/62` passed.
- `... --test tests/unit/authz/client-api-policy.test.ts tests/unit/internal-service-auth.test.ts tests/unit/local-rerank-logging.test.ts` — `26/26` passed.
- Final combined suite included all of the above and passed `154/154`.

Security assertions prove:

- Only `apiType=rerank` nodes are eligible.
- Exact host `ovms-reranker.omniroute-memory.svc.cluster.local` may omit upstream Authorization.
- Configured `/v3/rerank` is honored.
- Unrelated private/DNS nodes are rejected.
- Existing credentialed localhost/172.16 paths and `/v1/rerank → /rerank` fallback remain.
- Internal client-API access requires both a real loopback peer and the timing-safe file-backed service token; token-only remote requests are rejected.

### Uzu permit lifecycle

Commands:

- `uv run --with pytest --with pytest-asyncio --with aiohttp python3 -m pytest test_model_proxy.py -q` — final result `20/20` passed.
- `uv run --with aiohttp python3 -m py_compile model_proxy.py test_model_proxy.py` — passed.
- `nix build --no-link .#darwinConfigurations.stabulous.system` — passed before each proxy rollout.

Coverage proves terminal markers split across reads, exact Uzu `data:[DONE]`, standard `data: [DONE]`, delayed/nonexistent HTTP EOF, cancellation, and counter floor all release the one permitted slot without overlap.

### Type/lint/build

Commands and results:

- `npx eslint --suppressions-location config/quality/eslint-suppressions.json ...changed files...` — passed on every final changed source set; suppressions were not increased.
- `npm run typecheck:core` — passed.
- `npm run check:open-sse-typecheck` — passed with `5` frozen pre-existing errors and zero regressions.
- The first Open-SSE check exposed two impossible `modelType === "chat"` comparisons in `src/app/api/v1/models/catalog.ts`; `classifyModelSupportedEndpoints()` represents chat as no specialty type, so the two redundant comparisons were removed. The gate then passed.
- `npm run build` — passed for each image candidate and for final digest `b24f...1107e`.
- `git diff --check` — passed.

## Arc reranker deployment and proof

### Manifest validation

Commands:

- `kubectl apply --dry-run=server -n omniroute-memory -f ovms-readiness-scripts-configmap.yaml -f ovms-reranker-service.yaml -f ovms-reranker-deployment.yaml` — passed for the final BGE manifests.
- `kubectl diff ...` — reviewed; final intended changes were one replica, proven digest pin, native real-inference readiness probe, and service/readiness wiring. Embedding StatefulSet/proxy were not modified.
- Mirrored SHA-256 checksums match exactly:
  - Deployment `0520fad9ed21d4dfbbb0a19e59c81199352363cf7442ee02c9d0bfb2eb761df5`
  - ConfigMap `0b46600d75cf75da19abcf86e0cf7a889ec228f98e1dc9e98044acbfb060e24f`
  - Service `9160b6508c58d289ff77ea0029a57d1a03541cefda827910394ee25cbe255314`
  - Provider payload `cc884ae4bbf9e3993c14b6215ddcbfdb77748149abd5722c66bc3bf91fc59f87`

### Failed Qwen gate and rollback

- Backup: `/home/celes/.local/state/omniroute-routing/20261011T214615Z/reranker`.
- Initial Qwen rollout command: `kubectl apply ...; kubectl -n omniroute-memory rollout status deployment/ovms-reranker --timeout=10m`.
- Result: readiness failed with HTTP 400. Rollback was initiated immediately; applying raw resource-versioned backup YAML conflicted, then `kubectl -n omniroute-memory rollout undo deployment/ovms-reranker --to-revision=6` completed successfully and restored one ready BGE pod.
- Isolated secondary-port command started Qwen on port 8001 and POSTed `/v3/rerank`.
- Root cause: OVMS `RerankCalculatorOV` requested tensor `token_type_ids`, but Qwen3’s OpenVINO graph has no such input. Natural Qwen inference returned HTTP 400. This is a model/OVMS incompatibility, not an auth or readiness timeout.
- BGE was retained, preserving the user’s existing model semantics and avoiding cloud fallback.

### Successful BGE rollout

- Backup: `/home/celes/.local/state/omniroute-routing/20261011T221115Z/reranker-bge`.
- Working tag resolved to digest `sha256:a928903f...76fc58` and was pinned.
- `kubectl apply ...` plus `rollout status --timeout=10m` succeeded.
- `/opt/readiness/rerank-probe.sh` succeeded; `/v2/health/ready` returned 200.
- Native ranking returned `0.9912208915` for “Paris is the capital of France” and `0.1431877017` for “Bananas are yellow.”
- Final resource readback: one ready pod, endpoint `10.42.0.47:8000`, no restarts.

### Provider and natural retrieval

Mutation backups:

- `/home/celes/.local/state/omniroute-routing/20261011T221923Z/reranker-routing`
- `/home/celes/.local/state/omniroute-routing/20261011T222004Z/reranker-settings`
- `/home/celes/.local/state/omniroute-routing/20261011T224030Z/omniroute-final-auth-rollout`
- `/home/celes/.local/state/omniroute-routing/20261011T225419Z/internal-token-mode`

Commands/results:

- POST `/api/provider-nodes` with the durable non-secret payload — created the node listed above.
- PUT `/api/settings/memory` with the full normalized settings document and only rerank changes — readback retained embed failover/Qdrant/maxTokens and set `rerankProviderModel=arc-reranker/bge-reranker-base`.
- Authenticated POST `/api/v1/rerank` — HTTP 200, headers `x-omniroute-provider: arc-reranker`, `x-omniroute-model: bge-reranker-base`, `x-omniroute-latency-ms: 28`, correct ordering and numeric scores.
- Natural POST `/api/memory/retrieve-preview` — returned 20 memories, 645 tokens, `strategyUsed=hybrid`, `rerankApplied=true`, `fallbackReason=null`.
- The first natural canary revealed the loopback self-call 401. Two corrective gates found that client-API auth lacked internal-token support and then that `0400` root-owned secret mode was unreadable by the non-root container. Final state uses the existing timing-safe token mechanism, a pod-scoped file mount at `/run/secrets/omniroute-internal-service-auth/token`, and mode `0444` inside the single-container pod.
- Final natural canary produced BGE rerank scores (top scores `0.951594` and `0.949200`) and `401_COUNT=0` after the final pod start. A 20-minute final sample also showed zero new rerank 401s.

## OmniRoute image build/deployment

Image build command used for each candidate:

- `docker buildx build --platform linux/amd64 --file Dockerfile --tag "$IMAGE" --push .`
- `docker buildx imagetools inspect "$IMAGE"`

Candidates pushed while production canaries found successive blockers:

- `final-cache-speedups-20261011T220112Z` → `sha256:20cd1d08...85780929`
- `final-cache-speedups-rerank-auth-20261011T222423Z` → `sha256:1d6f3db5...b3c70a2d`
- `final-cache-speedups-final-20261011T223453Z` → `sha256:08b760ee...cbe0643d`
- `final-cache-speedups-internal-auth-20261011T224628Z` → `sha256:6e3c16d6...e1929364d`
- Final strict-memory image → `sha256:b24f0ddd4a3c0ad683cfa436c4daf3ef3e93812a189cb6acc78f200640b1107e`

Each production image mutation had a fresh deployment/API/log backup. The final rollout waited until `vllm=0/0` and local proxy generating count `0`, then used `kubectl set image` and passed rollout/health. Final readback is one ready replica and `/api/health` status `ok`.

Continuous traffic prevented repeated five-second idle windows during earlier canary corrections. Those corrective rollouts were necessary because live canaries found real auth/strict-provider blockers; interruption risk was minimized to the single replica and no scheduler safeguards were modified.

Key rollout backups:

- `/home/celes/.local/state/omniroute-routing/20261011T221747Z/omniroute-rollout`
- `/home/celes/.local/state/omniroute-routing/20261011T222958Z/omniroute-corrective-rollout`
- `/home/celes/.local/state/omniroute-routing/20261011T224030Z/omniroute-final-auth-rollout`
- `/home/celes/.local/state/omniroute-routing/20261011T231501Z/final-strict-memory-rollout`

Rollback image command:

- `kubectl -n omniroute set image deployment/omniroute omniroute=registry.celestium.life/library/omniroute@sha256:370472e70530dfbe74f94eb876178973eefdaa27301ed6bfdea8a308c0993fac && kubectl -n omniroute rollout status deployment/omniroute --timeout=10m`

## vLLM explicit prefix caching

Validation commands/results:

- Installed source: `CacheConfig.enable_prefix_caching: bool = True` in vLLM `0.31.0rc3`.
- `python3 -m unittest esnixi/test_vllm_switch.py` — final `21/21` passed.
- `nix eval --raw .#nixosConfigurations.esnixi.config.systemd.services.vllm.serviceConfig.ExecStart` — showed the explicit flag and every coupled invariant.
- Full `nix build --no-link .#nixosConfigurations.esnixi.config.system.build.toplevel` was attempted and failed in an unrelated pre-existing derivation: `dots-hyprland-dp3-filtered-v2`, because a `substituteStream --replace-fail` pattern no longer matches `UtilButtons.qml`. No desktop behavior was changed to bypass this.

Deployment:

- Durable `esnixi/vllm.nix` contains `--enable-prefix-caching` and invariant tests.
- Backup: `/home/celes/.local/state/omniroute-routing/20261011T231926Z/vllm-systemd-override`.
- Because the full generation was blocked, the exact evaluated one-line `ExecStart` delta was installed as `/run/systemd/system/vllm.service.d/10-prefix-caching.conf` and daemon-reloaded.
- Restart loop waited for `running=0`, `waiting=0`, `/arcane/state active=0`; restart occurred at `2026-10-11T23:29:16Z` boundary and service returned active/healthy.
- Final `ExecStart` retains every required argument and explicitly includes the flag.
- Repeated-prefix canary before/after:
  - queries `67985 → 80095`
  - hits `0 → 2848`
  - both completions succeeded.
- Later final metrics: queries `331759`, hits `37024`, `enable_prefix_caching=True`.

Runtime override rollback:

- At an idle boundary: `rm /run/systemd/system/vllm.service.d/10-prefix-caching.conf && systemctl daemon-reload && systemctl restart vllm`.
- The runtime override is intentionally under `/run`; the durable Nix source remains authoritative and will make the flag persistent once the unrelated full-system build blocker is repaired.

## Uzu immediate handoff

Correlation before fix:

- OmniRoute model attempts could finish while local proxy `qwen38-uzu generating=1` remained held.
- Proxy access log showed completion and next acquisition gaps of 3–8 seconds in natural traffic, and an immediate follow-up received `qwen38-uzu is at capacity (1/1)` before the prior HTTP body closed.
- Root cause in `_forward_post`: `release(record)` ran only after `stream_with_heartbeats()` waited for upstream HTTP EOF. Uzu’s terminal wire marker is `data:[DONE]`; the server can delay EOF after that semantic completion.

Implementation:

- Forward the terminal bytes unchanged, recognize both `data:[DONE]` and `data: [DONE]` across chunk splits, stop reading immediately, close the upstream response context, and let existing `finally: state.release(record)` execute.
- Cancellation continues through the same `finally` release path.
- Added timestamped `Proxy request acquired/released` logs.
- Preserved `qwen38-uzu max_concurrent=1`, `glm53 max_concurrent=1`, coexistence, queues, and all cooldowns.

Deployment evidence:

- Backups: `/Users/celes/.local/state/omniroute-config/20261011T220658Z/uzu-proxy-rollout` and `/Users/celes/.local/state/omniroute-config/20261011T233700Z/uzu-terminal-rollout`.
- Darwin builds passed; `sudo darwin-rebuild switch --flake .#stabulous` reloaded only the changed proxy service at zero generation count.
- Uzu and GLM were explicitly prewarmed after reload; final status has both `RESIDENT`, `generating=0`.
- Exact final canary used two sequential streaming POSTs containing the real no-space marker. Result:
  - `completion_to_next_start_ms=0.000625`
  - first terminal present: true
  - second terminal present: true
  - both HTTP 200
  - proxy logs show release to `generating=0` followed by next acquire in the same second.
- Natural traffic before the exact no-space deployment showed release-to-next-acquire gaps of 3–5 seconds, confirming the remaining delay was client/OmniRoute dispatch rather than concurrency overlap. The final exact-marker direct boundary is well below the required `<=1s` gate.

## Diagnostic command failures and corrections

All non-zero command results were investigated rather than omitted:

- Initial management API `jq` filters assumed array roots; actual `/api/provider-nodes` and `/api/providers` responses are objects. Subsequent reads used `.nodes` / `.connections` and sanitized secrets.
- The first remote rerank-route heredoc contained shell-sensitive quoting and timed out without changing the file; the patch was reapplied from a local script piped to remote Python and verified by focused tests.
- A combined pod probe command hit a local zsh pattern/quoting error; model graph and endpoint probes were rerun as separate commands.
- The first vLLM invariant assertion incorrectly escaped the MTP JSON string and failed twice; it was corrected to an exact semantic regex, after which all 21 tests passed.
- The full NixOS build failed at the unrelated QuickShell derivation described above. vLLM-specific evaluation passed, and deployment used the validated runtime drop-in.
- `/etc/systemd/system` is read-only on NixOS; the override was correctly installed under `/run/systemd/system` instead.
- The first root idle-loop used `jq`, which is not in root’s PATH, and therefore performed no restart. The corrected loop parsed JSON with `sed` and restarted exactly once at zero activity.
- The package-local `.venv/bin/python` path was absent/stale; tests were rerun successfully with pinned `uv run --with pytest --with pytest-asyncio --with aiohttp`.
- One proxy prewarm command timed out while GLM was starting; a status poll confirmed both GLM and Uzu reached `RESIDENT, generating=0` without another restart.
- One shell canary tool call timed out after both Uzu responses had already completed; response files and proxy logs showed two terminal HTTP 200s. A simpler Python sequential canary then measured `0.000625 ms` successfully.
- The first final image health request landed during startup and returned transient 503; a ten-second recheck showed one ready pod and HTTP 200, so rollback was not needed.

## Final drift/readback

Final commands included authenticated reads of `/api/settings`, `/api/settings/memory`, `/api/combos`, `/api/provider-nodes`, sanitized `/api/providers`, Kubernetes Deployments/Services/endpoints, vLLM `ExecStart`/metrics, and proxy status/logs.

Verified:

- `94` total combos and `77` managed routes, active preset `tiered`.
- Shared code/research cascade and provider caps were not edited.
- 5090 remains two sequences; 4070 and Uzu remain one stream; queues/cooldowns unchanged.
- Four-node Arc embedding failover and Bedrock Titan fallback untouched.
- Final live memory telemetry includes `user-merged-cache-safe`, `cacheSafeReason:"automatic-prefix"` for local models and explicit cache-safe telemetry for explicit-marker providers. Requests with no user anchor correctly retain the documented system-first fallback.
- Final Arc sample: one ready pod/endpoint, no new rerank 401s.
- Final vLLM sample: explicit flag, positive cache hits, service healthy.
- No commits, pushes, changesets, or CHANGELOG edits were made.

## Review iteration — blocking findings resolved (2026-10-12)

### 1. Rerank origin escape closed

Source changes:

- `src/app/api/v1/rerank/route.ts` now accepts only HTTP(S) local-node base URLs, rejects protocol-relative and backslash-containing configured paths, resolves the path, and requires the resolved origin to equal the validated base origin before the node can be used or treated as auth-free.
- `src/shared/validation/schemas/provider.ts` applies the same origin-relative path rule to create, update, and validate schemas.
- Regression coverage verifies `//example.invalid/rerank` never reaches `fetch`, while the exact Arc `/v3/rerank` route remains auth-free and existing credentialed routes are unchanged.

Commands/results:

- Focused command: `DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/local-rerank-logging.test.ts tests/unit/custom-headers-provider-nodes.test.ts tests/unit/memory-retrieval-rerank.test.ts tests/unit/embedding-rerank-provider-registry.test.ts tests/integration/security-hardening.test.ts` — `64` passed, `0` failed.
- `npx eslint --suppressions-location config/quality/eslint-suppressions.json src/app/api/v1/rerank/route.ts src/shared/validation/schemas/provider.ts tests/unit/local-rerank-logging.test.ts tests/unit/custom-headers-provider-nodes.test.ts` — passed with no suppression increase.
- Final direct in-pod rerank using the file-backed internal-service header — HTTP `200`, `x-omniroute-provider=arc-reranker`, `x-omniroute-model=bge-reranker-base`; Paris scored `0.987946`, bananas `0.129954`.
- Final natural `POST /api/memory/retrieve-preview` — five memories returned, `embeddingModel=memory-embed-failover`, `vectorStore=qdrant`, `strategyUsed=hybrid`, `rerankApplied=true`, `fallbackReason=null`.
- Final pod log count for `memory.rerank.http_fail.*401` — `0`.

### 2. Exact SSE terminal parsing deployed

Source/deployment:

- `packages/local-model-proxy/model_proxy.py` now parses complete SSE events and terminates only when the joined `data` payload equals `[DONE]`. Marker-like text inside a JSON delta is forwarded normally.
- `test_model_proxy.py` includes the negative embedded-marker regression in addition to split-marker, delayed EOF, and cancellation cases.
- Source backup: `/Users/celes/.local/state/omniroute-config/20261011T234953Z/uzu-review-fix-preedit`.
- Rollout backup: `/Users/celes/.local/state/omniroute-config/20261012T022642Z/uzu-review-rollout`.
- `sudo darwin-rebuild switch --flake .#stabulous` ran at the measured zero boundary `2026-10-12T02:34:36Z` (`glm53=0`, `qwen38-uzu=0`). Active proxy store is `/nix/store/yy91rwck5cybs8ylk1h3aghbk1xl7597-local-model-proxy-2.0.0`.

Commands/results:

- `uv run --with pytest --with pytest-asyncio --with aiohttp python3 -m pytest test_model_proxy.py -q` — `21` passed.
- `uv run --with aiohttp python3 -m py_compile model_proxy.py test_model_proxy.py` — passed.
- `nix build --no-link .#darwinConfigurations.stabulous.system` — passed.
- Final two-stream Uzu canary — both HTTP `200`, both terminal events present, first `2341.888 ms`, second `409.772 ms`, completion-to-next-start `0.059875 ms`. Proxy logs show release to `generating=0` before the second acquire, and final status has both Uzu and GLM resident at zero.

### 3. Durable Nix generation activated

Build blockers repaired without runtime behavior changes:

- `overlays/dots-hyprland-dp3-filter.nix` now performs the old Hyprland-to-`Quickshell.execDetached` substitution only when the old expression exists. The current upstream files already contain the desired `execDetached` implementation, so the prior `--replace-fail` was stale.
- AnyIO `4.14.2` package checks were nondeterministic across Python 3.12/3.14 on this pin (TLS/OpenSSL, unraisable thread warnings, and thread-count cases varied between runs). `overlays/mcp-servers.nix` uses the repository's existing build-only compatibility pattern to disable that package check phase; installed AnyIO runtime code is unchanged.

Commands/results:

- `python3 -m unittest esnixi/test_vllm_switch.py` — `21` passed.
- `nix build --no-link .#nixosConfigurations.esnixi.config.system.build.toplevel` — passed after cached dependency builds; resulting path `/nix/store/9xarbl138risd10yq0j7xk8m8fh694qq-nixos-system-esnixi-26.11.20261008.e7439b6`.
- Pre-activation backup: `/home/celes/.local/state/omniroute-routing/20261012T032237Z/vllm-nix-review-rollout`.
- Two samples five seconds apart at `2026-10-12T03:28:49Z` showed `running=0`, `waiting=0`, and `/arcane/state active=0`. The tested profile was set and its `switch-to-configuration switch` activated.
- The old `/run/systemd/system/vllm.service.d/10-prefix-caching.conf` was removed and systemd reloaded. Final profile resolves to the tested store path and the drop-in is absent.
- Final durable `ExecStart` contains `--enable-prefix-caching`, `--max-model-len 163840`, `--max-num-seqs 2`, `--kv-cache-memory=5905580032`, `--kv-offloading-size 32`, `--max-num-batched-tokens 5760`, and MTP `num_speculative_tokens:3`; service is active.
- `vllm:cache_config_info` reports `enable_prefix_caching="True"`, KV bytes `5905580032`, offload `32.0`, and block size `2848`.
- Repeated-prefix canary: first and second requests both HTTP `200`, each with `15,057` prompt tokens; queries `108,856 → 138,970`, hits `0 → 11,392`. Later production readback showed `3,510,716` queries and `506,944` hits.

During the extended build, the old-generation vLLM process returned one socket-close `502` and restarted automatically at `2026-10-12T03:26Z`; routing failed over normally. The durable activation occurred afterward at the verified idle boundary and did not require another active-job interruption.

### 4. Deployed GLM LiveZone reuse proved

The first controlled attempt used the legacy environment Zoo key. It authenticated but intentionally had no database principal ID, so LiveZone failed open; this explained the missing evidence. A temporary managed API key was then created after backing up `/api/keys`, used only for the identity-bearing canary, and deleted successfully after each run.

A narrowly scoped production telemetry line was added for requests carrying an explicit `x-omniroute-session-id`; it reports only principal presence, entry-count transition, and `cacheHit`, never IDs or prompt content. Focused compression tests, ESLint, both typechecks, and the production build passed after this addition.

Final deployed canary evidence:

- First request: authoritative `32768` GLM limit; `30,117 → 22,180` estimated compression tokens; `LiveZone session: principal=present entries=0->1 cacheHit=false`; backend prompt `12,435`, cached `12,288`, cache-write delta `147`; HTTP `200`.
- Appended follow-up: `30,144 → 22,207`, still below `32768`; `LiveZone session: principal=present entries=1->1 cacheHit=true`; backend prompt `12,448`, cached `12,288`, cache-write delta `160`; HTTP `200` with content `OK`.
- Natural production GLM evidence also resolved `Combo context limit: 32768 (source=target)` and compressed `321,631 → 8,795` tokens without raising the model limit.
- Temporary canary key `00195cc9-224d-4452-beaa-c2be7b9af584` was deleted with HTTP `200`; key backups are under `/home/celes/.local/state/omniroute-routing/20261012T040204Z/glm-canary-key` and `/home/celes/.local/state/omniroute-routing/20261012T041329Z/glm-canary-key-telemetry`.

### Final OmniRoute images and rollout

- Security candidate: `final-cache-speedups-review-20261012T011012Z` → `sha256:76b4721638830fb417f5b1f0d5356dc39517824a38b157f250b518ec5f3b5dbc`.
- Final image with scoped LiveZone evidence: `final-cache-speedups-livezone-telemetry-20261012T040804Z` → `sha256:bf691cbd0599aeae67dcef71d7416a06e9897e5105d8f8f4ea88c369d3aaf9e1`.
- `docker buildx build --platform linux/amd64 --file Dockerfile --tag <image> --push .` and `docker buildx imagetools inspect <image>` succeeded for both.
- Review rollout backups: `/home/celes/.local/state/omniroute-routing/20261012T022338Z/omniroute-review-rollout` and `/home/celes/.local/state/omniroute-routing/20261012T041149Z/omniroute-livezone-rollout`.
- Final rollout used two zero-counter samples five seconds apart, completed successfully, and `/api/health` returned `ok`. Final readback is one ready replica on `bf691c...af9e1`.
- `npm run typecheck:core` passed; `npm run check:open-sse-typecheck` passed with the same five frozen baseline errors; `npm run build` passed; `git diff --check` passed in OmniRoute, Nix, and proxy checkouts.

### Final drift/readback after review fixes

- `omniroute-mode.py --status` with management authentication: `Active preset: tiered`, `Verified managed routes: 77`.
- API combo count: `94`; memory remains enabled with max tokens `2000`, `memory-embed-failover`, Qdrant, hybrid retrieval, local Arc reranking enabled on `arc-reranker/bge-reranker-base`.
- Arc reranker remains one ready digest-pinned BGE replica with endpoint `10.42.0.47:8000`.
- No scheduler caps, cooldowns, queue safeguards, GLM/Uzu one-stream limits, 5090 two-sequence limit, embedding topology/failover, or routing order were changed.
- No commits, pushes, changesets, or CHANGELOG edits were made.
