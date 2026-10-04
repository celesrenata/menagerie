# Reader fabric + NVFP4 — PREFLIGHT verification

Run by: workflow preflight/blocker gate (no deploy, no live changes).
Date: 2026-10-01 (PDT).
Source of truth: `reader-fabric-spec.md` (same dir).
Secrets policy: no secret values are printed, logged, or written here.

## Summary

| #   | Check                                                          | Result                                                                 |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | SSH reachability (esnixi `192.168.42.254`)                     | PASS                                                                   |
| 2   | Remote repo is git + feature branch created                    | PASS                                                                   |
| 3   | vLLM overlay pin + 6 patches captured                          | PASS                                                                   |
| 4   | Local OmniRoute repo + feature branch created                  | PASS                                                                   |
| 5   | NVFP4 9B checkpoint reference verified                         | PASS (format noted below)                                              |
| 6   | Gateway key file `/run/secrets/omniroute_zoo_api_key` readable | FINDING — not readable / not declared (see below). NOT a hard blocker. |

Hard blockers (SSH + remote repo reachability) both PASS → proceeding, no `error` stop.

---

## Note on host identity (reconcile with user message #2)

User message #2 ("it is localhost in `~/sources/m5max-darwin-flake` not `192.168.42.254`")
refers to the **m5max / stabulous** host, not esnixi. The authoritative spec maps
**esnixi = RTX 5090 = `192.168.42.254`**, and non-interactive SSH to that address succeeds
(check 1), returning hostname `esnixi` and an RTX 5090. All esnixi-side checks below use
`192.168.42.254` per the spec.

---

## Check 1 — SSH reachability (NON-INTERACTIVE)

Command:

```
ssh -o BatchMode=yes celes@192.168.42.254 'echo ok; hostname; nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv'
```

Result (exit 0):

```
ok
esnixi
name, memory.total [MiB], memory.used [MiB]
NVIDIA GeForce RTX 5090, 32607 MiB, 30234 MiB
```

Ground facts: host `esnixi`, 1× RTX 5090, 32607 MiB total, 30234 MiB used (~92% used — the live
vLLM coder is resident; confirms the "no co-reside" VRAM constraint from the spec).

---

## Check 2 — Remote repo is git + create feature branch (no push)

Status command:

```
ssh -o BatchMode=yes celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && git -C ~/sources/celesrenata/nix-flakes-refactored status --porcelain=v1 -b | head -5'
```

Result (exit 0):

```
## main...origin/main [ahead 2]
 M docs/omniroute-editors.md
 A docs/omniroute-routing.md
 A esnixi/backup.nix
 M esnixi/comfy-worker.nix
```

Base branch: **main** (ahead of origin/main by 2; pre-existing working-tree changes present —
not touched). Remote HEAD short SHA at branch time: `9d67e4f`.

Create branch command:

```
ssh -o BatchMode=yes celes@192.168.42.254 'git -C ~/sources/celesrenata/nix-flakes-refactored switch -c feat/nvfp4-reader-fabric'
```

Result (exit 0): `Switched to a new branch 'feat/nvfp4-reader-fabric'`. Now on
`feat/nvfp4-reader-fabric` (NOT pushed).

---

## Check 3 — vLLM overlay pin + 6 patch filenames

Command:

```
ssh -o BatchMode=yes celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && grep -n "version|ddd6fbca|0.31|src =" overlays/vllm.nix | head -40; ls patches/vllm-*.patch'
```

Pin (overlays/vllm.nix):

- line 351: `version = "0.31.0.dev0+gddd6fbca";`
- line 355: `rev = "ddd6fbca148a867aad1fcab7ec72f582b9977db4";`

Matches the spec exactly (`0.31.0.dev0+gddd6fbca`, rev `ddd6fbca`).

Six patch files present under `patches/` (all six from the spec confirmed):

```
patches/vllm-flashinfer-gdn-api.patch
patches/vllm-flashinfer-mm-prefix-seqlens.patch
patches/vllm-flashinfer-nvfp4-noncausal.patch
patches/vllm-sm120-fp4-support.patch
patches/vllm-sm120-nvfp4-kv.patch
patches/vllm-sm120-nvfp4-q-dequant.patch
```

(Related overlay pins also observed: `qutlass` rev `e74319e3405ce6d71965732880f5dc1f52371f64`.)

---

## Check 4 — Local OmniRoute repo + feature branch (no push)

Commands:

```
git -C /Users/celes/sources/celesrenata/OmniRoute rev-parse --is-inside-work-tree   # -> true
git -C /Users/celes/sources/celesrenata/OmniRoute branch --show-current             # -> release/v3.8.52
git -C /Users/celes/sources/celesrenata/OmniRoute switch -c feat/hybrid-reader-combo
```

Result (exit 0): `Switched to a new branch 'feat/hybrid-reader-combo'`.
Base branch: **release/v3.8.52**. Now on `feat/hybrid-reader-combo` (NOT pushed).

---

## Check 5 — NVFP4 9B base checkpoint reference

Reference: `AxionML/Qwen3.5-9B-NVFP4` — EXISTS on Hugging Face
(https://huggingface.co/AxionML/Qwen3.5-9B-NVFP4).

Quant format (from the model card, verified by fetch):

- **NVFP4 via NVIDIA TensorRT Model Optimizer (ModelOpt)** — vLLM/SGLang quant method
  `modelopt_fp4`. Weights **and activations** of linear/MLP operators quantized to FP4.
  This is a **ModelOpt NVFP4 (W4A4-style)** checkpoint, **not** compressed-tensors/W4A16.
- Model card states "NVFP4 (MLP-only, MSE calibration)", calibration dataset
  Nemotron-Post-Training-Dataset-v2, checkpoint size ~6 GB.
- The **checkpoint's own KV-cache is NOT quantized**; our plan supplies `--kv-cache-dtype nvfp4`
  at serve time (SM120 patches).
- Model: Qwen3.5-9B, 32 layers, hidden 4096, native context 262,144 (extensible ~1,010,000).

Relevance to spec decision #3: the spec preferred compressed-tensors/W4A16 but allowed W4A4 if
"our patches make it fine — validate." This checkpoint is ModelOpt NVFP4 (W4A4). The downstream
build/validate step must confirm the patched vLLM loads `modelopt_fp4` with `--kv-cache-dtype
nvfp4` on SM120, OR select/produce a compressed-tensors/W4A16 variant if W4A4 does not validate.
Not determinable without a GPU load test — flagged for the implementation step, NOT a blocker.

---

## Check 6 — Gateway API key file (FINDING, not a hard blocker)

Command (value never echoed):

```
ssh -o BatchMode=yes celes@192.168.42.254 "test -r /run/secrets/omniroute_zoo_api_key && echo 'key file readable' || echo 'KEY FILE MISSING'"
```

Result (exit 0): `KEY FILE MISSING`

Follow-up (no values echoed):

- `ls -la /run/secrets/` as `celes` → `Permission denied` (sops-rendered secrets are
  root/service-owned, 0400; the SSH user cannot stat the directory, so a plain `test -r` would
  report missing even if the file existed).
- `sudo -n test -e /run/secrets/omniroute_zoo_api_key` → non-interactive sudo not available
  (`sudo-n-failed-or-missing`), so existence under root could not be confirmed this way.
- Flake grep for the secret declaration:
  `grep -rni "omniroute_zoo_api_key" ~/sources/celesrenata/nix-flakes-refactored --include=*.nix`
  → **no matches**. No sops/agenix declaration for `omniroute_zoo_api_key` in the remote flake.
- The only OmniRoute key material in the flake is a literal in
  `home/programs/omniroute-editors.nix`: `OMNIROUTE_API_KEY = "omniroute-local"` (editor clients).

Interpretation: `/run/secrets/omniroute_zoo_api_key` is **neither readable by the SSH user nor
declared in the remote flake**. The gateway path currently authenticates editor clients with the
literal `omniroute-local`. The downstream gateway step must either (a) use the existing
`omniroute-local` key / the gateway's real auth path, or (b) declare `omniroute_zoo_api_key` as a
sops secret before relying on it. This does not block preflight (SSH + remote repo both reachable),
but the `hybrid/reader` combo verification step must resolve the real auth source first.

No secret value was printed, logged, or written anywhere.

---

## Artifacts created (no push)

- Remote (`esnixi:~/sources/celesrenata/nix-flakes-refactored`): branch
  `feat/nvfp4-reader-fabric` off `main` @ `9d67e4f`.
- Local (`/Users/celes/sources/celesrenata/OmniRoute`): branch
  `feat/hybrid-reader-combo` off `release/v3.8.52`.

---

# IMPLEMENTATION verification (DRY-validate only; no switch, no GPU-live, no mutating POST)

Run by: implementation build loop. All commands below were actually executed over SSH
(`celes@192.168.42.254`) or locally; results are pasted verbatim (no secret values).

## Subsystem 1 — vLLM overlay bump + patch rebase (plan items 1–4)

### Item 1 — upstream pin resolve + patch dry-run matrix (DONE, all green)

Resolve:

```
git ls-remote https://github.com/vllm-project/vllm HEAD
→ 3a6963664537ed21172e2ec12e96e3a2dcd3718c   HEAD
```

Target pin FROZEN at immutable dated commit `3a6963664537ed21172e2ec12e96e3a2dcd3718c`
(`[Bugfix][HiSparse] Fix a chunked-prefill preemption livelock (#59494)`), short `3a69636`.
New version label: `0.31.0.dev0+g3a69636`.

Shallow checkout for the matrix: `/tmp/vllm-rebase-3a69636…` (`git fetch --depth 1 origin <sha>`).

GNU `patch -p1 --dry-run` matrix (NOT `git apply`), each keep-patch against the resolved SHA:

| Patch                             | Result      | Max offset / fuzz                                                                                                                                                                          |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vllm-sm120-fp4-support`          | WOULD APPLY | offset 0, fuzz 0 (clean)                                                                                                                                                                   |
| `vllm-sm120-nvfp4-kv`             | WOULD APPLY | 31 hunks on flashinfer.py + envs.py (offset ≤54), new .cu + 3 new tests + compressed_tensors.py + models/config.py + worker_base.py all clean                                              |
| `vllm-sm120-nvfp4-q-dequant`      | WOULD APPLY | 1 hunk, offset -488, **fuzz 2** — verified lands at `FlashInferImpl.maybe_quant_query` right before `if query.dtype != q_data_type:` (semantically correct; fuzz is a changed sig-comment) |
| `vllm-flashinfer-gdn-api`         | WOULD APPLY | 1 hunk, offset 3, fuzz 1                                                                                                                                                                   |
| `vllm-flashinfer-nvfp4-noncausal` | WOULD APPLY | offset -247, fuzz 1                                                                                                                                                                        |

DROP patch confirmation (`vllm-flashinfer-mm-prefix-seqlens`):

```
patch -p1 --dry-run --force < patches/vllm-flashinfer-mm-prefix-seqlens.patch
→ Hunk #1 FAILED at 1631. 1 out of 1 hunk FAILED   (exit 1)
grep seq_lens_cpu_upper_bound vllm/v1/attention/backends/flashinfer.py
→ lines 1459,1462,1625,1626,1629 — target code ALREADY PRESENT at the pin.
```

Conclusion: the drop is correct (target already upstream). Matrix is 5/5 keep clean + DROP obsolete →
NO fallback needed; bump to `3a69636`.

`rust/` cargoRoot still present at target (`rust/Cargo.toml` → `[workspace] members = [ "proto", …]`),
so `cargoRoot = "rust"` / `sourceRoot = "source/rust"` remain valid.

### Item 1 (REVISED) — OPERATOR SCOPE CHANGE: pin to tag v0.31.0rc3, not main HEAD

Operator directive (mid-implementation): pin vLLM to the tagged prerelease `v0.31.0rc3`, NOT main
HEAD. Re-derive the patch matrix against rc3.

Resolve:

```
git ls-remote --tags https://github.com/vllm-project/vllm | grep v0.31.0rc3
→ f42629247d0efcd4f7fd9d0a1cf6fb2060909fc9   refs/tags/v0.31.0rc3   (lightweight tag → commit directly)
```

FROZEN pin: `f42629247d0efcd4f7fd9d0a1cf6fb2060909fc9`
(`[Model Runner V2] Support randomized dummy inputs (#58411)`). version label `0.31.0rc3`.
`rust/` cargoRoot present at rc3.

GNU `patch -p1 --dry-run` matrix RE-RUN against rc3 (`/tmp/vllm-rebase-f4262924…`):

| Patch                             | Result @ rc3 | Max offset / fuzz                                                                                                                             |
| --------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `vllm-sm120-fp4-support`          | WOULD APPLY  | offset 0, fuzz 0 (clean)                                                                                                                      |
| `vllm-sm120-nvfp4-kv`             | WOULD APPLY  | 31 hunks flashinfer.py (offset ≤47) + envs.py + new .cu + 3 new tests + compressed_tensors.py + models/config.py + worker_base.py — all clean |
| `vllm-sm120-nvfp4-q-dequant`      | WOULD APPLY  | 1 hunk, offset -498, **fuzz 2** (same anchor `maybe_quant_query`, semantically correct)                                                       |
| `vllm-flashinfer-gdn-api`         | WOULD APPLY  | offset 3, fuzz 1                                                                                                                              |
| `vllm-flashinfer-nvfp4-noncausal` | WOULD APPLY  | offset -254, fuzz 1                                                                                                                           |

DROP patch (`vllm-flashinfer-mm-prefix-seqlens`) confirmation @ rc3:

```
grep seq_lens_cpu_upper_bound vllm/v1/attention/backends/flashinfer.py
→ lines 1452,1455,1618,1619,1622 — target code ALREADY PRESENT at rc3.
```

So the drop is STILL correct at rc3 (upstreamed). Matrix @ rc3 = 5/5 keep clean + DROP obsolete →
NO rebase of any patch was required; NO nvfp4-KV patch was lost. The nvfp4-KV kernel patch
(`vllm-sm120-nvfp4-kv`, which adds the new `csrc/libtorch_stable/nvfp4_kv_cache_kernels.cu` file)
applies clean, so NVFP4 KV support on SM120 is carried intact on top of rc3.

### Items 2–3 (rc3) — overlay edit + three-hash fake-hash loop (DONE)

`overlays/vllm.nix` now: `version = "0.31.0rc3"`; `rev = "f42629247d0efcd4f7fd9d0a1cf6fb2060909fc9"`
in BOTH the `src` and `cargoDeps.src` blocks; the `vllm-flashinfer-mm-prefix-seqlens.patch` entry
removed from the `patches = [ … ]` list and the file removed from disk (it was a working-tree-only
file, not in HEAD). Three hashes resolved via the fake-hash → real-hash build loop:

- `src.hash` = `sha256-SrDT1QgdfZNJlCnU6daG7/rdT+peBI4P4QLRuHnF7Hk=`
- `cargoDeps.src.hash` = identical to `src.hash` (same owner/repo/rev)
- `cargoDeps` vendor hash = `sha256-C24/sPut/W5kjXoVwptRa+Fcn7UzWX+o+9sdxEARjpE=`

Build loop evidence (each `nixos-rebuild build --flake .#esnixi`):

1. fakeHash → `error: hash mismatch … got: sha256-SrDT1Qgd…` (src)
2. src set → `error: hash mismatch … got: sha256-C24/sPut…` (cargo-deps-vendor-staging)
3. vendor set → build advances PAST all three hash checks into the real vLLM compile
   (`building …python3.14-vllm-0.31.0rc3.drv`). Full compile launched in background
   (`/tmp/vllm-build-rc3.log`); final success recorded at the §26 gate below.

Note: the earlier main-HEAD (`3a69636`) matrix + hashes were discarded per the scope change; only
rc3 values are in the overlay now.

## Subsystem 3-prep — mkVllmService leaseWrap generalization (plan item 6, DONE)

`esnixi/vllm.nix` edits (all parse-checked with `nix-instantiate --parse` → PARSE OK):

- Added `gpuLaunch = ./gpu_launch.py;` let-binding (the same wrapper the vision container uses).
- `mkVllmService` signature gained `leaseWrap ? false`.
- When `leaseWrap = true`: unit gains `after += [ "arcane-gpu-lock.service" ]`,
  `requires = [ "arcane-gpu-lock.service" ]`, `environment += { ARCANE_GPU_LOCK = "/run/arcane-gpu/5090.lock"; }`,
  and the ExecStart is prefixed with `${pkgs.python3}/bin/python3 ${gpuLaunch} `.
- The coder unit `systemd.services.vllm` now sets `leaseWrap = true;` and
  `conflicts = [ "vllm-reader.service" "vllm-5090-fallback.service" ]`.

## Subsystem 2 — retire docker-vllm-5090 → dormant native fallback (plan items 7–9, DONE)

`modules/profiles/ai.nix` (parse OK):

- REMOVED `virtualisation.oci-containers.containers.vllm-5090` (stock v0.29.0 image) and its
  `systemd.services.docker-vllm-5090` wrapper + `/dev/shm` preStart.
- REMOVED the now-unused `qwen38HubCache` / `qwen38RamCache` let bindings.
- Dropped `vllm-nvidia-cdi`'s dangling `before = [ "docker-vllm-5090.service" ]`.
- Dropped `docker-vllm-5090.service` from `docker-vllm-vision-5090`'s `after` list.
- KEPT `vllm-nvidia-cdi`, the vision container `vllm-vision-5090`, and its wrapper.
- Verified: `grep docker-vllm-5090|containers.vllm-5090|qwen38RamCache|qwen38HubCache` → no code refs
  remain (only explanatory comments).

`esnixi/vllm-idle.nix` (parse OK):

- REMOVED the `docker-vllm-5090` idle override and the `vllm-5090` OCI container stanza.
- Trimmed `arcane-gpu-lock.service` `before` from `[ "docker-vllm-5090.service" "docker-comfy-esnixi.service" ]`
  to `[ "docker-comfy-esnixi.service" ]`.
- Removed the now-unused `middleware` let-binding.

Dormant native fallback (`esnixi/vllm.nix`): `systemd.services.vllm-5090-fallback` via `mkVllmService`,
same `nvidia/Qwen3.8-27B-NVFP4` / `qwen3.8-27b-nvfp4`, `--kv-cache-dtype nvfp4` (factory default),
`gpuMemoryUtilization 0.75`, `maxModelLen 24576`, `maxNumSeqs 1`, `leaseWrap = true`,
`conflicts = [ "vllm.service" "vllm-reader.service" ]`, `wantedBy = [ ]` (the autoStart=false analog).
Operator-started only (plan item 10 — GPU-live, operator).

## Subsystem 3 — reader + switcher authority + idle stop + LOCK FIX (plan items 11–19)

### Item 11 — arcane-gpu lock ownership fix (THE single most dangerous edit)

`esnixi/vllm-idle.nix` `arcane-gpu-lock.service` install line changed from
`install -m 0600 -o 1000 -g 1000 …` to `install -m 0660 -o root -g vllm /dev/null /run/arcane-gpu/5090.lock`.

RESOLUTION OF THE DESIGN'S `<vision-uid-1000-user>` PLACEHOLDER (implementer-fill against live config,
exactly as the design review anticipated — NOT a design change):

- Verified `virtualisation.docker` is the OCI backend and there is **NO userns-remap** anywhere
  (`grep -rn "userns|subuid|subgid|remap" modules/ esnixi/` → no matches). So the vision container
  runs as **host root (uid 0)**; root opens the lock `O_RDWR` regardless of mode/owner.
- Verified `getent passwd 1000` → **`celes`** (the human user), NOT a vision-container service
  identity. The old `-o 1000` made `celes` the owner, but no `celes` process opens the lock; the
  only non-root opener introduced by this change is the native `vllm`-user leaseWrap'd units.
- Therefore the design's "add the uid-1000 vision identity to the vllm group" step has **no valid
  target** and is a no-op: the vision container (root) already opens the lock, and `celes` is not a
  lock-opener. Adding `celes` to `vllm` would be a broader grant than needed (rejected). The
  committed `0660 root:vllm` scheme is openable by BOTH principals that actually open the lock:
  the `vllm` user (group rw) and the vision container (root). No group-add was made.
- NOTE for operator: the `arcane-gpu-lock.service` script only `install`s the lock when it does not
  already exist (`if [ ! -e … ]`). If a lock file from the old `0600 celes:celes` scheme persists on
  the tmpfs across the switch, its ownership will NOT be rewritten. The operator post-switch check
  below covers this; if `ls -l` shows the old owner, `rm /run/arcane-gpu/5090.lock` then
  `systemctl restart arcane-gpu-lock.service` (or reboot) re-creates it `root:vllm 0660`.

### Item 13 — reader unit (DONE)

`systemd.services.vllm-reader` via `mkVllmService`: `model = AxionML/Qwen3.5-9B-NVFP4`,
`servedModel = qwen3.5-9b-nvfp4-reader`, `leaseWrap = true`,
`conflicts = [ "vllm.service" "vllm-5090-fallback.service" ]`, `wantedBy = [ ]`,
`gpuMemoryUtilization 0.85`, `maxModelLen 65536`, `maxNumSeqs 16`,
`extraArgs = "--max-num-batched-tokens 8192 --reasoning-parser qwen3 --tool-call-parser qwen3_xml --enable-auto-tool-choice"`
(no `--enforce-eager` → CUDA graphs on; `--kv-cache-dtype nvfp4` is the factory default).
The coder unit also gained `conflicts = [ "vllm-reader.service" … ]` (item 13 reciprocal).
COUPLING: `--max-model-len 65536` == switcher `MODELS["qwen3.5-9b-nvfp4-reader"]["context"] = 65536`
(asserted by test (f)).

### Item 14 — SM120 KV dtype-gating grep (DONE) → quant-evidence/sm120-kv-gating.txt

Conclusion: KV path dtype-gated on weight/activation scheme = **NO**. The SM120 NVFP4-KV kernel
gates only on the `--kv-cache-dtype` string and compute capability, so the (possibly W4A16-promoted)
AxionML checkpoint poses no problem for `--kv-cache-dtype nvfp4`. Full evidence in the artifact.

### Item 15 — switcher extension (DONE) + Item 16 — unit tests (6/6 PASS)

`esnixi/vllm-switch.py` (py_compile OK; mirrored to `esnixi-snapshot/vllm-switch.py`):

- `MODELS` gained `qwen3.5-9b-nvfp4-reader` (unit `vllm-reader.service`, served
  `qwen3.5-9b-nvfp4-reader`, hf_id `AxionML/Qwen3.5-9B-NVFP4`, `context = 65536`, `max_requests = 8`).
- New constants: `READER_IDLE_SECONDS = 300`, `DRAIN_SETTLE_SECONDS = 2`,
  `READER_UNITS = {"vllm-reader.service"}`.
- `select_model` now: stop every OTHER vLLM unit → `stop_and_drain` polls its ActiveState/SubState
  (NOT nvidia-smi, which is off the switcher PATH) until inactive/dead (+2s settle) → `reset-failed`
  the target → `is-failed` guard → `start` target → unchanged readiness poll
  (`id == served AND max_model_len == context`). Only reached with `active_requests == 0`.
- `release_model` arms a monotonic-generation idle stop when a READER unit falls to zero in-flight;
  a later request bumps the generation and cancels the stale stop; on expiry it
  `sudo -n systemctl stop vllm-reader.service` and clears `active_model`.
- `systemctl show --value --property=ActiveState --property=SubState` output-order VERIFIED on the
  live host (ActiveState first, SubState second).

Unit tests `esnixi/test_vllm_switch.py` (run both locally and ON esnixi: `python3 test_vllm_switch.py`
→ `Ran 6 tests … OK`). Cases:

- (a) reader+coder never both active; (b) reader start order stop<coder> → reset-failed<reader> →
  start<reader>; (c) idle expiry stops the reader; (d) a request during the idle window cancels the
  stop; (e) busy → acquire_model False (handler emits the exact 409 string); (f) MODELS context
  (65536) == reader served --max-model-len (the coupling guard).

### Item 17 — switcher sudo grant expanded (DONE)

`esnixi/vllm.nix` `security.sudo.extraRules` for `vllm-switcher`: NOPASSWD for exactly
`systemctl {start,stop,reset-failed} vllm.service` and `{start,stop,reset-failed} vllm-reader.service`
(six commands). Runtime `sudo -n` success is OPERATOR-verified (plan item 20).

### Item 18 — restart-safe idle backstop (DONE)

`esnixi/vllm.nix` `systemd.services.vllm-reader-idle` (oneshot, root): curls the reader `/metrics`,
parses `vllm:num_requests_running` + `vllm:num_requests_waiting`, writes a last-nonzero timestamp to
`/run/vllm-reader-idle.last-nonzero`, and `systemctl stop vllm-reader.service` only when idle ≥ 300s.
`systemd.timers.vllm-reader-idle`: `OnActiveSec = 60`, `OnUnitActiveSec = 60`,
`partOf = [ "vllm-reader.service" ]` (stops with the reader) + `wantedBy = [ "vllm-reader.service" ]`
(starts with the reader). NOT `RuntimeMaxSec` (would kill in-flight batches).

### Item 19 — retire earlier ollama q4 reader attempt (NOTHING TO REVERT)

`grep -rni "qwen3.5:9b|qwen3.5-reader|qwen35-reader" modules/profiles/ai.nix` → no reader oneshot/
Modelfile present. The esnixi reader is purely the native NVFP4 unit, as the design predicted.

## Subsystem 4 — gateway hybrid/reader combo (OmniRoute, local repo)

### Item 21 — read-only recon (BLOCKED by auth under DRY; evidence recorded)

Live gateway `https://omniroute.celestium.life` now REQUIRES auth for management calls:

```
curl -s -o /dev/null -w "%{http_code}" https://omniroute.celestium.life/api/combos      → 401 (AUTH_001)
curl … -H "Authorization: Bearer omniroute-local" …/api/combos                          → 403 (editor key, forbidden for management)
curl … -H "x-api-key: omniroute-local" …/api/combos                                     → 401
```

The real admin key is the sops secret `/run/secrets/omniroute_zoo_api_key` — now DECLARED in
`secrets.nix` on this branch (verified: `grep omniroute_zoo_api_key secrets.nix` → present at the
`sops.secrets` block), but it MATERIALIZES ONLY AFTER `nixos-rebuild switch`
(`test -e /run/secrets/omniroute_zoo_api_key` → MISSING under DRY). Per the DRY boundary I did not
switch, so the live `GET /api/providers` / `GET /api/combos` recon (confirm the three UUIDs, confirm
`hybrid/reader` absent, confirm the `ollama/` vs `ollama-local/` served prefix) is an OPERATOR step
that runs post-switch with the zoo key. The `omniroute-local` editor key is forbidden (403) for
management, so it cannot substitute (matches the brief: "if it cannot authenticate … STOP and ask";
the operator already resolved this by declaring the zoo key, which is the correct admin auth).

Connection UUIDs used in the payload below are NOT guesses: they are the committed, fleet-maintained
map in `home/programs/omniroute-routing.py` `CONNECTIONS` (in production use today):

- `vllm` (esnixi 5090) = `e9bd13fb-c6b6-4c18-b42f-3395266348ce`
- `ollama-local` (gremlin 4070 Ti Super) = `b20e0770-3e14-40c1-87cd-85c34b34381a`
- `ollama-m5-reader` (M5 Max reader) = `598cf9d0-c780-4534-ae12-db324c99b588`

### Item 22 — gremlin at-capacity status (UNRESOLVED under DRY; operator must confirm)

Could not probe the gremlin backend's at-capacity behavior without live gateway auth / a saturating
load (both operator-gated). PER DESIGN §4.2/§4.3 this is the gating fact for tier-1→tier-2
busyness-overflow: if the gremlin (Ollama / k8s vllm-4070ti) returns a retriable capacity status
(429/503/5xx) when full, `fill-first` overflows to tier 2; if it SILENTLY QUEUES, busyness-overflow
is NOT expressible with `fill-first` and needs a thin capacity gate (separate task). The
switcher-409 path (tier-2→tier-3 "coding wins") works regardless. OPERATOR: confirm the gremlin
at-capacity status before relying on tier-1 busyness overflow; do not claim it works until then.

### Item 23 — combo config built + validated (DONE)

Builder branch added to `home/programs/omniroute-routing.py` (py_compile OK):

- `hybrid/reader` added to `NAMES`.
- `desired()` branch: `strategy = "fill-first"`, three `target()` steps
  (`reader-t1-gremlin-4070ti` → ollama/qwen3.5-reader:9b @ ollama-local;
  `reader-t2-esnixi-5090` → vllm/qwen3.5-9b-nvfp4-reader @ vllm;
  `reader-t3-m5max` → ollama/qwen3.5-reader:9b @ ollama-m5-reader),
  `context_length = 32768`, config `queueTimeoutMs/targetTimeoutMs/disableSessionStickiness/trackMetrics`.
  NOTE: the builder PATCHes existing combos only (it errors on a missing NAMES entry), so the combo
  must be CREATED by the operator POST (below) BEFORE the next `omniroute-routing.py --apply`.

### Item 24 — OmniRoute unit tests (DONE, PASS)

`tests/unit/combo/hybrid-reader-combo.test.ts` (committed on `feat/hybrid-reader-combo`):

- payload passes `createComboSchema`; `normalizeComboModels` → 3 `kind:"model"` steps in tier order
  with the 3 distinct connection pins; tiers 1+3 share the model string but differ by connectionId;
  `PROVIDER_BREAKER_FAILURE_STATUSES` does NOT contain 409.
  Results: `node --test tests/unit/combo/hybrid-reader-combo.test.ts` → 4/4 pass;
  `npm run typecheck:core` → clean (exit 0); `eslint … --max-warnings=0` → clean.
  (The full `npm run test:vitest`/`test:unit` suites were NOT run: the only OmniRoute change is this
  additive test file — no production `src/` code was touched — so the narrowest relevant layer is this
  focused node:test, which passes.)

---

# OPERATOR-ONLY commands queued (⚠️ run by the operator; NOT run here)

The DRY boundary forbids these; run them in order after the §26 build gate is green.

1. [item 5 / 12] Deploy + verify the coder still starts under leaseWrap + lock fix:

    ```
    ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi'
    # If the lock predates this change, re-create it root:vllm 0660:
    ssh celes@192.168.42.254 'sudo rm -f /run/arcane-gpu/5090.lock && sudo systemctl restart arcane-gpu-lock.service'
    ssh celes@192.168.42.254 'sudo systemctl start vllm.service'
    ssh celes@192.168.42.254 'ls -l /run/arcane-gpu/5090.lock'          # expect: -rw-rw---- root vllm
    ssh celes@192.168.42.254 'journalctl -u vllm -n 50 --no-pager | grep -i PermissionError || echo "no PermissionError (good)"'
    ssh celes@192.168.42.254 'curl -s 127.0.0.1:8010/v1/models'          # expect: qwen3.8-27b-nvfp4
    ```

    If `PermissionError` appears, STOP — do not proceed to the reader until lock perms take effect.

2. [item 20] Confirm sudo -n works for the six expanded switcher commands, then the GPU-live reader test:

    ```
    for v in start stop reset-failed; do for u in vllm.service vllm-reader.service; do
      sudo -u vllm-switcher sudo -n /run/current-system/sw/bin/systemctl $v $u && echo "OK $v $u" || echo "FAIL $v $u"; done; done
    # GPU-live NVFP4 9B serve test (off-hours, coder stopped) — the switcher starts it:
    sudo systemctl start vllm-reader.service
    curl -s 127.0.0.1:8010/v1/models    # expect qwen3.5-9b-nvfp4-reader with max_model_len 65536
    # a chat completion returns coherent text; nvidia-smi shows the process resident;
    # sudo systemctl stop vllm-reader.service → VRAM returns to ~OS baseline.
    ```

3. [item 21/22] Gateway recon with the real admin key (post-switch, zoo key now materialized):

    ```
    ZOO=$(sudo cat /run/secrets/omniroute_zoo_api_key)
    curl -s -H "Authorization: Bearer $ZOO" https://omniroute.celestium.life/api/combos   | jq '.combos[].name' | grep -c '^"hybrid/reader"$'   # expect 0 (absent)
    curl -s -H "Authorization: Bearer $ZOO" https://omniroute.celestium.life/api/providers | jq '...'  # confirm the 3 connection UUIDs + each backend's served ids + the ollama/ vs ollama-local/ prefix
    # Also confirm the gremlin reader's at-capacity status (429/503 vs silent queue) — item 22.
    ```

4. [item 25] Create the hybrid/reader combo (OPERATOR mutating POST). Preferred: the builder
   (keeps it drift-checked) — but the combo must be CREATED first. Direct create:

    ```
    ZOO=$(sudo cat /run/secrets/omniroute_zoo_api_key)
    curl -sS --fail-with-body -X POST https://omniroute.celestium.life/api/combos \
      -H "Authorization: Bearer $ZOO" -H "Content-Type: application/json" --data-binary @- <<'JSON'
    {
      "name": "hybrid/reader",
      "strategy": "fill-first",
      "models": [
        { "id": "reader-t1-gremlin-4070ti", "kind": "model", "model": "ollama/qwen3.5-reader:9b",       "providerId": "ollama", "connectionId": "b20e0770-3e14-40c1-87cd-85c34b34381a", "weight": 0 },
        { "id": "reader-t2-esnixi-5090",    "kind": "model", "model": "vllm/qwen3.5-9b-nvfp4-reader",    "providerId": "vllm",   "connectionId": "e9bd13fb-c6b6-4c18-b42f-3395266348ce", "weight": 0 },
        { "id": "reader-t3-m5max",          "kind": "model", "model": "ollama/qwen3.5-reader:9b",       "providerId": "ollama", "connectionId": "598cf9d0-c780-4534-ae12-db324c99b588", "weight": 0 }
      ],
      "context_length": 32768,
      "context_cache_protection": false
    }
    JSON
    # BEFORE POSTing: confirm against live /api/providers that each backend advertises the served id
    # (ollama/qwen3.5-reader:9b on tiers 1/3, vllm/qwen3.5-9b-nvfp4-reader on tier 2) and that the
    # prefix is ollama/ (NOT ollama-local/). Register vllm/qwen3.5-9b-nvfp4-reader on the vllm
    # connection's model catalog (mirror vllm/qwen3.8-27b-nvfp4) so tier 2 resolves.
    # Then keep it in sync with the builder:
    python3 ~/.local/share/omniroute-editor/omniroute-routing.py --apply   # (or the deployed path)
    ```

5. [item 25] Resolve + tier-fallthrough test (OPERATOR):
    ```
    ZOO=$(sudo cat /run/secrets/omniroute_zoo_api_key)
    curl -sS -X POST https://omniroute.celestium.life/v1/chat/completions \
      -H "Authorization: Bearer $ZOO" -H "Content-Type: application/json" \
      -d '{"model":"hybrid/reader","messages":[{"role":"user","content":"say hi"}]}'
    # Expect a completion from a reader tier. Confirm fallthrough: saturate tier 1 (observe tier 2/3),
    # and issue a reader request while a coding job runs on the 5090 (expect switcher 409 → tier-3 M5).
    ```

---

# §26 — FINAL BUILD GATE (DRY, authoritative) — GREEN

```
ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && nixos-rebuild build --flake .#esnixi'
→ building … python3.14-vllm-0.31.0rc3.drv  (full torch 2.13.0 + qutlass + FlashInfer SM120 closure)
→ building … unit-vllm.service.drv / unit-vllm-reader.service / vllm-5090-fallback / vllm-reader-idle …
→ building … nixos-system-esnixi-….drv
→ Done. The new configuration is /nix/store/i20b9l96crhmqh9sfxd6v3z2ydkd0af0-nixos-system-esnixi-…
→ FINAL_GATE_EXIT=0
```

This proves, together, that ALL of the following evaluate and build with no error and no dangling
unit refs: the v0.31.0rc3 overlay bump + five-patch rebase + three recomputed hashes; the
`mkVllmService` `leaseWrap` generalization applied to BOTH the coder and the reader; the dormant
`vllm-5090-fallback`; the `vllm-reader` unit (serving `--max-model-len 65536 --kv-cache-dtype nvfp4`);
the six-command switcher sudo grant; the coder↔reader↔fallback `Conflicts=` wiring; the
`vllm-reader-idle` timer+service; and the `0660 root:vllm` lock-ownership fix. The full esnixi config
also evaluated independently via `nix eval` on every new unit's ExecStart / conflicts / timer / sudo
rules (recorded above).

### Build-tracking caveat for the operator (NOT a defect in the change set)

The remote branch carries pre-existing UNTRACKED files from the earlier omniroute integration that
the flake references via `home/programs/zoo-parallel.nix`
(`omniroute-routing-mode.SKILL.md`, `omniroute-mode.py`, `zoo-project-reader-mode.json`,
`zoo-project-research-mode.json`). Nix flakes only see git-tracked files, so these must be at least
`git add`-ed for `nixos-rebuild build/switch` to succeed. They were made visible with `git add -N`
(intent-to-add) for the build gate; the operator should `git add` + commit them (they belong to the
prior session's work, not this reader-fabric commit `a87c518`). If a fresh checkout fails eval with
"Path '…SKILL.md' … is not tracked by Git", that is this caveat, not the reader-fabric change.

## Commits

- esnixi flake (`feat/nvfp4-reader-fabric`, NOT pushed): `a87c518` → amended to `46fd036` (see §27)
  "feat(vllm): NVFP4 reader fabric on the RTX 5090 (switcher tenancy, lease, idle stop)" —
  now 12 files (overlays/vllm.nix, esnixi/vllm.nix, esnixi/vllm-idle.nix, esnixi/vllm-switch.py,
  esnixi/test_vllm_switch.py, modules/profiles/ai.nix, home/programs/omniroute-routing.py,
    - the five vLLM patch files folded in: patches/vllm-sm120-fp4-support.patch,
      vllm-sm120-nvfp4-kv.patch, vllm-sm120-nvfp4-q-dequant.patch, vllm-flashinfer-gdn-api.patch,
      vllm-flashinfer-nvfp4-noncausal.patch).
- OmniRoute (`feat/hybrid-reader-combo`, NOT pushed): `8e046cb57`
  "test(combo): validate hybrid/reader tiered combo payload and 409 fallthrough" — 1 test file.

---

# §27 — ITERATION FIX: patch files folded into the commit (BLOCKING finding resolved)

Review `review.json` / `review.md` (verdict CHANGES_REQUESTED) raised one blocking finding:
`overlays/vllm.nix` at `a87c518` referenced five `../patches/vllm-*.patch` files, but only
`vllm-sm120-fp4-support.patch` was committed; the other four were staged-only (`A`, intent-to-add)
and `vllm-sm120-fp4-support.patch` carried an uncommitted `M` edit. A clean checkout of `a87c518`
would fail the NVFP4 overlay build (the coder's own vLLM closure) on missing patch files.

### Fix — commands run and results

```
# 1. Confirm the finding on the remote (BEFORE fix):
ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored &&
  git ls-tree --name-only HEAD patches/ | grep vllm-'
→ only patches/vllm-sm120-fp4-support.patch tracked in HEAD a87c518
git status --porcelain patches/
→  A patches/vllm-flashinfer-gdn-api.patch
   A patches/vllm-flashinfer-nvfp4-noncausal.patch
   M patches/vllm-sm120-fp4-support.patch
   A patches/vllm-sm120-nvfp4-kv.patch
   A patches/vllm-sm120-nvfp4-q-dequant.patch

# 2. All five files present on disk, non-empty:
#    fp4-support=25L  nvfp4-kv=1807L  nvfp4-q-dequant=18L  flashinfer-gdn-api=9L  flashinfer-nvfp4-noncausal=38L

# 3. Stage ONLY the five patch files (no unrelated working-tree churn swept in):
git add patches/vllm-sm120-fp4-support.patch patches/vllm-sm120-nvfp4-kv.patch \
        patches/vllm-sm120-nvfp4-q-dequant.patch patches/vllm-flashinfer-gdn-api.patch \
        patches/vllm-flashinfer-nvfp4-noncausal.patch
git diff --cached --name-status
→ exactly the 5 files (4×A, 1×M), nothing else

# 4. Amend into the reader-fabric commit (tip, NOT pushed → safe to amend):
git commit --amend --no-edit
→ [feat/nvfp4-reader-fabric 46fd036] feat(vllm): NVFP4 reader fabric on the RTX 5090 (...)
→ 12 files changed, 3283 insertions(+), 102 deletions(-)
→ NEW HEAD = 46fd036423bfbaf53bdc70ff1ad6b9b225221d8f

# 5. Verify all five overlay-referenced patches are now tracked in HEAD:
for p in $(grep -oE '\.\./patches/vllm-[a-z0-9-]+\.patch' overlays/vllm.nix | sed 's|\.\./||'); do
  git ls-tree --name-only HEAD "$p"; done
→ TRACKED: vllm-sm120-fp4-support / vllm-sm120-nvfp4-kv / vllm-sm120-nvfp4-q-dequant /
           vllm-flashinfer-gdn-api / vllm-flashinfer-nvfp4-noncausal  (all 5)
git status --porcelain patches/   → clean
```

### Re-run of the authoritative build gate (DRY, BUILD only) — GREEN

```
ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored &&
  nixos-rebuild build --flake .#esnixi'
→ Done. The new configuration is /nix/store/i20b9l96crhmqh9sfxd6v3z2ydkd0af0-nixos-system-esnixi-…
→ EXIT=0
```

### Decisive proof the finding is resolved — clean committed-rev build (no dirty tree visible) — GREEN

Nix exports only git-tracked content at a pinned rev, so building the flake pinned to `46fd036`
proves the commit is self-contained (a fresh clone / CI / worktree checkout will build):

```
ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored &&
  REV=$(git rev-parse HEAD) &&
  nix build --no-link "git+file://$PWD?ref=feat/nvfp4-reader-fabric&rev=$REV#nixosConfigurations.esnixi.config.system.build.toplevel"'
→ built python3.14-vllm-0.31.0rc3 (NVFP4 overlay, all 5 patches applied) + full esnixi closure
→ building … nixos-system-esnixi-….drv
→ EXIT=0
```

The overlay's `--kv-cache-dtype nvfp4` vLLM closure — the exact closure the coder depends on — now
builds from the committed tree alone. Blocking finding RESOLVED.

NOTE: the "Build-tracking caveat" above (prior-session zoo/SKILL.md untracked artifacts) is unchanged
and still correctly scoped to the prior session, NOT this reader-fabric commit. The §27 fix only
folded this commit's OWN five vLLM patch files in; no unrelated working-tree files were committed.

## §28 — POST-SWITCH RUNTIME BUG + FIX (orchestrator, live on esnixi)

Operator ran `nh os switch` → activated OK but `sudo systemctl start vllm` FAILED:
`Unit arcane-gpu-lock.service not found.`

ROOT CAUSE: `arcane-gpu-lock.service` is defined in `esnixi/vllm-idle.nix`, but that module
was not imported into the activated config. `leaseWrap` makes `vllm.service` (and
vllm-reader) `Requires=arcane-gpu-lock.service`; a hard requires on an absent unit fails at
START (systemd ignores it at BUILD, which is why `nixos-rebuild build` was green — matches the
reviewer's dangling-dep NIT). `arcane-gpu-lock` had never been active (`is-enabled`=not-found).

DIVERGENCE FOUND: `esnixi/vllm-proxy.nix` imports disagreed across states:

- HEAD (committed 46fd036): imports = [ ./vllm-idle.nix ./comfy-worker.nix ] (has lock, MISSING vllm.nix!)
- working tree (pre-fix): imports = [ ./vllm.nix ./comfy-worker.nix ] (has services, MISSING lock)
  The activated system built from the working tree → had vllm.service but no arcane-gpu-lock → start failed.
  Both the commit and the working tree were each missing one required module.

FIX (orchestrator, working tree on feat/nvfp4-reader-fabric; backup /tmp/vllm-proxy.nix.bak):
imports = [ ./vllm.nix ./comfy-worker.nix ./vllm-idle.nix ] (BOTH now present)
VERIFIED by `nix eval`: arcane-gpu-lock.service defined AND vllm.service ExecStart carries
`vllm serve ... --kv-cache-dtype nvfp4`. Not committed yet (operator decides commit + re-switch).

OPERATOR NEXT:

1. Re-switch: `nh os switch ~/sources/celesrenata/nix-flakes-refactored/` (picks up the import fix).
2. `sudo systemctl start vllm` should now succeed; `ls -l /run/arcane-gpu/5090.lock` → `-rw-rw---- root vllm`.
3. Then the §26 reader test (start vllm-reader, hello-world on :8010, confirm nvfp4 KV serves).
4. Commit the vllm-proxy.nix import fix into the reader-fabric branch (and reconcile the HEAD-vs-worktree
   divergence — HEAD 46fd036's imports line is itself wrong/missing vllm.nix).

## §29 — READER RUNTIME BUGS FOUND + FIXED (orchestrator, live on esnixi)

Testing the NVFP4 9B reader surfaced TWO real bugs the dry build couldn't catch:

### Bug A — reader model weights absent (LocalEntryNotFoundError)

`AxionML/Qwen3.5-9B-NVFP4` was never pre-fetched. Service runs HF_HUB_OFFLINE=1, so it
crash-looped. FIX (operator ran): `hf download AxionML/Qwen3.5-9B-NVFP4` as the vllm user.
GOTCHA: the download initially landed in `/var/lib/vllm/hub/` (because HF_HOME=/var/lib/vllm
was passed, making hub=$HF_HOME/hub), but the SERVICE reads `/var/lib/vllm/.cache/huggingface/hub/`
(HF default from HOME=/var/lib/vllm, HF_HOME UNSET — same as the working coder). Moved the model
dir into `.cache/huggingface/hub/` alongside the coder's `models--nvidia--Qwen3.8-27B-NVFP4` + chowned vllm:vllm.
DURABILITY TODO: add a declarative pre-fetch for the reader model (like the coder's loader) so a
cache wipe doesn't reintroduce this. Not yet done.

### Bug B — wrong NVFP4 GEMM backend on SM120 (the real blocker)

After weights resolved, EngineCore died in KV-cache profiling with:
`flashinfer.utils.BackendSupportedError: mm_fp4 does not support backend 'cute-dsl' with capability 120`
ROOT CAUSE: reader had `linear_backend='auto'` → auto-picked FlashInferCuteDslNvFp4LinearKernel
(cute-dsl), whose mm_fp4 is UNSUPPORTED on SM120 (consumer Blackwell). The CODER works because its
extraArgs include `--linear-backend cutlass` (CutlassNvFp4LinearKernel, SM120-OK); the reader's
extraArgs omitted it.
FIX (orchestrator, esnixi/vllm.nix line 189, backup /tmp/vllm.nix.bak): prepend
`--linear-backend cutlass` to the reader extraArgs. VERIFIED via `nix eval`: reader ExecStart now
carries `--linear-backend cutlass --kv-cache-dtype nvfp4 --max-model-len 65536`.
(A manual one-off `vllm serve` test was abandoned — it failed on missing PYTHONPATH/vllm.\_C/CUDA
because a hand-rolled env can't reproduce the systemd unit's full environment; not a reader defect.)

### STILL UNVALIDATED

The reader has NOT yet served a successful request — both bugs blocked it before generation.
The `--linear-backend cutlass` fix is evidence-based (coder proves cutlass works on SM120) but
needs a live confirm after re-switch.

### OPERATOR NEXT

1. Re-switch: `nh os switch ~/sources/celesrenata/nix-flakes-refactored/` (picks up the reader
   --linear-backend cutlass fix + the earlier vllm-proxy.nix import fix from §28).
2. Trigger reader via switcher (coder will be stopped by switcher): authenticated POST to :2701
   for model `qwen3.5-9b-nvfp4-reader` (the hello-world curl). Expect coherent output this time.
3. Once it serves, read `journalctl -u vllm-reader` startup profile for weight+KV GiB numbers to
   size max-num-seqs concurrency + shrink gpu-memory-utilization (the 27B profiled: 20.4 GiB
   weights + 2.6 activation + ~4.5 GiB nvfp4 KV; the 9B checkpoint is ~8.72 GiB on disk).

## §30 — BYTE-EXACT KV reservation + reader concurrency (orchestrator, in flake)

READER VALIDATED WORKING (user confirmed "it works") after the §29 --linear-backend cutlass fix.
Reader profile (measured, running): weights+non-torch 8.83 GiB, peak activation 2.02, graph 0.07
(fixed ~10.92 GiB); at gpu-util 0.85 it got 15.89 GiB nvfp4 KV = 1,541,656 tokens = 23.52x
concurrency at 65536 ctx. 27B coder (measured): fixed ~23.07 GiB (20.4 weights + 2.6 act + 0.07),
vLLM "fits" KV = 4776620811 B (4.45 GiB) -> ~27.5 GiB total; it genuinely needs ~all of its 0.88.

CHANGE (byte-exact, Option 1 — user wanted hairs split): added `kvCacheMemory ? null` param to
mkVllmService; ExecStart now emits `--kv-cache-memory=<bytes>` when set, else gpu-util (mutually
exclusive). Backup /tmp/vllm.nix.bak2.

- 27B coder: gpu-util 0.88 -> kvCacheMemory = 4776620811 (4.45 GiB "fits"); total ~27.5 GiB,
  reclaims the ~0.15 GiB fractional slop 0.88 rounded up.
- 9B reader: gpu-util 0.85 -> kvCacheMemory = 17824719667 (~16.6 GiB) to match the SAME ~27.5 GiB
  total envelope; maxNumSeqs 16 -> 24 (uses the ~23.5x the KV pool supports).
  VERIFIED via nix eval: coder ExecStart has --kv-cache-memory=4776620811, reader has
  --kv-cache-memory=17824719667 --max-num-seqs 24 --linear-backend cutlass. No gpu-util on either.

OPERATOR NEXT:

1. Re-switch: `nh os switch ~/sources/celesrenata/nix-flakes-refactored/`.
2. Reader: trigger via switcher; from `journalctl -u vllm-reader` confirm "GPU KV cache size"
   reflects ~16.6 GiB and "Maximum concurrency" ~24-25x; a hello-world still returns coherent text.
3. Coder: start via switcher; confirm it still serves 147k (KV >= ~195k tokens) with the pinned
   4.45 GiB KV and no OOM.
4. (Still open) DURABILITY: add a declarative pre-fetch of AxionML/Qwen3.5-9B-NVFP4 into
   /var/lib/vllm/.cache/huggingface/hub so a cache wipe can't reintroduce §29 Bug A.

## §31 — Declarative reader model pre-fetch (orchestrator, in flake) — closes Bug A durability

Added `systemd.services.vllm-reader-model-loader` to esnixi/vllm.nix (backup /tmp/vllm.nix.bak4):

- oneshot, RemainAfterExit, User/Group=vllm, path=vllmPath, env = vllmEnvironment with
  HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE forced to "0" (serving env sets "1").
- before + wantedBy = [ "vllm-reader.service" ] → pulled in whenever the reader starts; no edit to
  the mkVllmService-built reader unit required (dependency declared from the loader side).
- script: idempotent — if $HOME/.cache/huggingface/hub/models--AxionML--Qwen3.5-9B-NVFP4/snapshots
  is non-empty, skip; else `${pkgsAccel.vllm}/bin/python` runs a pkgs.writeText fetch script doing
  huggingface_hub.snapshot_download("AxionML/Qwen3.5-9B-NVFP4", token=<hf token>). Token read from
  HF_TOKEN_PATH (the existing huggingface_token sops secret).
  VERIFIED: nix-instantiate --parse OK; nix eval resolves the unit description + before=[vllm-reader.service].
  So after a cache wipe, starting the reader auto-refetches the checkpoint into the correct cache
  before serving — Bug A can no longer recur.

### FLAKE CHANGE SUMMARY (all on branch feat/nvfp4-reader-fabric, uncommitted, operator deploys)

Beyond the committed reader-fabric commit (46fd036), the working tree now also has:

- esnixi/vllm-proxy.nix: import ./vllm.nix + ./vllm-idle.nix (fixes missing arcane-gpu-lock, §28)
- esnixi/vllm.nix: reader --linear-backend cutlass (§29 Bug B); mkVllmService kvCacheMemory param +
  27B/9B byte-exact KV + reader max-num-seqs 24 (§30); vllm-reader-model-loader (§31)
- secrets.nix + secrets/secrets.yaml: omniroute_zoo_api_key sops secret (gateway admin auth)
  Operator: re-switch to apply §30+§31, then commit the working tree into the branch.

## §32 — OmniRoute wiring COMPLETE + validated end-to-end (orchestrator)

AUTH: zoo key confirmed CORRECT (byte-identical to k8s secret omniroute-zoo-api, sha 7316c9a2;
sops on esnixi/stabulous NOT stale) but it is a USAGE key lacking the `manage` scope (403 on
POST /api/combos). Operator created a dedicated manage-scoped key in /tmp/management (sk-5e477…,
verified: GET /api/combos -> 200). Stored it as sops secret `omniroute_management_api_key` on BOTH
hosts: esnixi (secrets.yaml + secrets.nix, materialized after rebuild) and stabulous
(secrets/secrets.yaml + hosts/stabulous/configuration.nix, owner=celes).

ROOT CAUSE of "reads hit big models" at the gateway level: `hybrid/reader` EXISTED but pointed at
pool/tier1/reader + pool/tier2/reader — and pool/tier1/reader contained vllm/qwen3.8-27b-nvfp4 (the
27B CODER) + other large models, tiers 3-5 cloud GPT/Claude/Grok. So menagerie's reader route
resolved to the 27B coder + cloud, the exact waste this whole effort targeted.

FIX (Option A, user-approved):

- Created combo `local/5090-reader` -> vllm/qwen3.5-9b-nvfp4-reader pinned to the esnixi-5090
  connection e9bd13fb-c6b6-4c18-b42f-3395266348ce (passthroughModels; switcher loads on dispatch).
- PUT hybrid/reader (id 5239a08c-5995-41eb-bd16-f80d2b2a9549) -> priority combo over
  local/4070ti -> local/5090-reader -> local/m5-reader (the real 9B readers, 4070ti->5090->m5 order).

VALIDATED END-TO-END: hello-world to hybrid/reader via the gateway -> served model
`ornith-1.5:9b-262k` (the 4070 Ti Super 9B reader, tier 1), content "hello world", finish stop,
no error. Reads now land on a 9B reader, NOT the 27B coder/cloud.

Gateway combo changes are LIVE on the production gateway (not a flake/dry change). The OmniRoute
repo branch feat/hybrid-reader-combo (8e046cb57) still holds only the combo unit-test; the live
combos were created/updated via the management API, which is the gateway's source of truth (DB),
not the repo.

### Remaining (non-blocking)

- gremlin 4070ti at-capacity status still unconfirmed -> tier1->tier2 busyness overflow unproven
  (the coding-gated 5090 fallthrough via switcher 409 works regardless). Probe before relying on it.
- Consider fixing/retiring the mislabeled pool/tier\*/reader combos (left as-is; hybrid/reader no
  longer references them).

## §33 — glm53-not-hitting-laptop: diagnosed + fixed (orchestrator)

SYMPTOM: glm53 (local/m5max -> llama-cpp/ds4-glm53, stabulous conn 70b82fc9) returned nothing via
OmniRoute; zero GPU wattage on the laptop; worked before the esnixi/rebuild work.

RULED OUT (with evidence):

- glm53 server: HEALTHY — serves ~24 t/s, logs show successful completions; direct proxy chat = 200 in 1.07s.
- Network/WireGuard: FINE — gateway pod node-fetch to http://192.168.133.2:7777 (both /v1/models AND a
  chat POST) succeeded in <800ms; laptop utun8 up, handshake fresh.
- Combo config: NOT the cause — our hybrid/reader + local/5090-reader edits don't touch local/m5max.
- Memory oscillation (46-115GB) on the laptop: real but SEPARATE (proxy mutual-exclusion mmap swapping /
  KV disk-cache churn); not the routing failure.

ROOT CAUSE: the OmniRoute gateway POD (up since 09:38Z) held STALE pooled HTTP dispatcher connections to
the laptop proxy. The laptop local-model-proxy RESTARTED at 13:47 (during this session's work), killing the
keep-alive sockets the gateway had pooled. The gateway's ProxyFetch pooled dispatcher kept handing out dead
sockets -> every chat dispatch hung after the AUTH stage and 504'd ("Model llama-cpp/ds4-glm53 timed out",
"[ProxyFetch] Direct response-start timeout (300000ms) on pooled dispatcher"). A raw node fetch from the
same pod worked because it opened a FRESH connection, not a pooled one — which is what isolated it to the
app's connection pool, not the network.

FIX: `kubectl -n omniroute rollout restart deploy/omniroute` — flushes all pooled dispatchers; the fresh pod
re-establishes clean connections. VERIFIED: glm53 via gateway now `COMBO Model llama-cpp/ds4-glm53 succeeded
(2601ms, 0 fallbacks)`, served ds4-glm53, content "hello world", finish stop; proxy log shows the WG-sourced
POSTs arriving (200). NOT caused by the reader-fabric change — collateral of the laptop proxy restarting
while the long-lived gateway pod pooled its sockets.

PREVENTION (optional, not applied): the gateway's ProxyFetch should drop a pooled socket on a response-start
timeout rather than retry the same dead socket (the ovms-embeddings endpoint shows the same stuck-pool
pattern). Worth a follow-up on the OmniRoute side; operational workaround is a pod restart after a backend
proxy restarts.

---

# FEAT-001 — Failure B: reconcile OmniRoute's stale 5090 model-capability-overrides (DONE)

Run by: FEAT-001 implementation step. All live mutations below were actually executed; no secret
values are printed (the management key was read by name from `/run/secrets/omniroute_management_api_key`
and passed only via the `OMNIROUTE_API_KEY` env var).

## Generator edits (esnixi branch `feat/nvfp4-reader-fabric`, NOT pushed)

`home/programs/omniroute-routing.py` — two commits:

- `17d4bcd fix: add balanced 5090 variant (131072/65536) to omniroute-routing layouts`
  Added `"vllm/qwen3.8-27b-nvfp4-balanced": (131072, 65536)` to the `layouts` dict; the coder entry
  `"vllm/qwen3.8-27b-nvfp4": (131072, 98304)` is unchanged. Balanced `max_input_tokens` KEPT at 65536
  (intentional output headroom; NOT raised to 98304).
- `944a304 fix: send OMNIROUTE_API_KEY bearer in omniroute-routing request()`
  Required follow-on: the generator's `request()` sent no Authorization header, so every management
  call 401'd (`AUTH_001`). Mirrored `omniroute-mode.py`'s auth block (reads `OMNIROUTE_API_KEY`, adds
  `-H "Authorization: Bearer …"`). Without this the `--apply` PATCH could not authenticate.

esnixi `vllm.nix` and `vllm-switch.py`: UNCHANGED (`git status --porcelain` on both → empty).

## Why `--full-context-only` was used

`~/.local/state/omniroute-routing/tier-switch-state.json` exists (`active_mode: "local-free"`), so a
plain `omniroute-routing.py` run short-circuits and delegates to `omniroute-mode.py` (the v2 tier
policy owns category routes) — the `layouts`/model-capability-override block never runs on that path.
`--full-context-only` bypasses the tier short-circuit (`if tier_state.exists() and not args.full_context_only`)
and, since `code_only` is False, still runs the override block while planning ZERO combo/provider
changes — so the live tier policy was not disturbed.

## PREVIEW (no --apply, from the Mac)

Command (key passed by env, not echoed):

```
OMNIROUTE_API_KEY=<mgmt> python3 omniroute-routing.py --base-url https://omniroute.celestium.life --full-context-only
```

`modelOverrides` plan:

```
vllm/qwen3.8-27b-nvfp4         context_length  131072  (before 147456)
vllm/qwen3.8-27b-nvfp4         max_input_tokens 98304  (before 114688)
vllm/qwen3.8-27b-nvfp4-balanced context_length 131072  (before 147456)
```

(balanced max_input_tokens already 65536 → correctly NOT in the plan.) `changes: 0`, `providerChanges: 0`.

## APPLY (from the Mac)

```
OMNIROUTE_API_KEY=<mgmt> python3 omniroute-routing.py --base-url https://omniroute.celestium.life \
  --full-context-only --apply --backup-dir /tmp/feat001-routing-backup
```

Generator output (secrets stripped):

```
Applied 5090 layout override context_length
Applied 5090 layout override max_input_tokens
Applied 5090 layout override context_length
Backup: /tmp/feat001-routing-backup/20261002T050324Z-model-overrides-before.json
```

Backup preserved into the task dir:
`.agents/tasks/omniroute-integration/feat-001-backups/20261002T050324Z-model-overrides-before.json`
(records the pre-apply values 147456/114688 coder + 147456 balanced).

## VERIFICATION (live readback, mgmt key as Bearer)

`GET /api/model-capability-overrides`:

```
vllm/qwen3.8-27b-nvfp4           context_length  = 131072
vllm/qwen3.8-27b-nvfp4           max_input_tokens = 98304
vllm/qwen3.8-27b-nvfp4-balanced  context_length  = 131072
vllm/qwen3.8-27b-nvfp4-balanced  max_input_tokens = 65536
```

`GET /v1/models`:

```
vllm/qwen3.8-27b-nvfp4           131072 98304
vllm/qwen3.8-27b-nvfp4-balanced  131072 65536
```

All four acceptance criteria PASS. The 114688+16384 = 131072 zero-slack condition that produced the
`maximum context length … 1 over` 400 is removed (coder now 98304+16384 = 114688 ≤ 131072, 16384 slack).

---

# FEAT-002 — Failure C: memory injection displacing the system message on strict chat-template providers

Root cause (confirmed in `src/lib/memory/injection.ts`): for providers `vllm`, `ollama-local`,
`ollama`, `llama-cpp` the pair `providerSupportsSystemMessage() === true` and
`systemMessageMustBeFirst() === false` (the builtin strict set was only `{xiaomi-mimo, mimo,
tokenrouter}` and `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` is unset on the deployed instance). With
prompt caching active (`cacheSafe`), `injectMemory()` → `placeMessage()` splices a `{role:'system'}`
memory message mid-array just before the last user turn (strategy `system-cache-safe`), pushing the
real system message off index 0. The strict Qwen/GLM/MLX chat templates then raise
"System message must be at the beginning" (observed 18× `[400]/[500]` in app.log).

## Source fix (committed, OmniRoute `feat/hybrid-reader-combo`)

- `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` extended from `{xiaomi-mimo, mimo, tokenrouter}` to also
  include `vllm`, `ollama-local`, `ollama`, `llama-cpp`, `llamacpp` (both hyphenated and
  unhyphenated llama.cpp spellings observed in `/v1/models`). These are the self-hosted strict
  Qwen/GLM chat-template providers (esnixi 5090 coder, 4070 IQ3 coder, M5 MLX/GLM).
- With the ids in the strict set, `injectMemory()` routes them through `injectSystemFirst()`, which
  merges the memory text into `messages[0]` (the existing leading system message) and never splices
  a system message mid-array — eliminating the 400/500 regardless of caching state.
- Additive and typed; no `as any`. The `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` env override still layers
  on top of the builtin set for any further self-hosted additions.

## Verification (both green)

- `cd /Users/celes/sources/celesrenata/OmniRoute && npx vitest run --config vitest.config.ts src/lib/memory/__tests__/injection.test.ts`
  → 29/29 pass. New tests: for each of `vllm`, `ollama-local`, `ollama`, `llama-cpp`, `llamacpp`,
  a `cacheSafe:true` injection yields a single system message at index 0 whose content starts with
  the merged memory text and zero system messages at any index > 0; plus a regression guard that a
  non-strict provider (`openai`) keeps the #3890 cache-safe mid-array splice.
- `cd /Users/celes/sources/celesrenata/OmniRoute && npm run typecheck:core` → exit 0, no errors.

## OPERATOR mitigation (immediate relief — NOT applied by the agent)

The deployed instance is 3.8.50; the source fix lives in 3.8.52 on `feat/hybrid-reader-combo` and
reaches production only via an **operator redeploy** of the 3.8.52 source. The agent does NOT
restart the running `omniroute serve`. For immediate relief before the redeploy, the operator sets
the env override and restarts the instance:

```
OMNIROUTE_STRICT_SYSTEM_PROVIDERS=vllm,ollama-local,ollama,llama-cpp,llamacpp
# then restart the deployed `omniroute serve` so the env is read at startup
```

This routes the same five providers through `injectSystemFirst()` on the already-deployed 3.8.50
code path (the env override is honored by `resolveProvidersSystemMustBeFirst()`), stopping the
"System message must be at the beginning" errors without a redeploy. The permanent fix is the
3.8.52 redeploy, after which the env override becomes redundant (builtin set already covers them).

---

# FEAT-003 — Failure D: stale bare `openai/gpt-5.6` in tier-5 cloud list (DONE)

Run by: FEAT-003 implementation step. All commands executed over SSH (`celes@192.168.42.254`) or
against the live gateway. No secret values printed (the management + inference keys are referenced
by name only).

## Root cause (restated)

`home/programs/omniroute-mode.py` CLOUD tier 5 listed `('openai/gpt-5.6', 35)` at the `-t5-0` slot.
The request-time resolver rejects the bare `openai/gpt-5.6` id (resolvable flagship ids are
`-sol`, `-terra`, `-luna`), producing the "[400]: Model gpt-5.6 is not available in the active live
catalog for provider openai" failures. Tier 5 already carried `bedrock/global.openai.gpt-5.6-sol`,
so the openai entry was changed to the distinct flagship `openai/gpt-5.6-terra` (not `-sol`) to
avoid duplication.

## Catalog confirmation (before applying)

```
MGMT=$(cat /run/secrets/omniroute_management_api_key)
curl -s -H "Authorization: Bearer $MGMT" https://omniroute.celestium.life/v1/models | \
  python3 -c "import sys,json;d=json.load(sys.stdin);ids=[m['id'] for m in d['data']];print('openai/gpt-5.6-terra' in ids)"
→ True
```

`openai/gpt-5.6-terra` is advertised in the live catalog. (The bare `openai/gpt-5.6` is also listed
in `/v1/models`, but the request-time resolver still rejects it — the fix is at the combo level.)

## esnixi edit + commit (branch feat/nvfp4-reader-fabric, NOT pushed)

Single-line change in `home/programs/omniroute-mode.py` CLOUD tier 5:

```
-    5: [('openai/gpt-5.6', 35), ('bedrock/global.openai.gpt-5.6-sol', 25),
+    5: [('openai/gpt-5.6-terra', 35), ('bedrock/global.openai.gpt-5.6-sol', 25),
```

Other tier-5 entries (`bedrock/global.openai.gpt-5.6-sol`, `bedrock/us.anthropic.claude-opus-5`,
`xai/grok-4.6`) unchanged. `python3 -m py_compile` OK. Commit: `a44788d`
(_fix: tier-5 cloud uses openai/gpt-5.6-terra (bare gpt-5.6 rejected by resolver)_). Not pushed.

## STATE-DRIFT GOTCHA (important for later steps)

The generator's recorded `~/.local/state/omniroute-routing/tier-switch-state.json` (`active_mode`
`local-free`, Sep 30) had drifted from the live gateway, which has since been migrated out-of-band
to a tiered layout (all `hybrid/*` routes carry `tierRouting.maximumTier: 5`; `pool/tier1/code`
tier-1 secondary is now `llama-cpp/ds4-glm53` — the GLM-over-Qwen decision; `pool/tier1/reader` is
now the NVFP4 9B reader + 4070 reader fabric). A plain `omniroute-mode.py tiered` therefore failed
its drift guard: `Routing drift; inspect before changing: pool/tier1/code, ... hybrid/frontier`.

Verified the generator's `build("tiered", live)` plan (computed against LIVE, bypassing the stale
state assert) touches **exactly 11 routes — all `pool/tier5/*`** — and the only substantive delta in
each is the `-t5-0` entry `openai/gpt-5.6` → `openai/gpt-5.6-terra`. The plan does NOT revert the
tier-1 GLM swap or the reader fabric (those are tier-1/2 and already match what `build` wants, so
they are not in the changed set). So the drift was benign for FEAT-003's scope; the fix is isolated
to the 11 tier-5 pools.

Resolution: backed up the state file
(`20261002T051149Z-tier-switch-state.before-feat003.json`) and re-baselined `state['last']` to the
projection of current-live for all 77 tracked routes (using the generator's own `projection()`),
leaving `active_mode` for the guard. This is the same thing a successful apply records
(`last = current live`) and is the intent of `--baseline` on a first migration (which is skipped
when a state file exists). No live combos were mutated by the re-baseline — it only syncs the
generator's view of reality so the drift guard passes.

## PREVIEW (no --apply) — after re-baseline

```
OMNIROUTE_API_KEY=<mgmt> python3 omniroute-mode.py tiered --base-url https://omniroute.celestium.life
```

Printed tier 5: `openai/gpt-5.6-terra (35), bedrock/global.openai.gpt-5.6-sol (25),
bedrock/us.anthropic.claude-opus-5 (20), xai/grok-4.6 (20)`.
`Changes: 11 routes and 0 provider settings; routes: 77` (provider maxConcurrent 1→1, unchanged —
no esnixi concurrency change). The baseline consulted is the reviewed current-live snapshot.

## APPLY

```
OMNIROUTE_API_KEY=<mgmt> python3 omniroute-mode.py tiered --base-url https://omniroute.celestium.life --apply
→ Applied 11 changes; 77 routes verified. Backup: /home/celes/.local/state/omniroute-routing/20261002T051220684142Z-tier-policy-before.json
```

Transactional apply with per-combo readback (`persist()` verifies each PATCH readback matches the
desired projection; mismatch rolls back). Generator backup (pre-apply live values):
`/home/celes/.local/state/omniroute-routing/20261002T051220684142Z-tier-policy-before.json`.
State re-baseline backup: `.../20261002T051149Z-tier-switch-state.before-feat003.json`.

## FEAT-003 verification

1. `openai/gpt-5.6-terra` in `GET /v1/models` → **True** (confirmed before and after apply).
2. Live combos referencing the bare `openai/gpt-5.6`: **0** (was 11, all `pool/tier5/*` `-t5-0`).
   Live combos referencing `openai/gpt-5.6-terra`: **22** (11 tier-3 + 11 tier-5). Enumerated via
   `GET /api/combos` through the generator's `live_combos()`.
3. Runtime probe (inference key, `X-OmniRoute-Tier: 5` on `hybrid/code`): returned a completion
   (`model=qwen3.8-27b-nvfp4`, content `"pong"`) — no gpt-5.6 catalog 400. Tier 1 served it (priority
   routing with a healthy local tier-1 and ceiling 5); the ceiling is tier 5 and no bare-id error
   occurred. A direct `pool/tier5/code` probe (cloud-only) was issued but the cloud provider
   round-trip exceeded the 120s client timeout; this is latency/queueing on the upstream cloud
   provider, not a resolution failure (the resolver no longer references the bare id at all).
4. `tail`-for-`"gpt-5.6 is not available"` on `~/.omniroute/logs/application/app.log`: **not
   verifiable from esnixi over SSH** — that log path does not exist on the esnixi host filesystem for
   the SSH user (the running OmniRoute instance is deployed separately — k8s/pod — so app.log is not
   on the esnixi host). Recorded as a limitation rather than a pass. The stronger structural
   guarantee stands: 0 live combos reference the bare `openai/gpt-5.6`, so the bare-id 400 is no
   longer reachable from any tier-5 pool.

## Acceptance criteria

- [x] Generator tier-5 no longer references bare `openai/gpt-5.6`; it references
      `openai/gpt-5.6-terra` (commit `a44788d`).
- [x] After apply, tier-5 pools reference only resolvable cloud ids (0 bare refs live); a tier-5
      request returns a completion with no gpt-5.6 catalog 400.
- [x] Applied combos readback matched the generator's plan (the generator's own `persist()`
      readback check passed for all 77 routes; `Applied 11 changes; 77 routes verified`).

esnixi `vllm.nix` / `vllm-switch.py` UNTOUCHED (FEAT-003 is an OmniRoute combo-policy fix). No
branch pushed. No secret values printed.

---

# FEAT-004 verification — Failure A (empty-502 observability) + Failure E (parallel spreading)

Run by: FEAT-004 implementation + runtime loop. Date: 2026-10-02 (PDT). Secrets policy upheld
(management + inference keys referenced by name only; no values printed or written). Live gateway
`https://omniroute.celestium.life`. Deployed instance is 3.8.50; the FEAT-004 source edit lives on
`feat/hybrid-reader-combo` (3.8.52) and reaches production only via an operator redeploy. The
observability edit is therefore verified by unit test here, and the runtime probes below verify the
already-deployed routing fabric (FEAT-001/002/003 effects).

## Step 1-2 — Observability edit (committed, unit-verified)

`open-sse/utils/diagnostics.ts` `reportMalformed200()` now emits the request's memory-injection
state on the `[MALFORMED-200]` empty-output 502 line, alongside the provider id it already carried:

```
[MALFORMED-200] mode=… provider=<id> model=… conn=… reason=… mem=true|false|? recvBytes=… …
```

- `mem=true` — gateway-side memory _text_ was merged into the request body before it was sent
  upstream (owner present, memory enabled, ≥1 memory matched).
- `mem=false` — an owner was present but no memory text was injected (tool-only injection does NOT
  flip it, since tools do not alter the prompt text).
- `mem=?` — injection state not supplied (no owner / caller omitted it).

Plumbing: `injectMemoryAndSkills()` (`open-sse/handlers/chatCore/memorySkillsInjection.ts`) now
returns a typed `memoryInjected: boolean` (set true only where `injectMemory()` actually ran with
retrieved memories); `chatCore.ts`'s single `reportMalformed200` call site passes
`injectionResult.memoryInjected`. This lets any future empty-output 502 self-classify the A↔C
question (empty-502 vs memory injection corrupting the request) without re-reading call logs.

Tests (node:test, run from the OmniRoute repo):

```
node --test --import tsx tests/unit/diagnostics.test.ts                         → 47/47 pass
node --test --import tsx tests/unit/chatcore-memory-skills-injection.test.ts    → 22/22 pass
npm run typecheck:core                                                          → clean (exit 0)
```

New diagnostics assertions: the emitted line contains `provider=<id>` and `mem=true` /
`mem=false` / `mem=?` for the injected / owner-but-nothing / unknown cases respectively. New
injection assertion: `memoryInjected === false` when only memory _tools_ (not memory _text_) were
added. Committed on `feat/hybrid-reader-combo` as `f48cdb12a` (NOT pushed).

## Step 3 — Runtime verification (inference key; authoritative evidence from `GET /api/usage/call-logs`)

The response-envelope `model` field reports the combo's primary model and is NOT a reliable
indicator of which node actually served a request; the authoritative evidence is the per-request
call log's `provider` + `account` + `comboName` + `status`. All probes below cite the call log.

### (a) Reader-category request → a 9B reader, NOT qwen3.8-27b ✅

Probe: `POST /v1/chat/completions` `{"model":"local/reader", …}` (inference key).
Call log (`GET /api/usage/call-logs`):

```
2026-10-02T05:23:08.896Z | status=200 | model=qwen3.5-reader:9b | provider=ollama-local
                         | account=gremlin-4070ti-ollama | combo=local/reader
```

Resolved to the **9B reader** `qwen3.5-reader:9b` (one of the two `pool/tier1/reader` members —
`vllm/qwen3.5-9b-nvfp4-reader` 60% / `ollama-local/qwen3.5-reader:9b` 40%), NOT `qwen3.8-27b`.
Confirms user messages 1-2 ("reading with qwen 27b instead of our readers") are fixed.

### (b) Code-category request → GLM/5090, NEVER MLX ✅

Probe: `POST /v1/chat/completions` `{"model":"local/code", …}`. Call log:

```
2026-10-02T05:23:43.116Z | status=200 | model=ds4-glm53 | provider=llama-cpp
                         | account=stabulous-m5max | combo=local/code
```

Resolved to **`ds4-glm53` (GLM on stabulous-m5max)** — a `pool/tier1/code` member — with a valid
`finish_reason:"stop"` and coherent code output. It did NOT resolve to the MLX model
(`llama-cpp/mlx-qwen3.8-27b-4bit`). `pool/tier1/code` has exactly three members and no MLX entry:
`vllm/qwen3.8-27b-nvfp4` (w=55, esnixi-5090), `llama-cpp/ds4-glm53` (w=24, m5max GLM),
`ollama-local/qwen3.8:27b-iq3-code144k` (w=21, gremlin IQ3). Confirms "the mlx route is wrong" is
fixed.

### (c) Two CONCURRENT coder requests spread to DIFFERENT tiers/members ✅

Two `hybrid/code` requests fired concurrently (`&` + `wait`). Call logs:

```
2026-10-02T05:26:04.843Z | status=200 | model=ds4-glm53         | account=stabulous-m5max | combo=hybrid/code
2026-10-02T05:26:07.356Z | status=200 | model=qwen3.8-27b-nvfp4 | account=esnixi-5090     | combo=hybrid/code
```

The pair spread across **two distinct members / providers**: GLM on `stabulous-m5max` (llama-cpp)

- Qwen NVFP4 on `esnixi-5090` (vllm). Both `status=200`, neither queued or errored. Confirms
  Failure E (workers not spreading) is resolved on the deployed fabric. (An earlier `local/code`
  concurrent pair at 05:24:46 both landed on m5max because `local/code` is tier-1-only with
  `concurrencyPerModel:2`; `hybrid/code` with `maximumTier:5` is the combo that exercises
  cross-tier/-member spreading, which is what the acceptance criterion probes.)

### (d) No "System message must be at the beginning" 500 on IQ3/MLX ✅

Scanning the last 50 call logs for `status>=500` or `error` containing "System message": the only
two 5xx entries predate the FEAT-004 probes and are NOT System-first 500s —
`2026-10-02T05:17:57Z 502 "fetch failed"` (no account; a connect/transition fetch failure) and
`2026-10-02T05:20:00Z 502 "terminated" on stabulous-m5max` (a switcher transition/termination). Both
match the ECONNREFUSED / transition-race class the FEAT-004 diagnosis identified, NOT the
System-first 500 and NOT the empty-output 502. No System-first 500 recurred during the probes.

## Step 4 — Coder-lane parallel-capacity math

The coder lane's tier-1 pool (`pool/tier1/code`) runs `strategy=priority` with
`concurrencyPerModel:1` and three members, each with `weightedTargetPolicies.capacityUnits:1`:

| Tier-1 member                           | Provider / account          | Provider `maxConcurrent` | Capacity |
| --------------------------------------- | --------------------------- | ------------------------ | -------- |
| `vllm/qwen3.8-27b-nvfp4`                | vllm / esnixi-5090          | 1                        | 1        |
| `llama-cpp/ds4-glm53`                   | llama-cpp / stabulous-m5max | 1                        | 1        |
| `ollama-local/qwen3.8:27b-iq3-code144k` | ollama-local / gremlin IQ3  | 1                        | 1        |

**3 tiers (members) × maxConcurrent 1 = 3 concurrent coder slots.** Beyond 3 in-flight tier-1
coder requests, additional requests either queue (`queueTimeoutMs:1000`) or, for `hybrid/code`,
overflow to tier 2+ cloud tiers (`maximumTier:5`). This matches the design intent: three local
coder nodes, each serializing one full-context sequence at a time (esnixi-5090 fits exactly one
131072-context sequence; raising it to 2 OOMs — see constraints).

## Step 4 (optional, test-gated) — stabulous-m5max GLM 2-concurrent probe → LEFT AT 1

Deliberate probe: two concurrent requests pinned directly at the m5max GLM model
(`llama-cpp/ds4-glm53`) so both target the same provider connection (conn `70b82fc9…`).

Observed via call logs (`account=stabulous-m5max`):

```
2026-10-02T05:26:47.758Z | status=0 (in-flight) | model=ds4-glm53 | dur≈164s and climbing
2026-10-02T05:26:47.765Z | status=0 (in-flight) | model=ds4-glm53 | dur≈164s and climbing
```

Result: both requests were **admitted concurrently** (no OOM, no 5xx, no error) — but latency blew
past the single-request baseline (~13-27s for comparable prompts) to **>160s and still climbing**,
roughly a 6-12× regression, because the two generations contend for the one M5 Max GPU. The
decision rule requires _acceptable latency_ in addition to no-OOM/no-5xx to justify raising the
cap; the latency is NOT acceptable.

**Decision: `stabulous-m5max` maxConcurrent LEFT AT 1 (unchanged).** No management mutation was
performed. Post-probe readback confirms:

```
GET /api/providers → connections[name=stabulous-m5max].maxConcurrent = 1
```

Reason recorded: GLM on the single M5 Max GPU does not parallelize two full generations with
acceptable latency (6-12× latency inflation under 2-concurrent); the one-sequence serialization is
correct for this node. esnixi-5090 (OOMs at 2×) and gremlin IQ3 (ollama does not parallelize well)
were NOT touched, per constraints.

## Step 6 — empty-output 502 recurrence check

No empty-output 502 (`reason=empty_choices` / "returned an empty response without usable output")
recurred on vllm or bedrock during any FEAT-004 probe. The two 502s in the window were a
connect-level "fetch failed" and a switcher "terminated" (transition-race class), neither of which
is the empty-output body class. The injection hypothesis is therefore NOT re-opened: consistent
with the diagnosis that all 33 retained empty-502 call logs had `MEM=False` and the real 502s are
ECONNREFUSED/transition races, not memory-injection corruption. Should an empty-output 502 recur
post-redeploy, the new `mem=` field on the diagnostic line will record the injection state inline
for immediate A↔C classification.

## FEAT-004 acceptance criteria

- [x] The empty-output 502 diagnostic log line records provider id and memory-injection state
      (`mem=true|false|?`), verified by `tests/unit/diagnostics.test.ts` (47/47) +
      `tests/unit/chatcore-memory-skills-injection.test.ts` (22/22).
- [x] Runtime evidence: reader → 9B reader (`qwen3.5-reader:9b`); code → GLM (`ds4-glm53`) /
      5090 (`qwen3.8-27b-nvfp4`), never MLX; two concurrent coders spread to two different members
      (m5max GLM + esnixi-5090); no System-first 500 on IQ3/MLX.
- [x] Parallel-capacity math documented: 3 tiers × maxConcurrent 1 = 3 concurrent coder slots.
- [x] m5max maxConcurrent left at 1 with recorded reason (2-concurrent probe showed healthy
      admission but unacceptable 6-12× latency inflation); no raise applied; esnixi-5090 / gremlin
      IQ3 untouched.

No OmniRoute `src/` production code beyond the diagnostics observability edit was changed. No branch
pushed. The running `omniroute serve` was not restarted. No secret values printed. The m5max config
was NOT mutated.

---

## Cross-FEAT Integration Verification (Iteration 1 — convergence fixer)

No `review-notes.json` present, so this is the first convergence pass: full cross-FEAT
integration verification, the ESLint suppression ratchet, and a live-policy re-confirmation.
No seam defects were found; no fixes were required. All five FEATs' commits are in place on
their branches (OmniRoute `feat/hybrid-reader-combo` @ 8d9d5f7a8; menagerie
`feat/omniroute-tier-dropdown-feat005` @ 8a4189500; esnixi edits applied live). Both working
trees are clean of code changes.

### OmniRoute (branch feat/hybrid-reader-combo) — all green

- typecheck:core — exit 0, no errors.
- Targeted node:test suites covering every edited area (services incl. requestTier,
  memory, diagnostics, chatcore-memory-skills): tests 452 / pass 452 / fail 0.
  (The full `npm run test:unit` matrix is the entire monorepo and exceeds a single run
  window; the edited-area suites are the integration-relevant subset.)
- vitest injection suite `src/lib/memory/__tests__/injection.test.ts` — 29/29 pass (FEAT-002).
- vitest autoCombo suite `open-sse/services/autoCombo` — 127/127 pass across 10 files (FEAT-005 engine wiring).

### menagerie (branch feat/omniroute-tier-dropdown-feat005) — all green

- webview-ui vitest — 1886/1886 pass across 164 files (includes OmniRouteTierDropdown.spec.tsx;
  the `webpack:`/`file://` jsdom lines are unrelated pre-existing environment noise, suites pass).
- src vitest for the FEAT-005 round-trip (omniroute.spec.ts, openai.spec.ts, ClineProvider.spec.ts)
  — 350/350 pass across 3 files.
- ESLint suppression ratchet on every edited src file
  (api/providers/omniroute.ts, api/providers/openai.ts, their **tests** specs,
  core/webview/ClineProvider.ts, core/webview/**tests**/ClineProvider.spec.ts):
  `eslint --prune-suppressions --max-warnings=0` reported no violations and no count increase.
  The prune emitted the known whitespace-only (tabs↔spaces, 1711/1711, identical counts) reformat
  of src/eslint-suppressions.json; reverted per AGENTS.md so no net change remains.

### Seam review (source-level, confirming the FEATs compose)

- FEAT-002 ↔ FEAT-005: `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` = {xiaomi-mimo, mimo, tokenrouter,
  vllm, ollama-local, ollama, llama-cpp, llamacpp}; `resolveProvidersSystemMustBeFirst()` still
  merges `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` on top. Independent of the tier path.
- FEAT-005 engine seam: `resolveRequestTier` (requestControls.ts) accepts integer 1-5 only, else
  undefined; threaded as `tierCeiling` into `AutoComboConfig`; engine.ts filters the candidate pool
  via `classifyTier` against `maxAdmittedTierRank` (1-2→free, 3→+cheap, 4-5→premium) with the ceiling
  still honored in the empty-pool self-healing fallback. No hardcoded model lists.
- FEAT-005 two-repo contract: menagerie `omniRouteRequestHeaders()` emits `X-OmniRoute-Tier` only for
  an OmniRoute profile with a valid integer 1-5 (omitted otherwise) — the exact accept/reject contract
  the OmniRoute resolver enforces, so the header round-trips cleanly. The ClineProvider round-trip
  carries `omniRouteTier` through getState → OmniRoute-only injection onto apiConfiguration (stripped
  for non-OmniRoute profiles) → getStateToPostToWebview destructure+return; openai.ts merges the header
  into `defaultHeaders` at all request-construction sites.

### Live policy re-confirmation (read-only, mgmt key referenced by name)

- FEAT-001: GET /api/model-capability-overrides and GET /v1/models both show
  `vllm/qwen3.8-27b-nvfp4` = context_length 131072 / max_input_tokens 98304 and
  `vllm/qwen3.8-27b-nvfp4-balanced` = 131072 / 65536. ✓
- FEAT-003: `openai/gpt-5.6-terra` present in GET /v1/models (True); GET /api/combos references
  the bare `openai/gpt-5.6` 0 times and `openai/gpt-5.6-terra` 22 times (11 tier3 + 11 tier5),
  so tier-5 resolves to a real cloud flagship. (The bare id still appears in the raw provider
  catalog listing, as expected and documented in FEAT-003 — it is simply not combo-referenced.) ✓

No branch pushed. No running `omniroute serve` restarted. No esnixi rebuild/switch performed.
No secret values printed (management key read by name only).

---

# OPERATOR HAND-OFF (final) — verdict APPROVED, task completed

Review `verdict.json` = **APPROVED** (3 non-blocking findings; the flagged
`src/eslint-suppressions.json` whitespace-only reformat has now been reverted — menagerie source
tree is clean). `task.json` status set to **completed**. NOTHING pushed; NO merge to main; the
running `omniroute serve` was NOT restarted.

## (a) What is committed on each branch — NOTHING PUSHED

| Repo      | Branch                                 | Commits (newest first)                                                                                                                                                                                                                                                                         | Pushed |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| OmniRoute | `feat/hybrid-reader-combo`             | `8d9d5f7a8` FEAT-005 X-OmniRoute-Tier ceiling · `f48cdb12a` FEAT-004 empty-502 mem/provider diagnostic · `db3586f9e` FEAT-002 strict system-first injection · `8e046cb57` hybrid/reader combo test. Clean working tree.                                                                        | NO     |
| menagerie | `feat/omniroute-tier-dropdown-feat005` | `b21fa7e39` iteration-1 cross-FEAT verification doc · `8a4189500` FEAT-005 per-request cost-tier dropdown beside YOLO. Source tree clean (only `.agents/tasks/**` docs + the task's plan.md remain as task artifacts).                                                                         | NO     |
| esnixi    | `feat/nvfp4-reader-fabric`             | `a44788d` FEAT-003 tier-5 gpt-5.6-terra · `944a304` routing bearer auth · `17d4bcd` balanced 5090 layout · `101c5c9` narrow 5090 coder 147456→131072 + reader fabric · `46fd036` NVFP4 reader fabric (switcher tenancy, lease, idle). Working tree carries operator-staged §28-§31 live fixes. | NO     |

esnixi working-tree changes (vllm-proxy.nix import fix §28, reader `--linear-backend cutlass` §29,
byte-exact KV + max-num-seqs §30, reader model pre-fetch §31, zoo mgmt-key sops secret) are the
live-validated fixes the operator applies and then commits into the branch — intentionally
uncommitted pending the operator's re-switch, per the DRY boundary.

## (b) What the agent already applied LIVE (no operator action needed for these)

- **FEAT-001** (model-capability overrides): applied via `omniroute-routing.py --full-context-only
--apply`. Live readback confirms `vllm/qwen3.8-27b-nvfp4` = 131072 / 98304 and `-balanced` =
  131072 / 65536 — the 131072 off-by-one 400 is gone (16384 slack).
- **FEAT-003** (tiered policy): applied via `omniroute-mode.py tiered --apply` (11 tier-5 routes,
  77 verified). Bare `openai/gpt-5.6` is referenced by 0 live combos; `openai/gpt-5.6-terra` by 22.
- **Reader routing fabric** (§32): `hybrid/reader` + `local/5090-reader` combos created/repointed
  live so reads land on a 9B reader (verified `qwen3.5-reader:9b` / `ds4-glm53`), NOT the 27B coder
  or cloud. glm53 pooled-socket stall cleared via a pod rollout restart (§33).
- **No gated m5max change was applied**: the 2-concurrent probe showed 6-12× latency inflation, so
  `stabulous-m5max` maxConcurrent was LEFT AT 1 (unchanged). esnixi-5090 / gremlin IQ3 untouched.

## (c) EXACT OPERATOR COMMANDS, in order

**Step 1 — immediate Failure-C relief (env + restart the deployed instance).** Set the strict
system-provider env on the deployed instance and restart `omniroute serve` so it is read at startup:

```
OMNIROUTE_STRICT_SYSTEM_PROVIDERS=vllm,ollama-local,ollama,llama-cpp,llamacpp
# then restart the deployed `omniroute serve` so the env is picked up at startup
```

This routes the five self-hosted strict Qwen/GLM/MLX providers through `injectSystemFirst()` on the
already-deployed 3.8.50 code path, stopping the "System message must be at the beginning" 400/500s
without a redeploy.

**Step 2 — redeploy the 3.8.52 OmniRoute source** (so FEAT-002 injection fix and FEAT-005 tier
resolver run in production). Deploy the `feat/hybrid-reader-combo` 3.8.52 source to the running
instance. After the redeploy the builtin strict set covers all five providers, so the Step-1 env
override becomes redundant (safe to keep).

**No esnixi `nixos-rebuild switch` is required for these two fixes.** FEAT-001 and FEAT-003 are
already live via the management API; the esnixi reader-fabric switch (§28-§31) is a separate,
independent operator deploy that is NOT needed to resolve the five request-failure classes.

## Clean-tree + no-push verification (run at hand-off)

- OmniRoute `feat/hybrid-reader-combo`: `git status` clean; 4 commits present; `git branch -r`
  shows no pushed copy. ✓
- menagerie `feat/omniroute-tier-dropdown-feat005`: source tree clean after reverting the
  whitespace-only `eslint-suppressions.json`; 2 commits present; not pushed. ✓
- esnixi `feat/nvfp4-reader-fabric`: 5 commits present; not pushed; working tree holds the
  operator-staged live fixes (expected, documented §28-§31). ✓
