# OmniRoute `/api/combos` fix — verification

## Status: CODE fix applied (first iteration, no review.json present)

## Root cause (per plan.md)

Live DB evidence conclusively ruled out data corruption: all 91 `combos` rows
have `typeof(data) = 'text'`, parse as valid JSON, and are not filtered by
`isHidden`. The reproducible defect is a code/contract gap: `paginationSchema`
(`src/shared/validation/schemas/misc.ts`) hard-rejected `limit` values above
200 with an HTTP 400 instead of clamping, so a caller unconditionally sending
`limit=300` got a 400 on every request. A client reading `.combos` off that
400 body without checking status would observe "0 combos" — the most
plausible explanation for the reported symptom. No DATA repair was warranted
or performed; the live file was not modified.

## Code changes

1. `src/shared/validation/schemas/misc.ts` — `paginationSchema.limit` changed
   from `.max(200)` (hard 400 rejection) to an unbounded-but-clamped
   `.transform((v) => (v === undefined ? v : Math.min(v, 200)))`. This affects
   all four routes sharing this schema (`combos`, `model-combo-mappings`,
   `playground/presets`, `provider-nodes`): `limit > 200` now clamps to 200
   with a `200` response instead of a `400`. `limit` omitted, `0`, and exactly
   `200` are unchanged.
2. `src/lib/db/repositories/sqliteComboRepository.ts` — `parseComboRow`'s
   silent-drop path (when `getSerializedData` returns `null`, i.e.
   `typeof row.data !== "string"`) now emits
   `console.warn("[DB] Skipping combo row with non-string/empty data column (id=...)")`,
   following the existing pattern in `src/lib/db/models.ts`. This makes a
   future recurrence of the "silently dropped row" hypothesis immediately
   visible in pod logs instead of requiring a live DB dump to diagnose.

## Tests added

`tests/unit/combos-pagination-limit-clamp.test.ts` (new), using the same
harness pattern as `tests/unit/provider-connections-pagination-2998.test.ts`
(temp `DATA_DIR`, `core.resetDbInstance()`, `makeManagementSessionRequest()`,
calling the route's `GET` export directly):

- `GET /api/combos?limit=300` → `200` with all seeded combos (regression test
  for the actual reported-sounding defect).
- `GET /api/combos?limit=1000` → `200`, clamped.
- `GET /api/combos?limit=200` (boundary) → unaffected, still `200`.
- `GET /api/combos?limit=0` → unaffected, still `200` with an empty array
  (guards `Math.min(0, 200) = 0` not becoming `undefined`/unbounded).
- Legacy/malformed-row regression: seeds one combo row with `data` as a
  `Buffer` (BLOB, bypassing `createCombo`'s normal JSON-string write path, so
  it survives as a non-string value instead of being coerced back to TEXT by
  SQLite's column affinity) and asserts (1) the route still returns the other
  seeded combos while silently omitting the malformed one (existing,
  unchanged behavior) and (2) the new `console.warn` fires naming the
  skipped row's id.

## Commands run and results

```
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=4096 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit \
  tests/unit/combos-pagination-limit-clamp.test.ts \
  tests/unit/provider-connections-pagination-2998.test.ts \
  tests/unit/pagination.test.ts \
  tests/unit/db-combos-crud.test.ts
```

→ 39/39 pass.

Also ran, to confirm no regression in the three sibling routes sharing
`paginationSchema`:

```
tests/unit/model-combo-mappings-db.test.ts
tests/unit/provider-nodes-validate-modelid.test.ts
tests/unit/model-combo-mappings.test.ts
tests/unit/db-playground-presets.test.ts
tests/unit/provider-nodes-route.test.ts
tests/integration/playground-presets-zod.test.ts
tests/integration/playground-presets-crud.test.ts
```

→ all pass (63 + 36).

Broader combo suite sanity check:

```
"tests/unit/combo/**/*.test.ts" tests/unit/combos-duplicate-route.test.ts
tests/unit/model-combo-mappings-db.test.ts tests/unit/db-combos-crud.test.ts
tests/unit/combos-pagination-limit-clamp.test.ts tests/unit/pagination.test.ts
tests/unit/provider-connections-pagination-2998.test.ts
```

→ 421/421 pass.

Typecheck:

```
npx tsc --pretty false -p tsconfig.typecheck-core.json
```

→ clean (0 errors). Confirms the `.transform()` change to `paginationSchema`
type-checks against all four consumer routes.

ESLint on touched files (`npx eslint --max-warnings=0 <file>`): the only
findings in `src/shared/validation/schemas/misc.ts` are 9 pre-existing
`no-unused-vars` errors unrelated to and unchanged by this diff (confirmed via
`git stash` — identical findings present before the change). No new lint
findings introduced by either touched file or the new test file.

## Data repair

Not performed. Plan's Evidence 1-3 showed the live 91-row `combos` table is
already 100% well-formed; running a repair against healthy data would be
risk with no benefit. The live `/app/data/storage.sqlite` file was not
touched by this iteration.

## Not done here (per task scope)

No rebuild/redeploy of the image, and no live API call against
`omniroute.celestium.life` — both deferred to a later deploy step.

---

CODE CHANGED: yes
COMMIT: c9230dee8 (local, feat/hybrid-reader-combo branch, not pushed)
ROOT CAUSE: `paginationSchema`'s `limit.max(200)` hard-rejected `limit=300` with a 400 instead of clamping, so a caller reading `.combos` without checking status saw 0 combos — not a data corruption issue.
