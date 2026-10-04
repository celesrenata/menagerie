# vllm-switcher-hysteresis: setup

Host: celes@192.168.42.254 (esnixi). Repo: /home/celes/sources/celesrenata/nix-flakes-refactored
Branch: feat/nvfp4-reader-fabric
HEAD: 1d1059e2b0c9347fe877396ec2ffc871077a52db
Running switcher: /nix/store/hs406331cwxhilbf0fsh9ys60z566d53-vllm-switch.py (exists)

## Dirty tree (DO NOT touch/commit/stash/revert)

M: docs/omniroute-editors.md, esnixi/comfy-worker.nix, esnixi/comfy_gpu_admission.py, esnixi/graphics.nix,
esnixi/lan-mouse.nix, esnixi/remote-desktop.nix, esnixi/vllm-proxy.nix, flake.lock, flake.nix,
home/programs/mcp.nix, home/programs/omniroute-editors.nix, home/system/hyte-touch.nix,
overlays/default.nix, overlays/freerdp.nix, secrets.nix, secrets/secrets.yaml
A (staged!): docs/omniroute-routing.md, esnixi/backup.nix, esnixi/omniroute-wireguard.nix,
home/programs/{omniroute-parallel.md, omniroute-workers.py, zoo-chats.py, zoo-force-parallel.md, zoo-parallel.nix,
zoo-project-reader-mode.json, zoo-project-research-mode.json, zoo-spec-mode.json}, tests/test_omniroute_workers.py
??: .clinerules/, .specify/, distcc-monitor.sh, esnixi/**pycache**/, home/programs/**pycache**/,
home/programs/_.Modelfile (m5-reader, ornith-code, qwen38-4070), home/programs/_.before-\* backups, tests/**pycache**/

WARNING: index already has staged files (A). Commit switcher work with
`git commit -m ... -- esnixi/vllm-switch.py esnixi/test_vllm_switch.py [esnixi/vllm.nix]`
(path-limited commit) so staged unrelated files are NOT included. flake.nix is dirty: never stage it.
Switcher files (vllm-switch.py, test_vllm_switch.py, vllm.nix, vllm-idle.nix, vllm_idle.py) are all clean.

## File state

- esnixi/vllm-switch.py (523 lines): HTTP proxy to backend 127.0.0.1:8010, token auth. Constants: LOCK_WAIT_SECONDS=3,
  MODEL_READY_SECONDS=540, READER_IDLE_SECONDS=300, DRAIN_SETTLE_SECONDS=2, READER_UNITS={vllm-reader.service}.
  MODELS: qwen3.8-27b-nvfp4 + balanced alias -> vllm.service (ctx 131072, max_requests 1);
  qwen3.5-9b-nvfp4-reader -> vllm-reader.service (ctx 65536, max_requests 8, coupled to unit --max-model-len).
  Handler methods: acquire_model, release_model, arm_reader_idle_stop (timer \_maybe_stop), other_units, unit_state,
  stop_and_drain, select_model (stop others -> drain -> reset-failed -> start -> readiness poll), proxy.
  Switching is immediate on each request for a different model: no hysteresis/min-residency (source of churn).
- esnixi/test_vllm_switch.py (262 lines): unittest, 6 tests, cases (a)-(f): exclusivity, start ordering,
  idle stop, idle cancel on request, 409 on lock timeout, reader context coupling. Loads script via importlib, mocks systemctl.
- esnixi/vllm.nix (327 lines): mkVllmService; units vllm, vllm-reader, vllm-5090-fallback (all port 8010),
  vllm-switcher (python3 switcherScript), vllm-reader-idle oneshot + timer (OnActiveSec/OnUnitActiveSec=60,
  partOf/wantedBy reader): stops reader after 300s idle via /metrics running+waiting==0.
- esnixi/vllm-idle.nix: arcane-gpu-lock service. esnixi/vllm_idle.py (150 lines): async IdleController(engine,
  idle_seconds, lease) for in-process idle sleep.

## Tests

pytest not installed. Working command (from repo root):
`python3 esnixi/test_vllm_switch.py` -> baseline: Ran 6 tests, OK.

## Build

flake.nix: `hosts.esnixi` mapped into nixosConfigurations via mkHost -> attr `esnixi`.
`nixos-rebuild build --flake .#esnixi`
