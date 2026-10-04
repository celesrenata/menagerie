# Backend-aware `reasoning_effort` normalization for `ollama-local`

Commit `62c15ee22` on `feat/hybrid-reader-combo` registers an `ollama-local` provider entry so the qwen3.5/qwen3.8-family restricted thinking vocabulary (`low`/`medium`/`xhigh`, no `high`) becomes reachable by the forwarding-path clamp, which proactively rewrites `reasoning_effort: "high"` to `"xhigh"` before the request reaches the backend. This closes the live bug where those templates raise, Ollama wraps the error as HTTP 500, and the reactive 400/422-only learned-cap recovery never fires — tripping the connection unhealthy. The change also threads a cached operator-override lookup into the same clamp, removes a now-stale consistency allowlist entry, and documents family-aware override keying. The implementation tracks the APPROVED design (0 HIGH / 0 MEDIUM / 5 NIT) closely; I verified each of the six design-critical points against the actual source rather than the commit message.

Watch for: one cosmetic divergence from the design's Files-touched table — the dashboard helper text landed in `src/i18n/messages/en.json` rather than `ModelCapabilityOverridesTab.tsx` (confirmed, NIT, functionally equivalent and documented in verification.md). No blocking concerns.

**Verdict**: APPROVED

## High-level view

The registry entry mirrors `ollama-cloud`: `authType: "apikey"` (not `"optional"`), `passthroughModels: true`, `defaultSupportedThinkingEfforts: ["low","medium","xhigh"]`, and three bare-family opt-outs (`qwen3`, `qwen3-vl`, `gemma4`) carrying the standard `["none","low","medium","high"]` vocabulary. The `apikey` choice is the one that preserves today's resilience bucket byte-for-byte, which I confirmed against `getProviderCategory()`'s `authType === "apikey" ? "apikey" : "oauth"` branch and its `!entry` fallback.

The clamp wiring in `reasoningEffort.ts` is the heart of the fix and the place the prior review's double-defaulting HIGH was found. The implementation resolves vocabulary as override → model-level (exact id, then `:`-split family prefix via `getRegistryModelThinkingEfforts`) → provider default (`getRegistryEntry().defaultSupportedThinkingEfforts`), in that order. I verified `getRegistryModelThinkingEfforts` is exact-id-only and does not fold in the provider default, so the family-prefix probe is live rather than dead code — the opt-out families resolve to `high` and are not re-broken.

The operator override is read through `getCachedReasoningEffortsOverride()`, a cache-until-version-bump wrapper keyed off `getModelCatalogCacheVersion()`, not a per-request SQLite read. Only the two forwarding-path call sites pass it; `commandCode.ts` and the recovery re-invocation omit the optional argument and keep today's behavior.

Test coverage exercises the composed sanitizer end to end (not the registry helpers in isolation) across all six design cases, plus a cache-invalidation test that proves rebuild-on-write without manual invalidation. Verification evidence records the typecheck and every design-required suite as passing.

<details>
<summary>Issues (1)</summary>

1. **Helper-text file divergence (NIT)** — the design's Files-touched table lists `ModelCapabilityOverridesTab.tsx` for the override-keying helper text, but the change landed in `src/i18n/messages/en.json` (the i18n key the component renders). Functionally equivalent; no action required beyond awareness.

</details>

<details>
<summary>Details</summary>

### Registry entry mirrors `ollama-cloud`, `authType: "apikey"` preserves the resilience bucket

The new `open-sse/config/providers/registry/ollama-local/index.ts` declares `authType: "apikey"`, `authHeader: "bearer"`, `passthroughModels: true`, `defaultSupportedThinkingEfforts: ["low","medium","xhigh"]`, and the three opt-out model entries. I confirmed the design's resilience-bucket argument directly: `getProviderCategory()` (providerRegistry.ts:304-308) is `entry.authType === "apikey" ? "apikey" : "oauth"` with `if (!entry) return "apikey"`. So before this change `ollama-local` resolved to the apikey bucket via the `!entry` fallback, and `authType: "apikey"` keeps it there byte-for-byte. Had the entry used `"optional"` (the first-draft choice the prior review rejected), `getProviderCategory` would have moved every `ollama-local` connection to the oauth bucket — the exact resilience subsystem the bug's symptom touches. Registration is wired in `open-sse/config/providers/index.ts` (import + the `"ollama-local": ollama_localProvider` REGISTRY line).

### Clamp resolution order avoids the double-defaulting regression

This is the point the prior review's HIGH finding was about, so I traced it fully. `reasoningEffort.ts` now computes `ollamaFamilyId` by splitting on the first `:`, then resolves:

```
overrideEfforts  = override(exact) ?? override(family)
modelEfforts     = overrideEfforts ?? getRegistryModelThinkingEfforts(exact) ?? getRegistryModelThinkingEfforts(family)
declaredEfforts  = modelEfforts ?? getRegistryEntry(provider).defaultSupportedThinkingEfforts
```

The correctness hinges on `getRegistryModelThinkingEfforts` NOT folding in the provider default. I read it (providerRegistry.ts:193-201): it returns `model?.supportedThinkingEfforts` for an exact-id match only — no default fallback. `getRegistryThinkingEfforts` (the one that DOES fold the default) is deliberately not used in the clamp path. This means the family-prefix probe is live: `qwen3:14b-q4_K_M` misses the exact probe, matches the bare `qwen3` entry via the family probe, and resolves to `["none","low","medium","high"]` — so `high` is a native tier and passes through unchanged. `qwen3.8:27b-iq3-code144k` misses both model probes (no `qwen3.8` entry) and falls to the provider default `["low","medium","xhigh"]`.

The downstream nearest-tier clamp (lines 614-625) then does the rename for free: `declaredRanked = [low=2, medium=3, xhigh=5]`, requested `high` has rank 4, `find(rank >= 4)` returns `xhigh` (rank 5). No new clamp algorithm was added, exactly as the design predicted. The branch is gated by `declaredRanked.length > 0`, so providers with no declared vocabulary (e.g. `openai`) skip it entirely and are unaffected.

### Cached override, not a per-request SQLite read

`getCachedReasoningEffortsOverride()` in `src/lib/db/modelCapabilityOverrides.ts` builds a `provider → modelId → value` map from `listModelCapabilityOverrides()` filtered to `reasoning_efforts`, caches it, and rebuilds only when `getModelCatalogCacheVersion()` differs from the cached version. Writes go through `setModelCapabilityOverride`/`removeModelCapabilityOverride`, which already call `invalidateDbCache("model-capabilities")` → bumps the catalog version, so the cache self-invalidates on write with no new signal. The getter delegates to the existing `getReasoningEffortsOverride(provider, modelId, bulk)` with the cached map as the `bulk` argument, so the lookup semantics (including family/exact keying handled by that function) are unchanged. The existing `getReasoningEffortsOverride` signature is untouched — purely additive.

Only `base.ts:902` and `targetRequestSanitizer.ts:97` pass `getCachedReasoningEffortsOverride` as `overrideLookup`. `commandCode.ts:1060` and `reasoningEffortRecovery.ts:102` omit the optional argument, preserving today's behavior and carrying no regression risk for those paths.

### Stale consistency allowlist removed

`scripts/check/check-provider-consistency.ts` drops the `"ollama-local"` line from `KNOWN_CATALOG_ONLY`. Once `ollama-local` is in REGISTRY, `findCatalogOnlyLlmProviders()` excludes it before the allowlist is consulted, so leaving the line would have been dead/misleading documentation rather than a gate failure. verification.md records `check-provider-consistency.test.ts` (11 tests) still green, confirming the "covers every live llm provider without REGISTRY entry" assertion holds after the removal.

### Test coverage maps to all six design cases

`tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts` calls the composed `sanitizeReasoningEffortForProvider` end to end for: (a) `high→xhigh` provider-default path (qwen3.8 and qwen3.5); (b) opt-out families `qwen3`/`qwen3-vl`/`gemma4` keeping `high` via the family-prefix probe; (c) `low`/`medium` passthrough; (d) `ollama-cloud` colon-id no-op regression guard (both the registry-helper assertions and the composed-sanitizer passthrough); (e) `openai` unaffected, `high` stays `high`; (f) operator override family-aware (bare `qwen3.8` matches full tag) and exact-tag form. The opt-out test deliberately uses full Ollama tags against bare-family registry ids, which is precisely the regression the prior HIGH would reintroduce — a future double-default refactor fails here immediately.

`tests/unit/model-capability-overrides.test.ts` adds the cache test: it writes an override, reads twice while spying on the DB handle's `prepare()` to assert zero SQLite statements on the second read, then writes a changed value and asserts the next read reflects it with no manual invalidation — proving the version-signal rebuild. The `prepare()` spy uses a documented `as unknown as` double-assertion with a comment explaining no typed alternative exists.

### Verification evidence

verification.md records `npm run typecheck:core` PASS (exit 0), and these suites run via `node --test`/tsx: the new ollama-local test + ollama-cloud tiers + model-capability-overrides (18 pass), check-provider-consistency (11 pass), a 7-file regression sweep covering the clamp/split/learned-caps/direction-consistency/ollama-local-provider/routing/default-effort tests (66 pass), and i18n parity for the touched `en.json` (74 pass). ESLint is clean on all authored/edited files; the reported unused-import errors in `base.ts` and `ModelCapabilityOverridesTab.tsx` are on untouched lines pre-existing on HEAD (the evidence states this was verified against `git show HEAD`), so no suppression counts increased. The bun-runner `check:provider-consistency` was skipped for environment reasons with equivalent node-test coverage noted. This is sufficient evidence; I did not re-run anything.

### Divergence from the design's Files-touched table (NIT)

The design lists `src/app/(dashboard)/dashboard/settings/components/ModelCapabilityOverridesTab.tsx` for the helper-text change. The implementation instead edited `src/i18n/messages/en.json`'s `modelOverrideReasoningEffortsPlaceholder` key (the string the component renders), appending the exact-tag-or-family keying note. This is the same user-visible outcome through the correct i18n layer, is documented in verification.md, and the i18n parity suites were run. Cosmetic, non-blocking.

</details>

<details>
<summary>File map</summary>

- `open-sse/config/providers/registry/ollama-local/index.ts` — **new** registry entry (apikey, passthrough, `["low","medium","xhigh"]` default, qwen3/qwen3-vl/gemma4 opt-outs).
- `open-sse/config/providers/index.ts` — import + REGISTRY registration.
- `open-sse/executors/base/reasoningEffort.ts` — override→model(exact,family)→provider-default resolution; optional `overrideLookup` param.
- `open-sse/executors/base.ts` — pass `getCachedReasoningEffortsOverride` to sanitizer.
- `open-sse/services/targetRequestSanitizer.ts` — pass `getCachedReasoningEffortsOverride` to sanitizer.
- `src/lib/db/modelCapabilityOverrides.ts` — **new** `getCachedReasoningEffortsOverride()` cache-until-version-bump.
- `scripts/check/check-provider-consistency.ts` — remove stale `ollama-local` KNOWN_CATALOG_ONLY entry.
- `src/i18n/messages/en.json` — helper-text copy for family/exact override keying (design named `ModelCapabilityOverridesTab.tsx`; same outcome via i18n).
- `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts` — **new** end-to-end sanitizer coverage (cases a–f).
- `tests/unit/model-capability-overrides.test.ts` — cache/invalidation test.

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute show 62c15ee22`

</details>
