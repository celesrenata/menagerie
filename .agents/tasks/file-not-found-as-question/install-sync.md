# Install Sync — file-not-found-as-question

Synced the APPROVED `feat: treat file-not-found as a recoverable question`
(commit `67b984b13`) into the running VS Code extension install and verified
it landed in the installed bundle.

## 1. Bundle rebuild

Command: `pnpm --dir /Users/celes/sources/celesrenata/menagerie/src bundle`

Exit code: **0**

## 2. Backup of installed dist

Backup path:
`~/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-145819`

(Created with `cp -R "$EXT/dist" "$EXT/dist.bak-$(date +%Y%m%d-%H%M%S)"`.)

## 3. Replace installed dist

`$EXT/dist` was removed and replaced with the freshly built
`/Users/celes/sources/celesrenata/menagerie/src/dist`.

- `EXT=~/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`

## 4. Verification — grep of the INSTALLED bundle

Distinctive new string introduced by the fix (`formatNotFoundNotice` in
`src/core/tools/helpers/notFoundSuggestions.ts`):

```
$ grep -o -m1 "no similar files were found in the workspace" "$EXT/dist/extension.js"
no similar files were found in the workspace
```

New LAYER 2 / LAYER 3 identifiers (`suggestNearbyPaths`,
`buildPathConfirmationBlocker`, `formatNotFoundNotice`, `classifyNotFound`):

```
$ grep -c "suggestNearbyPaths\|buildPathConfirmationBlocker\|formatNotFoundNotice\|classifyNotFound" "$EXT/dist/extension.js"
11
```

Both the user-facing phrase and the new identifiers are present in the
installed `extension.js`, proving the installed bundle carries this fix (not a
no-op).

## 5. Required user action

The user must **FULLY QUIT and relaunch VS Code** (not just reload the window)
for the new bundle to take effect. A running instance keeps the previously
loaded `extension.js` in memory.
