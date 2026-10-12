# Install Sync — `parallelCapacityMap` fresh bundle into running VS Code

Synced the freshly built extension bundle into the installed VS Code extension so the
new user-adjustable **`parallelCapacityMap`** setting is live for testing.

## ⚠️ YOU MUST FULLY QUIT AND RELAUNCH VS CODE

> **A window reload (Developer: Reload Window) is NOT enough.** The parallel scheduler
> and its per-capability capacity provider are **constructed once at batch start**, so
> the new `parallelCapacityMap` value is only picked up by a fresh extension-host
> process. **Completely quit VS Code (Cmd+Q) and relaunch it** before testing the
> setting. Until you do, the running instance keeps using the previously loaded code.

## Install path

- `EXT = /Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`
- Target dist: `$EXT/dist`
- Source build: `/Users/celes/sources/celesrenata/menagerie/src/dist`
  (produced by `pnpm --dir src bundle` in the verify step; build mtime 10:44, fresher
  than the previously installed dist at 10:07)

## Backup created

- `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-104600`
- Created with `cp -R "$EXT/dist" "$EXT/dist.bak-<timestamp>"` before any replacement,
  so the prior install can be restored by copying this backup back over `$EXT/dist`.

## Files/dirs replaced

- Removed the entire `$EXT/dist` tree, recreated it, and copied the full contents of
  `src/dist` into it (`cp -R src/dist/. $EXT/dist/`).
- Replaced payload includes `extension.js`, `extension.js.map`, `assets/`, `bin/`,
  `i18n/`, and all `*.wasm` runtime files (esbuild, tiktoken, tree-sitter grammars).
- Post-copy parity: **47 entries installed = 47 entries in build**; `extension.js` is
  byte-identical at **33,054,924 bytes** in both locations.

## Grep confirmation (key found in INSTALLED bundle)

Run against `$EXT/dist/extension.js` (the installed bundle, not the build):

| Needle | Occurrences in installed bundle |
|--------|---------------------------------|
| `parallelCapacityMap` | **10** |
| `mergeRouteCapacityMap` | **2** |

Both are present, confirming the copy took and the running install now contains the new
setting and its merge/floor helper. (10 occurrences of `parallelCapacityMap` matches the
count recorded for `src/dist` in `verification.md`.)

## Result

- Install sync **succeeded**. Installed dist now equals the fresh build.
- Backup of the prior install retained at the path above.
- **Action required before testing: fully quit (Cmd+Q) and relaunch VS Code.**
