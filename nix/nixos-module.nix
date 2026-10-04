# nixOS module for Menagerie.
#
# System-level: makes the vsix and modes packages available in the system
# profile so any user can install the extension and reach the bundled modes.
# Per-user mode placement into ~/.roo and project roots is best handled by the
# home-manager module (programs.menagerie); this module intentionally does not
# write into user home directories.
{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.menagerie;
  system = pkgs.stdenv.hostPlatform.system;
  pkgSet = self.packages.${system};
in
{
  options.services.menagerie = {
    enable = lib.mkEnableOption "Menagerie (Zoo Code) packages in the system profile";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgSet.menagerie-vsix;
      defaultText = lib.literalExpression "menagerie flake's menagerie-vsix";
      description = "The Menagerie vsix package to add to the system profile.";
    };

    modesPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgSet.menagerie-modes;
      defaultText = lib.literalExpression "menagerie flake's menagerie-modes";
      description = "The bundled modes package to add to the system profile.";
    };

    installModes = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Add the modes package to the system profile alongside the vsix.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      [ cfg.package ] ++ lib.optional cfg.installModes cfg.modesPackage;
  };
}
