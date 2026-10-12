# Menagerie Flake — Build-Verify Gate

Hard success criterion: an ACTUAL built `.vsix` on disk (not "the derivation looks
right"). This document records every verification command and its real output.

- Worktree: `/Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake`
- Branch: `nix-flake` (working tree clean at start)
- Host: macOS / aarch64-darwin
- Nix: `nix (Nix) 2.35.2`, experimental-features = `fetch-tree flakes nix-command`

## RESULT SUMMARY

**A real `.vsix` WAS produced.**

- Artifact: `zoo-code-3.84.4.vsix`
- Size: **34,613,957 bytes (~33 MB / 33.01 MB per vsce)**
- Store path: `/nix/store/8w24wzgk82sahzkl2amyqbzmlfzzczbm-menagerie-vsix-3.84.4`
- Contains `extension/package.json` + built `extension/dist/extension.js` (15 MB) and
  the full `dist/` bundle (1932 files total in the archive).

All five verification steps passed. No packaging fixes were required; the worktree
was already correct, so no new commits were made (working tree remained clean).

---

## Step 1 — Build `#menagerie-vsix` and `#default`

Command:

```
nix build /Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake#menagerie-vsix \
  --print-build-logs --out-link /tmp/result-vsix
# EXIT_CODE=0
```

```
nix build /Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake#default \
  --print-build-logs --out-link /tmp/result-default
# EXIT_CODE=0
```

Both succeeded. `#default` resolves to the **same** store path as `#menagerie-vsix`:

```
/tmp/result-vsix     -> /nix/store/8w24wzgk82sahzkl2amyqbzmlfzzczbm-menagerie-vsix-3.84.4
/tmp/result-default  -> /nix/store/8w24wzgk82sahzkl2amyqbzmlfzzczbm-menagerie-vsix-3.84.4
```

The build drives the repo's real turbo pipeline through `pnpm vsix`. Build-log tail
(full log saved to `build-vsix-full.log`, 1877 lines):

```
zoo-code:vsix:    ├─ dist/ (175 files) [97.77 MB]
zoo-code:vsix:    └─ webview-ui/ (801 files) [56.01 MB]
zoo-code:vsix:  DONE  Packaged: ../bin/zoo-code-3.84.4.vsix (1932 files, 33.01 MB)
 Tasks:    5 successful, 5 total
```

(Full log head shows: unpackPhase, pnpmConfigHook with pnpm 10.34.5, offline deps
install, then the turbo `vsix` task graph.)

## Step 2 — `ls -la` the result symlink(s); confirm the `.vsix` is non-trivial

```
$ ls -la /tmp/result-vsix
lrwxr-xr-x ... /tmp/result-vsix -> /nix/store/8w24wzgk82sahzkl2amyqbzmlfzzczbm-menagerie-vsix-3.84.4

$ ls -la /tmp/result-vsix/
-r--r--r-- 1 root wheel 34613957 Dec 31 1969 zoo-code-3.84.4.vsix

$ du -h /tmp/result-vsix/zoo-code-3.84.4.vsix
34M	/tmp/result-vsix/zoo-code-3.84.4.vsix
```

**34,613,957 bytes** — a real, non-trivial artifact (not a few bytes).

## Step 3 — `unzip -l` the `.vsix`; confirm package.json + built extension bundle

```
$ unzip -l /tmp/result-vsix/zoo-code-3.84.4.vsix
Archive:  /tmp/result-vsix/zoo-code-3.84.4.vsix
  Length      Date    Time    Name
---------  ---------- -----   ----
     3054  ... extension.vsixmanifest
      942  ... [Content_Types].xml
...
164197888                     1932 files
```

Key entries confirmed present:

```
    16774  ... extension/package.json
 15028034  ... extension/dist/extension.js        <- 15 MB built main bundle
 16039346  ... extension/dist/extension.js.map
   205491  ... extension/dist/tree-sitter.wasm
   ... (full tree-sitter-*.wasm language grammars)
```

Top-level extension directories inside the archive:

```
extension/assets/
extension/dist/
extension/integrations/
extension/webview-ui/
```

The archive contains the extension manifest, `extension/package.json`, and the built
`extension/dist/` bundle (including `extension.js`). Confirmed.

## Step 4 — Build `#menagerie-with-modes`; confirm bundled modes directory present

```
nix build /Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake#menagerie-with-modes \
  --print-build-logs --out-link /tmp/result-with-modes
# this derivation will be built: ...menagerie-with-modes-3.84.4.drv  -> built OK
```

```
$ ls -la /tmp/result-with-modes/
dr-xr-xr-x ... modes
lrwxr-xr-x ... zoo-code-3.84.4.vsix -> /nix/store/8w24...menagerie-vsix-3.84.4/zoo-code-3.84.4.vsix

$ find /tmp/result-with-modes/modes -maxdepth 2 | sort
/tmp/result-with-modes/modes
/tmp/result-with-modes/modes/aar
/tmp/result-with-modes/modes/aar/roo
/tmp/result-with-modes/modes/aar/roomodes.yaml
/tmp/result-with-modes/modes/aar/tools
/tmp/result-with-modes/modes/repo
/tmp/result-with-modes/modes/repo/roo
/tmp/result-with-modes/modes/repo/roomodes.yaml
```

The output joins the vsix with a `modes/` tree containing both bundled profiles:
`aar` (AA&R v2 pack: `roo/`, `roomodes.yaml` 15 KB, `tools/`) and `repo` (in-repo
profile: `roo/`, `roomodes.yaml` 8.8 KB). Bundled modes directory present. Confirmed.

## Step 5 — `nix flake check` + evaluate the four flake outputs

```
nix flake check /Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake \
  --print-build-logs --no-build
```

Output:

```
evaluating flake...
checking flake output 'packages'...
checking derivation packages.aarch64-darwin.default...        -> evaluated to .drv
checking derivation packages.aarch64-darwin.menagerie-vsix... -> evaluated to .drv
checking derivation packages.aarch64-darwin.menagerie-modes...-> evaluated to .drv
checking derivation packages.aarch64-darwin.menagerie-with-modes... -> evaluated to .drv
checking flake output 'homeManagerModules'...
warning: unknown flake output 'homeManagerModules'
checking flake output 'nixosModules'...
checking NixOS module 'nixosModules.default'...
checking flake output 'darwinModules'...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux, x86_64-darwin, x86_64-linux
Use '--all-systems' to check all.
```

`nix flake check` **passed** ("all checks passed!").

Two expected caveats, handled by direct option-set evaluation below:
- `nix flake check` does not have a schema for `homeManagerModules`, so it emits
  `warning: unknown flake output 'homeManagerModules'` and does not structurally
  validate it. (It does validate `nixosModules.default`; it recognizes
  `darwinModules` as an output.)
- On this aarch64-darwin host, flake check omits the three incompatible systems
  (aarch64-linux, x86_64-darwin, x86_64-linux) rather than cross-evaluating them.

Because flake check cannot cross-eval all four systems here, the module option sets
were evaluated directly (as instructed). Harness
`/tmp/eval-modules.nix` uses `lib.evalModules` with stubbed base options
(`environment.systemPackages`, `home.packages`, `home.homeDirectory`,
`home.activation`) that the consumer modules write into but that normally come from
the real nixos/darwin/home-manager module systems. This proves each module's own
option set evaluates in isolation.

Command + output:

```
nix eval --impure --json --file /tmp/eval-modules.nix
```

```json
{
  "darwin":      {"evaluated":true,"hasEnableOption":true,"installModesDefault":true},
  "homeManager": {"evaluated":true,"hasEnableOption":true,"hasPackageOption":true,"modesProfileDefault":"aar"},
  "nixos":       {"evaluated":true,"hasEnableOption":true,"installModesDefault":true}
}
```

All four flake outputs EVALUATE on this host:
- `packages.aarch64-darwin.{default,menagerie-vsix,menagerie-modes,menagerie-with-modes}`
  — all build (steps 1 and 4) and all evaluate to derivations in flake check.
- `homeManagerModules.default` — evaluates; `programs.menagerie.enable` option present,
  `programs.menagerie.package` present, `modes.profile` default = `"aar"`.
- `nixosModules.default` — evaluates; `services.menagerie.enable` present,
  `installModes` default = `true`. Also validated by `nix flake check`.
- `darwinModules.default` — evaluates; `services.menagerie.enable` present,
  `installModes` default = `true`.

Full activation (actually installing the extension / seeding `~/.roo` / writing
system profiles) is explicitly out of scope; only option-set evaluation was required
and performed.

---

## Artifacts

- Full vsix build log: `.agents/tasks/menagerie-flake/build-vsix-full.log` (1877 lines)
- `nix flake check` log: captured inline above
- Module eval harness: `/tmp/eval-modules.nix` (ephemeral)

## Final verdict

A real `.vsix` was produced: `zoo-code-3.84.4.vsix`, **34,613,957 bytes (~33 MB)**,
at `/nix/store/8w24wzgk82sahzkl2amyqbzmlfzzczbm-menagerie-vsix-3.84.4`. It contains
`extension/package.json` and the built `extension/dist/extension.js` bundle. The
`menagerie-with-modes` output bundles both `aar` and `repo` mode profiles. `nix flake
check` passes, and all four flake outputs (packages, homeManagerModules.default,
nixosModules.default, darwinModules.default) evaluate on this host.
