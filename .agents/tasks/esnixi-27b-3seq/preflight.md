# Preflight: esnixi 5090 27B coder 4 -> 3 concurrent sequences

Host: esnixi (celes@192.168.42.254), repo /home/celes/sources/celesrenata/nix-flakes-refactored

## Starting state

- Branch: main
- HEAD: 7b0531d (matches expected deployed generation 438)
- `git status --porcelain`: only `?? distcc-monitor.sh` (untracked, repo root). Leave it untouched; never stage it.
- No uncommitted changes in esnixi/vllm.nix, esnixi/vllm-switch.py, esnixi/test_vllm_switch.py, home/programs/omniroute-routing.py, home/programs/omniroute-mode.py. Safe to proceed.

Scope check: the only "4" on the 5090 is the Qwen3.8-27B coder (vllm.service). The 9B reader is maxNumSeqs "16" / max_requests 8 and does not change.

## Change list (4 -> 3)

### esnixi/vllm.nix (vllm.service coder block)

- :209 `maxNumSeqs = "4";` -> `"3"`
- :193 comment `# 4 concurrent sequences.` -> `# 3 concurrent sequences.`
- :198-200 KV-capacity comment ("fits 3 x 54K or 2 x 57K (4 x 57K with a ~40K shared Zoo prefix)") is informational; optional refresh only.
- :210 `--max-num-batched-tokens 5760` comment mentions "other seqs MTP decode tokens"; value unchanged.

### esnixi/vllm-switch.py (MODELS)

- :95 `"qwen3.8-27b-nvfp4"` `"max_requests": 4` -> `3`
- :103 `BALANCED_MODEL_ID` ("qwen3.8-27b-nvfp4-balanced") `"max_requests": 4` -> `3`

### esnixi/test_vllm_switch.py

- :450-456 coupling test parses maxNumSeqs from vllm.nix and asserts == max_requests. No edit needed; it follows automatically.
- `test_n_coder_admits_up_to_max_requests_then_409` (:462-494):
    - :467 `assertEqual(SW.MODELS[self.CODER]["max_requests"], 4)` -> `3`
    - :468 `ids = [CODER, CODER, BALANCED, BALANCED]` -> 3 ids that still mix both aliases, e.g. `[CODER, CODER, BALANCED]`
    - :480 `[True] * 4` -> `[True] * 3`
    - :482 `active_requests, 4` -> `3`
    - :490 `for _ in range(4)` -> `range(3)`

### home/programs/omniroute-routing.py

- :165 comment `Matches the 5090 coder's 4 vLLM sequences / switcher max_requests 4.` -> 3 / 3
- :166 `CONNECTIONS["vllm"]: {"maxConcurrent": 4},` -> `3`

### home/programs/omniroute-mode.py

- :106-107 comment `runs 4 sequences (esnixi/vllm.nix --max-num-seqs 4, switcher max_requests 4)` -> 3 / 3 / 3
- :110 `CONNECTIONS['vllm']: {'maxConcurrent': 4},` -> `3`

Leave these alone (not the 5090 semaphore):

- omniroute-mode.py:213 `concurrencyPerModel=1 if tier == 1 else 4` (cloud tiers 2-5 combo config)
- omniroute-mode.py:363 summary print text (describes context sizes; no 4-seq value)
- maxConcurrent 1 entries for ollama-local, llama-cpp, ollama-m5-reader

`git grep maxConcurrent` found no other preview/expected values. 966dba3 changed only omniroute-mode.py and omniroute-routing.py.
