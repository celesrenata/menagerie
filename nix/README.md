# Menagerie Nix flake

This flake builds the **Menagerie** VS Code extension (`celesrenata.menagerie`) from source into
a `.vsix`, bundles its custom modes, and ships home-manager / NixOS / nix-darwin
modules so a downstream flake gets the extension plus modes on Linux and Darwin.

Supported systems: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`,
`x86_64-darwin`. The vsix is platform-independent JS, so all four
`menagerie-vsix` outputs are byte-identical; every system still exposes its own
output so a host on any platform can `nix build`.

## Flake output surface

```
packages.<system>.menagerie-vsix        # the built menagerie-<version>.vsix (PRIMARY)
packages.<system>.menagerie-vscode-extension
                                        # the vsix unpacked as a nixpkgs VS Code extension
packages.<system>.default               # = menagerie-vsix
packages.<system>.menagerie-modes       # the bundled custom modes tree (aar/ + repo/)
packages.<system>.menagerie-with-modes  # symlinkJoin: vsix + a modes/ tree in one path
homeManagerModules.default              # programs.menagerie — installs the extension + places modes
nixosModules.default                    # services.menagerie — adds packages to system profile
darwinModules.default                   # services.menagerie — nix-darwin equivalent
```

`menagerie-modes` lays its two profiles out in subdirectories so slugs never
collide:

- `aar/` — the AA&R v2 pack (default, 16 modes): `roomodes.yaml`, `roo/`, `tools/aar/`.
- `repo/` — the in-repo 7-mode set: `roomodes.yaml`, `roo/`.

## Quick start — build and install the vsix

No modules required. Build the extension and install it into your editor:

```sh
nix build github:celesrenata/menagerie#menagerie-vsix
code --install-extension ./result/menagerie-*.vsix
```

Build the vsix together with the bundled modes in one store path:

```sh
nix build github:celesrenata/menagerie#menagerie-with-modes
# result/menagerie-*.vsix              -> the extension
# result/modes/aar/ , result/modes/repo/  -> the bundled mode profiles
code --install-extension ./result/menagerie-*.vsix
```

## 1. Add the input

In your downstream `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    menagerie.url = "github:celesrenata/menagerie";
    # Optional: share your nixpkgs so you don't evaluate two copies.
    menagerie.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, menagerie, ... }: {
    # ... see the module sections below ...
  };
}
```

Pin to a tag or revision in production (`github:celesrenata/menagerie/<rev>`)
rather than tracking the default branch.

## 2a. Install via home-manager (`homeManagerModules.default`)

Works on both Linux and Darwin. Installs the extension on every switch and seeds
the bundled custom modes into the user's discovery paths.

```nix
{ inputs, ... }:
{
  imports = [ inputs.menagerie.homeManagerModules.default ];

  programs.menagerie = {
    enable = true;

    # Default: copy the build into ~/.vscode/extensions on every switch.
    vscode.enable = true;           # default true
    # vscode.extensionsDir = "...";  # defaults per modes.editor (~/.vscode/extensions for code)
    # vscode.removeLegacyZooCode = true;  # default true; see "Migrating from Zoo Code"
    # installExtension = true;      # alternative: run `<editor> --install-extension <vsix> --force`

    modes = {
      enable = true;                # default true
      profile = "aar";             # "aar" (16 modes, default) or "repo" (7 modes)
      editor = "code";             # code | code-insiders | cursor | codium
      global = true;                # seed profile roo/ into ~/.roo (global rules/skills/commands)
      projects = [ "~/dev/foo" ];  # seed <project>/.roomodes + <project>/.roo for project modes
      globalStorage = false;        # optional best-effort write to the editor's global-storage custom_modes.yaml
    };
  };
}
```

Notes:

- `modes.global = true` rsyncs the selected profile's `roo/` tree into `~/.roo`,
  which every workspace reads for rules/skills/commands.
- Custom **mode definitions** (`roomodes.yaml`) are seeded per-project via
  `modes.projects`, because global custom modes live in the editor's global
  storage and are not declaratively stable. `modes.globalStorage` is an opt-in,
  best-effort write of `custom_modes.yaml` into the editor's global-storage path.
- `vscode.enable` (default) copies the extension into the editor's extensions
  directory as a real directory and registers it in `extensions.json`. A real copy
  is required: VS Code 1.140+ marks symlinked extension directories obsolete, so
  `programs.vscode.profiles.*.extensions` cannot load it. The copy is replaced
  whenever the build's store path changes, even if the version number did not,
  and the activation prints a line asking you to reload VS Code windows.
- `installExtension` is for editors whose CLI should do the install instead
  (Cursor, VSCodium, a VS Code outside Nix). It runs with `--force` because
  rebuilds usually keep the same version, and it looks for the CLI in the usual
  app locations because activation runs with a minimal `PATH`. Turn it on
  *instead of* `vscode.enable`, not alongside it.

### Migrating from Zoo Code

Menagerie used to ship under Zoo Code's id (`ZooCodeOrganization.zoo-code`). It
now has its own id, `menagerie.*` command and settings keys, and its own
global-storage folder (`celesrenata.menagerie`).

On first start, Menagerie imports Zoo Code's task history, custom modes, MCP
settings and `zoo-code.*` settings, but only once Zoo Code is uninstalled.
`vscode.removeLegacyZooCode` (default on) removes the old Zoo Code extension
code for you; Zoo's data is left in place for the import. API keys live in
per-extension secret storage and cannot be moved: re-enter them, or point
`menagerie.autoImportSettingsPath` at a settings export.

## 2b. Install via NixOS / nix-darwin

System-level modules. They add the vsix (and optionally the modes package) to
the system profile so any user can reach them. They do **not** write into user
home directories — pair them with the home-manager module for per-user mode
placement. Both expose the same `services.menagerie` options.

NixOS (Linux):

```nix
{ inputs, ... }:
{
  imports = [ inputs.menagerie.nixosModules.default ];
  services.menagerie = {
    enable = true;
    installModes = true;   # also add menagerie-modes to the system profile (default true)
  };
}
```

nix-darwin (macOS):

```nix
{ inputs, ... }:
{
  imports = [ inputs.menagerie.darwinModules.default ];
  services.menagerie = {
    enable = true;
    installModes = true;
  };
}
```

## Refreshing the pnpm FOD hash

The build depends on a fixed-output `pnpmDeps` derivation keyed on
`pnpm-lock.yaml` (`nix/packages.nix`, `fetcherVersion = 4`). If the lockfile
changes, refresh the hash with the two-pass method: set `hash = lib.fakeHash`,
run `nix build`, read the real `got:` hash from the error, and pin it.

## Packaging notes

- The build drives the repo's own `pnpm vsix` → turbo graph → `vsce package
--no-dependencies`; the only source-affecting change is a build-time
  `postPatch` that rewrites the root `package.json` `packageManager` field to the
  nixpkgs pnpm version so pnpm does not try to self-provision from the network in
  the offline sandbox. Extension logic is untouched.
- `@vscode/ripgrep` needs no neutralization: it is external to the esbuild bundle
  and resolved from the host VS Code `appRoot` at runtime.
- `menagerie-cli` (`apps/cli`) is intentionally deferred and is not a flake
  output.
