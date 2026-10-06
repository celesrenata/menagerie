# Per-system package set for the Menagerie flake.
#
# Produces:
#   menagerie-vsix       - the built zoo-code-<version>.vsix (PRIMARY deliverable)
#   menagerie-modes      - the bundled custom modes (AA&R v2 pack + in-repo profile)
#   menagerie-with-modes - symlinkJoin of the vsix + the modes tree
#
# menagerie-cli is DEFERRED (see nix-build-design.md). apps/cli builds with tsup
# and is the only consumer of @vscode/ripgrep's per-platform prebuilt binaries;
# shipping it cleanly needs ripgrep wired in from nixpkgs plus extra env, which is
# out of scope for the extension goal. It is intentionally not an output here.
{ pkgs, self }:

let
  inherit (pkgs) lib stdenv;

  # The extension manifest pins exact versions; keep them in one place.
  version = "3.84.4";

  # ---------------------------------------------------------------------------
  # Toolchain pins.
  #
  # The repo pins node 22.23.1 (.nvmrc / .tool-versions / engines) and
  # pnpm 10.8.1 (packageManager). nixpkgs-unstable currently ships compatible
  # patch releases (node 22.23.x, pnpm 10.x). The lockfile is version 9.0, which
  # every pnpm 10.x reads, so --frozen-lockfile is satisfiable with the nixpkgs
  # pnpm. nixpkgs' pnpm is not corepack-managed, so the packageManager field is
  # advisory and does not block execution.
  # ---------------------------------------------------------------------------
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_10;

  # The whole workspace is the fetchDeps / build source.
  src = ../.;

  # Environment that keeps every install/build phase hermetic and silences
  # opportunistic binary downloads and telemetry. The vsix path needs none of
  # these binaries, but they are set defensively (belt-and-suspenders).
  hermeticEnv = {
    CI = "1";
    HUSKY = "0";
    TURBO_TELEMETRY_DISABLED = "1";
    TURBO_RUN_SUMMARY = "false";
    DO_NOT_TRACK = "1";
    VSCE_TELEMETRY = "0";
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    PUPPETEER_SKIP_DOWNLOAD = "1";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    CYPRESS_INSTALL_BINARY = "0";
    npm_config_offline = "true";
    # pnpm maps npm_config_<key> env vars to its config. Disable the
    # self-provisioning of the packageManager-pinned pnpm so the build stays
    # offline and uses the nixpkgs pnpm on PATH.
    npm_config_manage_package_manager_versions = "false";
    npm_config_update_notifier = "false";
  };

  # ---------------------------------------------------------------------------
  # pnpm offline dependencies: fixed-output derivation keyed on pnpm-lock.yaml.
  #
  # Two-pass hash: start with lib.fakeHash, run `nix build`, read the real
  # `got:` hash from the error, pin it below. Refresh whenever the lockfile
  # changes.
  # ---------------------------------------------------------------------------
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "menagerie";
    inherit version src pnpm;
    # fetcherVersion 2 was removed in the 26.11 nixpkgs release; use 4.
    fetcherVersion = 4;
    hash = "sha256-rtzbckiEopDddl/AIXrpPOvGKvTd9iHfAunU0Twl8DA=";
  };

  # ---------------------------------------------------------------------------
  # menagerie-vsix: build the extension from source into a .vsix.
  # ---------------------------------------------------------------------------
  menagerie-vsix = stdenv.mkDerivation (hermeticEnv // {
    pname = "menagerie-vsix";
    inherit version src;

    nativeBuildInputs = [
      nodejs
      pnpm
      pkgs.pnpmConfigHook
    ];

    inherit pnpmDeps;

    # Packaging-only patch (not an app-logic change): pin the root
    # `packageManager` field to the nixpkgs pnpm version so pnpm sees its own
    # running version and does NOT self-provision the originally-pinned
    # pnpm@10.8.1 from the network during the build. turbo also *requires* this
    # field for workspace resolution, so it cannot simply be removed. Every
    # pnpm invocation (including turbo's per-workspace children) otherwise
    # re-triggers ERR_PNPM_NO_OFFLINE_META / ERR_PNPM_META_FETCH_FAIL offline.
    # The nixpkgs pnpm reads the version-9.0 lockfile fine. Documented in
    # .agents/tasks/menagerie-flake/nix-build-design.md.
    postPatch = ''
      ${nodejs}/bin/node -e '
        const fs = require("fs");
        const p = "package.json";
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        j.packageManager = "pnpm@${pnpm.version}";
        fs.writeFileSync(p, JSON.stringify(j, null, "\t") + "\n");
      '
    '';

    # Drive the repo's own turbo pipeline through pnpm so the dependency graph
    # (types -> other packages -> webview build -> src bundle -> src vsix) runs
    # exactly as upstream intends. turbo telemetry/daemon are disabled via the
    # hermeticEnv (TURBO_TELEMETRY_DISABLED, TURBO_RUN_SUMMARY) and the sandbox
    # has no persistent daemon.
    buildPhase = ''
      runHook preBuild

      export HOME=$TMPDIR

      # Belt-and-suspenders: also point pnpm's global config dir at a writable
      # path and drop an rc disabling the packageManager self-provisioning, so
      # the build never tries to fetch pnpm@10.8.1 from the network offline.
      # (The npm_config_* env vars above are the primary mechanism; this rc is a
      # fallback for pnpm versions that read the global rc first.)
      export XDG_CONFIG_HOME="$HOME/.config"
      mkdir -p "$XDG_CONFIG_HOME/pnpm"
      printf '%s\n' 'manage-package-manager-versions=false' 'update-notifier=false' > "$XDG_CONFIG_HOME/pnpm/rc"

      # Note: do not pass `-- --no-daemon`; turbo forwards extra args after
      # `--` to the underlying task (vsce), which rejects them. turbo runs
      # without a daemon in the sandbox anyway (no persistent daemon process).
      pnpm vsix

      runHook postBuild
    '';

    # The repo's `vsix` script writes bin/zoo-code-<version>.vsix at the root.
    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp bin/zoo-code-*.vsix $out/

      runHook postInstall
    '';

    dontConfigure = false;

    meta = with lib; {
      description = "Menagerie (Zoo Code) VS Code extension packaged as a .vsix, built from source.";
      homepage = "https://zoocode.dev";
      license = licenses.asl20;
      platforms = platforms.unix;
    };
  });

  # ---------------------------------------------------------------------------
  # menagerie-modes: the bundled custom modes.
  #
  # Canonical layout (see nix-build-design.md):
  #   $out/aar/   - the AA&R v2 pack (default profile): roomodes.yaml, roo/, tools/aar/
  #   $out/repo/  - the in-repo 7-mode set (secondary profile): roomodes.yaml, roo/
  # Both are shipped but live in separate subdirectories; the consumer modules
  # select one profile to seed into discovery paths so slugs never collide.
  # ---------------------------------------------------------------------------
  menagerie-modes = stdenv.mkDerivation {
    pname = "menagerie-modes";
    inherit version;
    src = ./modes;
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r ./. $out/
      runHook postInstall
    '';
    meta = with lib; {
      description = "Menagerie custom modes (AA&R v2 pack + in-repo profile).";
      platforms = platforms.all;
    };
  };

  # ---------------------------------------------------------------------------
  # menagerie-with-modes: vsix + modes tree in one store path for consumers.
  # ---------------------------------------------------------------------------
  menagerie-with-modes = pkgs.symlinkJoin {
    name = "menagerie-with-modes-${version}";
    paths = [ menagerie-vsix ];
    postBuild = ''
      mkdir -p $out/modes
      cp -r ${menagerie-modes}/. $out/modes/
    '';
  };
in
{
  inherit menagerie-vsix menagerie-modes menagerie-with-modes;
}
