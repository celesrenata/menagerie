# X-OmniRoute-Tier ceiling for non-auto combo strategies

Before this change, a valid `X-OmniRoute-Tier: N` header only took effect for `auto` combos. Priority, fallback and round-robin combos (including `hybrid/*`) walked their steps in order and escalated into `pool/tier2..5/*` whenever the local tiers were busy. The fix filters `combo.models` once, in `handleComboChatInner`, before `createComboContext`, so every downstream dispatch path only sees steps whose tier is at or below the ceiling. A step's tier comes from an explicit `tier` field (new and optional in both the schema and the normalizer), then from a `tierN` path segment in the referenced combo or model name, then from a `-tierN` step-id suffix. Steps with no derivable tier are admitted. The #689 global fallback is also gated, because its model is unclassified and was a second escalation route.

Watch for: the server fix only takes effect when the header actually arrives. The coder's read-only check found that menagerie parallel workers whose modes use a saved profile do not send `X-OmniRoute-Tier` (likely). Those workers keep the old escalation behavior until the client is fixed. The zero-admitted 503 carries no `Retry-After` (confirmed, minor). Flatten mode does not re-filter grandchild combo-refs (confirmed, documented, and inert with today's pools).

**Verdict**: APPROVED

## High-level view

The filtering happens at a single chokepoint. `combo.strategy` is normalized the same way `comboSetup.ts` normalizes it, and `auto` is skipped because FEAT-005 already enforces the ceiling inside the auto engine. The filter runs before pinned dispatch, the runtime-unit loop and flatten target resolution, so none of those paths can reach an excluded step. That includes a stale context pin to a tier-5 model, which now falls out of `resolveComboTargets`. Nested combo-refs in execute mode re-enter `handleComboChat` with the same `relayOptions` and `requestHeaders`, so each nesting level re-applies the ceiling. The outer step pointing at `pool/tierN/...` acts as the gate.

The ceiling comes from `relayOptions.tierCeiling`, falling back to the raw `x-omniroute-tier` header. The header fallback covers the safety-net redirect, which passes `relayOptions: undefined`. Both sources go through the existing `resolveRequestTier`, so garbage, out-of-range and absent values all mean no ceiling. `defaultTier` is never applied implicitly, and `maximumTier` only clamps a ceiling the client actually sent. This matches the FEAT-005 contract and the spec.

When filtering leaves zero steps, the handler records a failed combo metric and returns a 503 with `terminalReason: tier_ceiling_no_targets`. When admitted steps exist but all fail or hit capacity, the existing runtime-unit loop returns the last local error without touching higher tiers. The global fallback is skipped for any ceiling from 1 to 4. Both behaviors follow the requirement to return a retryable error instead of escalating.

The tests drive `handleComboChat` with a stubbed `handleSingleModel` against a realistic five-tier pool fixture, and they cover every case the spec requires. The 15 tests pass, and so do 291 tests in adjacent suites. Typecheck and lint are clean apart from baseline noise that the coder showed exists without this change.

<details>
<summary>Issues (4)</summary>

1. **Parallel workers don't send the header** (likely, out of this diff's scope): saved-profile menagerie workers omit `X-OmniRoute-Tier`, so the user's "zoo is tier 1 but fails over to paid" symptom can persist for `parallel_tasks` workers. Follow up in menagerie: inject the live global `omniRouteTier` in `getTaskHandoffContext` or `runParallelTasks`, and stop persisting it in `saveConfig`.
2. **No Retry-After on the tier-ceiling 503** (confirmed, minor): `errorResponseWithComboDiagnostics(503, …, { code })` passes no `retryAfter`, so clients only see a bare 503. Consider adding a short `retryAfter`, because the actual cause is usually local-tier saturation.
3. **Flatten-mode grandchild refs not re-filtered** (confirmed, documented): a tiered combo-ref nested inside an admitted pool escapes the ceiling in flatten mode. This is inert with today's model-only pools. Add a note or test if pools ever gain refs.
4. **Busy path tested via a 503 stub, not real capacity** (possible): tier-1 failure is simulated with a 503 from `handleSingleModel`, not the runtime-unit concurrency cap the user actually hit. The two share the same loop, so the risk is low. A capacity-cap case would pin the real symptom.

</details>

<details>
<summary>Details</summary>

### Single chokepoint and strategy coverage

```
chat.ts ─ relayOptions{tierCeiling} + requestHeaders
   └─ handleComboChat → handleComboChatInner
        ├─ strategy != auto → resolveComboTierCeiling → applyTierCeilingToCombo
        │     ├─ excluded → log.debug("tier ceiling N … excluded steps: id(tier T)")
        │     └─ 0 kept   → recordComboRequest(fail) + 503 tier_ceiling_no_targets
        └─ createComboContext(filtered combo) → pinned / runtime-unit / flatten / rr …
              └─ combo-ref (execute) → handleComboChat(pool/tierN/…)  [ceiling re-applied]
```

The filtered combo keeps its `name` and `id`. As a result, round-robin counters, combo metrics and traces stay keyed the same way, and the `chat.ts` `recordRejectedRequestUsage` block still writes call_logs for the new 503. `applyTierCeilingToCombo` returns the original object when nothing is excluded, so an untiered combo with a header follows exactly the same path as before. Entries that can't be normalized are kept, which is the fail-open choice that preserves today's behavior for malformed configs.

### Tier derivation edge cases

`TIER_SEGMENT_RE` requires `tierN` to be a whole path segment, so names like `gpt-tier5x` or `mytier2` do not misclassify. A digit outside 1-5 counts as untiered and is admitted. That fails open, which matches the spec's "no derivable tier => admitted" rule. The explicit `tier` field is validated twice: `z.number().int().min(1).max(5)` in the schema and `toTier` in the normalizer. String-form steps can't carry an explicit tier and rely on name derivation, which works for `pool/tierN/...` refs.

### Global fallback gating

The #689 global fallback ran `settings.globalFallbackModel` on any combo 502/503 with no tier awareness. The new predicate blocks it for ceilings 1-4 and logs `Global fallback skipped … tier ceiling N` at info level. The predicate reads `perRequestAutoControls.tierCeiling`, which comes from the request headers, so it covers both the normal and the safety-net paths. Tier 5 and a missing header behave as before.

### Client-side gap (menagerie)

This diff guarantees enforcement only when the header is present, by design. The coder traced `runParallelTasks` → `getTaskHandoffContext(…, preferSavedModeProfile=true)` → `structuredClone(savedModeProfile.apiConfiguration)`. That path never goes through `getState()`, which is the only place the global `omniRouteTier` gets injected. Workers for modes with saved profiles (omni-hybrid-reader, omni-hybrid-research) therefore send no header, unless a stale snapshot was persisted into the profile. This is likely the remaining source of the user's paid-provider failover for parallel work, and it needs a separate menagerie change.

### Test coverage

All the required cases are covered by end-to-end `handleComboChat` tests:

- Tier-1-only, never reaching tier 2+ even when tier 1 returns 503, with the debug log naming the excluded steps.
- Tier 3 admits tiers 1-3 and returns 503 when all three fail, without touching 4 or 5.
- No header escalates to tier 5, as today.
- Garbage values (`"abc"`, 9, 0, and a header of `"7"`) behave like no header.
- Untiered model and combo-ref steps are admitted.
- `maximumTier: 2` clamps a header of 4.

The tests go further than required:

- Ceiling supplied through headers only.
- Explicit `tier` taking precedence over the name.
- The zero-admitted 503 and its terminal-reason header.
- Priority/flatten, round-robin (flatten and execute) and fallback/execute.
- `auto` not being filtered.
- Pure-helper tests and schema/normalizer round-trips.

Not tested:

- Busy-at-capacity as the cause of tier-1 failure (it is simulated with a 503).
- DB readback of call_logs and combo metrics for the 503. The coder verified this by reading the code.
- The global-fallback skip at the `chat.ts` integration level. Only the predicate is unit-tested.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo.ts`: ceiling filter, debug log, zero-admitted 503 and metric in `handleComboChatInner`.
- `open-sse/services/combo/tierCeiling.ts`: new module with `resolveStepTier`, `resolveComboTierCeiling`, `applyTierCeilingToCombo` and `isGlobalFallbackAllowedForTier`.
- `open-sse/services/combo/types.ts`: `tierCeiling` field on `ComboRelayOptions`.
- `src/lib/combos/steps.ts`: optional `tier` on step types, carried through `normalizeComboStep`.
- `src/shared/validation/schemas/combo.ts`: optional `tier` (int 1-5) in the step meta schema.
- `src/sse/handlers/chat.ts`: global fallback gated by the tier ceiling, with an info log.
- `tests/unit/combo-priority-tier-ceiling.test.ts`: 15 new tests.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute/.worktrees/priority-tier-ceiling diff feat/hybrid-reader-combo...fix/priority-tier-ceiling`

</details>
