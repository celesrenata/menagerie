# 27B coder on the 5090: 4 → 3 concurrent sequences

Commit f947fbc on esnixi `main` (not pushed) drops the Qwen3.8-27B NVFP4 coder from 4 to 3 concurrent sequences, because 4 was too slow. The value appears in three places that have to agree: vLLM's `--max-num-seqs`, the switcher's `max_requests` admission limit, and OmniRoute's persisted per-provider `maxConcurrent` semaphore. All three were lowered to 3 together. The KV budget, context length, batched-token cap and the 9B reader were not touched. The build output changes only the vllm unit, the switcher, and the home-manager chain for the two OmniRoute scripts.

Watch for: the KV-capacity comment at vllm.nix:198-200 still mentions the "4 x 57K" case (informational, non-blocking, **confirmed**). The live OmniRoute semaphore stays at 4 until `omniroute-apply-routing`/`omniroute-mode` is run again after deploy (deployment note, **confirmed**).

**Verdict**: APPROVED

## High-level view

The three limits now agree at 3. vllm.nix sets `maxNumSeqs = "3"`, and `kvCacheMemory = 5905580032` is byte-for-byte unchanged. The closure diff shows the ExecStart token change as `--max-num-seqs 4` → `3`, with `--kv-cache-memory=5905580032` present on both sides. Keeping the 5.5 GiB budget while serving fewer sequences gives each sequence more KV room. It does not regress anything.

Both switcher entries, `qwen3.8-27b-nvfp4` and the `-balanced` alias, moved to `max_requests: 3`. They share one `active_requests` counter, so it matters that they match, and they do. The admission test was resized to 3 slots and still mixes both aliases (CODER, CODER, BALANCED), so the shared-counter behaviour is still tested. The vllm.nix↔switcher coupling test reads `maxNumSeqs` from the nix file, so it needed no edit and now checks 3 == 3. The coder ran it and it passed (34/34).

Both OmniRoute scripts hardcode the vllm provider semaphore, and both are now 3. If only one had been updated, applying a tier preset would have silently put 4 back. The cloud-tier `concurrencyPerModel ... else 4` and the `maxConcurrent: 1` entries for the M5 and Ollama providers were correctly left alone.

<details>
<summary>Issues (1)</summary>

1. **Stale KV-capacity comment** — vllm.nix:198-200 still describes the "4 x 57K with a ~40K shared Zoo prefix" case. It is informational only. Optionally reword it to describe the 3-seq setup next time the file is touched. Non-blocking.

</details>

<details>
<summary>Details</summary>

### KV budget and the admission chain

```
OmniRoute vllm semaphore (3) ─▶ vllm-switcher max_requests (3, shared by coder + balanced) ─▶ vllm --max-num-seqs 3
                                                                                              --kv-cache-memory=5905580032 (unchanged)
```

Each layer is at or below the one after it. OmniRoute will not send a fourth request that the switcher would reject with a 409. The switcher will not admit more requests than vLLM schedules, so nothing sits invisibly in vLLM's waiting queue. `--max-num-batched-tokens 5760` is unchanged. Its comment ("64 slots for the other seqs MTP decode tokens") still holds with fewer sequences. The one stale text is the KV-capacity comment at :198-200, which the plan marked optional (**confirmed**, non-blocking).

### Evidence and scope

verification.md shows: switch tests 34 OK, idle tests 7 OK, comfy tests 6 OK (2 skipped), py_compile exit 0 for both OmniRoute scripts, and `nixos-rebuild build` exit 0. The coder also did a path-level closure comparison after `diff-closures` came back empty. Every changed path falls into one of three groups: the intended vllm/switcher units, the two step-3 scripts, or home-manager/top-level aggregators that only changed hash references. `tests/test_omniroute_workers.py` has one failure. The coder showed it also fails on a clean worktree at 7b0531d, and the test only loads omniroute-workers.py, which this commit does not touch, so it is out of scope.

Not tested: the two OmniRoute scripts have no unit tests. Their `maxConcurrent` values are checked only by `git grep` and by reading the diff (both confirm 3), not by an automated coupling assertion like the vllm.nix↔switcher one.

### Commit hygiene

`git show --stat HEAD` lists exactly the 5 intended files (14+/14−). `git status --short` on esnixi shows only `?? distcc-monitor.sh`, so the untracked script was not staged or modified. The commit is not pushed.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm.nix` — coder `maxNumSeqs` 4 → 3, comment updated; KV budget unchanged.
- `esnixi/vllm-switch.py` — `max_requests` 4 → 3 for the coder and the balanced alias.
- `esnixi/test_vllm_switch.py` — admission test resized to 3 slots, still mixes both aliases.
- `home/programs/omniroute-routing.py` — vllm `maxConcurrent` 4 → 3, comment updated.
- `home/programs/omniroute-mode.py` — vllm `maxConcurrent` 4 → 3, comment updated.

Full diff: `git -C /home/celes/sources/celesrenata/nix-flakes-refactored show f947fbc` on esnixi.

</details>
