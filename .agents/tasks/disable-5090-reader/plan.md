# Implementation Plan — Disable the esnixi RTX 5090 NVFP4 9B reader

## Goal

Remove the esnixi 5090 vLLM reader (`qwen3.5-9b-nvfp4-reader`, unit `vllm-reader.service`)
from the vLLM switcher and from OmniRoute routing, so the reader lane now only ever hits
ollama backends (`ollama-local/qwen3.5-reader:9b` on the 4070 Ti, and the M5 ollama reader).
Leave the coder path (`vllm.service`, `qwen3.8-27b-nvfp4` + balanced alias) and
`vllm-5090-fallback.service` untouched except for stale `vllm-reader.service` references.

## Environment & ground rules (verified at planning time)

- Host: `esnixi`. All file reads/edits run over SSH:
  `ssh -o ConnectTimeout=10 -o BatchMode=yes celes@192.168.42.254 "<cmd>"`.
  This plan artifact lives in the LOCAL menagerie workspace; the five target files are on esnixi only.
- Repo on esnixi: `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `main`, HEAD `a1edf0c`.
  STAY ON `main`. Do NOT branch/checkout/stash/reset/revert/rebase/push.
- Clean baseline confirmed: `git status --porcelain` shows ONLY the three untouchable unrelated
  entries — ` M nigel/virtualisation.nix`, `?? home/programs/omniroute-mode.py.bak-160kctx-20261004T092815Z`,
  `?? home/programs/omniroute-mode.py.bak-pool-20261004T094024Z`. Never touch these three.
  `git diff a1edf0c -- <file>` shows EXACTLY your own edits — trust it; no partial prior state exists.

### Test runner (IMPORTANT — the task's suggested command does not work here)

- `python3 -m pytest` is NOT available on esnixi (`NO_PYTEST` confirmed). Do NOT use pytest.
- The repo's real runner is Python's stdlib `unittest`. `python3` is 3.14.7 (no separate `python3.14` wrapper needed).
- Baseline: 41 tests pass. Canonical command (run from the `esnixi/` dir):
  ```
  ssh -o ConnectTimeout=10 -o BatchMode=yes celes@192.168.42.254 \
    "cd /home/celes/sources/celesrenata/nix-flakes-refactored/esnixi && python3 -m unittest test_vllm_switch -v"
  ```
  (`python3 -m unittest esnixi.test_vllm_switch` from the repo root also works.)

### Build / rebuild (verified)

- home-manager is a NixOS module here (`home-manager.nixosModules.home-manager` + `home-manager.users.celes`
  in `flake.nix`), so ONE system rebuild deploys both the vllm.nix switcher/reader changes AND the
  home-manager-copied omniroute scripts.
- Dry run (no activation): `sudo nixos-rebuild dry-run --flake .#esnixi` (or `build`).
- Apply: `sudo nixos-rebuild switch --flake .#esnixi`. HIGH-RISK on a live shared GPU host — this
  restarts `vllm-switcher.service` and removes `vllm-reader.service`. See "Go-live" below.

### omniroute-routing.py step-id strategy decision

RENAME IS SAFE. The reader step ids in `omniroute-routing.py` (`reader-t1-esnixi-5090`,
`reader-t2-gremlin-4070ti`, `reader-t3-m5max`) are generated fresh by `desired()` on every run and
are NOT read back, pinned, or looked up anywhere. The only `m.get("id")` lookups in the file target
`hybrid-planner-qwen5090` and `local-code-glm53-overflow` (unrelated). The `hybrid/reader` branch
rebuilds `out["models"]` from scratch, ignoring incoming ids. Therefore: drop the 5090 step and
RENUMBER the survivors → `reader-t1-gremlin-4070ti` (ollama 4070 Ti) then `reader-t2-m5max` (ollama M5).

## Edit plan (surgical, per file)

- [ ] 1. Remove the reader model entry from the switcher's `MODELS` map.
      In `esnixi/vllm-switch.py`, delete the entire `"qwen3.5-9b-nvfp4-reader": { ... }` dict entry
      (the block spanning `"qwen3.5-9b-nvfp4-reader": {` through its closing `},`, ~lines 112-125),
      leaving the coder (`qwen3.8-27b-nvfp4`) and `BALANCED_MODEL_ID` entries intact.
      Do NOT touch the generic machinery: `PRIMARY_MODEL/PRIMARY_UNIT`, `other_units`, `select_model`,
      `residency_remaining`, `_busy_reject`, `acquire`, `release`, `watchdog_*`, breaker logic, the
      `"reader"` string labels in `_busy_reject`/`acquire` (dead-but-harmless with one unit left), and
      `DRAIN_SETTLE_SECONDS` (generic, used by `stop_and_drain`). There is NO `READER_UNITS`/
      `READER_IDLE_SECONDS` constant in this file — the switcher is already model-generic; removing the
      one `MODELS` entry is the whole code change here. Optionally trim only the reader-specific lines of
      the module docstring (lines ~5-8, ~20, ~62, ~66, ~68) if the implementer wants; not required for
      correctness, so prefer leaving comments unless they become misleading.
      Files: `esnixi/vllm-switch.py`
      Verify: `python3 -c "import importlib.util,os,tempfile; ..."` is unnecessary — covered by step 2's
      test run. Minimum check: the file still parses — `ssh ... "cd .../esnixi && python3 -c 'import ast,pathlib; ast.parse(pathlib.Path(\"vllm-switch.py\").read_text())'"`.

- [ ] 2. Rewrite `esnixi/test_vllm_switch.py` to a coder-only switcher model (remove all reader tests).
      With only the coder in `MODELS`, the switcher no longer swaps between two models; every
      reader-dependent test is now meaningless and will fail at import/seed time.
      Make `FakeHost` single-unit (coder only): drop `READER_UNIT`, remove it from `active`, `sub`,
      `nrestarts`, `sleep_answers`, and from `_seed_active`'s unit loop (iterate only `CODER_UNIT`).
      DELETE these reader-only tests entirely: `test_f`, `test_a`, `test_a2`, `test_b`, `test_c`,
      `test_d`, `test_h`, `test_h2`, `test_k`, `test_p`, `test_p3`, `test_q`, `test_r`, `test_s`,
      `test_t`, `test_x`, `test_u`, `test_v`, `test_w`, `test_y3`, `test_ff5`, `test_ff6`, plus the
      reader helpers `_fail_reader_once`, `_seed_reader_idle` (and the `READER` class constant).
      KEEP and adjust these coder/generic tests so they no longer seed or assert the reader unit:
      `test_e`, `test_g` (keep only the coder-request-blocked-within-window direction), `test_i`
      (keep the coder/`BALANCED_MODEL_ID` same-unit path; drop the reader-thread half), `test_j`
      (retarget to the coder), `test_l`, `test_m` (drop the reader `_nix_block("vllm-reader")`
      assertions; keep the coder coupling asserts), `test_n`, `test_o` (proxy only the coder port
      8010; drop the 8012 reader expectation), `test_p2` (retarget the hung-stop scenario to a coder
      cold start, e.g. coder stopped then started), `test_y`, `test_y2`, `test_y4`, `test_y5`,
      `test_ff1`–`test_ff4` (replace `_seed_reader_idle`/`_watchdog_cold` reader seeding with a
      coder-stopped seed), and `test_z` (drop the `vllm-reader` restart/`_nix_block("vllm-reader")`
      assertions; keep the coder KV/gate/env assertions). Update the module docstring summary to drop
      the reader-tenancy narrative. Rewrite is substantial but mechanical; the surviving behavior is
      "keep one coder resident, cold-start/fast-retry/watchdog it."
      Files: `esnixi/test_vllm_switch.py`
      Verify (run AFTER steps 1 and 3, because `test_m`/`test_z` parse `vllm.nix`):
      `ssh ... "cd .../esnixi && python3 -m unittest test_vllm_switch -v"` — all remaining tests pass,
      zero errors, zero failures.

- [ ] 3. Remove the reader systemd service, its sudo rules, and stale unit conflicts from `esnixi/vllm.nix`.
      (a) Delete the whole `systemd.services.vllm-reader = mkVllmService { ... };` block (~lines 225-250)
      and its leading explanatory comment block (~lines 215-224).
      (b) In `security.sudo.extraRules`, delete the three `vllm-reader.service` NOPASSWD lines
      (start/stop/reset-failed, ~lines 288-290); keep the three `vllm.service` lines.
      (c) `systemd.services.vllm` (coder): change `conflicts = [ "vllm-5090-fallback.service" ];` — it
      currently lists only the fallback, so NO reader entry to remove there; LEAVE AS-IS. Trim only the
      reader-referencing coder comments that become misleading: line ~181 "Co-resident with the reader
      (sleep mode swaps them)" and the lines ~198-203 that describe the reader's VRAM headroom and
      "the switcher stops the reader ... whenever it selects the coder." Reword to the coder-only reality
      (coder is the sole 5090 sleep-mode tenant). Keep `kvCacheMemory`, `gpuMemoryUtilization = "0.92"`,
      `maxModelLen`, `maxNumSeqs`, `port`, `sleepMode`, `idleSeconds` unchanged (test_z/test_m pin them).
      (d) `systemd.services.vllm-5090-fallback`: change
      `conflicts = [ "vllm.service" "vllm-reader.service" ];` → `conflicts = [ "vllm.service" ];`
      so it no longer names a non-existent unit. Update the adjacent comment that says it "conflicts with
      both the coder and the reader" to reference only the coder.
      (e) The comment at ~lines 336-337 ("The former vllm-reader-idle stop timer is gone...") references
      the reader; trim/reword to not reference the now-removed reader, or drop it.
      Do NOT rewrite unrelated comments or the `mkVllmService` definition (it stays generic).
      Files: `esnixi/vllm.nix`
      Verify: evaluation succeeds and no dangling reader unit — `ssh ... "cd ... && sudo nixos-rebuild
      dry-run --flake .#esnixi"` completes without errors (see step 7 for the combined dry-run), and
      `git diff a1edf0c -- esnixi/vllm.nix` shows only the intended deletions/comment edits.

- [ ] 4. Point the OmniRoute mode policy's reader category at the 4070 Ti ollama reader only.
      In `home/programs/omniroute-mode.py`:
      (a) Delete the `READER5090 = 'vllm/qwen3.5-9b-nvfp4-reader'` constant (~line 39). Keep
      `READER4070 = 'ollama-local/qwen3.5-reader:9b'` (~line 40). Reword the comment at ~lines 36-38 to
      describe a single 4070 Ti ollama reader (drop the "5090 NVFP4 reader is primary / 5090, fallback to
      4070" wording).
      (b) Change the reader override (~line 48) from `'reader': [(READER5090, 60), (READER4070, 40)],`
      to `'reader': [(READER4070, 100)],`. Reword the preceding comment (~lines 46-47) to drop the
      "5090 NVFP4 reader -> 4070 Ti Super" wording.
      (c) In `OVERRIDE_POLICIES` (~lines 71-77), delete the `READER5090: {...}` entry (~line 75); keep the
      `READER4070: {...}` entry.
      (d) Update the tier-1 reader description string (~lines 205-206) from
      `'Tier 1 reader: 5090 NVFP4 9B reader > 4070 Ti Super 9B reader priority'` to a 4070 Ti-only
      wording, e.g. `'Tier 1 reader: 4070 Ti Super 9B ollama reader'`.
      Leave `WEIGHTS['reader']`, `CONNECTIONS`, `PROVIDER_POLICIES`, and all non-reader categories untouched.
      Files: `home/programs/omniroute-mode.py`
      Verify: file parses and no stale symbol — `ssh ... "cd .../home/programs && python3 -c 'import ast,pathlib;
      ast.parse(pathlib.Path(\"omniroute-mode.py\").read_text())' && ! grep -n READER5090 omniroute-mode.py
      && echo OK"` prints `OK`. Preview against live OmniRoute is part of go-live (step 8), not a build gate.

- [ ] 5. Remove the esnixi-5090 vLLM step from the `hybrid/reader` chain in `home/programs/omniroute-routing.py`.
      In the `elif name == "hybrid/reader":` branch (~lines 88-105): delete the
      `target("reader-t1-esnixi-5090", "vllm/qwen3.5-9b-nvfp4-reader", "vllm")` step and RENUMBER the
      survivors so the chain is 4070 Ti ollama first, then M5 ollama:
      - `target("reader-t1-gremlin-4070ti", "ollama/qwen3.5-reader:9b", "ollama-local")`
      - `target("reader-t2-m5max", "ollama/qwen3.5-reader:9b", "ollama-m5-reader")`
      Keep `out["strategy"] = "priority"`, `out["context_length"] = 32768`, and the `config.update(...)`
      line unchanged. Reword the explanatory comment (~lines 89-97) to describe a two-tier ollama reader
      fabric (4070 Ti primary, M5 fallback); drop the "esnixi 5090 NVFP4 reader (PRIMARY) ... switcher 409"
      narrative and the "5090, fallback to 4070 ti super" line.
      Renaming is safe (see decision above). Do NOT touch `local/m5-reader`, `NAMES`, `CONNECTIONS`, the
      `provider_policy` map, or any other branch.
      Files: `home/programs/omniroute-routing.py`
      Verify: file parses and the 5090 reader string is gone from the reader branch — `ssh ...
      "cd .../home/programs && python3 -c 'import ast,pathlib; ast.parse(pathlib.Path(\"omniroute-routing.py\").read_text())'
      && ! grep -n 'reader-t1-esnixi-5090\|qwen3.5-9b-nvfp4-reader' omniroute-routing.py && echo OK"` prints `OK`.
      NOTE: because `tier-switch-state.json` exists with `active_mode = tiered`, `omniroute-routing.py`
      delegates to `omniroute-mode.py` on a normal run (unless `--full-context-only`). This branch only
      executes for `--full-context-only` or when no tier state exists; edit it anyway for correctness/consistency.

- [ ] 6. Final no-stale-reference sweep across all five files.
      Confirm the only remaining `qwen3.5-9b-nvfp4-reader` / `vllm-reader.service` references are intentional
      (there should be NONE in the five edited files after this change).
      Files: none (verification only)
      Verify: `ssh ... "cd /home/celes/sources/celesrenata/nix-flakes-refactored &&
      grep -rn 'qwen3.5-9b-nvfp4-reader\|vllm-reader.service\|READER5090\|reader-t1-esnixi-5090' \
      esnixi/vllm-switch.py esnixi/test_vllm_switch.py esnixi/vllm.nix \
      home/programs/omniroute-mode.py home/programs/omniroute-routing.py; echo EXIT=$?"` returns no matches
      (grep EXIT=1). Also run `git diff --stat a1edf0c` and confirm ONLY these five files changed (plus the
      three pre-existing untouchable entries remain untouched).

- [ ] 7. Build gate: switcher tests + Nix evaluation.
      Files: none (verification only)
      Verify (both must pass):
      - Tests: `ssh ... "cd /home/celes/sources/celesrenata/nix-flakes-refactored/esnixi &&
        python3 -m unittest test_vllm_switch -v"` — all remaining tests pass (0 failures, 0 errors).
      - Nix eval: `ssh ... "cd /home/celes/sources/celesrenata/nix-flakes-refactored &&
        sudo nixos-rebuild dry-run --flake .#esnixi"` — completes with no evaluation errors and no
        reference to a removed `vllm-reader.service`.

## Go-live (operator steps — HIGH-RISK, live shared GPU host)

Discovered deployment path (do NOT guess beyond this):

1. Deploy the edited scripts + systemd units with one system rebuild (home-manager is a NixOS module,
   so this also installs the updated `~/.local/share/omniroute-editor/omniroute-mode.py` and the
   `omniroute-apply-routing` wrapper):
   ```
   sudo nixos-rebuild switch --flake .#esnixi
   ```
   This restarts `vllm-switcher.service` with the coder-only `MODELS` and removes `vllm-reader.service`.
   If the reader unit is currently loaded/running, the operator should stop it first
   (`sudo systemctl stop vllm-reader.service`) so the rebuild removes a quiescent unit.

2. Push the updated OmniRoute policy. The live reader routing is driven by `omniroute-mode.py`
   because `~/.local/state/omniroute-routing/tier-switch-state.json` has `active_mode = tiered`.
   Preview first (no `--apply`), then apply:
   ```
   omniroute-mode tiered            # preview: shows the reader route now 4070 Ti-only
   omniroute-mode tiered --apply    # push to OmniRoute (writes a timestamped backup; drift-checked)
   ```
   (The `omniroute-apply-routing` wrapper runs `omniroute-routing.py`, which — with tier state present —
   itself delegates to `omniroute-mode.py tiered`. Running `omniroute-mode` directly is the direct path.
   Use `omniroute-apply-routing --full-context-only` only for the 5090 catalog-limit override flow, which
   is unrelated to this reader change.)

3. Verify after apply: the `hybrid/reader` route in OmniRoute lists only the 4070 Ti ollama reader then
   the M5 ollama reader (no `vllm/qwen3.5-9b-nvfp4-reader`), and `systemctl status vllm-reader.service`
   reports the unit no longer exists. The coder (`vllm.service`) and `vllm-switcher.service` stay healthy.

## Notes / assumptions

- The task hinted at `READER_UNITS`, `READER_IDLE_SECONDS`, and reader-drain constants in
  `vllm-switch.py`; these do NOT exist — the switcher is model-generic and the only hard reader reference
  is the single `MODELS` entry. The plan reflects the actual code.
- The task said to run `python -m pytest`; pytest is not installed on esnixi. The repo uses stdlib
  `unittest` (41 tests at baseline). The plan uses `python3 -m unittest`.
- `git diff a1edf0c -- <file>` is the source of truth for each edit; keep every change minimal.
