# Implementation Plan — stop the code indexer from exploding block counts on large monorepos

Durable fix so the menagerie codebase indexer stops indexing huge i18n/doc trees and can never silently
attempt an unbounded number of files. Triggering case: OmniRoute indexed ~700,000 blocks (~23,900 scannable
files; ~10,206 markdown under `docs/i18n/`, ~6,400 under `tests/unit/`).

## Design decisions (made here, grounded in the code read)

- **New constant, index-only.** Add `INDEX_EXCLUDED_DIRS` (and a helper) under the code-index service, NOT in
  `src/services/glob/constants.ts`. Rationale: `DIRS_TO_IGNORE` is consumed by `src/services/glob/list-files.ts`,
  which backs the agent's general `list_files`/file-listing tools; adding `i18n`/`locales`/`translations` there
  would hide those dirs from the agent app-wide. The exclusion must apply to the code indexer only.
- **Reuse `isPathInIgnoredDirectory` semantics.** The new filter matches on any path segment equal to an excluded
  name (same segment-wise logic the existing helper uses), so `docs/i18n/...`, `src/i18n/...`, and
  `packages/x/locales/...` are all skipped. A new `isPathInIndexExcludedDirectory(relativePath)` helper lives in
  the code-index service and reuses the exact matching approach already in `glob/ignore-utils.ts` (segment equality
  + `/dir/` substring check), but reads from `INDEX_EXCLUDED_DIRS`. The scanner excludes a path when
  `isPathInIgnoredDirectory(rel)` (unchanged) OR `isPathInIndexExcludedDirectory(rel)` is true.
- **Excluded names (documented in code):** `i18n`, `locales`, `translations`. These are documentation/translation
  trees that are high-volume and low-value for code search; they are directory-name based so nested variants are
  caught. (Note: `tests/unit/` is intentionally NOT added — test code is legitimately searchable; the file/volume
  cap below is the backstop for pathological test trees.)
- **Two enumeration/filter sites, covered consistently.** `grep` confirms exactly two code-index consumers of
  `isPathInIgnoredDirectory`:
  1. `src/services/code-index/processors/scanner.ts` — the full-scan `supportedPaths` filter.
  2. `src/services/code-index/processors/file-preparation.ts` `getSkipReason()` — used by the file-watcher
     (`file-watcher.ts` → `FilePreparation.prepareFile`) for incremental create/change events.
  Both get the new OR-check so a file under an excluded dir is never indexed by either path. (The watcher's
  `createFileSystemWatcher` glob only filters by extension, so the `getSkipReason` gate is the effective exclusion
  for watched files.)
- **Safety cap = file-count cap at the pre-parse filter, with a prominent warning.** The scanner computes
  `supportedPaths` synchronously (an `Array.filter`) before any parsing/batching. The cleanest, least-invasive cap
  is to bound the number of files handed to the parser: if `supportedPaths.length` exceeds a new
  `MAX_INDEX_SCAN_FILES` threshold, truncate to the cap and emit one prominent warning through the existing
  `onError` callback (which the executor already collects into `batchErrors` and logs). This avoids entangling a
  mid-scan abort with the existing parallel `pLimit` / mutex / `AbortSignal` batching machinery (which would be
  fragile and invasive). We still respect `MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000` at the `listFiles` layer; the
  new cap is a second, tighter backstop on *indexable* files after filtering. Chosen value:
  `MAX_INDEX_SCAN_FILES = 25_000` (above every known-good repo but below the OmniRoute pathological ~23,900→ with
  excludes removed it drops well under; the cap only trips on genuinely unbounded trees). Tradeoff documented in a
  code comment: a hard per-block mid-scan abort would be more precise but requires reworking the abort/batch flow;
  the pre-parse file cap + warning is deterministic, cheap, and surfaces through the existing status/error path.
- **No change to supported extensions.** Markdown (`md`, `markdown`) and text stay supported, so a small repo's
  markdown still indexes. The reduction comes only from excluding i18n/locale/translation *directories* and the
  file cap, exactly as required.

## Ordered items

- [ ] 1. Add the index-only constants to `src/services/code-index/constants/index.ts`.
      Under the `Directory Scanner` section add `export const INDEX_EXCLUDED_DIRS = ["i18n", "locales", "translations"] as const`
      with a comment explaining these are index-only (NOT added to `glob/constants.ts` `DIRS_TO_IGNORE` because that
      list backs the agent's general file listing), and `export const MAX_INDEX_SCAN_FILES = 25_000` with a comment
      explaining the cap, its relationship to `MAX_LIST_FILES_LIMIT_CODE_INDEX`, and the tradeoff vs a mid-scan abort.
      Files: `src/services/code-index/constants/index.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` compiles clean (no new type errors).

- [ ] 2. Add the index-only directory matcher helper.
      Create `src/services/code-index/shared/index-excluded-dirs.ts` exporting
      `isPathInIndexExcludedDirectory(filePath: string): boolean` that mirrors the segment-equality + `/dir/`
      substring logic in `src/services/glob/ignore-utils.ts` but reads `INDEX_EXCLUDED_DIRS` from the code-index
      constants. Document in a header comment that it is directory-name based and lists the excluded names. No
      hidden-dir (`.*`) handling — that stays the shared helper's job.
      Files: `src/services/code-index/shared/index-excluded-dirs.ts`
      Verify: `pnpm --dir src exec tsc --noEmit` compiles clean.

- [ ] 3. Apply the exclusion + file cap in the full scanner.
      In `src/services/code-index/processors/scanner.ts` `scanDirectory()`:
      (a) import `isPathInIndexExcludedDirectory` and `MAX_INDEX_SCAN_FILES`; in the `supportedPaths` filter return
      `false` when `isPathInIndexExcludedDirectory(relativeFilePath)` is true (OR-ed with the existing
      `isPathInIgnoredDirectory` check);
      (b) after `supportedPaths` is computed, if `supportedPaths.length > MAX_INDEX_SCAN_FILES`, call `onError?.(...)`
      with a clear capped-index message (new i18n key from item 5) and reassign `supportedPaths` to the first
      `MAX_INDEX_SCAN_FILES` entries before the `parsePromises` map. Add a comment explaining the cap and tradeoff.
      Files: `src/services/code-index/processors/scanner.ts`
      Verify: `npx vitest run src/services/code-index/processors/__tests__/scanner.spec.ts` passes (existing + new
      cases from item 6).

- [ ] 4. Apply the exclusion in the file-watcher/incremental path.
      In `src/services/code-index/processors/file-preparation.ts` `getSkipReason()`, after the existing
      `isPathInIgnoredDirectory(relativeFilePath)` check, add a sibling check: if
      `isPathInIndexExcludedDirectory(relativeFilePath)` return a skip reason (e.g. "File is in an index-excluded
      directory"). Import the helper from item 2. This covers `file-watcher.ts` since it processes files through
      `FilePreparation.prepareFile`.
      Files: `src/services/code-index/processors/file-preparation.ts`
      Verify: `npx vitest run src/services/code-index/processors/__tests__/file-watcher.spec.ts` passes (existing +
      new case from item 6).

- [ ] 5. Add the capped-index warning i18n string to every embeddings locale.
      Under the existing `scanner` object in each `embeddings.json`, add
      `"indexScanCapped": "Code index was capped at {{maxFiles}} files because the workspace has too many indexable files. Add a .rooignore to exclude large directories (e.g. docs, i18n, generated code), then re-index."`
      (translate the value per locale; keep the `{{maxFiles}}` placeholder). The scanner references it via
      `t("embeddings:scanner.indexScanCapped", { maxFiles: MAX_INDEX_SCAN_FILES })`.
      Files: `src/i18n/locales/<lang>/embeddings.json` for all 17 locales (`ca de en es fr hi id it ja ko nl pl pt-BR
      ru tr vi zh-CN zh-TW` — same set as `ls src/i18n/locales`).
      Verify: `npx vitest run src/i18n` passes (i18n key-parity tests, if present) and `pnpm --dir src exec tsc
      --noEmit` is clean; the scanner `t(...)` call resolves.

- [ ] 6. Add/extend code-index tests for exclusion, no-regression, and the cap.
      In `src/services/code-index/processors/__tests__/scanner.spec.ts` add cases, following the existing
      `vi.mock("../../../glob/list-files")` + `parseFile` tracking pattern:
      (a) a path under `i18n/`, `locales/`, and `translations/` is excluded from parsing while an identical file
          under a normal `src/` dir IS parsed (assert `parseFile` called for the normal path, not the excluded ones);
      (b) markdown in a normal directory still parses — reuse/extend the existing "should process markdown files
          alongside code files" test to confirm `README.md`/`guide.markdown` in non-excluded dirs are untouched (no
          regression);
      (c) the cap: mock `listFiles` to return > `MAX_INDEX_SCAN_FILES` supported files; assert `onError` is called
          once with the capped message and that `parseFile` is called no more than `MAX_INDEX_SCAN_FILES` times; and
          a complementary case with a small file count asserts `onError` is NOT called for the cap.
      In `src/services/code-index/processors/__tests__/file-watcher.spec.ts` add a case asserting a create/change
      event for a file under `i18n/`/`locales/` is skipped (result status `skipped`, not upserted).
      Files: `src/services/code-index/processors/__tests__/scanner.spec.ts`,
      `src/services/code-index/processors/__tests__/file-watcher.spec.ts`
      Verify: `npx vitest run src/services/code-index/processors/__tests__/scanner.spec.ts
      src/services/code-index/processors/__tests__/file-watcher.spec.ts` — all pass.

- [ ] 7. Guard the shared `DIRS_TO_IGNORE` / general list-files behavior against regression.
      In `src/services/glob/__tests__/list-files.spec.ts` add a focused assertion that recursive `listFiles` does
      NOT hide directories named `i18n`/`locales`/`translations` (the agent's general file listing must keep showing
      them) — i.e. prove the index-only exclusion did not leak into the shared denylist. Follow the existing
      `mockReaddir` pattern in that file.
      Files: `src/services/glob/__tests__/list-files.spec.ts`
      Verify: `npx vitest run src/services/glob/__tests__/list-files.spec.ts
      src/services/glob/__tests__/list-files-limit.spec.ts` — all pass (existing behavior unchanged).

- [ ] 8. Lint the touched files and confirm suppression counts did not increase.
      Run eslint with suppression pruning on each edited `.ts` file per AGENTS.md.
      Files: all files edited above.
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0
      services/code-index/constants/index.ts services/code-index/shared/index-excluded-dirs.ts
      services/code-index/processors/scanner.ts services/code-index/processors/file-preparation.ts
      services/code-index/processors/__tests__/scanner.spec.ts
      services/code-index/processors/__tests__/file-watcher.spec.ts services/glob/__tests__/list-files.spec.ts`
      — no new warnings, suppression counts in `src/eslint-suppressions.json` not increased.

- [ ] 9. Full focused verification.
      Run the whole affected test surface together and a type check to confirm nothing else broke.
      Files: none (verification only).
      Verify: `pnpm --dir src exec tsc --noEmit` clean AND `npx vitest run src/services/code-index src/services/glob`
      — all suites pass.

## Notes / assumptions

- `MAX_INDEX_SCAN_FILES = 25_000` is a judgement call; if a maintainer prefers the task's suggested
  `MAX_INDEXED_BLOCKS ≈ 100000`, that would require a mid-scan block counter and abort, which conflicts with the
  existing parallel batch/abort structure — hence the file-count-at-filter approach instead. The constant is in one
  place and trivially tunable.
- `tests/unit/` was deliberately NOT added to `INDEX_EXCLUDED_DIRS` (test code is legitimately searchable); the file
  cap plus `.rooignore` guidance covers pathological test trees without a blanket exclusion.
- If i18n key-parity tooling rejects adding a key to only some locales, item 5 adds the key to all 17 locales
  (English value may be reused as a placeholder translation where a localized string is unavailable).
