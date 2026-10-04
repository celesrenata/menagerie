# Verification — Backend-aware reasoning_effort normalization for ollama-local

Repo: `/Users/celes/sources/celesrenata/OmniRoute`
Branch: `feat/hybrid-reader-combo`
Iteration: FIRST (no `review.json` present at start)

## Git state

- HEAD before: `c9230dee86dd396058500819c5b2589a42e43548`
  (`fix(api): clamp pagination limit instead of 400, log silent combo-row drops`)
- Working tree was clean at start; no uncommitted reasoning-effort changes.
  Prior session commits (combos pagination 3.8.53, FEAT-002/004/005) left intact.

## Files changed

New:

- `open-sse/config/providers/registry/ollama-local/index.ts` — registry entry (authType "apikey",
  defaultSupportedThinkingEfforts ["low","medium","xhigh"], per-model opt-outs qwen3 / qwen3-vl / gemma4).
- `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts` — end-to-end sanitizer coverage.

Modified:

- `open-sse/config/providers/index.ts` — import + REGISTRY registration of `ollama_localProvider`.
- `open-sse/executors/base/reasoningEffort.ts` — corrected model-first-then-provider-default lookup
  (getRegistryModelThinkingEfforts exact then `:`-split family-prefix, then getRegistryEntry default);
  added optional `overrideLookup` param probed exact-then-family, winning over static.
- `src/lib/db/modelCapabilityOverrides.ts` — new `getCachedReasoningEffortsOverride()` (cache-until-
  version-bump over getReasoningEffortsOverride, invalidated via getModelCatalogCacheVersion()).
- `open-sse/executors/base.ts` — pass `getCachedReasoningEffortsOverride` into the sanitizer.
- `open-sse/services/targetRequestSanitizer.ts` — pass `getCachedReasoningEffortsOverride` into the sanitizer.
- `scripts/check/check-provider-consistency.ts` — removed now-stale `ollama-local` KNOWN_CATALOG_ONLY entry.
- `src/i18n/messages/en.json` — helper-text update for the reasoning_efforts override placeholder
  (document exact-tag OR bare-family keying for Ollama-shaped ids). Value-only change, no key added.

## Commands run and results

### Typecheck

`npm run typecheck:core` (tsc -p tsconfig.typecheck-core.json)
→ PASS, exit 0, no diagnostics.

### Targeted unit tests (node --test via tsx)

Runner prefix:
`DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit <files>`

1. `ollama-local-reasoning-effort-qwen35-qwen38.test.ts` + `ollama-cloud-reasoning-effort-tiers-10788.test.ts` + `model-capability-overrides.test.ts`
   → tests 18, pass 18, fail 0. (Covers: high→xhigh default path; low/medium passthrough; qwen3/qwen3-vl/gemma4 opt-outs keep high; openai not regressed; override family-aware + exact-tag; override cache rebuilds only on write; ollama-cloud no-op.)

2. `check-provider-consistency.test.ts`
   → tests 11, pass 11, fail 0. ("KNOWN_CATALOG_ONLY covers every live llm provider without REGISTRY entry" still green after removing the ollama-local allowlist line.)

3. Regression sweep: `base-reasoning-effort-split`, `learned-reasoning-effort-caps`, `reasoning-effort-clamp-and-retry`, `reasoning-effort-clamp-direction-consistency`, `ollama-local-provider`, `ollama-local-capabilities-routing`, `default-reasoning-effort-6879`
   → tests 66, pass 66, fail 0.

4. i18n (en.json touched): `i18n-translation-ratio-gate.test.ts`, `i18n-locale-surfaces-parity.test.ts`
   → tests 74, pass 74, fail 0.

### ESLint

`npx eslint --max-warnings=0 <edited files>`
→ All files I authored/edited are clean (ollama-local/index.ts, reasoningEffort.ts, targetRequestSanitizer.ts,
modelCapabilityOverrides.ts, providers/index.ts, the two test files).
→ Pre-existing (NOT introduced by this change, present on HEAD) unused-import errors reported in
`open-sse/executors/base.ts` (supportsClaudeMaxEffort, supportsXHighEffort, getRotatingApiKey,
getValidApiKey, unused `health` arg) and `ModelCapabilityOverridesTab.tsx` (PricingCatalogModel) — all on
lines not touched by this change; verified against `git show HEAD`. No suppression counts increased.
→ `scripts/check/check-provider-consistency.ts` is in an eslint ignore pattern (warning only).

### Skipped

- `npm run check:provider-consistency` (bun runner) — bun postinstall not available in this environment;
  equivalent coverage provided by the passing `check-provider-consistency.test.ts` node test above.
- Live Jinja-template behavior — infra, out of scope per design (confirmed earlier via curl in the bug investigation).
