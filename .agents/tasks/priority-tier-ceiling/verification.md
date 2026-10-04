# Verification: priority-tier-ceiling (iteration 1)

Worktree: `/Users/celes/sources/celesrenata/OmniRoute/.worktrees/priority-tier-ceiling` (branch `fix/priority-tier-ceiling`). All commands ran with `cwd` set to the worktree.

## Tests

Common prefix: `npx cross-env DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit`

1. New file: `<prefix> tests/unit/combo-priority-tier-ceiling.test.ts` gave 15 tests, 15 pass, 0 fail.
2. Touched files plus tier and combo suites: `<prefix> tests/unit/combo-priority-tier-ceiling.test.ts tests/unit/services/requestTier.test.ts tests/unit/tier-*.test.ts tests/unit/combo-auto-tier.test.ts tests/unit/combo-runtime-unit-concurrency.test.ts tests/unit/combo-strategy-fallbacks.test.ts tests/unit/combo-config.test.ts tests/unit/combos-quota-protected.test.ts tests/unit/combo-hidden-leaf-routing.test.ts tests/unit/combo-routes-composite-tiers.test.ts tests/unit/composite-tiers-validation.test.ts tests/unit/combo-quota-exhaustion-option-schema.test.ts` gave 163 tests, 163 pass, 0 fail, 0 cancelled.
3. Extra coverage for chat.ts, the step normalizer and the hybrid combo: `<prefix> tests/unit/chat-route-coverage.test.ts tests/unit/combo-account-allowlist-3266.test.ts tests/unit/combo-routing-engine.test.ts tests/unit/combo/hybrid-reader-combo.test.ts tests/unit/combo-forecast.test.ts tests/unit/route-explainability.test.ts` gave 128 tests, 128 pass, 0 fail.

The full `npm run test:unit` suite was not run.

What the new tests cover:

- A priority combo with tier1..5 combo-ref steps at header tier 1 calls only the tier-1 model, even when it fails (503). The debug log names `hybrid-reader-tier2..5`.
- Tier 3 admits tiers 1-3. With 1-3 all failing it returns 503 and never tries 4 or 5.
- With no header, the request escalates to tier 5 (unchanged behavior).
- Garbage values ("abc", 9, 0, and a header of "7") behave exactly like no header.
- A ceiling passed only through `requestHeaders` (the safety-net path) is honored.
- Untiered model and combo-ref steps are admitted.
- An explicit `tier` on a step takes precedence over the name.
- `maximumTier: 2` clamps a header of 4 down to tiers 1-2.
- When zero steps are admitted, the response is 503 with `x-omniroute-combo-terminal-reason: tier_ceiling_no_targets`, a message containing "tier 1", and no calls.
- Priority/flatten, round-robin/flatten, round-robin/execute and fallback/execute never call a tier-2+ model.
- `auto` is not filtered.
- Pure helper tests, plus schema and normalizer `tier` round-trip.

## Typecheck

- `npm run typecheck:core` passes with 0 errors.
- `npm run typecheck:noimplicit:core` reports 1 error: `open-sse/services/combo/autoStrategy.ts(519,55) TS7006`. This error predates this change: the same error appears on the baseline with the change stashed, and the file is untouched.

## Lint / format

- `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0` on all 7 touched files: 0 errors, 0 warnings.
- `npm run lint` exits 2 with the single message "There are suppressions left that do not occur anymore". The baseline (`git stash -u`) shows the identical message and exit code, so this is not caused by the change. I did not prune because that would be unrelated cleanup.
- `npx eslint . --cache ... --pass-on-unpruned-suppressions` exits 0, with 0 lint errors repo-wide.
- Suppression counts did not increase. `config/quality/eslint-suppressions.json` is unmodified. `src/sse/handlers/chat.ts` still has only `no-unused-vars: 8`. The new chat.ts code uses a typed `{ globalFallbackModel?: unknown }` read instead of `as any`.
- `npx prettier --check` on all touched files: clean.

## call_logs / combo metrics

- When zero steps are admitted, the code calls `recordComboRequest(combo.name, null, { success:false, strategy })` before returning the 503. `src/sse/handlers/chat.ts` still records call_logs and usage_history for every `!response.ok` combo response (`recordRejectedRequestUsage` block, unchanged).
- The filtered combo keeps its original `name`/`id`, so metrics, round-robin counters and traces stay keyed the same way. When admitted steps all fail, the existing runtime-unit loop records metrics as it does today.
- Checked by reading the code. No test reads back the DB rows.

## Residual notes

- Global fallback (#689) is blocked for any ceiling 1-4 (`Global fallback skipped ... tier ceiling N` at info level), because the fallback model's tier is unclassified. Tier 5 and no header keep today's behavior.
- In flatten mode, grandchild combo-refs inside an admitted pool are not re-filtered. In execute mode they are, through re-entry. The current pools contain only model steps.

## Menagerie read-only check: do parallel_tasks workers send X-OmniRoute-Tier?

Finding: **No for workers whose mode has a saved profile** (omni-hybrid-reader, omni-hybrid-research), unless the stored profile happens to have a stale `omniRouteTier` persisted in it. Workers that inherit the parent's configuration (no saved profile for the mode, or `lockApiConfigAcrossModes`) do send it.

Evidence:

- `src/api/providers/omniroute.ts:33-43`: `omniRouteRequestHeaders()` emits the header only when `isOmniRoute(configuration)` (openai with `openAiIsOmniRoute === true`) and `configuration.omniRouteTier` is an integer 1-5. `src/api/providers/openai.ts:~48-53` spreads it into the client's default headers from `this.options`, which is the task's `apiConfiguration`.
- `src/core/webview/ClineProvider.ts:2945-2951`: the global `omniRouteTier` is copied onto `providerSettings` only inside `getState()`, and only for the active profile from `contextProxy.getProviderSettings()`. No other non-test code writes it. A grep of `src/core/task` and `src/api/index.ts` finds nothing, so neither `Task` nor `buildApiHandler` re-merges it.
- `src/core/task/runParallelTasks.ts:44`: each worker calls `provider.getTaskHandoffContext(parent, spec.mode, true)` with `preferSavedModeProfile=true`.
- `src/core/webview/ClineProvider.ts:3406-3445`: when the mode has a saved config id and `lockApiConfigAcrossModes` is off, it loads `providerSettingsManager.getProfile({ id })` verbatim. `src/core/task/providerHandoff.ts:12-29` then returns `structuredClone(savedModeProfile.apiConfiguration)`. `createTask` uses it unchanged via `getEffectiveTaskApiConfiguration` (`providerHandoff.ts:41-46`, `ClineProvider.ts:3509-3512`). No `getState()` injection happens on this path.
- Persisted value: `ProviderSettingsManager.saveConfig` (`src/core/config/ProviderSettingsManager.ts:428-447`) parses with `discriminatedProviderSettingsWithIdSchema`. `omniRouteTier` is a field of the openai provider schema (`packages/types/src/provider-settings/openai.ts:112`), so a profile saved from a `providerSettings` that carried the injected global value keeps a frozen snapshot of it. Whether the user's stored worker profiles contain one could not be verified, because it lives in VS Code secret storage.
- Fallback branch: `providerHandoff.ts:31-36` returns `structuredClone(parent.apiConfiguration)`, which carries the parent's injected tier.

Consequence: the server fix stops escalation only for requests that carry the header. Because an absent header means unchanged behavior by design, saved-profile parallel workers can still escalate. Follow-up for menagerie, not fixed here: inject the live global `omniRouteTier` into OmniRoute worker configurations in `getTaskHandoffContext` or `runParallelTasks`, and stop persisting it in `saveConfig`.

# Post-rebase verification (integration)

- `git fetch origin` ran. `feat/hybrid-reader-combo` was at `bc64a1293` (the Arc topology commit, "show Arc embedding/audio nodes in topology with live active state").
- `fix/priority-tier-ceiling` rebased onto it cleanly, with no conflicts. The fix commit is now `d5de1f49e`. The topology commit touches dashboard files and the fix touches `open-sse/services/*`, `src/lib/combos/steps.ts`, `src/shared/validation/schemas/combo.ts`, `src/sse/handlers/chat.ts` and tests, so the two don't overlap.
- `feat/hybrid-reader-combo` was fast-forwarded (`merge --ff-only`) to `d5de1f49e`. Nothing was pushed.
- All commands below ran in the worktree at `d5de1f49e`. The baseline is `bc64a1293`, checked out detached in the same worktree and then restored.

## Tier and combo suites

The iteration-1 tier and combo set plus `chat-route-coverage` and `combo/hybrid-reader-combo` gave 183 tests, 183 pass, 0 fail, 0 cancelled.

## Full `npm run test:unit`

44989 tests: 44939 pass, 21 fail, 0 cancelled, about 1021s. The 21 failures are in 20 files: tests/unit/api/v1/relay-completions-errors, binaryManager, build/build-tool-runner-win-shim, build/colocate-standalone-esm-scope, build/mitm-server-bundle-contents, call-log-file-rotation, check-provider-asset-provenance, cli-companion-types, cli-runtime-detection, cli-setup-opencode-nested-alias-7682, cli/alias-resolver-12073, client-bundle-no-server-only-10692, db-health-packaging, mcp/bundle-no-sync-esm-await, provider-node-reserved-prefix, provider-translate-path-golden, run-eslint-json-suppressions, tls-profiles-valid-5591 (.mjs), tsx-runtime-transform-5757, usage-history-provider-alias-13459.

None of these failures is caused by the change. The same 20 files were run on baseline `bc64a1293`:

- 20 of the 21 failures fail identically there. They are build/packaging, esbuild/tsx, CLI-environment, provider-registry and asset-manifest checks, and none of them touch combo routing.
- The remaining one, `#13459 saveRequestUsage stores the canonical provider id for an alias`, passed in that baseline batch but is flaky. Run alone on the baseline it gave fail, pass, pass. It also failed once alone post-rebase. It fails as a race in the usage_history row count (`n: 1` vs expected `n: 2`), and the 7 touched files have nothing to do with usage_history.

## Typecheck

- `npm run typecheck:core` exits 0 with 0 errors.
- `npm run typecheck:noimplicit:core` reports only the error that predates this change, `open-sse/services/combo/autoStrategy.ts(519,55) TS7006`, in a file this change doesn't touch.

## Lint / format

- `eslint --max-warnings=0` on the 7 touched files: no output, so clean. `prettier --check` on them: clean.
- `npm run lint` exits 2 with the same "suppressions left that do not occur anymore" message seen before the change. The same command with `--pass-on-unpruned-suppressions` exits 0. `config/quality/eslint-suppressions.json` is unchanged.
