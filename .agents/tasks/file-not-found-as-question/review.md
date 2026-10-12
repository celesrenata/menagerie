# File not found as a recoverable question — code review

Two additive layers make a missing file a question rather than a hard failure. Layer 2 (`ReadFileTool`) intercepts the `ENOENT` thrown by `fs.stat`/`fs.readFile` in both read loops and emits a structured "did you mean" notice carrying up to five ignore-filtered near-match PATHS, marking the entry `status: "blocked"` + `notFound: true` and excluding it from the turn-failure aggregate so a not-found read never sets `didToolFailInCurrentTurn`. Layer 3 (`normalizeWorkerResult`) refines salvage inference so a missing REFERENCED INPUT a worker was told to read becomes `blocked` with a synthesized path-confirmation blocker, while produced/expected-file failures and raw write-side ENOENT stay `failed`. No `WorkerResult` schema change, no new user setting; the commit (`67b984b13`) touches exactly the six source/test files and the task docs named by the design.

Watch for: the input-vs-produced boundary — the central safety invariant that a real failure can never be downgraded to `blocked` — rests entirely on `classifyNotFound`'s produced-first ordering and its exclusion of generic `no such file` phrasing from the input tier. This was verified against the source and is pinned by adversarial tests (confirmed).

**Verdict**: APPROVED

## High-level view

The input-vs-produced distinction holds. `classifyNotFound` tests the produced tier first and short-circuits to `"produced"` → `failed`; the produced tier matches raw write errno (`ENOENT … open`, `no such file or directory … open/write/mkdir/create`) with or without narration, so a worker that fails to write into a missing parent directory stays `failed`. The input tier is deliberately restricted to read-side vocabulary (`referenced input not found`, `could not find … input`, `input … not found`, and the Layer-2 markers `Not found:` / `did you mean`); generic `no such file` is excluded. Only a missing READ input is downgraded to `blocked` — a created/edited file, a required downstream output, and a verification-existence criterion all remain failures (confirmed via the diff and the test matrix).

The suggestion search returns PATHS only, is capped at 5, performs exactly one workspace enumeration per not-found read, and applies both `isAccessAllowed` (rooIgnore) and `isDeniedRead` (denylist) after ranking and before the cap trim, so a denied top hit does not consume a slot. The per-candidate `knownTarget` bypass is intentional and mirrors the read tool's own gate (confirmed).

No downstream artifact or produced output is at risk of being masked: the only read-input path becomes `blocked`, enforced by the produced-first ordering. The `FileResult.notFound` flag is excluded from the `executeNew` Phase-4 `hasErrors` predicate so a not-found read does not trip the turn-failure flag, while rooIgnore/denylist blocks (which leave `notFound` unset) are still counted exactly as before. The legacy render loop already keyed the flag only on `status === "error"`, so the two paths are now consistent.

No `WorkerResult` schema change (status/blockers already existed), no new user setting (the cap is a hard-coded constant, so the Persisted Setting Checklist does not apply), and no change to the 64k reader cap, read-denylist/budget, or prose-salvage. The single structural cast (`as NodeJS.ErrnoException` in `isEnoent`) is documented; no `as any`, no floating promises, no suppression-count change, no changeset/CHANGELOG edits.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. All prior design-review NITs (rounds 1–3) are reflected in the implementation and pinned by tests.

</details>

<details>
<summary>Details</summary>

### Input-vs-produced boundary — the safety pin

`classifyNotFound(text)` (in `normalizeWorkerResult.ts`) is the single owner of the distinction, and the ordering is correct: the produced tier is evaluated before the input tier and before the pre-existing generic `blocked`/`blocker:` rule in `inferProseStatus`. The produced tier matches the raw write errno via `/\benoent\b.*\bopen\b/` and `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/`, so a bare `ENOENT: no such file or directory, open 'dist/output.json'` with no narration resolves to `failed` — the exact "missing OUTPUT must stay failed" case the gate requires. The input tier omits the generic `/\bno such file\b/` and `/\b(file|path) .*\bnot found\b/` patterns entirely, which is what prevents a write-ENOENT from being read as an input miss.

The gate asks whether any path could downgrade a real failure (a just-created/edited file going missing, a required downstream artifact being absent, or a verification whose criterion IS the file's existence) to `blocked`/`ok`. Traced through the code: a produced-vocabulary message or any raw write errno hits `"produced"` → `failed` first; `verification failed: … does not exist` matches `/\bverification (failed|missing)\b/` → `failed`; `expected output … missing` matches the expected-artifact pattern → `failed`. Only read-framed input vocabulary reaches `"input"` → `blocked`. The input→produced direction is never crossed because produced short-circuits. This is pinned by tests: the bare write-ENOENT (`failed`, `blockers: []`), the narrated write-ENOENT, the produced-negation breadth (`was never written`, `was not generated`, `cannot proceed: … never written`), and the ordering guard (`failed to create output.json (did you mean dist/output.json?)` → `failed`, proving the `did you mean` input marker does not win over produced). The regression pin `I am blocked: the web/ directory is missing.` stays `blocked` with no synthesized blocker, confirming no not-found reinterpretation of ordinary blocked prose.

### Suggestion search — paths-only, bounded, ignore-filtered

`suggestNearbyPaths` requests `searchWorkspaceFiles(basename, cwd, cap*4)`, keeps only `type === "file"`, re-ranks by tier (exact basename case-sensitive, then case-insensitive, then stem, then residual fzf order), de-duplicates stably, then filters each candidate through `isAccessAllowed` AND `!isDeniedRead(..., { knownTarget })` before pushing up to `cap` results. The filter runs before the cap trim, so a denied top hit does not starve the list — this is why `cap*4` headroom is requested. The return is POSIX-relative paths only; the tests assert entries match `/^[\w./-]+$/` and contain no newlines, pinning the no-content-leak contract. The gate's "dumps file contents / ignores denylist / unbounded" concerns are all closed: the helper never reads content, applies both gates, and caps at 5. The per-candidate `knownTarget` bypass (a user-named Known_Target denylisted path is allowed to surface) is intentional and matches the read tool's own gate; it is covered by both a dropped-non-known-target and an allowed-known-target test.

### Turn-failure flag and render-path consistency

`FileResult.notFound` is excluded from the `executeNew` Phase-4 predicate (`r.status === "error" || (r.status === "blocked" && !r.notFound)`), so a not-found read does not set `didToolFailInCurrentTurn`, while rooIgnore/denylist blocks (notFound unset) remain counted — behavior-preserving for every existing blocked entry. The `executeLegacy` catch sets `nativeContent` (not `content`), matching the legacy blocked render which pushes `nativeContent ?? "File: …\nBlocked"` with no `content` fallback; setting `content` would have dropped the notice. The ENOENT branch is the first statement in each catch and `continue`s/`return`s before the generic `status: "error"` + `say("error")`, so a not-found read emits no error-channel narration. The integration tests assert the notice content, that `say("error", …)` is not called, that the flag stays false, and that a non-ENOENT `EACCES` still produces `status: "error"` + `say("error")` + flag set — the backward-safety boundary.

### Scope, schema, settings, and hygiene

The commit changes only the helper, its spec, `ReadFileTool.ts`, `normalizeWorkerResult.ts`, its spec, and the one-sentence `read_file.ts` prompt string — matching the design's file list with no scope creep. No `WorkerResult` schema change (the gate's forbidden change): `status: "blocked"` and `blockers: string[]` already existed; only the value and conditional blocker population changed. No new user setting, so the Persisted Setting Checklist / `cachedState` binding does not apply. `src/eslint-suppressions.json`, `.changeset`, and CHANGELOG files are untouched. The only cast is the documented `as NodeJS.ErrnoException` structural cast in `isEnoent`; no `as any` was added.

### Verification evidence

The coder's `verification.md` records `check-types` exit 0; the three focused specs passing together (119 tests); the full `core/tools/__tests__` regression suite green (630 tests); `eslint --prune-suppressions --max-warnings=0` clean on all seven touched files with `eslint-suppressions.json` unchanged; and a clean production bundle. The evidence is specific (command lines, pass counts, exit codes) and maps to the acceptance criteria via the included test matrix. Per the review mandate the suites were not re-run; the diff and tests corroborate the evidence (the asserted test behaviors are present in the committed spec files), leaving no articulable doubt that would warrant a spot-check.

</details>

<details>
<summary>File map</summary>

- `src/core/tools/helpers/notFoundSuggestions.ts` (new) — `isEnoent`, `formatNotFoundNotice`, `suggestNearbyPaths` (ranked, ignore/denylist-filtered, capped, paths-only).
- `src/core/tools/helpers/__tests__/notFoundSuggestions.spec.ts` (new) — helper unit tests: guard, notice formatting, ranking tiers, filtering, known-target bypass, cap, folders excluded, paths-only.
- `src/core/tools/ReadFileTool.ts` — `notFound?` field; ENOENT branches in both read loops; Phase-4 predicate excludes `notFound`.
- `src/core/tools/__tests__/readFileTool.spec.ts` — not-found integration tests (new + legacy paths, EACCES-still-fatal, flag assertions).
- `src/core/task/normalizeWorkerResult.ts` — `classifyNotFound`, `buildPathConfirmationBlocker`, refined `inferProseStatus`, conditional `blockers`.
- `src/core/task/__tests__/normalizeWorkerResult.spec.ts` — input/produced/write-errno classification cases + blocker extraction + regression pins.
- `src/core/prompts/tools/native-tools/read_file.ts` — one sentence documenting the not-found "did you mean" behavior.

Full diff: `git show 67b984b13`.

</details>
