# Implementation Plan — Icon, Snapshot, and Hidden-Webview Fixes

Three independent fixes. Work directly in the repo (no worktree). Do NOT create `.changeset` files or edit any `CHANGELOG`. After editing each source file, run:
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` and confirm `src/eslint-suppressions.json` counts did not increase (prefer `src` paths relative to the repo, e.g. `core/webview/ClineProvider.ts`). Avoid `as any` and floating promises in all new code.

Test runner: Vitest from the `src` package (`pnpm --dir src exec vitest run <path>`); webview tests from `webview-ui`.

## Investigation findings (recorded per task requirement)

FIX 2 — gitignore / snapshot investigation (conclusive):
- There is NO `web/` directory at the repo root. The user's "web" is the React webview at `webview-ui/`.
- `webview-ui/` is TRACKED: `git ls-files webview-ui/src` returns 752 files. It is NOT ignored from the repo root (`git check-ignore webview-ui/src` → no match).
- `src/.gitignore` ignores `webview-ui` (line 4), but that only hides the build-time copy/symlink `src/webview-ui` (which exists on disk, untracked). `webview-ui/node_modules` is correctly ignored via the root `node_modules` rule.
- `snapshotWorkingTree` runs `git rev-parse --show-toplevel` and then `git add -A -- .` from that root, so it already captures ALL untracked, non-ignored content. The existing test "preserves staged/unstaged/user files…" already proves an untracked non-ignored file (`user-new`) is included and ignored artifacts (`secret`) are excluded; the real index/HEAD are asserted unchanged.
- Conclusion: the current snapshot code is CORRECT and does not drop non-ignored content. The earlier omission was most likely a pre-populate race (worker reading the tree before `webview-ui/src` was materialized) or a worker invoking `--show-toplevel` from inside the ignored `src/webview-ui` copy. Therefore FIX 2 is RESILIENCE / DIAGNOSTIC-ONLY: add a guard/warning log and a regression test. Do NOT invent a change to the add/write-tree logic.

FIX 1 — icon assets/tooling:
- `src/package.json` activity-bar entry `zoo-code-ActivityBar` uses `"icon": "assets/icons/menagerie-activitybar.png"` (~line 58).
- Current `src/assets/icons/menagerie-activitybar.png` is 128x128 with alpha, but its alpha silhouette is a solid filled blob → VS Code masks it to a gray block.
- Masters are both 1254x1254 at the repo ROOT: `menagerie-master.png` and `menagerie.png`. (The task-mentioned `src/assets/icons/menagerie-master.png` does NOT exist; `src/assets/icons/menagerie.png` is only a 128x128 derivative.) Use the root masters.
- Tooling available: ImageMagick `magick` AND Python Pillow 12.3.0. `sips` cannot do interior-transparency.

FIX 3 — hidden webview:
- Sidebar webview options at `ClineProvider.resolveWebviewView` (~line 1054) set only `{ enableScripts, localResourceRoots }` — missing `retainContextWhenHidden`. The tab-panel path already passes `retainContextWhenHidden: true` (~line 3407).
- The `onDidChangeVisibility`/`onDidChangeViewState` listeners post `{ action: "didBecomeVisible" }`, but the webview handlers only scroll/focus (`SettingsView.tsx`, `ChatView.tsx`) — they do NOT re-render full state. So when hidden without retention, VS Code destroys the webview DOM and nothing rebuilds it → gray panel. Standard minimal fix: add `retainContextWhenHidden: true` to the sidebar options (modest memory tradeoff), matching the existing tab-panel pattern.
- Existing test `resolveWebviewView sets up webview correctly` (~line 626 in `ClineProvider.spec.ts`) asserts the exact options object and must be updated.

---

## FIX 1 — Activity-bar icon renders as a solid gray block

- [ ] 1. Generate a mask-ready monochrome activity-bar icon from the real master and overwrite the current PNG.
      From the 1254x1254 master `menagerie.png` (repo root), produce a 128x128 PNG where only the logo's strokes/features are OPAQUE WHITE and ALL other pixels (negative space + background) are fully transparent — true interior transparency, not a filled blob. Use ImageMagick or Pillow (NOT `sips`). Suggested ImageMagick pipeline: load master → convert to grayscale → threshold to a 1-bit silhouette that preserves interior negative space (tune threshold against the master's contrast; invert if the logo is dark-on-light) → set the shape to white, make everything else alpha-0 → resize to 128x128 (keep aspect, pad transparent to square) → write `src/assets/icons/menagerie-activitybar.png`. Verify the result has genuine interior transparency, not a solid alpha region, before accepting it. Keep the package.json path unchanged (PNG). Only if a clean raster silhouette proves infeasible, instead hand-author `src/assets/icons/menagerie-activitybar.svg` (single `fill="currentColor"`/white path on transparent) and update the package.json icon path to the `.svg`; keep the PNG as fallback.
      Files: `src/assets/icons/menagerie-activitybar.png` (overwrite), optionally `src/assets/icons/menagerie-activitybar.svg` + `src/package.json` (only if switching to SVG).
      Verify: `magick identify -verbose src/assets/icons/menagerie-activitybar.png` reports 128x128 with alpha; confirm the alpha channel is NOT fully opaque across the logo region — e.g. `magick src/assets/icons/menagerie-activitybar.png -alpha extract -format "min=%[fx:minima] mean=%[fx:mean]\n" info:` shows `min=0` and a `mean` well below 1 (substantial transparent area). If an SVG was adopted, confirm `src/package.json` points at it and the file is a single-color path on transparent background.

- [ ] 2. (If package.json changed in item 1) sanity-check the manifest.
      Files: `src/package.json`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` is not needed for JSON; instead run `node -e "require('./src/package.json')"` from repo root to confirm valid JSON, and visually confirm the activity-bar `icon` value is correct.

---

## FIX 2 — Snapshot resilience/diagnostic (no behavior change to capture logic)

- [ ] 3. Add a diagnostic guard to `snapshotWorkingTree` that warns when a top-level, on-disk, non-ignored source directory is missing from the written tree.
      After `git write-tree` produces the tree, list the tree's top-level entries (`git ls-tree --name-only <tree>` with the private `GIT_INDEX_FILE` env or against the tree sha). Compare against the top-level directories present on disk under `root` (via `fs.readdir(root, { withFileTypes: true })`) filtered through `git check-ignore` (skip any path git reports as ignored, and skip `.git`). For any directory that exists on disk, is NOT ignored, yet is absent from the tree, emit a single `console.warn` prefixed `"[ParallelTaskWorkspace]"` naming the omitted directory. Do NOT change the existing `read-tree`/`add -A`/`write-tree`/`commit-tree` flow, do NOT commit ignored artifacts, and keep the user's real index/HEAD untouched. Guard against floating promises (await all execa calls) and avoid `as any`.
      Files: `src/core/task/ParallelTaskWorkspace.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/ParallelTaskWorkspace.ts` passes with no new suppressions (file currently has none).

- [ ] 4. Add focused unit tests for the snapshot resilience behavior in a temp git repo.
      Extend the existing suite with cases: (a) an UNTRACKED, non-ignored NESTED directory (e.g. create `web/src/app.ts` with no matching gitignore rule) is present in the worker worktree after snapshot+`createParallelWorkspace` and no `[ParallelTaskWorkspace]` warning fires; (b) ignored artifacts (e.g. a `node_modules/` dir or a `.gitignore`-listed path) stay excluded from the worktree; (c) the real `.git/index` and `HEAD` are unchanged (reuse the existing assertions). Add a case asserting the diagnostic warning IS emitted when a non-ignored top-level dir on disk is absent from the tree — simulate by spying on `console.warn` and constructing a scenario where the tree omits it (e.g. a dir that only appears after write-tree, or stub to force the branch). Mirror the existing test style (temp dir via `fs.mkdtemp`, direct `execa("git", …)` helper).
      Files: `src/core/task/__tests__/ParallelTaskWorkspace.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/ParallelTaskWorkspace.spec.ts` — all tests pass. Then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/__tests__/ParallelTaskWorkspace.spec.ts` with no new suppressions.

---

## FIX 3 — Webview grays out when hidden during an active task

- [ ] 5. Add `retainContextWhenHidden: true` to the sidebar webview options in `resolveWebviewView`.
      In `ClineProvider.resolveWebviewView` (~line 1054), set `webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots }`, matching the tab-panel pattern already used (~line 3407). This retains the webview DOM when hidden so it does not gray out mid-task (modest memory tradeoff). Keep the change minimal; do not alter the visibility listeners or the existing `logWebviewHiddenDiagnostics` call. Avoid floating promises and `as any`.
      Files: `src/core/webview/ClineProvider.ts`
      Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts` passes and the ClineProvider count in `src/eslint-suppressions.json` does NOT increase.

- [ ] 6. Update the webview-options test to assert the new option.
      In `ClineProvider.spec.ts`, update the `resolveWebviewView sets up webview correctly` test (~line 626) so the expected options include `retainContextWhenHidden: true` alongside `enableScripts` and `localResourceRoots`. Leave the `logWebviewHiddenDiagnostics` tests unchanged.
      Files: `src/core/webview/__tests__/ClineProvider.spec.ts`
      Verify: `pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.spec.ts` — all tests pass, including the updated options assertion.

---

## Final verification

- [ ] 7. Confirm the two touched Vitest suites pass together and no suppression counts increased.
      Verify: `pnpm --dir src exec vitest run core/task/__tests__/ParallelTaskWorkspace.spec.ts core/webview/__tests__/ClineProvider.spec.ts` passes, and `git diff src/eslint-suppressions.json` shows no increases (ideally no change). Confirm no `.changeset` files were created and no `CHANGELOG` was modified.
