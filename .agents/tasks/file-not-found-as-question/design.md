# File Not Found as a Question — Requirements & Design

## Requirements

### Summary

Make "file not found" a **recoverable question** rather than a hard failure in two
layers of the Menagerie VS Code extension:

- **Layer 2 (read tool):** when `read_file` is asked for a path that does not
  exist, return a structured, model-actionable result — "X not found at `<path>`;
  did you mean: `<candidates>`?" — with a short, ignore-filtered list of
  near-match PATHS from the workspace, instead of a bare `fs` error the model
  treats as fatal.
- **Layer 3 (worker result semantics):** when a parallel worker cannot proceed
  because a **referenced input** it was told to read is missing (and the read
  tool's suggestions did not resolve it), its `WorkerResult` is `blocked` with a
  specific path-confirmation blocker, **not** `failed`.

The non-negotiable constraint: a missing **input/reference** (a file expected to
already exist that the worker was asked to READ) becomes a question/blocked; a
missing **produced/expected** file (one the task just created, a required output
a downstream step depends on, or a file whose existence IS the acceptance
criterion) stays a genuine failure. The design must not blanket-soften all
not-found into "ok."

This is a HEAD, design-first feature. No `.changeset`/CHANGELOG entries
(AGENTS.md). The 64k reader cap, read-denylist/budget, timeout-config,
routeCapacityMap/scheduler, taskLifecycle (#1469/#1021), and orchestrator routing
are all out of scope and must not regress.

### Functional Requirements

- **FR-1 — Structured not-found result (Layer 2).** When `ReadFileTool` resolves
  a path that does not exist on disk (`ENOENT`), it must emit a structured
  not-found notice as the file's result content (not a thrown/opaque error),
  distinguishable by the model as "verify the path," not "crash."
- **FR-2 — Near-match suggestions.** The not-found notice must include up to a
  small cap (N = 5) of near-match candidate PATHS discovered by searching the
  workspace file list. Matching favors files sharing the same basename, then
  stem/substring matches. Suggestions are PATHS only — never file contents.
- **FR-3 — Clean negative.** When there are no near matches, the notice must say
  so explicitly ("not found; no similar files in workspace"). Still not a crash.
- **FR-4 — Ignore/denylist-filtered suggestions.** Candidate suggestions must
  honor `rooIgnore` and the read denylist so vendored/generated junk is never
  surfaced as a suggestion.
- **FR-5 — Bounded cost.** The suggestion search must be cheap and bounded:
  reuse existing workspace-file enumeration (ripgrep-backed `searchWorkspaceFiles`
  / `list-files`), cap results, and never read or return file contents, so it
  does not bloat context (intersects the input-bloat work).
- **FR-6 — Applies to all callers.** The structured not-found behavior applies to
  all `read_file` callers, not only parallel workers (the behavior is generally
  useful). Suggestions stay short and ignore-filtered regardless of caller.
- **FR-7 — Missing input → blocked (Layer 3).** When a parallel worker's output
  signals it could not proceed because a **referenced input** file it was asked
  to READ does not exist, the normalized `WorkerResult` must be `status:
  "blocked"` with an actionable blocker entry naming the path and (when
  available) nearest matches, phrased as a path-confirmation request.
- **FR-8 — Preserve the input-vs-produced distinction.** The blocked
  classification must apply ONLY to a missing input/reference. A file the worker
  just created/edited going missing, a required output/artifact a downstream step
  depends on being absent, or a verification acceptance criterion that IS the
  file's existence must remain `failed`.
- **FR-9 — No schema change.** `WorkerResult.status` already includes `"blocked"`
  and `blockers: string[]`. This feature changes WHEN `blocked` + a
  path-confirmation blocker is emitted; it does not change the schema.
- **FR-10 — Preserve prose-salvage.** The existing `normalizeWorkerResult`
  prose-salvage path must not regress: non-conforming prose still salvages with
  full text retained; genuinely-empty output stays `failed`. This feature only
  refines the blocked-vs-failed boundary for the not-found-input case.

### Non-Functional Requirements

- **NFR-1 — Backward safety.** Existing successful reads behave exactly as before;
  genuine failures (directory-as-file, binary errors, permission errors, denylist
  blocks, rooIgnore blocks) behave exactly as before. Only not-found becomes a
  structured question.
- **NFR-2 — No new fuzzy-match dependency.** Reuse the already-present `fzf`
  (via `searchWorkspaceFiles`) and/or simple basename/substring matching over the
  existing workspace file list. Do not add a new dependency.
- **NFR-3 — Testability at the lowest layer.** The suggestion-matching rule and
  the input-vs-produced classification must be pure, exported helpers unit-testable
  without the VS Code host.
- **NFR-4 — Lint hygiene.** New code fixes its own lint violations; no increase in
  `src/eslint-suppressions.json` per-file counts; avoid `as any`.

### Acceptance Criteria

1. Reading an existing file via `read_file` returns identical content and notices
   (budget notice, truncation banner) as before this change (no regression).
2. Reading a path that does not exist returns a result whose content begins with a
   recognizable not-found marker (e.g. `File: <path>\nNot found:`) and, when near
   matches exist, lists up to 5 candidate PATHS phrased as "did you mean: …?".
3. When no near matches exist, the not-found result states "no similar files in
   workspace" and contains no candidate list.
4. Suggestion candidates never include a path that `isDeniedRead` denies or that
   `rooIgnore` blocks, even if such a path matches by basename.
5. The suggestion list contains only paths, never any bytes of file content.
6. A directory read, a binary read error, a denylist block, and a rooIgnore block
   each produce exactly their current result (no not-found reinterpretation).
7. `normalizeWorkerResult` returns `status: "blocked"` with a path-confirmation
   blocker when worker prose/output signals a missing **referenced input** via an
   unambiguously read-side signal — "referenced input not found", "could not find
   (the) input `<path>`", "input `<path>` … not found", or the Layer-2 markers
   `Not found:` / `did you mean` — including the path in the blocker text. A bare
   generic "no such file" / "`<path>` not found" with no read/input framing does
   NOT, by itself, trigger `blocked` (finding #1).
8. `normalizeWorkerResult` returns `status: "failed"` (unchanged) when prose
   signals a missing **produced/expected** file (e.g. "failed to create", "could
   not write/produce/generate", "expected output … missing", "artifact … was
   never written / was not generated", "verification failed: … does not exist")
   OR echoes a raw write-side errno (`ENOENT: no such file or directory, open
   '<path>'`), including when that errno carries no narration.
9. A worker that fails to WRITE/CREATE an output into a missing parent directory
   and echoes the raw `ENOENT: no such file or directory, open '<path>'` errno is
   classified `failed`, never `blocked` — the central safety invariant (finding
   #1).
10. In `executeNew`, a not-found read does NOT invoke `task.say("error", …)` and
    does NOT set `task.didToolFailInCurrentTurn` (finding #3); it surfaces only
    the structured notice as the file result's content.
11. Existing `normalizeWorkerResult` behaviors are unchanged: conforming structured
    results pass through; empty output → `failed`; generic prose → `completed`;
    generic "blocked"/"blocker:" prose → `blocked`; `failed to`/`could not
    complete` prose → `failed`; the function never throws.
12. All new matching and classification logic is covered by package-local unit
    tests (both the match and no-match cases, and both the input and produced
    not-found cases, including the raw write-ENOENT-stays-failed pin).

### Out of Scope

- Any change to `WorkerResult` schema fields.
- Changes to the 64k reader cap, read-denylist contents/budget, timeout-config,
  routeCapacityMap/scheduler, taskLifecycle (#1469/#1021), orchestrator routing.
- Auto-retrying the read against a suggested path (the agent/mastermind decides;
  this feature only surfaces the actionable question).
- `.changeset`/CHANGELOG edits.

### Assumptions

- "Near match" is best served by basename equality first, then stem/substring,
  over the existing workspace file enumeration; a dedicated fuzzy library is not
  required because `fzf` already backs `searchWorkspaceFiles`.
- No new user setting is strictly required (see Design §7). The default caps
  (N = 5 suggestions, bounded enumeration) are hard-coded constants, matching how
  `DEFAULT_LINE_LIMIT` and budget constants are already shared.

---

## Design

### Overview

Two independent, additive changes behind existing seams. In **Layer 2**,
`ReadFileTool` already funnels missing-file reads into generic `catch` blocks that
set `status: "error"` with a bare `Error reading file: …` message. We insert an
explicit `ENOENT` branch *before* that generic handling that (a) marks the result
with a distinct not-found disposition and (b) attaches a bounded, ignore-filtered
list of near-match paths produced by a new pure-ish helper
`suggestNearbyPaths()`. The emitted notice is phrased as a question so the model
treats it as "verify the path," not a fatal error. In **Layer 3**, we extend
`normalizeWorkerResult`'s prose inference so that output signaling a missing
**referenced input** maps to `blocked` with a synthesized path-confirmation
blocker, while output signaling a missing **produced/expected** file stays
`failed`. No schema change; no new injection path.

The two layers compose: the read tool's structured not-found notice is what a
worker most often echoes into its `attempt_completion` when it gives up on a
missing input, so Layer 3's inference keys on the same vocabulary Layer 2 emits.

### Technology stack (locked)

TypeScript, existing modules only. Suggestion enumeration reuses
`src/services/search/file-search.ts` (`searchWorkspaceFiles`, ripgrep + `fzf`,
already a dependency) with denylist/ignore filtering via the existing
`isDeniedRead` (`src/services/glob/readDenylist.ts`) and
`task.rooIgnoreController?.validateAccess`. No new dependency. Tests use the
package's existing Vitest setup under `src/`.

### Layer 2 — ReadFileTool: structured not-found + suggestions

**A. Detection point(s).** `read_file` reaches a non-existent path through
`fs.stat(fullPath)` in two sibling read loops:

- `executeNew` (single-file path), Phase 3, inside the per-file `try/catch`
  around `fs.stat`/`fs.readFile`. The catch currently does:
  `updateFileResult(relPath, { status: "error", error: "Error reading file: …",
  nativeContent: "File: <relPath>\nError: …" })`.
- `executeLegacy` (batch + the single/batch paths that funnel through it via
  `executeBatch`), inside `readApprovedFile`'s `try/catch`, which sets
  `fileResult.status = "error"` and `fileResult.content = "Error: …"`.

The decision: detect not-found by inspecting the caught error's code. Node's
`fs.stat` throws an error with `code === "ENOENT"` for a missing path. We add a
small, exported type-guard `isEnoent(error: unknown): boolean` (checks
`error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"`;
the single `as` is a documented Node errno structural cast, which AGENTS.md
permits with a comment) in a new module
`src/core/tools/helpers/notFoundSuggestions.ts`. Both catch blocks branch on it
*before* the generic error assignment.

Rationale for branching in the catch (rather than a pre-`stat` `fs.access`
probe): it avoids a second syscall on the hot success path and avoids a
TOCTOU window; the `stat` that already runs is the authoritative existence check.

**A2. Structured shape.** On `ENOENT`, instead of the `error`/`Error:` content we
produce a not-found disposition. To keep NFR-1 (genuine failures unchanged) crisp,
we neither overload `"error"` nor silently reuse `"blocked"` semantics wholesale.

The `FileResult` interface (`ReadFileTool.ts` lines 69–78) currently has
`path`, `status: "approved" | "denied" | "blocked" | "error" | "pending"`,
`content?`, `error?`, `notice?`, `nativeContent?`, `imageDataUrl?`,
`feedbackText?`. We add ONE optional disposition field — `notFound?: boolean` —
and render the not-found entry with `status: "blocked"` so BOTH render paths emit
its `nativeContent` verbatim (confirmed: `executeNew` → `buildAndPushResult`
filters/joins `r.nativeContent`; `executeLegacy` render loop pushes
`fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`` for `status ===
"blocked"`). Using `"blocked"` (not a brand-new status enum value) avoids touching
every `switch`/branch that enumerates the status union; the `notFound` flag is the
discriminator that carries the "this is a question" meaning without a status
change.

**Design decision — the turn-failure flag (resolves review finding #1).** The
original design claimed we could choose `"blocked"` and avoid setting
`task.didToolFailInCurrentTurn`. That was WRONG against the source: `executeNew`
Phase 4 (line 401) runs
`const hasErrors = fileResults.some((r) => r.status === "error" || r.status === "blocked")`
and sets `task.didToolFailInCurrentTurn = true` when `hasErrors`; and the
`executeLegacy` render loop sets the flag only on `status === "error"` (the
`blocked` branch does NOT). So, left as-is, a `blocked` not-found entry would trip
the flag in `executeNew` but not in `executeLegacy` — inconsistent, and contrary
to the "it's a question" intent.

We adopt review-option (a): the `notFound` flag is EXCLUDED from the Phase-4
`hasErrors` aggregate so a not-found read does NOT set `didToolFailInCurrentTurn`
in either path. Concretely, change the Phase-4 predicate to:

```ts
const hasErrors = fileResults.some(
  (r) => r.status === "error" || (r.status === "blocked" && !r.notFound),
)
```

This preserves the existing behavior for rooIgnore/denylist blocks (they are
`blocked` with `notFound` unset → still counted → flag still set, exactly as
today) and keeps the not-found read a clean, actionable negative that does not
perturb consecutive-mistake accounting. `executeLegacy` already does not set the
flag on `blocked`, so it needs no predicate change and is now consistent with
`executeNew`. This is the single, intentional divergence from the
denylist/rooIgnore block behavior, and it is now enforced by the predicate rather
than asserted.

- `formatNotFoundNotice` returns, for the match case:

  ```
  File: <relPath>
  Not found: no file exists at this path.
  Did you mean one of these? (verify the intended path and re-read)
    - <candidate1>
    - <candidate2>
    ...
  ```

  and for the no-match case:

  ```
  File: <relPath>
  Not found: no file exists at this path, and no similar files were found in the workspace.
  Verify the intended path.
  ```

  The leading `Not found:` marker is the stable token both humans and Layer 3
  inference key on. The phrasing "Did you mean … verify the intended path and
  re-read" steers the model to re-read a candidate rather than abort.

  **Signature (pinned, resolves review finding #7 and #2).**
  `formatNotFoundNotice(relPath: string, suggestions: string[]): string`. There is
  NO `includeHeader` option. Both render paths push `nativeContent` verbatim, and
  `nativeContent` always carries its own leading `File: <relPath>` line (matching
  how every other `nativeContent` in the tool is built, e.g.
  `File: <relPath>\nError: …`, `File: <relPath>\nBinary file …`). The legacy
  `blocked` branch pushes `nativeContent` without re-wrapping it in a `File:`
  prefix (unlike the success path's `` `File: ${relPath}\n${content}` ``), so no
  header duplication occurs and no toggle is needed. The notice ALWAYS includes
  the `File:` header; the earlier `{ includeHeader }` option is removed from the
  design.

**B. Suggestion search.** New exported async helper in
`src/core/tools/helpers/notFoundSuggestions.ts`:

```
suggestNearbyPaths(args: {
  missingRelPath: string
  cwd: string
  denylist: ReadDenylistConfig
  isAccessAllowed: (relPath: string) => boolean   // wraps rooIgnoreController
  isKnownTarget: (relPath: string) => boolean      // task.isKnownTargetPath
  cap?: number                                      // default 5
}): Promise<string[]>
```

- **Source.** Call `searchWorkspaceFiles(basename, cwd, limit)` where `basename =
  path.basename(missingRelPath)`. `searchWorkspaceFiles` enumerates the workspace
  via ripgrep, runs `fzf` ranking, and returns `{ path, type, label }[]` — PATHS
  and labels only, no contents. We request `limit = cap * 4` to leave headroom for
  post-filtering, then trim to `cap`.

  **ripgrep's excludes are NOT the ignore story (resolves review finding #4).**
  `executeRipgrepForFiles` passes only `-g !**/node_modules/**`, `.git`, `out`,
  `dist` and respects VS Code `search.useIgnoreFiles`. It does NOT consult the
  Menagerie read denylist (`isDeniedRead` — richer categories: `vendoredDirs`,
  `rootDirs` with `out-*` prefixes, exact `files` like `package-lock.json`, and
  `globs`) and does NOT consult `.rooignore` (`RooIgnoreController` is a separate
  mechanism). Therefore `searchWorkspaceFiles` WILL return paths that the read
  denylist or `.rooignore` would block (e.g. a `files:`-category basename, or a
  `secrets.json` not in VS Code's ignore files). FR-4/AC-4 are satisfied ONLY by
  the helper's own post-filter below — ripgrep's built-in excludes are a
  performance convenience, not the compliance boundary.
- **Matching rule.** Rank in this order, de-duplicated, stable:
  1. Exact basename equality (`path.basename(candidate) === basename`),
     case-sensitive first then case-insensitive as a secondary tier.
  2. Stem match: basename without extension equal to the missing stem
     (`ingress` matches `ingress.yaml` vs `ingress.yml`).
  3. Substring/`fzf` order for the remainder.
  `searchWorkspaceFiles` already applies `fzf` with `byLengthAsc`; we re-rank its
  results by the basename/stem tiers above so same-name-elsewhere wins over a
  loose substring hit.
- **Ignore/denylist filtering (FR-4, AC-4) — the compliance boundary.** Every
  candidate MUST pass BOTH gates before inclusion, because the enumeration above
  returns paths these mechanisms would block:
  - `isAccessAllowed(candidate)` (wraps `rooIgnoreController?.validateAccess(p)
    !== false`; a missing controller is treated as allowed, matching the tool's
    own truthy gate), AND
  - `!isDeniedRead(candidate, denylist, { knownTarget: isKnownTarget(candidate)
    }).denied`.

  Filtering happens after ranking, before the `cap` trim, so a denied top hit does
  not consume a slot.

  **`knownTarget` per-candidate bypass is INTENTIONAL (resolves review finding
  #4).** We pass `knownTarget: isKnownTarget(candidate)` for each candidate, so a
  denylisted path the user explicitly named as a Known_Target elsewhere in the
  task is allowed to surface as a suggestion. This mirrors the tool's own
  denylist-gate semantics (a user-named path is read even if denylisted) and is
  deliberate: if the user already told the task about a path, suggesting it is not
  a leak. A path that is NOT a Known_Target and is denylisted (or rooIgnore'd) is
  always dropped. This is stated as intentional so the reviewer need not treat it
  as an accidental un-deny.
- **Cap & cost bound (FR-5, NFR-2).** `cap = 5`. Only `type === "file"` results
  are considered (directories are not read targets). The helper performs exactly
  one workspace enumeration per not-found read; it reads no file contents. The
  helper is only invoked on the ENOENT branch, so successful reads pay nothing.
- **Source failure is a silent empty, not a throw (resolves review finding #3).**
  `searchWorkspaceFiles` wraps its body in `try { … } catch (error) {
  console.error(…); return [] }` and returns `[]` on ANY internal failure
  (ripgrep binary missing, workspace enumeration error, a thrown `executeRipgrep`).
  It does NOT propagate. So the helper treats an empty result identically to
  no-match and renders the clean negative notice. The helper's own `try/catch`
  remains ONLY as a defensive guard against an unexpected throw (e.g. a future
  refactor that lets something escape); it is not the mechanism that converts a
  ripgrep failure to `[]` (that conversion already happens inside
  `searchWorkspaceFiles`) and is not expected to fire from this source.
- **Return.** `string[]` of workspace-relative POSIX paths, length ≤ cap, possibly
  empty. Never contents.

The denylist and `cwd` are already resolved inside both read loops
(`resolveReadControls(task)` yields `{ denylist, budgetBytes }`; `task.cwd` is in
scope). `isAccessAllowed` wraps `task.rooIgnoreController?.validateAccess(p) !==
false`; `isKnownTarget` wraps `task.isKnownTargetPath(p)`. These are passed in so
the helper stays unit-testable without a `Task` (NFR-3).

**C. Caller scope (FR-6).** Applies to all `read_file` callers. Both read loops
(`executeNew`, `executeLegacy`) get the branch, so single reads, batch reads, and
worker reads all benefit. No `task.parallelWorker` gating. The suggestion cap and
ignore-filtering keep it cheap for every caller.

**Integration points (exact):**

- New: `src/core/tools/helpers/notFoundSuggestions.ts` exporting `isEnoent`,
  `suggestNearbyPaths`, and `formatNotFoundNotice`.
- Edit `src/core/tools/ReadFileTool.ts`:
  - Add `notFound?: boolean` to the `FileResult` interface (lines 69–78).
  - `executeNew` Phase-3 per-file `catch (error)`: the branch is the FIRST
    statement in the catch. If `isEnoent(error)`, compute
    `const suggestions = await suggestNearbyPaths({ missingRelPath: relPath, cwd:
    task.cwd, denylist, isAccessAllowed, isKnownTarget })`, build
    `const notice = formatNotFoundNotice(relPath, suggestions)`,
    `updateFileResult(relPath, { status: "blocked", notFound: true, notice,
    nativeContent: notice })`, and then **`continue`** to the next file —
    explicitly BEFORE the generic `updateFileResult(..., status: "error", ...)`
    assignment AND before the `await task.say("error", \`Error reading file …\`)`
    call that follows it (verified at `ReadFileTool.ts` ~line 390: the generic
    catch always calls `task.say("error", …)`). The ENOENT branch owns its own
    disposition and MUST NOT reach that error-channel narration — a not-found
    read is a question, not a user-facing error (NFR-1, finding #3). The branch
    emits no `say("error")`; the structured notice is surfaced solely via the
    file result's `nativeContent`, which `buildAndPushResult` renders verbatim
    (with its own `File:` header). Only a non-ENOENT error falls through to the
    unchanged generic `status: "error"` + `say("error")` path.
  - `executeNew` Phase-4 predicate: change to
    `fileResults.some((r) => r.status === "error" || (r.status === "blocked" && !r.notFound))`
    so the not-found entry does NOT set `didToolFailInCurrentTurn` (finding #1).
  - `executeLegacy` `readApprovedFile` `catch (error)`: same ENOENT branch —
    `fileResult.status = "blocked"`, `fileResult.notFound = true`, and
    **`fileResult.nativeContent = formatNotFoundNotice(relPath, suggestions)`**
    (NOT `fileResult.content`). The legacy render loop's blocked branch pushes
    `fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`` (confirmed at
    `ReadFileTool.ts` ~line 991 — there is NO `?? content` fallback), so setting
    `content` would render the literal `Blocked` and drop the notice (finding #2).
    The legacy blocked branch pushes `nativeContent` verbatim without re-wrapping
    it in a `File:` prefix, so the notice's own `File:` header is correct and no
    `includeHeader` toggle is needed. The legacy render loop does not set
    `didToolFailInCurrentTurn` on `blocked` (only on `error`), so no predicate
    change is needed there and it is now consistent with `executeNew`.
- No changes to `read_file.ts` tool description are required for behavior, but add
  one sentence to `src/core/prompts/tools/native-tools/read_file.ts` documenting
  that a not-found read returns a "did you mean" suggestion list to re-read,
  not a fatal error (helps the model act on it). This is a prompt string edit, not
  logic.

### Layer 3 — normalizeWorkerResult: missing input → blocked

**C (classification).** Extend the prose-status inference in
`src/core/task/normalizeWorkerResult.ts`. Today `inferProseStatus(text)` returns
`blocked | failed | completed` with blocked taking precedence. We refine it to
separate the not-found-input case:

1. Add a pure exported helper `classifyNotFound(text: string): "input" |
   "produced" | "none"`:
   - Returns `"produced"` when the text matches **produced/expected** failure
     vocabulary — tested FIRST so it wins over any input phrase:
     `/\bfailed to (create|write|produce|generate)\b/`,
     `/\bcould not (create|write|produce|generate)\b/`,
     `/\bexpected (output|artifact|file)\b.*\b(missing|not found|does not exist|absent)\b/`,
     `/\bverification (failed|missing)\b/`,
     `/\b(output|artifact) .*\b(missing|(?:not|never|wasn'?t|was not) (?:created|produced|written|generated))\b/`,
     and — to catch a RAW write-side errno that a worker echoes verbatim when
     `fs.writeFile`/`fs.mkdir` hits a missing parent directory —
     `/\benoent\b.*\bopen\b/` and
     `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/`.
   - Returns `"input"` ONLY when the text matches an **unambiguously read-side**
     input not-found signal and did NOT match produced. The vocabulary is
     restricted to signals a *write/create* path cannot emit (finding #1):
     `/\breferenced input not found\b/`,
     `/\bcould not find (?:the )?input\b/`,
     `/\binput .*\bnot found\b/`,
     `/\bnot found:/` (the Layer-2 marker, emitted only on a read),
     `/\bdid you mean\b/` (the Layer-2 suggestion marker, emitted only on a read).
     The previously-listed GENERIC patterns `/\bno such file\b/` and
     `/\b(file|path) .*\bnot found\b/` are **deliberately NOT in the input tier**:
     a failing `fs.writeFile`/`fs.mkdir` into a missing parent directory throws
     `ENOENT: no such file or directory, open '<path>'`, which a worker commonly
     echoes into `attempt_completion`; those generic phrases therefore cannot
     distinguish a read-ENOENT from a write-ENOENT and must not be allowed to
     downgrade a produced/write failure to `blocked`. A bare `no such file`
     string with no read/input framing falls through to `"none"` and the existing
     generic rules (→ `failed` if it also says "failed to", else `completed`),
     which never produces `blocked` from a write failure.
   - Returns `"none"` otherwise.
2. `inferProseStatus` is updated so that:
   - If `classifyNotFound(text) === "produced"` → `"failed"` (a genuine failure;
     this is checked before the generic blocked/failed phrase rules so a message
     like "failed to create output.json; file not found" is `failed`, not
     `blocked`).
   - Else if `classifyNotFound(text) === "input"` → `"blocked"`.
   - Else fall through to the existing rules unchanged (generic
     `blocked`/`blocker:` → blocked; `failed to`/`could not complete` → failed;
     default completed).

   Ordering is the invariant that prevents misclassification (FR-8, AC-7, AC-8):
   **produced is matched first and short-circuits to failed, before the
   pre-existing generic blocked-first rule can run.** Concretely, the two
   `classifyNotFound` checks are evaluated at the TOP of `inferProseStatus`,
   ahead of the existing `\bblocked\b|\bblocker:` test. This matters for finding
   #2: a produced failure whose phrasing escapes the produced tier (uses neither
   produced vocabulary nor a raw write errno) but contains a generic blocked
   token could otherwise be caught by the pre-existing blocked-first rule. The
   produced tier is deliberately broadened (negation alternation now includes
   `not|never|wasn'?t|was not` over `created|produced|written|generated`) so the
   common produced-failure phrasings — "the artifact was never written", "output
   was not generated", "wasn't produced" — are caught as `"produced"` → `failed`
   before any blocked rule. The claim is scoped (not asserted as total): a
   missing produced file is routed to `failed` for every phrasing in the
   enumerated produced set (see the test matrix in Testability); a produced
   failure phrased entirely outside that set AND lacking any input signal falls
   through to `"none"` and the pre-existing rules — where it becomes `blocked`
   ONLY if the worker literally emitted "blocked"/"blocker:" (unchanged
   pre-existing behavior, not introduced by this feature).

3. When the salvage path produces `blocked` because of an input not-found, we
   must also surface an actionable `blockers[]` entry (today `salvagedResult`
   leaves all arrays empty). Add `buildPathConfirmationBlocker(text): string`
   that extracts the first path-like token near the not-found phrase (a regex for
   a path with a `/` or a known extension, e.g.
   `/([\w./-]+\.(?:ya?ml|md|json|ts|tsx|txt|toml))/` or a token containing `/`)
   and any "nearest matches:"/"did you mean:" list already present in the text,
   then returns:
   `Referenced input not found: <path>. <nearest matches if present>. Confirm the correct path.`
   If no path token can be extracted, fall back to a generic
   `Referenced input not found (see summary). Confirm the correct path.` This
   blocker is attached only on the input→blocked branch. The full prose stays in
   `summary` as today (FR-10 — salvage not regressed).

   Wiring: `salvagedResult(raw, workerName)` computes `status =
   inferProseStatus(text)`. When `status === "blocked"` AND
   `classifyNotFound(text) === "input"`, set `blockers: [buildPathConfirmationBlocker(text)]`;
   otherwise `blockers: []` as before. Structured (schema-conforming) worker
   results are unaffected — a worker that already emits `status: "blocked"` with
   its own `blockers` passes through `workerResultSchema.safeParse` untouched.

**Why it cannot misclassify a real failure as blocked (corrected per finding #1):**

The invariant does NOT rest on the false premise that "a worker only reads paths
it did not create." A worker that *writes* a file into a missing parent directory
produces a raw `ENOENT: no such file or directory, open '<path>'` errno string
that superficially reads like a not-found — so the boundary must be drawn on
signals a write/create path CANNOT emit, not on the generic phrase "no such file."

Two mechanisms enforce the boundary, in order:

1. **Produced-first short-circuit, broadened to cover raw write-side ENOENT.**
   `classifyNotFound` tests the produced tier before the input tier, and the
   produced tier now explicitly matches raw write errno text
   (`/\benoent\b.*\bopen\b/`,
   `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/`) in addition
   to produced narration ("failed to create", "could not write/produce/generate",
   "expected output … missing/absent", "artifact … was never written/was not
   generated", "verification failed"). So a worker echoing a raw write failure —
   with or without its own narration — resolves to `"produced"` → `failed`.
2. **Input tier restricted to read-only signals.** The input tier no longer
   contains the generic `/\bno such file\b/` or `/\b(file|path) .*\bnot found\b/`
   patterns. It keys only on vocabulary a write path never emits: the explicit
   framings "referenced input not found" / "could not find (the) input" / "input
   … not found", and the two Layer-2 markers `Not found:` and `did you mean`,
   which `ReadFileTool` emits ONLY on the read ENOENT branch (never on a write).
   This is the concrete read-vs-write discriminator: the signal must say "input"
   explicitly, or be a Layer-2 read-authored marker.

Consequences:

- A worker that *created/edited* a file and failed reports with produced
  vocabulary OR raw write errno → `"produced"` → `failed`, checked first.
- A verification whose criterion IS a file's existence reports "verification
  failed" / "expected file … does not exist/absent" → `"produced"` → `failed`.
- A worker that *could not read an input it was told already exists* uses the
  restricted read-side input vocabulary → `blocked`.
- A bare raw errno with no read framing (e.g. `ENOENT: no such file or directory,
  open 'dist/output.json'`) matches the produced write-errno pattern
  (`/\benoent\b.*\bopen\b/`) → `"produced"` → `failed`; even if it somehow did
  not, it matches no input signal → `"none"` → the existing generic rules →
  `failed`/`completed`, never `blocked`. (Adversarial pin added in Testability.)
- Genuinely-empty output never reaches `inferProseStatus` (handled earlier as
  `failed`), so AC-9's empty→failed is preserved.

The "can never be reclassified as blocked" claim is therefore scoped precisely:
it holds for (a) all produced vocabulary enumerated above, now including the
`never`/`wasn't`/`was not`/`generated` negations, and (b) all raw write-side
ENOENT echoes via the two errno patterns. A produced-failure phrasing OUTSIDE
this enumerated set that also lacks any input signal falls through to `"none"`
and the pre-existing rules; it is never routed to `blocked` by `classifyNotFound`
because the input tier can no longer be triggered by generic not-found phrasing.
The one residual way such a stray phrase could still be labeled `blocked` is the
pre-existing generic `\bblocked\b|\bblocker:` rule (unchanged by this feature) —
i.e. the worker literally said "blocked"; that is existing behavior this feature
does not alter and is not a not-found misclassification.

**No schema change (FR-9):** `status`/`blockers` already exist; we only choose the
value and populate the blocker in the salvage path.

### D. Interaction with existing mechanisms (none regressed)

- **Prose-salvage (`normalizeWorkerResult`).** The only change is inside
  `inferProseStatus` + a conditional `blockers` population in `salvagedResult`.
  Conforming structured results, empty→failed, generic prose→completed, generic
  blocked/failed inference, and never-throws are all preserved; new tests pin the
  pre-existing cases.
- **Read denylist/budget.** Layer 2 reuses the already-resolved `denylist` and
  does not touch `budgetBytes`, `readInputBytesConsumed`, the budget notice, or
  `BUDGET_TIGHTENED_LINE_LIMIT`. The not-found branch triggers only when the file
  does not exist, so no bytes are counted and no budget logic runs (there is no
  content). Denylist filtering of *suggestions* is additive and read-only.
- **64k reader cap / truncation.** Not-found reads return a tiny notice (a path
  plus ≤5 paths), far under any cap, and never read content, so truncation and
  the line cap are untouched.
- **Measurability log.** `emitMeasurabilityLog` still runs; `deniedBytes` is
  unaffected by a not-found read (nothing was denied, nothing ingested).

### E. Backward safety

Successful reads: unchanged (the ENOENT branch is reached only when `fs.stat`
throws `ENOENT`). Directory-as-file, binary errors, permission errors (`EACCES`,
etc.), rooIgnore blocks, and denylist blocks: unchanged (non-ENOENT errors fall
through to the existing generic `error` handling; rooIgnore/denylist run before
the read and are untouched). The Phase-4 predicate change
(`r.status === "blocked" && !r.notFound`) is behavior-preserving for every
existing `blocked` entry: rooIgnore/denylist blocks leave `notFound` undefined
(falsy), so `!r.notFound` is `true` and they are still counted into `hasErrors`
and still set `didToolFailInCurrentTurn` — only the new not-found entry (which
sets `notFound: true`) is excluded. Layer 3: a worker already returning a
conforming structured result is unaffected; only salvaged prose that matches
input-not-found vocabulary flips failed→blocked.

### Error handling (per operation)

- `suggestNearbyPaths` → `searchWorkspaceFiles` internal failure (ripgrep binary
  missing, workspace enumeration error): **recoverable, and handled inside
  `searchWorkspaceFiles`.** `searchWorkspaceFiles` catches internally and returns
  `[]` (it does NOT throw for ripgrep/enumeration errors — finding #3), so the
  helper simply receives an empty list and the caller renders the clean no-match
  not-found notice. The helper's own `try/catch` is a defensive guard for an
  unexpected throw only (not expected to fire from this source); if it ever does,
  it returns `[]` with a single `console.debug` — not an error-level log, so a
  transient suggestion-source failure never escalates a read into noise. The read
  result is still the clean actionable negative either way.
- `isEnoent` on a non-Error throw (string, etc.): returns `false`; the value falls
  through to the existing generic error handling (unchanged behavior). Fatal to
  the read as before — not reinterpreted.
- `fs.stat` throwing a non-ENOENT code (`EACCES`, `ELOOP`, `EISDIR` is handled
  separately by the directory check): **fatal to that file read, unchanged.**
  Generic `status: "error"` + `Error reading file: …`, `say("error", …)`,
  `didToolFailInCurrentTurn = true`.
- `buildPathConfirmationBlocker` finding no path token: **recoverable.** Returns
  the generic fallback blocker; the worker result is still `blocked` with an
  actionable (if less specific) blocker. Not logged.
- `normalizeWorkerResult` contract: still **never throws** (the new helpers are
  pure string/regex operations wrapped by the existing outer try/catch).

### Input validation (per external input)

- `missingRelPath` (Layer 2): already validated/normalized by the time it reaches
  the catch (it is the `relPath` the read loop used). `path.basename` on it is
  safe; an empty basename yields an empty query → `searchWorkspaceFiles("")`
  returns top items, which we then filter to basename/stem matches (empty basename
  matches nothing) → `[]`. Behavior: clean no-match notice.
- Candidate paths from `searchWorkspaceFiles`: validated through
  `isDeniedRead` + `isAccessAllowed` before inclusion (FR-4). Type must be
  `"file"`.
- `text` (Layer 3): arbitrary worker prose, already whitespace-collapsed by
  `rawToText`. Regexes are anchored on word boundaries and are case-insensitive
  on a lowercased copy, matching the existing `inferProseStatus` style. No
  catastrophic-backtracking patterns (all alternations are bounded, no nested
  quantifiers over `.*` without anchoring).

### Invariant ownership

- **Input-vs-produced boundary (FR-8):** owned by `classifyNotFound` in
  `normalizeWorkerResult.ts`, enforced by ordering (produced tested first). This
  is the single place the distinction lives, so it cannot drift.
- **Suggestions are paths-only, ignore-filtered, capped (FR-2/4/5):** owned by
  `suggestNearbyPaths`; the read tool only renders what the helper returns, so the
  content-leak and denylist invariants are enforced at one layer.
- **Not-found ≠ genuine error (NFR-1):** owned jointly by (a) the `isEnoent` guard
  placement (branch before generic error handling) in `ReadFileTool`, which keeps
  the entry out of the `"error"` bucket, and (b) the `notFound` flag's exclusion
  from the `executeNew` Phase-4 `hasErrors` predicate, which keeps
  `didToolFailInCurrentTurn` unset for a not-found read. The flag behavior is now
  ENFORCED by the predicate (`r.status === "blocked" && !r.notFound`), not merely
  asserted by status choice — this is the correction from review finding #1.
  rooIgnore/denylist blocks (`blocked` with `notFound` unset) continue to set the
  flag exactly as before.

### Testability

- **Unit (package-local, `src/`, Vitest):**
  - `notFoundSuggestions.spec.ts`: `isEnoent` (ENOENT true; EACCES/non-Error
    false); `formatNotFoundNotice` (match list includes `File:` header + "Did you
    mean" + candidates; no-match wording states "no similar files" with no list);
    `suggestNearbyPaths` with a mocked `searchWorkspaceFiles` — basename tier beats
    substring, stem tier (`ingress.yaml` vs `ingress.yml`), denylist/rooIgnore
    filtering drops a top hit (including a non-known-target denylisted basename),
    a known-target denylisted candidate is allowed (intentional bypass), cap at 5,
    empty when the mocked source returns `[]`, only `type: "file"`.
  - `ReadFileTool` not-found integration (extend the existing ReadFileTool spec,
    or a focused `executeNew` test with a mocked `task`): reading a path that
    throws `ENOENT` yields a file result with `status: "blocked"`,
    `notFound: true`, and `nativeContent` beginning `File: <path>\nNot found:`;
    AND asserts `task.say` is NOT called with type `"error"` and
    `task.didToolFailInCurrentTurn` is NOT set for that read (finding #3). A
    non-ENOENT error (e.g. `EACCES`) still produces `status: "error"`, a
    `say("error", …)` call, and `didToolFailInCurrentTurn = true` (NFR-1
    unchanged).
  - `normalizeWorkerResult.spec.ts` (extend existing): read-side-framed
    input-not-found prose → `blocked` + path-confirmation blocker containing the
    path (AC-7); produced not-found prose → `failed` (AC-8); raw write-ENOENT →
    `failed` (AC-9); the mixed `"failed to create … not found"` case → `failed`
    (ordering); and re-assert the current cases (AC-11) so the refinement does
    not regress salvage. The following adversarial cases are
    pinned explicitly because a future regex tweak could silently reclassify
    them:
    - **Pin (finding #1 — raw write-ENOENT must NOT be blocked):** the bare errno
      string `"ENOENT: no such file or directory, open 'dist/output.json'"` (no
      read/input framing) must resolve to `failed`, never `blocked`. Traced: it
      matches the produced write-errno pattern `/\benoent\b.*\bopen\b/` →
      `classifyNotFound → "produced"` → `failed`. (Even if that pattern were
      removed, the restricted input tier matches nothing in it → `"none"` → the
      generic rules, which never yield `blocked` from this string.) This is the
      direct guard against downgrading a missing-OUTPUT write failure.
    - **Pin (finding #1 — produced-first on raw errno with narration):**
      `"could not write the artifact: ENOENT: no such file or directory, open 'dist/out.json'"`
      → `failed` (matches `/\bcould not (create|write|produce|generate)\b/` and
      the errno pattern; produced tested first).
    - **Pin (finding #2 — produced negation breadth):**
      `"the required artifact was never written"` → `failed`, and
      `"output was not generated"` → `failed`. Both match the broadened produced
      negation `/\b(output|artifact) .*\b(missing|(?:not|never|wasn'?t|was not) (?:created|produced|written|generated))\b/`
      → `"produced"` → `failed`, ahead of any generic blocked rule, even though
      a worker might phrase them with a "cannot proceed" lead-in. Include one
      variant with a blocked token:
      `"cannot proceed: the artifact was never written"` → `failed` (produced
      checked before the pre-existing `\bcannot proceed\b` blocked rule).
    - **Pin (prior finding #5):** `"I am blocked: the web/ directory is missing."`
      must stay `blocked`. Traced: it matches no `classifyNotFound` produced regex
      (no "output"/"artifact"/"expected"/"verification"/"failed to create"/errno)
      and no (now-narrowed) input regex (no "referenced input not found"/"could
      not find input"/"input … not found"/"not found:"/"did you mean"), so
      `classifyNotFound → "none"`, falling through to the existing `\bblocked\b`
      rule → `blocked`. A test asserting this stays green guards the
      bare-"blocked … missing" message against regex drift.
    - **Pin (finding #6 — ordering guard):** `"failed to create output.json (did
      you mean dist/output.json?)"` must be `failed`, not `blocked`. The text
      contains the `did you mean` input marker, but `classifyNotFound` tests the
      produced regex `/\bfailed to (create|write|produce|generate)\b/` FIRST →
      `"produced"` → `failed`, short-circuiting before the input check. This
      adversarial case proves the produced-first ordering is the invariant that
      prevents a produced-file verification message (which may legitimately carry a
      suggestion list) from being misclassified as a recoverable input question.
      Pin it alongside the existing `"failed to create … not found"` case.
- **Integration/webview-ui:** none required (no React/host surface changes).
- **E2E (`apps/vscode-e2e`):** none — both behaviors are provable at the unit
  layer (per AGENTS.md Test Placement Guidance; add E2E only for a boundary the
  unit layer cannot represent, which this is not).

Run from the package that declares Vitest:
`pnpm --dir src exec vitest run core/tools/helpers/__tests__/notFoundSuggestions.spec.ts core/task/__tests__/normalizeWorkerResult.spec.ts`,
and after editing each touched file,
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` to
confirm suppression counts do not increase.

### Settings impact (AGENTS.md Persisted Setting Checklist)

No new user setting is introduced. The suggestion cap (`N = 5`) and the fact that
suggestions are always on are hard-coded constants, consistent with existing
shared constants (`DEFAULT_LINE_LIMIT`, budget constants). Therefore the Persisted
Setting Checklist does not apply and `SettingsView`/`cachedState` are untouched.

Rationale for not adding a toggle: the behavior strictly improves on the current
bare-error path, is cheap and bounded, and adding a setting would pull in the full
round-trip surface (`global-settings.ts`, `ExtensionState`, `cachedState`,
`updateSettings`, `webviewMessageHandler`, `getState`/`getStateToPostToWebview`,
import/export, tests) for no clear user need. If a future need arises (e.g.
disabling suggestions in huge monorepos), the design can add a
`readFileNotFoundSuggestions` boolean and a `readFileNotFoundSuggestionCap` number
following the full checklist, binding both to `cachedState` and the
`handleSubmit()` `updateSettings` payload — but this is explicitly deferred/out of
scope for this pass.

### Files touched (summary)

- **New:** `src/core/tools/helpers/notFoundSuggestions.ts`
  (`isEnoent`, `suggestNearbyPaths`, `formatNotFoundNotice`).
- **New test:** `src/core/tools/helpers/__tests__/notFoundSuggestions.spec.ts`.
- **Edit:** `src/core/tools/ReadFileTool.ts` — add `notFound?: boolean` to
  `FileResult`; ENOENT branches in `executeNew` Phase-3 catch (sets
  `status: "blocked", notFound: true, nativeContent: notice`) and `executeLegacy`
  `readApprovedFile` catch (sets `fileResult.nativeContent`, NOT `content`);
  update the `executeNew` Phase-4 `hasErrors` predicate to exclude `notFound`.
- **Edit:** `src/core/task/normalizeWorkerResult.ts` — add `classifyNotFound`,
  `buildPathConfirmationBlocker`; refine `inferProseStatus`; conditional
  `blockers` in `salvagedResult`.
- **Edit test:** `src/core/task/__tests__/normalizeWorkerResult.spec.ts` — add
  input/produced not-found cases; keep existing cases.
- **Edit (prompt string):** `src/core/prompts/tools/native-tools/read_file.ts` —
  one sentence documenting the "did you mean" not-found behavior.

---

## Response to Design Review — Round 1 (verdict: CHANGES_REQUESTED — 2 HIGH, 2 MEDIUM, 3 NIT)

All seven findings addressed. Each was re-verified against the live source before
revising.

- **#1 (HIGH) — Phase-4 `hasErrors` forces `didToolFailInCurrentTurn`.**
  ADDRESSED. Confirmed `ReadFileTool.ts` line 401 sets the flag for ANY `blocked`
  entry. Adopted review-option (a): added a `notFound?: boolean` field to
  `FileResult`, kept rendering via `status: "blocked"`, and changed the Phase-4
  predicate to `r.status === "blocked" && !r.notFound` so the not-found entry does
  not trip the flag. Removed the unsupported "we deliberately do NOT set the flag"
  claim; the behavior is now enforced by the predicate. Reconciled
  §Invariant-ownership and §Backward-safety to the predicate-based mechanism.

- **#2 (HIGH) — legacy blocked branch keys on `nativeContent`, not `content`.**
  ADDRESSED. Confirmed the legacy render loop (~line 991) pushes
  `fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`` with NO `content`
  fallback. The `executeLegacy` catch now sets `fileResult.nativeContent` (not
  `content`). Removed the `includeHeader` option entirely (finding #7): the
  blocked branch pushes `nativeContent` verbatim without re-wrapping, so the
  notice's own `File:` header is correct and no toggle is needed.

- **#3 (MEDIUM) — `searchWorkspaceFiles` does not throw.** ADDRESSED. Restated
  §Layer-2 B and §Error-handling: `searchWorkspaceFiles` catches internally and
  returns `[]` on any ripgrep/enumeration error; the helper treats empty as
  no-match. The helper's own `try/catch` is now described as a defensive guard
  only, not the mechanism that converts failures to `[]`.

- **#4 (MEDIUM) — helper must apply rooIgnore + read-denylist itself.** ADDRESSED.
  Added an explicit paragraph that ripgrep's `node_modules/.git/out/dist` excludes
  are NOT the compliance boundary (they do not cover the read denylist or
  `.rooignore`), and that every candidate MUST pass both `isAccessAllowed` and
  `!isDeniedRead(...).denied`. Stated the per-candidate `knownTarget` bypass as
  intentional (mirrors the tool's own denylist-gate semantics for user-named
  paths), with a dedicated test.

- **#5 (NIT) — pin the bare "blocked … missing" regression.** ADDRESSED. Pinned
  `"I am blocked: the web/ directory is missing."` → `blocked` explicitly in the
  test list, with the trace (classifyNotFound → "none" → falls through to the
  `\bblocked\b` rule).

- **#6 (NIT) — add the adversarial produced-with-suggestion ordering test.**
  ADDRESSED. Pinned `"failed to create output.json (did you mean dist/output.json?)"`
  → `failed`, documenting that the produced regex is tested first and
  short-circuits before the `did you mean` input check.

- **#7 (NIT) — pin `formatNotFoundNotice` signature.** ADDRESSED. Pinned the final
  signature `formatNotFoundNotice(relPath: string, suggestions: string[]): string`
  and removed the `includeHeader` option (resolved by #2: both render paths push
  `nativeContent` verbatim, so the notice always carries its own `File:` header).

## Response to Design Review — Round 2 (verdict: CHANGES_REQUESTED — 1 HIGH, 1 MEDIUM, 2 NIT)

All four findings addressed. The HIGH and MEDIUM were the same class — the
input-vs-produced boundary — and both are now fixed at the regex-tier level, not
by narrative assertion.

- **#1 (HIGH) — write-side ENOENT downgraded to `blocked` via generic input
  patterns.** ADDRESSED, review-option (a) + a reinforcement from (b). The two
  GENERIC patterns `/\bno such file\b/` and `/\b(file|path) .*\bnot found\b/` are
  REMOVED from the Layer-3 `classifyNotFound` input tier. The input tier now keys
  only on unambiguously read-side signals: "referenced input not found", "could
  not find (the) input", "input … not found", and the two Layer-2 read-authored
  markers `Not found:` and `did you mean` (emitted by `ReadFileTool` only on the
  read ENOENT branch, never on a write). As reinforcement, the produced tier is
  broadened to catch RAW write-side errno text regardless of narration via
  `/\benoent\b.*\bopen\b/` and
  `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/`, tested first.
  The §"Why it cannot misclassify" section was rewritten to drop the false
  "a worker only reads paths it did not create" premise and to name the concrete
  read-vs-write discriminator (explicit input framing OR a Layer-2 read marker).
  Added the adversarial pin
  `"ENOENT: no such file or directory, open 'dist/output.json'"` → `failed`
  (never `blocked`), plus a narrated-errno variant, and new AC-8/AC-9. This
  closes the first forbidden acceptance-baseline case (missing OUTPUT must stay
  `failed`).

- **#2 (MEDIUM) — absolute "can never be reclassified" claim exceeded the regex
  set.** ADDRESSED. The produced negation alternation is broadened from
  `not (created|produced|written)` to `(?:not|never|wasn'?t|was not)
  (?:created|produced|written|generated)`, so "the artifact was never written" /
  "output was not generated" / "wasn't produced" resolve to `"produced"` →
  `failed`. The totality claim is now explicitly SCOPED to the enumerated
  produced vocabulary (plus the two write-errno patterns) rather than asserted as
  absolute; a produced phrasing outside that set that also lacks any input signal
  falls through to `"none"` and the pre-existing rules, where it can only become
  `blocked` if the worker literally said "blocked"/"blocker:" (unchanged
  pre-existing behavior). Added produced pins including a "cannot proceed: …
  never written" variant proving produced is tested before the pre-existing
  `\bcannot proceed\b` blocked rule.

- **#3 (NIT) — `executeNew` ENOENT branch must suppress `say("error", …)`.**
  ADDRESSED. The integration point now states the ENOENT branch is the first
  statement in the catch and `continue`s BEFORE both the generic
  `status: "error"` assignment and the unconditional `await task.say("error", …)`
  that follows it (verified at `ReadFileTool.ts` ~line 390). Added AC-10 and a
  `ReadFileTool` integration test asserting `task.say` is NOT called with type
  `"error"` and `didToolFailInCurrentTurn` is NOT set for a not-found read, while
  a non-ENOENT error still narrates and sets the flag. (The `executeLegacy` path
  needs no change: its `readApprovedFile` catch sets fields only, and
  `say("error")` fires in the render loop solely for `status === "error"`, which
  the ENOENT branch — `status: "blocked"` — does not hit.)

- **#4 (NIT) — "optional short labels" vs paths-only contract.** ADDRESSED.
  Removed "and optional short labels" from AC-5 so the paths-only contract is
  stated uniformly; the pinned `formatNotFoundNotice(relPath, suggestions:
  string[])` signature and the helper's `string[]` return are now consistent
  everywhere. The remaining mentions of `label` describe the `searchWorkspaceFiles`
  return shape (whose `label` field the helper drops) — not a claim that
  suggestions carry labels.
