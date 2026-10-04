# Implementation Plan — total-pc-control multi-display screen capture

## Context (verified during exploration)

- Target project: `/Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control` (TypeScript, ESM, `tsconfig`: target ES2022, module Node16 → imports MUST use `.js` extensions, `strict: true`). Build = `npm run build` (just `tsc`). No test files exist (vitest is declared but unused), so verification is build + a guarded manual run.
- Flake patch: `/Users/celes/sources/m5max-darwin-flake/packages/total-pc-control/screenshot-tmpdir.patch`, applied by `/Users/celes/sources/m5max-darwin-flake/modules/home/total-pc-control-patch.nix` at home-manager activation. The module clones if missing, applies the patch idempotently (guarded by `git apply --reverse --check`), and rebuilds with `npm run build`.
- Git state of the project: branch `main`. `src/tools/screen.ts` is already **modified in the working tree but NOT committed** (the tmpdir fix); HEAD still holds the pristine EROFS version. Therefore `git diff HEAD <files>` regenerates the FULL patch (tmpdir + new screencapture changes) exactly like the current patch was produced. `package-lock.json` is untracked and must be excluded from the diff.
- `screencapture` flags confirmed on this machine: `-x` (no sound), `-D<n>` (1=main, 2=secondary), `-t<fmt>` where format is `png`/`jpg` (NOT `jpeg`), `-R<x,y,w,h>` (global coords). `system_profiler SPDisplaysDataType` lists each display with a `Resolution:` line and `Main Display: Yes` on the primary.
- The ONLY writable workspace is the menagerie repo (this plan file). The coder edits/commits in the project and flake repos per the task, but must NOT commit there unless instructed by the task (task says "commit locally"? — task item 4 only regenerates a patch; see step notes). Relative paths in the coder's shell MUST resolve against the project/flake absolute paths, not the menagerie workspace.

## Design decisions

- **Shell out to `/usr/sbin/screencapture` for image capture** (replaces nut-js `screen.captureRegion` for both `captureScreen` and `captureRegion`). Reason: libnut has no multi-display API; `screencapture -D<n>` is the native, confirmed-working way to reach display 2. Use `execFile` (promisified) with an absolute binary path and an args array — never a shell string — to avoid injection.
- **Keep nut-js** for `getScreenSize()` (main display is acceptable) and because mouse/keyboard/clipboard tools depend on `@nut-tree-fork/nut-js`. Do NOT remove the dependency. The `FileType` import becomes unused in `screen.ts` after the rewrite — remove it to keep `tsc` clean; keep the `screen` import (still used by `getScreenSize`).
- **Format mapping**: `CaptureFormat.JPEG ("jpeg")` → `screencapture -t jpg` and `.jpg` file extension; `CaptureFormat.PNG` → `-t png` / `.png`. The returned data URI keeps `data:image/${format}` (i.e. `image/jpeg`) to preserve the existing return-string contract.
- **`display` parameter**: `captureScreen(format?, display = 1)`. For `captureRegion`, `-R` uses global coordinates that already span all displays, so a `display` arg is accepted but documented as advisory/ignored for the actual `-R` capture (do not pass both `-D` and `-R`; `-R` wins). Keep the signature `captureRegion(region, format?, display?)` for API symmetry.
- **`listDisplays()`**: best-effort parse of `system_profiler SPDisplaysDataType`. Return an array of `{ index, resolution, main }` (index assigned in listed order, 1-based, matching `-D` numbering) plus a count. On parse failure, degrade gracefully (return count only or an empty list with a note) — never throw to crash the tool.
- **Error handling**: if `screencapture` exits non-zero (e.g. missing Screen Recording TCC permission), throw an `Error` carrying stderr; `index.ts` already wraps tool calls in try/catch and returns `{ isError: true, ... }`, so the server never crashes.

## Steps

- [ ]   1. Rewrite image capture in `src/tools/screen.ts` to use `screencapture`.
       Replace the bodies of `captureScreen` and `captureRegion` to shell out via a promisified `execFile` (`import { promisify } from "node:util"; import { execFile } from "node:child_process";`) to `/usr/sbin/screencapture`. Add a `display: number = 1` param to `captureScreen` and an optional `display?: number` to `captureRegion`. Keep the rotating `screenshot_NN` filename, `MAX_SCREENSHOTS`, writing to `os.tmpdir()`, and the exact return string `File saved as <name>. Image data: data:image/<format>;base64,<...>`. `captureScreen`: run `['-x','-D',String(display),'-t',fmt,filepath]` where `fmt` is `jpg`/`png` and file ext matches. `captureRegion`: run `['-x','-R',`${left},${top},${width},${height}`,'-t',fmt,filepath]`. On non-zero exit, throw `Error` with stderr. Add `listDisplays()` that runs `execFile('/usr/sbin/system_profiler', ['SPDisplaysDataType'])`, parses `Resolution:` / `Main Display: Yes` lines into `{ index, resolution, main }[]`, and returns `{ count, displays }`; wrap parsing in try/catch and degrade gracefully. Remove the now-unused `FileType` import; keep `screen` (used by `getScreenSize`) and `NutRegion` only if still referenced (it will not be — remove it too if `getScreenSize` doesn't use it). Keep `getScreenSize()` as-is.
       Files: `src/tools/screen.ts`
       Verify: `cd /Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control && npm run build` → exits 0, no TS errors, no unused-import errors.

- [ ]   2. Add the `display` param and `list_displays` tool in `src/index.ts`.
       In `capture_screen`, add `display: z.number().int().min(1).optional().describe("Display index to capture (1 = main). Defaults to 1.")` to the schema and pass it to `tools.captureScreen(format, display)`. In `capture_region`, add the same `display` field and pass it to `tools.captureRegion(region, format, display)`. Add a new `list_displays` tool registered right after `get_screen_size` with empty params that calls `tools.listDisplays()` and returns a readable text summary (e.g. `Found N display(s): [1] 3456x2234 (main), [2] 6720x3780`), wrapped in the same try/catch `{ content: [...] }` / `{ isError: true, ... }` shape as the other tools.
       Files: `src/index.ts`
       Verify: `cd /Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control && npm run build` → exits 0, no TS errors. Confirm `build/index.js` contains `list_displays`.

- [ ]   3. (Optional) Leave `src/types.ts` unchanged.
       No new type is strictly required (`display` is a plain number; `listDisplays` return type can be inlined or declared locally in `screen.ts`). Only touch `types.ts` if the coder chooses to export a `DisplayInfo` interface — if so, add it there and import it. The patch regeneration step must include `src/types.ts` ONLY if it was actually changed.
       Files: `src/types.ts` (only if a shared type is added)
       Verify: build still passes (covered by step 2's build).

- [ ]   4. Smoke-test the running behavior (environment-sensitive).
       From the project dir, run a quick node check against the built output, e.g. `node -e "import('./build/tools/index.js').then(async t => { console.log(await t.listDisplays()); console.log((await t.captureScreen('png',2)).slice(0,80)); })"`. NOTE: this is TCC-permission-sensitive — a standalone `node` process may lack Screen Recording permission and `screencapture` can exit non-zero or produce a black image. Treat a permission failure as EXPECTED and NON-BLOCKING: the acceptance bar for this step is that `listDisplays()` returns the two displays and that a `screencapture` failure surfaces as a thrown Error (not a crash), NOT that a real image is captured. Record the observed outcome in the review notes.
       Files: none (runtime check only)
       Verify: `listDisplays()` prints 2 displays; `captureScreen` either returns a `data:image/png;base64,...` string OR throws an Error mentioning the screencapture failure/permission — both are acceptable. Server does not crash.

- [ ]   5. Regenerate the committed Nix patch from the project dir.
       Run exactly (from the project dir), listing only files that actually changed: `git -C /Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control diff HEAD src/tools/screen.ts src/index.ts > /Users/celes/sources/m5max-darwin-flake/packages/total-pc-control/screenshot-tmpdir.patch` (append `src/types.ts` to the diff args ONLY if step 3 modified it). Using `HEAD` (not plain `git diff`) ensures the already-uncommitted tmpdir change in `screen.ts` is captured together with the new screencapture change, reproducing how the existing patch was made. Do NOT include `package-lock.json`.
       Files: `/Users/celes/sources/m5max-darwin-flake/packages/total-pc-control/screenshot-tmpdir.patch`
       Verify: `head -5` of the patch shows a `diff --git a/src/tools/screen.ts` hunk and the file is non-empty; `grep -q 'src/index.ts' <patch>` succeeds.

- [ ]   6. Verify the regenerated patch applies to a pristine checkout.
       In the project dir: `git stash` (stashes the working-tree changes, returning the tree to pristine HEAD), then `git apply --check /Users/celes/sources/m5max-darwin-flake/packages/total-pc-control/screenshot-tmpdir.patch` (expect exit 0 = applies cleanly), then `git stash pop` (restore the working tree). If `git stash pop` reports conflicts, resolve by keeping the working-tree version. Also confirm the activation module's idempotency guard still makes sense: after a real `git apply` of this patch, `git apply --reverse --check` must succeed on the patched tree — the module needs no change, but note this reasoning in the review.
       Files: none (verification only; `screenshot-tmpdir.patch` already written in step 5)
       Verify: `git apply --check <patch>` exits 0 against the pristine (stashed) tree; working tree is restored afterward (`git status` shows `src/tools/screen.ts` modified again). The flake module is confirmed unchanged.

- [ ]   7. Write the review verdict file.
       After steps 1–6 pass (treating step 4's permission failure as acceptable per its note), write `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/tpc-multi-display/review.json` containing `{"verdict": "APPROVED"}` (or `{"verdict": "CHANGES_REQUESTED", ...}` with findings if any step failed). This is the workflow loop's stop contract.
       Files: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/tpc-multi-display/review.json`
       Verify: file exists and `jsonPath` `verdict` equals `APPROVED`.

## Notes / assumptions

- Do NOT commit in the project or flake repos. The task only asks to regenerate the patch file; the flake patch is the delivery mechanism, consumed at activation. Committing is out of scope unless the task says otherwise.
- Do NOT run `darwin-rebuild`/home-manager activation as part of verification — that is a system-level, high-impact action. The build + patch-apply checks are sufficient here.
- `screencapture` format token is `jpg`, not `jpeg`; the data-URI MIME stays `image/jpeg` to preserve the return-string contract.
- If `tsc` flags `NutRegion`/`FileType`/`screen` as unused after the rewrite, remove only the genuinely-unused imports; `screen` is still used by `getScreenSize()`.
