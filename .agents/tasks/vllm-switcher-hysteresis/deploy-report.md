# Deploy report: vllm-switcher hysteresis (esnixi)

Status: DEPLOYED. The user ran the switch because sudo needs a password. The live check was done through the journal, not with authenticated requests (details in section 6).

## 1. Commit

- Branch feat/nvfp4-reader-fabric, not pushed.
- Commit: `2b1c1f78f58ffdb04ce9cbe28b67e368c5e10819` "fix(esnixi): add minimum-residency hysteresis to vllm switcher"
- `git add` with explicit paths, then a path-limited commit (`-- esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix`). vllm.nix is included because it adds `VLLM_SWITCH_RESIDENCY_SECONDS = "90"`.
- `git show --stat HEAD`: exactly those 3 files (183 insertions, 9 deletions).
- Unrelated dirty, intent-to-add, and untracked files were left alone. `git status --short` went from 44 to 41 lines, so only the 3 committed files left the list.

## Tests (from verification.md, re-run before commit)

`python3 esnixi/test_vllm_switch.py` -> Ran 13 tests, OK (a through l, including test_f context coupling).

## 2. Build

`nixos-rebuild build --flake .#esnixi` -> `/nix/store/s4dh8rhds4108hchlk1yl7blfzi6kybx-nixos-system-esnixi-26.11.20260922.6774f7b`
Current system: `/nix/store/6r37blqk7qj8lgr4pvg8n95cc71jgfr6-nixos-system-esnixi-...`

## 3. Closure gate: PASS

`nix store diff-closures /run/current-system ./result` printed nothing, because no package version or size changed. A full comparison of the store paths in each closure (`comm` of `nix-store -qR` for both systems) shows only these changes:

- vllm-switch.py: hs406331... -> hdvsmk2a...
- unit-vllm-switcher.service: 457p74m2... -> h156b4jq...
- The aggregates that wrap them: system-units, etc, nixos-system toplevel

No vllm engine units or other services changed, and nothing from the dirty tree leaked in.

## 4. Switch: BLOCKED (sudo password required)

The user needs to run this on esnixi:

```
cd /home/celes/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi
```

Effect: only vllm-switcher.service restarts, which drops any in-flight proxied request. vllm.service and vllm-reader.service are not restarted.

## Pre-switch state

- vllm-switcher ExecStart: `/nix/store/hs406331cwxhilbf0fsh9ys60z566d53-vllm-switch.py`, active since Thu 2026-10-01 20:23:51 PDT
- vllm.service inactive, vllm-reader.service active. nvidia-smi: RTX 5090 at 11271 MiB used (reader loaded).

## 4b. Switch: DONE by the user

`/run/current-system` -> `/nix/store/s4dh8rhds4108hchlk1yl7blfzi6kybx-nixos-system-esnixi-...` (the built system).

## 5. Restart verification: PASS

- `systemctl show -p ExecStart vllm-switcher.service` -> `.../python3 /nix/store/hdvsmk2arpqcqwmdm0df206cbvqqv6p8-vllm-switch.py` (the NEW path), started Sat 2026-10-03 00:24:17 PDT, PID 1708322.
- `systemctl status`: active (running), with no errors or tracebacks in the journal.
- Environment includes `VLLM_SWITCH_RESIDENCY_SECONDS=90`.
- vllm.service and vllm-reader.service were not restarted by the switch. At 00:24:21 the first request after the restart sent `reset-failed` + `start vllm-reader.service`; the reader was already running, so that was a no-op.
- nvidia-smi at 00:24:41: RTX 5090 at 28207 MiB, with the reader loaded.

## 6. Live check: verified through the journal during real traffic, NOT with authenticated requests

`sudo -n true` still returns "a password is required", so the token could not be read through sudo. I sent no authenticated test requests, and the token was never read or printed.

Journal evidence, 00:24:17 to 00:31:35:

- Pre-deploy churn for comparison: reader stopped 00:20:37, coder started 00:20:40, coder stopped 00:22:24, reader started 00:22:27. That is two swaps about 2 minutes apart.
- Post-deploy: vllm-reader served 6 `POST /v1/chat/completions` with 200, the last at 00:26:56. The switcher issued no stop/start of either unit after 00:24:21, and vllm.service was never started. No swap happened while the reader was in use.
- 00:29:22: the reader was stopped by the separate `vllm-reader-idle` oneshot ("Stop the NVFP4 reader after it has been idle for 5 minutes", polling /metrics). The switcher did not stop it. This is the intended idle release, so the GPU is now free (vllm.service and vllm-reader.service both inactive).
- The switcher does not log 409s, so the journal can't confirm the fast-409 path directly. The direct evidence is the absence of any stop/start. The 409 then fallthrough would show in the OmniRoute call_logs, which I did not check.

Observation, outside the scope of this fix: the idle oneshot stopped the reader 146s after its last request, not 300s. Its idle clock likely counts from before the last burst, or the oneshot uses its own state. Worth checking separately if the reader unloads sooner than expected.

## Status: DEPLOYED

Commit 2b1c1f7 (not pushed). The switcher is running the hysteresis build with RESIDENCY=90s.
