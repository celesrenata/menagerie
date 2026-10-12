# Install Sync — parallel-capacity-routing

Synced the freshly built Menagerie extension bundle into the running VS Code install.

- Repo: `/Users/celes/sources/celesrenata/menagerie`
- Installed extension: `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`
- Source commit: `e6dc45210` — `feat(parallel): capacity-aware scheduling and backend spread`

## 1. Bundle rebuild

Command: `pnpm --dir src bundle` (run from repo root).

Result: exit `0`. esbuild cleaned `src/dist`, bundled the extension, and copied WASMs, locales, and assets. Output `src/dist/extension.js` is 33,053,212 bytes.

(The engine warning `wanted node 22.23.1, current v24.21.0` is pre-existing and non-fatal; build succeeded.)

## 2. Backup of installed dist

The previous installed `dist` was copied before replacement:

- Backup path: `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-100715`
- Size: 117M (matches the original `dist`).

## 3. Replacement

- Removed `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist`.
- Copied `/Users/celes/sources/celesrenata/menagerie/src/dist` into its place.
- Replacement exit `0`; installed `dist/extension.js` is 33,053,212 bytes (matches the fresh build).

## 4. Freshness grep (symbol + match)

Distinctive NEW symbol chosen: **`computeCapacityBounds`** — an exported function introduced in the new source file `src/core/task/routeCapacityMap.ts` by commit `e6dc45210`. It did not exist in any prior bundle.

Pre-sync (old installed bundle):

```
computeCapacityBounds: 0
createStaticRouteCapacityProvider: 0
validateRouteCapacityMap: 0
STATIC_ROUTE_CAPACITY: 0
```

Post-sync (installed `dist/extension.js`):

```
computeCapacityBounds: 2
createStaticRouteCapacityProvider: 2
STATIC_ROUTE_CAPACITY: 5
```

Sample match in installed bundle: `computeCapacityBounds(` (call site present, confirming the capacity-bounds helper is wired in).

The symbol going from 0 → 2 confirms the installed bundle is the fresh build.

## 5. Rollback steps

If the new bundle misbehaves, restore the backup:

```sh
cd /Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4
rm -rf dist
cp -R dist.bak-20261007-100715 dist
```

Then fully restart the app (see note below). To re-sync the fresh build again, repeat the replacement in step 3.

Once the new bundle is confirmed good, the backup can be deleted:

```sh
rm -rf /Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-100715
```

## Required restart

> **The change will NOT take effect until the app is fully restarted.** A window reload is not sufficient — fully quit and relaunch the application so the extension host reloads the new `dist/extension.js`.
