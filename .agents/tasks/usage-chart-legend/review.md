# Top-N grouping and compact legend for "Model Usage Over Time"

The chart used to draw one stacked area and one legend chip per model the analytics API returned. On the live 30-day window that was 173 names, 99 of them at zero tokens. A new pure module, `modelUsageSeries.ts`, now ranks models by total tokens over the selected range, keeps the top N (5/8/12/All, default 8), and folds the rest into one neutral "Other" series. It drops connection-test, model-sync, health probes, embeddings and zero-total ids before ranking. The chart component only consumes that module, and adds a persisted top-N button group and a truncated legend. `/api/usage/analytics` and the recharts lazy boundary are untouched. The `/dashboard/cache` 500 did not reproduce under a real cookie session, and it is documented without a code change.

Watch for: 65 of 67 locales show the English fallback for the 4 new keys (en and vi have real values; this is the documented `__MISSING__` process) (confirmed). The cache 500 is still unexplained, and the only lead is the hypothesis of a transient rollout or deploy skew (confirmed as not reproduced).

**Verdict**: APPROVED

## High-level view

Grouping happens on the client, in a React-free, recharts-free function, so the API shape other consumers rely on stays the same. Totals are summed across all rows, ties sort by id, and Other is computed per row from only the non-excluded hidden keys. Excluded ids therefore never land in Other. Other is emitted only when its total is positive, and never with "All".

There is no alias table. Distinct ids such as `global.openai.gpt-5.6-sol` and `gpt-5.6-sol` stay separate, as the plan decided, and the small alias normally falls into Other.

Colors come from an FNV-1a hash of the model id into `MODEL_COLORS`, with linear probing in rank order. A model keeps its color across refreshes unless a higher-ranked model already holds its slot. `getModelColor` is unchanged for the other charts.

The top-N choice persists under `pref:analytics:modelUsageTopN` with a guarded lazy initializer and try/catch on writes. Invalid values fall back to 8.

<details>
<summary>Issues (3)</summary>

1. **Legend items lack the planned aria-label** — Decision 7 called for `title` and `aria-label` on each label. Only `title` is set. Truncation is CSS-only, so the accessible text is still the full name, and this is non-blocking. Add `aria-label` only if the plan is meant literally.
2. **Header row doesn't wrap** — the title and the 4-button group share a `justify-between` row with no `flex-wrap`, so they may crowd in a narrow grid cell. Add `flex-wrap` if it looks cramped on the live page (possible, not checked visually).
3. **Cache 500 unexplained** — the next time it happens, capture the failing URL, status and error digest, plus `kubectl logs` from that time. The missing Traefik `default-redirectscheme` middleware (http returns 404) is a separate infra fix.

</details>

<details>
<summary>Details</summary>

### Grouping correctness

`buildModelUsageSeries` takes the candidate keys from the union of `modelNames` and every row key, minus `date`/`dateLabel`. Excluded and zero/non-finite totals are dropped before ranking, so `hiddenKeys` only holds positive, inference-only models, and the per-row `__other__` sum equals the sum of those models on that row. The `__other__` sentinel cannot collide with a model literally named "Other". The node tests cover range-total ranking (versus a single-day spike), Other per-row and total sums, exclusion of every non-inference category, NaN/undefined, shuffled input with ties, "all", and Other being omitted when hidden totals are zero.

`/embed/i` is deliberately broad, per Decision 2. Any future inference model whose id contains "embed" would be hidden silently. That is an accepted trade-off, not a defect.

### Legend and control

Each legend item is capped at `max-w-[12rem]` with a `truncate` label and a `title` holding the full name (or the translated "Other"). The button group uses `role="group"`, an i18n `aria-label`, `aria-pressed` and `type="button"`. The component test stubs `useRecharts` and confirms:

- 8 areas plus Other in the default view, with titles equal to the full names;
- no connection-test or embed id anywhere in the DOM;
- Top 5 writes `"5"` to storage;
- a stored `"all"` restores 12 areas with no Other;
- all-zero data shows `chartNoData`.

### /dashboard/cache 500

The cache item was reproduced as the plan asked: a cookie-only session minted in the pod, with the secret never printed, then revoked afterwards. The page then rendered cleanly on load, reload, client-side navigation, every tab and SSR in all 67 locales, and the pod and Traefik logs showed no 5xx. Following item 8, no code changed, and the findings file records the deploy-skew/transient-rollout hypothesis and the capture steps. No test was possible without a reproducible defect.

### Verification re-run by this review

- node:test on `model-usage-series` plus `analytics-recharts-lazy`: 13/13 pass.
- Vitest on `model-over-time-chart.test.tsx`: 4/4 pass.
- eslint with `--max-warnings=0` on the 4 new/changed TS files: 0 errors.
- `config/quality/eslint-suppressions.json`, `src/app/api/usage/**` and the rest of `src/app/**` are unchanged in the diff range.
- All 67 locale files gained exactly the 4 keys.
- The branch has no upstream, and no remote branch contains HEAD, so nothing was pushed.
- No secrets in the diff.

The full-suite evidence in `verification.md` was not re-run. It reports 1 new failure (the vi completeness test, fixed in f98cea204), and 10 pre-existing failures confirmed identical on HEAD~1.

</details>

<details>
<summary>File map</summary>

- `src/shared/components/analytics/modelUsageSeries.ts`: new pure grouping, exclusion, top-N parsing and stable colors.
- `src/shared/components/analytics/rechartsUsageCharts.tsx`: `ModelOverTimeChart` uses the module, plus the top-N control, persisted pref and compact legend.
- `tests/unit/shared/model-usage-series.test.ts`: node:test for the pure module.
- `tests/unit/ui/model-over-time-chart.test.tsx`: Vitest/jsdom render test.
- `src/i18n/messages/*.json`: 4 new `analytics` keys (en source, vi translated, other locales `__MISSING__` backfill).

Full diff: `git -C /Users/celes/sources/celesrenata/OmniRoute diff 1d48e1cfd..HEAD`

</details>
