# Final report: X-OmniRoute-Tier ceiling for non-auto combos

## Problem

Zoo is set to tier 1, but `hybrid/*` priority combos still fell over to paid tier 2+ pools such as openai, mistral and bedrock. The cause was that the `X-OmniRoute-Tier` ceiling was only applied to the `auto` strategy.

## Fix

- The OmniRoute commit is `d5de1f49e`, "fix(combo): apply X-OmniRoute-Tier ceiling to non-auto combo steps". It is on `feat/hybrid-reader-combo`, which was fast-forwarded to it. Nothing was pushed.
- When a valid header 1-5 is present, priority, round-robin and fallback combos only admit steps whose tier is at or below the ceiling. The tier is taken from an explicit `tier` field or from the step name.
- `tierRouting.maximumTier` clamps the ceiling.
- If no step is admitted, the request returns 503 with `x-omniroute-combo-terminal-reason: tier_ceiling_no_targets`.
- With no header or an invalid one, behavior is unchanged.
- For ceilings 1-4, the global fallback is skipped.

## Tests (see verification.md)

- Before the rebase: the new suite passed 15/15, the tier and combo suites 163/163, and the extra chat, combo and hybrid suites 128/128.
- After the rebase onto `bc64a1293`: the tier, combo and hybrid suites passed 183/183. Full `npm run test:unit` had 44939 of 44989 tests pass and 21 fail. All 21 failures are pre-existing or flaky:
    - 20 fail identically on the baseline. They are build, packaging and CLI tests.
    - 1 is a flaky usage_history race, `#13459`.
- `typecheck:core` passed clean.
- eslint and prettier were clean on the touched files, and suppression counts were unchanged.

## Deploy (see deploy-report.md)

- Image: `registry.celestium.life/library/omniroute:3.8.58-priority-tier-ceiling-20261003`.
- Digest: `sha256:74f472d369c1c471a3eec6075c75f9a7db4862488ebbf6ae5cf374543148b1f6`.
- Kube commit: `603182e`, not pushed.
- Pod `omniroute-7fdccb8f64-5pvpc` is running that digest.

## Live verification (see live-verification.md)

- With `X-OmniRoute-Tier: 1`, `hybrid/reader` returned HTTP 200, served by `qwen3.5-reader:9b` on ollama at $0 cost.
- The call_logs step for that request was `reader-t1-1`. No row after the deploy has a tier2+ step.
- Before the deploy, the same day's logs show `hybrid/reader` going to tier2 openai (25 rows) and tier3 bedrock (1 row).
- Without the header, the request returned HTTP 200 through normal priority order (tier 1 was healthy) and the ceiling was not applied.
- No-header escalation when tier 1 fails was not forced live. The unit tests and the pre-deploy logs cover it.
- The post-deploy sample is small: 2 combo requests.

## Remaining gap: Zoo parallel_tasks workers

Workers whose mode has a saved profile (omni-hybrid-reader, omni-hybrid-research) do NOT send `X-OmniRoute-Tier`. The exception is a saved profile that has a stale `omniRouteTier` persisted in it.

- `getTaskHandoffContext(..., preferSavedModeProfile=true)` clones the saved profile verbatim.
- The global tier is injected only in `ClineProvider.getState()`.

Without the header, those workers keep the old behavior and can still escalate to paid tiers. The suggested menagerie follow-up, which is not done:

- Inject the live global `omniRouteTier` into OmniRoute worker configs in `getTaskHandoffContext` or `runParallelTasks`.
- Stop persisting `omniRouteTier` in `saveConfig`.
