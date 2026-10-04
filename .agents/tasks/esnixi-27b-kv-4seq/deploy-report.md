# Deploy: esnixi coder KV 5.5 GiB / switcher stops reader for coder

- Commit deployed: `7b0531d` (esnixi `main`; production change in `e789922`, `7b0531d` adds test p3)
- System generation: **438** (2026-10-03 06:32:34), current = True
- Toplevel: `/nix/store/14avxdr4vhk9mb7jmb0230vhcpimfxc5-nixos-system-esnixi-26.11.20260922.6774f7b` (matches the pre-switch build)

## Pre-switch closure check

New store paths vs. generation 437 were only `unit-vllm.service`, `unit-vllm-switcher.service`, `vllm-switch.py`, and their wrappers (`system-units`, `etc`, toplevel). `nix store diff-closures` reported no version changes.

## Units after switch

- `vllm.service`: active since 06:51:21. ExecStart carries `--kv-cache-memory=5905580032 --gpu-memory-utilization 0.92`. The running process has the same `--kv-cache-memory=5905580032`.
- `vllm-switcher.service`: active since 06:51:21. ExecStart runs the new `/nix/store/29w5hmvv…-vllm-switch.py`, and a live process is running from that path.
- GPU: 30,527 / 32,607 MiB used with the coder resident (about 2 GiB free).

## Note: vllm-reader is `failed (Result: timeout)`

The reader relaunched around the switch. At 06:52:21 systemd began stopping it, consistent with the new stop-for-coder path. It ignored SIGTERM for the 2-minute stop timeout and was SIGKILLed at 06:54:21. The unit is now `failed`, not `inactive`. The GPU memory was freed. This is the hung-reader-stop scenario that test p3 covers.

Not done yet: check whether the switcher counted this as a coder breaker failure, and clear it with `sudo systemctl reset-failed vllm-reader` if so. The 4 × 55K live verification (expected Running=3/Waiting=1 unless the shared Zoo prefix is ≥ ~34K) also still needs to run.
