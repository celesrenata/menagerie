# Design Review — File Not Found as a Question (Round 3)

Reviewed: `.agents/tasks/file-not-found-as-question/design.md`
Scope: two layers — (L2) `ReadFileTool` structured ENOENT-with-suggestions result;
(L3) `normalizeWorkerResult` missing-referenced-INPUT → `blocked`, not `failed`.

This is the third revision of the design. Rounds 1 and 2 are documented inline in
the design with their findings marked ADDRESSED. I reviewed the current document
fresh and re-verified every load-bearing source claim against the live tree. The
central safety invariant (a missing produced/output file must stay `failed`) and
the suggestion-safety constraints (paths-only, ignore/denylist-filtered, capped)
are the acceptance baseline; I checked those first.

## Verdict basis

I found zero HIGH and zero MEDIUM issues. All acceptance-baseline forbidden cases
are addressed with concrete, source-verified mechanisms. The findings below are
NITs only; none alters the verdict. **APPROVED.**

---

## Verified Assumptions

Each was checked against the referenced source, not taken on the design's word.

1. **`FileResult` interface shape** — `src/core/tools/ReadFileTool.ts` lines
   68–80: `path`, `status: "approved" | "denied" | "blocked" | "error" |
   "pending"`, `content?`, `error?`, `notice?`, `nativeContent?`, `imageDataUrl?`,
   `feedbackText?`, `feedbackImages?`, `entry?`. Adding one optional
   `notFound?: boolean` is additive and touches no status enum. ✓ (Design cites
   "69–78"; actual 68–80 — immaterial.)

2. **`executeNew` Phase-3 generic catch** — lines 390–397: on any error it sets
   `status: "error"`, `error: "Error reading file: …"`,
   `nativeContent: "File: <relPath>\nError: …"`, then unconditionally
   `await task.say("error", …)`. The design's ENOENT branch as the first catch
   statement with a `continue` before this is reachable (the per-file loop uses
   `continue` at lines 354 and 398). ✓ So AC-10 (no `say("error")`, no flag) is
   achievable exactly as described.

3. **`executeNew` Phase-4 predicate** — line 401:
   `fileResults.some((r) => r.status === "error" || r.status === "blocked")`, and
   line 403 sets `task.didToolFailInCurrentTurn = true`. Verbatim match to the
   design, including the proposed change to
   `(r.status === "blocked" && !r.notFound)`. ✓ (Round-1 finding #1 fix is sound.)

4. **`executeLegacy` detection point and flag behavior** — `readApprovedFile`
   catch (lines ~974–978) sets `fileResult.status = "error"` (the design changes
   this to `blocked` + `notFound` + `nativeContent` on ENOENT). The render loop
   (lines 990–1002) handles `status === "blocked"` by pushing
   `fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`` and `continue`ing —
   it does NOT set `didToolFailInCurrentTurn`; the flag is set only on
   `status === "error"` (line 999). The separate `didToolFailInCurrentTurn = true`
   on a `blocked` entry at line 883 is in the **pre-read rooIgnore access gate**,
   not in `readApprovedFile`'s catch, so a not-found `blocked` entry authored in
   the catch never trips it. The design's claim that `executeLegacy` "already does
   not set the flag on blocked (in the render path) and is now consistent with
   `executeNew`" is accurate for the ENOENT path. ✓

5. **Legacy blocked render keys on `nativeContent`, not `content`** — line 991:
   `results.push(fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`)` —
   there is NO `?? content` fallback. The design's Round-1 finding #2 fix (set
   `nativeContent`, not `content`) is required and correct. ✓

6. **`buildAndPushResult` renders `nativeContent` verbatim** — lines 745–750:
   `fileResults.filter((r) => r.nativeContent).map((r) => r.nativeContent).join(…)`.
   The notice's own `File:` header is emitted verbatim; no header duplication; the
   removal of the `includeHeader` option (Round-1 #7) is consistent with the two
   render paths. ✓

7. **`searchWorkspaceFiles` return shape and failure mode** —
   `src/services/search/file-search.ts`: returns `{ path, type, label? }[]` (PATHS
   and labels only, no contents), POSIX-normalized (`result.path.toPosix()`), and
   wraps its whole body in `try { … } catch (error) { console.error(…); return [] }`.
   It does NOT throw on ripgrep/enumeration failure. The design's Round-2 finding
   #3 claim is exactly correct. ✓

8. **ripgrep excludes are not the ignore story** — `executeRipgrepForFiles`
   passes only `-g !**/node_modules/**`, `.git`, `out`, `dist`, plus
   `search.useIgnoreFiles`/`useGlobalIgnoreFiles`/`useParentIgnoreFiles`. It does
   NOT consult the Menagerie read denylist or `.rooignore`. The design's finding
   #4 analysis — that FR-4/AC-4 compliance rests ONLY on the helper's own
   `isAccessAllowed` + `!isDeniedRead(...).denied` post-filter — is correct. ✓

9. **`isDeniedRead` signature + known-target bypass** —
   `src/services/glob/readDenylist.ts`:
   `isDeniedRead(relPath, config, opts?: { knownTarget?: boolean }): { denied; category? }`,
   and `opts.knownTarget === true` returns `{ denied: false }` first. Matches the
   design's `!isDeniedRead(candidate, denylist, { knownTarget: isKnownTarget(candidate) }).denied`.
   The existing `applyDenylistGate` (ReadFileTool line 150) already uses this exact
   pattern — the helper mirrors established tool semantics. ✓

10. **`task.isKnownTargetPath(relPath): boolean`** — `src/core/task/Task.ts`
    line 291, public. ✓

11. **`resolveReadControls(task)` yields `{ denylist, budgetBytes }`** — both
    `executeNew` (line 291) and `executeLegacy` (line 861) resolve `denylist` in
    scope, so the helper's `denylist` arg is available at both call sites. ✓

12. **`rooIgnoreController.validateAccess(filePath): boolean`** —
    `src/core/ignore/RooIgnoreController.ts` line 89; returns `true` when no
    `.rooignore` exists. The design's `validateAccess(p) !== false` with "missing
    controller treated as allowed" (`?.validateAccess(p) !== false` → `undefined
    !== false` → `true`) is correct. ✓

13. **`workerResultSchema` has `status` and `blockers`** —
    `packages/types/src/model.ts` line 135:
    `status: z.enum(["completed", "failed", "blocked"])`, line 141:
    `blockers: z.array(z.string())`. FR-9 (no schema change) holds — `blocked` and
    `blockers` already exist. ✓

14. **`normalizeWorkerResult` current behavior** — `inferProseStatus` lowercases
    (`text.toLowerCase()`), tests blocked-first
    (`\bblocked\b|\bblocker:|\bcannot proceed\b|\bunable to proceed\b`), then
    failed (`\btask failed\b|\bi failed\b|\bfailed to\b|\bcould not complete\b|\bunable to complete\b`),
    default completed. `salvagedResult` calls `rawToText` (whitespace-collapsed)
    then `inferProseStatus`, with all arrays `[]`. The function is wrapped in a
    defensive outer try/catch and never throws. The design's "insert the two
    `classifyNotFound` checks at the TOP of `inferProseStatus`, before the
    existing blocked-first rule" is a correct and sufficient placement. ✓

15. **Pre-existing test pins exist** —
    `src/core/task/__tests__/normalizeWorkerResult.spec.ts` already asserts
    `"I am blocked: the web/ directory is missing."` → `blocked`,
    `"The task failed because the file could not be read."` → `failed`, empty →
    `failed`, conforming pass-through, and never-throws. The design's commitment to
    keep these green is checkable, and the new `classifyNotFound` does not disturb
    them: the blocked-missing string matches no produced/input regex → `"none"` →
    existing `\bblocked\b` rule; the "task failed … could not be read" string
    matches no input regex (no "could not find input" / "not found") → `"none"` →
    `\btask failed\b` → `failed`. ✓

16. **Prompt-string file exists** —
    `src/core/prompts/tools/native-tools/read_file.ts` exists; the one-sentence
    documentation edit is a string change, not logic. ✓

## Acceptance-baseline forbidden cases — all cleared

- **Real failure downgraded to blocked/ok (missing OUTPUT / just-written file /
  verification-criterion-is-existence):** PREVENTED. L3 removes the generic
  `/\bno such file\b/` and `/\b(file|path) .*\bnot found\b/` from the input tier
  and keys `input` only on write-impossible signals ("referenced input not
  found", "could not find (the) input", "input … not found", and the L2
  read-only markers `Not found:` / `did you mean`). The produced tier is tested
  FIRST and matches produced narration plus raw write errno
  (`/\benoent\b.*\bopen\b/`, `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/`).
  Adversarial pins cover bare write-ENOENT, narrated write-ENOENT, "failed to
  create … (did you mean …)", and produced-negation breadth. The read-vs-write
  discriminator is concrete, not narrative.
- **Suggestions dumping CONTENTS:** PREVENTED. `suggestNearbyPaths` returns
  `string[]` of paths; `searchWorkspaceFiles` emits only `{ path, type, label }`
  and reads no file bytes; the notice renders paths only.
- **Suggestions ignoring rooIgnore/denylist:** PREVENTED by the helper's own
  per-candidate `isAccessAllowed` AND `!isDeniedRead(...).denied` post-filter
  (ripgrep excludes are explicitly disclaimed as insufficient).
- **Unbounded suggestion cost:** PREVENTED. `cap = 5`, one enumeration per
  not-found read, filter-before-trim, file-type only, no content reads; success
  reads pay nothing (ENOENT-branch-only).
- **Prose-salvage / denylist-budget / 64k-cap regression:** NONE. L3 only inserts
  two checks ahead of the existing rules plus a conditional `blockers` population;
  L2 reuses the resolved denylist read-only and never touches budget/byte
  accounting on the no-content ENOENT path.
- **WorkerResult schema change:** NONE. `status`/`blockers` pre-exist.
- **New user setting without the full checklist:** NONE. No setting added; the
  deferral rationale is explicit and the hard-coded `N = 5` matches existing
  shared constants.

## Unverified / Wrong Assumptions

None. Every load-bearing source claim in the design was verified against the live
tree and matched (line numbers differ trivially in two places, noted in
Verified #1 and immaterial). The two prior-round corrections the design makes
(write-ENOENT-stays-failed; legacy keys on `nativeContent`) are both confirmed
necessary and correct against source.

---

## Findings

1. **NIT — AC-7 markers must be matched on the whitespace-collapsed, lowercased
   text, and the design should pin that the L2 marker survives collapsing.**
   `salvagedResult` runs `rawToText` (which collapses the `File: <path>\nNot
   found:` newline to a single space) before `inferProseStatus` lowercases. The
   input-tier regexes `/\bnot found:/` and `/\bdid you mean\b/` therefore match
   against `…file: <path> not found: …` — which they do. This works, but the
   design never states that `classifyNotFound` must run on the same collapsed,
   lowercased string the existing rules use. Where it occurs: Layer 3 §C step 1
   and §Input validation.
   Fix: add one sentence — "`classifyNotFound` receives the already
   whitespace-collapsed (`rawToText`) text and matches case-insensitively (on the
   lowercased copy), identical to the existing `inferProseStatus` input, so the
   L2 `File:\nNot found:` marker — whose newline becomes a space — still matches
   `/\bnot found:/`." Add a test feeding a verbatim L2 notice body (post-collapse)
   and asserting `blocked` + path-confirmation blocker.

2. **NIT — the known-target denylist bypass for suggestions should be pinned
   against the paths-only/leak contract explicitly in the acceptance criteria,
   not only in prose.** The design (Layer 2 §B) intentionally surfaces a
   denylisted/rooIgnore'd candidate when `isKnownTargetPath(candidate)` is true,
   mirroring `applyDenylistGate`. This is defensible (the user named the path, so
   it is not a leak) and does not expose contents, so it does not violate the
   baseline. But AC-4 reads "never include a path that `isDeniedRead` denies or
   that `rooIgnore` blocks," which is literally in tension with the intentional
   known-target bypass. Where it occurs: AC-4 vs Layer 2 §B "`knownTarget`
   per-candidate bypass is INTENTIONAL."
   Fix: amend AC-4 to "never include a path that `isDeniedRead` denies **(unless
   that path is a Known_Target the user named, matching the tool's own read-gate)**
   or that `rooIgnore` blocks," so the acceptance criterion and the design body
   do not contradict. Keep the existing test that a NON-known-target denylisted
   top hit is dropped AND the test that a known-target denylisted candidate is
   allowed (both are already listed in Testability).

3. **NIT — `buildPathConfirmationBlocker` path-extraction regex is
   under-specified for the no-slash, known-extension case and the ordering of its
   two alternatives.** The design offers
   `/([\w./-]+\.(?:ya?ml|md|json|ts|tsx|txt|toml))/` "or a token containing `/`"
   but does not pin which runs first, the extension allow-list's completeness
   (e.g. `.yml` is covered by `ya?ml`, but `.tsx` is listed while `.js`/`.py`/
   `.sh` are not), or the behavior when the collapsed text contains multiple path
   tokens (it says "first path-like token near the not-found phrase" but the
   regex is not anchored near the phrase). This only affects blocker *specificity*
   (a miss falls back to the generic blocker, so the result is still `blocked` and
   actionable) — hence NIT, not MEDIUM. Where it occurs: Layer 3 §C step 3.
   Fix: pin a single, ordered extraction rule — "(a) prefer the first token
   containing `/` that also ends in a file extension; (b) else the first token
   matching the known-extension set; (c) else the generic fallback" — and either
   broaden the extension set or state it is intentionally a heuristic allow-list
   whose misses degrade to the generic blocker. Add a test for a path with no
   slash (`config.yaml`) and for a message with two path tokens.
