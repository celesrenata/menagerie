# Verification — reader-parent-result-cap

Fix a result-clipping defect in the Menagerie VS Code extension so a project-reader
worker (the mastermind's information channel) can return a realistic audit backlog
inline, and so the clip note reads as "retained in the manifest" rather than
"go read a file" (the mastermind cannot open files).

## Code changes

File: `src/core/tools/ParallelTasksTool.ts`

### Problem A — reader cap too small
- **Old:** `export const MAX_READER_PARENT_RESULT_CHARS = 2_400`
- **New:** `export const MAX_READER_PARENT_RESULT_CHARS = 24_000`
- Still an exported const; still bounded (protects the coordinator context window).
- `MAX_WORKER_PARENT_RESULT_CHARS = 6_000` and `MAX_WORKER_PARENT_ERROR_CHARS = 2_000` left unchanged.

### Problem B — clip pointer rewording
`clipParentResult` clip math is unchanged (`text.slice(0, maxChars)`, reports
`text.length - maxChars`, head slice + `\n… [clipped N chars …]`). Only the location
phrasing changed so both variants read as manifest retention, not a file-open instruction:

- **Path-known variant (new):**
  `Full result retained in the parallel-task manifest record (${manifestPath}).`
  (was `Full result: ${manifestPath}`)
- **Path-unknown variant (new):**
  `Full result retained in the parallel-task manifest record.`
  (was `Full result retained in the parallel-task manifest.`)

Full emitted clip note shape (path-known):
`<head slice>\n… [clipped <N> chars. Full result retained in the parallel-task manifest record (<path>).]`

### Tests
File: `src/core/tools/__tests__/ParallelTasksTool.spec.ts` — added a
`compactParallelTasksResultForParent` describe block covering:
- reader cap (24_000) > coder cap (6_000);
- a project-reader result of 12_000 chars (between old 6_000 and new 24_000) returned IN FULL,
  no `[clipped` marker, `resultClipped` false, `resultChars` == input length;
- a project-reader result > 24_000 clipped at 24_000, `resultClipped` true, `resultChars` == original length,
  clip note mentions manifest retention and includes the supplied manifest path;
- a non-reader (coder) result still clips at 6_000 (unchanged);
- clip-note "retained in the manifest record" phrasing asserted for BOTH path-known and path-unknown variants.

## Verification commands + results

1. `pnpm --dir src check-types` (`tsc --noEmit`) — **exit code 0**.
2. `pnpm --dir src exec vitest run core/tools/__tests__/ParallelTasksTool.spec.ts` —
   **1 test file passed, 24 tests passed, 0 failed**.
3. `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/tools/ParallelTasksTool.ts core/tools/__tests__/ParallelTasksTool.spec.ts` —
   **exit code 0, no warnings/errors**. Neither edited file appears in `src/eslint-suppressions.json`
   (0 references before and after → suppression counts did not increase; `git diff --stat` on the
   suppressions file shows no change).
4. `pnpm --dir src bundle` (`node esbuild.mjs`) — **exit code 0**, completed and emitted dist.
   - `grep -c "24000\|24_000" src/dist/extension.js` → **4** (> 0; esbuild stripped the underscore, so `24000`).
   - Reworked phrasing present in bundle: `grep -o "retained in the parallel-task manifest record" src/dist/extension.js` → match found.
   - mtime check (fresh bundle newer than source edit):
     - source `src/core/tools/ParallelTasksTool.ts` → Tue Oct 6 21:51:49 PDT 2026
     - bundle `src/dist/extension.js` → Tue Oct 6 21:52:59 PDT 2026 (newer ✓)

## Manual step required (cannot be performed here)
The user must **reload the VS Code window** (Developer: Reload Window) to load the
freshly built bundle; the running extension host will not pick up the new cap until reload.

## Note on the "m5-contract-audit" phantom worker-3
No code change. The `AUTO_READER_NAME = "m5-contract-audit"` auto-reader fan-out in
`src/core/task/ParallelTaskReader.ts` is **intended** — a bounded reader auto-appended
per shared doc. The worker-3 "m5-contract-audit" the user observed is this designed
auto-reader fan-out, **not a defect**, and was left exactly as is.
