# Review — Disable the esnixi RTX 5090 NVFP4 9B reader

Removes the esnixi RTX 5090 NVFP4 9B reader (`qwen3.5-9b-nvfp4-reader`, unit `vllm-reader.service`) from the vLLM switcher and OmniRoute routing so the reader lane now only ever lands on ollama backends (4070 Ti Super primary, M5 Max fallback). The change is surgical across five files: one `MODELS` entry out of the switcher, a rewrite of the switcher test suite to a coder-only fixture, deletion of the reader systemd unit + its sudo rules + stale `conflicts` references in `vllm.nix`, and a reader-category retarget in both `omniroute-mode.py` and `omniroute-routing.py`. Committed as `72a6da4` on `main`, not pushed, not deployed.

Watch for: nothing blocking. The diff matches the recorded evidence exactly (confirmed), the five-file reference sweep is clean repo-wide (confirmed), the coder path and `vllm-5090-fallback` are untouched beyond the required stale-reference removal (confirmed), and the surviving ollama readers remain wired in both routing files (confirmed).

**Verdict**: APPROVED

## High-level view

The switcher was already model-generic, so removing the reader meant deleting exactly one `MODELS` dict entry and nothing else — no `READER_UNITS`/`READER_IDLE_SECONDS` constants existed to clean up, contrary to the original task hint. The generic drain/select/watchdog/breaker machinery and the coder/balanced entries are left in place.

The `vllm.nix` change deletes the `vllm-reader` service block, its three NOPASSWD sudo rules, and the stale `vllm-reader.service` entry in `vllm-5090-fallback`'s `conflicts`. The coder's own `conflicts` list never named the reader, so it is correctly left as-is. Comments that described reader co-tenancy were reworded to the coder-only reality; the pinned coder KV/gate/env values that tests assert against are unchanged.

OmniRoute routing is handled in two places. `omniroute-mode.py` (the live driver, since tier state is `tiered`) drops the `READER5090` constant, its override-policy entry, and its weight in the reader chain, leaving `[(READER4070, 100)]`. `omniroute-routing.py`'s `hybrid/reader` branch drops the 5090 step and renumbers the two surviving ollama tiers; the step-id rename is safe because those ids are regenerated every run and never read back.

The test suite rewrite is the largest piece by line count (421 lines, mostly deletions). It makes `FakeHost` single-unit and keeps the coder/generic behaviors. The author did not re-run builds beyond what's recorded; per the task, the recorded `unittest` pass (20 tests) and the Nix pure-eval are accepted as evidence rather than re-run here.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. All completeness, scope, and correctness criteria verified.

</details>

<details>
<summary>Details</summary>

### Switcher reader entry removal is the whole code change

The task brief anticipated reader-only lifecycle constants (`READER_UNITS`, `READER_IDLE_SECONDS`, reader-drain timers) in `vllm-switch.py`. Those do not exist — the switcher is model-generic and keys everything off the `MODELS` map (confirmed: `PRIMARY_MODEL`, `PRIMARY_UNIT`, `select_model`, watchdog, breaker all remain and reference `PRIMARY_MODEL`/`MODELS` generically). The only hard reader reference was the single `MODELS["qwen3.5-9b-nvfp4-reader"]` dict entry (unit `vllm-reader.service`, port 8012, `AxionML/Qwen3.5-9B-NVFP4`, context 65536, max_requests 8). Its 14-line deletion is the complete and correct code change. The coder (`qwen3.8-27b-nvfp4`) and `BALANCED_MODEL_ID` entries are intact (confirmed at lines 96–121).

### vllm.nix: unit, sudo rules, and stale conflicts

The `systemd.services.vllm-reader` block and its explanatory comment are gone, as are the three `vllm-reader.service` NOPASSWD rules (start/stop/reset-failed); the three `vllm.service` rules survive. The scope-sensitive points both check out:

- The coder's `conflicts = [ "vllm-5090-fallback.service" ]` is left unchanged (confirmed line 182) — it never listed the reader, so there was nothing to remove, matching the plan.
- `vllm-5090-fallback`'s `conflicts` dropped `"vllm-reader.service"` and now reads `[ "vllm.service" ]` (confirmed line 221). This was the one legitimately stale reference to the removed unit, and removing it is in-scope. The service is otherwise untouched.

Coder KV/gate/env values that `test_m`/`test_z` pin (`gpuMemoryUtilization = "0.92"`, `kvCacheMemory`, `maxModelLen`, `maxNumSeqs`, port, `sleepMode`, `idleSeconds`) are unchanged; only reader-referencing comments were reworded. The obsolete `vllm-reader-idle` timer comment is dropped.

### OmniRoute routing retarget across two files

`omniroute-mode.py` is the live driver (tier state is `tiered`). It drops `READER5090`, its `OVERRIDE_POLICIES` entry, and collapses the reader override to `[(READER4070, 100)]`; the tier-1 reader description is now 4070 Ti-only. `READER4070` and `WEIGHTS['reader']` survive (confirmed lines 21, 37, 45, 72, 202).

`omniroute-routing.py`'s `hybrid/reader` branch drops the `vllm/qwen3.5-9b-nvfp4-reader` step and renumbers the survivors to `reader-t1-gremlin-4070ti` (ollama-local) then `reader-t2-m5max` (ollama-m5-reader) (confirmed lines 96–97), keeping `strategy`/`context_length`/`config`. The id-rename safety argument holds: the step ids are produced by `desired()` each run and the only `m.get("id")` lookups elsewhere target unrelated planner/overflow ids, so renaming the reader tiers has no downstream reader. The unrelated `local/m5-reader` branch (line 85) and `CONNECTIONS` are untouched.

### Scope discipline

The commit `72a6da4` touches exactly the five target files (confirmed: 83 insertions, 442 deletions). `nigel/virtualisation.nix` shows in a `diff a1edf0c` stat only because it is a pre-existing uncommitted working-tree change; it is NOT in the commit (confirmed via `git show --stat`), and the two `omniroute-mode.py.bak-*` backups remain untracked and unedited. Working tree after commit shows only those three pre-existing untouchables. Still on `main`, HEAD is one commit past `a1edf0c`, nothing pushed or deployed.

### No dangling references

The five-file sweep for `qwen3.5-9b-nvfp4-reader|vllm-reader.service|READER5090|reader-t1-esnixi-5090` returns zero hits, and a repo-wide sweep across `esnixi/` and `home/programs/` `.py`/`.nix` (excluding `.bak`) also returns zero (both confirmed). No surviving unit, model id, constant, or step id references the removed reader.

### Test coverage

The recorded run is `python3 -m unittest test_vllm_switch -v` → 20 tests, 0 failures, 0 errors. Per the task, builds the coder already ran are not re-run here; the evidence is accepted. The rewrite removed every reader-dependent test and helper and retargeted the coder/generic tests (busy 409, residency, same-unit concurrency, env parsing, nix coupling, proxy port, bounded stop, breaker, watchdog, coder fast-retry). The Nix side was validated by `nix eval` of the full esnixi `toplevel.drvPath` (pure evaluation, no build/activate) rather than `nixos-rebuild dry-build`, because `nixos-rebuild` is not in the NOPASSWD sudo set and the batch SSH session has no TTY — a reasonable non-disruptive substitute that still proves the config evaluates with no dangling `vllm-reader.service`.

Not tested here (by design, deferred to operator go-live): the real `nixos-rebuild dry-build`/`switch`, the live OmniRoute `omniroute-mode tiered --apply` reconciliation, and runtime confirmation that `vllm-reader.service` is gone after a rebuild.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm-switch.py` — removed the single `MODELS["qwen3.5-9b-nvfp4-reader"]` entry; generic machinery and coder/balanced entries untouched.
- `esnixi/test_vllm_switch.py` — rewritten to a coder-only `FakeHost`; reader tests/helpers deleted, coder/generic tests retargeted (20 remain).
- `esnixi/vllm.nix` — deleted the `vllm-reader` service + comment, its three sudo NOPASSWD rules, and the stale `vllm-reader.service` entry in `vllm-5090-fallback`'s `conflicts`; reworded reader-referencing comments.
- `home/programs/omniroute-mode.py` — removed `READER5090` constant + override-policy entry; reader override now `[(READER4070, 100)]`; tier-1 reader description 4070 Ti-only.
- `home/programs/omniroute-routing.py` — removed the 5090 step from `hybrid/reader`; renumbered survivors to `reader-t1-gremlin-4070ti` / `reader-t2-m5max`.

Commit `72a6da4` on `main` (not pushed). Full diff: `git --no-pager diff a1edf0c -- <files>` on esnixi.

</details>
