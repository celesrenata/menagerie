# Maskable activity-bar icon, snapshot omission guard, and hidden-webview repaint

Three independent fixes land in one commit (`3a8f4ca74`, one ahead of `origin/main`): the activity-bar icon is regenerated as a true maskable monochrome silhouette, `snapshotWorkingTree` gains a resilience-only diagnostic for top-level directories missing from the snapshot tree, and the sidebar/tab webview reposts full state on becoming visible so it no longer grays out mid-task. The icon fix is the only user-visible asset change; the other two are behavioral but low-blast-radius. All three are backed by focused unit tests and verified evidence (check-types exit 0, two Vitest suites 185 passed, ESLint clean with no suppression-count increase, bundle exit 0, install-sync into the running extension).

Watch for: nothing blocking. One **confirmed** low-severity observation — the FIX 2 diagnostic fires for *any* empty non-ignored top-level directory (Git never records empty dirs), so it can emit benign `[ParallelTaskWorkspace]` warnings in normal use; this is cosmetic log noise, not a capture regression. The icon opaque-pixel ratio was independently re-measured and reproduces the coder's 33.5% exactly (**confirmed**).

**Verdict**: APPROVED

## High-level view

FIX 1 regenerates `menagerie-activitybar.png` from the master logo by thresholding luminance so the bright logo features stay opaque and the dark background plus interior negative space go fully transparent. The result is a 128x128 RGBA mask whose non-transparent ratio is 33.5% — a genuine silhouette, not a filled block. The independent re-measurement matches the recorded numbers to the pixel, and the marketplace icon `menagerie.png` was not touched in the commit.

FIX 2 is explicitly diagnostic-only. The existing `git add -A -- .` against a private `GIT_INDEX_FILE` already captures all untracked non-ignored content without touching the user's real index or HEAD; the new `warnOnOmittedTopLevelDirectories` helper only logs when an on-disk, non-ignored top-level directory is absent from the written tree. Capture behavior is unchanged, so the user's checkout stays untouched. The one caveat is that empty directories always trigger the warning by construction.

FIX 3 is minimal: both visibility listeners (tab `onDidChangeViewState`, sidebar `onDidChangeVisibility`) now call `postStateToWebview()` before the existing `didBecomeVisible` action when the view becomes visible, so a dropped DOM rebuilds instead of staying gray. The coder chose this repost-on-visible path over adding `retainContextWhenHidden` to `webview.options` because that property belongs to `WebviewPanelOptions`, not `WebviewOptions`, and would not type-check. Registration already sets `retainContextWhenHidden: true`, so the repost is a complementary safety net.

The install-sync into `$EXT` (`zoocodeorganization.zoo-code-3.84.4`) was verified end to end: the installed `package.json` activity-bar path resolves to a present asset that is byte-identical to the fixed repo asset, replacing the previously stale 1.4 MB master.

<details>
<summary>Issues (1)</summary>

1. **Empty-dir diagnostic noise** — `warnOnOmittedTopLevelDirectories` logs a `[ParallelTaskWorkspace]` warning for every empty, non-ignored top-level directory on every snapshot, since Git never records empty dirs in a tree. Non-blocking; consider skipping empty directories if the log proves noisy in practice.

</details>

<details>
<summary>Details</summary>

### Maskable icon silhouette and independent re-measurement

The master `menagerie.png` (light logo on dark navy) is converted to grayscale and thresholded at luminance 70/255: brighter pixels become opaque white, darker ones fully transparent, then downsampled to 128x128 with LANCZOS. Because the logo is light-on-dark, this keeps the glyph features opaque while the background and interior negative space go transparent — the interior-transparency requirement, not a filled blob.

The gate for this fix is the opaque-pixel ratio, which was re-measured independently with Pillow 12.3.0 against the committed asset rather than trusted from the report:

```
size=128x128 total=16384
opaque(a==255)=1713 (10.5%)
transparent(a==0)=10897 (66.5%)
partial=3774 (23.0%)
non-transparent ratio=33.5%
```

This reproduces the recorded measurement to the pixel. 33.5% non-transparent sits in the 15–45% band for a proper silhouette; a solid block would be ~100%. 66.5% of pixels are fully transparent, which rules out a filled bounding box. `package.json` line 58 references `assets/icons/menagerie-activitybar.png`, matching the produced asset, and the marketplace icon (`menagerie.png`, line 7) does not appear in the commit's file list — it was not regressed.

### Snapshot omission diagnostic is capture-neutral

`snapshotWorkingTree` was already correct: it resolves the repo root, reads HEAD into a private `GIT_INDEX_FILE`, runs `git add -A -- .`, then `write-tree`/`commit-tree`, so untracked non-ignored content is captured and ignored artifacts are excluded without ever touching the user's real index or HEAD. The new call sits between `write-tree` and `commit-tree` and does not alter that flow.

`warnOnOmittedTopLevelDirectories` lists the tree's top-level entries, reads on-disk top-level directories (skipping `.git`), and for any on-disk directory absent from the tree runs `git check-ignore -q` — exit 0 means ignored and is skipped, otherwise a single `console.warn` fires. All execa calls are awaited; `check-ignore` uses `reject: false` to read the exit code. The one behavioral wrinkle, confirmed by the second test, is that an empty directory is never recorded in a Git tree yet is not ignored, so it will always trip the warning. In a repo that routinely has empty non-ignored dirs this produces benign log noise on every snapshot. It does not affect what gets captured, so it is a cosmetic concern, not a regression.

The tests cover both paths: a nested untracked `web/src/app.ts` is present in the worker worktree while `node_modules` is excluded and no warning fires for `"web"`; an empty `generated/` dir triggers the diagnostic, and the same test asserts the real `.git/index` and `HEAD` bytes are unchanged — the core invariant the intent requires.

### Hidden-webview repost over an invalid options switch

Both visibility listeners now call `void this.postStateToWebview()` before posting `didBecomeVisible` when the view is visible. The `didBecomeVisible` action alone only scrolls/focuses and does not rebuild state, so a DOM dropped while hidden had nothing to rebuild it — the gray panel. Reposting full state forces a rebuild.

The report documents why the plan's alternative (adding `retainContextWhenHidden` to `webview.options`) was rejected: that property lives on `WebviewPanelOptions`, not `WebviewOptions`, and produces TS2353. Registration already sets `retainContextWhenHidden: true`, so this repost is a complementary net that also covers the WebviewPanel path. The change is 6 lines across the two symmetric listeners, matches the existing pattern, and leaves the hide-side `logWebviewHiddenDiagnostics` untouched. The added test spies on `postStateToWebview`, flips the view visible, invokes the captured callback, and asserts a single repost.

### Install-sync verification

`$EXT = zoocodeorganization.zoo-code-3.84.4`. The installed `package.json` line 58 points to `assets/icons/menagerie-activitybar.png`, which is present and byte-identical to the fixed repo asset (`cmp` → IDENTICAL, 7926 bytes), replacing the stale 1.4 MB master that had been installed. The marketplace icon at line 7 also resolves and is byte-identical to the repo copy. The install-sync requirement — installed manifest's activity-bar icon path points to an asset present in `$EXT` — holds.

### Test and lint evidence

The coder recorded check-types exit 0, ESLint clean across all four touched files with `git diff src/eslint-suppressions.json` showing no change (no suppression-count increase), both suites together at 185 passed, and bundle exit 0. No `.changeset` or `CHANGELOG.md` edits, per repo rules. These were taken as recorded per the no-re-run instruction; only the icon ratio and install-sync were independently spot-checked.

</details>

<details>
<summary>File map</summary>

- `src/assets/icons/menagerie-activitybar.png` — regenerated as 128x128 maskable monochrome silhouette (33.5% non-transparent); bin 5555 → 7926 bytes.
- `src/core/task/ParallelTaskWorkspace.ts` — adds capture-neutral `warnOnOmittedTopLevelDirectories` diagnostic after `write-tree`.
- `src/core/task/__tests__/ParallelTaskWorkspace.spec.ts` — two tests: nested untracked dir included / ignored excluded / no false warning; empty-dir warning + index/HEAD invariant.
- `src/core/webview/ClineProvider.ts` — reposts full state in both visibility listeners when the view becomes visible.
- `src/core/webview/__tests__/ClineProvider.spec.ts` — test asserting a single repost on becoming visible.

Full diff: `git show 3a8f4ca74`.

</details>
