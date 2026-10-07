# Verification — File Not Found as a Question

First implementation iteration (no `review.json` present). Implemented per the
approved plan (`plan.md`) and design (`design.md`, APPROVED round 3). All
commands run from the repo root; `src/` declares Vitest and the build scripts.

## What was implemented

### Layer 2 — ReadFileTool structured not-found + suggestions

- **New helper** `src/core/tools/helpers/notFoundSuggestions.ts`:
  - `isEnoent(error)` — type-guard: `error instanceof Error && (error as
    NodeJS.ErrnoException).code === "ENOENT"`. The single structural cast is a
    documented Node-errno cast (comment in file), NOT `as any`.
  - `formatNotFoundNotice(relPath, suggestions)` — always emits a leading
    `File: <relPath>` line and the stable `Not found:` token. Match case lists
    `Did you mean one of these? …` with `  - <candidate>` lines; no-match case
    states "no similar files were found in the workspace."
  - `suggestNearbyPaths({ missingRelPath, cwd, denylist, isAccessAllowed,
    isKnownTarget, cap=5 })` — one `searchWorkspaceFiles(basename, cwd, cap*4)`
    enumeration, filtered to `type === "file"`, re-ranked by tier
    (0: exact basename case-sensitive, 1: exact basename case-insensitive,
    2: stem match, 3: residual fzf order), de-duplicated and stable. Each
    candidate must pass BOTH `isAccessAllowed` (rooIgnore) AND
    `!isDeniedRead(..., { knownTarget })` BEFORE the cap trim. Returns POSIX
    relative PATHS only, length ≤ cap, possibly empty. Defensive `try/catch`
    returns `[]` with `console.debug` (not `console.error`).

- **`src/core/tools/ReadFileTool.ts`:**
  - Added `notFound?: boolean` to the `FileResult` interface.
  - `executeNew` Phase-3 per-file `catch`: ENOENT branch is the FIRST statement
    — builds suggestions + notice, calls `updateFileResult(relPath, { status:
    "blocked", notFound: true, notice, nativeContent: notice })` and `continue`,
    before the generic `status:"error"` + `say("error")`. The ENOENT branch
    emits NO `say("error")`.
  - `executeNew` Phase-4 predicate changed to
    `r.status === "error" || (r.status === "blocked" && !r.notFound)` so a
    not-found entry does NOT set `didToolFailInCurrentTurn`; rooIgnore/denylist
    blocks (notFound unset) are still counted — unchanged.
  - `executeLegacy` `readApprovedFile` `catch`: same ENOENT branch — sets
    `status="blocked"`, `notFound=true`, and `nativeContent` (NOT `content`,
    because the legacy blocked render pushes `nativeContent ?? "…\nBlocked"`
    with no `?? content` fallback). Legacy render sets the turn-failure flag
    only on `status==="error"`, so no predicate change needed there.

- **`src/core/prompts/tools/native-tools/read_file.ts`:** added one sentence to
  the tool description documenting that a missing path returns a "did you mean"
  candidate list to re-read, not a fatal error. String edit only.

### Layer 3 — normalizeWorkerResult: missing input → blocked

- **`src/core/task/normalizeWorkerResult.ts`:**
  - New exported `classifyNotFound(text): "input" | "produced" | "none"` —
    receives the already whitespace-collapsed, lowercased text (identical input
    to `inferProseStatus`). PRODUCED tier tested FIRST (wins over input):
    `failed to (create|write|produce|generate)`, `could not (create|write|
    produce|generate)`, `expected (output|artifact|file) … (missing|not found|
    does not exist|absent)`, `verification (failed|missing)`, the broadened
    negation `(output|artifact) … (missing|(not|never|wasn't|was not)
    (created|produced|written|generated))`, and the two RAW write-errno patterns
    `\benoent\b.*\bopen\b` and `\bno such file or directory\b.*\b(open|write|
    mkdir|create)\b`. INPUT tier restricted to read-only signals: `referenced
    input not found`, `could not find (the) input`, `input … not found`, the
    Layer-2 markers `not found:` and `did you mean`. Generic `no such file` /
    `<path> not found` are DELIBERATELY EXCLUDED from the input tier.
  - New exported `buildPathConfirmationBlocker(text)` — extraction order:
    (i) first token with `/` ending in a known extension; (ii) else first
    known-extension token (`ya?ml|md|json|ts|tsx|txt|toml`); (iii) else the
    generic fallback `Referenced input not found (see summary). Confirm the
    correct path.` Appends any `did you mean`/`nearest matches` list if present.
  - `inferProseStatus` runs `classifyNotFound` at the TOP: `"produced"` →
    `failed`, `"input"` → `blocked`, else the pre-existing rules unchanged.
  - `salvagedResult` populates `blockers: [buildPathConfirmationBlocker(text)]`
    only when `status === "blocked"` AND `classifyNotFound(text) === "input"`;
    otherwise `blockers: []` as before. Full prose still preserved in `summary`.

## Detection points

- Layer 2: the ENOENT thrown by `fs.stat`/`fs.readFile` inside the two sibling
  read loops (`executeNew` Phase-3 `catch`, `executeLegacy` `readApprovedFile`
  `catch`). Detection is in the catch (not a pre-`stat` `fs.access` probe) —
  avoids a second syscall on the hot success path and a TOCTOU window.
- Layer 3: `classifyNotFound` keys on the same vocabulary Layer 2 emits
  (`Not found:` / `did you mean`), plus explicit read-side input framings, while
  routing produced/write failures to `failed`.

## Suggestion mechanism + cost bound

- Reuses the already-present ripgrep + `fzf` enumeration via
  `searchWorkspaceFiles(basename, cwd, cap*4)`. No new fuzzy-match dependency.
- Exactly ONE workspace enumeration per not-found read; no file contents are
  ever read or returned (suggestions are PATHS only). The helper is invoked only
  on the ENOENT branch, so successful reads pay nothing.
- Cap = 5. `searchWorkspaceFiles` already swallows ripgrep/enumeration failures
  to `[]`; the helper's own `try/catch` is a defensive guard only.
- Compliance boundary: ripgrep's built-in `-g !` excludes are a performance
  convenience; FR-4/AC-4 are satisfied by the helper's own post-filter
  (`isAccessAllowed` + `isDeniedRead` with per-candidate `knownTarget` bypass).

## Input-vs-produced classification — "cannot downgrade a real failure"

Two mechanisms, in order:

1. **Produced-first short-circuit, broadened to raw write-side ENOENT.**
   `classifyNotFound` tests the produced tier before the input tier. The
   produced tier matches a worker's raw write errno (`ENOENT … open`,
   `no such file or directory … open/write/mkdir/create`) with OR without
   narration, plus all produced narration vocabulary and the broadened
   `never`/`wasn't`/`was not`/`generated` negations.
2. **Input tier restricted to read-only signals.** The generic
   `\bno such file\b` / `\b(file|path) … not found\b` patterns are NOT in the
   input tier — a failing `fs.writeFile`/`fs.mkdir` into a missing parent throws
   `ENOENT: no such file or directory, open '<path>'`, which cannot be
   distinguished from a read-ENOENT by generic phrasing and must stay `failed`.
   The input tier keys only on vocabulary a write path never emits.

Consequences (all pinned by tests): a created/edited file going missing, a
required OUTPUT a downstream step depends on, and a verification whose criterion
IS the file's existence all stay `failed`. Only a missing REFERENCED INPUT the
worker was told to READ becomes `blocked`. Genuinely-empty output is handled
earlier (`failed`) and never reaches `inferProseStatus`. Prose-salvage is not
regressed: non-conforming prose still salvages with full text in `summary`.

## Commands run and results

### 1. Type check — exit 0

```
$ pnpm --dir src check-types
> tsc --noEmit
(exit 0)
```

Note: a Node engine-version WARN is emitted (wanted 22.23.1, current 24.21.0);
it is pre-existing and does not affect any exit code.

### 2. Focused Vitest (all three specs together) — exit 0

```
$ pnpm --dir src exec vitest run \
    core/tools/helpers/__tests__/notFoundSuggestions.spec.ts \
    core/task/__tests__/normalizeWorkerResult.spec.ts \
    core/tools/__tests__/readFileTool.spec.ts
 Test Files  3 passed (3)
      Tests  119 passed (119)
EXIT=0
```

Breakdown confirmed in separate runs:
- `notFoundSuggestions.spec.ts` + `normalizeWorkerResult.spec.ts`: 39 passed.
- `readFileTool.spec.ts`: 80 passed (4 new not-found tests + 76 existing).

Regression guard — the full existing tool suite still green:

```
$ pnpm --dir src exec vitest run core/tools/__tests__
 Test Files  29 passed (29)
      Tests  630 passed (630)
(exit 0)
```

### 3. ESLint with --prune-suppressions on every touched file — exit 0, no output

```
$ pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 \
    core/tools/helpers/notFoundSuggestions.ts \
    core/tools/helpers/__tests__/notFoundSuggestions.spec.ts \
    core/tools/ReadFileTool.ts \
    core/tools/__tests__/readFileTool.spec.ts \
    core/task/normalizeWorkerResult.ts \
    core/task/__tests__/normalizeWorkerResult.spec.ts \
    core/prompts/tools/native-tools/read_file.ts
(no output, exit 0)
```

`src/eslint-suppressions.json` was NOT modified (`git status --short` shows it
unchanged), so no per-file suppression count increased. No `as any`, no floating
promises; the only cast is the documented Node-errno structural cast in
`isEnoent`.

### 4. Production bundle — exit 0

```
$ pnpm --dir src bundle
> node esbuild.mjs
… (copies assets, locales, wasms) …
[esbuild-problem-matcher#onEnd]
(exit 0)
```

## Repo-rules compliance

- No `.changeset` files and no `CHANGELOG.md` / `src/CHANGELOG.md` edits.
- No new user setting added (design §Settings impact), so the Persisted Setting
  Checklist / `SettingsView` / `cachedState` are untouched.
- Did not touch timeout-config, routeCapacityMap/scheduler, the 64k reader cap,
  read-denylist contents/budget, taskLifecycle (#1469/#1021), or orchestrator
  routing.

## Test matrix (acceptance mapping)

| Case | Expectation | AC |
|------|-------------|----|
| ENOENT read, near matches exist | `blocked` + `notFound`, notice `File:…\nNot found:…\nDid you mean`; no `say("error")`; flag not set | AC-2, AC-10 |
| ENOENT read, no near matches | notice states "no similar files"; no candidate list | AC-3 |
| EACCES read | still `status:"error"` + `say("error")` + flag set | AC-6, NFR-1 |
| suggestions: exact basename > substring; stem > residual | tier ranking | FR-2 |
| non-known-target denylisted top hit | dropped, no cap slot consumed | AC-4 |
| known-target denylisted candidate | allowed (intentional bypass) | AC-4/finding #4 |
| rooIgnore-blocked candidate | dropped | AC-4 |
| cap enforced | ≤ 5 | FR-5 |
| only `type:"file"` | folders ignored | FR-2 |
| suggestions contain paths only | no content bytes | AC-5 |
| read-side-framed missing input | `blocked` + path-confirmation blocker w/ path | AC-7 |
| verbatim collapsed Layer-2 notice | `blocked` + blocker | finding #1 |
| produced failure prose | `failed` | AC-8 |
| bare raw write-ENOENT | `failed`, never `blocked` | AC-9 |
| narrated write-ENOENT | `failed` | finding #1 |
| produced negations (never/was not written/not generated) | `failed` | finding #2 |
| ordering: "failed to create … did you mean" | `failed` | ordering |
| generic "I am blocked …" prose | stays `blocked`, no synthesized blocker | AC-11 |
| `buildPathConfirmationBlocker` no-slash / two-token / no-token | correct extraction/fallback | finding #3 |
| existing conforming / empty / generic / never-throws | unchanged | AC-11 |
```
