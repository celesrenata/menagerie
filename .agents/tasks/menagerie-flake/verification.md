# Menagerie Nix Flake — Verification Note

This records what was run to verify the flake and the results, so the reviewer does not have to
re-run the (long) build. All work is in the worktree
`/Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake`.

Environment: macOS, `aarch64-darwin`, Nix 2.35.2 (flakes enabled). nixpkgs pinned to `nixos-unstable`
(locked `c59305bab2065cfecc4944690d9eedbb56f3a9fa`, 2026-10-01). The build also succeeds on the other
three declared systems by construction (platform-neutral JS vsix); only the host system was built
here.

## 1. pnpmDeps fixed-output hash (two-pass method)

First pass used `lib.fakeHash` and the build reported:

```
error: hash mismatch in fixed-output derivation '…-menagerie-pnpm-deps.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
            got:    sha256-KvdnQIYa9K7gJx+/6yjLa3ocSGCOUrX6vTu2D8FBbfo=
```

Pinned in `nix/packages.nix`:

```
hash = "sha256-KvdnQIYa9K7gJx+/6yjLa3ocSGCOUrX6vTu2D8FBbfo=";   # fetcherVersion = 4
```

Second pass with the real hash fetched all workspace deps offline with `--frozen-lockfile`
successfully (no network).

## 2. `nix build .#menagerie-vsix`

```
$ nix build .#menagerie-vsix
# (exit 0, built /nix/store/zw8dwzgclmfdm2mpd3hnqrqv3fk8p9bf-menagerie-vsix-3.84.4)
```

The full upstream turbo graph ran: `@roo-code/types#build` → other `^build` deps →
`@roo-code/vscode-webview#build` (vite) → `zoo-code#bundle` (esbuild + asset copy) → `zoo-code#vsix`
(`vsce package --no-dependencies`).

### `ls -la` the result symlink — non-trivial .vsix

```
$ readlink result
/nix/store/zw8dwzgclmfdm2mpd3hnqrqv3fk8p9bf-menagerie-vsix-3.84.4

$ ls -la result/
-r--r--r-- 1 root wheel 34613957 Dec 31 1969 zoo-code-3.84.4.vsix

$ du -h result/zoo-code-3.84.4.vsix
34M	result/zoo-code-3.84.4.vsix
```

### `unzip -l` the vsix — extension.js / dist / package.json present

```
$ unzip -l result/*.vsix | tail -1
164197888                     1932 files

$ unzip -l result/*.vsix | grep -E 'extension/package.json|extension/dist/extension.js|workers/countTokens.js'
    16774  …   extension/package.json
 15028034  …   extension/dist/extension.js
  2359850  …   extension/dist/workers/countTokens.js
```

Also present: `extension/dist/*.wasm` (tree-sitter + tiktoken), `extension/dist/i18n/locales/**`
(126 locale files), and `extension/webview-ui/build/assets/**` (the built React webview). 1932 files
total, 34 MB packed. This is a complete, installable extension vsix built from source.

## 3. `menagerie-modes` and `menagerie-with-modes`

```
$ nix build .#menagerie-modes -o result-modes   # exit 0
$ find result-modes/ -maxdepth 2
result-modes/aar/roomodes.yaml
result-modes/aar/roo
result-modes/aar/tools        (omniroute.py, polite_fetch.py, leads.py)
result-modes/repo/roomodes.yaml
result-modes/repo/roo

$ nix build .#menagerie-with-modes -o result-wm  # exit 0
$ ls result-wm/
modes/   zoo-code-3.84.4.vsix -> …/menagerie-vsix-3.84.4/zoo-code-3.84.4.vsix
$ ls result-wm/modes/
aar  repo
```

`menagerie-modes` ships both bundled mode sets (AA&R v2 pack under `aar/`, the in-repo 7-mode set
under `repo/`) in separate subdirectories so slugs never collide. `menagerie-with-modes` is the
symlinkJoin of the vsix + the modes tree in one store path.

## 4. `nix flake check`

```
$ nix flake check
checking derivation packages.aarch64-darwin.default...            OK
checking derivation packages.aarch64-darwin.menagerie-vsix...     OK
checking derivation packages.aarch64-darwin.menagerie-modes...    OK
checking derivation packages.aarch64-darwin.menagerie-with-modes... OK
checking flake output 'homeManagerModules'...  (warning: unknown flake output — informational; nix
                                                has no built-in checker for the HM output type)
checking flake output 'nixosModules'...
checking NixOS module 'nixosModules.default'...                   OK
checking flake output 'darwinModules'...
all checks passed!
```

### Module evaluation

- `nixosModules.default` is validated by `nix flake check`'s NixOS-module checker (passed).
- `darwinModules.default` has the same shape (checked as a generic module output; passed).
- `homeManagerModules.default` was additionally instantiated with `lib.evalModules` against a minimal
  stub: with `programs.menagerie.enable = true` it yields `home.packages` containing the vsix (1
  package) and defines the `home.activation.menagerie` script. (The real `lib.hm.dag` is provided by
  home-manager at consume time.)

## 5. Source changes

The TS/extension source is unchanged. The only build-time edit is a `postPatch` in `nix/packages.nix`
that rewrites the root `package.json` `packageManager` field to the nixpkgs pnpm version so pnpm does
not self-provision pnpm@10.8.1 from the network offline (turbo requires the field, so it cannot be
deleted). This is a metadata-only packaging patch applied inside the derivation; the repo tree is not
modified. Rationale is documented in `nix-build-design.md` (Implementation notes).

## Summary

All required outputs build and verify: `menagerie-vsix` (PRIMARY, 34 MB installable vsix with
`extension.js`/`dist`/`package.json`), `default`, `menagerie-modes`, `menagerie-with-modes`, and the
home-manager / nixOS / darwin modules all evaluate. `nix flake check` passes. The pnpmDeps FOD hash is
pinned via the two-pass method. `menagerie-cli` remains intentionally deferred (documented).

## 6. Review iteration — fix: seeded mode files were write-only

The reviewer confirmed a blocking defect in `nix/hm-module.nix`: the two `install -m u+w` calls
(project `.roomodes` seeding and global-storage `custom_modes.yaml`) produced mode `0200`
(write-only, no read bit), because `install` applies a symbolic `-m` mode against an all-zero base on
both GNU and BSD. The seeded files were therefore unreadable by the editor/extension, defeating the
mode-discovery paths they exist to feed.

Verified the root cause directly with the host `install`:

```
$ chmod 0444 src.txt
$ install -m u+w  src.txt out_uw.txt   && ls -l out_uw.txt    # --w-------  (0200, write-only)
$ install -m 0644 src.txt out_0644.txt && ls -l out_0644.txt  # -rw-r--r--  (readable)
```

Fix applied in `nix/hm-module.nix`:

- project seeding: `install -m u+w` → `install -m 0644` (world-readable, matches the additive
  `rsync --chmod=u+w` → `0644` used for the `~/.roo` and project `.roo/` trees).
- global storage: `install -m u+w` → `install -m 0600` (private; the global-storage settings dir).

The global `~/.roo` and project `.roo/` `rsync -a --chmod=u+w` paths were already correct (additive
`u+w` keeps the store's read bits) and were left unchanged. A repo-wide grep confirms no remaining
`install -m u+w` in the flake.

Re-verified after the fix:

```
$ nix flake check /…/.worktrees/nix-flake      # all checks passed!
$ nix build /…/.worktrees/nix-flake#menagerie-vsix   # exit 0
$ ls -laL result/*.vsix                        # -r--r--r-- 34613957  zoo-code-3.84.4.vsix (34 MB)
$ unzip -l result/*.vsix | grep -E 'extension/dist/extension.js|extension/package.json'
    16774   extension/package.json
 15028034   extension/dist/extension.js
```

The fix is confined to the two `install` mode strings; no other behavior changed.
