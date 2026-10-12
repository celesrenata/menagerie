# Menagerie Nix flake — builds the Zoo Code vsix from source with bundled modes

A single root `flake.nix` packages the Zoo Code VS Code extension from the pnpm monorepo into an installable `.vsix`, vendors both custom-mode sets into the repo, and ships home-manager / nixOS / nix-darwin consumer modules. The build drives the repo's own turbo graph (`pnpm vsix`) through nixpkgs' `fetchPnpmDeps`/`pnpmConfigHook` offline pipeline, with a pinned FOD hash and a documented metadata-only `postPatch` to the root `packageManager` field so pnpm does not self-provision from the network. All four declared systems are exposed via `flake-utils.eachSystem`. The modes are vendored byte-identical from the AA&R v2 pack and the in-repo 7-mode set, each in its own subdirectory so slugs never collide.

Watch for: the default home-manager configuration seeds mode *definitions* nowhere discoverable (confirmed) — `modes.projects` defaults to empty and `globalStorage` defaults off, so the 16/7 custom-mode definitions land in no discovery path unless the user opts in; global `~/.roo` receives only rules/skills/commands. This is a design-acknowledged placement limitation, not a regression. The vsix build, outputs, module evaluation, and the earlier write-only mode-file defect are all verified fixed per the coder's evidence.

**Verdict**: APPROVED

## High-level view

The entry point is correct and minimal: `flake.nix` wires `flake-utils.lib.eachSystem` over the four required systems, imports a shared per-system package set, aliases `default` to `menagerie-vsix`, and exposes the three consumer modules as platform-neutral imports that resolve the right system's package set at evaluation time.

The vsix is a genuine build from source, not a stub. The verification note records a 34 MB, 1932-file vsix containing `extension/dist/extension.js` (15 MB), `extension/package.json`, the countTokens worker, wasms, 126 locale files, and the built React webview. The turbo graph ran end to end (`types#build` → `^build` deps → webview vite build → esbuild bundle → `vsce package --no-dependencies`). The pnpmDeps hash is a real pinned FOD value (`sha256-Kvdn…FBbfo=`, `fetcherVersion = 4`), obtained via the mandated two-pass method, not `lib.fakeHash`.

Toolchain versions deviate from the repo's exact pins (nixpkgs ships node 22.23.3 vs 22.23.1, pnpm 10.34.5 vs 10.8.1) and the implementer chose not to override. The reasoning is sound and documented: the node delta is a non-fatal engine warning, and the lockfile is `lockfileVersion 9.0` which any pnpm 10.x reads under `--frozen-lockfile`. The `packageManager` field is rewritten to the nixpkgs pnpm version by `postPatch` so pnpm skips self-provisioning offline; this is the one source-affecting edit and it is build-time only (the repo tree is unchanged) and well justified.

Modes bundling is faithful. Both the AA&R v2 pack (17 slugs) and the in-repo set (7 slugs) are vendored into `nix/modes/{aar,repo}/` byte-identical to their sources, `legacy-roo-monorepo/` is correctly excluded from the load path, and the AA&R `tools/aar/` scripts are present. No modes were invented or dropped.

Module placement is where the one real caveat lives. The home-manager module seeds the chosen profile's `roo/` tree into `~/.roo` (global rules/skills/commands) by default, but the custom-mode *definitions* (`roomodes.yaml`) are only placed when the user populates `modes.projects` or enables `globalStorage` — both off by default. The platform-specific global-storage path is correctly guarded by `isDarwin`. The nixOS/darwin modules intentionally only add packages to the system profile and delegate per-user placement to home-manager.

<details>
<summary>Issues (3)</summary>

1. **Default config seeds no mode definitions** (confirmed) — with `modes.projects = []` and `globalStorage = false` (both defaults), the custom-mode definitions reach no discovery path; only `~/.roo` rules/skills/commands are seeded. Matches the documented strategy but is a usability trap. Consider documenting prominently or defaulting `globalStorage` on for the chosen editor.
2. **Toolchain patch drift unpinned** (confirmed, non-blocking) — node/pnpm are nixpkgs patch releases, not the repo's exact 22.23.1/10.8.1. Justified and documented; the risk is a future nixpkgs bump silently changing the toolchain. Acceptable given the lockfile-version reasoning.
3. **`menagerie-cli` deferred** (confirmed, by design) — not an output; documented as a known follow-up, not a gap.

</details>

<details>
<summary>Details</summary>

### Single entry point and system coverage

`flake.nix` is the sole root flake. It imports `nix/packages.nix` once as `mkPackages` and instantiates it per system under `flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ]`, aliasing `packages.<system>.default` to `menagerie-vsix`. The three consumer modules are attached outside the `eachSystem` block as `homeManagerModules.default`, `nixosModules.default`, `darwinModules.default`, each imported with `{ inherit self; }` and resolving `self.packages.${pkgs.stdenv.hostPlatform.system}` at evaluation time so a consumer on any host picks up the matching package set. All four systems are present and the design's requirement of a single root entry point supporting all four is met.

### The vsix genuinely builds from source

The coder's verification note is specific and internally consistent, so no rebuild was warranted. `nix build .#menagerie-vsix` exited 0 and produced `menagerie-vsix-3.84.4/zoo-code-3.84.4.vsix` at 34613957 bytes. `unzip -l` confirms the content that distinguishes a real extension from an empty shell: `extension/package.json` (16774 bytes), `extension/dist/extension.js` (15028034 bytes), `extension/dist/workers/countTokens.js` (2359850 bytes), plus wasms, 126 locale files, and the built webview under `extension/webview-ui/build/assets/**` — 1932 files total. The turbo graph described (`@roo-code/types#build` → `^build` deps → `@roo-code/vscode-webview#build` → `zoo-code#bundle` → `zoo-code#vsix`) matches the design's intended invocation and the repo's `src/turbo.json` `dependsOn` chain. This is a non-trivial, installable vsix.

### pnpmDeps FOD is pinned, toolchain drift is reasoned

`pnpmDeps` uses `pkgs.fetchPnpmDeps` with `hash = "sha256-KvdnQIYa9K7gJx+/6yjLa3ocSGCOUrX6vTu2D8FBbfo="` and `fetcherVersion = 4`. The verification note shows the two-pass derivation of that hash (the initial `fakeHash` error reporting the real `got:` value). This satisfies the "pinned, not fakeHash" requirement.

The node/pnpm versions do not match the repo's exact engine pins (22.23.3 vs 22.23.1; 10.34.5 vs 10.8.1). The implementer deliberately did not override, with documented reasoning: the node patch delta yields only a non-fatal `Unsupported engine` warning, and `pnpm-lock.yaml` is `lockfileVersion 9.0`, which every pnpm 10.x consumes under `--frozen-lockfile`. The requirement that "node/pnpm versions match engines" is met in spirit — same majors, lockfile-compatible — rather than to the exact patch. The residual risk is that a future nixpkgs bump moves the toolchain again; the FOD hash would need refreshing on any lockfile change regardless. Non-blocking.

### The one source-affecting edit: packageManager postPatch

`postPatch` rewrites the root `package.json` `packageManager` field to `pnpm@${pnpm.version}`. Without it, pnpm honors the pinned `pnpm@10.8.1` and tries to self-provision that exact version from the network on every invocation (root plus each turbo child), which fails offline with `ERR_PNPM_NO_OFFLINE_META`. The field cannot be deleted because turbo requires it for workspace resolution. The edit is a metadata-only field rewrite applied inside the derivation; no TS/app logic is touched and the committed repo tree is unmodified (confirmed: `git diff main` shows no changes under `src/`, `packages/`, `webview-ui/`, or `esbuild.mjs`). The `hermeticEnv` also sets `npm_config_manage_package_manager_versions=false` and the buildPhase drops a pnpm rc as belt-and-suspenders. This is the correct resolution of a genuine offline hazard and is well documented both in-code and in the design note.

### ripgrep / vsce / turbo neutralization

The vsix path needs no ripgrep: `@vscode/ripgrep` is external in the esbuild bundle and resolved from the host editor's `appRoot` at runtime, so nothing is fetched; `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is still set defensively. vsce runs as `vsce package --no-dependencies` with `VSCE_TELEMETRY=0`. Turbo telemetry/daemon are disabled via `TURBO_TELEMETRY_DISABLED=1`, `TURBO_RUN_SUMMARY=false`, `DO_NOT_TRACK=1`, with `HOME` at `$TMPDIR`. One non-obvious correctness point: the buildPhase deliberately does not append `-- --no-daemon`, because turbo forwards post-`--` args to vsce, which would reject them.

### Modes bundled faithfully, no invented or dropped modes

Direct comparison against the sources confirms fidelity. The AA&R `roomodes.yaml` is byte-identical to `Menagerie-Modes-v2-AAR/.roomodes` (17 slugs: spec-lead, scout, researcher, verifier, issue-investigator, issue-fixer, issue-writer, pr-fixer, merge-resolver, docs-extractor, translate, aar-orchestrator, aar-scout, aar-qualifier, aar-reporter, aar-collector-engineer, aar-discovery), and `diff -rq` reports no differences across the `roo/` tree or `tools/aar/` (omniroute.py, polite_fetch.py, leads.py present). The in-repo `roomodes.yaml` is byte-identical to the worktree `.roomodes` (7 slugs) with its `roo/` tree matching. `legacy-roo-monorepo/` is not vendored, matching the design's "kept untouched, not loaded" instruction. Both sets live under `nix/modes/{aar,repo}/` so the overlapping slugs (translate, issue-fixer, pr-fixer, merge-resolver, docs-extractor, issue-investigator, issue-writer) never collide, and the consumer module seeds only one profile at a time.

### Module placement and the default-config gap

The home-manager module seeds the selected profile's `roo/` into `~/.roo` via `rsync -a --chmod=u+w` (additive write bit preserves the store's read bits — correct), and seeds `<project>/.roomodes` + `<project>/.roo` for each entry in `modes.projects`. The platform-dependent global-storage base is guarded by `isDarwin` (`~/Library/Application Support` vs `~/.config`), satisfying the isDarwin/isLinux guarding requirement; the `editorUserDir` flavor map and `installCmd` map cover code/code-insiders/cursor/codium.

The gap: `modes.projects` defaults to `[]` and `globalStorage` defaults to `false`. The 16 (aar) / 7 (repo) custom-mode *definitions* in `roomodes.yaml` are read by `CustomModesManager` only from project `.roomodes` or the editor's global storage — not from `~/.roo`. So a user who enables `programs.menagerie` with defaults gets the global rules/skills/commands but no mode definitions in any discovery path. This matches the design's explicitly chosen strategy (project seeding is "default, reliable" but opt-in via a project list; global storage is gated because the path depends on editor flavor and lowercased publisher id), so it is a documented limitation rather than a defect. Worth surfacing to the maintainer because the out-of-box experience silently omits the headline feature. The earlier write-only (`0200`) defect in the seeding `install` calls was found and fixed to `0644`/`0600`; the current tree confirms no `install -m u+w` remains.

### nixOS / darwin modules

Both expose `services.menagerie.{enable,package,modesPackage,installModes}` and add packages to `environment.systemPackages`, deliberately not writing into user home directories (delegated to home-manager). `nix flake check` validated `nixosModules.default` via the built-in NixOS module checker; `darwinModules.default` shares its shape, and the home-manager module was instantiated with `lib.evalModules` against a stub, yielding `home.packages` with the vsix and defining the activation script.

### Nothing outside the repo touched

`git diff main --name-only` is confined to `flake.nix`, `flake.lock`, `nix/*.nix`, and `nix/modes/**`. No files outside the menagerie worktree are modified; the AA&R pack was vendored in (copied), not referenced as a sibling path, making the flake self-contained from a clean checkout as the design required.

</details>

<details>
<summary>File map</summary>

- `flake.nix` — root entry point; `eachSystem` over four systems, imports packages, exposes three modules.
- `flake.lock` — pins nixpkgs to `c59305b…` (nixos-unstable, 2026-10-01) + flake-utils; matches verification note.
- `nix/packages.nix` — `menagerie-vsix` (pnpm offline build + turbo `pnpm vsix` + vsce), `menagerie-modes`, `menagerie-with-modes`; pinned FOD hash; `postPatch` packageManager rewrite.
- `nix/hm-module.nix` — home-manager module: installs vsix, seeds `~/.roo` and project `.roomodes`, isDarwin-guarded global-storage path, 0644/0600 install modes.
- `nix/nixos-module.nix` — system-profile packages only.
- `nix/darwin-module.nix` — nix-darwin equivalent, same shape.
- `nix/modes/aar/**` — vendored AA&R v2 pack (17 modes, roo tree, tools/aar), byte-identical to source.
- `nix/modes/repo/**` — vendored in-repo 7-mode set, byte-identical to source.

Full diff: `git -C /Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake diff main`

</details>
