# Menagerie Nix Flake — Build & Packaging Design

Read-only design pass. Target repo: the pnpm monorepo at `.worktrees/nix-flake` (checked out at
`/Users/celes/sources/celesrenata/menagerie/.worktrees/nix-flake`). Goal: a single self-contained
flake that **builds the VS Code extension (`src`) from source** into a `.vsix`, bundles its custom
modes, and ships home-manager / nixOS / nix-darwin modules so a consumer gets the extension plus
modes on `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, `x86_64-darwin`.

## Repo facts this design is grounded in

Verified by reading the worktree:

- Root `package.json`: `name: roo-code`, `packageManager: pnpm@10.8.1`, `engines.node: 22.23.1`
  (also pinned in `.nvmrc` / `.tool-versions`). `pnpm.onlyBuiltDependencies: ["@vscode/ripgrep"]`.
  `preinstall`/`install` run `scripts/bootstrap.mjs`, which **exits immediately (status 0) when
  invoked through pnpm** (`npm_execpath` contains `pnpm`) — it downloads nothing in our path.
- Workspace members (`pnpm-workspace.yaml`): `src` (the extension), `webview-ui` (React webview),
  `apps/*` (`cli`, `vscode-e2e`), `packages/*` (`build, cloud, config-eslint, config-typescript,
  core, ipc, telemetry, types, vscode-shim`).
- Extension manifest `src/package.json`: `name: zoo-code`, `publisher: ZooCodeOrganization`,
  `version: 3.84.4`, `main: ./dist/extension.js`, `engines.vscode: ^1.100.0`. Extension id is
  therefore **`ZooCodeOrganization.zoo-code`** and the vsix filename is **`zoo-code-3.84.4.vsix`**.
- Build scripts (`src/package.json`):
  - `bundle`: `node esbuild.mjs` (esbuild, cjs, `platform: node`, outfile `dist/extension.js` +
    `dist/workers/countTokens.js`; copies README/CHANGELOG/LICENSE, wasms, locales, material icons,
    webview audio, marketplace assets into `dist`).
  - `vscode:prepublish`: `pnpm bundle --production`.
  - `vsix`: `mkdirp ../bin && vsce package --no-dependencies --out ../bin` → writes
    `<repo>/bin/zoo-code-<version>.vsix`.
- Turbo graph (`src/turbo.json`): `bundle` dependsOn `^build` + `@roo-code/vscode-webview#build`;
  `vsix` dependsOn `bundle`. Root `turbo.json` defines a generic `build` task
  (`outputs: ["dist/**"]`). Running `pnpm vsix` from the repo root therefore drives:
  `@roo-code/types#build` and the other workspace `^build` deps → webview `build` (vite, emits to
  `src/webview-ui/build`, per `webview-ui/vite.config.ts`) → `src` `bundle` (esbuild) → `src` `vsix`
  (vsce pack).
- `esbuild.mjs` marks `["vscode","esbuild","global-agent","@vscode/ripgrep"]` as **external**.
  `undici` is bundled on purpose "because our VSIX is packaged with `--no-dependencies`".
- `src/.vscodeignore` excludes everything then re-includes `package.json`, `package.nls.*`, `dist`,
  `README.md`/`CHANGELOG.md`/`LICENSE`, the built webview under `webview-ui/build/assets/**` +
  `webview-ui/audio`, default themes, and `assets/**`. So **the vsix content is fully determined by
  what `bundle` produced in `dist` + the pre-existing assets/manifest** — vsce does not need
  `node_modules`.

### How ripgrep is actually used (resolves hazard #2)

- `@vscode/ripgrep` is **not** a dependency of `src`; the lockfile shows it only under `apps/cli`
  (`specifier ^1.15.9`, resolved `1.18.0`). It is `external` in the extension bundle.
- At runtime the extension finds ripgrep **inside the host VS Code install** via
  `vscode.env.appRoot` (`src/services/ripgrep/index.ts` → `getBinPath`/`ripgrepCandidatePaths`),
  probing `@vscode/ripgrep`, `@vscode/ripgrep-universal`, and the `@vscode/ripgrep-<platform>-<arch>`
  layouts under the editor's `appRoot`. The extension **never** ships or downloads its own ripgrep.
- Consequence: **the vsix build does not need `@vscode/ripgrep` at all.** We do not fetch its binary
  and do not need it present. `onlyBuiltDependencies: ["@vscode/ripgrep"]` only matters if we later
  build the CLI (deferred — see outputs). `@vscode/ripgrep@1.18.0` uses prebuilt per-platform
  optional npm packages (regular tarballs in the lockfile), not a network postinstall download, so
  even the CLI path is sandbox-friendly as long as we neutralize env-driven downloads defensively.

## (a) pnpm offline strategy & where the FOD lives

Use nixpkgs' native pnpm 10 support: `pnpm_10` + `pnpm_10.configHook` (a.k.a. `pnpmConfigHook`) and
`pnpm_10.fetchDeps`, which produce a **fixed-output derivation (`pnpmDeps`)** containing the pnpm
content-addressed store, keyed on `pnpm-lock.yaml`.

- Pin `pnpm` to the repo's version. nixpkgs exposes `pnpm_10`; assert/override it to **10.8.1** to
  match `packageManager` (if the pinned nixpkgs `pnpm_10` differs, override via
  `pnpm_10.override`/a small `pnpm` package pin so `--frozen-lockfile` stays satisfiable).
- `pnpmDeps = pnpm_10.fetchDeps { pname = "menagerie"; version = "3.84.4"; src = ./.; hash = "…"; }`.
  Because this is a workspace monorepo, let `fetchDeps` install the **whole workspace**
  (`fetchDeps` runs `pnpm install` honoring `pnpm-workspace.yaml`); do not restrict to a single
  member — the vsix build needs `@roo-code/types`, `build`, `core`, `cloud`, `ipc`, `telemetry`,
  `vscode-shim`, plus `webview-ui`.
- The main build derivation consumes it with `pnpmConfigHook`, which sets `pnpm config` to use the
  offline store and runs `pnpm install --frozen-lockfile --offline` with no network.
- **Hash via the mandated two-pass method:** first set `hash = lib.fakeHash`, run the build, read
  the real `got:` hash from the Nix error, then pin it. The FOD lives **in the flake** as the
  `pnpmDeps` derivation (not vendored into the repo); its hash is the only value committed into the
  flake and must be refreshed whenever `pnpm-lock.yaml` changes.

Env for `fetchDeps`/install to stay hermetic and skip opportunistic binary downloads (defensive even
though the vsix path needs none): `ELECTRON_SKIP_BINARY_DOWNLOAD=1`,
`PUPPETEER_SKIP_DOWNLOAD=1`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `CYPRESS_INSTALL_BINARY=0`,
`HUSKY=0` (skip the `prepare: husky` git-hook install), `npm_config_offline=true`.

## (b) How ripgrep & vsce binary downloads are neutralized

- **ripgrep (build time):** nothing to neutralize for the vsix — `src` neither bundles nor downloads
  it. The esbuild `external` list keeps `@vscode/ripgrep` out of the bundle; the runtime uses the
  host editor's copy. We still export `ELECTRON_SKIP_BINARY_DOWNLOAD=1` during install as a belt-and-
  suspenders guard. (If/when the CLI output is enabled, supply ripgrep from nixpkgs `ripgrep` and/or
  rely on the already-prebuilt `@vscode/ripgrep-<platform>-<arch>` tarball present in `pnpmDeps`; do
  not run its network postinstall.)
- **vsce (package time):** package with **`vsce package --no-dependencies`** (already the repo's
  `vsix` script). `--no-dependencies` makes vsce skip dependency resolution/`npm install` and skip
  the prepublish-driven dep walk; it packs purely from `src/.vscodeignore`. vsce needs no network.
  Two vsce gotchas handled:
  - vsce warns/fails on a missing `repository`; `src/package.json` already has a `repository` field,
    so no `--allow-missing-repository` needed.
  - vsce wants `LICENSE`/`README.md`; the `bundle` step copies both into `src` (`copyPaths` pulls
    `../README.md`, `../CHANGELOG.md`, `../LICENSE`), and `.vscodeignore` re-includes them. Set
    `VSCE_TELEMETRY=0` (and `TURBO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) to keep it silent/offline.

## (c) Exact build invocation that produces the vsix

Build inside the stdenv derivation after `pnpmConfigHook` has materialized `node_modules` offline.
Drive the project's own turbo pipeline through pnpm so the dependency graph (types → other packages →
webview `build` → `src` `bundle` → `src` `vsix`) runs exactly as upstream intends:

```sh
# buildPhase (cwd = repo root, node = nodejs_22 pinned to 22.23.1, pnpm = pnpm_10 @ 10.8.1)
export HOME=$TMPDIR
export CI=1
export HUSKY=0
export TURBO_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1
export VSCE_TELEMETRY=0
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export npm_config_offline=true
# turbo must not reach the network / daemon:
export TURBO_RUN_SUMMARY=false

# Produce the vsix via the repo's turbo task (bundle -> vsce package --no-dependencies).
pnpm vsix

# installPhase: the vsix lands at <repo>/bin/zoo-code-<version>.vsix
mkdir -p $out
cp bin/zoo-code-*.vsix $out/
```

Notes / fallbacks:
- `pnpm vsix` runs `turbo vsix`, which first runs `src#bundle` (esbuild + asset copy) and the webview
  `build`. If turbo's daemon or cache causes trouble in the sandbox, run with `--no-daemon` and
  `TURBO_FORCE=true`, or bypass turbo entirely and run the steps directly in order:
  `pnpm --filter @roo-code/types build` → `pnpm --filter @roo-code/vscode-webview build` →
  `pnpm --filter zoo-code bundle --production` → `pnpm --filter zoo-code exec vsce package
  --no-dependencies --out ../bin`. Prefer the turbo path first since it encodes the real `dependsOn`
  graph; keep the explicit sequence as the documented fallback.
- Pin node to **22.23.1**. If the chosen nixpkgs `nodejs_22` is a different patch, override it; the
  engines field is exact and some deps (and `.tool-versions`) assume it.
- `navigator`/`globalThis.navigator` are defined to `undefined` by esbuild — no action needed; it is
  handled in `esbuild.mjs`.

## (d) Modes bundling — canonical layout & placement

### What to bundle (sources found)

Two mode sources exist. **Decision: the canonical bundled set is the AA&R v2 pack**, because the
user's explicit goal ("all its custom modes", "all features", "keep the uncensored model alive with
all features") maps to the richer, repo-agnostic v2 set, and the pack's own README states the old 7
were stock Roo modes that were rewritten/superseded.

- **Primary (bundle this):** the AA&R v2 pack at the repo *parent* dir
  `/Users/celes/sources/celesrenata/menagerie/Menagerie-Modes-v2-AAR/`:
  - `.roomodes` (16 modes: `spec-lead, scout, researcher, verifier, issue-investigator, issue-fixer,
    issue-writer, pr-fixer, merge-resolver, docs-extractor, translate, aar-orchestrator, aar-scout,
    aar-qualifier, aar-reporter, aar-collector-engineer, aar-discovery`).
  - `.roo/**` (shared `rules/`, per-mode `rules-<slug>/`, `commands/`, `skills/`).
  - `tools/aar/**` (`omniroute.py`, `polite_fetch.py`, `leads.py`).
  - `legacy-roo-monorepo/` is explicitly "kept untouched, not loaded" — **do not** place it in the
    active load path.
  - **Hazard:** this directory is **outside** the `nix-flake` worktree. The flake must either copy
    this tree into the repo under a tracked `nix/modes/` path during the packaging work, or the flake
    `src` for the modes derivation must point at a vendored copy. Implementation must vendor it
    (copy into the repo) so the flake is self-contained and buildable from a clean checkout; a flake
    cannot reference a sibling dir outside its own source tree.
- **Secondary (the in-repo `.roo` + `.roomodes` at the worktree root, 7 modes):** this is the older
  stock set. Keep it available as an alternative modes profile but not the default; or drop it. Default
  to shipping only the v2 pack to avoid slug collisions (both define `translate`, `issue-fixer`, etc.).

### Canonical layout inside the flake

Vendor the chosen pack into the repo and expose it as a derivation `menagerie-modes`:

```
nix/modes/                      # vendored, tracked copy of the AA&R v2 pack
├── roomodes.yaml               # == the pack's .roomodes (custom mode defs)
├── roo/                        # == the pack's .roo/
│   ├── rules/
│   ├── rules-<slug>/ ...
│   ├── commands/
│   └── skills/
└── tools/aar/                  # omniroute.py, polite_fetch.py, leads.py
```

`menagerie-modes` is a trivial derivation that `cp -r`'s `nix/modes` into `$out` (so the layout is a
Nix store path consumers can symlink from).

### How the extension discovers modes at runtime (resolves hazard: placement)

From the source:

- **Project modes** come from `<workspace>/.roomodes` and `<workspace>/.roo/**`
  (`CustomModesManager`, `ROOMODES_FILENAME = ".roomodes"`; `services/roo-config` resolves project
  `.roo` as `<cwd>/.roo`).
- **Global** rules/skills/commands come from `~/.roo/**` (`getGlobalRooDirectory()` =
  `os.homedir()/.roo`) and `~/.agents/**` (`getGlobalAgentsDirectory()`), with project `.roo`
  overriding global.
- **Global custom modes** are not read from a dotfile but from the extension's **global storage**
  `settings/custom_modes.yaml` (managed by `CustomModesManager`). Writing modes there requires the
  extension's storage path and is not stable to place declaratively, so the modules target the
  filesystem discovery paths instead.

**Module placement decision:** the home-manager / nixOS / darwin modules place the bundled pack into
the user's **global** discovery locations so every workspace sees the modes without per-project setup:

- Symlink/copy `nix/modes/roo/` → `~/.roo/` (merging `rules/`, `rules-<slug>/`, `commands/`,
  `skills/`). Global `.roo` is read by rules/skills/commands discovery.
- The 16 **custom mode definitions** (`roomodes.yaml`) cannot be injected via `~/.roo` (global custom
  modes live in extension global storage). The module therefore supports two placement strategies,
  pick per option:
  1. **Project seeding (default, reliable):** a `home.activation`/module option that drops
     `.roomodes` + `.roo/` into one or more user-chosen project roots (`menagerie.modes.projects =
     [ "~/dev/foo" ]`). This is exactly the discovery path `CustomModesManager` reads for project
     modes and needs no knowledge of VS Code internals.
  2. **Global storage write (optional, best-effort):** an activation script that writes
     `roomodes.yaml` into the editor's global-storage `settings/custom_modes.yaml`
     (`~/.config/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/custom_modes.yaml`
     on Linux; `~/Library/Application Support/Code/User/globalStorage/...` on darwin). Gated behind an
     option because the storage path depends on the editor flavor (Code / Code - Insiders / Cursor /
     VSCodium) and the lowercased `publisher.name` id.

Provide module options: `menagerie.enable`, `menagerie.package` (the vsix pkg),
`menagerie.installExtension` (run `code --install-extension` the vsix on activation, or just place it
for manual install), `menagerie.modes.enable`, `menagerie.modes.global` (seed `~/.roo`),
`menagerie.modes.projects` (list of project roots to seed), `menagerie.modes.editor`
(`code`/`code-insiders`/`cursor`/`codium`, selects global-storage path + install command).

## (e) Flake output surface

```
packages.<system>.menagerie-vsix        # PRIMARY: the built zoo-code-<version>.vsix (derivation (c))
packages.<system>.default                = menagerie-vsix
packages.<system>.menagerie-modes        # derivation that exposes nix/modes/ (the AA&R v2 pack)
packages.<system>.menagerie-with-modes   # symlinkJoin of menagerie-vsix + menagerie-modes
                                         #   (vsix + a modes/ tree in one store path for consumers)
# packages.<system>.menagerie-cli        # DEFERRED — see note
homeManagerModules.default               # installs vsix + places modes (section d)
nixosModules.default                     # system-level: ensures pkg available; delegates per-user
                                         #   mode placement to home-manager where possible
darwinModules.default                    # nix-darwin equivalent of the nixOS module
```

Supported systems: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, `x86_64-darwin` (use
`flake-utils.eachSystem` or `forAllSystems`). The vsix is platform-independent JS, so the four
`menagerie-vsix` outputs are byte-identical except for the builder platform; still expose all four so
consumers on any host can `nix build`.

**`menagerie-cli` is DEFERRED** and intentionally not a default output:
- `apps/cli` (`@roo-code/cli`) builds with `tsup` and is the only consumer of `@vscode/ripgrep`,
  which pulls per-platform prebuilt binaries; it also wires `ROO_*` cloud base URLs. Shipping it
  cleanly needs ripgrep from nixpkgs + extra env, which is out of scope for the extension goal.
- Plan: add it later as `packages.<system>.menagerie-cli` building `pnpm --filter @roo-code/cli
  build`, supplying `pkgs.ripgrep` and setting the `@vscode/ripgrep` resolution to it, once the vsix
  flake is proven. Note this explicitly in the flake comments so it is a known follow-up, not a gap.

## Hazard resolutions (summary)

1. **pnpm offline:** `pnpm_10.fetchDeps` FOD + `pnpmConfigHook`, whole-workspace install,
   `--frozen-lockfile --offline`; hash pinned via `fakeHash` → read `got:` → pin. FOD lives in the
   flake, keyed on `pnpm-lock.yaml`.
2. **ripgrep/vsce downloads:** vsix path needs no ripgrep (external in bundle, resolved from host
   editor at runtime); still export `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. vsce runs `--no-dependencies`,
   `repository`+`LICENSE`+`README` already present, telemetry disabled — no network.
3. **vsce invocation:** use the repo's `vsce package --no-dependencies` via `pnpm vsix` (turbo graph),
   with the explicit per-filter sequence as the documented fallback.
4. **turbo network/telemetry:** `TURBO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `--no-daemon`,
   `TURBO_RUN_SUMMARY=false`; HOME set to a writable tmp dir.

## Open assumptions (reasonable defaults chosen, flagged for the implementer)

- The AA&R v2 pack is treated as the canonical modes set and must be **vendored into the repo**
  (e.g. `nix/modes/`) because it currently lives outside the worktree; a flake cannot reference a
  sibling directory. If the maintainer prefers the in-repo 7-mode `.roomodes`/`.roo` as canonical,
  swap the `menagerie-modes` src accordingly (one-line change) — do not ship both globally due to
  slug collisions.
- Exact `nodejs_22` patch and `pnpm_10` version in the pinned nixpkgs must be checked against
  22.23.1 / 10.8.1 and overridden if they differ.
- Global-storage extension-id path uses `zoocodeorganization.zoo-code`; verify casing against the
  installed vsix id if using the optional global-storage mode-write strategy.
```

## Implementation notes (appended after the first build pass)

The flake was implemented and built successfully. Key decisions and deviations from the pure design
pass, recorded for the reviewer:

### Toolchain / nixpkgs facts (resolved the "verify versions" open assumption)

- Pinned nixpkgs: `nixos-unstable` (locked `c59305b…`, 2026-10-01).
- `nodejs_22` resolves to **22.23.3** (repo pins 22.23.1) and `pnpm_10` to **10.34.5** (repo pins
  10.8.1). The node patch delta only produces a non-fatal `Unsupported engine` warning; the pnpm
  delta is harmless because the lockfile is `lockfileVersion: 9.0`, which every pnpm 10.x reads under
  `--frozen-lockfile`. No override of the nixpkgs toolchain was needed.
- `pnpm.fetchDeps` / `pnpm.configHook` are deprecated in current nixpkgs; the flake uses the
  top-level `pkgs.fetchPnpmDeps` + `pkgs.pnpmConfigHook` instead. **`fetcherVersion = 2` was removed
  in the 26.11 release**, so the FOD uses `fetcherVersion = 4`.

### pnpmDeps hash (two-pass method, now pinned)

`hash = "sha256-KvdnQIYa9K7gJx+/6yjLa3ocSGCOUrX6vTu2D8FBbfo="` (fetcherVersion 4). Refresh via the
fakeHash → read `got:` → pin loop whenever `pnpm-lock.yaml` changes.

### Required packaging-only source patch (`postPatch`)

pnpm 10 honors the root `packageManager: pnpm@10.8.1` field by trying to **self-provision that exact
pnpm from the network** on every invocation (root + each turbo per-workspace child), which fails
offline with `ERR_PNPM_NO_OFFLINE_META` / `ERR_PNPM_META_FETCH_FAIL`. Disabling it via
`manage-package-manager-versions=false` (env var and/or global rc) did **not** reliably take across
turbo's child processes on darwin (pnpm's global rc path is `~/Library/Preferences/pnpm/rc`, not the
XDG path). The field also **cannot simply be deleted**: turbo requires `packageManager` for workspace
resolution (`Could not resolve workspaces. Missing packageManager field`).

Resolution: a `postPatch` step rewrites the root `package.json` `packageManager` field to
`pnpm@<nixpkgs pnpm version>` (currently `pnpm@10.34.5`). pnpm then sees its own running version and
skips self-provisioning entirely. This is a build-time packaging edit of a metadata field only — **no
app logic is touched** — and is applied in the Nix derivation (the repo source is unchanged).

### Build invocation

`pnpm vsix` (the repo's turbo task) runs end to end: `@roo-code/types#build` → other `^build` deps →
`@roo-code/vscode-webview#build` (vite) → `zoo-code#bundle` (esbuild + asset copy) → `zoo-code#vsix`
(`vsce package --no-dependencies`). Note: do **not** append `-- --no-daemon`; turbo forwards args
after `--` to the underlying task (vsce), which rejects unknown flags. Telemetry/daemon are disabled
via env.

### Modes bundling (both sets shipped, no slug collision)

Per the task's explicit "MODES TO BUNDLE" list, **both** mode sources are vendored into `nix/modes/`
and shipped in `menagerie-modes`, in separate subdirectories so slugs never collide:

- `nix/modes/aar/` — the AA&R v2 pack (canonical/default profile): `roomodes.yaml`, `roo/`,
  `tools/aar/` (`omniroute.py`, `polite_fetch.py`, `leads.py`). Vendored from the sibling
  `Menagerie-Modes-v2-AAR/` (outside the worktree) so the flake is self-contained.
- `nix/modes/repo/` — the in-repo 7-mode set (secondary profile): `roomodes.yaml`, `roo/` (rules,
  skills, commands, guidance, roomotes.yml), copied from the worktree root `.roo` + `.roomodes`.

The consumer modules select one profile via `programs.menagerie.modes.profile` (default `aar`) so
only one is seeded into discovery paths, avoiding the slug collisions flagged in the design.

### menagerie-cli: still DEFERRED

Confirmed out of scope for this first cut (see the DEFERRED section above). The vsix is not blocked on
it. Follow-up: add `packages.<system>.menagerie-cli` building `pnpm --filter @roo-code/cli build` with
`pkgs.ripgrep` wired in, once the vsix flake is proven (it now is).