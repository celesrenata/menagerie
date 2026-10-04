# Verification: esnixi 27B coder KV (iteration 1)

Commit: **e789922** on main (`fix(esnixi): 5.5 GiB coder KV, 0.92 startup gate, switcher stops reader for coder`), parent 9fc7375. Not pushed. Not deployed (`nixos-rebuild switch` is operator-run).

Files committed (explicit paths): `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `esnixi/test_vllm_switch.py`. The untracked `distcc-monitor.sh` was left alone.

## Changes (per plan.md)

- vllm.nix coder: `kvCacheMemory = 5905580032;` (was 5368709120), `gpuMemoryUtilization = "0.92";` (was "0.80"), comments rewritten with the block arithmetic and the gate math. Generic mkVllmService comment now cites the measured residuals (coder 2.30, reader 1.56, desktop 0.93 GiB).
- vllm.nix reader: no functional change (restart "no", idleSeconds 300, kv 4 GiB, gate 0.50). The block comment and trailing comment now say the switcher stops the reader whenever it selects the coder.
- vllm-switch.py `select_model`: `if active == "active" and target_unit != PRIMARY_UNIT and sleep_unit(other, deadline):`. Selecting the coder (acquire, rollback, watchdog all go through select_model) now stops and drains the reader. Selecting the reader still sleeps the coder. Docstring and `release()` comment updated. MODELS unchanged.
- test_vllm_switch.py: test_d split (coder->reader `[("sleep", coder)]`, reader->coder `[("stop", reader)]`); test_r expects `[("stop", reader)]`; new `test_a2_coder_stops_reader_instead_of_sleeping` covers reader awake + coder asleep, reader asleep + coder asleep, and reader asleep + coder cold start (asserts stop, never sleep of the reader, reader inactive, coder started only in the cold case, `gpu_owners() == [coder]`); test_z pins `kvCacheMemory = 5905580032;` and `gpuMemoryUtilization = "0.92";` in the coder block; docstring (a), (d), (z) updated.

## Commands and results (all on esnixi)

```
$ git -C /home/celes/sources/celesrenata/nix-flakes-refactored status   (before edits)
On branch main, ahead of origin/main by 1 commit; untracked: distcc-monitor.sh; nothing else

$ cd /home/celes/sources/celesrenata/nix-flakes-refactored && python3 esnixi/test_vllm_switch.py
Ran 33 tests in 1.727s
OK

$ python3 esnixi/test_vllm_idle.py
Ran 7 tests in 0.719s
OK

$ nixos-rebuild build --flake .#esnixi        (working tree, before commit)
building unit-vllm.service.drv, vllm-switch.py.drv, unit-vllm-switcher.service.drv,
system-units.drv, etc.drv, activate.drv, nixos-system-esnixi-26.11.20260922.6774f7b.drv
Done. The new configuration is /nix/store/14avxdr4vhk9mb7jmb0230vhcpimfxc5-nixos-system-esnixi-26.11.20260922.6774f7b

$ nix store diff-closures /run/current-system ./result
(no output; exit 0) -- no package/version changes, nixpkgs/kernel/nvidia untouched

$ grep -o -- '--kv-cache-memory=[0-9]* --gpu-memory-utilization [0-9.]*' result/etc/systemd/system/vllm{,-reader}.service
vllm.service:--kv-cache-memory=5905580032 --gpu-memory-utilization 0.92
vllm-reader.service:--kv-cache-memory=4294967296 --gpu-memory-utilization 0.50

$ diff -rq /run/current-system/etc/systemd/system result/etc/systemd/system
differ: multi-user.target.wants/vllm-switcher.service, vllm.service, vllm-switcher.service
(only these three; vllm-reader.service is byte-identical)

$ readlink -f kernel in both systems -> identical ("kernel-same")
```

The rebuilt derivations are only the vllm unit, the switcher script and its unit, plus the system-units/etc/activate/toplevel wrappers that every unit change pulls in.

During the first test run, test_a2 failed in the warm-coder case because the fake host leaves a running coder flagged asleep until its middleware wakes it. The test now models that wake and also covers the cold-start case. It passed on the second run (output above).

## Post-deploy checks (operator, not run here)

Order matters (review finding 2): stop the reader BEFORE the switch, so the flock-blocked reader launcher can't take the lease while `vllm.service` restarts.

1. `sudo systemctl stop vllm-reader`
2. `sudo nixos-rebuild switch --flake .#esnixi`
3. Confirm "reserved 5.5 GiB" and about 1.69x max concurrency in the coder startup log.
4. Under real Zoo c=4 load, nvidia-smi should show at least ~1000 MiB free (finding 3: headroom is now ~1.0 GiB, so watch for desktop or browser GPU growth).
5. A reader request followed by a coder request should log "stopping vllm-reader.service", not "slept".

# Iteration 2 (review.json: CHANGES_REQUESTED)

Commit: **7b0531d** on main (`test(esnixi): hung reader stop fails coder select without sticking`), parent e789922. Not pushed. File committed: `esnixi/test_vllm_switch.py` only.

- Finding 1 (blocking: 4 × 55K isn't reached at 5.5 GiB with MTP 3) is a product decision, so the code is unchanged. Escalated to the user with a send_message warning: Option B (MTP off, 4 × 57K) or accept 3 × 54K.
- Finding 1 resolution: the user chose **Option A**. MTP k=3 stays on with 5.5 GiB KV (e789922 + 7b0531d), on the expectation that the Zoo workers' shared system-prompt/tools prefix lets 4 concurrent requests fit through prefix caching. Live-verify must measure both cases: (1) 4 × ~55K distinct prompts and (2) 4 × ~55K sharing a ~30K prefix. For each, report Running/Waiting, TTFT, aggregate tok/s and VRAM free, and note what Option B (MTP off) would likely gain or lose.
- Finding 2: post-deploy order fixed above.
- Finding 3: folded into post-deploy check 4.
- Finding 4: new `test_p3_reader_stop_timeout_fails_coder_select` (reader awake, coder asleep, reader `systemctl stop` times out). It asserts a 409 `start_failed` containing "could not stop vllm-reader.service", no reader sleep, no coder start, `switching` False, `switching_to` None, and `breakers["vllm.service"]["failures"] == 1`. Docstring entry (p3) added.

```
$ git status --short          (before edit)
?? distcc-monitor.sh
$ python3 esnixi/test_vllm_switch.py
Ran 34 tests in 2.026s
OK
$ python3 esnixi/test_vllm_idle.py
Ran 7 tests in 0.719s
OK
$ nixos-rebuild build --flake .#esnixi     (working tree, before commit)
Done. The new configuration is /nix/store/14avxdr4vhk9mb7jmb0230vhcpimfxc5-nixos-system-esnixi-26.11.20260922.6774f7b
  (same toplevel as iteration 1; the test file is not part of the closure)
$ nix store diff-closures /run/current-system ./result
(no output; exit 0)
$ diff -rq /run/current-system/etc/systemd/system result/etc/systemd/system
differ: multi-user.target.wants/vllm-switcher.service, vllm.service, vllm-switcher.service
```
