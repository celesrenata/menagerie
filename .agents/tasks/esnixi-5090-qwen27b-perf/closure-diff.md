# esnixi closure diff (pre-deploy)

Host: celes@192.168.42.254, repo nix-flakes-refactored, branch feat/nvfp4-reader-fabric
HEAD: 3601dd8 perf(esnixi): 5090 coder 4 seqs, 6 GiB KV, 5760-token prefill chunks, 32 GiB CPU KV offload

## Outcome: user deployed the dirty-tree build (Build 1)

Live /run/current-system = p602jvk0…-26.11.20260922.6774f7b. vllm.service and vllm-switcher.service are active. The live unit shows `--max-num-seqs 4`, `--max-num-batched-tokens 5760`, `--kv-cache-memory=6442450944` (6 GiB) and `--kv-offloading-size 32`.

## Original verdict: the build needed a user decision because both builds pulled in more than vllm/switcher.

## Build 1: dirty working tree (`.#esnixi`)

Out: /nix/store/p602jvk0xk2b1nxvhdcqv9q190zsbjsc-nixos-system-esnixi-26.11.20260922.6774f7b

```
arcane_worker_launch.py: ∅ → ε
comfy-esnixi-wait: ∅ → ε
comfy-esnixi-wait-gpu: ∅ → ε
unit-comfy-esnixi-gate.service: ∅ → ε
unit-comfy-esnixi-gate.socket: ∅ → ε
```

Changed units: comfy-esnixi-gate.service/.socket, docker-comfy-esnixi.service, vllm.service, vllm-switcher.service, vllm-reader.service.wants.

## Build 2: committed HEAD only (`git+file://$PWD?ref=feat/nvfp4-reader-fabric#esnixi`)

Out: /nix/store/3akha6a2kazw6n24hsllx3ag1fs4q31w-nixos-system-esnixi-26.11.20260913.ef34387 (`./result` now points here)

This build would REVERT/REMOVE a lot of what's live right now:

- vLLM removed entirely: `python3.14-vllm 0.31.0rc3 → ∅`, plus `unit-vllm.service`, `unit-vllm-reader.service`, `unit-vllm-switcher.service`, `unit-vllm-5090-fallback.service`, `unit-vllm-reader-idle.{service,timer}`, `vllm-switch.py` all `→ ∅`. Root cause: in HEAD, `esnixi/vllm-proxy.nix` doesn't import `./vllm.nix`. That import exists only in the uncommitted edit. So the committed vllm.nix perf changes do nothing without the WIP.
- nixpkgs rollback (uncommitted `flake.lock`): 26.11.20260922 → 26.11.20260913. Linux 7.2.7 → 7.2.5, nvidia driver 615.71.09 → 595.91.07, CUDA 13.3 → 13.2 (12.9 removed), k3s 1.36.4 → 1.35.8, mesa, hyprland, firefox, chromium, vscode, nfs-utils, etc. all downgraded.
- Removed services: wireguard-omniroute (+ peer, target, wireguard-tools), esnixi-backup.{service,timer}, comfy-esnixi-gate.{service,socket}, omniroute-ollama-proxy.service, omniroute-vllm-proxy.service, cups-post script, freerdp + xfreerdp security wrapper.
- Removed home-manager files: omniroute (mode, routing, workers, parallel, apply), zoo-\* configs/chats/spec-setup, speckit .roo commands, kiro-mcp.json, vscode-mcp.json, zoo-mcp_settings.json, dcgconfig.toml.
- Added back (stale from HEAD): drift-visualizer.service, omniroute-stabulous-tunnel.service, mpvpaper, nginx rtmp/moreheaders modules.
- About 280 unit files differ in total (libvirt, NetworkManager, nfs, docker, systemd drop-ins, mostly because of the nixpkgs/kernel rollback).
