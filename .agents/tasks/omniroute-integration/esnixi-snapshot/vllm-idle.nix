{ lib, pkgs, ... }:

let
  middleware = import ./gpu-runtime.nix { inherit pkgs; };
in
{
  systemd.services.arcane-gpu-lock = {
    description = "Shared RTX 5090 ownership file";
    before = [ "docker-vllm-5090.service" "docker-comfy-esnixi.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "arcane-gpu";
      RuntimeDirectoryMode = "0755";
      RuntimeDirectoryPreserve = "yes";
    };
    # Never replace the inode while either container might hold a lease.
    script = ''
      if [ ! -e /run/arcane-gpu/5090.lock ]; then
        ${pkgs.coreutils}/bin/install -m 0600 -o 1000 -g 1000 /dev/null /run/arcane-gpu/5090.lock
      fi
    '';
  };
  systemd.services.docker-vllm-5090 = {
    after = [ "arcane-gpu-lock.service" ];
    requires = [ "arcane-gpu-lock.service" ];
  };
  virtualisation.oci-containers.containers.vllm-5090 = {
    entrypoint = "python3";
    volumes = [
      "${middleware}:/opt/vllm-idle:ro"
      "/run/arcane-gpu:/run/arcane-gpu"
    ];
    environment = {
    };
    cmd = [ "vllm" "serve" ];
  };
}
