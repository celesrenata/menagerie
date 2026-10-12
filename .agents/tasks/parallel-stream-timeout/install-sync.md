# Install Sync — parallel-stream-timeout

Final step: rebuild the extension bundle and sync it into the running VS Code install.

## 1. Bundle rebuild

- Command: `pnpm --dir src bundle`
- Result: **exit 0** (clean rebuild; dist cleaned and regenerated).
- Fresh bundle: `/Users/celes/sources/celesrenata/menagerie/src/dist/extension.js`
  - Size: 33,047,182 bytes
  - mtime: Oct 7 09:22
- The rebuild confirmed the stream-idle timeout change is compiled in:
  - `getApiStreamIdleTimeout()` reads config key `apiStreamIdleTimeout`
  - `DEFAULT_STREAM_IDLE_SECONDS = 1800`
  - `MAX_STREAM_IDLE_SECONDS = 3600`

## 2. Backup of installed dist

- Installed extension dir: `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`
- **Backup path: `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-092318`**
  - Created via `cp -a dist dist.bak-20261007-092318` (full metadata-preserving copy).
  - Backed-up `extension.js`: 33,047,180 bytes, mtime Oct 7 08:27 (the previous installed build).

## 3. Replacement

- Removed the old installed dist: `rm -rf <ext>/dist`
- Copied the fresh build in: `cp -a /Users/celes/sources/celesrenata/menagerie/src/dist <ext>/dist`
- Post-replace installed `extension.js`: 33,047,182 bytes, mtime Oct 7 09:22 — matches the fresh build exactly.
- Scope: only `<ext>/dist` and its backup were modified. No other files touched.

## 4. Freshness verification (grep of installed bundle)

Ran against `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist/extension.js`:

```
=== getApiStreamIdleTimeout count ===
3
=== apiStreamIdleTimeout line ===
463378:  const configTimeout = vscode20.workspace.getConfiguration(Package.name).get("apiStreamIdleTimeout", DEFAULT_STREAM_IDLE_SECONDS);
=== DEFAULT_STREAM_IDLE_SECONDS assignment ===
463391:    DEFAULT_STREAM_IDLE_SECONDS = 1800;
=== MAX_STREAM_IDLE_SECONDS assignment ===
463392:    MAX_STREAM_IDLE_SECONDS = 3600;
```

The new 1800s (30 min) stream-idle default and its config key are present in the installed bundle, proving the new build landed.

## 5. Restart required

**The user MUST fully restart the application (quit and relaunch VS Code / the host app) for the new bundle to take effect.** A simple window reload may not reliably reload the extension host from the replaced dist; a full restart is the safe path.

## Rollback

To revert, restore the backup:

```
EXT=/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4
rm -rf "$EXT/dist" && cp -a "$EXT/dist.bak-20261007-092318" "$EXT/dist"
```

Then restart the app.
