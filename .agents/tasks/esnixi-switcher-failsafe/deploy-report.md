# esnixi switcher fail-safe: deploy report

## Source

- Host: esnixi (celes@192.168.42.254)
- Repo: /home/celes/sources/celesrenata/nix-flakes-refactored
- Branch: `main` (the brief named `feat/nvfp4-reader-fabric`, but no such branch exists locally or on origin; the reviewed change is committed on `main`)
- Commit: `9fc737590e498c06acda88fb7962429e63134f76` — fix(esnixi): fail-safe vLLM switcher (rollback, breaker, watchdog, deadlines)
- Working tree: clean except untracked `distcc-monitor.sh` (not part of the flake build)

## Build

`nixos-rebuild build --flake .#esnixi` from the working tree: succeeded.

- Current: `/nix/store/ldj6nj4zv6wgb98367hcbb940pawa7h7-nixos-system-esnixi-26.11.20260922.6774f7b`
- New: `/nix/store/4yhfh06h3alpx56sbfnkybkmp3k23j4j-nixos-system-esnixi-26.11.20260922.6774f7b`

Rebuilt derivations (7): `unit-vllm-reader.service`, `vllm-switch.py`, `unit-vllm-switcher.service`, `system-units`, `etc`, `activate`, `nixos-system-esnixi`. Same nixpkgs (26.11.20260922.6774f7b), vLLM untouched.

## Closure diff

```
$ nix store diff-closures /run/current-system ./result
vllm-switch.py: 13.4 KiB
```

Changed files under `etc/systemd/system`: only `vllm-reader.service` and `vllm-switcher.service` (plus its `multi-user.target.wants` link).

`vllm-reader.service`:

```
< Restart=on-failure
> Restart=no
```

`vllm-switcher.service`:

```
> Environment="VLLM_SWITCH_BACKOFF_MAX_SECONDS=1800"
> Environment="VLLM_SWITCH_BACKOFF_SECONDS=300"
> Environment="VLLM_SWITCH_CODER_RESIDENCY_SECONDS=90"
> Environment="VLLM_SWITCH_SLEEP_SECONDS=90"
> Environment="VLLM_SWITCH_START_SECONDS=300"
> Environment="VLLM_SWITCH_STOP_SECONDS=150"
> Environment="VLLM_SWITCH_WATCHDOG_SECONDS=60"
< ExecStart=... /nix/store/h6f1f86d3bzvn520w6zc4xwsf38j43ib-vllm-switch.py
> ExecStart=... /nix/store/qcxignqf9v7g4brl5g40xxwwk7yfyzrz-vllm-switch.py
```

Verdict: diff touches only the vLLM switcher / vLLM units. Cleared to deploy.

## Deploy

The user ran `sudo nixos-rebuild switch --flake .#esnixi` on esnixi.

Checked after the switch:

- `/run/current-system` points to `/nix/store/4yhfh06h3alpx56sbfnkybkmp3k23j4j-nixos-system-esnixi-26.11.20260922.6774f7b`, the build above.
- `vllm-switcher.service` is active (running) since 04:59:04 PDT with NRestarts=0. Its ExecStart runs the new script `qcxignqf9v7g4brl5g40xxwwk7yfyzrz-vllm-switch.py`, and all 7 new `VLLM_SWITCH_*` variables are in the unit.
- `vllm-reader.service` now shows `Restart=no`.
- `GET http://127.0.0.1:8011/healthz` returns `{"status":"ok"}` (HTTP 200).
- The new watchdog is running. The journal shows `05:00:04 INFO watchdog: adopted awake qwen3.8-27b-nvfp4`, 60 s after start, which matches `VLLM_SWITCH_WATCHDOG_SECONDS=60`.
- The coder (`vllm.service`, up since 04:18:26) kept the GPU through the switch without a restart and is still serving (spec-decode metrics logged at 04:58:56). It uses 29.3 GiB of the 5090.

Something I noticed but did not change: `vllm-reader.service` shows active because the activation restarted it at 04:59:04 (its unit changed). It is blocked in `gpu_launch.py` waiting on the GPU flock: 36 MB RAM, no GPU memory. The old switcher had already started it at 04:25, so this is the same state as before the deploy, not a regression. If the coder ever releases the flock outside the switcher, this queued reader would take the GPU. Stopping it needs sudo, so I left it for the user to decide.

Not tested live: the fail-safe paths (rollback, breaker, deadlines). They need a forced switch failure on production.
