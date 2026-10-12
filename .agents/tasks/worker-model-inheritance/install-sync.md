# Install Sync — worker-model-inheritance

Sync of the approved, verified fix (`b0a986cdb` — "fix: resolve parallel workers
to their own profile model, not parent planner") from the repo build output into
the running VS Code extension install, with grep proof that the installed bundle
carries the fix.

- Repo: `/Users/celes/sources/celesrenata/menagerie`
- Source build output: `/Users/celes/sources/celesrenata/menagerie/src/dist`
- Installed extension: `/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4`

---

## 1. Rebuild

Command (run from `src/`):

```
pnpm --dir /Users/celes/sources/celesrenata/menagerie/src bundle
```

Result: **EXIT 0** (`BUNDLE_EXIT=0`). esbuild reported no problems between
`onStart` and `onEnd`; dist cleaned and rebuilt. The only warning was the
harmless pnpm `Unsupported engine` note (Node v24 vs wanted 22.23.1), which does
not affect the exit code.

Sanity check on the freshly built source bundle before syncing:

```
grep -c "ownModelFallback" /Users/celes/sources/celesrenata/menagerie/src/dist/extension.js
# -> 4
```

## 2. Backup of installed dist

```
EXT=/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4
TS=$(date +%Y%m%d-%H%M%S)
cp -R "$EXT/dist" "$EXT/dist.bak-$TS"
```

Backup path created (NOT deleted):

```
/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist.bak-20261007-132514
```

## 3. Replace method

Replaced the installed dist with the fresh source dist via `rsync -a --delete`
(copies fresh contents and removes stale files that no longer exist in source):

```
EXT=/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4
SRC=/Users/celes/sources/celesrenata/menagerie/src/dist
rsync -a --delete "$SRC/" "$EXT/dist/"
```

Result: **RSYNC_EXIT=0**.

Post-sync freshness check — installed `extension.js` is byte-identical in size to
the freshly built source bundle (both `33068118` bytes), with a matching
`Oct 7 13:25` timestamp.

## 4. Grep proof the installed bundle carries the fix

Distinctive string: **`ownModelFallback`** — the new local identifier introduced
by the fix in `resolveLaneRouteId` (`src/core/task/parallelWorkerRouting.ts`).
The bundle is minified/comment-stripped JS, so the JSDoc "parent-planner-inheritance
trap" comment text does NOT survive bundling (grep for it returns 0, as expected);
the `ownModelFallback` identifier and its logic line do survive and are the
reliable fix marker.

Exact grep command:

```
grep -rc "ownModelFallback" /Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist/extension.js
```

Match result (**4 occurrences**):

```
/Users/celes/.vscode/extensions/zoocodeorganization.zoo-code-3.84.4/dist/extension.js:4
```

Context grep confirming the actual fix logic (not just the name):

```
grep -o "ownModelFallback[^;]\{0,60\}" .../dist/extension.js | head -4
# ownModelFallback = profile.openAiModelId && profile.openAiModelId !== parent
# ownModelFallback
# ownModelFallback
# ownModelFallback
```

The leading match is the exact fix tier
(`ownModelFallback = profile.openAiModelId && profile.openAiModelId !== parentModelId ? ...`),
and the three remaining uses are its substitutions at the `reader.fast`/`reader.deep`,
`coder.primary` single-id, and `reasoning.escalation` fallback branches.

**Sync VERIFIED:** the installed bundle contains the fix.

---

## Action required by the user

The running VS Code process still has the OLD bundle loaded in memory. You must
**FULLY QUIT and relaunch VS Code** (Cmd+Q, not just reload the window) for the
synced bundle to take effect.
