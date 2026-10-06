# Verification — Menagerie logo + Task Board fixes

First iteration (no prior `review.json`). Both diagnosed defects fixed.

## Issue 1 — Logo does not display in VS Code

### Tools used
- `magick`/`convert` (ImageMagick) and `python3` + Pillow 12.3.0 all available (`which`/import check).
- Conversion done with **Python Pillow** via a one-shot script (`.agents/tmp/convert_logos.py`),
  because `sips` cannot add an alpha channel to the opaque source. The script flood-fills the
  uniform dark background (~RGB 4,10,23) from the four corners to transparent, then resizes to
  128x128 with LANCZOS. The activity-bar icon reuses that knocked-out alpha as a white silhouette
  on transparent, matching the original monochrome activity-bar silhouette (the original fork used
  `assets/icons/icon.svg`, a 400x400 silhouette; VS Code renders activity-bar icons as alpha masks).

### High-res master preserved
- Copied `menagerie.png` (1254x1254) to `menagerie-master.png` before overwriting the assets.

### Before
| File | WxH | hasAlpha | format | bytes |
|---|---|---|---|---|
| menagerie.png | 1254x1254 | no | png | 1,498,207 |
| menagerie-activitybar.png | 1254x1254 | no | png | 1,498,207 |

### After
| File | WxH | hasAlpha | format | bytes |
|---|---|---|---|---|
| menagerie.png | 128x128 | **yes** | png | 23,362 |
| menagerie-activitybar.png | 128x128 | **yes** | png | 5,555 |

### Reference assets (for comparison)
| File | WxH | hasAlpha | format | bytes |
|---|---|---|---|---|
| icon.png (working ext icon) | 128x128 | yes | png | 18,982 |
| roo.png (original Zoo logo) | 180x180 | yes | png | 22,889 |

### Alpha sanity (Pillow)
- menagerie.png: 45% transparent / 36% fully opaque; corner alpha 0, center alpha 255 (background knocked out, logo body solid).
- menagerie-activitybar.png: same alpha coverage; white silhouette on transparent.

### package.json references (unchanged — no path edits needed)
- line 7:  `"icon": "assets/icons/menagerie.png"`
- line 58: activity bar container `"icon": "assets/icons/menagerie-activitybar.png"`

## Issue 2 — Task Board empty at all times

### Change (src/activate/taskBoard.ts)
Root cause: `refresh()` ran only once at activation, when no task exists yet, so `rows` stayed
empty forever. Restored refresh behavior (minimal, no detail panel / selection handler / Beside):
- `view.onDidChangeVisibility`: when the board becomes visible, `void refresh()` + start a 5s poll;
  when hidden, clear the poll. Listener pushed to `context.subscriptions`.
- A 5s `setInterval` runs only while visible; each tick calls `void refresh()` (no floating promise,
  and the existing `refreshing` reentrancy guard still protects overlap).
- Interval cleanup registered via `new vscode.Disposable(stopPolling)` pushed to
  `context.subscriptions`, so it is disposed on deactivate.
- Initial `void refresh()` retained; `if (view.visible) startPolling()` kicks off polling when the
  board is already open at activation.
- No command IDs or view ids changed (`zoo-code.taskBoard`, `zoo-code.getTaskBoard`, etc. intact).

### Test (src/activate/__tests__/taskBoard.spec.ts)
Updated the vscode mock to provide `view.visible` + `onDidChangeVisibility` and a `Disposable`
class, and rewrote the snapshot test to assert the new, correct behavior: one initial snapshot,
polling every 5s while visible, polling stops when hidden, and resumes (with an immediate refresh)
when re-shown.

### Verification commands
- `pnpm --dir src check-types` (`tsc --noEmit`) → **exit 0**, no errors.
- `pnpm --dir src exec vitest run activate/__tests__/taskBoard.spec.ts` → **3 passed**.
- `cd src && pnpm exec eslint --prune-suppressions --max-warnings=0 activate/taskBoard.ts activate/__tests__/taskBoard.spec.ts` → **exit 0**, no findings.
- `git diff --stat src/eslint-suppressions.json` → **empty** (no suppression entry added; count did not increase).
