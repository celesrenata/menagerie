# Live verification: Model Usage Over Time legend

Target: https://omniroute.celestium.life, image `registry.celestium.life/library/omniroute:3.8.64-usage-chart-legend-20261003` (commits 76dec5550 + f98cea204).
Method: headless Chromium (Playwright, chrome-headless-shell-1243), Bearer management key via `extraHTTPHeaders` (never printed), `waitUntil: 'load'`, 1440x1000 viewport. Run twice (second run fixed the card screenshot locator); both runs gave the same results.

Result: PASS.

## 1. /dashboard/analytics (overview, default range 30d)

| Check                                                       | Result                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default (localStorage cleared) shows ≤ 8 models + Other     | PASS: 8 models + `Other`; `Top 8` has `aria-pressed=true`                                                                                                                                                                                                                                                                            |
| Compact wrapping row                                        | PASS: legend container `display:flex; flex-wrap:wrap; font-size:10px`, single row 15 px tall, all 9 items on the same line                                                                                                                                                                                                           |
| No connection-test / model-sync / embed / zero-token models | PASS: none in the default, Top 12 or All legends. `All` shows exactly the 74 models with tokens > 0 (99 zero-token ids dropped out of 173, including 4 zero-token `*-embed*` ids). `connection-test` and `model-sync` do not appear in the 30-day API data at all, so live data cannot exercise their exclusion. Unit tests cover it |
| Labels truncate and carry a title                           | PASS: every label span has `text-overflow:ellipsis; overflow:hidden; white-space:nowrap`, `title` equals the label, and the item has `max-width:192px` (no current label is long enough to clip at 1440 px)                                                                                                                          |
| Top 5 / 8 / 12 / All control                                | PASS: Top 5 → 5 + Other, Top 12 → 12 + Other, All → 74 (no Other). Each click writes `pref:analytics:modelUsageTopN` (`5`, `12`, `all`)                                                                                                                                                                                              |
| Choice persists after reload                                | PASS: Top 5 selected, then reload → legend still 5 + Other, `Top 5` pressed. Reset to Top 8 afterwards (`8` stored)                                                                                                                                                                                                                  |
| pageerror events                                            | PASS: 0. Also 0 console errors and 0 responses ≥ 400                                                                                                                                                                                                                                                                                 |

Default legend: qwen3.8-27b-nvfp4, ds4-glm53, qwen3.8-27b-nvfp4-balanced, qwen3-coder-next, ornith-1.5:9b-262k, qwen3.8:27b-q2-code144k, codestral-latest, qwen3.8:27b-iq3-code144k, Other.

Screenshots (in `artifacts/live/`):

- `legend-default-top8.png`: chart card, default Top 8
- `legend-top5.png`: after clicking Top 5
- `legend-all.png`: All (74 models, wrapping)
- `legend-top5-after-reload.png`: Top 5 still applied after reload
- `analytics-overview-full.png`: full overview page

Observation (existing behavior, not a regression): the page has two `<h3>`s titled "Model Usage Over Time". The other one is the `DailyTrendChart` (input/output/cost) card, which already used `chartModelUsageOverTime` before 76dec5550. It could get its own title in a follow-up.

## 2. API cross-check: GET /api/usage/analytics?range=30d

HTTP 200. Tokens were summed per key across `dailyByModel` (keys from `modelNames` ∪ row keys, minus `date`). Ids matching connection-test, model-sync, `/embed/i` or health-probe were excluded, along with zero totals. Ties sort by name.

| #   | Model                      | Tokens (30d) |
| --- | -------------------------- | ------------ |
| 1   | qwen3.8-27b-nvfp4          | 129,688,322  |
| 2   | ds4-glm53                  | 95,916,157   |
| 3   | qwen3.8-27b-nvfp4-balanced | 64,247,701   |
| 4   | qwen3-coder-next           | 30,758,898   |
| 5   | ornith-1.5:9b-262k         | 24,952,342   |
| 6   | qwen3.8:27b-q2-code144k    | 12,734,899   |
| 7   | codestral-latest           | 11,254,735   |
| 8   | qwen3.8:27b-iq3-code144k   | 9,633,894    |

The remaining 66 models total 38,920,398 tokens, which go into `Other`. This top 8 matches the rendered legend exactly, in the same order. Top 5 and Top 12 also match the API ranking prefixes.

## 3. /dashboard/cache

FEAT-002 changed no code; its outcome was documented only (`cache-500-findings.md`). The cookie-session reproduction found no error, and the leading hypothesis is a transient error during a rollout. With no fix to re-verify, no new session was minted. Next step if it happens again: capture the failing URL, status and digest, plus `kubectl -n omniroute logs deploy/omniroute`, right away.

## Cleanup

Deleted the temp script and JSON output under `/tmp`. Screenshots were written straight to `artifacts/live/`, so none were left in `/tmp`. No session token was minted and no secrets were printed.
