# Implementation Plan: per-request tier ceiling for non-auto combos

Worktree (use absolute paths; relative paths land in the parent workspace):
`/Users/celes/sources/celesrenata/OmniRoute/.worktrees/priority-tier-ceiling` (branch `fix/priority-tier-ceiling`).
Below, `$WT` means that absolute path. Run every command with `cwd=$WT` or `git -C $WT`.

## What exploration found

- `X-OmniRoute-Tier` gets parsed in `$WT/open-sse/services/autoCombo/requestControls.ts`. `resolveRequestTier()` is at L89 and `resolveRequestAutoControls()` is at L127-147. Only valid integers 1-5 are accepted; anything else becomes `undefined`.
- `$WT/src/sse/handlers/chat.ts` L1136-1142 spreads `tierCeiling` into `relayOptions`, which goes to `handleComboChat` at L1246. Only the `auto` path reads it: `$WT/open-sse/services/combo/resolveAutoStrategy.ts` L275/L418 feeds `$WT/open-sse/services/autoCombo/engine.ts` L298-328.
- Nothing outside tests reads `config.tierRouting`. The config zod schema is `.passthrough()` (`$WT/src/shared/validation/schemas/combo.ts` ~L297), so the field is stored but inert.
- `hybrid/*` uses `strategy:"priority"` with `nestedComboMode:"execute"`. In `$WT/open-sse/services/combo.ts` `handleComboChatInner` (L638+), that goes to `tryRuntimeUnitDispatch` (`$WT/open-sse/services/combo/dispatchPrelude.ts` L729-822) and then `executeRuntimeUnitCombo` (`$WT/open-sse/services/combo/runtimeUnits.ts` L185-399). That function walks every unit in order. A unit at its concurrency cap produces `503 "<unit> is at concurrency capacity"` and the loop moves to the next unit, all the way up to pool/tier5. This is the escalation the user hit. After the last unit it returns `lastResponse`, or `503 "All nested combo units unavailable"`, and calls `recordComboRequest(combo.name, …)`.
- Nested combo-ref execution re-enters `handleComboChat` through `buildBaseOptions()` (`dispatchPrelude.ts` L103-125), which forwards `relayOptions` and `requestHeaders`. A ceiling applied in `handleComboChatInner` is therefore re-applied at each nesting level for free. The pool combos (`pool/tierN/<lane>`) hold plain model steps with no derivable tier, so they stay fully admitted. **The pool needs no extra filtering: the outer step that references `pool/tierN/...` is the gate, and the pool tier is the tier.**
- In flatten mode, `resolveComboTargets`/`resolveNestedComboTargets` (`$WT/open-sse/services/combo/comboStructure.ts` L303-336, L953) expand only the top-level steps that survive. Filtering top-level `combo.models` therefore also prunes the whole subtree in flatten mode. Grandchild combo-refs inside an admitted pool are not re-filtered in flatten mode. I accept that limitation for now: pools hold models, not refs.
- The pinned-context dispatch (`tryPinnedModelDispatch`, `dispatchPrelude.ts` L266+) only honors a pin when the pinned model is still in `resolveComboTargets(combo)`. Filtering `combo.models` before that runs means a stale pin to a tier-5 model can't get past the ceiling.
- The safety-net redirect in `$WT/src/sse/handlers/chat.ts` L1483-1541 calls `handleComboChat` with `relayOptions: undefined` but does pass `requestHeaders`. The ceiling has to fall back to reading `requestHeaders`. The audio and embeddings callers (`$WT/src/app/api/v1/audio/transcriptions/route.ts:264`, `translations/route.ts:203`, `$WT/src/lib/embeddings/service.ts:115`) get the same benefit when they pass headers.
- **A second escalation path:** the Global Fallback (#689) in `$WT/src/sse/handlers/chat.ts` L1257-1311 runs `settings.globalFallbackModel` on any combo 502/503. Nothing classifies that model's tier, so a tier-1 request that exhausts its local steps can still end up on a paid model through it. It has to be gated by the ceiling.
- `normalizeComboStep` (`$WT/src/lib/combos/steps.ts` L269+) rebuilds step objects field by field. `normalizeComboModels` runs it on save (`$WT/src/app/api/combos/route.ts`, `[id]/route.ts`), so any new step field must be carried through it or it gets dropped on save.
- Combo errors surface through `errorResponseWithComboDiagnostics(status, msg, ComboDiagnostics, opts)` (`$WT/open-sse/utils/error.ts` L586). It sets `x-omniroute-combo-terminal-reason` and an optional `Retry-After`. Existing exhausted-combo terminals use 503.
- call_logs: `chat.ts` L1315-1335 records a call_logs row and a usage_history row (`recordRejectedRequestUsage`) for any `!response.ok` combo response. That covers the new 503 without extra work. Combo metrics come from `recordComboRequest` (`$WT/open-sse/services/comboMetrics.ts` L271). The filtered combo keeps the original `name`/`id`, so metrics, rr counters and traces stay keyed the same way.
- Test runner: Node's native `node --test` with tsx, not Vitest. Combo tests drive `handleComboChat` directly with a stub `handleSingleModel`. Pattern to copy: `$WT/tests/unit/combo-runtime-unit-concurrency.test.ts` (temp DATA_DIR, `createLog()`, `okResponse()`, `allCombos`).

## Design decisions

1. **One chokepoint in `handleComboChatInner`.** Filter `combo.models` before `createComboContext`, so every downstream path sees the reduced combo: pinned, fusion, chaos, pipeline, runtime-unit execute, round-robin, and the flatten target pipeline. This covers priority, fallback, round-robin, weighted, fill-first, random and the rest without touching each strategy. **`auto` is skipped**, because FEAT-005 already applies the ceiling inside the auto engine by model classification.
2. **Ceiling source:** `resolveRequestTier(relayOptions?.tierCeiling)`, falling back to `resolveRequestTier(requestHeaders.get("x-omniroute-tier"))` when relayOptions has none. `requestHeaders` can be a `Headers` or a plain record, so handle both, case-insensitively. **Absent or invalid header means no ceiling and unchanged behavior.** `config.tierRouting.defaultTier` is deliberately not applied. A code comment must say so, citing FEAT-005 "absent header = unchanged".
3. **Clamp:** when a ceiling exists and `config.tierRouting.maximumTier` is an integer 1-5, the effective ceiling is `min(header, maximumTier)`. With no header, `maximumTier` does nothing (same rule as decision 2).
4. **Step tier**, in order:
    - (a) an explicit `tier` integer 1-5 on the step. Add it as an optional field to the step schema and to `normalizeComboStep`, so it is clean and backward-compatible.
    - (b) the referenced `comboName`, or the model string for model steps, matching `/(^|\/)tier(\d)(\/|$)/i`.
    - (c) the step id matching `/-tier(\d)$/i`.
    - (d) otherwise `undefined`, and the step is **admitted**. A derived digit outside 1-5 also counts as "no tier".
5. **Zero admitted steps:** if the original combo had at least one step and the ceiling excludes all of them, return `errorResponseWithComboDiagnostics(503, "No target within tier N available for combo <name>", {poolSize: <original count>, attempted: 0, excluded: [...], attemptOrder: [], terminalReason: "tier_ceiling_no_targets"}, { code: "tier_ceiling_unavailable" })`. Also call `recordComboRequest(combo.name, null, {success:false, latencyMs:0, fallbackCount:0, strategy})`. 503 matches how exhausted combos already surface, and clients treat it as retryable. When admitted steps exist but all fail or are busy, the existing loop already returns the last local error (for example the 503 concurrency-capacity response) and never touches excluded tiers. No extra code is needed for that case.
6. **Global fallback guard:** skip the #689 global fallback when the request carries a valid ceiling below 5. The fallback model's tier is unknown, and tier 5 admits everything. Log at info: `Global fallback skipped: tier ceiling N`. Put this in a pure exported predicate so it can be unit-tested.
7. **Logging:** `log.debug("COMBO", "tier ceiling N (header H, maximumTier M) excluded steps: <stepId>(tier T), …")` whenever at least one step is excluded.

## Steps

- [ ]   1. Add an optional explicit step `tier` to the schema and normalizer.
       In `$WT/src/shared/validation/schemas/combo.ts`, add `tier: z.number().int().min(1).max(5).optional()` to `comboStepMetaSchema` (L17-22). That covers model and combo-ref steps.
       In `$WT/src/lib/combos/steps.ts`, add `tier?: number` to `ComboModelStep`, `ComboRefStep` and `ComboProviderWildcardStep` (L12-49). In `normalizeComboStep`'s object branch, read `const tier = toTier(value.tier)` (a new small helper: integer 1-5 or undefined) and spread `...(tier !== undefined ? { tier } : {})` into the combo-ref, provider-wildcard (both branches) and model return objects. String entries stay tierless.
       Files: `$WT/src/shared/validation/schemas/combo.ts`, `$WT/src/lib/combos/steps.ts`
       Verify: `cd $WT && npx cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo-config.test.ts tests/unit/combo-quota-exhaustion-option-schema.test.ts`. Existing tests must still pass, which shows unchanged shapes when `tier` is absent. Then `npm run typecheck:core` must be clean.

- [ ]   2. Create the pure tier-ceiling module `$WT/open-sse/services/combo/tierCeiling.ts`. It depends on step 1 for `ComboStep.tier`. Exports:
        - `resolveStepTier(step: ComboStep): number | undefined`, implementing decision 4 (a→d).
        - `resolveComboTierCeiling({ relayOptions, requestHeaders, config }): { ceiling: number; headerTier: number; maximumTier?: number } | null`, implementing decisions 2-3. It imports `resolveRequestTier` from `../autoCombo/requestControls.ts`. `requestHeaders` is `Headers | Record<string, unknown> | null | undefined`; read with `.get()` when available, otherwise do a case-insensitive key lookup. Doc comment: absent header = unchanged, defaultTier intentionally ignored.
        - `applyTierCeilingToCombo(combo: ComboLike, ceiling: number, allCombos: ComboCollectionLike): { combo: ComboLike; excluded: Array<{ stepId: string; tier: number }>; originalCount: number }`. It normalizes each raw `combo.models[i]` with `normalizeComboStep(entry, { comboName: combo.name, index: i, allCombos })` so string combo-refs are detected. It keeps raw entries whose tier is undefined or ≤ ceiling, and unnormalizable entries too, to preserve today's behavior. It returns `{ ...combo, models: kept }` without mutating the input. Return the same `combo` object when nothing is excluded.
        - `isGlobalFallbackAllowedForTier(tierCeiling: number | undefined): boolean`, which returns `tierCeiling === undefined || tierCeiling >= 5`.
          No `any`. Use the existing `ComboLike` / `ComboCollectionLike` types from `$WT/open-sse/services/combo/types.ts`.
          Files: `$WT/open-sse/services/combo/tierCeiling.ts`
          Verify: `cd $WT && npm run typecheck:core && npm run typecheck:noimplicit:core` are clean.

- [ ]   3. Wire the ceiling into `handleComboChatInner` in `$WT/open-sse/services/combo.ts` (L638-660), before `createComboContext`. It depends on step 2.
       Compute `normalizeRoutingStrategy(combo.strategy || "priority")` (import from `../../src/shared/constants/routingStrategies.ts`, as `combo/comboSetup.ts` L12 does). If it is not `"auto"` and `resolveComboTierCeiling({ relayOptions, requestHeaders, config: combo.config })` is non-null, call `applyTierCeilingToCombo(combo, ceiling, allCombos)`. If anything was excluded, log the debug line from decision 7. If `originalCount > 0 && kept.length === 0`, call `recordComboRequest` and return the 503 from decision 5; reuse the existing `errorResponseWithComboDiagnostics` and `buildRecoveryHint` imports where a hint fits. Otherwise reassign `combo` to the filtered combo so every later reference uses it.
       Add a comment saying the ceiling propagates to nested combo-ref execution through `buildBaseOptions` (relayOptions/requestHeaders), and that pools are untiered leaves.
       Files: `$WT/open-sse/services/combo.ts`
       Verify: `cd $WT && npx cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo-runtime-unit-concurrency.test.ts tests/unit/combo-strategy-fallbacks.test.ts tests/unit/combo-hidden-leaf-routing.test.ts tests/unit/combos-quota-protected.test.ts`. They must still pass, which confirms no-header behavior is unchanged.

- [ ]   4. Gate the Global Fallback (#689) on the ceiling in `$WT/src/sse/handlers/chat.ts` (L1257-1263). It depends on step 2.
       Add `isGlobalFallbackAllowedForTier(perRequestAutoControls.tierCeiling)` to the `if` condition. When the fallback would otherwise have run but is blocked, log at info `Global fallback skipped for combo "<name>": tier ceiling N`. Leave the call_logs / `recordRejectedRequestUsage` block (L1315+) as is, so the 503 is still recorded.
       Files: `$WT/src/sse/handlers/chat.ts`
       Verify: `cd $WT && npm run typecheck:core` is clean. The predicate gets unit-tested in step 5.

- [ ]   5. Add tests in the new file `$WT/tests/unit/combo-priority-tier-ceiling.test.ts`. Copy the harness from `$WT/tests/unit/combo-runtime-unit-concurrency.test.ts`: temp `DATA_DIR` set before imports, `handleComboChat` from `../../open-sse/services/combo.ts`, a no-op `createLog()` with a `debug` spy that captures messages, and `test.after` cleanup.
       Fixture: `pool/tier1/reader` … `pool/tier5/reader`, each `strategy:"priority"` with one model step `local/t<N>-model`. The outer `hybrid/reader` is `strategy:"priority"`, `config:{maxRetries:0, nestedComboMode:"execute", tierRouting:{defaultTier:1, maximumTier:5}}`, with combo-ref steps `{id:"hybrid-reader-tier<N>", kind:"combo-ref", comboName:"pool/tier<N>/reader"}`. The stub `handleSingleModel` records `modelStr` and returns 503 for a configurable failing set and 200 otherwise. Pass `allCombos` with all six combos and `isModelAvailable: async () => true`.
       Cases:
        - header tier 1 (`relayOptions: { tierCeiling: 1 }`) with t1 failing: the 503 result comes back, calls equal `["local/t1-model"]`, tier2+ is never called, and the debug log names the excluded `hybrid-reader-tier2..5`.
        - tier 3 with t1 and t2 failing: t3 is called and the response is 200. With t1-t3 all failing, calls equal t1..t3 and the result is 503.
        - no header and no relayOptions, with t1-t4 failing: calls reach t5 and the result is 200 (today's behavior).
        - garbage header (`relayOptions.tierCeiling: "abc"`, `9`, `0`, and `requestHeaders: new Headers({"x-omniroute-tier":"7"})`) behaves exactly like no header.
        - the header arrives only via `requestHeaders: new Headers({ "x-omniroute-tier": "1" })` with no relayOptions, which is the safety-net path: only tier 1 is tried.
        - steps with no derivable tier are admitted. The outer combo gets an extra `{kind:"model", model:"local/plain"}` step and a combo-ref to `pool/misc` (id `misc-step`); with tier 1 they are still called after t1 fails, while tier2+ is not.
        - explicit step `tier` beats name derivation: a combo-ref named `pool/tier1/reader` with `tier: 4` gets excluded at ceiling 2.
        - maximumTier clamp: with `tierRouting.maximumTier: 2` and header 4, all tiers failing, calls equal t1..t2.
        - zero admitted: a combo of only tier2..5 refs with header 1 returns status 503, a body message containing "tier 1", a `x-omniroute-combo-terminal-reason` of `tier_ceiling_no_targets`, and no calls.
        - flatten mode and round-robin: the same tiered fixture with `nestedComboMode` unset (flatten) under `strategy:"priority"`, and again with `strategy:"round-robin"`, at header 1, never calls a tier2+ model.
        - `strategy:"auto"` is not touched by this filter. Assert `applyTierCeilingToCombo` is bypassed, or just assert via a direct unit test of the helpers.
        - pure helpers: `resolveStepTier` covering the explicit, comboName, model-string, `-tierN` id and untiered cases; `resolveComboTierCeiling` covering absent, garbage, clamp and plain-record headers; `isGlobalFallbackAllowedForTier` returning `undefined`→true, 5→true, 1..4→false.
        - schema and normalizer: `comboRefStepInputSchema.parse({kind:"combo-ref", comboName:"x", tier:2}).tier === 2`, tier 6 is rejected, and `normalizeComboStep` keeps `tier`.
          Files: `$WT/tests/unit/combo-priority-tier-ceiling.test.ts`
          Verify: `cd $WT && npx cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo-priority-tier-ceiling.test.ts` and all cases pass.

- [ ]   6. Run the full verification for touched and related suites, typecheck, lint and format.
        - Tier and combo tests: `cd $WT && npx cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/combo-priority-tier-ceiling.test.ts tests/unit/services/requestTier.test.ts tests/unit/tier-*.test.ts tests/unit/combo-auto-tier.test.ts tests/unit/combo-runtime-unit-concurrency.test.ts tests/unit/combo-strategy-fallbacks.test.ts tests/unit/combo-config.test.ts tests/unit/combos-quota-protected.test.ts tests/unit/combo-hidden-leaf-routing.test.ts tests/unit/combo-routes-composite-tiers.test.ts tests/unit/composite-tiers-validation.test.ts`. All must pass.
        - Typecheck: `npm run typecheck:core` and `npm run typecheck:noimplicit:core` must both be clean.
        - Lint: `npm run lint`, with 0 errors and no new suppressions in `config/quality/eslint-suppressions.json`. `no-explicit-any` is an error in `open-sse/` and `tests/`.
        - Format: `npx prettier --check open-sse/services/combo/tierCeiling.ts open-sse/services/combo.ts src/sse/handlers/chat.ts src/lib/combos/steps.ts src/shared/validation/schemas/combo.ts tests/unit/combo-priority-tier-ceiling.test.ts`. Run `npx prettier --write` on those files if needed.
        - Optional wider net if time allows: `npm run test:unit`.
          Record every command and its pass/fail output in the verification note.

- [ ]   7. Menagerie header-propagation check. This is **read-only: do not modify anything under `/Users/celes/sources/celesrenata/menagerie/src`**. Put the findings in the verification note.
       Read `/Users/celes/sources/celesrenata/menagerie/src/api/providers/omniroute.ts` L26-53 and `/Users/celes/sources/celesrenata/menagerie/src/api/providers/openai.ts` L26-60, then confirm the following:
        - The header comes only from `omniRouteRequestHeaders(configuration)`, and only when `openAiIsOmniRoute === true` and `omniRouteTier` is an integer 1-5.
        - The global `omniRouteTier` gets injected into a profile only in `ClineProvider.getState()` (`/Users/celes/sources/celesrenata/menagerie/src/core/webview/ClineProvider.ts` ~L2943-2951), and only on the active `providerSettings`.
        - Parallel workers: `getTaskHandoffContext` (~L3409-3450) loads the mode's saved profile through `providerSettingsManager.getProfile({id})`, and `createTask` uses it verbatim via `getEffectiveTaskApiConfiguration` (`/Users/celes/sources/celesrenata/menagerie/src/core/task/providerHandoff.ts` L41-46). Nothing re-injects `omniRouteTier` there: the only non-test readers are omniroute.ts and ClineProvider.getState.
          Also confirm whether `Task` (constructor / `updateApiConfiguration`) or `buildApiHandler` re-merges global state, and whether saved profiles can carry a persisted `omniRouteTier` (check the save path in `/Users/celes/sources/celesrenata/menagerie/src/core/config/ProviderSettingsManager.ts`).
          **Preliminary finding to confirm or correct:** workers on saved-profile modes (omni-hybrid-reader, omni-hybrid-research) most likely do **not** send `X-OmniRoute-Tier`, unless a stale value got persisted into the stored profile. Workers that inherit the parent's configuration (no saved mode profile, or `lockApiConfigAcrossModes`) do carry it through `structuredClone(parent.apiConfiguration)`. If confirmed, the server fix alone will not stop worker escalation, because absent header = unchanged by design. Report this as a follow-up for menagerie and do not fix it here.
          Files: none modified
          Verify: the verification note lists file:line evidence for each conclusion.

- [ ]   8. Commit locally on `fix/priority-tier-ceiling` and never push. `git -C $WT add` the specific files from steps 1-5, then `git -C $WT commit -m "fix(combo): apply X-OmniRoute-Tier ceiling to non-auto combo steps"`. Don't create changesets or CHANGELOG edits.
       Verify: `git -C $WT status` is clean and `git -C $WT log --oneline -1` shows the commit.

## Assumptions and gaps

- Tier 4/5 still allow the Global Fallback only at 5. Tier 4 ("cloud/tiered") blocks it because the fallback model's cost is unclassified. This is the conservative choice; tell the user in the summary.
- Grandchild combo-refs inside an admitted pool are filtered in execute mode (through re-entry) but not in flatten mode. The current pools contain only model steps, so it doesn't matter today.
- Filtering shortens round-robin/weighted unit lists for that one request. rr counters stay keyed by `combo.name`, so rotation offsets may shift between ceiling and no-ceiling requests. That's acceptable.
- No dashboard UI for the explicit `tier` field. It's API/JSON only.
