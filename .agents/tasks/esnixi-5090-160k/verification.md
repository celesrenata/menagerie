# esnixi 5090 vLLM — 160K context / 2-seq verification

**Host:** `esnixi` via `ssh celes@192.168.42.254`
**Repo:** `/home/celes/sources/celesrenata/nix-flakes-refactored` (branch `main`, base HEAD `b1869ed`)
**Change:** Raise 5090 vLLM Qwen3.8-27B coder context 147456 → 163840 (160K); drop maxNumSeqs 3 → 2.
**Scope guard:** NOT built, NOT committed, NOT activated in this step. Protected uncommitted files left untouched: `flake.lock`, `overlays/default.nix`, `overlays/ltrace-skip-tests.nix`, `distcc-monitor.sh`.

## KV math (verified, not re-derived)
- kvCacheMemory = 5905580032 (5.9 GB) → 104 usable hybrid KV blocks of 2848 tokens + 15 GDN state blocks/sequence.
- Startup gate: one 163840 sequence = ceil(163840/2848)=58 + 15 GDN = 73 of 104 usable blocks — fits with margin.
- Model native max_position_embeddings = 262144 (rope default, no YaRN); 163840 well within support.
- kvCacheMemory, kvOffloadingSize=32, gpuMemoryUtilization=0.92 UNCHANGED.

## Edits made (4 target files)

### 1. `esnixi/vllm.nix` — 27B coder service block
- `maxModelLen = "147456";` → `"163840";`
- `maxNumSeqs = "3";` → `"2";`
- Comment "3 concurrent sequences…" → "2 concurrent sequences…"
- KV-block comment updated: one max-length 163840 sequence = 58 blocks + 15 GDN state = 73 of 104 usable (maxNumSeqs now 2).
- mkVllmService defaults (L132), reader service (65536 / maxNumSeqs 16), and fallback (24576) NOT touched.

### 2. `esnixi/vllm-switch.py` — MODELS (both coder aliases)
- `"qwen3.8-27b-nvfp4"`: `"context": 147456` → `163840`, `"max_requests": 3` → `2`.
- `"qwen3.8-27b-nvfp4-balanced"` (`BALANCED_MODEL_ID`): same (`147456`→`163840`, `3`→`2`).
- Reader entry unchanged.

### 3. `home/programs/omniroute-routing.py` — `layouts` dict
- `"vllm/qwen3.8-27b-nvfp4": (131072, 98304)` → `(163840, 147456)`
- `"vllm/qwen3.8-27b-nvfp4-balanced": (131072, 65536)` → `(163840, 65536)`
- Added comment: `147456 = 163840 - 16384 output reserve; COUPLED to esnixi/vllm.nix maxModelLen.`

### 4. `home/programs/zoo-spec-setup.py` — L49
- `local/5090` `contextWindow` `131072` → `163840`.
- research `262144` and hybrid/`local/code`/`local/long` `163840` entries NOT touched.

### Coupled test update: `esnixi/test_vllm_switch.py`
`test_n_coder_admits_up_to_max_requests_then_409` hardcoded `max_requests == 3` and a 3-concurrent-admit / 4th-409 behavioral flow. Dropping the limit to 2 made the hardcoded `3` stale (the only failing assert). Updated to assert `max_requests == 2`, derive the concurrent-admit count from `max_requests`, admit 2 across both coder aliases (shared counter), then confirm the next request 409s. Intent preserved; `test_m` (the pure nix↔MODELS coupling test) continued to pass before and after.

## git status --short (edited vs protected)
```
 M esnixi/test_vllm_switch.py   <- coupled test update (this step)
 M esnixi/vllm-switch.py        <- edit 2 (this step)
 M esnixi/vllm.nix              <- edit 1 (this step)
 M flake.lock                   <- pre-existing, NOT touched
 M home/programs/omniroute-routing.py  <- edit 3 (this step)
 M home/programs/zoo-spec-setup.py     <- edit 4 (this step)
 M overlays/default.nix         <- pre-existing, NOT touched
A  overlays/ltrace-skip-tests.nix     <- pre-existing, NOT touched
?? distcc-monitor.sh            <- pre-existing untracked, NOT touched
```

## STEP A — switcher test suite
Command: `cd $R/esnixi && python3 test_vllm_switch.py`

Result: **PASS**
```
Ran 41 tests in 2.025s

OK
```
`test_m_coupling_matches_vllm_nix` (parses vllm.nix block and asserts
context==maxModelLen, max_requests==maxNumSeqs, port==port for both coder
aliases) passed, proving the nix↔MODELS coupling at 163840 / 2.

## STEP A — py_compile
Command (PYTHONPYCACHEPREFIX redirected to /tmp due to repo-dir cache perms):
```
python3 -m py_compile esnixi/vllm-switch.py            -> OK vllm-switch.py
python3 -m py_compile home/programs/omniroute-routing.py -> OK omniroute-routing.py
python3 -m py_compile home/programs/zoo-spec-setup.py    -> OK zoo-spec-setup.py
python3 -m py_compile esnixi/test_vllm_switch.py         -> OK test_vllm_switch.py
```
All compiled cleanly (exit 0).

## Not done in this step (deferred to a later step)
- No `nixos-rebuild` / flake build.
- No git commit.
- No activation / service restart.
