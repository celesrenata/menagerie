# esnixi deploy: 27B coder 4 → 3 concurrent sequences

- Commit: f947fbc (nix-flakes-refactored, main)
- Generation: 439 (current), previous 438
- /run/current-system: /nix/store/qsnq8v0ajaa7wb04yw9wxirxhcsyqpbm-nixos-system-esnixi-26.11.20260922.6774f7b
- Verified: 2026-10-03 08:04 PDT, over SSH

## Live config

- vllm.service (qwen3.8-27b-nvfp4): active since 08:04:12. Unit file and running process both show `--max-num-seqs 3`.
- vllm-switcher.service: active, process started 08:04:11 from the new script `/nix/store/cxdlrkdjldjyd7da65viv93a4fpiq461-vllm-switch.py`. Both coder entries have `"max_requests": 3`. The 9B reader stays at 8.
- vllm-reader.service: inactive. That's expected, since the switcher stops the reader while the coder is loaded.

## Notes

- The first attempt didn't run. sudo failed because there was no terminal to ask for the password. The second run, from an interactive session, applied generation 439.
