# Implementation Plan — File Not Found as a Question

Derived from the APPROVED design at `.agents/tasks/file-not-found-as-question/design.md`
(reviewed APPROVED in `design-review.md`, round 3). This plan sequences the work
faithfully; it does not re-decide the architecture. Decisions already made in the
design (status reuse of `"blocked"` + `notFound` flag, read-only input tier,
produced-first short-circuit, paths-only ignore-filtered suggestions) are carried
through unchanged.

Repo rules encoded throughout:
- After editing EACH file, run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` and confirm the per-file suppression count in `src/eslint-suppressions.json` did NOT increase.
- No `as any`; the single Node-errno structural cast in `isEnoent` must carry a comment. No floating promises (`void`/`await`/`.catch()`).
- No `.changeset` files; no `CHANGELOG.md` / `src/CHANGELOG.md` edits.
- No new user setting is added (design §Settings impact), so the Persisted Setting Checklist and `SettingsView`/`cachedState` are untouched.
- Do NOT touch timeout-config, routeCapacityMap/scheduler, the 64k reader cap, read-denylist contents/budget, taskLifecycle (#1469/#1021), or orchestrator routing.

Verification base command (run from repo root; `src/` declares Vitest):
`pnpm --dir src exec vitest run core/tools/helpers/__tests__/notFoundSuggestions.spec.ts core/task/__tests__/normalizeWorkerResult.spec.ts`

Ordering rationale: items 1–3 are Layer 2 (ReadFileTool), independent of Layer 3.
Item 1 (the helper) must precede items 2–3 because both ReadFileTool edits import
it. Items 4–5 are Layer 3 (normalizeWorkerResult), independent of Layer 2 at the
code level (Layer 3 keys on the SAME vocabulary Layer 2 emits but does not import
it). Item 6 is a prompt-string doc edit. Item 7 is the final full-suite gate.

---

- [ ] 1. Create the `notFoundSuggestions` helper module with the three pure/async exports.
      Add `src/core/tools/helpers/notFoundSuggestions.ts` exporting:
      (a) `isEnoent(error: unknown): boolean` — `error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"`; the single `as NodeJS.ErrnoException` cast is a documented Node-errno structural cast (comment required, AGENTS.md-permitted) — do NOT use `as any`.
      (b) `formatNotFoundNotice(relPath: string, suggestions: string[]): string` — NO `includeHeader` option; ALWAYS emits a leading `File: <relPath>` line. Match case: `File: <relPath>\nNot found: no file exists at this path.\nDid you mean one of these? (verify the intended path and re-read)\n  - <c1>\n  - <c2>…`. No-match case: `File: <relPath>\nNot found: no file exists at this path, and no similar files were found in the workspace.\nVerify the intended path.` The literal `Not found:` token must appear in both (Layer-3 keys on it).
      (c) `suggestNearbyPaths(args: { missingRelPath: string; cwd: string; denylist: ReadDenylistConfig; isAccessAllowed: (relPath: string) => boolean; isKnownTarget: (relPath: string) => boolean; cap?: number }): Promise<string[]>` — `cap` defaults to 5. Compute `basename = path.basename(missingRelPath)`; call `searchWorkspaceFiles(basename, cwd, cap * 4)`; keep only `type === "file"`; re-rank by tier (1: exact basename equality, case-sensitive then case-insensitive; 2: stem match = basename-without-ext equals missing stem; 3: residual fzf/substring order), de-duplicated and stable; FILTER each candidate by BOTH `isAccessAllowed(candidate)` AND `!isDeniedRead(candidate, denylist, { knownTarget: isKnownTarget(candidate) }).denied` BEFORE the `cap` trim (so a denied top hit does not consume a slot); return POSIX-relative paths, length ≤ cap, possibly empty, NEVER file contents. Wrap the body in a defensive `try/catch` returning `[]` with a single `console.debug` (NOT `console.error`) — note `searchWorkspaceFiles` already returns `[]` on ripgrep/enumeration failure, so this catch is a guard only, not the failure-to-empty mechanism. An empty `basename` yields no basename/stem matches → `[]`.
      Files: `src/core/tools/helpers/notFoundSuggestions.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/tools/helpers/notFoundSuggestions.ts` passes with no suppression increase; TypeScript compiles the file (covered by item 2's build/test run). Full behavior is proven by item 2's unit test.

- [ ] 2. Add the unit test for the helper, covering match/no-match, ranking tiers, filtering, cap, and the known-target bypass.
      Add `src/core/tools/helpers/__tests__/notFoundSuggestions.spec.ts` (Vitest, mock `searchWorkspaceFiles` from `../../../../services/search/file-search`). Cover: `isEnoent` (ENOENT → true; EACCES → false; non-Error → false); `formatNotFoundNotice` match case includes `File:` header + "Did you mean" + each candidate line; no-match case states "no similar files" with no candidate list and still starts `File:`; `suggestNearbyPaths` — basename tier beats substring; stem tier (`ingress` matches `ingress.yaml` vs `ingress.yml`); a NON-known-target denylisted top hit is DROPPED (and does not consume a cap slot); a KNOWN-target denylisted candidate IS allowed (intentional bypass, design finding #4); a rooIgnore-blocked candidate is dropped; cap enforced at 5; only `type: "file"` considered; empty result when mocked source returns `[]`; suggestions contain only paths (assert no file-content bytes). Add the finding #3 NIT test: feed a verbatim post-collapse Layer-2 notice body is NOT this file's concern — leave that to item 5.
      Files: `src/core/tools/helpers/__tests__/notFoundSuggestions.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/tools/helpers/__tests__/notFoundSuggestions.spec.ts` — all new tests pass. Then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/tools/helpers/__tests__/notFoundSuggestions.spec.ts` with no suppression increase.

- [ ] 3. Wire the ENOENT not-found branch into both ReadFileTool read loops and adjust the Phase-4 predicate.
      Edit `src/core/tools/ReadFileTool.ts`:
      (a) Add `notFound?: boolean` to the `FileResult` interface (near line 69).
      (b) `executeNew` Phase-3 per-file `catch (error)` (near line 390): make the ENOENT branch the FIRST statement — if `isEnoent(error)`, compute `const isAccessAllowed = (p: string) => task.rooIgnoreController?.validateAccess(p) !== false`, `const isKnownTarget = (p: string) => task.isKnownTargetPath(p)`, `const suggestions = await suggestNearbyPaths({ missingRelPath: relPath, cwd: task.cwd, denylist, isAccessAllowed, isKnownTarget })`, `const notice = formatNotFoundNotice(relPath, suggestions)`, then `updateFileResult(relPath, { status: "blocked", notFound: true, notice, nativeContent: notice })` and `continue` — BEFORE the generic `status: "error"` assignment and BEFORE the `await task.say("error", …)` that follows it. The ENOENT branch emits NO `say("error")`.
      (c) `executeNew` Phase-4 `hasErrors` predicate (near line 401): change to `fileResults.some((r) => r.status === "error" || (r.status === "blocked" && !r.notFound))` so a not-found entry does NOT set `task.didToolFailInCurrentTurn`. (rooIgnore/denylist blocks leave `notFound` undefined → still counted → unchanged.)
      (d) `executeLegacy` `readApprovedFile` `catch (error)` (near line 974): same ENOENT branch — set `fileResult.status = "blocked"`, `fileResult.notFound = true`, and `fileResult.nativeContent = formatNotFoundNotice(relPath, suggestions)` (NOT `fileResult.content` — the legacy blocked render pushes `fileResult.nativeContent ?? \`File: ${relPath}\nBlocked\`` with no `content` fallback). Resolve `denylist`/`isAccessAllowed`/`isKnownTarget` the same way (`denylist` is already in scope here). Non-ENOENT errors fall through to the unchanged `status = "error"` path. No Phase-4-style predicate change is needed in legacy (its render loop sets the flag only on `status === "error"`).
      Files: `src/core/tools/ReadFileTool.ts`
      Verify: `pnpm --dir src exec vitest run core/tools/__tests__` — existing ReadFileTool suites still pass (successful reads, directory/binary/denylist/rooIgnore cases unchanged). Add a focused not-found integration test (extend the existing ReadFileTool spec or add one) asserting: an ENOENT read yields `status: "blocked"`, `notFound: true`, `nativeContent` beginning `File: <path>\nNot found:`; `task.say` is NOT called with type `"error"`; `task.didToolFailInCurrentTurn` is NOT set for that read; and a non-ENOENT error (e.g. `EACCES`) STILL produces `status: "error"`, a `say("error", …)` call, and `didToolFailInCurrentTurn = true`. Then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/tools/ReadFileTool.ts` with no suppression increase.

- [ ] 4. Extend `normalizeWorkerResult` with `classifyNotFound`, `buildPathConfirmationBlocker`, the refined `inferProseStatus`, and conditional `blockers` population.
      Edit `src/core/task/normalizeWorkerResult.ts`:
      (a) Add exported pure helper `classifyNotFound(text: string): "input" | "produced" | "none"`. It receives the already whitespace-collapsed (`rawToText`) text and matches case-insensitively on the lowercased copy, identical to `inferProseStatus`'s existing input (design finding #1 NIT — so the Layer-2 `File:\nNot found:` marker, whose newline becomes a space, still matches `/\bnot found:/`). Test PRODUCED FIRST (wins over input): `/\bfailed to (create|write|produce|generate)\b/`, `/\bcould not (create|write|produce|generate)\b/`, `/\bexpected (output|artifact|file)\b.*\b(missing|not found|does not exist|absent)\b/`, `/\bverification (failed|missing)\b/`, `/\b(output|artifact) .*\b(missing|(?:not|never|wasn'?t|was not) (?:created|produced|written|generated))\b/`, plus RAW write-errno `/\benoent\b.*\bopen\b/` and `/\bno such file or directory\b.*\b(open|write|mkdir|create)\b/` → `"produced"`. Then INPUT (read-only vocabulary only — the generic `/\bno such file\b/` and `/\b(file|path) .*\bnot found\b/` are DELIBERATELY EXCLUDED): `/\breferenced input not found\b/`, `/\bcould not find (?:the )?input\b/`, `/\binput .*\bnot found\b/`, `/\bnot found:/`, `/\bdid you mean\b/` → `"input"`. Else `"none"`. (Regexes use bounded alternations / word boundaries — no catastrophic backtracking.)
      (b) Add exported helper `buildPathConfirmationBlocker(text: string): string`. Extraction order: (i) prefer the first token containing `/` that also ends in a known file extension; (ii) else the first token matching the known-extension set `/([\w.\/-]+\.(?:ya?ml|md|json|ts|tsx|txt|toml))/`; (iii) else the generic fallback. On a hit: `Referenced input not found: <path>. <nearest matches if a "did you mean"/"nearest matches" list is present>. Confirm the correct path.` On no path token: `Referenced input not found (see summary). Confirm the correct path.` (Design finding #3 NIT: the extension set is an intentional heuristic allow-list whose misses degrade to the generic fallback.)
      (c) Refine `inferProseStatus(text)`: at the TOP, before the existing `\bblocked\b|\bblocker:` test — if `classifyNotFound(text) === "produced"` return `"failed"`; else if `=== "input"` return `"blocked"`; else fall through to the existing rules unchanged.
      (d) In `salvagedResult(raw, workerName)`: compute `const status = inferProseStatus(text)`; when `status === "blocked"` AND `classifyNotFound(text) === "input"`, set `blockers: [buildPathConfirmationBlocker(text)]`; otherwise `blockers: []` as today. Everything else (full text in `summary`, empty arrays, never-throws, conforming-result pass-through) unchanged.
      Files: `src/core/task/normalizeWorkerResult.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/normalizeWorkerResult.ts` with no suppression increase; behavior proven by item 5.

- [ ] 5. Extend the normalizeWorkerResult test suite with the input/produced/write-errno classification cases, keeping existing cases green.
      Edit `src/core/task/__tests__/normalizeWorkerResult.spec.ts`. Add: read-side-framed input not-found prose (e.g. "could not find the input config/app.yaml") → `blocked` with a path-confirmation blocker CONTAINING the path (AC-7); a verbatim post-collapse Layer-2 notice body (`"File: config/app.yaml Not found: no file exists at this path. Did you mean …"`) → `blocked` + blocker (finding #1 NIT); produced not-found prose (e.g. "failed to create output.json", "expected output … missing", "verification failed: … does not exist") → `failed` (AC-8); bare raw write-ENOENT `"ENOENT: no such file or directory, open 'dist/output.json'"` → `failed`, never `blocked` (AC-9, the central safety pin); narrated write-ENOENT `"could not write the artifact: ENOENT: no such file or directory, open 'dist/out.json'"` → `failed`; produced-negation breadth `"the required artifact was never written"` and `"output was not generated"` → `failed`, and `"cannot proceed: the artifact was never written"` → `failed` (produced tested before the pre-existing `cannot proceed` blocked rule); the ordering guard `"failed to create output.json (did you mean dist/output.json?)"` → `failed` (produced short-circuits the `did you mean` input marker); the regression pin `"I am blocked: the web/ directory is missing."` → stays `blocked`; `buildPathConfirmationBlocker` extraction for a no-slash path (`config.yaml`) and for a two-path-token message. Keep ALL existing cases (conforming pass-through, empty → failed, generic prose → completed, "task failed … could not be read" → failed, never-throws).
      Files: `src/core/task/__tests__/normalizeWorkerResult.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/normalizeWorkerResult.spec.ts` — all new and existing tests pass. Then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/__tests__/normalizeWorkerResult.spec.ts` with no suppression increase.

- [ ] 6. Document the not-found behavior in the read_file tool prompt string.
      Edit `src/core/prompts/tools/native-tools/read_file.ts` — add ONE sentence stating that a not-found read returns a "did you mean" suggestion list of candidate paths to re-read, not a fatal error, so the model verifies the path and re-reads a candidate. String edit only, no logic.
      Files: `src/core/prompts/tools/native-tools/read_file.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/prompts/tools/native-tools/read_file.ts` with no suppression increase; file compiles in the item 7 build/test run.

- [ ] 7. Final verification gate across both layers.
      No new edits. Run the focused suites together and confirm no suppression regressions on all touched files.
      Files: none (verification only).
      Verify: `pnpm --dir src exec vitest run core/tools/helpers/__tests__/notFoundSuggestions.spec.ts core/tools/__tests__ core/task/__tests__/normalizeWorkerResult.spec.ts` — all pass. Re-run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on each of: `core/tools/helpers/notFoundSuggestions.ts`, `core/tools/helpers/__tests__/notFoundSuggestions.spec.ts`, `core/tools/ReadFileTool.ts`, `core/task/normalizeWorkerResult.ts`, `core/task/__tests__/normalizeWorkerResult.spec.ts`, `core/prompts/tools/native-tools/read_file.ts` — none increases its suppression count. Confirm no `.changeset`/`CHANGELOG` files were created or modified.

---

## Notes / assumptions

- Decomposition decision: this feature is ONE cohesive unit (one new helper, two
  file edits, two test files, one prompt-string edit) across two code-independent
  layers. It does not warrant FEAT decomposition into separate workflow steps;
  the existing implement-and-review loop implements this plan and writes the
  APPROVED verdict to `review.json`. The remaining workflow steps are NOT
  restructured.
- The design's line-number citations were spot-checked against the live tree and
  match (the `FileResult` interface, the `executeNew` Phase-3 catch and Phase-4
  predicate near line 401, the `executeLegacy` blocked render pushing
  `nativeContent` with no `?? content` fallback, `searchWorkspaceFiles(query,
  workspacePath, limit)` returning `{ path, type, label? }[]` and swallowing
  errors to `[]`, and `isDeniedRead(relPath, config, { knownTarget })`). Exact
  lines may drift slightly during implementation; the implementer should locate
  by the described code shape, not by line number alone.
- Each item leaves the codebase buildable: item 1 adds an unused-but-valid module;
  items 2/5 add tests; items 3/4/6 are additive edits behind existing seams.
