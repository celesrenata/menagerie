# Coder KV 5 → 5.5 GiB on the 5090, switcher stops the reader for the coder (pass 2)

This pass covers e789922 plus 7b0531d on esnixi `main`, diffed against 9fc7375. The first pass blocked on one product question: with MTP k=3, 5.5 GiB holds 3 × 54K unique, not 4 × 55K. The user has since picked Option A. MTP stays on at 5.5 GiB, on the bet that the Zoo workers' shared system/tools prefix lets four requests fit through prefix caching, and that bet gets measured live. That decision clears the blocker. The other three pass-1 findings are fixed: the runbook order is corrected, the headroom check is in the post-deploy steps, and a new test (p3) covers a hung reader stop. The production code is unchanged from pass 1, and the closure diff is still limited to `vllm.service` and the switcher script and unit.

Watch for: with Option A, a ~30K shared prefix still does not fit 4 × 55K. That takes about 34K of sharing, so live-verify case (2) should expect one request waiting unless the real prefix is larger (confirmed arithmetic, informational).

**Verdict**: APPROVED

## High-level view

The KV arithmetic stands as reviewed in pass 1. 5.5 GiB is 105 blocks of 2848 tokens (104 usable), and each sequence costs ceil((L+3)/2848) + 15 GDN blocks, with MTP lookahead and spec state included. At the coder's measured 29,708 MiB peak with the reader stopped, about 1033 MiB stays free. Four distinct 55K requests need 140 blocks. With S shared full attention blocks they need 140 − 3S, so they fit at S ≥ 12, which is about 34.2K tokens of shared prefix. When it doesn't fit, vLLM queues the fourth request instead of OOMing.

The reader strategy and the gates are unchanged and still hold. The reader starts only while the coder is asleep, and its 0.50 gate (15.72 GiB) has about 12 GiB of margin. A coder cold start after a reader session finds the reader stopped, which leaves about 30.16 GiB against the 28.93 GiB gate. A coder wake isn't gated and leaves about 1.0 GiB.

The switcher change is still the single `target_unit != PRIMARY_UNIT` guard in `select_model`. Acquire, rollback-to-coder and the watchdog all go through it, MODELS is untouched, and the `test_m` coupling doesn't depend on the KV value. The new p3 test confirms the fail-closed path the sleep fallback removal created. A reader that can't be stopped makes the coder select return a 409 `start_failed`, records one coder breaker failure, and leaves `switching` and `switching_to` cleared. The reader is never slept and the coder is never started.

<details>
<summary>Issues (1)</summary>

1. **30K shared prefix is short of 4 × 55K** (confirmed, non-blocking). Ten shared blocks give 110 needed against 104 available, so live-verify case (2) should expect Running=3/Waiting=1 at ~30K sharing. Report the actual Zoo prefix length alongside the result; ≥ ~34K is needed for all four to run.

</details>

<details>
<summary>Details</summary>

### Option A capacity under prefix sharing

The verification note asks live-verify to measure 4 × ~55K distinct prompts and 4 × ~55K sharing a ~30K prefix. The block math predicts both results ahead of time:

```
55K  -> ceil(55003/2848) = 20 attn + 15 GDN = 35 blocks/seq
distinct:        4 x 35            = 140  > 104  -> 3 running, 1 waiting
30K shared:      S = floor(30000/2848) = 10;  140 - 3*10 = 110 > 104 -> still 1 waiting
34.2K shared:    S = 12;           140 - 36 = 104 -> all 4 run, zero slack
```

Only full blocks are shared, and the 15 GDN state blocks per sequence are never shared. So the second test case only proves Option A if the real Zoo prefix is about 34K or more. Otherwise both cases will show a waiting request, and the result reads as "Option A ≈ 3 concurrent". The expectation should be stated up front so a Waiting=1 result isn't misread as a regression.

### Hung reader stop on coder select (p3)

This closes pass-1 finding 4. With the sleep fallback gone for the primary, the failure is now visible to the breaker instead of being silently hidden by a reader that stayed asleep and resident.

### Runbook

The post-deploy order now stops `vllm-reader` before `nixos-rebuild switch`. That closes the window in which the flock-blocked reader launcher could take the lease while `vllm.service` restarts. The ~1 GiB headroom check under real c=4 load is folded into step 4.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm.nix`: coder `kvCacheMemory` 5905580032 and `gpuMemoryUtilization` "0.92", with budget comments. Reader block: comments only (e789922).
- `esnixi/vllm-switch.py`: `select_model` stops, rather than sleeps, other units when the target is the coder. Docstring and `release()` comment updated (e789922).
- `esnixi/test_vllm_switch.py`: test_d split by direction, test_r expects stop, test_a2 matrix, test_z pins the KV and gate (e789922). New test_p3 for a hung reader stop (7b0531d).

Full diff: `ssh celes@192.168.42.254 git -C /home/celes/sources/celesrenata/nix-flakes-refactored diff 9fc7375 7b0531d`

</details>
