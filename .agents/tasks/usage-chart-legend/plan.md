# Implementation Plan — "Model Usage Over Time" legend cleanup + /dashboard/cache 500

Repo: `/Users/celes/sources/celesrenata/OmniRoute` (branch `feat/hybrid-reader-combo`, HEAD `1d48e1cfd`,
live image `3.8.63-context-estimate-20261003`). Always use absolute paths; the shell's default cwd is the
`menagerie` workspace, not the OmniRoute repo. Commit locally only; never push.

## What exploration found

- Chart: `ModelOverTimeChart` / `ModelOverTimeChartBody` in
  `src/shared/components/analytics/rechartsUsageCharts.tsx` (lines ~218-310). It renders one stacked
  `<Area>` per entry of `modelNames` and a legend of every model, colored by `getModelColor(index)`
  (`src/shared/constants/colors.ts`, index-based, so colors shift whenever ordering changes).
  Rendered from `src/shared/components/UsageAnalytics.tsx:417` (`/dashboard/analytics` overview tab) with
  `dailyByModel={analytics?.dailyByModel} modelNames={analytics?.modelNames}`.
- Data builder: `GET /api/usage/analytics` (`src/app/api/usage/analytics/route.ts:568-595, 888-911`).
  Per row of `getDailyCostRows()` (`src/lib/db/usageAnalytics.ts:135`, `usage_history` UNION
  `daily_usage_summary`), tokens = `promptTokens + completionTokens` (i.e. `tokens_input + tokens_output`;
  cache/reasoning are not added), keyed by `normalizeModelName(model)` (`src/lib/usage/costCalculator.ts:21`,
  strips everything up to the last `/`). The response returns EVERY model in the window and fills 0 for
  each date. Live 30d: 173 model names, 99 of them with 0 tokens (combo names such as `5090`, `m5max`,
  `4070ti`, `reader`, rejected-request rows, Mistral catalog ids, embed models); top 8 = 91% of tokens.
- Non-inference markers in the codebase: `connection-test` (`src/app/api/providers/[id]/test/route.ts:1178`)
  and `model-sync` (`src/app/api/providers/[id]/sync-models/route.ts`) are written to `call_logs`, and
  `src/app/(dashboard)/home/HomeRecentRequests.tsx::isConnectionTestRow` already filters them client-side.
  They should not normally reach `usage_history`, but we exclude them defensively in the chart.
- Embeddings: `/v1/embeddings` (`src/lib/embeddings/service`) does not write `usage_history`, so arc-embed
  never appears; embed ids that do appear (`codestral-embed`, `mistral-embed`, ...) have 0 tokens.
- Canonical model-id helper: none suitable exists (see Decision 3), so no alias collapsing.
- localStorage prefs pattern exists: `pref:<area>:<name>` keys read in a lazy `useState` initializer with a
  `globalThis.window === undefined` guard and try/catch (`src/shared/components/RequestTimeline.tsx:68-88`,
  `src/shared/components/RequestLoggerDetail.sections.tsx:200-258`).
- Tests: node:test + tsx for pure logic (`tests/unit/shared/*.test.ts` is in the `test:unit` glob); Vitest +
  jsdom for components (`tests/unit/**/*.test.tsx`, see `tests/unit/ui/analytics-token-hover-tooltip.test.tsx`
  for the `next-intl` mock). `tests/unit/shared/analytics-recharts-lazy.test.ts` asserts no analytics file
  imports `recharts` directly; the new module must not either.
- i18n: `src/i18n/messages/en.json` is the source of truth (`analytics` namespace, 311 keys); 67 locales.
  `npm run i18n:sync-ui` backfills missing keys as `__MISSING__:<english>` (runtime falls back to English,
  per `scripts/i18n/check-ui-value-drift.mjs`); `npm run i18n:check-ui-coverage` is the gate.
- Lint suppressions: `config/quality/eslint-suppressions.json` has `rechartsUsageCharts.tsx` at 1
  `no-unused-vars`; counts must not increase.
- Cache page: with the Bearer management key, headless Chromium (Playwright from the repo's
  `node_modules`, executable `~/Library/Caches/ms-playwright/chromium_headless_shell-1243/...`) loads
  `/dashboard/cache` with 200, and the Prompt / Semantic / Reasoning tabs all render with no `pageerror`.
  The only console errors were unrelated (news.json CORS, `wss://...:20132/live-ws` refused). So the
  failure is NOT reproducible under Bearer auth; the browser path differs by auth (cookie) or by state.
- Dashboard browser auth: httpOnly `auth_token` cookie holding an HS256 JWT `{ authenticated: true }` with a
  `jti`, 30d expiry, signed with env `JWT_SECRET` (`src/shared/utils/dashboardSessionToken.ts`), minted by
  `POST /api/auth/login` (management password; `src/app/api/auth/login/route.ts:212-231`) or the OIDC
  callback. Logout (`/api/auth/logout`) revokes the `jti`. Unauthenticated `/dashboard/cache` is a 307 to
  `/login`.

## Decisions

1. Client-side grouping in a pure module. The API already returns every model, and other consumers
   rely on the full shape, so `/api/usage/analytics` stays unchanged. Grouping lives in a new pure module,
   `src/shared/components/analytics/modelUsageSeries.ts`, with no React and no recharts.
2. Exclusion rule. The chart's token figure is `tokens_input + tokens_output`, so an embedding row would
   count its whole input as usage. Memory indexing is high-volume, input-only traffic, so it would distort
   an inference chart and take top-N slots. Embeddings are therefore excluded entirely, not folded into
   Other. Excluded ids (case-insensitive) never reach the top N or Other:
    - exact `connection-test` and `model-sync`;
    - health probes: `/(^|[-_.:/])health[-_]?(check|probe)s?($|[-_.:/])/i`;
    - embeddings: `/embed/i`;
    - any model whose total over the selected range is 0 (or not a finite number).
3. No alias collapsing. No suitable canonical helper exists:
    - `normalizeModelName` only strips the provider prefix, and the server already applies it, so
      `bedrock/global.openai.gpt-5.6-sol` arrives as `global.openai.gpt-5.6-sol`.
    - `getCanonicalModelSpecId` (`src/shared/constants/modelSpecs.ts:895`) maps to static spec ids using
      prefix matching. It would merge distinct models (gpt-5.6-sol and luna into a spec family), and it
      pulls a 1,046-line table into the client bundle.
    - `getBedrockKnownModelLimits` (`open-sse/config/bedrock.ts:85`) peels Bedrock prefixes inline but
      exports no id helper.

    So aliases stay separate, per the task rule. In practice they are tiny (live 30d:
    `global.openai.gpt-5.6-sol` has 560 tokens vs 810k for `gpt-5.6-sol`) and land in Other.

4. Top-N control. Options are `5 | 8 | 12 | "all"`, default 8. The choice persists in localStorage under
   `pref:analytics:modelUsageTopN` (values `"5"`, `"8"`, `"12"`, `"all"`; invalid or missing values fall
   back to 8), following the RequestTimeline lazy-initializer pattern. The state lives in
   `ModelOverTimeChart`. The body only renders after recharts lazy-loads on the client, so no hydration
   mismatch is visible.
5. The Other series uses the sentinel dataKey `__other__`, so a model literally named "Other" cannot
   collide. Its label comes from `t("chartOther")`, its color is a fixed neutral `#94A3B8`, and it is only
   emitted when its total is greater than 0. With `"all"` there is no Other.
6. Stable colors. Hash each model id (FNV-1a 32-bit) to a preferred slot in `MODEL_COLORS`. Then assign
   colors to the visible series in rank order, linear-probing past slots already used. A model therefore
   keeps its color across refreshes whenever its preferred slot is free, and visible series never share
   a color (up to 15). `getModelColor` stays unchanged, because donuts and tables still use it.
7. Legend. One `flex flex-wrap` row holds only the visible series plus Other. Each item gets a
   `max-w-[12rem]` wrapper, the label gets `truncate`, and `title` and `aria-label` carry the full name.
   The top-N control is a small button group in the card header (`role="group"`, `aria-label`,
   `aria-pressed` on each button).
8. i18n. New `analytics` keys: `chartOther` "Other", `chartTopN` "Top {count}", `chartTopAll` "All",
   `chartTopNLabel` "Models shown". Add them to `en.json`, then run `npm run i18n:sync-ui` to propagate
   `__MISSING__` markers to the other locales (the documented process).

## Items

- [ ]   1. Create the pure grouping module.
       Exports:
        - `MODEL_USAGE_TOP_N_OPTIONS = [5, 8, 12, "all"] as const`, type `ModelUsageTopN`, and
          `DEFAULT_MODEL_USAGE_TOP_N = 8`.
        - `MODEL_USAGE_TOP_N_STORAGE_KEY = "pref:analytics:modelUsageTopN"` and `OTHER_SERIES_KEY = "__other__"`.
        - `parseModelUsageTopN(raw: string | null | undefined): ModelUsageTopN`.
        - `isNonInferenceModel(id: string): boolean` (Decision 2 rules, excluding the zero-total rule).
        - `assignStableModelColors(keysInRankOrder: string[]): Record<string, string>`.
        - `buildModelUsageSeries(dailyByModel, modelNames, topN)` returning
          `{ rows: Array<{ date: string; dateLabel: string; [key: string]: number | string }>, series: Array<{ key: string; name: string; total: number; color: string; isOther: boolean }>, hiddenModelCount: number }`.

        Behavior of `buildModelUsageSeries`:
        - Candidate keys are `modelNames` ∪ row keys, minus `date` and `dateLabel`.
        - Totals are summed over all rows. Non-finite values count as 0. Drop excluded and zero-total keys.
        - Sort by total descending, ties by id ascending (plain `<`, deterministic).
        - Take the first N (all when N is `"all"`).
        - Per row, `__other__` is the sum of the remaining non-excluded keys.
        - Rows keep `date` plus `dateLabel` (`MM/DD`, same as the current chart) and only the visible keys.
        - Other's `name` is a placeholder (`"Other"`); the component overrides it with `t("chartOther")`.

        Files: `src/shared/components/analytics/modelUsageSeries.ts` (new; imports only `MODEL_COLORS` from
        `@/shared/constants/colors`).
        Verify: verified by item 2's tests (implement 1 and 2 together); `npx eslint --suppressions-location config/quality/eslint-suppressions.json src/shared/components/analytics/modelUsageSeries.ts` has 0 errors.

- [ ]   2. Unit-test the pure module with node:test. Cover:
        - top-N by total tokens across the whole range, not one day;
        - Other equals the per-row and total sum of the hidden models;
        - `connection-test`, `model-sync`, `health-check`/`healthprobe`, and `*embed*` ids are excluded, and
          are neither visible nor counted in Other;
        - zero-usage and NaN/undefined values are dropped;
        - stable ordering with ties (shuffled `modelNames` input gives identical output);
        - `"all"` gives no Other series;
        - no Other when the hidden totals are 0;
        - `parseModelUsageTopN` handles valid, invalid, and null input;
        - `assignStableModelColors` is deterministic, keeps a model's color when other models are
          added/removed (where its slot is free), and gives no duplicates for 15 or fewer keys.

        Files: `tests/unit/shared/model-usage-series.test.ts` (new).
        Verify: `cd /Users/celes/sources/celesrenata/OmniRoute && node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test tests/unit/shared/model-usage-series.test.ts`
        shows all tests passing.

- [ ]   3. Rewire the chart.
        - `ModelOverTimeChart` holds `topN` state: lazy init from localStorage via `parseModelUsageTopN`,
          window guard plus try/catch.
        - A setter writes `MODEL_USAGE_TOP_N_STORAGE_KEY` (try/catch).
        - `useMemo(() => buildModelUsageSeries(dailyByModel, modelNames, topN))`.
        - The empty state triggers when there are no rows or no visible series. Excluded-only data shows
          "No data".
        - The Body renders one `<Area dataKey={s.key} name={s.isOther ? t("chartOther") : s.name} stroke/fill={s.color}>`
          per series.
        - Add the header top-N button group (labels `t("chartTopN", { count })` / `t("chartTopAll")`,
          `aria-pressed`, `type="button"`).
        - Add the compact legend from Decision 7.
        - Keep the `useRecharts` lazy boundary and do not import `recharts`.
        - Do not change `DailyTrendChart` or the props `UsageAnalytics.tsx` passes.

        Files: `src/shared/components/analytics/rechartsUsageCharts.tsx`.
        Verify: `npx eslint --suppressions-location config/quality/eslint-suppressions.json src/shared/components/analytics/rechartsUsageCharts.tsx src/shared/components/analytics/modelUsageSeries.ts tests/unit/shared/model-usage-series.test.ts`
        reports 0 errors, with no new suppressions needed. Also run
        `node --import tsx/esm --test tests/unit/shared/analytics-recharts-lazy.test.ts` and confirm it passes.

- [ ]   4. Add the i18n keys from Decision 8 to the `analytics` object in `en.json`, next to
       `chartModelUsageOverTime`. Then run `npm run i18n:sync-ui` and commit the locale backfill.
       Files: `src/i18n/messages/en.json`, plus the other `src/i18n/messages/*.json` updated by the script.
       Verify: `npm run i18n:check-ui-coverage` exits 0, and
       `node scripts/i18n/check-ui-value-drift.mjs --warn` reports no drift for existing keys.

- [ ]   5. Add a component render test.
       Setup:
        - `// @vitest-environment jsdom`; mock `next-intl` as in `analytics-token-hover-tooltip.test.tsx`.
        - `vi.mock("@/shared/components/analytics/rechartsCore", ...)` returns
          `useRecharts: () => stub`. In the stub, `ResponsiveContainer` and `AreaChart` render their children,
          `Area` renders `<span data-testid="area" data-key={dataKey} />`, and `XAxis`, `YAxis`, `Tooltip`
          render null. Also provide `ChartLoadingCard` and `DarkTooltip`.

        Assertions:
        - With 12 nonzero models plus `connection-test` and an embed model, the default view shows
          8 areas + `__other__` and 9 legend items.
        - No `connection-test` and no embed id appears anywhere.
        - Legend labels carry `title` with the full name.
        - Clicking "Top 5" shows 5 + Other and writes `"5"` to localStorage.
        - A pre-seeded `"all"` shows all 12 and no Other.
        - All-zero input renders `chartNoData`.

        Files: `tests/unit/ui/model-over-time-chart.test.tsx` (new).
        Verify: `npx vitest run tests/unit/ui/model-over-time-chart.test.tsx tests/unit/ui/analytics-token-hover-tooltip.test.tsx`
        passes.

- [ ]   6. Type and quality gates for the chart work.
       Verify, from `/Users/celes/sources/celesrenata/OmniRoute`:
        - `npm run typecheck:core` is clean;
        - `npm run check:dashboard-typecheck` shows no regression vs baseline (the chart is reachable from
          `src/app/(dashboard)`);
        - `npm run check:file-size` passes;
        - `npx prettier --check` on the changed files passes.

        Commit: `feat(analytics): top-N model usage chart with compact legend`.

- [ ]   7. Reproduce the `/dashboard/cache` error with a real cookie session.
       Bearer auth already renders cleanly, so the repro must use the `auth_token` cookie.
        1. Mint a session JWT inside the pod without printing `JWT_SECRET`:
           `kubectl -n omniroute exec deploy/omniroute -- node -e "<use jose SignJWT({authenticated:true}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))>"`.
           Resolve `jose` from the image's `node_modules`. Write the token to a `/tmp` file with mode 600.
           If `jose` is not resolvable in the image, or minting fails, call `send_message` with severity
           `warning`, asking the user for their browser's `auth_token` cookie value (or permission to use
           another method), and wait.
        2. Playwright, using the repo's `node_modules/playwright` with
           `executablePath: ~/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`:
            - add the cookie `auth_token` for `omniroute.celestium.life` (secure, httpOnly, path `/`), with NO
              Authorization header;
            - load `/dashboard/cache` (`waitUntil: "load"`, because `networkidle` never settles due to polling);
            - click each tab;
            - also hard-reload, and navigate client-side from `/dashboard/analytics`;
            - capture `pageerror` messages and stacks, console errors, and every response with status 400 or
              higher (including `/_next/static` chunk 404s, which point to a ChunkLoadError or stale build);
            - run `kubectl -n omniroute logs deploy/omniroute --since=10m` at the same time.
        3. Afterwards, revoke the session with `POST /api/auth/logout` carrying the cookie, and delete the
           temp token and scripts.

        Files: none in the repo. Scripts go in `/tmp`. Findings go to
        `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/usage-chart-legend/cache-500-findings.md`.
        Verify: the findings file records the exact error, stack or failing URL, and the auth mode used.

- [ ]   8. Fix the cache error if it is a small local fix (for example a client render exception in
       `src/app/(dashboard)/dashboard/cache/page.tsx` or its `components/*`, or an API route that fails only
       under cookie auth).
        - Add a regression test at the lowest layer that fails without the fix: Vitest in
          `src/app/(dashboard)/dashboard/cache/__tests__/` for render bugs, or a node:test in `tests/unit/api/`
          for route bugs.
        - If it is not a small local fix, or it cannot be reproduced even with a cookie session (for example
          a stale-asset or ingress problem), do not change code. Document the root cause or hypothesis and
          the next step in `cache-500-findings.md`.

        Files: as determined by item 7.
        Verify: `npx vitest run "src/app/(dashboard)/dashboard/cache/__tests__"` (or the node:test file) passes,
        and `npm run check:dashboard-typecheck` shows no regression.
        Commit: `fix(dashboard): <root cause> on /dashboard/cache`.

- [ ]   9. Final integration run, once.
       Verify: `npm run lint` shows 0 errors, and `npm run test:unit` is run at most once (the full suite pegs
       the Mac CPU). Note pre-existing failures vs new ones, and run the focused files again rather than
       the full suite.

## Notes / gaps

- `DailyTrendChart` also uses the `chartModelUsageOverTime` heading for the token/cost bar chart. It is
  pre-existing and out of scope; leave it.
- Deploy follows the prior pattern (`.agents/tasks/omniroute-reasoning-effort-fix/deploy-report.md`):
  rsync to esnixi (`celes@192.168.42.254`), `docker build --target runner-cli`, push
  `registry.celestium.life/library/omniroute:3.8.64-usage-chart-legend-20261003`, bump the image in
  `/Users/celes/sources/kube/omniroute/omniroute.yaml` (currently `3.8.63-context-estimate-20261003`),
  commit locally, apply, and verify rollout and digest.
