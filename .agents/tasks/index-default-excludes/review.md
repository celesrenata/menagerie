# Code-index-only i18n/translation exclusion plus a pre-parse scan cap

The code indexer gained a code-index-scoped exclusion layer so it skips directory trees named `i18n`, `locales`, or `translations` out of the box, plus a hard pre-parse file-count cap (`MAX_INDEX_SCAN_FILES = 25_000`) that bounds how many files reach the parser on a single full scan. The motivating case was OmniRoute exploding to ~700k indexed blocks by fully parsing huge translation/doc trees. The change is deliberately confined to `src/services/code-index/`: the shared `DIRS_TO_IGNORE` denylist and `src/services/glob/list-files.ts` that back the agent's general `list_files` tools are untouched, so i18n/locale directories still appear in agent file listings. Supported extensions and markdown support are unchanged. The exclusion is applied in both code-index file-enumeration paths — the full scanner and the incremental file-watcher.

Watch for: the capped-scan warning reaches the user only through the existing `onError` → `batchErrors` → `console.error` path and is converted to a thrown, UI-visible error only when indexing substantially fails; on a successful-but-truncated scan it is logged but does not raise a status error (possible). This matches the recorded tradeoff and the brief's "existing onError/status path" wording, so it is informational, not blocking.

**Verdict**: APPROVED

## High-level view

The new exclusion list `INDEX_EXCLUDED_DIRS = ["i18n", "locales", "translations"]` and the cap constant live in `src/services/code-index/constants/index.ts`, not in `src/services/glob/constants.ts`. The highest-priority constraint — leave the shared denylist and the general list-files path alone — holds: the commit touches no production glob file. Only a test was added under `src/services/glob/__tests__/` to lock in that the shared list is unaffected.

Matching uses `isPathInIndexExcludedDirectory()` in a new `shared/index-excluded-dirs.ts`, which mirrors the segment-equality + `/dir/` substring semantics of the shared `isPathInIgnoredDirectory()`. It is wired into the scanner's `supportedPaths` filter and into the file-watcher's `getSkipReason()` in `file-preparation.ts`. Those are the only two file-enumeration entry points in `code-index/`, so coverage is complete.

The safety cap is applied after all other filtering, so it bounds the files that would actually be parsed and embedded; it stays below the pre-existing `MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000` applied at the `listFiles` layer, which is still respected. The chosen behavior is truncate-and-warn (not hard-abort), surfaced via `onError`. This is an intentional tradeoff recorded in both the code and verification notes, chosen over reworking the parallel batching machinery for a mid-scan abort.

Tests assert both the excluded and the not-excluded cases, the markdown-in-normal-dir no-regression, the shared list-files behavior being unchanged, and both the cap-trigger and cap-no-trigger cases. Lint ran clean with no suppression-count increase, and no `.changeset`/CHANGELOG files were touched.

<details>
<summary>Issues (1)</summary>

1. **Capped-scan surfacing is log-only on success** — the cap warning flows through `onError`/`batchErrors`/`console.error` but is only promoted to a thrown, UI-visible error when indexing substantially fails (`validateFullScan`); a successful-but-truncated scan logs the warning without a status error. Matches the recorded tradeoff and the brief's "existing onError/status path"; informational only, no action required unless a visible capped status is desired. (possible)

</details>

<details>
<summary>Details</summary>

### Constants live under code-index, not in the shared denylist (constraints 1, 2)

`INDEX_EXCLUDED_DIRS = ["i18n", "locales", "translations"] as const` and `MAX_INDEX_SCAN_FILES = 25_000` are both defined in `src/services/code-index/constants/index.ts`, right below the pre-existing `MAX_LIST_FILES_LIMIT_CODE_INDEX`. A doc comment on the exclusion list explicitly states it must not be added to `src/services/glob/constants.ts`.

The highest-priority constraint is satisfied. `git show HEAD --stat` lists no production glob files; `grep` confirms `src/services/glob/constants.ts` still contains none of `i18n`, `locales`, `translations`. The only glob-area change is an added test in `src/services/glob/__tests__/list-files.spec.ts` that asserts the shared denylist does not contain those names and that recursive `listFiles` still surfaces i18n content. `list-files.ts` itself is unmodified.

### Matching semantics and both enumeration paths (constraint 3)

`src/services/code-index/shared/index-excluded-dirs.ts` exposes `isPathInIndexExcludedDirectory(filePath)`, which normalizes separators, checks each path segment for exact equality against the excluded names, and also checks for `/dir/` appearing anywhere in the path — the same two-part matching the shared `isPathInIgnoredDirectory()` uses. It reads only `INDEX_EXCLUDED_DIRS`, so the two lists stay independent. The excluded names include all three required: `i18n`, `locales`, `translations`.

A grep of `code-index/` for file-enumeration shows exactly two entry points, and both are covered:

```
scanner.ts        -> supportedPaths filter adds `|| isPathInIndexExcludedDirectory(...)`
file-preparation.ts -> getSkipReason() returns "File is in an index-excluded directory"
```

The watcher path (`file-preparation.ts getSkipReason`) is what the incremental `FileWatcher` uses per file, keeping create/change events consistent with the full scan. No third enumeration path exists in `code-index/`.

### Safety cap: value, placement, behavior (constraint 4)

The cap is `25_000`, applied in `scanner.ts` after `.rooignore` / ignored-dir / extension / index-exclude filtering, so it bounds files that would actually be parsed. When `supportedPaths.length > MAX_INDEX_SCAN_FILES`, the scanner emits one `onError(new Error(t("embeddings:scanner.indexScanCapped", { maxFiles })))` and slices the list to the cap before parsing. It warns-and-truncates rather than hard-aborting, which is the recorded, intentional tradeoff (a mid-scan per-block abort would entangle the `pLimit`/mutex/`AbortSignal` batching). `MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000` is still passed to `listFiles`, so the new cap is a tighter backstop beneath it, not a replacement.

The surfacing nuance: `onError` pushes into `batchErrors` in `code-index-scan-executor.ts`, and `validateFullScan` only throws when `indexed === 0 && found > 0`, or when `(found - indexed) / found > 0.1`, or `firstError && indexed === 0`. A scan that is merely capped but otherwise indexes fine will log the warning via `console.error` and retain it in `batchErrors`, but will not raise a user-visible status error. The brief asks that the cap "surfaces a clear capped status/error via the existing onError/status path" — it does traverse the existing `onError` path, so this is consistent with the stated requirement and the recorded tradeoff. Flagged as a `possible` informational item in case a visible capped status is desired later; not blocking.

### Extensions and markdown untouched (constraint 5)

`src/services/code-index/shared/supported-extensions.ts` is not in the commit. `scannerExtensions = allExtensions` ("Include all extensions including markdown for the scanner") is unchanged, so markdown still indexes in normal directories; a small repo's markdown is unaffected. The scanner's extension gate (`scannerExtensions.includes(ext)`) is identical to before.

### Test coverage (constraint 6)

`scanner.spec.ts` asserts both directions in one test: `src/app.ts` and `src/components/Button.tsx` are parsed while identical-looking files under `docs/i18n/`, `packages/x/locales/`, and `src/translations/` are not (`parseFile` called exactly twice). The pre-existing "process markdown files alongside code files" test is retained, covering markdown-in-normal-dir no-regression. The cap has both a trigger test (`MAX_INDEX_SCAN_FILES + 50` files → exactly one `onError`, parsed count `<= cap`) and a no-trigger test (two files → `onError` not called). `file-watcher.spec.ts` asserts create events under i18n/locales/translations are skipped while a normal `.ts` file succeeds. `list-files.spec.ts` asserts the shared denylist excludes those names and that recursive listing still surfaces i18n content. The exclude and not-excluded cases, markdown no-regression, shared-list no-change, and cap trigger/no-trigger are all present — a default-wiring mistake could not hide behind an exclude-only assertion.

### Lint, changesets, evidence (constraints 7, 8)

`src/eslint-suppressions.json` is not in the commit, and the verification notes record `--prune-suppressions --max-warnings=0` returning 0 warnings on every edited file with an empty suppressions diff — no count increase. No `.changeset` or CHANGELOG file appears in the commit stat. The verification.md names concrete commands with results: `npx vitest run` over the seven affected spec files reporting 7 files / 130 tests passed, plus the specific new/extended cases described above. The evidence names assertions, not just an exit code, so the include-and-exclude coverage is demonstrated rather than assumed.

</details>

<details>
<summary>File map</summary>

- `src/services/code-index/constants/index.ts` — adds `INDEX_EXCLUDED_DIRS` and `MAX_INDEX_SCAN_FILES` with explanatory comments.
- `src/services/code-index/shared/index-excluded-dirs.ts` — new `isPathInIndexExcludedDirectory()` helper (segment + `/dir/` matching).
- `src/services/code-index/processors/scanner.ts` — applies the index-exclude filter and the post-filter cap with one `onError` warning.
- `src/services/code-index/processors/file-preparation.ts` — watcher `getSkipReason()` skips index-excluded dirs.
- `src/i18n/locales/*/embeddings.json` (17 locales) — adds `scanner.indexScanCapped` with `{{maxFiles}}`.
- `src/services/code-index/processors/__tests__/scanner.spec.ts` — exclude/not-exclude, cap trigger/no-trigger.
- `src/services/code-index/processors/__tests__/file-watcher.spec.ts` — watcher skip cases.
- `src/services/glob/__tests__/list-files.spec.ts` — shared denylist unaffected; i18n still listed.
- `.agents/tasks/index-default-excludes/{plan,verification}.md` — task notes.

Full diff: `git show 93276654`.

</details>
