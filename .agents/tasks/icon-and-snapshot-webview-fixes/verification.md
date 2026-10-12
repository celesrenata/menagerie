# Verification — Icon, Snapshot, and Hidden-Webview Fixes

First iteration (no `review.json` present). All three fixes implemented from scratch.

Local-model delegation was unavailable (`local_model_chat` MCP namespace not present),
so per the fallback rule the agent wrote the code directly. The icon-generation helper
is a one-off utility, not shipped code.

---

## FIX 1 — Activity-bar icon maskable silhouette

### Approach
VS Code renders an activity-bar container `icon` as a MONOCHROME ALPHA MASK: it fills the
non-transparent alpha region with the theme foreground color. The previous
`src/assets/icons/menagerie-activitybar.png` had a solid filled alpha region, so VS Code
masked it to a gray block.

The master `menagerie.png` (repo root, 1254x1254, fully opaque, light logo features on a
dark navy background) was converted to a maskable mask with **Pillow 12.3.0**:
- Convert the master to grayscale (luminance).
- Threshold luminance at **70/255**: pixels brighter than the threshold become OPAQUE
  WHITE, everything darker becomes FULLY TRANSPARENT. Because the logo is light-on-dark,
  this naturally keeps the bright features (the "M" strokes, four animal heads, orbit
  circle, glowing nodes) opaque while the dark background AND interior negative space
  become transparent — true interior transparency, not a filled blob.
- Downsample to **128x128** with LANCZOS (matches repo convention; package.json path kept
  as PNG, unchanged).

Helper script: `.agents/tasks/icon-and-snapshot-webview-fixes/make_mask_icon.py`.
Thresholds 50/70/90/110/130 were all evaluated; 70 best preserves logo features while
keeping clear interior negative space. The resulting silhouette visibly depicts the
Menagerie logo (M formed by animal heads + orbit ring + sparkle nodes), confirmed by
compositing the white mask over dark gray and viewing it.

### Chosen format/size
- Format: PNG (unchanged), path unchanged: `assets/icons/menagerie-activitybar.png`
- Size: 128x128, 8-bit RGBA, Type reported by ImageMagick as `Bilevel` with 8-bit alpha.
- `src/package.json` activity-bar `icon` path left as PNG (no SVG switch needed).

### CRITICAL alpha/mask measurement (proves interior transparency, NOT a solid block)
Pillow measurement of the final `src/assets/icons/menagerie-activitybar.png`:

```
THRESHOLD=70
size=128x128 total=16384
opaque(a==255)=1713 (10.5%)
transparent(a==0)=10897 (66.5%)
partial(0<a<255)=3774 (23.0%)
non-transparent ratio (opaque+partial)=33.5%
logo bbox=(9,12)-(118,112) area=11110
interior-transparent pixels (inside bbox)=5623 (50.6% of bbox)
```

ImageMagick alpha-channel stats on the final asset:

```
min=0 mean=0.20797 max=1
```

Interpretation:
- **Non-transparent (opaque + partial) ratio = 33.5%** — squarely in the 15–45% range the
  task describes for a proper silhouette. A solid block would be ~100%. FIX SUCCEEDED.
- **66.5% of pixels are fully transparent (alpha==0)**, and **50.6% of the logo bounding box
  is interior-transparent negative space** — proving the alpha is NOT a solid filled region.
- Alpha channel `min=0` (fully transparent pixels exist) and `mean=0.208` (far below 1.0,
  i.e. not a filled bounding box).

### Marketplace icon not regressed
Top-level `icon` field (`src/assets/icons/menagerie.png`, 128x128, 23362 bytes) was NOT
modified in the repo.

### Reproduction command
`python3 .agents/tasks/icon-and-snapshot-webview-fixes/make_mask_icon.py 70`

---

## FIX 2 — Worker worktree snapshot resilience (diagnostic-only, no capture-behavior change)

### Investigation finding (confirms plan)
`snapshotWorkingTree` runs `git rev-parse --show-toplevel` then `git add -A -- .` from the
repo root against a PRIVATE `GIT_INDEX_FILE`, so it already captures ALL untracked,
non-ignored working-tree content while leaving the user's real index/HEAD untouched. The
existing suite already proves an untracked non-ignored file is included and ignored
artifacts are excluded. The earlier omission was a pre-populate race (a directory
materialized after the snapshot was captured), NOT a capture-logic bug.

Therefore FIX 2 is **RESILIENCE / DIAGNOSTIC-ONLY**: capture behavior is unchanged; a
warning log is added. No change to the `read-tree` / `add -A` / `write-tree` /
`commit-tree` flow; the user's real index/HEAD remain untouched.

### Change
`src/core/task/ParallelTaskWorkspace.ts`: after `git write-tree`, a new
`warnOnOmittedTopLevelDirectories(root, tree, env)` helper:
- Lists the tree's top-level entries (`git ls-tree --name-only <tree>` with the private
  `GIT_INDEX_FILE`).
- Reads on-disk top-level directories via `fs.readdir(root, { withFileTypes: true })`,
  skips `.git`.
- For any on-disk directory absent from the tree, checks `git check-ignore -q -- <name>`
  (exit 0 ⇒ ignored ⇒ skipped).
- Emits a single `console.warn` prefixed `"[ParallelTaskWorkspace]"` for a non-ignored,
  on-disk, absent-from-tree directory.
All execa calls are awaited (no floating promises); no `as any`.

### Tests added — `src/core/task/__tests__/ParallelTaskWorkspace.spec.ts`
- "includes an untracked non-ignored nested directory without warning, and excludes
  ignored artifacts": creates untracked `web/src/app.ts` (no gitignore rule) and ignored
  `node_modules/pkg/index.js`; asserts the worker worktree contains `web/src/app.ts`,
  does NOT contain `node_modules`, and that no `[ParallelTaskWorkspace]` warning fires for
  `"web"`.
- "warns when a non-ignored top-level directory on disk is absent from the snapshot tree":
  creates an EMPTY `generated/` dir (Git never records empty dirs in a tree, so it is
  absent while not ignored), asserts the diagnostic fires for `"generated"`, and asserts
  the real `.git/index` and `HEAD` are unchanged (core invariant).

### Test result
`pnpm --dir src exec vitest run core/task/__tests__/ParallelTaskWorkspace.spec.ts`
→ **Test Files 1 passed (1); Tests 4 passed (4)**. Exit 0.

---

## FIX 3 — Webview grays out when hidden during an active task

### Root cause
The sidebar WebviewView already has `retainContextWhenHidden: true` set at REGISTRATION
(`src/extension.ts:263`, `registerWebviewViewProvider(..., { webviewOptions: {
retainContextWhenHidden: true } })`). The plan's suggested option — adding
`retainContextWhenHidden` to `webviewView.webview.options` — does NOT type-check: that
property belongs to `WebviewPanelOptions`, not `WebviewOptions` (TS2353 confirmed when
attempted). The visibility listeners posted only `{ action: "didBecomeVisible" }`, which
the webview handlers use merely to scroll/focus — they do NOT re-render full state. When
the DOM is dropped while hidden, nothing rebuilds it → gray panel.

### Change (task option B — repost full state on becoming visible)
`src/core/webview/ClineProvider.ts`: in BOTH visibility listeners (tab-panel
`onDidChangeViewState` and sidebar `onDidChangeVisibility`), when the view becomes visible
again, additionally call `void this.postStateToWebview()` before the existing
`didBecomeVisible` action. This reposts the full state so the webview rebuilds and does not
stay gray. The `logWebviewHiddenDiagnostics` call on hide is unchanged. No `as any`; the
new call is `void`-guarded (no floating promise). This is type-safe for both WebviewView
and WebviewPanel paths, unlike the options approach.

The webview-options test was left UNCHANGED (the options object was not modified).

### Test added — `src/core/webview/__tests__/ClineProvider.spec.ts`
"reposts full state when the view becomes visible again so it does not stay gray": spies on
`provider.postStateToWebview`, sets the view visible, invokes the captured visibility
callback, asserts `postStateToWebview` was called once.

### Test result
`pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.spec.ts -t "sets up webview correctly|logWebviewHiddenDiagnostics|becomes visible"`
→ **Test Files 1 passed (1); Tests 6 passed | 175 skipped (181)**. Exit 0.

---

## Repo-rule verification

### check-types
`pnpm --dir src check-types` → exit **0** (no errors). (`tsc --noEmit`.)

### ESLint (per edited/created file, `--prune-suppressions --max-warnings=0`)
```
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 \
  core/task/ParallelTaskWorkspace.ts \
  core/task/__tests__/ParallelTaskWorkspace.spec.ts \
  core/webview/ClineProvider.ts \
  core/webview/__tests__/ClineProvider.spec.ts
```
→ exit **0**, no warnings/errors. `git diff src/eslint-suppressions.json` → **no change**
(counts did not increase).

### Both touched suites together
`pnpm --dir src exec vitest run core/task/__tests__/ParallelTaskWorkspace.spec.ts core/webview/__tests__/ClineProvider.spec.ts`
→ **Test Files 2 passed (2); Tests 185 passed (185)**. Exit 0.

### Bundle
`pnpm --dir src bundle` → exit **0**. Completed: dist cleaned+rebuilt, WASMs/locales/assets
copied (911 material-icons, 36 tree-sitter wasms, 126 locale files, etc.).

### No forbidden edits
No `.changeset` files created; no `CHANGELOG.md` modified (`git status` confirmed).

---

## Final sync into running install

`EXT=/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`

1. **Backed up** old dist → `$EXT/dist.bak-20261006-232057` (timestamped `cp -R`).
2. **Replaced** `$EXT/dist` with freshly built `src/dist`.
3. **Copied** the fixed `src/assets/icons/menagerie-activitybar.png` →
   `$EXT/assets/icons/menagerie-activitybar.png`.
   - Note: the previously installed `menagerie-activitybar.png` was stale (the full
     1254x1254 1.4 MB master). It is now the correct 128x128 maskable asset.
4. **Copied** `src/package.json` → `$EXT/package.json` so the installed manifest references
   match (`node -e "require($EXT/package.json)"` → valid JSON).
5. **Copied** the correct marketplace icon `src/assets/icons/menagerie.png` →
   `$EXT/assets/icons/menagerie.png` (installed copy had also been the stale 1.4 MB master;
   repo version was not modified by this task). This fixes pre-existing install drift
   without regressing the repo asset.

### Installed-manifest reference verification
```
$EXT/package.json line 7 : "icon": "assets/icons/menagerie.png"            -> exists (128x128, 23362B)
$EXT/package.json line 58: "icon": "assets/icons/menagerie-activitybar.png" -> exists (128x128, 7926B)
```
Installed activity-bar icon alpha stats (match repo):
```
min=0 mean=0.20797 max=1
```

**The user must RESTART the app to see the new icon** (VS Code reads activity-bar icons at
load time).
