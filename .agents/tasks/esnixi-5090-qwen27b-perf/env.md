# esnixi (celes@192.168.42.254) environment baseline

Captured 2026-10-03 01:49 (host time). No config changed.

## Repo

- Path: /home/celes/sources/celesrenata/nix-flakes-refactored
- Branch: feat/nvfp4-reader-fabric (confirmed)
- HEAD: 2b1c1f7 fix(esnixi): add minimum-residency hysteresis to vllm switcher
- Unrelated uncommitted working-tree changes left untouched.

## vLLM

- `vllm` CLI is not on the login PATH (`command not found`).
- Running vllm.service ("vLLM OpenAI-compatible API server (qwen3.8-27b-nvfp4)") uses python3.14-vllm-0.31.0rc3 (from unit Environment), launched via python3-3.14.7 + gpu_launch.py.
- Also running: vllm-switcher.service, omniroute-vllm-proxy.service.

## GPU (nvidia-smi)

- Driver/KMD 615.71.09, CUDA UMD 13.4
- GPU 0: NVIDIA GeForce RTX 5090, bus 0C:00.0, display attached
- Memory: 27721 / 32607 MiB used; util 96%; P1; 182 W / 575 W; 52 C; fan 30%
- Processes: VLLM::EngineCore 26900 MiB; Hyprland 305, quickshell 64+200, Xwayland 8 MiB

## RAM (free -g)

- Mem: total 125, used 23, free 14, buff/cache 89, available 102 GiB (128 GB nominal)
- Swap: 63 total, 2 used, 61 free
