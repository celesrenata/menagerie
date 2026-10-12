# Consuming the Menagerie flake

This flake builds the Menagerie (Zoo Code) VS Code extension from source into a
`.vsix`, bundles its custom modes, and ships home-manager / nixOS / nix-darwin
modules so a downstream flake gets the extension plus modes on Linux and Darwin.

Supported systems: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`,
`x86_64-darwin`. The vsix is platform-independent JS, so all four
`menagerie-vsix` outputs are byte-identical; every system still exposes its own
output so a host on any platform can `nix build`.

## Flake output surface

```
packages.<system>.menagerie-vsix        # the built zoo-code-<version>.vsix (PRIMARY)
packages.<system>.default               # = menagerie-vsix
packages.<system>.menagerie-modes       # the bundled custom modes tree (aar/ + repo/)
packages.<system>.menagerie-with-modes  # symlinkJoin: vsix + a modes/ tree in one path
homeManagerModules.default              # programs.menagerie — installs vsix + places modes
nixosModules.default                    # services.menagerie — adds packages to system profile
darwinModules.default                   # services.menagerie — nix-darwin equivalent
```

`menagerie-modes` lays its two profiles out in subdirectories so slugs never
collide:

- `aar/` — the AA&R v2 pack (default, 16 modes): `roomodes.yaml`, `roo/`, `tools/aar/`.
- `repo/` — the in-repo 7-mode set: `roomodes.yaml`, `roo/`.

`menagerie-cli` is intentionally **not** an output (deferred — see the design
doc).

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

Works on both Linux and Darwin. This installs the vsix and seeds the bundled
custom modes into the user's discovery paths.

```nix
# In your home-manager configuration
{ inputs, ... }:
{
  imports = [ inputs.menagerie.homeManagerModules.default ];

  programs.menagerie = {
    enable = true;

    # Place the vsix in the Nix store only (default) or auto-install it.
    installExtension = true;        # runs `<editor> --install-extension <vsix>` on activation
    # package = ...;                # defaults to the flake's menagerie-vsix

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
  best-effort write of `custom_modes.yaml` into the editor's global-storage
  path (its location depends on `modes.editor`).
- `installExtension = false` (default) only places the vsix in the store; install
  it manually (see section 2c).

## 2b. Install via nixOS / nix-darwin (`nixosModules.default` / `darwinModules.default`)

These are system-level modules. They add the vsix (and optionally the modes
package) to the system profile so any user can reach them. They do **not** write
into user home directories — pair them with the home-manager module for per-user
mode placement.

Both modules expose the same `services.menagerie` options.

nixOS (Linux):

```nix
{ inputs, ... }:
{
  imports = [ inputs.menagerie.nixosModules.default ];

  services.menagerie = {
    enable = true;
    installModes = true;   # also add menagerie-modes to the system profile (default true)
    # package = ...;        # defaults to menagerie-vsix
    # modesPackage = ...;   # defaults to menagerie-modes
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

With the system module active, the vsix ends up in the system profile; combine
with `programs.menagerie` (home-manager) if you also want modes placed into
`~/.roo` and project roots.

## 2c. Just build the vsix and install manually

No modules required — build the package directly and install the vsix into your
editor.

```sh
# Build the vsix (replace <system>/default as needed; default == menagerie-vsix)
nix build github:celesrenata/menagerie#menagerie-vsix

# The vsix lands in ./result/
code --install-extension ./result/zoo-code-*.vsix
```

Build the vsix together with the modes tree in one store path:

```sh
nix build github:celesrenata/menagerie#menagerie-with-modes
# result/zoo-code-*.vsix   -> the extension
# result/modes/aar/ , result/modes/repo/  -> the bundled modes profiles
code --install-extension ./result/zoo-code-*.vsix
```

Build just the modes tree:

```sh
nix build github:celesrenata/menagerie#menagerie-modes
# result/aar/ , result/repo/
```

To seed modes manually after a `menagerie-modes` / `menagerie-with-modes` build,
copy the chosen profile's `roo/` into `~/.roo` and drop `roomodes.yaml` as
`.roomodes` in the project you want the custom modes in:

```sh
rsync -a result/aar/roo/ ~/.roo/
install -m 0644 result/aar/roomodes.yaml ~/dev/foo/.roomodes
rsync -a result/aar/roo/ ~/dev/foo/.roo/
```

## Refreshing the pnpm FOD hash

The build depends on a fixed-output `pnpmDeps` derivation keyed on
`pnpm-lock.yaml` (`nix/packages.nix`, `fetcherVersion = 4`). If the lockfile
changes, refresh the hash with the two-pass method: set `hash = lib.fakeHash`,
run `nix build`, read the real `got:` hash from the error, and pin it.

---

See `nix-build-design.md` in this directory for the full build and packaging
design, hazard resolutions, and the deferred `menagerie-cli` plan.
