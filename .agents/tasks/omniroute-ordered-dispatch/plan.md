# Implementation Plan — OmniRoute Ordered Dispatch (Tier-1 interleave + Tier-2 free-before-cheap)

Repo: `/Users/celes/sources/celesrenata/OmniRoute`
Branch checked out during exploration: `release/v3.8.52` (NOT `feat/hybrid-reader-combo` as the step assumed; same discrepancy the backup report flagged). The implementer should confirm/switch to the intended working branch before coding; the engine files below exist on both.
Live API: `https://omniroute.celestium.life` — management via `/api/combos` (list) and `PATCH /api/providers/<id>` (per-connection). `/api/management/*` does not exist (404). Management bearer key lives at `/run/secrets/omniroute_management_api_key` on `192.168.42.254` — never print/store it.

---

## PART 1 PATH:
PART 1 PATH: ENGINE_CODE

### Why ENGINE_CODE and not CONFIG_ONLY (option b rejected — proven by reading the code)

Option (b) = "list the 5090 as two steps `[5090-a, 4070Ti, 5090-b, GLM]` under strategy `priority`" does NOT produce the interleave. Proof from the dispatch code:

1. **`priority` applies no reordering.** `open-sse/services/combo/applyStrategyOrdering.ts` handles every non-`auto` strategy; there is no `priority` branch, so it returns `initialOrderedTargets` untouched. For a non-weighted combo that initial order is `combo.models` in declared array order (`open-sse/services/combo/comboStructure.ts::resolveComboTargets` → `getTopLevelRuntimeSteps`, which `.map`s `combo.models` in index order). So `orderedTargets` would literally be `[5090-a, 4070Ti, 5090-b, GLM]`. (This confirms duplicate steps are *representable* — each `combo.models` entry with a distinct `id` becomes its own `ResolvedComboTarget`, uniquely keyed via `buildExecutionKey(path, step.id)` at `comboStructure.ts:112`.)

2. **Every request walks `orderedTargets` from index 0.** The attempt loop at `open-sse/services/combo/comboAttemptLoop.ts:269` is `for (let i = 0; i < state.orderedTargets.length; i++)` and `orderedTargets[0]` is the primary; `i+1…` are fallbacks tried only on failure. There is NO per-combo cursor advancing the *start* index for `priority` (that cursor only exists for `round-robin`, `rrState.ts`/`roundRobinCombo.ts`). So **four concurrent requests each start at `orderedTargets[0]` = 5090-a.**

3. **The only per-job gate that could divert job 2 to the 4070 Ti is the per-connection concurrency semaphore, and with cap=2 it does NOT fire for job 2.** The pre-dispatch skip gate is `open-sse/services/combo/executeTargetGates.ts` (~line 404): `const maxConcurrentCap = await lookupPositiveCap(connectionId); if (maxConcurrentCap && isAccountSemaphoreFull(provider, connectionId, maxConcurrentCap)) { skip }`. `isAccountSemaphoreFull` (`open-sse/services/accountSemaphore.ts`) keys on `provider:connectionId` and returns `running >= cap`. The slot is actually acquired at dispatch in `open-sse/handlers/chatCore.ts` (`acquireConcurrencyGates`, cap from `credentials.maxConcurrent`). With the 5090 cap set back to **2** (required so job 3 can land on it), job 1 takes slot 1 of 2 → `running=1 < 2` → **not full** → job 2 ALSO passes the 5090 gate and takes slot 2 of 2. Result with option (b): jobs 1 and 2 both on the 5090, i.e. the greedy fill the user explicitly rejected. **Both 5090 steps share one connection semaphore**, so a second 5090 step cannot be "independently concurrency-gated" — the task's precondition for preferring (b) is false.

Therefore an explicit ordered sequence that **advances one entry per concurrent job** (task option (a)) is required.

### Engine design (option a — `config.dispatchSequence`)

A per-combo rotating cursor over an ordered sequence (with repeats), applied to `priority` combos only, that makes **`orderedTargets[0]` differ per concurrent request**. Everything downstream (per-connection semaphore skip, fail-safe advance to the next entry, fall-through to the rest of the chain / tier 2) is already implemented and reused unchanged.

- **Config shape** (new, additive, under `combo.config`): `dispatchSequence: string[]` — an ordered list of **step ids** (the `id` field of entries in `combo.models`), repeats allowed. Example for tier-1 code: `["code-t1-5090a", "code-t1-4070ti", "code-t1-5090b", "code-t1-glm"]`. Using step ids (not modelStr) is unambiguous when the same model/connection appears twice. (If the maintainer prefers not to add a duplicate `combo.models` entry for the 5090, the sequence may repeat an existing step id — see Item 2 note — but adding a distinct second 5090 step id is cleaner and is the layout specified in the diffs below.)
- **Cursor**: a module-level `Map<comboName, number>` mirroring `rrCounters` in `open-sse/services/combo/rrState.ts` (same eviction cap `MAX_RR_COUNTERS`, same "resets on restart" semantics). Call it `dispatchSeqCounters`.
- **Rotation**: when `strategy === "priority"` AND `config.dispatchSequence` is a non-empty array, after the base `orderedTargets` are resolved, reorder them so the head follows the sequence rotated by the current cursor:
  - Build `seqTargets` = for each id in `dispatchSequence`, the matching target(s) by `stepId`, in sequence order (an id with no matching step is skipped with a warn log).
  - `start = counter % seqTargets.length`; rotate: `rotated = [...seqTargets.slice(start), ...seqTargets.slice(0, start)]`.
  - Append any `orderedTargets` **not** named in the sequence (preserving their relative order) as the tail — these are the fall-through-to-rest-of-combo targets. (For the tier-1 pools every model is in the sequence, so the tail is empty and fall-through goes to tier 2 via the existing tier chain.)
  - Final `orderedTargets = [...dedupeByReference(rotated), ...tail]`. Do NOT drop duplicate *step* entries — the two 5090 steps are distinct `ResolvedComboTarget` objects and both must remain so the loop can try the second if the first is skipped.
  - **Increment the cursor by 1 at rotation time** (admission), NOT at settle. This is what makes concurrent requests see different start indices: request A rotates with counter=0 (head 5090a) then sets counter=1; request B, arriving while A is in flight, rotates with counter=1 (head 4070ti) then sets counter=2; etc. Guard the read-modify-write so it is atomic within the single-threaded event loop (a plain `get`+`set` is sufficient in Node's model, matching how `rrCounters` is handled).
- **Fail-safe skip is already handled**: once `orderedTargets[0]` is the sequence head for this job, the attempt loop + `evaluateExecuteTargetGates` skip a head that is at capacity (`isAccountSemaphoreFull`), circuit-open, in cooldown, locked, or unavailable, and advance to `orderedTargets[1]` (the next sequence entry), then the tail, then the request fails over to tier 2 through the normal tier chain. No new skip logic is needed. The rotation only chooses the *starting* offset; the loop body is unchanged.

### Files to change (PART 1 engine)

1. `open-sse/services/combo/rrState.ts` — add `dispatchSeqCounters: Map<string, number>` plus a small helper `nextDispatchSequenceStart(comboName, length): number` that reads, computes `counter % length`, writes `counter+1` (with the same eviction guard as `rrCounters`). Keeping it beside `rrCounters` preserves the "single Map instance" cohesion rule the file documents.
2. `open-sse/services/combo/applyStrategyOrdering.ts` — add handling for the sequence. Cleanest: add an `else if (strategy === "priority")` branch (today `priority` is implicit no-op) that, when `config.dispatchSequence` is a non-empty array, applies the rotation described above using `nextDispatchSequenceStart`; otherwise leaves order untouched (preserving current behavior). This keeps the engine change in the one function whose job is strategy ordering and keeps the attempt loop untouched. Match the existing targets' `stepId` field to the sequence ids.
   - Note the G1 gate (`open-sse/services/combo/strategyDispatch.ts`): adding a `priority` branch does NOT change the HANDLED set (no new strategy name) and `priority` is already listed there, so the known-symbols gate stays green. Confirm by running `npm run lint` / the known-symbols check.
3. `src/shared/validation/schemas/combo.ts` — add `dispatchSequence: z.array(z.string()).optional()` to `comboRuntimeConfigSchema` so the key is validated and round-trips through combo save/export instead of only surviving via `.passthrough()`.
   - Files: `open-sse/services/combo/rrState.ts`, `open-sse/services/combo/applyStrategyOrdering.ts`, `src/shared/validation/schemas/combo.ts`
   - Verify: `npm run typecheck:core` clean; `npm run lint` 0 errors; the new unit test (Item below) passes.

### Required unit test (PART 1)

New file `tests/unit/combo-dispatch-sequence.test.ts` (Node `node:test`, mirroring `tests/unit/combo-strategy-fallbacks.test.ts`: set `DATA_DIR` to a temp dir, dynamic-import `handleComboChat`, reset `rrStickyTargets`/`dispatchSeqCounters`/semaphores between tests, mock `handleSingleModel` and `isModelAvailable`).

- **Test A — exact interleave for 4 simultaneous jobs.** Build a `priority` combo with four steps whose ids are `[5090a, 4070ti, 5090b, glm]` (5090a and 5090b share the vllm connection id with `maxConcurrent=2`; 4070ti and glm each `maxConcurrent=1`) and `config.dispatchSequence = ["5090a","4070ti","5090b","glm"]`. Make `handleSingleModel` block (never resolve until released) so slots stay held, and record the `modelStr`+connectionId each call dispatches to. Fire 4 concurrent `handleComboChat` calls. Assert the dispatched connection for job1=5090, job2=4070Ti, job3=5090 (second slot), job4=GLM — i.e. the sequence `5090,4070Ti,5090,GLM`.
- **Test B — skip an unavailable/at-capacity entry.** Same combo; make the 4070 Ti connection report at-capacity (hold its one slot, or stub `isModelAvailable`/semaphore so `isAccountSemaphoreFull` is true for it). Fire a job whose rotated head is the 4070 Ti; assert it is SKIPPED to the next sequence entry (the second 5090 step, or GLM) and never stalls/errors — the request still dispatches to a live target. Also assert that when the entire sequence is at capacity/unavailable, the chain falls through to the tier-2 fallback target (add a tier-2 step or a `combo-ref` tail) rather than failing.
   - Files: `tests/unit/combo-dispatch-sequence.test.ts`
   - Verify: `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test tests/unit/combo-dispatch-sequence.test.ts` — both tests pass. (Or scoped via `npm run test:unit` filtered to the file.)

---

## PART 2 — Tier-2: free before cheap (pure combo config, no engine change)

Strategy stays `priority`. The free model (`openrouter/qwen/qwen3.8-27b:free`) becomes step [0]; a 429/5xx on it already skips to the next target via the existing attempt-loop error handling + circuit/cooldown skip gates (same `evaluateExecuteTargetGates` path), so no engine work. This is config-only (PATCH the combos / edit combo definitions).

Per the backup report, the seven 27B-class tier-2 pools split into two current shapes:

- **code, tester, reviewer, research** — strategy `priority`, currently start `[bedrock/qwen.qwen3-coder-next, bedrock/qwen.qwen3-coder-30b-a3b-v1:0, mistral/codestral, mistral-code, bedrock/global.openai.gpt-5.6-luna]`.
- **any, long, frontier** — strategy `round-robin`, currently `[mistral/codestral-latest (w25), mistral-code (w25), bedrock/global.openai.gpt-5.6-luna (w50)]`. These do NOT currently start with the Bedrock Qwen coders.

The task says "match whichever currently start with the Bedrock Qwen coders" and lists all seven pools under POOLS for tier-1. For tier-2, the literal instruction is "put `openrouter/qwen/qwen3.8-27b:free` as the FIRST target, then the existing Bedrock Qwen coders, then the existing paid models in current order", and names the pools "tester, reviewer, research, any, long, frontier — match whichever currently start with the Bedrock Qwen coders." **ASSUMPTION (flagged):** apply the tier-2 free-first change to the four pools that actually start with the Bedrock Qwen coders — **code, tester, reviewer, research**. For **any, long, frontier** (round-robin, no Bedrock Qwen first), prepend the free model as a priority-ordered first target is ambiguous under round-robin; the implementer should either (i) leave any/long/frontier unchanged (they have no Bedrock Qwen coders to sit behind), or (ii) if the user wants free-first there too, convert them to `priority` with `[free, codestral, mistral-code, gpt-5.6-luna]`. Recommend (i) and confirm with the user if tier-2 free-first is wanted on any/long/frontier. This is the one genuine gap in the spec and must be confirmed before touching any/long/frontier.

### Tier-2 config diff (apply to code, tester, reviewer, research)

New `models` order (strategy `priority`, keep every existing field — connectionId, weight, label — on the existing entries; only prepend one new entry and keep the rest in current order):

```
[0] openrouter/qwen/qwen3.8-27b:free      (openrouter free connection)   ← NEW first target
[1] bedrock/qwen.qwen3-coder-next         (bedrock-cloud)                 ← existing [0]
[2] bedrock/qwen.qwen3-coder-30b-a3b-v1:0 (bedrock-cloud)                 ← existing [1]
[3] mistral/codestral-latest              (mistral)                        ← existing
[4] mistral/mistral-code                  (mistral)                        ← existing
[5] bedrock/global.openai.gpt-5.6-luna    (bedrock-cloud)                 ← existing last
```

- Give the new step a distinct `id` (e.g. `code-t2-free`, `tester-t2-free`, …) and set its `connectionId` to the OpenRouter connection that serves `qwen/qwen3.8-27b:free`. Resolve that connection id live before editing (`GET /api/combos` for an existing openrouter-free step, or `GET /api/providers`).
- 429/5xx skip is automatic: the free model's provider circuit breaker / cooldown and the loop's non-2xx fallback advance to [1]. No `fallbackOnlyOnQuotaExhaustion` needed; a plain priority order already fails over on 429/5xx. (If the maintainer wants the free model retried-but-not-sticky, leave defaults.)

   - Files: live combos `pool/tier2/code`, `pool/tier2/tester`, `pool/tier2/reviewer`, `pool/tier2/research` (and, pending user confirmation, `pool/tier2/any`, `pool/tier2/long`, `pool/tier2/frontier`). Edited via the management API (`PATCH`/combo save), not source.
   - Verify: `GET /api/combos` shows each pool's `models[0]` = `openrouter/qwen/qwen3.8-27b:free`, strategy `priority`, remaining order unchanged (live-verify procedure below).

---

## PART 1 — Tier-1 combo config diffs (seven pools: code, tester, reviewer, research, any, long, frontier)

Apply the SAME ordered-sequence layout to all seven. Do NOT touch reader, fast, tiny, planner.

For each pool `pool/tier1/<P>`, set strategy `priority` and define four model steps + `config.dispatchSequence`:

```
models:
  { id: "<P>-t1-5090a", model: "vllm/qwen3.8-27b-nvfp4",            connectionId: "e9bd13fb-c6b6-4c18-b42f-3395266348ce" }  # 5090
  { id: "<P>-t1-4070ti", model: "ollama-local/qwen3.8:27b-iq3-code144k", connectionId: "b20e0770-3e14-40c1-87cd-85c34b34381a" }  # 4070 Ti (ollama-local)
  { id: "<P>-t1-5090b", model: "vllm/qwen3.8-27b-nvfp4",            connectionId: "e9bd13fb-c6b6-4c18-b42f-3395266348ce" }  # 5090 again (distinct step id)
  { id: "<P>-t1-glm",   model: "llama-cpp/ds4-glm53",              connectionId: "70b82fc9-6f96-41ac-aa16-8da6099dd7ac" }  # GLM-5.3
config:
  strategy: "priority"            # (strategy is top-level on the combo; config mirrors as needed)
  dispatchSequence: ["<P>-t1-5090a", "<P>-t1-4070ti", "<P>-t1-5090b", "<P>-t1-glm"]
  concurrencyPerModel: <see CONCURRENCY>   # see note — this key is NOT read by priority dispatch today
```

Notes:
- The current tier-1 pools have THREE steps `[5090, GLM, 4070Ti]` (per backup report). The change is: (a) re-order to `[5090, 4070Ti, 5090, GLM]` via a duplicated 5090 step, and (b) add `dispatchSequence`. Keep each step's `connectionId` explicit (every current tier-1 step already pins `connectionId`, which is required so the per-connection semaphore gate applies).
- Fall-through to tier 2: because all four steps are in the sequence, when all are skipped the combo yields no target and the request fails over to tier 2 through the existing hybrid/tier chain (`dispatchPrelude.ts` runtime-unit / tier dispatch, unchanged). Confirm the tier-1 pool is reached via its tier wrapper the same way today.
- The per-model `weight`/`weightedTargetPolicies`/`weightedRoundRobin` keys are inert for `priority` (prior findings `omniroute-tier1-priority/findings.md` Evidence 1/2/6). Leave or clean up; they do not affect dispatch.

---

## CONCURRENCY — final numbers and reconciliation

- **esnixi-5090 connection `maxConcurrent`: set to 2.** Currently 1 (lowered by an earlier change). This is the gate that actually enforces the 5090's two slots (`executeTargetGates.ts` → `lookupPositiveCap` → `isAccountSemaphoreFull`; real acquisition in `chatCore.ts` from `credentials.maxConcurrent`). Required so job 3's rotated head (second 5090 step) can acquire slot 2 while job 1 still holds slot 1. Apply via `PATCH /api/providers/e9bd13fb-c6b6-4c18-b42f-3395266348ce` `{ "maxConcurrent": 2 }`.
- **gremlin-4070ti-ollama (`b20e0770-…`) `maxConcurrent`: 1.** Confirm/leave at 1.
- **stabulous-m5max GLM-5.3 (`70b82fc9-…`) `maxConcurrent`: 1.** Confirm/leave at 1.
- **`config.concurrencyPerModel` on the tier-1 pools:** per prior findings (`omniroute-tier1-priority/findings.md` Evidence 2/6), `concurrencyPerModel` is NOT read in the priority dispatch path — only round-robin reads it (`roundRobinCombo.ts:172`). The real per-model cap is the per-connection `maxConcurrent` above. **Recommended final:** document `concurrencyPerModel: 2` on the tier-1 pools for operator intent/consistency (5090 wants 2) but record explicitly that it is advisory-only for `priority` and the enforced cap is the connection `maxConcurrent`. Do NOT rely on `concurrencyPerModel` to gate the 5090; rely on the connection `maxConcurrent=2`. If the maintainer wants a single source of truth, prefer the connection value and drop `concurrencyPerModel` to avoid implying semantics the engine does not honor for priority.
- **Net effect:** 5090 can hold 2 in-flight (slots for job1 and job3); 4070Ti and GLM one each. The dispatch sequence places job2 on 4070Ti and job4 on GLM so no single connection is overfilled, and the semaphore skip is the fail-safe if reality diverges.

---

## LIVE-VERIFY PROCEDURE

1. **Backups already captured** (see backup-report.md): `all-combos-…json`, per-connection JSON for the three connections, under `/Users/celes/sources/kube/omniroute/backups/`. Re-snapshot `GET /api/combos` immediately before applying config so the diff is attributable.
2. **Apply connection change:** `PATCH /api/providers/e9bd13fb-…` set `maxConcurrent: 2`; `GET /api/providers/e9bd13fb-…` confirms `maxConcurrent=2`.
3. **Apply combo changes** for the seven tier-1 pools and the tier-2 pools (via combo save/management PATCH). `GET /api/combos` and confirm for each tier-1 pool: four steps in order `[5090, 4070Ti, 5090, GLM]` and `config.dispatchSequence` present; for each tier-2 pool edited: `models[0]` = `openrouter/qwen/qwen3.8-27b:free`.
4. **Concurrency observability:** `GET /api/admin/concurrency` (surfaces `accountSemaphore.getStats()`) to watch per-connection `running` during the test.
5. **Live interleave check:** fire 4 concurrent slow requests at a tier-1 pool (e.g. `pool/tier1/code`, or via `hybrid/code` if that is the entry) and, using the dispatch decision trace / response routing headers and `GET /api/admin/concurrency`, confirm the landing order 5090 → 4070Ti → 5090 → GLM. Then push a 5th concurrent job and confirm it falls through to tier 2 (and that tier-2's first attempt is the free OpenRouter model).
6. **Tier-2 free-first + 429 skip:** send a request routed to a tier-2 pool and confirm the free model is attempted first; simulate/observe a 429 on the free model (or wait for a real daily-limit 429) and confirm it skips to the Bedrock Qwen coder rather than failing the request.
7. **Rollback:** restore combos from the pre-change `GET /api/combos` snapshot and reset `esnixi-5090` `maxConcurrent` to its prior value if any check fails.

---

## PRE-MERGE GATES (engine change, PART 1)

- `npm run typecheck:core` and `npm run typecheck:noimplicit:core` — clean (no implicit `any`; `no-explicit-any` is an ESLint error in `open-sse/`).
- `npm run lint` — 0 errors; suppression counts must not increase.
- `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test tests/unit/combo-dispatch-sequence.test.ts` — new tests pass.
- Narrow combo regression: run the existing combo unit tests (`tests/unit/combo-*.test.ts`) to confirm no priority/round-robin regression, especially `combo-strategy-fallbacks.test.ts` and `combo-priority-all-circuit-open.test.ts`.
- Do NOT add a `.changeset` or edit `CHANGELOG.md` (maintainer-managed, per repo rules).

## OPEN QUESTIONS / ASSUMPTIONS (flagged, do not block)
- Tier-2 free-first on any/long/frontier (round-robin pools with no Bedrock Qwen first): recommend leaving unchanged; confirm with user. (See PART 2.)
- `config.concurrencyPerModel` is advisory-only for priority dispatch; enforced cap is connection `maxConcurrent`. Documented above; no code relies on it.
- Working branch discrepancy (`release/v3.8.52` vs `feat/hybrid-reader-combo`): confirm intended branch before coding.
