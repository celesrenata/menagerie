# home-manager module for Menagerie.
#
# Installs the built extension and places the bundled custom modes into
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
  # Global-storage folder name: VS Code lowercases "<publisher>.<name>".
  extensionUniqueId = cfg.extensionPackage.vscodeExtUniqueId or "celesrenata.menagerie";
  extensionPublisher = cfg.extensionPackage.vscodeExtPublisher or "celesrenata";
  # Install folder / global-storage name: VS Code lowercases "<publisher>.<name>".
  extensionStorageId = lib.toLower extensionUniqueId;

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

  editorAppName = {
    code = "Visual Studio Code";
    code-insiders = "Visual Studio Code - Insiders";
    cursor = "Cursor";
    codium = "VSCodium";
  }.${cfg.modes.editor};
  installCmd = {
    code = "code";
    code-insiders = "code-insiders";
    cursor = "cursor";
    codium = "codium";
  }.${cfg.modes.editor};
in
{
  options.programs.menagerie = {
    enable = lib.mkEnableOption "Menagerie VS Code extension and custom modes";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgSet.menagerie-vsix;
      defaultText = lib.literalExpression "menagerie flake's menagerie-vsix";
      description = "The Menagerie vsix package to install.";
    };

    extensionPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgSet.menagerie-vscode-extension;
      defaultText = lib.literalExpression "menagerie flake's menagerie-vscode-extension";
      description = "The Menagerie extension in nixpkgs VS Code extension form.";
    };
    vscode = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Install the extension into the editor's extensions directory on every
          switch. It is copied in as a real directory (VS Code 1.140+ marks
          symlinked extension directories obsolete, so programs.vscode-style links
          do not load) and recopied whenever the build's store path changes, even
          when the version number does not.
        '';
      };
      extensionsDir = lib.mkOption {
        type = lib.types.str;
        default = "${config.home.homeDirectory}/${{
          code = ".vscode";
          code-insiders = ".vscode-insiders";
          cursor = ".cursor";
          codium = ".vscode-oss";
        }.${cfg.modes.editor}}/extensions";
        defaultText = lib.literalExpression ''"~/.vscode/extensions" (per modes.editor)'';
        description = "Extensions directory to install into.";
      };
      removeLegacyZooCode = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Remove installed Zoo Code (ZooCodeOrganization.zoo-code) extension
          directories and their extensions.json entries. Menagerie imports Zoo
          Code's history and settings on first start, but only once Zoo Code is
          gone. Only extension code is removed; Zoo's data is left for the import.
        '';
      };
    };
    installExtension = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        For editors not managed by programs.vscode (Cursor, VSCodium, a VS Code
        installed outside Nix): run `<editor> --install-extension <vsix> --force`
        on activation. Leave off when vscode.enable is on.
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

  config = lib.mkIf cfg.enable (lib.mkMerge [
  (lib.mkIf cfg.vscode.enable {
    home.activation.menagerieExtensionInstall = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      src="${cfg.extensionPackage}/share/vscode/extensions/${extensionUniqueId}"
      extdir="${cfg.vscode.extensionsDir}"
      version="${cfg.extensionPackage.version}"
      dest="$extdir/${extensionStorageId}-$version"
      stamp="$dest/.menagerie-nix-source"
      $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "$extdir"
      # A symlink left by a programs.vscode-managed install is marked obsolete by VS Code.
      if [[ -L "$extdir/${extensionUniqueId}" ]]; then
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/rm -f "$extdir/${extensionUniqueId}"
      fi
      # Compare the build, not the version: rebuilds usually keep the same version.
      if [[ ! -f "$stamp" || "$(${pkgs.coreutils}/bin/cat "$stamp" 2>/dev/null)" != "${cfg.extensionPackage}" ]]; then
        for old in "$extdir"/${extensionStorageId}-*; do
          [[ -e "$old" ]] && $DRY_RUN_CMD ${pkgs.coreutils}/bin/rm -rf "$old"
        done
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/cp -RL "$src" "$dest"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/chmod -R u+w "$dest"
        if [[ -z "''${DRY_RUN_CMD:-}" ]]; then
          printf '%s\n' "${cfg.extensionPackage}" > "$stamp"
        fi
        echo "programs.menagerie: installed ${extensionUniqueId} $version; reload VS Code windows to load it."
      fi
      ${lib.optionalString cfg.vscode.removeLegacyZooCode ''
        for legacy in "$extdir"/zoocodeorganization.zoo-code-* "$extdir/ZooCodeOrganization.zoo-code"; do
          [[ -e "$legacy" || -L "$legacy" ]] && $DRY_RUN_CMD ${pkgs.coreutils}/bin/rm -rf "$legacy"
        done
      ''}
      # Register in the mutable extensions.json, replacing any earlier entry.
      if ${pkgs.jq}/bin/jq -n \
        --arg dest "$dest" --arg version "$version" \
        --arg id "${extensionUniqueId}" --arg idLower "${extensionStorageId}" \
        --argjson dropLegacy ${lib.boolToString cfg.vscode.removeLegacyZooCode} \
        --arg publisher "${extensionPublisher}" \
        --slurpfile existing <(${pkgs.coreutils}/bin/cat "$extdir/extensions.json" 2>/dev/null || echo '[]') '
          ($existing[0] // [])
          | map(select(
              (.identifier.id // "" | ascii_downcase) as $entry
              | $entry != $idLower and (($dropLegacy | not) or $entry != "zoocodeorganization.zoo-code")
            ))
          + [{
              identifier: { id: $id },
              version: $version,
              location: { "$mid": 1, path: $dest, scheme: "file" },
              relativeLocation: ($dest | split("/") | last),
              metadata: { installedTimestamp: 0, targetPlatform: "undefined", isPreReleaseVersion: false, source: "vsix", publisherDisplayName: $publisher }
            }]
        ' > "$extdir/extensions.json.menagerie-new" 2>/dev/null; then
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mv "$extdir/extensions.json.menagerie-new" "$extdir/extensions.json"
      else
        ${pkgs.coreutils}/bin/rm -f "$extdir/extensions.json.menagerie-new"
        echo "programs.menagerie: could not update extensions.json; VS Code will rescan the directory." >&2
      fi
      # Clear a stale obsolete marker for this extension.
      if [[ -f "$extdir/.obsolete" ]]; then
        ${pkgs.jq}/bin/jq --arg idLower "${extensionStorageId}" \
          'with_entries(select(.key | ascii_downcase | startswith($idLower) | not))' \
          "$extdir/.obsolete" > "$extdir/.obsolete.menagerie-new" 2>/dev/null \
          && $DRY_RUN_CMD ${pkgs.coreutils}/bin/mv "$extdir/.obsolete.menagerie-new" "$extdir/.obsolete" \
          || ${pkgs.coreutils}/bin/rm -f "$extdir/.obsolete.menagerie-new"
      fi
    '';
  })
  {
    warnings = lib.optional (cfg.vscode.enable && cfg.installExtension)
      "programs.menagerie: vscode.enable and installExtension are both on; the extension is installed twice. Turn one off.";
    home.packages = [ cfg.package ];

    home.activation.menagerie = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      vsix="$(${pkgs.coreutils}/bin/ls ${cfg.package}/*.vsix 2>/dev/null | ${pkgs.coreutils}/bin/head -n1 || true)"

      ${lib.optionalString cfg.installExtension ''
        # Activation runs with a minimal PATH, so also look in the usual app locations.
        editor="$(command -v ${installCmd} 2>/dev/null || true)"
        for candidate in \
          "/Applications/${editorAppName}.app/Contents/Resources/app/bin/${installCmd}" \
          "${config.home.homeDirectory}/Applications/${editorAppName}.app/Contents/Resources/app/bin/${installCmd}" \
          "${config.home.homeDirectory}/.nix-profile/bin/${installCmd}" \
          "/etc/profiles/per-user/${config.home.username}/bin/${installCmd}" \
          /run/current-system/sw/bin/${installCmd}; do
          [ -z "$editor" ] && [ -x "$candidate" ] && editor="$candidate"
        done
        if [ -z "$vsix" ]; then
          echo "programs.menagerie: no .vsix found in ${cfg.package}" >&2
        elif [ -z "$editor" ]; then
          echo "programs.menagerie: '${installCmd}' not found; install $vsix manually" >&2
        else
          # --force: rebuilt vsixes often keep the same version, which the CLI would skip.
          $DRY_RUN_CMD "$editor" --install-extension "$vsix" --force \
            || echo "programs.menagerie: '${installCmd} --install-extension' failed" >&2
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
          $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m 0644 "${profileDir}/roomodes.yaml" "${projPath}/.roomodes"
        '') cfg.modes.projects}

      ${lib.optionalString (cfg.modes.enable && cfg.modes.globalStorage) ''
        storageDir="${editorUserDir}/globalStorage/${extensionStorageId}/settings"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "$storageDir"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m 0600 "${profileDir}/roomodes.yaml" "$storageDir/custom_modes.yaml"
      ''}
    '';
  }
  ]);
}
