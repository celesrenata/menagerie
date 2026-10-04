{
  description = "Menagerie (Zoo Code) VS Code extension built from source, with bundled custom modes and home-manager / nixOS / nix-darwin modules.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    let
      # Platform-neutral module definitions. These are imported from the
      # per-system packages so the modes/vsix placement logic is shared.
      mkPackages = import ./nix/packages.nix;
    in
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ]
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          packages = mkPackages { inherit pkgs self; };
        in
        {
          packages = packages // {
            default = packages.menagerie-vsix;
          };
        })
    // {
      # Platform-neutral consumer modules. Each takes the vsix/modes packages
      # from the appropriate system's package set at evaluation time.
      homeManagerModules.default = import ./nix/hm-module.nix { inherit self; };
      nixosModules.default = import ./nix/nixos-module.nix { inherit self; };
      darwinModules.default = import ./nix/darwin-module.nix { inherit self; };
    };
}
