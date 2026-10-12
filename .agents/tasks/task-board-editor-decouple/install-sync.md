# Install Sync — task-board-editor-decouple

Synced the freshly built extension bundle into the running VS Code install.

## Source build

- Fresh bundle: `/Users/celes/sources/celesrenata/menagerie/src/dist`
- Produced by `pnpm --dir src bundle` (exit 0) in the prior step.
- Confirmed fresh: `extension.js` mtime `Oct 7 08:26`, size `33047180` bytes (sync performed `2026-10-07 08:27`).

## Backup created (NOT deleted)

```
/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-082722
```

Created via `cp -R <EXT>/dist <EXT>/dist.bak-20261007-082722` before any destructive step. Verified `extension.js` present in backup (33042110 bytes — the previous installed bundle).

## Replace operation

1. Verified backup existed and contained `extension.js`.
2. Removed old `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist` only AFTER backup success.
3. Copied `/Users/celes/sources/celesrenata/menagerie/src/dist` into `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist`.

Result: installed `extension.js` now `33047180` bytes, matching the fresh source build.

## Freshness verification (grep of INSTALLED bundle)

Command:

```
cd /Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist
for sym in detachTabView editorViewRole rebindView; do grep -c "$sym" extension.js; done
```

Output:

```
detachTabView: 4
editorViewRole: 4
rebindView: 4
```

Matching line sample:

```
this.log("[detachTabView] Non-popout provide ...
```

All three NEW symbols introduced by this change are present in the INSTALLED bundle, confirming the sync is fresh (not stale).

## ACTION REQUIRED BY USER

**You MUST RESTART the app** — reload the VS Code / Zoo Code window (Command Palette → "Developer: Reload Window", or fully quit and reopen) for the new bundle to take effect. The running extension host keeps the old bundle in memory until reload.

## Rollback (if needed)

```
EXT=/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4
rm -rf "$EXT/dist" && cp -R "$EXT/dist.bak-20261007-082722" "$EXT/dist"
```
