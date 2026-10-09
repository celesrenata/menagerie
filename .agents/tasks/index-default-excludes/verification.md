# Verification — stop the code indexer from exploding block counts on large monorepos

Date: 2026-10-09

## What changed

Durable fix so the menagerie codebase indexer stops indexing huge i18n/doc trees and can never silently
attempt an unbounded number of files (triggering case: OmniRoute indexed ~700,000 blocks).

1. **New index-only constants** in `src/services/code-index/constants/index.ts`:
   - `INDEX_EXCLUDED_DIRS = ["i18n", "locales", "translations"]` (directory-name based, documented in a comment).
     Deliberately NOT added to `src/services/glob/constants.ts` `DIRS_TO_IGNORE`, which backs the agent's general
     `list_files` tools.
   - `MAX_INDEX_SCAN_FILES = 25_000` — pre-parse file cap, a tighter backstop below the existing
     `MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000`.
2. **New helper** `src/services/code-index/shared/index-excluded-dirs.ts` — `isPathInIndexExcludedDirectory()`
   mirrors the segment-equality + `/dir/` substring semantics of `isPathInIgnoredDirectory()` but reads the
   index-only list.
3. **Full scanner** (`src/services/code-index/processors/scanner.ts`):
   - `supportedPaths` filter now excludes a path when `isPathInIgnoredDirectory` OR
     `isPathInIndexExcludedDirectory` is true.
   - After filtering, if `supportedPaths.length > MAX_INDEX_SCAN_FILES`, emit one `onError` warning
     (`embeddings:scanner.indexScanCapped`) and truncate to the cap before parsing.
4. **File-watcher / incremental path** (`src/services/code-index/processors/file-preparation.ts`): `getSkipReason()`
   returns a skip reason for files in an index-excluded directory, keeping the watcher consistent with the full scan.
5. **i18n**: added `scanner.indexScanCapped` with the `{{maxFiles}}` placeholder to all 17 `embeddings.json` locales.

### Tradeoff recorded (also in code comments)

A precise per-block mid-scan abort would require reworking the existing parallel `pLimit` / mutex / `AbortSignal`
batching machinery (fragile and invasive). The pre-parse file-count cap + prominent warning through the existing
`onError`/status path is deterministic, cheap, and surfaces cleanly. The shared `DIRS_TO_IGNORE` denylist was left
untouched so the agent's general file listing still shows i18n/locale/translation directories.

## Test commands and results

All run from `src/` (the package that declares Vitest), single-run (`vitest run`).

### Focused affected suites

```
npx vitest run \
  services/code-index/processors/__tests__/scanner.spec.ts \
  services/code-index/processors/__tests__/file-watcher.spec.ts \
  services/code-index/processors/__tests__/file-preparation.spec.ts \
  services/glob/__tests__/list-files.spec.ts \
  services/glob/__tests__/list-files-limit.spec.ts \
  i18n
```

Result: **PASS** — Test Files 7 passed (7); Tests 130 passed (130).

New/extended cases:
- scanner.spec.ts: excludes files under `i18n/`, `locales/`, `translations/` while identical files under normal
  `src/` dirs are still parsed; markdown in normal dirs still indexed (pre-existing test unchanged); cap triggers a
  single `onError` warning and parses no more than `MAX_INDEX_SCAN_FILES`; cap does NOT fire for a small file count.
- file-watcher.spec.ts: create events for files under `i18n/`/`locales/`/`translations/` are skipped (not upserted).
- list-files.spec.ts: shared `DIRS_TO_IGNORE` does not contain `i18n`/`locales`/`translations`; recursive `listFiles`
  still surfaces i18n content (agent file listing unchanged).

## ESLint results

Per AGENTS.md, run with `--prune-suppressions --max-warnings=0` on every edited `.ts` file:

```
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 \
  services/code-index/constants/index.ts \
  services/code-index/shared/index-excluded-dirs.ts \
  services/code-index/processors/scanner.ts \
  services/code-index/processors/file-preparation.ts \
  services/code-index/processors/__tests__/scanner.spec.ts \
  services/code-index/processors/__tests__/file-watcher.spec.ts \
  services/glob/__tests__/list-files.spec.ts
```

Result: **exit 0, 0 warnings**. `git diff src/eslint-suppressions.json` is empty — suppression counts did NOT
increase for any file. New code added no `@typescript-eslint/no-explicit-any` violations.

## Type check

```
pnpm --dir src exec tsc --noEmit
```

No new errors in any touched file (verified by grepping the output for `code-index`, `index-excluded`,
`list-files.spec`, `constants/index`, `embeddings` — no matches). Pre-existing, unrelated errors remain in
`core/task/__tests__/*` and `core/task/task-persistence/apiMessages` (not touched by this change).
