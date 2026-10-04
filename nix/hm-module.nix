# home-manager module for Menagerie.
#
# Installs the built extension (.vsix) and places the bundled custom modes into
# the user's discovery locations:
#   - global rules/skills/commands  -> ~/.roo/   (read by every workspace)
#   - custom mode definitions       -> seeded into chosen project roots as
#                                      <project>/.roomodes + <project>/.roo/
#     (project modes are the stable, documented discovery path; global custom
#      modes live in the editor's global storage, which is not declaratively
#      stable, so project seeding is the default placement.)
{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.menagerie;
  system = pkgs.stdenv.hostPlatform.system;
  pkgSet = self.packages.${system};

  modesPkg = cfg.modes.package;
  # Selected modes profile subtree inside the modes package.
  profileDir = "${modesPkg}/${cfg.modes.profile}";

  # Editor global-storage base dirs per flavor (used by the optional
  # global-storage write strategy). Paths differ Linux vs darwin.
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  editorUserDir =
    let
      base =
        if isDarwin
        then "${config.home.homeDirectory}/Library/Application Support"
        else "${config.home.homeDirectory}/.config";
      flavorDir = {
        code = "Code";
        code-insiders = "Code - Insiders";
        cursor = "Cursor";
        codium = "VSCodium";
      }.${cfg.modes.editor};
    in
    "${base}/${flavorDir}/User";

  installCmd = {
    code = "code";
    code-insiders = "code-insiders";
    cursor = "cursor";
    codium = "codium";
  }.${cfg.modes.editor};
in
{
  options.programs.menagerie = {
    enable = lib.mkEnableOption "Menagerie (Zoo Code) VS Code extension and custom modes";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgSet.menagerie-vsix;
      defaultText = lib.literalExpression "menagerie flake's menagerie-vsix";
      description = "The Menagerie vsix package to install.";
    };

    installExtension = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        If true, run `<editor> --install-extension <vsix>` on activation.
        If false, the vsix is only placed in the Nix store (install manually).
      '';
    };

    modes = {
      enable = lib.mkEnableOption "placement of the bundled custom modes" // { default = true; };

      package = lib.mkOption {
        type = lib.types.package;
        default = pkgSet.menagerie-modes;
        defaultText = lib.literalExpression "menagerie flake's menagerie-modes";
        description = "The modes package to source placement from.";
      };

      profile = lib.mkOption {
        type = lib.types.enum [ "aar" "repo" ];
        default = "aar";
        description = ''
          Which bundled modes profile to seed. "aar" is the AA&R v2 pack
          (16 modes, canonical); "repo" is the in-repo 7-mode set. Only one is
          seeded to avoid slug collisions.
        '';
      };

      global = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Seed the profile's roo/ tree into ~/.roo (global rules/skills/commands).";
      };

      projects = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = lib.literalExpression ''[ "~/dev/foo" ]'';
        description = ''
          Project roots to seed with <project>/.roomodes + <project>/.roo so the
          custom mode definitions are discovered as project modes.
        '';
      };

      editor = lib.mkOption {
        type = lib.types.enum [ "code" "code-insiders" "cursor" "codium" ];
        default = "code";
        description = "Editor flavor, selects the install command and global-storage path.";
      };

      globalStorage = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Optional, best-effort: also write the profile's custom mode definitions
          into the editor's global-storage settings/custom_modes.yaml. Gated off
          by default because the storage path depends on the editor flavor and
          the lowercased publisher.name id.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    home.activation.menagerie = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      vsix="$(${pkgs.coreutils}/bin/ls ${cfg.package}/*.vsix 2>/dev/null | ${pkgs.coreutils}/bin/head -n1 || true)"

      ${lib.optionalString cfg.installExtension ''
        if [ -n "$vsix" ] && command -v ${installCmd} >/dev/null 2>&1; then
          ${installCmd} --install-extension "$vsix" || true
        fi
      ''}

      ${lib.optionalString (cfg.modes.enable && cfg.modes.global) ''
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "${config.home.homeDirectory}/.roo"
        $DRY_RUN_CMD ${pkgs.rsync}/bin/rsync -a --chmod=u+w "${profileDir}/roo/" "${config.home.homeDirectory}/.roo/"
      ''}

      ${lib.concatMapStringsSep "\n" (proj:
        let
          # Expand a leading ~ to the home directory.
          projPath =
            if lib.hasPrefix "~/" proj
            then "${config.home.homeDirectory}/${lib.removePrefix "~/" proj}"
            else proj;
        in
        lib.optionalString (cfg.modes.enable) ''
          $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "${projPath}/.roo"
          $DRY_RUN_CMD ${pkgs.rsync}/bin/rsync -a --chmod=u+w "${profileDir}/roo/" "${projPath}/.roo/"
          $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m u+w "${profileDir}/roomodes.yaml" "${projPath}/.roomodes"
        '') cfg.modes.projects}

      ${lib.optionalString (cfg.modes.enable && cfg.modes.globalStorage) ''
        storageDir="${editorUserDir}/globalStorage/zoocodeorganization.zoo-code/settings"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "$storageDir"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m u+w "${profileDir}/roomodes.yaml" "$storageDir/custom_modes.yaml"
      ''}
    '';
  };
}
