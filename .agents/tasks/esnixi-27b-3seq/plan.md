# Implementation Plan: esnixi 5090 27B coder 4 -> 3 concurrent sequences

Host: `ssh celes@192.168.42.254`. Repo: `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `main`, HEAD `7b0531d`.
All commands below run on esnixi from the repo root. Local artifacts: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/esnixi-27b-3seq/` (on the Mac).
Line numbers come from preflight.md and were re-checked against HEAD 7b0531d.

Rules for the whole change:

- `git status --porcelain` before starting must show only `?? distcc-monitor.sh`. Never stage, edit or delete it.
- Keep `kvCacheMemory = 5905580032;` (5.5 GiB) exactly as it is. Do not touch `kvOffloadingSize`, `maxModelLen`, `port`, or `extraArgs` (`--max-num-batched-tokens 5760` stays).
- The 9B reader (`maxNumSeqs "16"` / `max_requests` 8) does not change.
- Do NOT run omniroute-routing.py or omniroute-mode.py against live OmniRoute. Do not push.

- [ ]   1. Change the coder to 3 seqs in esnixi/vllm.nix.
       In the vllm.service coder block: `:209 maxNumSeqs = "4";` -> `"3"`; `:193` comment `# 4 concurrent sequences.` -> `# 3 concurrent sequences.`. Optional comment refresh at `:198-200` only (the 3 x 54K figure already matches); no value changes.
       Files: esnixi/vllm.nix
       Verify: `git diff esnixi/vllm.nix` shows only the maxNumSeqs value and comment lines; `kvCacheMemory = 5905580032;` is unchanged.

- [ ]   2. Change the switcher limit and its tests (depends on 1 for the coupling test).
       esnixi/vllm-switch.py MODELS: `:95` (`qwen3.8-27b-nvfp4`) and `:103` (`BALANCED_MODEL_ID`, `qwen3.8-27b-nvfp4-balanced`) `"max_requests": 4` -> `3`. Both must match because they share one active_requests counter.
       esnixi/test_vllm_switch.py, `test_n_coder_admits_up_to_max_requests_then_409` (:462-494): `:467` assertEqual(..., 4) -> 3; `:468` ids -> `[self.CODER, self.CODER, self.BALANCED]` (keep the existing spelling and still mix both aliases); `:480` `[True] * 4` -> `[True] * 3`; `:482` `active_requests, 4` -> `3`; `:490` `range(4)` -> `range(3)`. Leave the vllm.nix<->switcher coupling test (:450-456) alone: it parses maxNumSeqs itself and will check 3 == 3.
       Files: esnixi/vllm-switch.py, esnixi/test_vllm_switch.py
       Verify: `python3 esnixi/test_vllm_switch.py` and `python3 esnixi/test_vllm_idle.py` both pass (OK, 0 failures). Also run `python3 esnixi/test_comfy_ondemand.py` as a regression check. Save the summary lines.

- [ ]   3. Update the OmniRoute routing scripts so a later run does not put 4 back.
       home/programs/omniroute-routing.py: `:165` comment "4 vLLM sequences / switcher max_requests 4" -> 3 / 3; `:166` `CONNECTIONS["vllm"]: {"maxConcurrent": 4},` -> `3`.
       home/programs/omniroute-mode.py: `:106-107` comment (`runs 4 sequences (esnixi/vllm.nix --max-num-seqs 4, switcher max_requests 4)`) -> 3 / 3 / 3; `:110` `CONNECTIONS['vllm']: {'maxConcurrent': 4},` -> `3`.
       Leave these unchanged: omniroute-mode.py `concurrencyPerModel=1 if tier == 1 else 4` (~:213, cloud tiers), the summary print at ~:363/367, and every `maxConcurrent: 1` entry.
       Neither script has its own tests. `tests/test_omniroute_workers.py` only loads omniroute-workers.py, so it is a regression check, not a test of these scripts.
       Files: home/programs/omniroute-routing.py, home/programs/omniroute-mode.py
       Verify: `python3 -m py_compile home/programs/omniroute-routing.py home/programs/omniroute-mode.py` exits 0 (it compiles without running anything). `python3 -m unittest tests/test_omniroute_workers.py` (or `python3 tests/test_omniroute_workers.py`) passes. `git grep -n "maxConcurrent" home/programs/` shows vllm at 3 in both files and no other 4.

- [ ]   4. Build and check the closure diff (depends on 1-3).
       Run `nixos-rebuild build --flake .#esnixi`, then `nix store diff-closures /run/current-system ./result`. The diff may touch ONLY the vllm units (vllm.service / coder unit and its generated scripts) and the vllm-switch switcher. home-manager / omniroute script derivations also changed in step 3; if they show up, list them explicitly in verification.md as expected from step 3. If anything else changed (other packages, version bumps, unrelated units), STOP: call send_message severity "warning" with the list and wait. Do not activate (`switch`/`test`). Leave `./result` as a symlink and do not commit it (it is gitignored or untracked; check with `git status`).
       Files: none (build output only)
       Verify: the build exits 0 and the diff-closures output is limited to the paths above.

- [ ]   5. Record the evidence in the LOCAL file `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/esnixi-27b-3seq/verification.md`.
       Include: the exact commands with exit codes and test summary lines from steps 2-3, the build result, the full `nix store diff-closures` output with a one-line classification of each entry, and `git diff --stat` plus the full `git diff`, so the reviewer does not have to re-run anything.
       Files: verification.md (on the Mac)
       Verify: the file exists and covers every command in steps 2-4.

- [ ]   6. Commit on main by explicit path, with no push.
       `git add esnixi/vllm.nix esnixi/vllm-switch.py esnixi/test_vllm_switch.py home/programs/omniroute-routing.py home/programs/omniroute-mode.py` then `git commit -m "esnixi: serve 27B coder with 3 concurrent sequences (vllm, switcher, OmniRoute)"`. Do not use `git add -A`/`.`. Add the commit hash to verification.md.
       Verify: `git status --porcelain` shows only `?? distcc-monitor.sh` (and `result` if it is untracked); `git show --stat HEAD` lists exactly the 5 files; `git log origin/main..HEAD` shows the new commit (not pushed).
