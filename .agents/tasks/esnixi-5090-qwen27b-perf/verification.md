# Verification: esnixi 5090 Qwen3.8-27B NVFP4 perf config (iteration 1)

Host `celes@192.168.42.254`, repo `/home/celes/sources/celesrenata/nix-flakes-refactored`, branch `feat/nvfp4-reader-fabric`, parent `2b1c1f7`. Built, not switched.

## Applied config (vllm.service only)

| Knob                                          | Before                          | After                                    |
| --------------------------------------------- | ------------------------------- | ---------------------------------------- |
| maxModelLen                                   | 131072                          | 131072                                   |
| maxNumSeqs                                    | 1                               | 4                                        |
| kvCacheMemory                                 | 4776620811                      | 6442450944 (6 GiB)                       |
| kvOffloadingSize                              | null                            | 32 GiB, `--kv-offloading-backend native` |
| --max-num-batched-tokens                      | 256                             | 5760                                     |
| MTP                                           | k=3                             | k=3 (unchanged)                          |
| CUDA graphs / eager                           | graphs on, no `--enforce-eager` | unchanged                                |
| KV dtype                                      | nvfp4                           | nvfp4 (unchanged)                        |
| switcher `max_requests` (coder + `-balanced`) | 1 / 1                           | 4 / 4                                    |
| switcher `context` (coder + `-balanced`)      | 131072                          | 131072 (== `--max-model-len`)            |
| `VLLM_SWITCH_RESIDENCY_SECONDS`               | 90                              | 90                                       |

## Results

- `nix eval --raw …services.vllm.serviceConfig.ExecStart` matches the plan exactly:
  `… vllm serve nvidia/Qwen3.8-27B-NVFP4 --served-model-name qwen3.8-27b-nvfp4 --host 127.0.0.1 --port 8010 --max-model-len 131072 --max-num-seqs 4 --kv-cache-memory=6442450944 --kv-cache-dtype nvfp4 --kv-offloading-size 32 --kv-offloading-backend native --language-model-only --linear-backend cutlass --reasoning-parser qwen3 --tool-call-parser qwen3_xml --enable-auto-tool-choice --max-num-batched-tokens 5760 --speculative-config '{"method":"mtp","num_speculative_tokens":3}'`
- `vllm-reader` and `vllm-5090-fallback` ExecStart are byte-identical to before the edit (`cmp` against pre-edit captures).
- `vllm-switcher.environment.VLLM_SWITCH_RESIDENCY_SECONDS` = `"90"`.
- `python3 esnixi/test_vllm_switch.py`: **Ran 15 tests, OK**. That's the 13 existing tests plus new (m), the nix coupling guard, and (n), which admits 4 then returns 409.
- Negative check: setting coder `maxNumSeqs = "1"` temporarily makes `test_m_coder_coupling_matches_vllm_nix` FAIL. After restoring `"4"`, the run gives 15 OK.
- `nixos-rebuild build --flake .#esnixi`: **rc=0**, giving `/nix/store/c9ib4am72mklw4qssq04181c3c5v8mz7-nixos-system-esnixi-26.11.20260922.6774f7b`. It rebuilt `unit-vllm.service` and `unit-vllm-switcher.service`. The comfy and atlas unit rebuilds in the same build come from uncommitted working-tree files that were already there and that this change doesn't touch. `result` is gitignored.
- No switch was performed.
