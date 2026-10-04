# Verification: vllm-switcher hysteresis (iteration 1, not committed)

Host: celes@192.168.42.254, repo /home/celes/sources/celesrenata/nix-flakes-refactored,
branch feat/nvfp4-reader-fabric, HEAD 1d1059e (unchanged, nothing committed).

Files changed (only these three; `git status --short -- <them>` shows ` M` for each):

```
 esnixi/test_vllm_switch.py | 135 +++++++++++++++++++++++++++++++++++++++++++++
 esnixi/vllm-switch.py      |  55 +++++++++++++++---
 esnixi/vllm.nix            |   2 +
 3 files changed, 183 insertions(+), 9 deletions(-)
```

Note: `git diff --cached --name-only` currently prints nothing (0 staged files). setup.md listed
staged "A" files; they were not staged at the time of this check. I did not run any git add/reset.

## Tests

Command (repo root, per setup.md; pytest is not installed):
`python3 esnixi/test_vllm_switch.py`

Run 1 (exit 0):

```
test_a_never_both_active ... ok
test_b_reader_start_ordering ... ok
test_c_idle_expiry_stops_reader ... ok
test_d_request_during_idle_cancels_stop ... ok
test_e_busy_returns_false ... ok
test_f_context_matches_served_max_model_len ... ok
test_g_residency_blocks_swap_within_window ... ok
test_h2_window_expiring_during_lock_wait_swaps ... ok
test_h_swaps_after_window ... ok
test_i_same_unit_unaffected ... ok
test_j_release_and_acquire_stamp_last_activity ... ok
test_k_idle_stop_fires_despite_residency_and_frees_gpu ... ok
test_l_env_seconds_parsing ... ok
----------------------------------------------------------------------
Ran 13 tests in 2.206s
OK
```

Run 2 (flakiness check, exit 0): `Ran 13 tests in 2.206s` / `OK`.

Mapping to the requested cases:

- (a) different unit within window -> False/409, no systemctl stop/start: test_g (both directions)
- (b) after the window it swaps: test_h (age 91s > 90s), test_h2 (window expires mid lock-wait)
- (c) same-unit unaffected: test_i (coder, balanced alias, 2 concurrent reader requests; zero systemctl calls)
- (d) idle-stop timer still armed and fires inside the window, then coder can claim GPU: test_k
- Readiness coupling: test_f passes; vllm.nix reader `maxModelLen = "65536"` matches MODELS context 65536.

## Build

Command: `nixos-rebuild build --flake .#esnixi` -> exit 0,
`Done. The new configuration is /nix/store/s4dh8rhds4108hchlk1yl7blfzi6kybx-nixos-system-esnixi-26.11.20260922.6774f7b`

Artifact checks:

- `grep RESIDENCY result/etc/systemd/system/vllm-switcher.service` ->
  `Environment="VLLM_SWITCH_RESIDENCY_SECONDS=90"`
- The built switcher script referenced by that unit contains `residency_remaining` (2 matches).

Not deployed (no `nixos-rebuild switch`), not committed, per this step's instructions.
