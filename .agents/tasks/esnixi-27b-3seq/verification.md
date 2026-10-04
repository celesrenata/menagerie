# Verification: esnixi 5090 27B coder 4 -> 3 concurrent sequences

Host esnixi (`ssh celes@192.168.42.254`), repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `main`.
Iteration: FIRST (no review.json existed).
Commit: **f947fbc** `esnixi: serve 27B coder with 3 concurrent sequences (vllm, switcher, OmniRoute)`. Not pushed.

## Preconditions

- `git status --porcelain` -> `?? distcc-monitor.sh` only. HEAD `7b0531d`.
- `git grep -n maxConcurrent` (before) -> vllm=4 at omniroute-mode.py:110 and omniroute-routing.py:166; others are `1` or the print at mode.py:367. No preview/expected values elsewhere.

## Edits

Applied by an asserting Python replace script (each old string had to match the exact expected count, or it aborted).

`git diff --stat`:

```
 esnixi/test_vllm_switch.py         | 10 +++++-----
 esnixi/vllm-switch.py              |  4 ++--
 esnixi/vllm.nix                    |  4 ++--
 home/programs/omniroute-mode.py    |  6 +++---
 home/programs/omniroute-routing.py |  4 ++--
 5 files changed, 14 insertions(+), 14 deletions(-)
```

Full `git diff` (= `git show f947fbc`):

```diff
--- a/esnixi/test_vllm_switch.py
+++ b/esnixi/test_vllm_switch.py
@@ -464,8 +464,8 @@ class SwitcherTests(unittest.TestCase):
         SW.LOCK_WAIT_SECONDS = 0.2
         self._seed_active(self.CODER, age=0)
         h = self._handler()
-        self.assertEqual(SW.MODELS[self.CODER]["max_requests"], 4)
-        ids = [self.CODER, self.CODER, SW.BALANCED_MODEL_ID, SW.BALANCED_MODEL_ID]
+        self.assertEqual(SW.MODELS[self.CODER]["max_requests"], 3)
+        ids = [self.CODER, self.CODER, SW.BALANCED_MODEL_ID]
         results = []
         results_lock = threading.Lock()
@@ -479,15 +479,15 @@ class SwitcherTests(unittest.TestCase):
             t.start()
         for t in threads:
             t.join(5)
-        self.assertEqual(results, [True] * 4)
+        self.assertEqual(results, [True] * 3)
         with SW.switch_condition:
-            self.assertEqual(SW.active_requests, 4)
+            self.assertEqual(SW.active_requests, 3)
         self.assertFalse(h.acquire_model(self.CODER))
         # A reader request cannot swap while the coder is busy, even past residency.
         SW.RESIDENCY_SECONDS = 0
         self.assertFalse(h.acquire_model(self.READER))
         self.assertEqual(self.lifecycle(), [])
-        for _ in range(4):
+        for _ in range(3):
             h.release_model()
         with SW.switch_condition:
             self.assertEqual(SW.active_requests, 0)
--- a/esnixi/vllm-switch.py
+++ b/esnixi/vllm-switch.py
@@ -92,7 +92,7 @@ MODELS = {
         "served": "qwen3.8-27b-nvfp4",
         "hf_id": "nvidia/Qwen3.8-27B-NVFP4",
         "context": 131072,
-        "max_requests": 4,
+        "max_requests": 3,
     },
     BALANCED_MODEL_ID: {
         "unit": "vllm.service",
@@ -100,7 +100,7 @@ MODELS = {
         "served": "qwen3.8-27b-nvfp4",
         "hf_id": "nvidia/Qwen3.8-27B-NVFP4",
         "context": 131072,
-        "max_requests": 4,
+        "max_requests": 3,
     },
--- a/esnixi/vllm.nix
+++ b/esnixi/vllm.nix
@@ -190,7 +190,7 @@ in
-    # 4 concurrent sequences. maxModelLen, maxNumSeqs and port are COUPLED to
+    # 3 concurrent sequences. maxModelLen, maxNumSeqs and port are COUPLED to
@@ -206,7 +206,7 @@ in
     kvCacheMemory = 5905580032;
     kvOffloadingSize = 32;
     maxModelLen = "131072";
-    maxNumSeqs = "4";
+    maxNumSeqs = "3";
--- a/home/programs/omniroute-mode.py
+++ b/home/programs/omniroute-mode.py
@@ -103,11 +103,11 @@ MODES = {
-# The native 5090 vLLM coder runs 4 sequences (esnixi/vllm.nix --max-num-seqs 4,
-# switcher max_requests 4); keep OmniRoute's persisted provider semaphore aligned
+# The native 5090 vLLM coder runs 3 sequences (esnixi/vllm.nix --max-num-seqs 3,
+# switcher max_requests 3); keep OmniRoute's persisted provider semaphore aligned
 # whenever a tier preset is applied.
 PROVIDER_POLICIES = {
-    CONNECTIONS['vllm']: {'maxConcurrent': 4},
+    CONNECTIONS['vllm']: {'maxConcurrent': 3},
--- a/home/programs/omniroute-routing.py
+++ b/home/programs/omniroute-routing.py
@@ -162,8 +162,8 @@ def main():
-        # Matches the 5090 coder's 4 vLLM sequences / switcher max_requests 4.
-        CONNECTIONS["vllm"]: {"maxConcurrent": 4},
+        # Matches the 5090 coder's 3 vLLM sequences / switcher max_requests 3.
+        CONNECTIONS["vllm"]: {"maxConcurrent": 3},
```

`kvCacheMemory = 5905580032;`, `kvOffloadingSize`, `maxModelLen`, `port`, `extraArgs`, and the 9B reader are unchanged. The optional KV-capacity comment (vllm.nix:198-200) was left as is. omniroute-mode.py `concurrencyPerModel ... else 4` (cloud tiers) and every `maxConcurrent: 1` entry are untouched.

## Tests (run on esnixi from the repo root)

| Command                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python3 esnixi/test_vllm_switch.py`                                                       | `Ran 34 tests ... OK`, exit 0 (includes the vllm.nix<->switcher coupling test `test_m`, now 3 == 3)                                                                                                                                                                                                                                                                                                         |
| `python3 esnixi/test_vllm_idle.py`                                                         | `Ran 7 tests ... OK`, exit 0                                                                                                                                                                                                                                                                                                                                                                                |
| `python3 esnixi/test_comfy_ondemand.py`                                                    | `Ran 6 tests ... OK (skipped=2)`, exit 0                                                                                                                                                                                                                                                                                                                                                                    |
| `python3 -m py_compile home/programs/omniroute-routing.py home/programs/omniroute-mode.py` | exit 0. I deleted the generated `omniroute-{routing,mode}.cpython-314.pyc` afterwards; the existing `omniroute-workers` pyc was left alone.                                                                                                                                                                                                                                                                 |
| `python3 tests/test_omniroute_workers.py`                                                  | `Ran 3 tests ... FAILED (failures=1)`: `test_concurrent_hosts_and_per_host_caps` fails at line 31 (`all(t['state']=='completed' ...)`). **This failure was already there before this change**: the same command in a clean `git worktree` at HEAD 7b0531d also gives `FAILED (failures=1)` (I removed the worktree afterwards). The test only loads omniroute-workers.py, which this change does not touch. |
| `git grep -n maxConcurrent home/programs/` (after)                                         | vllm=3 at mode.py:110 and routing.py:166; nothing else is 4.                                                                                                                                                                                                                                                                                                                                                |

Neither OmniRoute script was run against live OmniRoute. Nothing was activated (no `switch`/`test`).

## Build

`nixos-rebuild build --flake .#esnixi` -> exit 0.
`/run/current-system` = `/nix/store/14avxdr4…-nixos-system-esnixi-26.11.20260922.6774f7b`
`./result` = `/nix/store/qsnq8v0a…-nixos-system-esnixi-26.11.20260922.6774f7b`

### `nix store diff-closures /run/current-system ./result`

Output was **empty**, exit 0. No package versions or sizes changed. diff-closures only reports version and size deltas, so I also compared the closures path by path.

### Path-level closure comparison

Method: `comm` of `nix-store -qR` for both systems, then `diff -r` of each changed old/new path pair (store hashes shown as `<H>`). The same 20 names appear on both sides, with no paths added or removed:

| Changed path                                                                                                                                                                        | Classification                                                   | Content diff                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| unit-vllm.service                                                                                                                                                                   | vllm unit (intended)                                             | ExecStart: only token change `--max-num-seqs 4` -> `3`; `--kv-cache-memory=5905580032` present in both |
| vllm-switch.py                                                                                                                                                                      | switcher (intended)                                              | lines 95, 103 `max_requests` 4 -> 3                                                                    |
| unit-vllm-switcher.service                                                                                                                                                          | switcher unit (intended)                                         | ExecStart hash ref to new vllm-switch.py only                                                          |
| omniroute-routing.py                                                                                                                                                                | step-3 script (expected)                                         | lines 165-166, comment + maxConcurrent 4 -> 3                                                          |
| omniroute-apply-routing                                                                                                                                                             | wrapper for omniroute-routing.py (expected from step 3)          | hash ref only                                                                                          |
| omniroute-apply-routing-fish-completions, celes-fish-completions                                                                                                                    | depend on the wrapper above (expected from step 3)               | hash ref only (no text diff)                                                                           |
| hm_omniroutemode.py                                                                                                                                                                 | step-3 script (expected)                                         | lines 106-107, 110, comment + maxConcurrent 4 -> 3                                                     |
| home-manager-path, home-manager-files, home-manager-generation, hm-putter.json, hm*hmfontconfigfonts.xml, hm*.manpath, man-cache, user-environment, unit-home-manager-celes.service | home-manager rebuild caused by the two step-3 scripts (expected) | hash refs only                                                                                         |
| system-units, etc, nixos-system-esnixi                                                                                                                                              | top-level aggregators                                            | hash refs only                                                                                         |

Nothing else changed: no other packages, no version bumps, no unrelated units.

## Commit

```
git add esnixi/vllm.nix esnixi/vllm-switch.py esnixi/test_vllm_switch.py home/programs/omniroute-routing.py home/programs/omniroute-mode.py
git commit -m "esnixi: serve 27B coder with 3 concurrent sequences (vllm, switcher, OmniRoute)"
```

- `git show --stat HEAD`: exactly the 5 files, 14+/14-.
- `git status --porcelain`: `?? distcc-monitor.sh` only (`result` is ignored).
- `git log origin/main..HEAD`: f947fbc, 7b0531d, e789922, 9fc7375 (none pushed; the three older ones were already unpushed before this step).

## Not done / follow-ups for the user

- Not deployed. Running `nixos-rebuild switch` restarts vllm.service and vllm-switcher.
- The live OmniRoute vllm `maxConcurrent` is not changed by this commit. It updates only when `omniroute-apply-routing` / `omniroute-mode` is next run.
