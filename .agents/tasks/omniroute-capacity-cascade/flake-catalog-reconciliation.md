# OmniRoute Flake/Catalog Reconciliation

Investigation performed read-only on 2026-10-11 PDT. No API mutation, deployment change, service restart, database write, catalog sync, or git mutation was performed. Secret values and request/prompt content are omitted.

## Summary answer

1. **`scripts/configure-omniroute.sh` is not invoked by nix-darwin activation, launchd, or a package hook, but it is not wholly unreferenced.** The current flake imports `modules/darwin/omniroute.nix`, and that module directly launches and bootstraps the Mac OmniRoute. The old script is manual-only: `scripts/setup-omniroute.sh:18` tells an operator to run it, and docs still point to it. In the current worktree it is untracked, while `modules/darwin/omniroute.nix` is newly added. Calling it “orphaned from automatic wiring” is accurate; calling it impossible to use or the current catalog owner is not.

2. **The Mac OmniRoute is a separate loopback instance and does not seed or forward its catalog to the cluster OmniRoute.** It listens only on `127.0.0.1:20128`, uses `/Users/celes/.omniroute/storage.sqlite`, and rewrites its own `customModels` and `syncedAvailableModels` rows at launch. Its provider targets include the local M5 proxy and remote physical inference hosts, not the cluster OmniRoute management API. The cluster has its own `/app/data/storage.sqlite` on a retained Longhorn PV. Matching provider UUIDs reflect copied/shared configuration identity, not a propagation channel.

3. **The live cluster image baseline is verified, but the durable manifest is badly stale.** The Deployment runs `registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`; `/home/celes/sources/kube/omniroute/omniroute.yaml:61` still names `3.8.50-native-ovms-spacing-20260929`. The live Deployment has later timeout, security, embedding, and hard-concurrency settings that the file does not fully contain. `kustomization.yaml:4` still identifies that YAML as the only resource, but `/home/celes/sources/kube` is not a git repository, the last-applied annotation names a different intermediate image (`3.8.68-hard-conn-cap-20261004`), and later `kubectl-set`/`kubectl-patch` managers changed the live object. There is currently no reconciled declarative owner matching live state.

4. **`OMNIROUTE_STRICT_SYSTEM_PROVIDERS` is absent both live and in the durable cluster YAML, and the separate system-message failure is active now.** The current pod had 160 matching log lines, representing 80 paired failed attempts, between 00:24:07 and 03:20:41 PDT; there were zero `reasoning_effort` matches. Safe context association ties the failures to `ollama-local/qwen3.8:27b-iq3-code144k`; nearby fallback events can also mention vLLM/Uzu, but the exact upstream message is coming from the Ollama-local path. This is not the already-fixed reasoning-effort Jinja bug.

5. **The cluster can reach M5 and M5 currently advertises Uzu and GLM.** Both Mac loopback and cluster-to-WireGuard `http://192.168.133.2:7777/v1/models` returned the same 14 safe model IDs. `qwen3.8-27b-uzu` and aliases are present; `ds4-glm53` remains present.

6. **The cluster llama-cpp catalog is stale.** Provider `70b82fc9-6f96-41ac-aa16-8da6099dd7ac` is passthrough-enabled and points at `http://192.168.133.2:7777/v1`, but `GET /api/providers/{id}/models` returned `source: "cache"`, 17 entries, no Uzu, and no usable sync timestamp. Six currently advertised M5 IDs are absent from the cache, including all three Uzu aliases and all three reader aliases. Nine cached IDs are no longer advertised by M5.

7. **The approved capacity-cascade baseline has drifted. Uzu is not catalog-only in current durable/live policy.** Live still has 94 combos and all 44 tier-2-through-tier-5 pools have `targetTimeoutMs: 60000`, but code/research tier 1 is now `[5090, 4070, Uzu, 5090]`, followed by the GLM tier-1b overflow and then cloud. Live provider caps are now vLLM `2`, Ollama `1`, llama-cpp `2`, not the approved `2/1/1`. Commit `0395e689` in `nix-flakes-refactored` explicitly added Uzu to code/research and raised llama-cpp to 2; the policy was applied at 03:05 PDT. The prior backup has `[5090, 4070, 5090]`, then GLM tier-1b, and llama-cpp cap 1. If the stated approved intent remains authoritative, current live and durable policy must be restored; Uzu may still remain catalog-available without being a code/research rung.

8. **The correct refresh action is authenticated `POST /api/providers/{id}/sync-models`; it was not invoked.** It forces a live `/models` read with `refresh=true&excludeCustom=true`, then updates connection-scoped discovery/synced-model state. It is a reasonable one-time operation after durable policy is settled, but it is not side-effect-free: it writes SQLite, invalidates caches, takes a DB backup, may reconcile context windows and editor profiles, prunes stale connection caches, removes prior *imported* custom-model rows, preserves manual custom overlays, and may write a call log. `POST /api/providers/{id}/test` is not a catalog refresh and also persists health/tokens/status; it should not be used for this repair.

## Evidence

### 1. Mac flake wiring and local ownership

- `flake.nix:137-153` imports `./modules/darwin/omniroute.nix` into `darwinConfigurations.stabulous`. There is no import or invocation of `scripts/configure-omniroute.sh`.
- A repository-wide reference search found the script only in reports/docs and `scripts/setup-omniroute.sh:18`; no activation, launchd, package, or Nix command executes it.
- Worktree status at investigation time:
  - `modules/darwin/omniroute.nix` — added;
  - `scripts/configure-omniroute.sh` — untracked;
  - `flake.nix` — modified.
  This matters because the inspected state is current working-tree/live state, not a clean committed flake baseline.
- The active launch agent `com.celes.omniroute` was running. `launchctl` reported PID 93824, and Node PID 94037 listened on `127.0.0.1:20128`. Its plist executes Nix-store launcher `/nix/store/3gx3gn8zrvpav8hdsj9za7rq12cahjbn-omniroute-server`.
- The deployed launcher is the code generated by `modules/darwin/omniroute.nix:80-97`: it opens `/Users/celes/.omniroute/storage.sqlite`, applies bootstrap SQL, and starts OmniRoute on port 20128. The environment is defined at `modules/darwin/omniroute.nix:109-125`, including `OMNIROUTE_DATA_DIR=/Users/celes/.omniroute`, `OMNIROUTE_SERVER_HOST=127.0.0.1`, `REQUIRE_API_KEY=false`, and local strict providers `vllm,llama-cpp`.
- The active module is the local catalog owner:
  - static llama-cpp entries: `modules/darwin/omniroute.nix:4-14`;
  - write to local `customModels`: lines 33-34;
  - write to local connection-scoped `syncedAvailableModels`: lines 36-43;
  - local M5 base URL: lines 45-52.
- The local SQLite row for the M5 connection points to `http://127.0.0.1:7777/v1`, has `passthroughModels=true`, and the local catalog is exactly the six static IDs from lines 5-13. It lacks Uzu and contains retired IDs.
- `scripts/configure-omniroute.sh:6` defaults its management target to `http://127.0.0.1:20128`. Its M5 provider is local loopback (`:148`), and its 5090 target is a physical inference endpoint (`:67`), not cluster OmniRoute. It therefore cannot seed cluster state unless an operator deliberately overrides `OMNIROUTE_BASE_URL`, supplies cluster authentication, and runs it—none of which is wired in the flake.
- `modules/darwin/omniroute-wireguard.nix:8-14` gives the Mac `192.168.133.2` and routes cluster subnets. That is network reachability, not database/catalog replication. The module publishes only a DS4 API proxy on port 8083 (`:54-63`); the observed `:7777` reachability is provided elsewhere by the current model-proxy setup.

**Conclusion:** the pasted handoff was directionally right that the two OmniRoutes are separate, but it missed that the active `omniroute.nix` now directly seeds the **local** catalog on every launch. The old shell script is obsolete as an automatic owner, not the source of the current cluster catalog.

### 2. Cluster Deployment, manifest drift, DATA_DIR, and errors

Live Deployment `omniroute/omniroute`, generation 113:

- image: `registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`;
- one available replica, current pod `omniroute-7f9d7d8b7c-r5chw`, started `2026-10-11T05:37:12Z`, zero restarts at inspection;
- `DATA_DIR=/app/data`;
- `/app/data` mounted from PVC `omniroute-data-longhorn`;
- PVC is a bound 5 GiB Longhorn volume, reclaim policy `Retain`;
- database is `/app/data/storage.sqlite` (about 540 MB at inspection); `/app/data/omniroute.db` exists but is zero bytes;
- `OMNIROUTE_STRICT_SYSTEM_PROVIDERS`: absent;
- selected live-only/newer values include `REQUEST_TIMEOUT_MS=2700000`, `OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS=1200000`, both stream-readiness values `1200000`, `STREAM_IDLE_TIMEOUT_MS=300000`, and `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS=vllm,ollama-local`.

Durable file evidence:

- `/home/celes/sources/kube/omniroute/kustomization.yaml:1-4` contains only `omniroute.yaml`.
- `/home/celes/sources/kube/omniroute/omniroute.yaml:61` has old image tag `3.8.50-native-ovms-spacing-20260929`.
- `DATA_DIR=/app/data` is present at lines 80-81.
- old timeouts remain at lines 88-97.
- the data mount and correct Longhorn claim are present at lines 120-122 and 144-147.
- no strict-system-provider env is present.
- `/home/celes/sources/kube` is not a git repository, so there is no commit history protecting or identifying this manifest version.
- Deployment field ownership shows client-side apply on 2026-10-06, `kubectl-set` on 2026-10-10, and `kubectl-patch` at the current pod rollout time on 2026-10-11. This explains why current live state is ahead of the file.

Current-pod log evidence, sanitized:

- 160 exact matching lines for `System message must be at the beginning`, representing 80 paired upstream/combo log records from 00:24:07 through 03:20:41 PDT;
- safe context association: all exact failures were on the Ollama-local Qwen 27B IQ3 route; Uzu/vLLM identifiers appeared only in adjacent cascade/fallback context;
- zero `reasoning_effort` matches in the current pod logs;
- therefore the reasoning-effort fix remains good, while the independent system-message ordering issue is unresolved and active.

### 3. M5 live model inventory and cluster reachability

Both `http://127.0.0.1:7777/v1/models` on the Mac and `http://192.168.133.2:7777/v1/models` from the cluster host returned HTTP 200 and these 14 IDs:

- `deepseek-v41-uncensored`
- `ds4-deepseek-v41-uncensored`
- `ds4-glm53`
- `glm-5.3-flash`
- `glm53`
- `mlx-qwen3.8-27b-4bit`
- `qwen3.5-reader-262k`
- `qwen3.5-reader:9b-262k`
- `qwen3.8-27b-mlx`
- `qwen3.8-27b-uzu`
- `qwen35-reader-262k`
- `qwen38-mlx`
- `qwen38-uzu`
- `uzu-qwen3.8-27b`

This independently verifies both `qwen3.8-27b-uzu` and `ds4-glm53`. It also disproves any claim that the cluster cannot discover M5 because of network reachability.

### 4. Cluster provider and stale catalog

Authenticated read-only management API queries used the secret file without printing it. The API accepted bearer authentication.

Provider detail for `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`:

- provider/name: `llama-cpp` / `stabulous-m5max`;
- base URL: `http://192.168.133.2:7777/v1`;
- `passthroughModels=true`;
- default model: `deepseek-v4.1-flash`;
- updated at `2026-10-11T10:22:15.317Z` during ongoing policy activity;
- API sync-timestamp fields were null, and returned model records also had no sync timestamps;
- `GET /api/providers/{id}/models` returned `source: cache` and 17 IDs.

Cluster cache IDs:

- `qwen38-mlx`
- `mlx-qwen3.8-27b-4bit`
- `qwen3.8-27b-mlx`
- `flash-quality`
- `ds4-flash-quality`
- `deepseek-v4-flash`
- `qwen-q4`
- `ds4-qwen-q4`
- `qwen3.8-flash-next`
- `glm53`
- `ds4-glm53`
- `glm-5.3-flash`
- `deepseek-v41`
- `ds4-deepseek-v41`
- `deepseek-v4.1-flash`
- `deepseek-v41-uncensored`
- `ds4-deepseek-v41-uncensored`

Only in cluster cache, not currently advertised by M5:

- `deepseek-v41`
- `deepseek-v4.1-flash`
- `deepseek-v4-flash`
- `ds4-deepseek-v41`
- `ds4-flash-quality`
- `ds4-qwen-q4`
- `flash-quality`
- `qwen3.8-flash-next`
- `qwen-q4`

Only advertised by M5, absent from cluster cache:

- `qwen3.5-reader-262k`
- `qwen3.5-reader:9b-262k`
- `qwen35-reader-262k`
- `qwen3.8-27b-uzu`
- `qwen38-uzu`
- `uzu-qwen3.8-27b`

`passthroughModels=true` does not make the active catalog gate disappear. The observed combo failures explicitly said Uzu was unavailable in the active live catalog before reaching the provider. In source, `src/app/api/providers/[id]/models/route.ts:256-283` makes nonempty synced rows authoritative, while lines 367-375 return discovery cache unless refresh is requested. This is why a reachable passthrough provider can still be blocked by stale stored inventory.

### 5. Mac local OmniRoute catalog and lack of upstream propagation

The local instance is healthy enough to serve `/v1/models`; its `/health` path returned 404, while `/v1/models` returned the configured auto/local/hybrid/cloud model surface. Its physical database is `/Users/celes/.omniroute/storage.sqlite`; the cluster database is `/app/data/storage.sqlite` on a separate PV.

The local provider happens to use the same UUID as the cluster provider, but its base URL is loopback, default model is different, and its catalog contains only the six manual rows injected by the Mac Nix module. There is no replication process, cluster management URL, sync token, or forwarding relationship in the launch module. The Mac instance is a local routing consumer of M5/5090/4070/cloud providers; the cluster independently consumes M5 over WireGuard.

The Mac local catalog is itself stale: `modules/darwin/omniroute.nix:4-14` lacks Uzu and retains retired IDs, and the launch bootstrap reasserts those rows. Fixing cluster state therefore does not fix Mac-local direct routing, and updating Mac-local state does not fix cluster state.

### 6. `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` semantics

Candidate source: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z` at base commit `ad45d990`, with current capacity-cascade/reasoning changes in its worktree.

Exact behavior:

- `src/lib/memory/injection.ts:70-84` defines built-ins `xiaomi-mimo`, `mimo`, and `tokenrouter` and documents the self-hosted extension mechanism.
- `:90-104` parses a comma-separated, trimmed, case-insensitive env value and **adds** it to the built-in set.
- `:111-118` matches the normalized provider ID, not a connection name or individual model ID.
- `:156-175` merges memory into an existing first system message or prepends one.
- `:257-263` disables the cache-safe mid-array memory splice for strict providers.
- `open-sse/translator/helpers/strictSystemHoist.ts:18-34` says translation is the common outbound choke point, including OpenAI-to-OpenAI passthrough.
- `:74-98` finds every system-role message after index 0, removes it from its old location, and merges its text into one leading system message. It returns the original array unchanged when the provider is not strict or the array is already compliant.
- `:43-72` has a narrower always-on special case for multiple adjacent leading system messages on `vllm/qwen3.8-27b-nvfp4`; that does not solve arbitrary mid-array system messages when the env is absent.
- Calls at `open-sse/translator/index.ts:413` and `:787` apply the hoist in both relevant translation paths.

Assessment of `vllm,llama-cpp,ollama-local`:

- **`ollama-local`: required now.** Current logs repeatedly prove the IQ3 Qwen chat template rejects the present message shape.
- **`llama-cpp`: needed before making Uzu usable through cluster routes.** The source/provider family is Qwen-compatible, and the Mac local instance already treats llama-cpp as strict. Today the stale catalog prevents Uzu from reaching its upstream, so current logs cannot prove the upstream error there yet.
- **`vllm`: prudent and consistent, though less urgently evidenced.** The NVFP4-specific leading-message merge already handles one narrow shape, but the generic env is what handles mid-array system messages. Adding it extends protection to all vLLM connections/models under that provider ID.
- The setting does **not** rewrite every message globally. It acts only for the named provider IDs and only changes arrays containing non-leading system messages (plus the existing model-specific vLLM rule). Risk is semantic/prompt-cache change for those malformed arrays: multiple system messages are merged, array text parts are flattened to text, and cache prefixes may differ. Compliant requests are no-ops.

### 7. Capacity policy intent conflict

Read-only live API facts:

- total combos: 94;
- cloud/online pool count matching `pool/tier[2-5]/*`: 44;
- all 44 have `targetTimeoutMs=60000`;
- live caps: vLLM 2, Ollama-local 1, llama-cpp 2.

Current live code/research local sequence:

1. `pool/tier1/{code,research}` round robin: 5090 Qwen, 4070 IQ3 Qwen, M5 Uzu Qwen, 5090 Qwen;
2. `pool/tier1b/{code,research}`: M5 `ds4-glm53` at concurrency 1;
3. tier 2+ cloud pools.

Durable generator evidence:

- `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py:32-37` defines 5090, IQ3, MLX, GLM, and Uzu.
- `:137-142` now sets provider caps 2/1/2 and explicitly says llama-cpp has “GLM planner + Uzu coder, one slot each.”
- `:199-218`, especially `:213-215`, generates `[QWEN5090, IQ3, UZU, QWEN5090]` for code/research.
- `:251-256` then creates separate GLM tier-1b overflow.
- `:263-274` puts tier1, tier1b, and cloud into roots in that order.
- Commit `0395e6897188a3412399bdbe6721b384574993d6` (`omniroute-mode: add M5 Uzu 27B coder lane + capture live tiered policy`) is on `main`/`origin/main` and changed this policy.
- State file `/home/celes/.local/state/omniroute-routing/tier-switch-state.json` was updated at 03:05:25 PDT, records active mode `tiered`, 80 managed routes, three provider policies, and a rollback backup.
- Backup `omniroute-mode.py.bak-uzu-27b-20261011T030136Z` shows the approved-like prior values: `[5090, IQ3, 5090]`, llama-cpp cap 1, followed by GLM tier-1b.

Therefore the handoff claim “Uzu is M5 rung 3” accurately describes **current drift**, not the stated approved policy. It is not merely a catalog-available model today. No evidence supports replacing GLM as the approved slot-4/overflow model; GLM remains the durable tier-1b and planner specialist. Restoring approved intent means removing Uzu from code/research tier 1 and returning llama-cpp to cap 1 while leaving Uzu discoverable for explicit/manual routes.

### 8. Refresh/test endpoints and persistence semantics

Current source verifies all three endpoints:

- `GET /api/providers/{id}/models`: `src/app/api/providers/[id]/models/route.ts:132-150`;
- `POST /api/providers/{id}/sync-models`: `src/app/api/providers/[id]/sync-models/route.ts:392-404`;
- `POST /api/providers/{id}/test`: `src/app/api/providers/[id]/test/route.ts:1208-1225`.

Sync behavior:

- authentication required: sync route lines 416-422;
- forced live read with `?refresh=true&excludeCustom=true`: lines 360-388;
- refresh bypasses normal cached-discovery return: models route lines 367-375;
- imports/reconciles fetched models: sync route lines 608-652;
- persists discovered rows connection-scoped when nonempty: `src/lib/providerModels/managedModelImport.ts:242-328`;
- preserves manual custom overlays while removing prior imported rows: managed import lines 284-319;
- prunes stale inactive-connection caches: lines 330-335;
- canonical storage is `key_value(namespace='syncedAvailableModels', key='<provider>:<connection>')`: `src/lib/db/models/syncedAvailableModelPersistence.ts:42-75`;
- a changed write backs up the DB, invalidates model cache, and schedules context-window reconciliation: persistence lines 24-39 and 77-79;
- sync may auto-update Codex/Claude profiles and write a call log when stored state changes: sync route lines 652-725.

A sync should add the six missing advertised IDs and replace stale imported discovery rows. It will deliberately retain manual custom overlays, so it may not make the visible catalog byte-for-byte identical to `/v1/models`; removing obsolete manual rows would be a separate, higher-risk cleanup.

`POST .../test` is not a harmless probe: `test/route.ts:1100-1155` writes test status/errors/cooldowns, may update refreshed tokens, and can sync cloud state. It was correctly not called.

## Prioritized conclusions and recommendations

### A. Required durable configuration changes

1. **Restore the approved capacity cascade before treating Uzu as a live rung.** In the durable generator, return code/research tier 1 to `[5090, 4070, 5090]`, retain GLM as the following tier-1b/slot-4 overflow before cloud, and return llama-cpp `maxConcurrent` to 1. Apply only with the generator’s drift checks and backup. Uzu can remain in catalog and be exposed by an explicit route without changing code/research policy.
   - Risk: changing active routing/caps can interrupt or reroute in-flight work and may expose latent contention.
   - Rollback: use the generator’s timestamped `tier-policy-before.json` and built-in `--rollback`; it validates drift before restoring.

2. **Make `/home/celes/sources/kube/omniroute/omniroute.yaml` match the complete intended live Deployment, not merely add one env line.** Pin the verified image digest; carry forward the current live timeout/security/embedding/hard-concurrency env and Longhorn PVC; add `OMNIROUTE_STRICT_SYSTEM_PROVIDERS=vllm,llama-cpp,ollama-local`. The current file is unsafe to reapply because it would regress the image and multiple live settings.
   - Risk: a typo or omitted live-only field causes a full pod replacement and behavior regression.
   - Rollback: save the complete pre-change Deployment JSON/YAML and use Deployment rollout history/previous ReplicaSet; preserve the retained PVC. Verify image ID, env, readiness, and sanitized error counts after rollout.

3. **Decide and document one declarative cluster owner.** The kube directory is not versioned and live state has accumulated imperative set/patch changes. Put the reconciled manifest under the actual managed repository or make the generator/deployment mechanism explicit; otherwise future applies will continue to erase fixes.

4. **Update the active Mac `modules/darwin/omniroute.nix` catalog only if Mac-local direct OmniRoute must expose current Uzu/reader IDs.** This is separate from cluster repair. Add current IDs/metadata and retire stale rows deliberately. Do not rely on the old configure script, because the launch bootstrap will reassert the Nix catalog.
   - Risk: local catalog changes alter Kiro’s visible direct models and may invalidate local routes referencing retired aliases.
   - Rollback: restore the prior six-entry Nix catalog and rebuild/restart the local launch agent.

### B. One-time safe catalog sync

After the durable routing decision and strict-system env rollout, invoke exactly one authenticated `POST /api/providers/70b82fc9-6f96-41ac-aa16-8da6099dd7ac/sync-models`, then verify with `GET /api/providers/{id}/models` that Uzu appears and route validation no longer reports it absent. Do not use `/test` as a substitute.

- Expected mutation: cluster `/app/data/storage.sqlite` discovery/synced rows, cache invalidation, DB backup, possible editor-profile/context-window reconciliation, and a model-sync call log.
- Expected preservation: manual custom metadata overlays.
- Risk: the live endpoint currently advertises aliases as independent IDs; sync imports all eligible IDs and can remove prior imported rows. It may leave obsolete manual rows visible.
- Rollback: restore the automatically created pre-write DB backup or re-sync after restoring the upstream advertisement; prefer a targeted catalog backup/inspection over whole-PV rollback.

### C. Obsolete/dead files worth cleaning later

- `scripts/configure-omniroute.sh`: remove or rewrite after its remaining manual setup/documentation role is replaced. It is stale and no longer the automatic local owner.
- `scripts/setup-omniroute.sh:18` and `docs/local-inference.md:91-99`: update instructions so they identify `modules/darwin/omniroute.nix` as the current catalog/bootstrap owner.
- stale local catalog entries in `modules/darwin/omniroute.nix:4-14`: reconcile separately from cluster.
- timestamped `.bak-*` generator files: retain until the approved policy is restored and audited, then archive/remove under normal repository hygiene.

### D. No-op or stale claims

- **No-op/stale:** changing the Mac local OmniRoute catalog will not repair the cluster catalog.
- **No-op/stale:** `passthroughModels=true` does not bypass the active catalog gate in this build.
- **Stale:** the cluster currently has provider caps 2/1/1. Actual live is 2/1/2 after the Uzu policy commit.
- **Stale:** Uzu is only catalog-available. It is currently an active code/research tier-1 member, although the catalog gate prevents successful dispatch.
- **Incorrect conflation:** the current system-message error is the prior reasoning-effort Jinja error. Current pod logs show the former repeatedly and zero matches for the latter.
- **Confirmed:** 94 total combos, 44 cloud pools at 60 seconds, live image digest, M5 Uzu+GLM advertisement, and cluster reachability to M5.
