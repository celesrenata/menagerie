# Verification — OmniRoute combo-id fix (Option A)

Branch: `feat/parallel-tasks-import`. First iteration (no `combo-fix-review.json` present).

## Root cause (confirmed, not re-litigated)
Per `bare-code-request-path.md`: the request path (`OpenAiHandler`) sends
`openAiModelId` verbatim as the chat `model` field — there is NO prefix strip
there. The bare id originates at catalog selection: `fetchOmniRouteCatalog`
fetched `${base}/models?prefix=alias`, which returns BARE alias ids (`code`),
and the webview stored `entry.id` verbatim. OmniRoute's chat endpoint needs the
`tier/role` combo id (`hybrid/code`), a different namespace, so it rejected the
request with "Unable to determine provider for model 'code'".

## Endpoint shape verified live (http://127.0.0.1:20128)
- `GET /api/v1/vscode/<token>/combos` → `{ object:"list", data:[ {name, strategy, models, capabilities}, ... ] }`.
  The combo id is in the **`name`** field (`hybrid/code`, `local/long`, `hybrid/reader`, ...).
- `GET /models?prefix=alias` → `{ object:"list", data:[ {id, ...}, ... ] }` (alias namespace — NOT used).
- The tokenized combos variant exists and mirrors the existing tokenized base URL
  (`omniRouteTokenizedBaseUrl`), so the fix reuses that base + the same Bearer auth.

## Changes (Option A)
1. `packages/types/src/providers/openai.ts`: added `omniRouteComboEntrySchema`
   (parses `{name}`, transforms to an `OmniRouteCatalogEntry` with `id = name`).
2. `src/api/providers/omniroute.ts`: `fetchOmniRouteCatalog` now GETs `${base}/combos`
   (reusing the tokenized base + Bearer header) and parses with `omniRouteComboEntrySchema`,
   so every `entry.id` is a full `tier/role` combo id. Response extraction prefers
   `data`, falls back to `combos`, then a bare array.
3. `webview-ui/.../OmniRouteSettings.tsx`: no code change required — it already stores
   `entry.id` verbatim via `setApiConfigurationField` (bound to `cachedState` through the
   parent). With `entry.id` now a combo id, selecting an entry sets `openAiModelId` to the
   full combo id. Custom-routes block (verbatim modelId) is unaffected.
4. `docs/architecture/omniroute-integration-design.md`: corrected §1.2 and §2.2 — the
   "server strips the suffix" assumption holds only for suffix VARIANTS on a valid combo
   base, NOT for the `tier/` PREFIX; the chat `model` must be a full combo id, and the
   catalog is now populated from `/combos`.

## Tests
- `src/api/providers/__tests__/openai.spec.ts`: added request-path regression (streaming +
  non-streaming) asserting that `openAiModelId = "hybrid/code"` reaches
  `client.chat.completions.create` as `model: "hybrid/code"`.
- `src/api/providers/__tests__/omniroute.spec.ts`: added `omniRouteComboEntrySchema` mapping
  test and `fetchOmniRouteCatalog` tests (hits `/combos`, yields combo ids, falls back to the
  top-level combos array, errors on missing URL).

### Guard proof (test fails without the fix)
Temporarily changed the handler's `modelId` to `(openAiModelId ?? "").split("/").pop()`:
both new openai.spec regression tests FAILED (`model` became `"code"`). Reverted; all pass.
The restore left `src/api/providers/openai.ts` with no diff.

## Commands run (all pass)
- `pnpm --dir packages/types build` → success (regenerates gitignored dist for `@roo-code/types`).
- `pnpm --dir src exec tsc --noEmit` → exit 0.
- `pnpm exec vitest --run api/providers/__tests__/omniroute.spec.ts api/providers/__tests__/openai.spec.ts`
  (cwd `src`) → 2 files, 165 tests passed.
- `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/omniroute.ts
  api/providers/__tests__/omniroute.spec.ts api/providers/__tests__/openai.spec.ts` → exit 0.
  `src/eslint-suppressions.json` had only whitespace/line-ending re-serialization under
  `git diff -w` (no count changed, no entry added/removed); reverted to avoid churn.
  `omniroute.ts` is not in the suppressions file (0 suppressions).
- `pnpm --dir packages/types exec eslint --max-warnings=0 src/providers/openai.ts` → exit 0.

## Scope notes
- Did NOT touch `src/core/task/parallelWorkerRouting.ts` or reader-route logic (out of scope).
- No `.changeset`, no CHANGELOG edits.
- `.agents/tasks/omniroute-integration/plan.md` had a pre-existing uncommitted modification not
  made by this task; it was left untracked/unstaged and NOT included in the commit.
