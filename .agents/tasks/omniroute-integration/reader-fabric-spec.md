# Reader fabric + NVFP4 KV — confirmed design (verified ground truth)

Captured by orchestrator from live inspection. Deploy is the user's job (they `switch`);
workflows only write config and dry-validate (`nixos-rebuild build` / `darwin-rebuild build`, NO switch).

## Hosts (verified via docs/local-inference.md + flakes, 2026)

- **esnixi** = RTX 5090, `192.168.42.254`. Primary coding = native vLLM `qwen3.8-27b-nvfp4`.
- **gremlin-1** = RTX 4070 Ti Super, `10.1.1.12`. Current fast worker (Ollama Ornith 1.5 9B @262k;
  also a k8s `vllm-4070ti` serving `QuantTrio/Qwen3.5-4B-AWQ` @32k, gpu-util 0.55, max-num-seqs 2).
- **stabulous** = M5 Max. `local-model-proxy` (:7777), unified memory, no arcane-gpu lease.

## vLLM build (verified)

- Native build (LIVE 5090 coder): `esnixi/vllm.nix` → `pkgsAccel.vllm` from `overlays/vllm.nix`
  pinned `0.31.0.dev0+gddd6fbca` (rev ddd6fbca) with SIX patches:
  vllm-sm120-fp4-support, vllm-sm120-nvfp4-kv, vllm-sm120-nvfp4-q-dequant,
  vllm-flashinfer-gdn-api, vllm-flashinfer-mm-prefix-seqlens, vllm-flashinfer-nvfp4-noncausal.
  Serves on 127.0.0.1:8010, `--kv-cache-dtype nvfp4` ALREADY, maxModelLen 147456, gpu-util 0.88,
  started by the switcher (`systemctl start vllm.service`).
- Dormant fallback: `modules/profiles/ai.nix` `docker-vllm-5090` container, `autoStart=false`,
  STOCK `vllm/vllm-openai:v0.29.0`, `--kv-cache-dtype fp8_e4m3`, port 8010:8000. NOT the live path.

## GPU arbitration (verified) — arcane-gpu lease

- `/run/arcane-gpu/5090.lock` flock. `esnixi/arcane_gpu.py` (GPULease), `gpu_launch.py`
  (blocking LOCK_EX then execvp, fd inheritable via ARCANE_GPU_LOCK_FD), `vllm_idle.py`
  (IdleSleepMiddleware: sleeps weights to host RAM after 5s idle, releases lease).
- Hard VRAM constraint: vLLM coder ~83% + OS ~14% => ~3% free. The 9B reader CANNOT co-reside.
  Reader must fully release: unload AND stop its process so VRAM returns to the coder.

## CONFIRMED DECISIONS

1. **Dormant container** `docker-vllm-5090`: `fp8_e4m3` → `nvfp4` KV, AND move off stock v0.29.0
   onto the patched build (latest vLLM + our 6 SM120/nvfp4 patches + any upstream nvfp4 changes).
2. **vLLM overlay bump**: bump `overlays/vllm.nix` from 0.31.0.dev0+gddd6fbca to latest, pulling
   in upstream NVFP4 changes; REBASE all 6 patches against new upstream (drop any now-upstreamed),
   update src hash + cargoDeps hashes. Validate NVFP4 weights+KV still load on SM120 after bump.
3. **New reader = NVFP4 9B + NVFP4 KV on the patched vLLM** (NOT ollama q4). Drop the ollama
   qwen3.5:9b-q4_K_M reader on esnixi (revert the ai.nix oneshot + Modelfile I added earlier).
   Base NVFP4 9B checkpoint: AxionML/Qwen3.5-9B-NVFP4 (verify format = compressed-tensors/W4A16
   preferred on SM120; our patches may make W4A4 fine — validate). "Flies" on 5090: generous
   --max-num-seqs / --max-num-batched-tokens, real paged/parallel KV (continuous batching).
4. **Reader lifecycle on esnixi**: on-demand; acquires arcane-gpu lease (gpu_launch.py), serves,
   and on idle FULLY STOPS (service down => VRAM returned, lease released) so the 27B coder reclaims.
   A small lease-aware activator in front (esnixi analog of local-model-proxy) starts/stops it.
5. **Scheduling / overflow policy (gateway `hybrid/reader` tiered combo)**:
    - priority 1: **4070 Ti Super** (gremlin) — first-choice reader.
    - priority 2: **5090** (esnixi) — ONLY when 4070ti busy (>=1 read job) AND 5090 NOT running a
      qwen3.8 coding job (coding wins; reader takes 5090 only during a coding lull, under the lease).
    - priority 3: **M5 Max** — joins only after the 5090 fills up (headroom overflow).
    - menagerie already points reader route at `hybrid/reader` (user said "looks fine"). NOTE:
      gateway catalog does NOT currently publish `hybrid/reader` as a resolvable combo — only
      `ollama/qwen3.5-reader:9b` exists. Must CREATE/REPAIR the `hybrid/reader` combo with the tiers
      above and verify it resolves (chat completion returns, served model is a reader tier).
6. M5 Max side: keep ollama via local-model-proxy (unified memory, no lease). The type:ollama
   backend `qwen35-reader-262k` + Modelfile already added to m5max flake stand.

## Validation (no deploy)

- esnixi: `nixos-rebuild build --flake .#esnixi` must succeed (proves overlay+patch rebase builds).
- Confirm patched vLLM loads the NVFP4 9B with `--kv-cache-dtype nvfp4` on SM120 (dry/off-hours test
  if a GPU slot is free; otherwise document the exact serve command for the user to validate).
- Gateway: `hybrid/reader` resolves (authenticated chat completion), tiers in correct priority.
- Record every command + result; user performs the actual `switch` and gateway apply.

## UPDATE — gateway auth resolved (orchestrator, confirmed by user "then add it")

The preflight found `/run/secrets/omniroute_zoo_api_key` undeclared/unreadable on esnixi.
RESOLVED: the key is now a sops secret on esnixi.

- Encrypted into `secrets/secrets.yaml` via `sops set ["omniroute_zoo_api_key"]` (value never printed).
- Declared in `secrets.nix` as `sops.secrets.omniroute_zoo_api_key` (mode 0440, group wheel),
  modeled on the existing `openai_api_key` / `vllm_switcher_token` entries. Backup: /tmp/secrets.nix.bak.
- Verified: `nix eval .#nixosConfigurations.esnixi.config.sops.secrets.omniroute_zoo_api_key.path`
  → `/run/secrets/omniroute_zoo_api_key` (materialized after the operator's `nixos-rebuild switch`).
- IMPLICATION for the gateway combo step: use `/run/secrets/omniroute_zoo_api_key` as the admin
  bearer for the `hybrid/reader` combo POST, NOT the `omniroute-local` editor key. The path only
  exists post-switch, so the combo-apply remains an OPERATOR step (or runs after switch).
- NOTE: these sops edits (secrets.yaml + secrets.nix) are uncommitted on branch
  feat/nvfp4-reader-fabric alongside the workflow's design/impl changes; operator deploys.
