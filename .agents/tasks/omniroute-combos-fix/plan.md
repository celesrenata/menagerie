# OmniRoute `/api/combos` 0-result / 5-result investigation — root cause and fix plan

## Executive summary

**The `data`-column-corruption hypothesis is REFUTED.** Direct queries against the live
`/app/data/storage.sqlite` inside the running pod (`omniroute-6f9c5b67d9-jjvxq`, image
`3.8.52-failfixes-feat002-005-20261001`) show all 91 `combos` rows have `typeof(data) = 'text'`,
every row's `data` parses as valid JSON with `JSON.parse`, and `GET /api/combos` (no params),
`GET /api/combos?all=true`, and the paginated `GET /api/combos?limit=100&offset=0` loop
(`omniroute-mode.py`'s own pagination strategy) **all currently return the full 91/91 combos** —
confirmed from inside the pod against both the loopback management API (`127.0.0.1:20128`) and
the public HTTPS endpoint (`https://omniroute.celestium.life`) using the real `sops-management`
API key read live from the `api_keys` table.

**What I actually found:** `GET /api/combos?limit=300` returns an **HTTP 400** —
`{"error":{"message":"Invalid request","details":[{"field":"limit","message":"Too big: expected
number to be <=200"}]}}` — not an empty 200. `paginationSchema` (added in commit `4b06761ad`,
`src/shared/validation/schemas/misc.ts:211-214`) caps `limit` at `z.coerce.number().int().min(0)
.max(200)`. A caller that always requests `limit=300` (unconditionally, not in a paginating loop)
gets a 400 on every call. This is a **real, reproducible bug** — just not a "0 real rows return
despite being correctly inserted" data bug. It is a **client/schema contract mismatch**: some
caller hardcodes `limit=300` (above the 200 cap OmniRoute's own `paginationSchema` enforces),
expecting it to work like a plain "give me everything" ceiling the way it does on sibling routes
pre-#7046, and gets a 400 instead of either 200-with-all-rows or a clamped 200.

A client that does not check the HTTP status before reading `.combos` off the response body would
see `undefined`/`0` combos from that 400 payload — this is the most plausible explanation for the
"GET /api/combos?limit=300 returned 0" symptom in the brief, and it explains why `?all=true`
(5 results in the brief's earlier test) and the plain call diverge from `limit=300`: `all=true` and
no-params both skip the `limit` validation path entirely (`range.limit` ends up `undefined`, so
`getCombos(undefined, undefined)` runs the unbounded query), while `limit=300` is rejected before
any DB read happens.

**The "5 results" number does NOT currently reproduce.** Both `?all=true` and no-params return the
full 91 live right now. Given FEAT-002/004/005 are unrelated to this code path and the live pod
is healthy and only ~1-2 hours into its current rollout generation (confirmed via `kubectl get
events`), the most likely explanation for the "5" observed earlier is a stale observation taken
_during_ the PVC remount/pod-churn window on 2026-10-02 (the events log shows four pod
replacements between 07:10 and 07:25 UTC — `omniroute-68dd55c4f7` → `omniroute-774d5b74d4` →
`omniroute-56c8f77b9d` → `omniroute-6f9c5b67d9`, several hitting startup-probe timeouts), not a
reproducible defect in the current, stable pod. I cannot retroactively query a DB state from a
pod that no longer exists (`kubectl logs --previous` confirms no previous container exists to
inspect), so this number is **unconfirmed and likely transient**, not reproduced with hard
evidence the way the `limit=300` 400 is.

## (a) Confirmed root cause, with evidence

### Evidence 1 — `data` column is healthy (refutes the leading hypothesis)

Ran directly in-pod via `kubectl exec omniroute-6f9c5b67d9-jjvxq -- node <script>` using the
pod's own `better-sqlite3` (`/app/node_modules/better-sqlite3`) against `/app/data/storage.sqlite`:

```
count: { c: 91 }
by typeof(data): [ { t: 'text', c: 91 } ]
parseFail (JSON.parse over all 91 rows): 0
```

Sampled 10 rows' `id`/`name`/`typeof(data)`/`length(data)` — all `text`, lengths 360-1048 bytes,
no NULLs, no BLOBs. `sort_order` is a `number` for every sampled row, `context_cache_protection`
is `0`/`number` (not `null`). None of `getSerializedData`, `getSortOrder`, or the
`context_cache_protection` branch in `parseComboRow` (`src/lib/db/repositories/
sqliteComboRepository.ts:94-110`) would reject any of the 91 rows.

### Evidence 2 — `isHidden` is not filtering any rows either

```
hidden: 0  visible: 91
```

All 91 rows have `isHidden: false` (or unset) in their parsed JSON — the dashboard's
`(combosData.combos || []).filter((c) => !c.isHidden)` client-side filter
(`src/app/(dashboard)/dashboard/combos/page.tsx:925`) would not explain a reduced count either.

### Evidence 3 — live reads currently return all 91 through every code path

| Call                                                                                                                                            | Result                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/combos` (loopback, management key)                                                                                                    | `200`, 91 combos, `total: 91`                                                                                                                                                                   |
| `GET /api/combos?all=true` (loopback)                                                                                                           | `200`, 91 combos, `total: 91`                                                                                                                                                                   |
| `GET /api/combos?limit=200`                                                                                                                     | `200`, 91 combos                                                                                                                                                                                |
| `GET /api/combos?limit=91&offset=86`                                                                                                            | `200`, 5 combos (last page — NOT a bug, correct pagination)                                                                                                                                     |
| `GET /api/combos?limit=0`                                                                                                                       | `200`, **0** combos, `total: 91` (correct: `limit=0` means "return 0 rows", by SQL `LIMIT 0` semantics — not a bug)                                                                             |
| `GET /api/combos?offset=200&limit=50`                                                                                                           | `200`, 0 combos, `total: 91` (correct: offset beyond the table)                                                                                                                                 |
| `GET /api/combos?offset=200` (no limit)                                                                                                         | `200`, **91** combos (offset is silently ignored because `range.limit === undefined` skips the `LIMIT ? OFFSET ?` clause entirely — `src/lib/db/repositories/sqliteComboRepository.ts:122-126`) |
| `GET /api/combos?limit=300`                                                                                                                     | **`400`** `{"error":{"details":[{"field":"limit","message":"Too big: expected number to be <=200"}]}}`                                                                                          |
| `GET /api/combos?limit=201` / `?limit=1000`                                                                                                     | **`400`**, same error                                                                                                                                                                           |
| `GET /api/combos?all=true&limit=300`                                                                                                            | **`400`** — `all=true` does NOT bypass the `limit` validation; `paginationSchema.safeParse` runs on `{offset, limit}` from the URL regardless of any other param, and `limit` fails first       |
| `GET https://omniroute.celestium.life/api/combos` + `?all=true` (public HTTPS, same key)                                                        | Both `200`, 91 combos — ingress/TLS termination is not altering behavior                                                                                                                        |
| Simulated `omniroute-mode.py`'s own `live_combos()` loop (`limit=100&offset=0`, growing offset)                                                 | `200`, 91 rows collected in one page (91 ≤ 100)                                                                                                                                                 |
| `GET /api/v1/vscode/<zoo-m5-key>/combos` (tokenized route — what menagerie's `fetchOmniRouteCatalog` in `src/api/providers/omniroute.ts` calls) | `200`, 91 entries                                                                                                                                                                               |

**Conclusion: there is no live 0-result or 5-result reproduction right now.** The DB, the
migrations (163-174, confirmed already applied per the brief), the `combos` table, and every
documented read path (`route.ts` → `getCombos` → `sqliteComboRepository.list` → `parseComboRow`)
are all healthy as of this investigation.

### Evidence 4 — the one real, reproducible defect: `limit=300` is a hard validation wall, not a graceful cap

`src/shared/validation/schemas/misc.ts:211-214`:

```ts
export const paginationSchema = z.object({
	offset: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(0).max(200).optional(),
})
```

`src/app/api/combos/route.ts:25-33` runs this schema against the raw `offset`/`limit` query
params unconditionally in the `GET` handler, before anything else happens:

```ts
const validation = validateBody(paginationSchema, raw)
if (isValidationFailure(validation)) {
	return NextResponse.json({ error: validation.error }, { status: 400 })
}
```

Any caller that passes `limit=300` — a value above the 200 cap, presumably chosen before the cap
existed (the cap was introduced by commit `4b06761ad`, "feat(api): add pagination params to 8 DB
modules", 2026-07-20) or chosen to mean "there will never be more than 300 combos, give me
everything in one call" — gets a 400 on **every single request**, deterministically, with no
retry succeeding. The three sibling routes that reused the same `paginationSchema` in the same
commit (`provider-nodes`, `model-combo-mappings`, `playground/presets`) have the exact same
400-on-limit>200 behavior — this is not combos-specific, but combos is the one in the user's
report.

### Evidence 5 — the `all=true` vs plain-call divergence in the brief

Reading `src/app/api/combos/route.ts` end to end: **there is no `all` query parameter handling
anywhere in this file.** `searchParams.get("all")` is never called. The only params read are
`offset` and `limit` (lines 26-29). `all=true` is simply an extra query param that
`paginationSchema.safeParse({offset, limit})` ignores — Zod's default `.object()` behavior is to
ignore extra keys not present in the raw object passed to it (and here, `raw` itself only ever
contains `offset`/`limit` — `all` is read from `request.url`'s `searchParams` but never placed
into `raw`, so it has literally zero effect on the handler). This means **`?all=true` and no
params are byte-for-byte identical requests** to this handler: both produce `range.limit ===
undefined`, both skip the `LIMIT ? OFFSET ?` SQL clause (`sqliteComboRepository.ts:122-126`), both
return every row. The two numbers in the brief (0 for plain, 5 for `all=true`) are not explained by
anything in this route's code, because the code treats them identically. The only way to get two
different numbers from calls that the code treats identically is one of:

1. They were made at **different points in time** during the pod-churn window (07:10-07:25 UTC),
   hitting different pod instances with different DB-mount states (stale `omniroute-data` 25-row
   PVC vs. the correct `omniroute-data-longhorn` 91-row PVC was the exact failure class already
   fixed per the brief's "already confirmed" section) — most likely explanation given the
   observed churn.
2. The TTL/version-bumped combo cache (`readCache.ts`'s `combosCacheVersion`, used only by
   `sse/handlers/chat.ts`'s `combosCachePromise`, NOT by `/api/combos`'s `route.ts` — confirmed
   by `grep` showing `getCombos`/`route.ts` never touch `readCache.ts` except for the
   write-invalidation calls in `combos.ts`) is irrelevant to this specific divergence, because
   `/api/combos` GET never reads through that cache.
3. A transient 5xx/timeout on one call that a wrapper script silently treated as "0 combos"
   while a later retry (`all=true`) succeeded with a still-not-fully-synced read-replica or
   in-flight write — not reproducible now and no DB-level evidence supports it (no partial-write
   artifacts, no `config_audit_log` rows in the relevant window, no WAL corruption flags in the
   startup log).

Given the DB evidence rules out a persistent data problem, and the route code proves `all=true`
has no special handling, **the 0-vs-5 discrepancy is most parsimoniously explained by the
documented pod churn/PVC remount window**, not a bug still present in the code today.

## (b) Is the fix CODE, DATA, or BOTH?

**CODE.** There is no data corruption to repair — Evidence 1-3 rule that out conclusively. The
one concrete, reproducible defect is a **code/contract gap**: `paginationSchema`'s `max(200)`
silently 400s a caller using `limit=300` instead of either (a) clamping to 200, consistent with
how a "give me a big page" caller would reasonably expect pagination caps to behave, or (b)
treating an over-cap `limit` as "no limit" (unbounded), which is what every other combos-reading
code path in this codebase already does when `limit` is simply omitted. Secondarily, `parseComboRow`
returning `null` with no logging (confirmed in Evidence 1 as currently never triggered, but still
a latent silent-failure risk per the brief's point 7) should get a warning log so a _future_
occurrence of this hypothesis is diagnosable in minutes instead of requiring a live DB dump.

No DATA repair script is warranted: there's nothing in the 91 rows to normalize, and running a
"backup + repair" step against healthy data is pure risk for zero benefit.

## (c) Code fix — exact files, functions, and tests

### Fix 1 — stop hard-rejecting `limit` above the cap; clamp instead

**File:** `src/shared/validation/schemas/misc.ts`, `paginationSchema` (lines 211-214).

Change `limit`'s Zod validator from `.max(200)` (which makes `safeParse` fail and `GET` 400) to a
post-parse clamp so any `limit > 200` is silently capped to 200 instead of rejected — matching how
every other route that forgets to pass `limit` already gets "no cap" behavior, and avoiding a
mandatory client-side change for anyone (internal or external) currently sending `limit=300`:

```ts
export const paginationSchema = z.object({
	offset: z.coerce.number().int().min(0).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.transform((v) => (v === undefined ? v : Math.min(v, 200))),
})
```

This schema is shared by `src/app/api/combos/route.ts`, `src/app/api/model-combo-mappings/
route.ts`, `src/app/api/playground/presets/route.ts`, and `src/app/api/provider-nodes/route.ts` —
all four get the fix at once, consistent with how the cap was introduced across all four in one
commit (`4b06761ad`). This is a deliberate behavior change (400 → 200-with-clamped-results) that
affects a shared, cross-cutting validator — confirm with the user before merging if a strict
400-on-invalid-input contract is relied upon elsewhere (none of the four `route.ts` files in this
repo have tests asserting a 400 specifically for `limit > 200` — `tests/unit/pagination.test.ts`'s
"clamps limit to the maximum of 200" test (line 33) is for a DIFFERENT, unrelated
`parsePaginationParams` helper in `src/shared/types/pagination.ts`, not `paginationSchema` — so no
existing test needs to change for routes using `paginationSchema`; only the new tests added below
assert the new behavior).

### Fix 2 — log the silent-drop path in `parseComboRow`

**File:** `src/lib/db/repositories/sqliteComboRepository.ts`, `parseComboRow` (lines 94-99).

Add a `console.warn` when `getSerializedData` returns `null`, following the exact pattern already
used for this kind of silent-drop in `src/lib/db/models.ts:612`
(`console.warn(\`[DB] Skipping malformed syncedAvailableModels entry for key ${key}:\`, error)`):

```ts
function parseComboRow(row: unknown): JsonRecord | null {
  const payload = getSerializedData(row);
  if (!payload) {
    const id = getComboId(row);
    console.warn(
      `[DB] Skipping combo row with non-string/empty data column${id ? ` (id=${id})` : ""}.`
    );
    return null;
  }
  const parsed = withRowId(payload, asRecord(row));
  // ... unchanged
```

This makes the leading hypothesis in the brief instantly diagnosable from pod logs the next time
it's suspected, without needing a live `kubectl exec` DB dump to confirm or refute it.

### Tests to add

**File:** `tests/unit/combos-pagination-limit-clamp.test.ts` (new), following the exact harness
pattern already used in `tests/unit/provider-connections-pagination-2998.test.ts` (temp
`DATA_DIR`, `core.resetDbInstance()`, `makeManagementSessionRequest()` from
`tests/helpers/managementSession.ts`, calling the route's `GET` export directly):

- `GET /api/combos?limit=300` returns `200` with all seeded combos (not 400), proving the clamp
  replaces the hard rejection — this is the regression test for the actual reported-sounding
  defect (a caller unconditionally sending `limit=300` getting a non-200).
- `GET /api/combos?limit=201` and `?limit=1000` likewise clamp to 200 rather than 400.
- `GET /api/combos?limit=200` (the exact boundary) is unaffected — still 200, still works exactly
  as before (regression guard against the clamp off-by-one).
- `GET /api/combos?limit=0` is unaffected — still `200` with an empty `combos` array and the
  correct `total` (regression guard: `Math.min(0, 200) = 0` must not become `undefined`/unbounded).
- (Legacy-shape regression, covering the brief's hypothesis even though currently unreproduced)
  seed one combo row with `data` manually set to a non-string value (e.g. insert via raw SQL with
  `data = NULL` or a numeric literal, bypassing `createCombo`'s normal JSON-string write path) and
  assert: (1) `GET /api/combos` returns the OTHER seeded combos but silently omits the malformed
  one (current behavior, unchanged — this test documents it rather than fixing it, since fixing a
  genuinely malformed row would require migrating or discarding data this plan has no evidence
  exists), and (2) a `console.warn` spy captures the new warning message from Fix 2, confirming the
  silent-drop is now logged.

### Verification

Run from `/Users/celes/sources/celesrenata/OmniRoute`:

```
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=4096 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit \
  tests/unit/combos-pagination-limit-clamp.test.ts \
  tests/unit/provider-connections-pagination-2998.test.ts \
  tests/unit/pagination.test.ts \
  tests/unit/db-combos-crud.test.ts
```

Expected: all tests pass, including the pre-existing `provider-connections-pagination-2998.test.ts`
and `pagination.test.ts` suites (already confirmed green in this investigation,
unaffected by the `misc.ts` change since `provider-connections` pagination uses a different helper).
Also run `npx tsc --pretty false -p tsconfig.typecheck-core.json` (the project's `typecheck:core`
script) to confirm the `.transform()` change to `paginationSchema` still type-checks against every
consumer (`combos`, `model-combo-mappings`, `playground/presets`, `provider-nodes` routes).

## Why NOT a data-repair approach

A repair script (backup-then-normalize the `data` column) was the brief's leading hypothesis, but
Evidence 1-3 show the live 91-row table is already 100% well-formed JSON text with no NULLs, BLOBs,
or malformed rows. Writing and running a repair migration against healthy data has no benefit and
carries real risk (any bug in the repair script, or an interrupted VACUUM/backup, could itself
corrupt a currently-healthy 281MB production file). If the brief's "0 rows / 5 rows" symptom
recurs after this code fix ships, Fix 2's new warning log will immediately show which combo id(s)
and why, converting the next report into actual data evidence instead of another from-scratch
`kubectl exec` investigation — at that point a targeted repair for the SPECIFIC malformed row(s)
identified by the log would be the appropriate next step, not a blanket repair of a table that is
currently fine.

## Open item: confirm the operator-facing "300" caller

I could not find a `limit=300` caller against `/api/combos` in: `OmniRoute/src` (grep across
`.ts`/`.tsx`), `OmniRoute/@omniroute/opencode-plugin`, `OmniRoute/open-sse`, `menagerie/src`,
`menagerie/packages`, `/private/tmp/omniroute-routing.py`, `/private/tmp/omniroute-mode.py`, or
`~/.local/share/omniroute-editor/omniroute-mode.py` (the only live, in-use copy of the tiering
script, which pages at `limit=100`, not 300). If the user has a specific external script or tool
hardcoding `limit=300` against this gateway (a Zoo panel, a monitoring dashboard, a one-off curl in
a runbook), that caller needs to be identified and either updated to the new clamp-tolerant
behavior (no change needed once Fix 1 ships) or left alone (Fix 1 makes `limit=300` succeed with
200 real rows instead of a 400, so no caller-side change is actually required). This is noted as an
open item, not a blocking unknown — Fix 1 resolves the symptom regardless of which caller was
sending it.
