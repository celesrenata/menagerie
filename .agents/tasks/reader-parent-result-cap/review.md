# Raise reader parent-result cap to 24k and reword clip note as manifest retention

The change fixes a result-clipping defect in `ParallelTasksTool.ts` that caused the mastermind to receive truncated worker summaries. A project-reader worker — the coordinator's inline information channel — had its parent-result cap raised from 2_400 to 24_000 chars, and the clip note for both the path-known and path-unknown variants was reworded from a "go read this file" instruction into a "full result retained in the manifest" statement, since the coordinator model cannot open files. Clip math is unchanged. The coder cap (6_000) and error cap (2_000) are untouched.

Watch for: nothing blocking. The commit scope is tight (two code files plus the verification doc), the `AUTO_READER_NAME` fan-out was correctly left alone, and the bundle was rebuilt and verified to contain the new values. **confirmed**

**Verdict**: APPROVED

## High-level view

The cap change is a single-const edit raising `MAX_READER_PARENT_RESULT_CHARS` to 24_000 while leaving the two sibling caps at their prior values, exactly matching Problem A. The reader still has a bound, so the coordinator context window remains protected.

The clip-note rewording changes only the location phrasing inside `clipParentResult`; the slice offset, the retained-count arithmetic (`text.length - maxChars`), and the overall `head + "\n… [clipped N chars …]"` shape are byte-for-byte identical to before. Both the path-known and path-unknown branches now assert manifest retention.

Scope is clean. No edits to `ParallelTaskReader.ts` (the intended `m5-contract-audit` auto-reader), the types schema, `runParallelTasks.ts`, or `normalizeWorkerResult.ts`. The new tests cover every case the intent requires, and the verification doc records a fresh bundle rebuild whose grep for `24000` returns 4.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings.

</details>

<details>
<summary>Details</summary>

### Problem A — reader cap raised to 24_000

`MAX_READER_PARENT_RESULT_CHARS` is now `24_000`, remains an exported const, and remains a finite bound. `MAX_WORKER_PARENT_RESULT_CHARS = 6_000` and `MAX_WORKER_PARENT_ERROR_CHARS = 2_000` are present and unchanged in the diff. The cap was not removed. **confirmed** — read directly from the committed diff of `ParallelTasksTool.ts`.

### Problem B — clip note reworded as manifest retention

In `clipParentResult`, the path-known branch changed from `` ` Full result: ${manifestPath}` `` to `` ` Full result retained in the parallel-task manifest record (${manifestPath}).` ``, and the path-unknown branch from `" Full result retained in the parallel-task manifest."` to `" Full result retained in the parallel-task manifest record."`. The return expression is unchanged: `` `${text.slice(0, maxChars)}\n… [clipped ${text.length - maxChars} chars.${location}]` ``. Head slice, retained-count math, and marker shape are all preserved; only the location string differs, and both variants now express retention rather than a file-open instruction. **confirmed**

### AUTO_READER_NAME left untouched

The commit's file list is `verification.md`, `ParallelTasksTool.ts`, and `ParallelTasksTool.spec.ts`. `ParallelTaskReader.ts` is not in the commit. The only occurrences of `AUTO_READER_NAME` / `ParallelTaskReader` in the diff are inside the verification doc prose explaining that the `m5-contract-audit` auto-reader fan-out is intended and was left as is. No code edit to the fan-out. **confirmed**

### Out-of-scope files

No changes to `packages/types` schema, `runParallelTasks.ts`, or `normalizeWorkerResult.ts` — none appear in the commit file list. **confirmed**

### Test coverage

The new `compactParallelTasksResultForParent` describe block covers each required case: a reader result of 12_000 chars (between old 6_000 and new 24_000) returned in full with `resultClipped` false and no `[clipped` marker; a reader result of `24_000 + 5_000` clipped at 24_000 with `resultClipped` true, `resultChars` equal to the original length, a clip note mentioning manifest retention and including the supplied path; a coder result still clipping at 6_000 with the matching retained-count assertion; and dedicated assertions that both the path-known and path-unknown variants carry the "retained in the parallel-task manifest record" wording and no longer match `/Full result:/`. The assertions pin the exact retained-count arithmetic and the slice prefix, so a regression in the clip math would fail them. **confirmed** — read from the committed spec diff.

### Verification evidence

The coder's `verification.md` records `check-types` exit 0, vitest 24/24 passing on the spec file, eslint `--prune-suppressions --max-warnings=0` exit 0 with no suppression-count change, and a `pnpm --dir src bundle` rebuild. The bundle checks are the gating ones: the doc reports `grep -c "24000\|24_000" src/dist/extension.js` → 4 and the reworded phrasing present. I spot-checked the live bundle independently: `grep -c "24000\|24_000" src/dist/extension.js` returns 4 and `grep -c "retained in the parallel-task manifest record" src/dist/extension.js` returns 1, confirming the rebuild landed and is not stale. The evidence is internally consistent with the diff. **confirmed**

</details>

<details>
<summary>File map</summary>

- `src/core/tools/ParallelTasksTool.ts` — raised reader cap to 24_000; reworded both clip-note location variants to manifest retention.
- `src/core/tools/__tests__/ParallelTasksTool.spec.ts` — added `compactParallelTasksResultForParent` describe block with six cases covering caps, full-return, clip behavior, and both clip-note variants.
- `.agents/tasks/reader-parent-result-cap/verification.md` — coder verification evidence (type-check, vitest, eslint, bundle rebuild + grep).

Full diff: `git show HEAD -- src/core/tools/ParallelTasksTool.ts src/core/tools/__tests__/ParallelTasksTool.spec.ts`

</details>
