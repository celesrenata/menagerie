# Orchestrator Lane Routing — Findings Report

**Mode:** READ-ONLY investigation. No files were modified, no services restarted.
**Date:** generated during workflow `wf_9cc8a7c0b26bfd6c`.

---

## Summary answer (TL;DR)

The orchestrator lands on the GLM-only `hybrid/planner` lane because of **one single configuration point on the Menagerie Mac side**:

- `/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json` →
  `providerProfiles.modeApiConfigs.orchestrator = "omni-hybrid-planner"` (and `spec-orchestrator = "omni-hybrid-planner"`, `visual-auditor = "omni-hybrid-planner"`).
- That profile (`OmniRoute-Hybrid-Planner`) has `openAiModelId = "hybrid/planner"`. Every orchestrator *coordination* turn carries model id `hybrid/planner`, and OmniRoute resolves that id to combo `hybrid/planner` → `combo:pool/tier1/planner` → `llama-cpp/ds4-glm53` (GLM, M5, maxConcurrent 1). That is the 65/65 you saw.

**The parallel workers do NOT leak onto planner at the Menagerie extension level.** `resolveWorkerModelId` runs each worker on its own saved profile model (reader → `hybrid/reader`, research → `hybrid/research`), never inheriting the parent orchestrator's `hybrid/planner`. So the fix is **only** "move the orchestrator off planner" — Q2 shows no worker→planner leak originating in the extension (see the caveat in Q2 about what the logs actually prove).

**Minimal fix (Mac side only):** point the orchestrator mode at the coder/reasoner profile instead of the planner profile. One JSON value:
`modeApiConfigs.orchestrator`: `"omni-hybrid-planner"` → `"omni-hybrid-code"`. No remote `omniroute-mode.py` change is required, and the GLM-only planner lane stays intact for genuine planning. Details and the `spec-orchestrator` decision are in Q3.

---

## Q1 — Where is the orchestrator assigned its OmniRoute lane/combo?

The assignment is a two-hop lookup, entirely on the Mac side, plus a passive resolution on the remote.

### Hop 1 (Mac): mode slug → profile id

**File:** `/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json`
**JSON path:** `providerProfiles.modeApiConfigs`

Current values (quoted verbatim):

```json
"orchestrator": "omni-hybrid-planner",
"spec-orchestrator": "omni-hybrid-planner",
"visual-auditor": "omni-hybrid-planner",
"code": "omni-hybrid-code",
"architect": "omni-hybrid-research",
"project-reader": "omni-hybrid-reader",
"project-research": "omni-hybrid-research",
...
```

How this is consumed in the extension:
- `src/core/config/ProviderSettingsManager.ts` — `modeApiConfigs` schema (line ~40), `setModeConfig(mode, configId)` writes `providerProfiles.modeApiConfigs[mode] = configId` (~line 567), and `getModeConfigId` returns `modeApiConfigs?.[mode]` (~line 581). When a task runs in `orchestrator` mode, the provider loads the profile whose id is `omni-hybrid-planner`.
- `src/extension/api.ts` (~line 572): on `setConfiguration`, each `modeApiConfigs` entry is persisted via `setModeConfig`.

### Hop 2 (Mac): profile id → model id

**File:** same profiles JSON
**JSON path:** `providerProfiles.apiConfigs["OmniRoute-Hybrid-Planner"]`

```json
"OmniRoute-Hybrid-Planner": {
  "id": "omni-hybrid-planner",
  "openAiModelId": "hybrid/planner",
  "openAiBaseUrl": "https://omniroute.celestium.life/v1",
  "openAiIsOmniRoute": true,
  "openAiOmniRouteReaderRouteId": "hybrid/research",
  "openAiOmniRouteReasonerRouteId": "hybrid/code",
  ...
}
```

The orchestrator's **own** coordination/tool-calling turns use `openAiModelId = "hybrid/planner"`. (The `openAiOmniRouteReaderRouteId`/`openAiOmniRouteReasonerRouteId` fields on this profile are the *worker* role defaults it would hand to children if a child shared this profile — they are not what the orchestrator's own turns use.)

### Hop 3 (Remote, passive): model id → combo → GLM

**File:** `celes@192.168.42.254:~/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`

- `WEIGHTS['planner'] = (0, 0, 0, 100)` (line ~20) → tuple order `[5090, MLX, IQ3, GLM]`, so 100% GLM.
- `build()` constructs pool `pool/tier1/planner` with `description = 'Tier 1 planner: M5 DS4 GLM only'` and the combo `hybrid/planner` (family loop, `name = f'{family}/{category}'`) as a priority combo-ref to that pool.
- `context_length` for planner tier 1 = `PLANNER_RAW_WINDOW` (1048576) — this matches the 1M-context observation in the evidence.

**The single configuration point** that causes orchestrator requests to resolve to combo `hybrid/planner` is therefore `modeApiConfigs.orchestrator = "omni-hybrid-planner"` → that profile's `openAiModelId = "hybrid/planner"`. Change either and the lane changes; the cleanest is the mode→profile mapping (Q3).

---

## Q2 — Are the parallel workers also resolving to `planner`?

**At the Menagerie extension level: NO. Workers do not inherit the orchestrator's `hybrid/planner`.**

**File:** `src/core/task/parallelWorkerRouting.ts`, function `resolveWorkerModelId` (and `roleDefault`).

The precedence (quoted/paraphrased from the code and its regression tests):

1. An explicit per-worker `route` wins verbatim.
2. **A worker whose own saved profile model differs from the parent runs on its own profile model.** This is the key guard:
   ```ts
   const ownModelId = workerProfile.openAiModelId
   if (ownModelId && ownModelId !== parentModelId) return ownModelId
   ```
   The code comment states this exists precisely so "a reader whose profile defines no role routes inherited the parent orchestrator's model and did all its reading there" — i.e. it was added to stop the planner-inheritance leak.
3. Else `roleDefault(mode, profile)` — reader modes → `openAiOmniRouteReaderRouteId`, every other mode → `openAiOmniRouteReasonerRouteId`.
4. Else fall back to parent model id.

Regression tests in `src/core/task/__tests__/parallelWorkerRouting.spec.ts` lock this:
- `project-reader` with profile `hybrid/reader` and parent `hybrid/planner` → resolves to `hybrid/reader` (comment: "it must not inherit the GLM planner").
- `project-research` with profile `hybrid/research` + reasoner `hybrid/code`, parent `hybrid/planner` → resolves to `hybrid/research`.

The batch workers you observed carried `OmniRoute-Hybrid-Reader` / `OmniRoute-Hybrid-Research`, whose `openAiModelId` are `hybrid/reader` / `hybrid/research` — both differ from `hybrid/planner`, so branch (2) fires and they resolve to their own lanes.

**How a worker's model-id maps to a combo:** identically to the orchestrator — the resolved `openAiModelId` (e.g. `hybrid/reader`) is sent as the request model, and OmniRoute matches it to combo `hybrid/reader` → `pool/tier1/reader` → `READER4070` (`ollama-local/qwen3.5-reader:9b`), per `TIER1_OVERRIDES['reader'] = [(READER4070, 100)]` in `omniroute-mode.py`.

### Caveat — what the logs actually prove

The confirmed evidence says 65/65 logged combos were `hybrid/planner` with **zero** reader/research traffic, even though workers "carried" reader/research profiles. Reconcile:

- If in the logged window the orchestrator made many coordination turns but the workers **had not yet been dispatched / had not yet issued model calls**, then 65/65 planner is simply the orchestrator talking to itself on GLM — fully consistent with "no leak". The orchestrator is a chatty dispatcher: every planning/tool turn is a GLM request at ~128s each, which alone saturates a single-slot M5.
- The code path cannot route a `hybrid/reader`/`hybrid/research` worker onto `hybrid/planner`; there is no code route for that. So a *literal* worker→planner leak is not reproducible from the extension source.

**Bottom line for the fix decision:** the fix is "move the orchestrator off planner" only. There is no extension-side worker→lane bug to fix. If after moving the orchestrator you *still* see zero reader/research combos while workers are demonstrably dispatched, that would point at a *runtime* issue (workers never issuing calls, or profiles not loaded) rather than a routing-map bug — but nothing in the current source supports a worker→planner mapping leak. This cannot be fully determined from static files alone; it requires correlating a log window where workers are known to have issued model calls.

---

## Q3 — Minimal, precise change to route the orchestrator to the coder/reasoner lane

### (a) Menagerie Mac side — THE change (this is all that is required)

**File:** `/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json`
**JSON path:** `providerProfiles.modeApiConfigs.orchestrator`

| | value |
|---|---|
| before | `"orchestrator": "omni-hybrid-planner"` |
| after  | `"orchestrator": "omni-hybrid-code"` |

Pointing `orchestrator` at `omni-hybrid-code` makes the orchestrator's own turns carry `openAiModelId = "hybrid/code"`, which OmniRoute resolves to combo `hybrid/code` → `pool/tier1/code` → `TIER1_OVERRIDES['code'] = [(QWEN5090,55),(GLM,24),(IQ3,21)]`. That is the coder/reasoner lane: 5090-primary with M5-GLM + 4070-IQ3 overflow. This is exactly the "coder/reasoner lane (5090-primary + overflow)" the design intent calls for.

Why `omni-hybrid-code` rather than a new profile: `OmniRoute-Hybrid-Code` already exists, already has `openAiOmniRouteReaderRouteId = "hybrid/reader"` and `openAiOmniRouteReasonerRouteId = "hybrid/code"`, so if a child ever shares the orchestrator profile the worker role-defaults remain correct. No new profile needs to be authored.

**Decision on `spec-orchestrator`:** it is also mapped to `omni-hybrid-planner` and is likewise a dispatcher (its `roleDefinition` is "deliver work only by delegating it"). For consistency with the stated design intent, apply the same change:

| | value |
|---|---|
| before | `"spec-orchestrator": "omni-hybrid-planner"` |
| after  | `"spec-orchestrator": "omni-hybrid-code"` |

**Decision on `visual-auditor`:** it is also mapped to `omni-hybrid-planner`, but it is NOT a dispatcher — it is a vision-capable screenshot reviewer. Planner (`hybrid/planner` → GLM) is vision-capable (`supportsImages: true`) and this is single-shot analytic work, not coordination fan-out. **Leave `visual-auditor` on `omni-hybrid-planner`.** Changing it is out of scope for this task and would alter image-review routing.

### Honoring the "Qwen is not a planner fallback" intent

This change does **not** add Qwen as a planner fallback. `WEIGHTS['planner']` stays `(0,0,0,100)` and `pool/tier1/planner` stays GLM-only. The orchestrator simply becomes a *consumer of the coder lane* (`hybrid/code`), which is explicitly allowed. Genuine deep-planning work (anything still routed through `hybrid/planner`, e.g. `visual-auditor`, or any future planner-profile task) continues to hit GLM.

### (b) Remote host `omniroute-mode.py` / OmniRoute combo config

**No remote change is required** for the orchestrator fix. The `hybrid/code` combo and `pool/tier1/code` already exist and already carry the 5090-primary + GLM/IQ3 overflow chain. The remote config is already correct for the target lane; only the Mac-side mode→profile mapping is wrong.

(Optional, NOT required: if you wanted the orchestrator on a *dedicated* reasoner lane distinct from worker coders, that would require authoring a new category/pool/combo in `omniroute-mode.py` and a matching Mac profile. This is unnecessary for the stated goal and is explicitly not part of the minimal fix. See Q4 for why sharing the coder lane is acceptable.)

### Apply mechanics

The profiles JSON is the exported snapshot; the live source of truth is `ContextProxy` secret storage. To make the change take effect you must re-import the edited profiles (Settings → import) or change the orchestrator mode's API config in the UI, not merely edit the file on disk — editing the JSON alone does not update running `ContextProxy` state. (Flagged because the brief treats this file as read-only input; stating this is informational, not an instruction to edit.)

---

## Q4 — Risks / interactions

### 1. Does it collide with the capacity-aware scheduler (`routeCapacityMap reasoner=2`)?

**File:** `src/core/task/routeCapacityMap.ts` — `STATIC_ROUTE_CAPACITY.reasoner = 2`, with the comment "27B code lane; vLLM `maxConcurrent 2`". The scheduler (`BoundedElasticScheduler` in `runParallelTasks.ts`) uses this map to lease **worker** slots per capability.

Key point: **the orchestrator's own coordination turns are NOT scheduled through `routeCapacityMap`.** That map governs parallel *worker* leasing (reader/reasoner/long-context/general/vision slots). The orchestrator turn is an ordinary top-level chat request. So moving the orchestrator onto `hybrid/code` does not consume a `reasoner` worker lease and does not change the scheduler's accounting. The scheduler is unaffected.

### 2. Will it over-subscribe the 5090?

This is the real interaction to watch. Relevant facts:
- `omniroute-mode.py` `PROVIDER_POLICIES[vllm] = {'maxConcurrent': 2}` and the comment: the 5090 vLLM runs 2 sequences (`esnixi/vllm.nix --max-num-seqs 2`), "the 2nd slot is slow overflow", **shared** between coder workers and now the orchestrator.
- `pool/tier1/code` is a **priority** chain `[(QWEN5090,55),(GLM,24),(IQ3,21)]`: QWEN5090 first, then M5 GLM, then 4070 IQ3 as overflow.

Consequence: the orchestrator now competes with `coder.primary` workers for the two 5090 slots. Because the chain is priority with GLM and IQ3 as explicit overflow targets, OmniRoute spills to GLM/IQ3 when the 5090's 2 slots are busy rather than blocking. So you get contention, not a hard stall. But under heavy parallel coding fan-out, the orchestrator's turns may land on the GLM overflow slot (slower) or the IQ3 slot — ironically the same GLM it is leaving, but now only under contention rather than always.

Net: moving the orchestrator to the coder lane is a clear improvement over 100%-GLM-always (the 5090 and IQ3 now carry orchestrator traffic in the common case), but it does add one more consumer to a 2-slot card already shared by coder workers.

### 3. Backend-spread routing interaction

**File:** `src/core/task/parallelWorkerRouting.ts` — `resolveLaneRouteId` / `collectCodeCapableRouteIds`. The just-shipped spread round-robins `coder.primary` workers across `codeCapableRouteIds` (reasoner route id + reasoner/general custom routes) by `coderOrdinal`. This spread applies to **workers**, not the orchestrator. The orchestrator's own turn still resolves straight to `hybrid/code`. So the spread and the orchestrator fix are orthogonal; no collision.

### 4. Should the orchestrator get a dedicated slot or share?

**Recommendation: share the coder lane (the minimal fix), do not carve a dedicated slot now.** Rationale:
- The orchestrator is a dispatcher: its turns are frequent but bursty (plan → dispatch → wait for workers → integrate). While workers run, the orchestrator is mostly idle, so steady-state contention on the 5090 is lower than the worst case suggests.
- A dedicated slot would require a new remote category/pool/combo plus a new Mac profile (more surface area, more drift risk against `PROVIDER_POLICIES`), for a benefit that only materializes under sustained max fan-out.
- If, after applying the fix, telemetry shows the orchestrator starving coder workers on the 5090, the follow-up is a dedicated low-weight pool on a different card (e.g. route orchestrator coordination to a GLM/M5-first chain so it does not touch the 5090 at all) — but that is a second, data-driven iteration, not part of this minimal change.

---

## What could not be determined from available files

- Whether, in the specific 65/65 log window, the reader/research workers had actually issued model calls yet. The source proves no worker→planner *mapping* leak exists, but only live log correlation (a window where workers demonstrably made calls) can confirm workers resolve to reader/research at runtime. If zero reader/research combos persist after the orchestrator fix *with workers known to be calling*, investigate runtime worker dispatch, not the routing map.
- Whether the live `ContextProxy` state matches the on-disk `omniroute-zoo-profiles.json` snapshot. The JSON is an export; the running mapping could differ if the file was edited without re-import.

---

## Change inventory (nothing applied)

**Mac side (user applies via Settings import or UI, not raw file edit):**
`/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json` → `providerProfiles.modeApiConfigs`:
- `orchestrator`: `omni-hybrid-planner` → `omni-hybrid-code`
- `spec-orchestrator`: `omni-hybrid-planner` → `omni-hybrid-code`
- (`visual-auditor`: leave as `omni-hybrid-planner`)

**Remote side:** none required.
