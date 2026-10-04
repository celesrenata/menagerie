# Reader fabric + NVFP4-KV — technical design

Status: DESIGN — **iteration 4** (surgical pass after the iteration-3 review
`reader-fabric-design-review.json`, verdict `CHANGES_REQUESTED`: 1 HIGH, 1 MEDIUM, 1 NIT). Those
three findings are resolved below (lock-file ownership scheme in §3.3 step 5; reader
`context`==`--max-model-len` coupling in §3.3 step 1 / §3.4 / §3.9; `arcane-gpu-lock` `before` cleanup
in §2.3); the iteration-2→3 ledger is retained in §8 and the iteration-3→4 ledger is appended. All
other iteration-3 content is unchanged. Authoritative inputs: `reader-fabric-spec.md` (confirmed
decisions — NOT re-decided here) and `reader-fabric-verification.md` (preflight facts). This document
SEQUENCES and DE-RISKS the spec.

> **Citation policy (resolves finding #5).** Earlier iterations cited line numbers from the _live_
> remote files, which drifted from the committed `esnixi-snapshot/` copies. This iteration cites by
> **symbol name** for Python/Nix, and gives a snapshot line only where it was re-verified against the
> committed file in `esnixi-snapshot/`. All switcher/flake facts below were re-checked against the
> committed snapshot during this revision.

> **What changed vs iteration 2 (summary of the three HIGH fixes).**
>
> 1. **Gateway overflow was built on a false premise (finding #1).** `fill-first` does NOT gate on
>    per-connection `maxConcurrent` — that cap is wired only into `quota-share`
>    (`applyStrategyOrdering.ts`, the `strategy === "quota-share"` branch calling
>    `resolveMaxConcurrentByConnection`) and the round-robin semaphore (`roundRobinCombo.ts`
>    via `makeConnectionConcurrencyResolver`). The `fill-first` branch only logs
>    "preserving priority order" and advances **on target error**. §4 is rewritten: tier overflow is
>    **error-driven**, and tier 1 (gremlin) must return a _retriable capacity status_ when busy for
>    the combo to fall through. The `maxConcurrent` rows are kept only as documentation of intended
>    load, not as the overflow mechanism.
> 2. **The new switcher stop-and-drain had two runtime gaps on the primary coder host (finding #2).**
>    (a) `select_model`'s `systemctl is-failed` guard would refuse to restart a unit left in a failed
>    sub-state after a deliberate stop — so a `reset-failed` is now part of the stop path and the
>    sudo grant. (b) The drain-wait no longer shells to `nvidia-smi` (not on the hardened switcher
>    unit's PATH); it polls the _other_ unit's `ActiveState`/`SubState` via the `systemctl show` the
>    switcher already runs, plus a bounded settle delay.
> 3. **The idle-timer section was internally contradictory (finding #3).** It is replaced by ONE
>    backstop with correct semantics: a `vllm-reader-idle.timer`/`.service` pair polling vLLM's
>    `num_requests_running` metric with a stated interval + idle window, `PartOf` the reader unit.
>    `RuntimeMaxSec` is dropped as the idle primitive (it is a hard wall-clock cap that would kill an
>    in-flight batch), with an explicit note on why.

> **Hard operating rule for every step below:** config-only + DRY-validate. The implementation
> step may run `nixos-rebuild build --flake .#esnixi` (NEVER `switch`), `patch --dry-run`, Nix hash
> prefetches, GitHub-raw / remote-patch greps, and _read-only_ OmniRoute REST GETs. **Every
> `switch`, every `systemctl start`/`stop`, every GPU-live model load, every `sudo -n` confirmation,
> and every combo POST/PUT that mutates the live gateway is performed by the operator.** The
> ⚠️ OPERATOR markers below enumerate exactly which.

---

## 0. Overview

Four coupled changes land the NVFP4 reader fabric:

1. **vLLM overlay bump** (`overlays/vllm.nix`): `0.31.0.dev0+gddd6fbca` (rev `ddd6fbca`, 2026-09-26)
   → a fixed, dated upstream-main commit, pulling in upstream NVFP4 work. Six SM120/NVFP4 patches
   rebase; the **predicted** outcome is one drop + five clean re-applies, but this is a _prediction_
   to be turned into a result by the §1.2 `patch --dry-run` matrix at implementation time against a
   concrete resolved SHA (finding #8). Three hashes change (src, cargoDeps-from-src, cargoDeps
   vendor), computed by the fake-hash loop. If a clean rebase is NOT achievable → smallest green
   bump, else no bump (§1.1).
2. **Dormant `docker-vllm-5090` container** (`modules/profiles/ai.nix`): `fp8_e4m3` → `nvfp4` KV AND
   off stock `vllm/vllm-openai:v0.29.0` onto the patched native build. Chosen approach: **retire the
   OCI fallback and make it a dormant native systemd unit reusing `pkgsAccel.vllm`** (§2),
   `autoStart=false` preserved as `wantedBy = []`.
3. **New NVFP4 9B reader vLLM service** on esnixi (`esnixi/vllm.nix`): NVFP4 weights
   (`AxionML/Qwen3.5-9B-NVFP4`, ModelOpt `modelopt_fp4`) + `--kv-cache-dtype nvfp4`, patched vLLM,
   generous batching. Runs **under the arcane-gpu lease via `gpu_launch.py`** and is **mutually
   exclusive with the coder, enforced by the switcher as the single tenancy authority**. It **fully
   stops on idle** via a restart-safe systemd idle timer so the 27B coder reclaims the GPU.
4. **Gateway `hybrid/reader` tiered combo** (OmniRoute runtime DB): tier 1 = gremlin 4070 Ti Super,
   tier 2 = esnixi 5090 (only when t1 is at capacity AND the 5090 is not coding), tier 3 = M5 Max.
   Overflow is **error-driven** `fill-first` (§4) — NOT concurrency-cap-gated.

The M5 Max flake side is left AS-IS (spec decision #6). No gateway change forces an M5 tweak.

**Locked technology stack** (do not substitute downstream): NixOS flake on esnixi; the existing
`overlays/vllm.nix` build (torch 2.13.0 source build, CUDA 13.3, FlashInfer 0.6.18, qutlass
`e74319e3`, `TORCH_CUDA_ARCH_LIST=12.0`); the `mkVllmService` factory in `esnixi/vllm.nix`; the
`gpu_launch.py`/`arcane_gpu.py`/`vllm_idle.py` lease mechanics; the Python `vllm-switch.py`
serializing HTTP gateway on `127.0.0.1:8011` (fronted by nginx `:2701`); OmniRoute combos via REST
`/api/combos` with `strategy = "fill-first"`, applied through the existing
`home/programs/omniroute-routing.py` builder against `https://omniroute.celestium.life`.

> **Strategy-count note (finding #9):** OmniRoute's authoritative strategy list is
> `ROUTING_STRATEGY_VALUES` in `src/shared/constants/routingStrategies.ts` (the services-dir
> `AGENTS.md` prose count of "17" is non-authoritative). This design relies only on `fill-first`,
> which is present in the enum. No strategy count is asserted elsewhere.

---

## 1. vLLM overlay bump + six-patch rebase

### 1.1 Target revision selection

The current pin `ddd6fbca…` is 2026-09-26. **A clean rebase to a recent dated upstream-main HEAD is
expected to be achievable** (see §1.2), so the design targets a fixed, dated upstream-main commit and
pulls in whatever upstream NVFP4 work landed in that window.

Chosen target: **pin to an immutable, dated commit (not a moving `HEAD`/branch ref)**, because the
overlay pins by `rev` and the Nix `fetchFromGitHub` hash is only reproducible against a fixed commit.
The version string becomes `0.31.0.dev0+g<short-sha>` (cosmetic label; the overlay sets `version`
literally).

**Fallback if a clean rebase is NOT achievable at execution time** (e.g. HEAD churned `flashinfer.py`
further): the safest reachable version is **the smallest forward bump that keeps all five live
patches applying** — walk back from the resolved HEAD toward `ddd6fbca` and pick the newest commit
where the §1.2 matrix is all-green. If even `ddd6fbca+1` breaks a patch that cannot be hand-fixed in
scope, **do not bump at all this cycle**: keep `ddd6fbca`, document the blocking upstream commit, and
raise it as a separate task. A working build at the old pin beats a broken build at a new one. This
is a required design output, not a failure mode.

### 1.2 The six patches — upstream status (PREDICTED; matrix executed at implementation time)

> **Finding #8 — this is a prediction, not a result.** No concrete target SHA is pinned here (by
> design: the pin is resolved and frozen at implementation time, §1.3 step 1). The DROP below rests
> on a _verified_ fact (the target code is already present at the current pin — see the
> `vllm-flashinfer-mm-prefix-seqlens` row); the five "keep" rows are a **prediction** that the
> GNU-`patch -p1 --dry-run` matrix (run at implementation time against the resolved SHA) must
> confirm. If any "keep" flips to FAIL, apply the §1.1 fallback. Do not read the table as an
> already-obtained result.

Dry-runs use **GNU `patch -p1` (what Nixpkgs' patch phase uses)**, not `git apply` (stricter about
3-dot context headers → false failures). The six patch files are confirmed present
(`reader-fabric-verification.md` check 3):

| Patch                               | Target file(s)                                                                                                                                       | Decision                                                            | Basis          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------- |
| `vllm-sm120-fp4-support`            | `vllm/platforms/interface.py`                                                                                                                        | **keep** (predicted clean)                                          | matrix TBD     |
| `vllm-sm120-nvfp4-kv`               | new CUDA kernel `nvfp4_kv_cache_kernels.cu` + `envs.py`, `compressed_tensors.py`, `models/config.py`, `flashinfer.py`, `worker_base.py`, 3 new tests | **keep** (predicted clean; adds a NEW file so cannot upstream-away) | matrix TBD     |
| `vllm-sm120-nvfp4-q-dequant`        | `flashinfer.py` (`FlashInferImpl`)                                                                                                                   | **keep** (predicted clean)                                          | matrix TBD     |
| `vllm-flashinfer-gdn-api`           | `qwen_gdn_linear_attn.py`                                                                                                                            | **keep** (predicted clean)                                          | matrix TBD     |
| `vllm-flashinfer-nvfp4-noncausal`   | `flashinfer.py` (non-causal prefill backend)                                                                                                         | **keep** (predicted clean)                                          | matrix TBD     |
| `vllm-flashinfer-mm-prefix-seqlens` | `flashinfer.py` (`_build_mm_prefix_block_seqlens`)                                                                                                   | **DROP** (VERIFIED: target code already present at the pin)         | drop confirmed |

**`vllm-flashinfer-mm-prefix-seqlens` is obsolete at the current pin.** Its `+` side introduces
`common_attn_metadata.seq_lens_cpu_upper_bound`, which the target code already reads at `ddd6fbca`;
the change upstreamed at or before the current pin, so the patch is a dead entry in `patches = [...]`.
**Remove it from the overlay patch list.** The live coder building and serving today at this exact
pin already proves the _current_ patch list (including this entry as a now-no-op) applies — so
dropping a dead entry is low-risk.

### 1.3 Rebase procedure (DRY — no switch)

Implementation step, over SSH inside the `feat/nvfp4-reader-fabric` worktree branch (created by
preflight off `main` @ `9d67e4f`):

1. **Resolve + freeze the pin, then RUN the §1.2 matrix (turns the prediction into a result).**
   `git ls-remote https://github.com/vllm-project/vllm HEAD` → record the SHA. Check out that SHA (or
   fetch the tree) and run `patch -p1 --dry-run < <each of the five keep patches>`, recording the
   actual **offset/fuzz/FAIL per patch** into §1.2. If any of the five flips to FAIL, apply the §1.1
   fallback (walk back to the newest green commit; else keep `ddd6fbca`). The pin is always an
   immutable dated SHA, never a branch ref.
2. Edit `overlays/vllm.nix`:
    - `version = "0.31.0.dev0+g<newshort>";`
    - `rev = "<newfull>";` in **both** the `src` block AND the `cargoDeps.src` block (two literal
      copies of the same commit — keep identical).
    - **Remove** `../patches/vllm-flashinfer-mm-prefix-seqlens.patch` from the `patches = [ … ]` list
      and delete the file, noting the removal in the commit so the dead patch does not resurface.
3. Update the **three** hashes with the fake-hash loop:
    - `src.hash` (the `fetchFromGitHub` of `src`).
    - `cargoDeps.src.hash` (same owner/repo/rev → **identical** to `src.hash`; set both equal).
    - `cargoDeps` outer vendor hash (`rustPlatform.fetchCargoVendor`, `sourceRoot = "source/rust"`),
      which changes iff `rust/Cargo.lock` changed between commits.
      Set each to `lib.fakeHash`, run `nixos-rebuild build --flake .#esnixi`, read the "got: sha256-…"
      from the mismatch error, paste back, repeat. `rust/` cargoRoot is present at `ddd6fbca`;
      re-confirm at the target SHA (grep the tree) before relying on `cargoRoot = "rust"` /
      `sourceRoot = "source/rust"`.
4. Confirm the `postPatch` seds still match the new tree (torch pin rewrite, `setuptools-rust`
   strip, `setuptools` relax, `deepgemm`/`deepselect`/`flashkda` cmake-include drops). **A `sed` that
   matches nothing is a silent no-op** — safe, but if an external-project `include(...)` line was
   renamed upstream, the now-no-op sed lets the include resurface and the build tries a sandbox
   git-fetch at configure time → fails loudly. The `nixos-rebuild build` is the gate; if it fails on
   a resurfaced external-project fetch, patch the new sed target.
5. **Validation gate:** `nixos-rebuild build --flake .#esnixi` must complete. This proves overlay +
   five-patch rebase + three new hashes + the full torch/qutlass/flashinfer closure build for SM120.

⚠️ **OPERATOR**: `nixos-rebuild switch`, and the GPU-live confirmation that the rebuilt coder
(`qwen3.8-27b-nvfp4`) still loads NVFP4 weights + `--kv-cache-dtype nvfp4` and serves on `:8010`.

### 1.4 Edge cases / risks

- **Moving HEAD.** The pinned dated SHA builds reproducibly; main moving after the dry-run does not
  change the recorded hashes (why we pin a dated commit, not a branch).
- **cargoDeps vendor hash is the most fragile.** If `rust/Cargo.lock` changed, the vendor hash
  changes and the first build fails with a mismatch — expected; the fake-hash loop captures it. If
  `rust/Cargo.toml` gained a dependency needing network, `fetchCargoVendor` fails differently
  (missing crate) → fall back to a smaller bump (§1.1).
- **torch/FlashInfer ABI unaffected.** The overlay rebuilds torch 2.13.0 + FlashInfer 0.6.18 from
  source; neither is re-pinned by this bump. Only vLLM's own sources move.
- **Patch fuzz masking a semantic break.** GNU patch can apply at a shifted offset; the dry-run
  reports offset/fuzz. The real correctness proof is the operator's GPU-live load — a compiling
  NVFP4-KV kernel can still mis-route attention. Build gate catches compile breaks; operator serve
  test catches runtime breaks.

---

## 2. Dormant `docker-vllm-5090` fallback: fp8_e4m3 → nvfp4 KV + off stock image

### 2.1 Current state (verified at `modules/profiles/ai.nix`, symbols below)

`virtualisation.oci-containers.containers.vllm-5090`: `autoStart=false`, `image =
"vllm/vllm-openai:v0.29.0@sha256:…"`, cmd includes `--kv-cache-dtype fp8_e4m3`, `--max-model-len
24576`, `--gpu-memory-utilization 0.75`, `--enforce-eager`, binds `0.0.0.0:8010:8000`. Its systemd
wrapper `systemd.services.docker-vllm-5090` has `conflicts = [ "ollama.service" ]` (NOT
`vllm.service`) and a `/dev/shm` `preStart` RAM-stage of the 27B model. It is explicitly "NOT the
live path"; the live coder is the native `systemd.services.vllm` from `esnixi/vllm.nix`. A
**separate** vision container `vllm-vision-5090` _does_ launch via `gpu_launch.py` + `ARCANE_GPU_LOCK`

- `vllm_idle` middleware — it is a distinct concern and stays.

> Line numbers for `ai.nix` are intentionally omitted (that file is not in `esnixi-snapshot/`); the
> implementer locates these stanzas by the symbol names above. If an `ai.nix` snapshot is wanted for
> reviewability, capture it into `esnixi-snapshot/` first (same discipline as finding #10).

### 2.2 Decision: retire the OCI fallback onto the native build (do NOT rebuild a patched image)

- **(A) Keep it a container, swap the image for a patched one.** Stock `v0.29.0` has **no SM120
  NVFP4-KV kernel** — that kernel lives only in our six-patch overlay. Serving `nvfp4` KV from a
  container means building a bespoke OCI image embedding the patched vLLM and pinning it by digest,
  duplicating the whole torch/CUDA/FlashInfer closure into an image layer and creating a second
  artifact to rebuild on every overlay bump.
- **(B) Make the fallback a dormant native systemd unit** reusing `pkgsAccel.vllm` (the same patched
  build the coder uses) via `mkVllmService`, `wantedBy = []`, `--kv-cache-dtype nvfp4` (the
  `mkVllmService` default — the factory's `ExecStart` hardcodes `--kv-cache-dtype nvfp4`, confirmed
  in `esnixi-snapshot/vllm.nix` `mkVllmService`).

**Chosen: (B).** It satisfies both spec requirements (`nvfp4` KV AND off stock `v0.29.0`) with zero
new build artifacts — the fallback is the same binary as the coder, just dormant — and stays
consistent with the native-build direction of the flake. (A) is strictly more work for a worse
result.

### 2.3 Concrete change

In `modules/profiles/ai.nix`:

- **Remove** `virtualisation.oci-containers.containers.vllm-5090` and its wrapper
  `systemd.services.docker-vllm-5090` (including the `/dev/shm` `preStart`). Keep `vllm-nvidia-cdi`
  and the **vision** container `vllm-vision-5090` and its wrapper — they are a separate concern on
  the OCI path intentionally.
- **Clean up now-unused `let` bindings** `qwen38RamCache` / `qwen38HubCache` referenced only by the
  removed container/preStart. `vllm-nvidia-cdi`'s `before = [ "docker-vllm-5090.service" ]` also
  references the removed unit — **drop that `before` entry** or the eval fails on a dangling unit.
- **`esnixi/vllm-idle.nix` dangling reference (verified in `esnixi-snapshot/vllm-idle.nix`).** That
  file declares a `docker-vllm-5090` idle override AND `vllm-5090` container stanzas, plus the
  `arcane-gpu-lock` oneshot. If `docker-vllm-5090` is removed from `ai.nix`, these overrides
  reference a non-existent unit → eval error. **Remove the `docker-vllm-5090` and `vllm-5090`
  stanzas from `esnixi/vllm-idle.nix` too; keep `arcane-gpu-lock`** (still used by the vision
  container and, after §3, by the coder and reader).
- **`arcane-gpu-lock.service` ordering dep on the retired unit (resolves finding #3).** In
  `esnixi-snapshot/vllm-idle.nix` the `arcane-gpu-lock` oneshot carries
  `before = [ "docker-vllm-5090.service" "docker-comfy-esnixi.service" ]` (VERIFIED:
  `esnixi-snapshot/vllm-idle.nix` `systemd.services.arcane-gpu-lock.before`). Retiring
  `docker-vllm-5090` leaves `docker-vllm-5090.service` as a dangling ordering dep. systemd ignores
  an ordering dep on an absent unit (so this is a harmless NIT, not an eval error), but for cleanup
  consistency: **drop the `docker-vllm-5090.service` entry from that `before` list, leaving
  `before = [ "docker-comfy-esnixi.service" ]`** (keep `docker-comfy-esnixi.service` only if that
  unit still exists; if it too is gone, drop it as well). Note: this `arcane-gpu-lock.service` is the
  SAME unit whose `install` line is retargeted to `-m 0660 -o root -g vllm` per §3.3 step 5 — both
  edits land in the same stanza.
- **Add** a dormant native fallback unit in `esnixi/vllm.nix` via `mkVllmService`, e.g.
  `systemd.services.vllm-5090-fallback` with `wantedBy = []`, same `model`/`servedModel` as the
  coder, `--kv-cache-dtype nvfp4` (default), conservative `gpuMemoryUtilization`/`maxModelLen`, and
  `conflicts = [ "vllm.service" "vllm-reader.service" ]`. The `mkVllmService` factory already accepts
  a `conflicts` arg (confirmed: `esnixi-snapshot/vllm.nix` `mkVllmService` signature line 122), so no
  factory change is needed for this unit.
- Because it binds the same `127.0.0.1:8010` as the coder/reader, `conflicts` with both is mandatory.
  It is started only by an operator for disaster recovery.

A native systemd unit with `wantedBy = []` and no enable-time start is the exact analog of
`autoStart=false`.

### 2.4 Validation

`nixos-rebuild build --flake .#esnixi` must evaluate and build with the container gone and the
dormant unit present (proves no dangling unit references across `ai.nix` + `vllm-idle.nix`).
⚠️ **OPERATOR**: any actual start of the fallback unit (GPU-live).

---

## 3. New NVFP4 9B reader service on esnixi (lease-aware, idle-stop)

### 3.1 Goal and the hard constraint

A 9B NVFP4 reader that "flies" on the 5090 — but the 5090 is a **single-tenant** GPU for heavy
models: coder ~83% VRAM + OS ~14% ⇒ ~3% free (preflight check 1: 30234/32607 MiB used while the
coder is resident). **The reader CANNOT co-reside with the coder.** It must acquire the GPU, serve,
and on idle **fully stop** (process exits → VRAM returned → coder reclaims). This is NOT the vision
container's sleep-to-host-RAM (`vllm_idle.IdleSleepMiddleware`, `esnixi-snapshot/vllm_idle.py`) —
sleeping still holds VRAM; the reader must _terminate_.

### 3.2 The verified switcher state machine, and the two gaps this change must fill

`esnixi-snapshot/vllm-switch.py` is the esnixi analog of the m5max `local-model-proxy`: an
authenticated serializing HTTP gateway on `127.0.0.1:8011` (fronted by nginx `:2701`). Verified
facts (cite by symbol; snapshot line given only where re-checked against the committed file):

- `MODELS` map (`MODELS = { … }`): two entries, both pointing at `unit = "vllm.service"`,
  `served = "qwen3.8-27b-nvfp4"`, `max_requests = 1`. `ALIASES` derived just below.
- Module-global tenancy state: `switch_condition = threading.Condition()` (snapshot **line 52**),
  `active_model`, `active_requests = 0` (snapshot **line 54**), `switching = False`. **`active_requests`
  is a single GLOBAL counter, not per-unit** (mutated in `acquire_model`/`release_model`).
- Timing constants: `LOCK_WAIT_SECONDS = 3` (snapshot **line 21**), `MODEL_READY_SECONDS = 540`
  (snapshot **line 22**).
- `acquire_model`: under `switch_condition`, if the requested model's `unit` equals the active
  model's `unit` and `active_requests < max_requests`, it shares the slot; **otherwise it waits for
  `active_requests == 0`, sets `switching = True`, clears `active_model`, then calls `select_model`.**
  `LOCK_WAIT_SECONDS` bounds the wait → on timeout `acquire_model` returns `False` → the handler
  returns a **409** with the exact message `RTX 5090 is busy; use the next OmniRoute fallback`
  (snapshot **line 234**).
- `select_model`: checks `systemctl is-failed` (snapshot **line 285**, and again mid-poll at
  **line 321**); records `NRestarts`; runs **`sudo -n systemctl start <unit>`** (NOTE: only `start`);
  then polls the backend `/v1/models` for up to `MODEL_READY_SECONDS` until an item has `id == served`
  **and `max_model_len == context`**; bails early on `is-failed` or an `NRestarts` increment.
  **There is no `stop` and no idle timer anywhere in the file.**
- Sudo grant (`esnixi-snapshot/vllm.nix` `security.sudo.extraRules`, snapshot **lines 173–182**):
  the `vllm-switcher` user is granted exactly `${pkgs.systemd}/bin/systemctl start vllm.service`
  NOPASSWD (snapshot **line 178**) — nothing else.
- Switcher hardening (`esnixi-snapshot/vllm.nix` `systemd.services.vllm-switcher`, snapshot
  **lines 185+**): `environment` sets ONLY `SYSTEMCTL = "${pkgs.systemd}/bin/systemctl"` and
  `SUDO = "/run/wrappers/bin/sudo"`; `ProtectSystem = "strict"`, `ProtectHome = true`,
  `PrivateTmp = true`, `RestrictAddressFamilies`. **There is no `path = …` on the switcher unit**, so
  `nvidia-smi` is NOT reachable from the switcher process (this is why §3.3 does NOT shell to it).

**Two gaps this change must fill, confirmed by the above:**

- **(G1) The switcher never stops a unit.** With two distinct units sharing the GPU and port 8010
  (`vllm.service` coder, `vllm-reader.service` reader), `select_model`'s bare `start` is insufficient
  — the previously-active unit keeps its VRAM and the new one OOMs. The switcher must **stop the
  other unit and wait for it to go inactive before starting the target.**
- **(G2) The sudo grant is too narrow.** It covers only `start vllm.service`. The switcher needs
  NOPASSWD for `start`/`stop`/`reset-failed` of **both** `vllm.service` and `vllm-reader.service`.

### 3.3 Mutual exclusion: the switcher is the SINGLE tenancy authority (resolves findings #1, #2, #3)

**Authority = the switcher.** It is the ONLY actor permitted to transition either unit. Concretely:

1. **Extend `MODELS`** with a `qwen3.5-9b-nvfp4-reader` entry: `unit = "vllm-reader.service"`,
   `served = "qwen3.5-9b-nvfp4-reader"`, `hf_id = "AxionML/Qwen3.5-9B-NVFP4"`, `context = 65536`,
   `max_requests > 1` (concurrency; start at e.g. 8). Because the reader's `unit` differs from the
   coder's, `acquire_model` already routes a reader request down the "different unit" branch: it
   waits for `active_requests == 0`, sets `switching`, then calls `select_model`.

    > **The MODELS `context` MUST equal the reader unit's served `--max-model-len` (resolves finding
    > #2).** `select_model`'s readiness poll succeeds only when the backend `/v1/models` lists an item
    > with `id == served` **AND `max_model_len == selected['context']`** (VERIFIED:
    > `esnixi-snapshot/vllm-switch.py` `select_model`). The reader unit serves `--max-model-len 65536`
    > (§3.4); therefore the MODELS `context` is set to `65536` here, **not** a different placeholder.
    > If these two values ever disagree, every reader acquisition spins the full
    > `MODEL_READY_SECONDS` (540 s), then `select_model` returns `False` → the handler returns the
    > 409 → the reader tier is **silently always-dead** (always falls through to M5). **Rule: the
    > reader's `--max-model-len` and the MODELS `context` are a single coupled value — change both or
    > neither.** When the operator later raises VRAM-headroom and bumps `--max-model-len`, the MODELS
    > `context` MUST be bumped to the identical number in the same change. A switcher unit test
    > (§3.9) asserts `MODELS["qwen3.5-9b-nvfp4-reader"]["context"]` equals the reader unit's served
    > `--max-model-len` (parsed from the generated unit / a shared constant) so a drift fails CI
    > rather than silently killing the tier.

2. **Make `select_model` stop-the-other-first, with drain-wait + reset-failed (fills G1; resolves
   finding #2).** Before `start <target>`, the switcher must transition the OTHER unit cleanly:
    - **(2a) `sudo -n systemctl stop <other_unit>`** (clean stop; `KillMode=control-group` default +
      the factory's `TimeoutStopSec = "120s"` — snapshot **line 136**, inherited by every unit built
      from `mkVllmService` — reap the cgroup).
    - **(2b) Drain-wait by polling `ActiveState`/`SubState`, NOT `nvidia-smi`.** `nvidia-smi` is not
      on the hardened switcher unit's PATH (§3.2), so the switcher instead polls the other unit via the
      `systemctl show --value --property=ActiveState,SubState <other_unit>` it already shells to for
      `NRestarts`, waiting until `ActiveState == "inactive"` (and `SubState == "dead"`), bounded by a
      deadline ≤ `MODEL_READY_SECONDS`. Because systemd tears the process (and its CUDA context) down
      before the unit reaches `inactive/dead`, `inactive` is a sound proxy for "VRAM returned". Add a
      small fixed **settle delay (e.g. 2 s)** after `inactive` so the driver finishes reclaiming before
      the target's `cudaMalloc`. (Belt-and-suspenders: the arcane-gpu flock in step 5 makes a
      residual-VRAM race impossible even if the settle delay is too short — the target's
      `gpu_launch.py` blocks on `LOCK_EX` until the dying process's inherited fd is released by the
      kernel.)
    - **(2c) `reset-failed` guard (resolves finding #2a).** `select_model` opens with an `is-failed`
      guard that returns `False` and refuses to start a unit in a failed sub-state (snapshot
      **line 285**). A deliberate `stop` is clean (`inactive/dead`, not `failed`), so it will not trip
      the guard — BUT if the stopped unit had previously crashed into `failed`, or a stop times out and
      systemd marks it `failed`, a later request for it would be refused and the coder could get wedged
      "off". Therefore: **before `start <target>`, the switcher runs
      `sudo -n systemctl reset-failed <target_unit>`** (idempotent; clears a stale `failed` state) so
      the subsequent `start` is never refused by its own `is-failed` guard. Cheap and safe to run
      unconditionally.
    - Then the existing `start <target>` + `/v1/models` readiness poll proceeds unchanged.
      Only the switcher ever issues start/stop/reset-failed, and it only does so when
      `active_requests == 0` under `switch_condition` — so **a coding generation is never mid-flight when
      the coder is stopped** (the "coding wins" guarantee, owned by one actor).
3. **Race window.** Because `acquire_model` holds `switch_condition` and only transitions when
   `active_requests == 0`, a coding request that arrives _after_ the stop-decision but _before_ the
   coder restarts is serialized on the condition: it waits, and when the reader later goes idle and is
   stopped, the next coder request triggers a fresh coder start. Worst case for either side is one
   cold start (tens of seconds), surfaced to the gateway as a slow response or a 409 → `fill-first`
   fallthrough. No request is killed mid-generation.
4. **`Conflicts=` is a crash-safety backstop ONLY, not the stop mechanism.** Declare
   `vllm-reader.service` `conflicts = [ "vllm.service" ]` and give the coder
   `conflicts = [ "vllm-reader.service" ]` (via the `mkVllmService` `conflicts` arg). This exists
   purely so that if some out-of-band actor or a crashed switcher leaves both units somehow enabled,
   systemd will not let them co-run. **Document explicitly: no path other than the switcher may
   `systemctl start` either unit** (operators included, except the §2 disaster-recovery fallback which
   conflicts with both).
5. **The flock becomes a real backstop by wrapping BOTH units — a COMMITTED design decision, not an
   operator choice (resolves finding #6).** Today the coder does NOT hold `/run/arcane-gpu/5090.lock`:
   the `mkVllmService` `ExecStart` is a flat `${pkgsAccel.vllm}/bin/vllm serve …` (snapshot
   **line 133**) with no `gpu_launch.py` and no `ARCANE_GPU_LOCK`. `gpu_launch.py`
   (`esnixi-snapshot/gpu_launch.py`, 10 lines) opens `ARCANE_GPU_LOCK`, takes `fcntl.flock(fd,
LOCK_EX)`, `os.set_inheritable(fd, True)`, exports `ARCANE_GPU_LOCK_FD`, then `os.execvp`s into
   vLLM — so **the vLLM process inherits the fd and the kernel releases the lock on process death.**
   **Decision: generalize `mkVllmService` with an optional `leaseWrap ? false` flag and set
   `leaseWrap = true` on BOTH the coder and the reader.** `leaseWrap` (a) prefixes the ExecStart with
   `${pkgs.python3}/bin/python3 ${gpuLaunch} ` and (b) adds `ARCANE_GPU_LOCK =
"/run/arcane-gpu/5090.lock"` to the unit `environment`, with `after`/`requires` ordering on
   `arcane-gpu-lock.service`. With both wrapped, the flock is a genuine last-line guarantee that two
   heavy models never hold the GPU at once even if the switcher logic has a bug.

    > **This edits the live coder unit's ExecStart** — the single most dangerous change in the set. It
    > is in-scope and committed (NOT left bimodal). The implementer applies it; it is validated by
    > `nixos-rebuild build`; the operator's role is **post-`switch` verification only**: confirm the
    > coder still starts and serves on port 8010 with the wrapped ExecStart. (The abandoned alternative
    > — reader-only lease + `Conflicts=` and "flock not claimed active" — is NOT adopted; do not
    > implement it.)

    **The lock-file ownership/permission scheme MUST be fixed, or the wrapped coder cannot start
    (resolves finding #1 — the exact must-not-happen failure).** The lock is created by
    `arcane-gpu-lock.service` as `install -m 0600 -o 1000 -g 1000 /dev/null /run/arcane-gpu/5090.lock`
    (VERIFIED: `esnixi-snapshot/vllm-idle.nix` `systemd.services.arcane-gpu-lock`, the `script`
    `install` line — mode `0600`, owner uid/gid `1000`, the vision-container identity). But the native
    vLLM units run as `User = "vllm"; Group = "vllm";` (VERIFIED: `esnixi-snapshot/vllm.nix`
    `mkVllmService` `serviceConfig`, the `User`/`Group` lines), and `users.users.vllm` is
    `isSystemUser = true` with **no explicit `uid`** (VERIFIED: `esnixi-snapshot/vllm.nix`
    `users.users.vllm`), so the `vllm` user is NOT uid 1000. `gpu_launch.py` does
    `os.open(os.environ["ARCANE_GPU_LOCK"], os.O_RDWR)` (VERIFIED: `esnixi-snapshot/gpu_launch.py`
    line 6 — it RE-opens the file, it does not inherit an fd like the vision container does). A
    `0600`/uid-1000 file is NOT openable `O_RDWR` by the `vllm` user → `gpu_launch.py` raises
    `PermissionError` **before** `os.execvp` → the coder ExecStart never reaches vLLM and the primary
    coding model never starts after a switch.

    **COMMITTED fix — one scheme, openable `O_RDWR` by BOTH the `vllm` user and the uid-1000 vision
    container:** change the `arcane-gpu-lock.service` `install` line in `esnixi/vllm-idle.nix` to
    `install -m 0660 -o root -g vllm /dev/null /run/arcane-gpu/5090.lock` **and add the uid-1000
    vision-container identity to the `vllm` group** (declare `users.users.<vision-uid-1000-user>.extraGroups`
    includes `"vllm"`, or add the group to the container's `--group-add`/supplementary groups so the
    container's uid-1000 process is a supplementary member of `vllm`). Rationale for picking the
    group scheme over the two alternatives: (i) a world-RW `0666` advisory flock whose contents are
    never read also works, but it is a broader permission grant on a `/run` file than necessary and the
    group scheme is tighter; (ii) pinning `users.users.vllm.uid = 1000` would make `vllm` == the vision
    identity, which risks a uid collision with the existing uid-1000 container identity and conflates
    two distinct service principals — rejected. The `0660 root:vllm` + supplementary-group approach
    grants exactly the two principals that need the lock and nothing else. Both principals open the
    file `O_RDWR` (group has `rw`), the kernel still releases the advisory `LOCK_EX` on process death
    regardless of owner, and the vision container (which inherits the already-open fd via
    `ARCANE_GPU_LOCK_FD`) is unaffected either way.

    > **Operator post-switch check (REQUIRED, finding #1):** after `nixos-rebuild switch`, confirm the
    > wrapped coder actually opens the lock and serves — e.g. `systemctl start vllm.service` then
    > verify `journalctl -u vllm` shows no `PermissionError` from `gpu_launch.py`, `ls -l
/run/arcane-gpu/5090.lock` shows `-rw-rw---- root vllm`, and `curl -s 127.0.0.1:8010/v1/models`
    > lists `qwen3.8-27b-nvfp4`. If the coder throws `PermissionError`, the lock perms/group membership
    > did not take — do NOT proceed to the reader until this passes. The `nixos-rebuild build` gate
    > CANNOT verify runtime file permissions; this is an operator-only check.

### 3.4 The reader systemd unit

Add to `esnixi/vllm.nix` via `mkVllmService` (inherits `vllmEnvironment`, `vllmPath`/`path`,
PYTHONPATH, CUDA wiring, HF-offline, and the hardcoded `--kv-cache-dtype nvfp4` ExecStart).
Parameters:

- `model = "AxionML/Qwen3.5-9B-NVFP4"`, `servedModel = "qwen3.5-9b-nvfp4-reader"`.
- `--kv-cache-dtype nvfp4` (factory ExecStart default; the SM120 kernel from §1 handles it).
- **Generous batching** (spec #3 "flies"): `maxNumSeqs = "16"` (tune up after the VRAM test) and
  `--max-num-batched-tokens 8192` (vs the coder's `256`), real continuous batching / paged KV (do NOT
  pass `--enforce-eager` — CUDA graphs wanted for throughput). `maxModelLen` start at
  `--max-model-len 65536`; operator raises after measuring VRAM — **but any change here MUST be
  mirrored into the switcher MODELS `context` in the SAME change (§3.3 step 1, finding #2), or the
  readiness poll never matches and the reader tier goes silently dead.** The initial `65536` is the
  single coupled value shared by this unit's `--max-model-len` and `MODELS["qwen3.5-9b-nvfp4-reader"]
["context"]`.
- `gpuMemoryUtilization = "0.85"` — the reader has the GPU to itself while active (coder stopped).
- `leaseWrap = true` (the new §3.3 step 5 flag) + `conflicts = [ "vllm.service" ]`.
- `wantedBy = [ ]` — only the switcher starts it.

### 3.5 Idle → full stop (VRAM returned), restart-safe — ONE backstop (resolves finding #3)

The reader must terminate on idle, and the stop must fire **even if the switcher process is dead** (an
in-memory armed deadline is lost on switcher restart). Two mechanisms, both required; the backstop is
specified **once** with the correct semantic.

1. **Fast path: switcher-driven idle stop.** Extend `release_model()`
   (`esnixi-snapshot/vllm-switch.py` `release_model`, snapshot **line 274**): when the active model is
   a _reader_ unit and `active_requests` drops to 0, arm a monotonic idle deadline
   (`READER_IDLE_SECONDS = 300`). On expiry with still-zero active requests,
   `sudo -n systemctl stop vllm-reader.service`. The deadline is **re-armed/cancelled under
   `switch_condition`**: a new reader request that acquires the slot cancels the pending stop; when it
   finishes and `active_requests` returns to 0, the deadline re-arms. Stopping the unit kills the vLLM
   process → CUDA context torn down → VRAM returned; the inherited `gpu_launch.py` fd closes on exit →
   flock released.
2. **Restart-safe backstop (independent of the switcher): a systemd IDLE timer, NOT `RuntimeMaxSec`.**

    > **Why not `RuntimeMaxSec`.** `RuntimeMaxSec` is a hard wall-clock cap counted from unit
    > _activation_, so e.g. `RuntimeMaxSec = 300` would kill a reader that is actively serving a long
    > batch at the 5-minute mark mid-generation — breaking the "no request killed mid-flight" property
    > §3.3 promises. It is the wrong primitive for "idle for N seconds → stop" and is therefore NOT
    > used.

    Add a dedicated **`vllm-reader-idle.timer` + `vllm-reader-idle.service`** pair:
    - `systemd.services.vllm-reader-idle`: a `Type=oneshot` root service whose script curls the reader
      backend `/metrics` endpoint, parses vLLM's **`vllm:num_requests_running`** (and
      `vllm:num_requests_waiting`) gauge, and — only if the sum has been **zero for the full idle
      window** — runs `systemctl stop vllm-reader.service`. To make "zero for the window" robust against
      a single scrape landing between requests, the oneshot writes the last-nonzero timestamp to a
      small state file under `/run` and stops only when `now - last_nonzero >= READER_IDLE_SECONDS`
      (300 s). Runs as root → needs no sudo.
    - `systemd.timers.vllm-reader-idle`: `OnActiveSec = 60` + `OnUnitActiveSec = 60` (poll every 60 s)
      with `PartOf = [ "vllm-reader.service" ]` so the timer is started/stopped together with the
      reader (a stopped reader has no idle timer running).
    - Idle window: **`READER_IDLE_SECONDS = 300`**, poll interval **60 s**. Same 300 s value as the
      switcher fast path, so both agree on "idle".

    **This is the single, canonical backstop.** No `RuntimeMaxSec`, no `OnUnitInactiveSec`, no 1800
    value anywhere — those alternatives are deleted.

3. **Sudo grant (fills G2, resolves finding #2 + the earlier sudoers gap).** The current grant is
   `start vllm.service` only (snapshot **line 178**). Replace with these NOPASSWD rules for the
   `vllm-switcher` user: `systemctl start vllm.service`, `systemctl stop vllm.service`,
   `systemctl reset-failed vllm.service`, `systemctl start vllm-reader.service`,
   `systemctl stop vllm-reader.service`, `systemctl reset-failed vllm-reader.service` (coder stop is
   needed because §3.3 step 2 stops the coder before starting the reader; `reset-failed` per §3.3 step
   2c). The `vllm-reader-idle.service` runs as root (system oneshot) so its `systemctl stop` needs no
   sudo. **The `nixos-rebuild build` gate CANNOT verify sudo works at runtime** — the operator MUST
   confirm `sudo -n` succeeds for each of these exact commands before the first live test.

**Mutual exclusion thus rests on, in order of authority:** (1) the switcher as single tenancy
authority with explicit stop → drain-to-`inactive` → `reset-failed` → start, under `switch_condition`
only when `active_requests == 0` (§3.3 steps 1–3) — the primary guarantee; (2) the restart-safe
`vllm-reader-idle.timer` so VRAM returns even if the switcher dies (§3.5 step 2); (3) the arcane-gpu
flock held by BOTH wrapped units (§3.3 step 5) and systemd `Conflicts=` (§3.3 step 4) as crash-safety
backstops. No layer contradicts another; the switcher is the only thing that starts/stops in normal
operation.

### 3.6 Quant-format validation plan (ModelOpt NVFP4 / W4A4-vs-W4A16) (resolves finding #4)

Preflight check 5: `AxionML/Qwen3.5-9B-NVFP4` is **ModelOpt NVFP4** (vLLM quant method `modelopt_fp4`,
"NVFP4 (MLP-only, MSE calibration)", ~6 GB), **not** compressed-tensors/W4A16; its own KV is NOT
quantized, so we supply `--kv-cache-dtype nvfp4` at serve time.

**DRY pre-checks performed and VERIFIED at authoring (no GPU), evidence persisted in `quant-evidence/`
(resolves findings #4 + #10 — moved out of `/tmp`):**

1. **`modelopt_fp4` is registered in-tree at the pin.** `quant-evidence/vllm_quant_init.py`
   (`vllm/model_executor/layers/quantization/__init__.py` @ `ddd6fbca`): `"modelopt_fp4"` in the
   method-name list (**line 22**) and `"modelopt_fp4": ModelOptNvFp4Config` in the config map
   (**line 164**). So the reader is not a dead target for "unknown quant method".
2. **No `nvidia-modelopt` import gate on the serve path.** `quant-evidence/vllm_modelopt.py`
   (`modelopt.py` @ `ddd6fbca`): the module's top imports are vLLM-internal / torch only; the
   `nvidia-modelopt` pip package is needed to _produce_ checkpoints, not to serve one.
3. **The W4A4-vs-W4A16 dtype gating is handled IN-TREE at config-parse time (the source-level answer
   the reviewer asked for).** `modelopt.py` quant-algo map: `"NVFP4" → ("modelopt_fp4","nvfp4_config")`
   is **W4A4** (4-bit weights AND activations); `"W4A16_NVFP4" → ("modelopt_fp4","w4a16_nvfp4_config")`
   is **W4A16** (bf16/fp16 activations) (`quant-evidence/vllm_modelopt.py` **lines 137–140**).
   Critically, `ModelOptNvFp4Config.from_config` **auto-promotes a `"NVFP4"` checkpoint whose config
   groups have `input_activations is None` (weight-only quant) to `"W4A16_NVFP4"`** (**lines
   775–791**), and the MoE/linear methods then set `use_a16 = (quant_method == "W4A16_NVFP4")` and
   select a bf16-activation backend (**line 842**). The AxionML card's "MLP-only" quant strongly
   suggests weight-only MLP quant, which this path routes to W4A16 automatically. **Conclusion:
   whether this checkpoint lands on W4A4 or W4A16 is decided by vLLM from the checkpoint's own
   `hf_quant_config.json`, not by us — the serve command is identical either way.** This removes the
   "will W4A4 even be accepted" uncertainty at the _config_ layer.
4. **Remaining open question = the SM120 KV kernel only, and it has a concrete DRY pre-check the
   implementer MUST run (over SSH, no GPU).** The one thing not answerable from the quant config is
   whether the SM120 attention/KV kernel from `patches/vllm-sm120-nvfp4-kv.patch` gates on a weight or
   activation dtype (W4A4 vs W4A16) or on a `quant_algo`/`kv_cache_quant_algo` check. **Implementer
   dry pre-check:** `grep -nE "W4A4|W4A16|use_a16|quant_algo|kv_cache_quant|activation"` over
   `patches/vllm-sm120-nvfp4-kv.patch` and `patches/vllm-sm120-nvfp4-q-dequant.patch` on the remote,
   and record whether the KV path is dtype-gated. If the KV kernel is independent of the
   weight/activation scheme (it operates on the KV tensor, which `--kv-cache-dtype nvfp4` sets
   regardless of weight dtype), W4A16-activation weights pose no problem. **Save the grep output into
   `quant-evidence/sm120-kv-gating.txt`.** This is a required implementation-step artifact.

**OPERATOR (GPU-live) serve test** (off-hours, coder stopped), mirroring the live `gpu_launch.py`
invocation shape — serve `AxionML/Qwen3.5-9B-NVFP4` with `--served-model-name qwen3.5-9b-nvfp4-reader`,
`--kv-cache-dtype nvfp4`, `--max-model-len 65536 --max-num-seqs 16 --max-num-batched-tokens 8192
--gpu-memory-utilization 0.85`, under `ARCANE_GPU_LOCK=/run/arcane-gpu/5090.lock` via `gpu_launch.py`
on the reader port (8010). Success criteria: weights load with no quant-method error; `/v1/models`
lists the served name with `max_model_len == 65536`; a chat completion returns coherent text;
`nvidia-smi` shows the process resident; stopping it returns VRAM to ~OS baseline (confirms §3.5).

**If the serve test fails** — fallback order:

- (a) **No action needed for W4A16** — vLLM auto-promotes weight-only `"NVFP4"` to `W4A16_NVFP4`
  (verified above); the same serve command covers it.
- (b) **compressed-tensors/W4A16 9B — OUT OF SCOPE for this task.** Sourcing or quantizing a
  different checkpoint is a materially larger, separate effort. No known compressed-tensors/W4A16
  Qwen3.5-9B is identified here. **If the ModelOpt checkpoint does not validate, STOP and raise a
  separate task** to source/produce a W4A16 variant; do not treat (b) as in-scope rework.
- (c) Last resort for the reader tier only: serve NVFP4 weights with a higher-precision KV (drop
  `--kv-cache-dtype nvfp4` to `fp8_e4m3` or `auto`) to isolate whether the KV kernel is the problem —
  a diagnostic, not a shipping config.
  Record which path validated. This is a validation branch, not a build blocker.

### 3.7 Retire the earlier ollama q4 reader attempt (spec #3)

The implementer must confirm whether a `qwen3.5:9b` reader Modelfile/oneshot was committed on
`feat/nvfp4-reader-fabric` (grep `ai.nix` for a `qwen3.5:9b` reader oneshot); if so, remove it. The
esnixi reader is the native NVFP4 unit, not ollama. Note the result (likely "nothing to revert").

### 3.8 Edge cases / error handling

- **Slow coder shutdown.** When a read job arrives and the coder is active, the switcher
  (`active_requests == 0` gate) stops the coder and waits for `ActiveState == inactive`, bounded by
  the drain deadline ≤ `MODEL_READY_SECONDS`. If drain/stop exceeds it, `select_model` returns False →
  switcher 409/5xx → gateway tier fallthrough. The factory `TimeoutStopSec = "120s"` (snapshot
  **line 136**, inherited by all `mkVllmService` units) bounds the stop. **Recoverable, logged** by
  systemd + switcher.
- **Reader fails to load (quant/kernel error).** The readiness poll never sees `served` with matching
  `max_model_len`; `select_model` also watches `is-failed` and `NRestarts` and returns False promptly
  → switcher 409/5xx → gateway fallthrough. **Recoverable**; operator inspects `journalctl -u
vllm-reader`.
- **Stop leaves a unit `failed`.** The `reset-failed` in §3.3 step 2c (run before the next start)
  clears it so the `is-failed` guard never wedges a deliberately-stopped unit "off". **Recoverable.**
- **Idle-stop races a new request.** Re-arm/cancel is under `switch_condition` (§3.5 step 1); a
  request during a pending stop is serialized, cancels the stop (if not yet issued) or triggers a
  fresh start (if already stopped). Worst case one cold start. **Recoverable.**
- **VRAM not fully returned after stop.** `KillMode=control-group` + `TimeoutStopSec` reap the cgroup;
  the inherited flock fd closes on process death → lease released; the drain-wait + settle delay (§3.3
  step 2b) ensures the target does not `cudaMalloc` before reclaim. Operator check: `nvidia-smi`
  baseline after stop.
- **Switcher dead while reader resident.** The `vllm-reader-idle.timer` (§3.5 step 2) stops the reader
  independently → VRAM returns → coder can start on the next request. This is the explicit resolution
  of the "survives a switcher restart" requirement.
- **Error-body hygiene.** The switcher already returns structured `{"error":{"message":…}}` via
  `json_response` and never leaks stack traces; keep that.

### 3.9 Testability

- **Unit-testable without a GPU:** the switcher's extended `MODELS`/`ALIASES`, the `acquire_model`
  state machine (two units, `switching`, 409-on-`LOCK_WAIT_SECONDS`-timeout), the new
  stop → drain-wait → reset-failed → start ordering, and the idle-deadline arm/cancel/stop logic. Add
  Python tests beside `vllm-switch.py` driving `acquire_model`/`release_model`/`select_model` with a
  fake `subprocess` (fake `systemctl show ActiveState`), asserting: (a) reader and coder are never
  both "active"; (b) a reader start issues `stop <coder>` → polls `ActiveState` to `inactive` →
  `reset-failed <reader>` → `start <reader>`, in that order, only when `active_requests == 0`;
  (c) idle expiry issues `stop vllm-reader.service`; (d) a request arriving during the idle window
  cancels the stop; (e) busy → 409 with the exact string;
  (f) **`MODELS["qwen3.5-9b-nvfp4-reader"]["context"]` equals the reader unit's served
  `--max-model-len` (65536)** — the context/max-model-len coupling guard (finding #2), so a future
  drift fails CI instead of silently always-dead-ing the reader tier (assert against a shared
  constant or the value parsed from the generated reader unit).
- **Nix eval/build-testable (implementer):** `nixos-rebuild build` proves the reader unit, the
  `mkVllmService` `leaseWrap` generalization (applied to BOTH coder and reader), the expanded sudo
  rules, the `Conflicts=` wiring, the `vllm-reader-idle` timer+service, and the dormant-fallback unit
  all evaluate and build.
- **Integration-testable only GPU-live (operator):** weight load, VRAM return, lease handoff,
  throughput under `--max-num-seqs 16`, and `sudo -n` for the expanded command set. Documented in
  §3.5/§3.6.

---

## 4. Gateway `hybrid/reader` tiered combo

### 4.1 Current state (what is VERIFIED here vs what the implementer must confirm live)

- OmniRoute combos are **runtime DB rows** created/updated via REST `/api/combos` (POST) and
  `/api/combos/{id}` (PUT); the fleet applies them through `home/programs/omniroute-routing.py`
  (and `omniroute-mode.py`) against `https://omniroute.celestium.life`.
- **VERIFIED in this workspace (OmniRoute source):**
    - `comboNameSchema` regex `^[a-zA-Z0-9_/.\-\[\] ]+$` allows `/`, so `hybrid/reader` is a valid combo
      name (`src/shared/validation/schemas/combo.ts`).
    - `createComboSchema` accepts `name`, `strategy`, `models` (steps with `providerId`, `connectionId`,
      `weight`), `config`, `context_length`, `context_cache_protection` — the §4.4 payload's top-level
      shape validates (`combo.ts`, `comboModelStepInputSchema`).
    - A combo step's `connectionId` IS the dispatch pin. `ResolvedComboTarget.connectionId`
      (`open-sse/services/combo/types.ts`, the `connectionId: string | null` field) is carried
      per-target through target resolution and consumed by `executeTargetAttempt.ts` (which keys the
      attempt, LKGP recording, and native-turn pin on `effectiveConnectionId`/`connId`). So two steps
      with the SAME `model` string but DIFFERENT `connectionId` dispatch to different physical
      connections — this is how tier 1 (gremlin) and tier 3 (M5) are distinguished (resolves finding #7's
      dispatch-pin question).
- **NOT verified here (file not in this workspace or in `esnixi-snapshot/`) — the implementer MUST
  confirm against live `/api/providers`:** every `home/programs/omniroute-routing.py` detail
  (connection UUIDs, the per-connection `maxConcurrent` policy values, the existing `local/m5-reader`
  lane, the exact served model strings). The connection UUIDs below are carried from the preflight /
  prior iteration as **candidates to confirm**, not as verified facts. Snapshot `omniroute-routing.py`
  into the task dir, or treat its specifics as "to be confirmed by `/api/providers`" (resolves
  finding #7's unverifiable-cite concern).

Candidate physical connections (confirm each UUID with a read-only `GET /api/providers`):

- `vllm` — esnixi native vLLM (switcher). Candidate UUID `e9bd13fb-c6b6-4c18-b42f-3395266348ce`.
- `ollama-local` — gremlin 4070 Ti Super Ollama. Candidate UUID `b20e0770-3e14-40c1-87cd-85c34b34381a`.
- `ollama-m5-reader` — stabulous M5 Ollama **reader**. Candidate UUID
  `598cf9d0-c780-4534-ae12-db324c99b588`.
- (`llama-cpp` = stabulous GLM/MLX proxy exists but is NOT a reader tier — the M5 reader is
  `ollama-m5-reader`.)

**Gap (spec #5):** `hybrid/reader` is genuinely absent from the catalog and must be CREATED. The
existing reader lane is `local/m5-reader` (model `ollama-local/qwen3.5-reader:9b` pinned to the M5
reader connection, context 32768) — confirm this against live config before mirroring it.

### 4.2 Strategy choice: `fill-first`, and what it actually does (resolves finding #1)

The spec tiering is strict priority-ordered overflow. OmniRoute's **`fill-first`** preserves operator
priority order and advances **on target failure** — this is VERIFIED in source:

- `open-sse/services/combo/applyStrategyOrdering.ts`, the `strategy === "fill-first"` branch, does
  nothing but log "Fill-first ordering: preserving priority order". It does **not** read any
  per-connection concurrency cap.
- Per-connection `maxConcurrent` (`provider_connections.max_concurrent`, resolved by
  `concurrencyCaps.ts`) is consumed in exactly TWO places: `resolveMaxConcurrentByConnection(...)`
  inside the `strategy === "quota-share"` branch of `applyStrategyOrdering.ts`, and
  `makeConnectionConcurrencyResolver(...)` inside the round-robin semaphore (`roundRobinCombo.ts`).
  **Neither is `fill-first`.**

> **Therefore the iteration-2 premise was false (finding #1):** "`fill-first` + per-connection
> `maxConcurrent` → fill tier 1 to cap, overflow to tier 2" does NOT hold. `fill-first` does not gate
> on a concurrency cap; it only advances when the current target **errors** (or is pre-dispatch-skipped
> for a persisted cooldown). A healthy-but-busy gremlin that has not errored keeps getting reader
> requests and will NOT overflow to the 5090 on busyness alone.

**Chosen mechanism: error-driven overflow (reviewer option (a)).** The design does NOT rely on
`maxConcurrent` to force tier-1→tier-2 overflow. Instead:

- Tier order is the `fill-first` step order (tier 1 → 2 → 3). This part is correct and verified.
- Overflow between tiers happens when the current tier **returns a retriable capacity/failure status**
  that the combo loop treats as "advance to the next target". The tier-2 ("5090 not coding") and
  tier-2→tier-3 paths are inherently error-driven already (switcher 409 → fallthrough), so they work.
  For **tier 1 → tier 2 on gremlin busyness**, the gremlin backend must return a retriable capacity
  error when it has no free slot, so `fill-first` advances. This is the explicit, verified-against-code
  design; the `maxConcurrent` row on the gremlin connection is kept only as _documentation of intended
  concurrency_, not as the overflow trigger.

**Implementer MUST verify the gremlin's at-capacity behavior (gating fact for the whole combo).** Does
the gremlin reader (Ollama, and/or its k8s `vllm-4070ti`) return a retriable status (e.g. 429/503/5xx)
when it is at its serving limit, or does it **silently queue** the request? If it queues silently,
tier-1→tier-2 overflow-on-busyness **cannot** be expressed by `fill-first` and the design must be
re-scoped (see §4.3). Confirm with a read-only probe of the gremlin backend under a saturating load,
or by reading its serving config (`num_parallel` / `max-num-seqs`). Record the finding.

### 4.3 The three tiers — how overflow is enforced (error-driven)

- **Tier 1 = gremlin 4070 Ti Super** (`ollama-local/qwen3.5-reader:9b`, gremlin connection), first
  step. **Overflow condition:** the gremlin returns a retriable capacity error when busy →
  `fill-first` advances to tier 2. If (per §4.2) the gremlin silently queues instead, overflow on
  busyness is not achievable with `fill-first`; the honest options are: (i) accept that tier 1 absorbs
  all load until it _errors_ for another reason (not the spec's intent), or (ii) front the gremlin
  reader with a thin capacity gate that returns 503 when full (a separate task). **Do not claim
  busyness-overflow works until the gremlin's at-capacity status is confirmed (§4.2).**
- **Tier 2 = esnixi 5090 reader** (`vllm/qwen3.5-9b-nvfp4-reader`, esnixi connection), second step.
  Reached only when tier 1 has advanced. The "5090 NOT coding" half is enforced **by the switcher**
  (§3.3): if the coder is active, acquiring the reader requires the switcher to stop the coder, which
  it only does when `active_requests == 0`; if a coding job is in flight the reader cannot acquire
  within `LOCK_WAIT_SECONDS` and the switcher returns **409 "RTX 5090 is busy; use the next OmniRoute
  fallback"**. The combo treats 409 as a target failure and `fill-first`-falls to tier 3. **No gateway
  rule needed** — "coding wins" is the switcher's behavior.
- **Tier 3 = M5 Max reader** (`ollama-local/qwen3.5-reader:9b`, M5 reader connection), third step,
  reached only after tiers 1+2 have advanced.

This maps spec priority 1/2/3 onto `fill-first` step order; the conditional gates are both
error-driven (gremlin capacity error; switcher 409) — **no new strategy or scheduler code.**

### 4.4 Exact runtime config to create

**A. Provider-connection caps — documentation only, NOT the overflow mechanism (finding #1).** The
`maxConcurrent` values below describe intended per-connection load; they do NOT drive `fill-first`
overflow. Confirm/keep them for operator visibility and for any future switch to a cap-aware strategy
(`quota-share`/round-robin), but the combo's correctness does not depend on them.

- `ollama-local` (gremlin) → `maxConcurrent: 1` (candidate current value — confirm). _Operator option:_
  raise to 2 to use both 4070ti read slots.
- `vllm` (esnixi) → `maxConcurrent: 1` (candidate current value — confirm).
- `ollama-m5-reader` (M5) → `maxConcurrent: 1`, `defaultModel: "qwen3.5-reader:9b"` (candidate — confirm).

**B. A reader backend model on the `vllm` connection.** The switcher advertises
`qwen3.5-9b-nvfp4-reader` in `/v1/models` (added in §3.3 via its `MODELS` map). Register that model id
in OmniRoute's catalog for the `vllm` connection (dashboard "models" or `/api/models`), mirroring how
`vllm/qwen3.8-27b-nvfp4` is registered, so `vllm/qwen3.5-9b-nvfp4-reader` resolves.

**C. The `hybrid/reader` combo** (REST `POST /api/combos`). Name is literally `hybrid/reader` (slash
allowed — verified `comboNameSchema`). Steps are written with `providerId` = model-string prefix and
`connectionId` = the pinned UUID (the dispatch pin, §4.1). Payload:

```json
{
	"name": "hybrid/reader",
	"strategy": "fill-first",
	"models": [
		{
			"id": "reader-t1-gremlin-4070ti",
			"kind": "model",
			"model": "ollama-local/qwen3.5-reader:9b",
			"providerId": "ollama-local",
			"connectionId": "<gremlin-connection-uuid>",
			"weight": 0
		},
		{
			"id": "reader-t2-esnixi-5090",
			"kind": "model",
			"model": "vllm/qwen3.5-9b-nvfp4-reader",
			"providerId": "vllm",
			"connectionId": "<esnixi-vllm-connection-uuid>",
			"weight": 0
		},
		{
			"id": "reader-t3-m5max",
			"kind": "model",
			"model": "ollama-local/qwen3.5-reader:9b",
			"providerId": "ollama-local",
			"connectionId": "<m5-reader-connection-uuid>",
			"weight": 0
		}
	],
	"config": {},
	"context_length": 32768,
	"context_cache_protection": false
}
```

Notes:

- Replace each `<…-uuid>` with the UUID confirmed from live `/api/providers` (candidates in §4.1). Do
  NOT hardcode the candidate UUIDs without confirming them.
- `weight: 0` is correct for `fill-first` (priority-order strategies ignore weight). Step order is the
  tier order.
- Tiers 1 and 3 share the model string `ollama-local/qwen3.5-reader:9b` but DIFFERENT `connectionId`.
  The `connectionId` is the dispatch pin (§4.1, verified), so the two steps route to different physical
  GPUs despite the identical model string.
- `context_length: 32768` matches the most constrained tier (the M5 reader lane); raise only if every
  tier supports more.
- Before the operator POSTs, the implementer MUST re-read live `/api/providers` to confirm the UUIDs
  and that each backend's `/v1/models` actually advertises `qwen3.5-reader:9b` (tiers 1/3) and
  `qwen3.5-9b-nvfp4-reader` (tier 2); adjust served strings if the live ids differ.

**D. Prefer the existing builder over a hand POST.** The cleanest implementation is to add a
`hybrid/reader` branch to `omniroute-routing.py` (it already carries the connection ids and the
`reader` category) and let it emit the combo through its drift-checked projection, rather than a raw
curl. The payload above is the equivalent the script would produce. (Confirm the builder's current
shape first — it is not snapshotted here.)

### 4.5 Auth source (resolves preflight finding 6)

Preflight check 6: `/run/secrets/omniroute_zoo_api_key` is neither readable nor declared in the flake.
**Decision: use the existing OmniRoute management auth path the `omniroute-routing.py` builder already
uses** against `https://omniroute.celestium.life` — do NOT introduce a dependency on
`omniroute_zoo_api_key` unless a later task declares it as a sops secret. The §4.6 verification uses
that same key.

### 4.6 Validation (DRY where possible; live POST + resolve are operator)

- **Implementer (read-only):** `GET /api/combos` to confirm `hybrid/reader` is absent and capture live
  connection ids / served ids; `GET /api/providers` to confirm the three connections exist with the
  expected caps and served models; probe the gremlin's at-capacity status (§4.2); validate the payload
  against `createComboSchema` with a local check; OmniRoute Vitest/unit tests for combo normalization
    - 409 classification (`npm run test:vitest` / `npm run test:unit`, no GPU/live gateway).
- **OPERATOR (mutates live gateway):** the `POST /api/combos` (or `omniroute-routing.py --apply`) that
  creates `hybrid/reader`, plus any `maxConcurrent` edits.
- **OPERATOR (resolve + tier-fallthrough test):** an authenticated chat completion with
  `"model": "hybrid/reader"` returns a completion, and the responding model is a reader tier (tier 1
  gremlin while free; tier 2 esnixi only during a coding lull; tier 3 M5 on overflow). Confirm
  fallthrough by saturating tier 1 and observing tier 2/3 selection, and by issuing a reader request
  while a coding job runs on the 5090 (expect the 409 → tier-3 M5).

### 4.7 Edge cases / error handling

- **Name collision warning.** `POST /api/combos` returns a non-blocking warning if the name shadows a
  model id; `hybrid/reader` is not a model id → benign.
- **All tiers busy.** Every target advanced / errored → combo exhausts and returns a terminal combo
  error with per-target diagnostics; the caller sees a 429/503-class error, not a hang.
- **Tier-2 switcher 409 is NOT a breaker trip.** The provider-breaker trip set is `{408,500,502,503,504}`
  (VERIFIED: `PROVIDER_BREAKER_FAILURE_STATUSES` in `src/sse/handlers/chatPredicates.ts`), so a busy
  5090 409 does not open the whole `vllm` provider circuit; it just advances `fill-first`.
- **Stale connection ids.** If any UUID changed, the step resolves to no connection and
  `cleanupComboConnectionRefs` nulls it. The implementer MUST re-read `/api/providers` and confirm the
  UUIDs before building (§4.4).

### 4.8 Testability

- **Unit (OmniRoute, Vitest/node):** `normalizeComboModels` on the §4.4 payload yields three
  `kind:"model"` steps with the right connection pins; `fill-first` preserves step order; a 409 from a
  target is classified as a non-breaker fallthrough. `npm run test:vitest` / `npm run test:unit`, no
  GPU, no live gateway.
- **Integration (operator, live gateway):** the resolve + fallthrough test in §4.6.

---

## 5. Operator vs implementer split (explicit)

| Action                                                                                                                                                                                                                     | Who               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `git ls-remote` resolve + RUN the §1.2 `patch --dry-run` matrix; edit `overlays/vllm.nix`; fake-hash → real-hash loop; GitHub-raw quant-registry grep; remote `patches/*.patch` dtype-gating grep (§3.6 step 4)            | Implementer (DRY) |
| `nixos-rebuild build --flake .#esnixi` (overlay bump, dormant unit, reader unit, `leaseWrap` on BOTH coder+reader)                                                                                                         | Implementer (DRY) |
| Edit `ai.nix`/`vllm-idle.nix` to retire the OCI fallback; add dormant native unit; add reader unit; generalize `mkVllmService` with `leaseWrap`; add `vllm-reader-idle` timer+service; add `Conflicts=`; expand sudo rules | Implementer (DRY) |
| Extend `vllm-switch.py` (reader `MODELS` entry; stop → `ActiveState`-drain → `reset-failed` → start in `select_model`; idle-stop in `release_model`) + its unit tests                                                      | Implementer (DRY) |
| Build the `hybrid/reader` payload; add a branch to `omniroute-routing.py`; read-only `GET /api/combos`/`/api/providers`; probe gremlin at-capacity status; OmniRoute Vitest/unit tests                                     | Implementer (DRY) |
| **`nixos-rebuild switch`** on esnixi                                                                                                                                                                                       | ⚠️ OPERATOR       |
| **Post-`switch`: confirm the coder still starts/serves on 8010 with the `leaseWrap`-wrapped ExecStart**                                                                                                                    | ⚠️ OPERATOR       |
| **Confirm `sudo -n` works for the expanded switcher command set** (build gate cannot verify)                                                                                                                               | ⚠️ OPERATOR       |
| **Any `systemctl start`/`stop` of coder/reader/fallback; all GPU-live model loads**                                                                                                                                        | ⚠️ OPERATOR       |
| **NVFP4 9B serve/validation test** (§3.6)                                                                                                                                                                                  | ⚠️ OPERATOR       |
| **`POST /api/combos` / `maxConcurrent` edits**                                                                                                                                                                             | ⚠️ OPERATOR       |
| **`hybrid/reader` resolve + tier-fallthrough chat test (incl. coding-lull 409 → M5)**                                                                                                                                      | ⚠️ OPERATOR       |

---

## 6. Build/test commands reference

- Flake DRY build (esnixi, over SSH in `feat/nvfp4-reader-fabric`):
  `nixos-rebuild build --flake .#esnixi` — the single gate for §1/§2/§3 Nix correctness.
- Patch dry-run (GNU patch, matches Nixpkgs patch phase): `patch -p1 --dry-run < <patch>` against a
  checkout of the target SHA. (`git apply --check` is NOT authoritative.)
- Quant-registry DRY grep (no clone): `curl -sfL
https://raw.githubusercontent.com/vllm-project/vllm/<sha>/vllm/model_executor/layers/quantization/__init__.py`
  then grep for `modelopt_fp4`.
- SM120 KV-gating DRY grep (§3.6 step 4): `grep -nE "W4A4|W4A16|use_a16|quant_algo|kv_cache_quant|activation"`
  over the two remote nvfp4-kv patches → save to `quant-evidence/sm120-kv-gating.txt`.
- OmniRoute tests (local `feat/hybrid-reader-combo`): `npm run test:unit`, `npm run test:vitest`,
  `npm run typecheck:core`.
- Switcher unit tests: `python3 -m pytest` over the extended `vllm-switch.py` state machine, no GPU.

---

## 7. Summary of decisions made in this design (beyond the spec's confirmed set)

1. **Bump target = a fixed dated upstream-main commit**; clean rebase expected but the §1.2 matrix is
   RUN at implementation time to prove it; fallback = smallest green bump, else no bump (never a broken
   build). §1.2/§1.3 are explicitly labeled PREDICTED-until-matrix (finding #8).
2. **Drop `vllm-flashinfer-mm-prefix-seqlens`** (target code already present at the pin — verified);
   keep the other five (predicted clean, confirmed by the matrix).
3. **Three hashes to update** (src, cargoDeps.src = identical, cargoDeps vendor); re-confirm `rust/`
   cargoRoot at target.
4. **Dormant fallback = native systemd unit reusing `pkgsAccel.vllm`, not a rebuilt OCI image**; retire
   `docker-vllm-5090` from both `ai.nix` and `vllm-idle.nix` (+ the `vllm-nvidia-cdi` `before` entry
   and the unused `qwen38*Cache` lets); `conflicts` with coder AND reader; `wantedBy=[]`.
5. **Reader lifecycle: the switcher is the single tenancy authority** — stop other → drain to
   `ActiveState=inactive` (NOT `nvidia-smi`, which is off the switcher's PATH) → `reset-failed target`
   → start, only when `active_requests == 0` (fills G1; resolves finding #2); the flock becomes real
   by wrapping BOTH coder and reader through `gpu_launch.py` (`leaseWrap`) — a COMMITTED decision, not
   bimodal (resolves finding #6); `Conflicts=` is a crash backstop only.
6. **Idle → full stop via ONE backstop:** switcher-driven fast path + a restart-safe
   `vllm-reader-idle.timer`/`.service` polling `vllm:num_requests_running` with a stated 60 s interval
   / 300 s window, `PartOf` the reader. `RuntimeMaxSec` is explicitly NOT used (wrong primitive; would
   kill in-flight batches). Resolves finding #3 — no contradictory alternatives remain.
7. **Sudo grant expanded** to start/stop/reset-failed of coder + reader; operator must confirm
   `sudo -n` (build gate cannot).
8. **Reader batching generous** (`--max-num-seqs 16`, `--max-num-batched-tokens 8192`, CUDA graphs on)
   — provisional, operator tunes after the VRAM test.
9. **Quant: `modelopt_fp4` serve path VERIFIED in-tree; W4A4-vs-W4A16 is auto-decided by vLLM from the
   checkpoint config (verified in `quant-evidence/`); the only open question is SM120-KV dtype gating,
   with a concrete remote-patch grep as the DRY pre-check and a GPU-live serve test as the proof.** The
   W4A16 "different checkpoint" fallback is explicitly OUT OF SCOPE (separate task). Resolves finding #4.
10. **Gateway = `fill-first` with ERROR-DRIVEN overflow, NOT concurrency-cap-gated** (resolves finding
    #1): tier order is step order; tier-1→tier-2 overflow depends on the gremlin returning a retriable
    capacity status (implementer must confirm; else re-scope per §4.3); tier-2 "coding wins" is the
    switcher's 409; `maxConcurrent` rows are documentation only. `connectionId` is the verified
    dispatch pin (resolves finding #7); omniroute-routing.py specifics are "confirm against
    `/api/providers`".
11. **Auth = existing OmniRoute management key** the live builder uses, not the undeclared
    `omniroute_zoo_api_key`.

---

## 8. Response to the design review (iteration 2 → 3 ledger)

Verdict addressed: `CHANGES_REQUESTED` (3 HIGH, 5 MEDIUM, 2 NIT) from
`reader-fabric-design-review.json`. All ten findings ADDRESSED (none backlogged or ignored).

- **#1 (HIGH — `fill-first` does not enforce `maxConcurrent`, overflow premise false).** ADDRESSED by
  re-verifying the source: `applyStrategyOrdering.ts` wires `resolveMaxConcurrentByConnection` only in
  the `quota-share` branch and `makeConnectionConcurrencyResolver` only in round-robin; the
  `fill-first` branch only logs and advances on error. §4.2/§4.3/§4.4 rewritten to **error-driven
  overflow (reviewer option (a))**: tier order = step order; tier-1→tier-2 overflow depends on the
  gremlin returning a retriable capacity status, which the implementer MUST confirm (else re-scope per
  §4.3); `maxConcurrent` rows are demoted to documentation. No claim that `fill-first`+`maxConcurrent`
  yields the overflow remains.
- **#2 (HIGH — stop-the-other-first gaps: `is-failed` guard + `nvidia-smi` not on PATH).** ADDRESSED.
  (a) Added `reset-failed <target>` before every start (§3.3 step 2c) and to the sudo grant (§3.5 step
  3), so a deliberately-stopped coder is never refused by its own `is-failed` guard. (b) Replaced the
  `nvidia-smi` drain-wait with polling the other unit's `ActiveState`/`SubState` via the `systemctl
show` the switcher already runs (§3.3 step 2b), plus a 2 s settle delay; verified the switcher unit
  has no `path=` and only `SYSTEMCTL`/`SUDO` env (snapshot lines 185+), confirming `nvidia-smi` was
  unreachable.
- **#3 (HIGH — garbled idle-timer section, contradictory 300/1800, wrong `RuntimeMaxSec` semantic).**
  ADDRESSED. §3.5 rewritten to ONE backstop: a `vllm-reader-idle.timer`/`.service` polling
  `vllm:num_requests_running` (60 s interval, 300 s idle window, `PartOf` the reader) + the
  switcher-driven fast path. `RuntimeMaxSec` is explicitly rejected with the reason (hard wall-clock
  cap kills in-flight batches). No 1800 / `OnUnitInactiveSec` / dual-recommendation remains.
- **#4 (MEDIUM — W4A4-on-SM120 punted; no source dry pre-check; `/tmp` evidence; W4A16 fallback
  unscoped).** ADDRESSED. Added the source-level finding that vLLM auto-decides W4A4 vs W4A16 from the
  checkpoint config and auto-promotes weight-only `"NVFP4"` to `W4A16_NVFP4` (`quant-evidence/`
  lines 137–140, 775–791, 842). Added a concrete remote-patch grep as the remaining DRY pre-check for
  SM120-KV dtype gating (§3.6 step 4) with a required `quant-evidence/sm120-kv-gating.txt` artifact.
  Scoped the W4A16 "different checkpoint" fallback as OUT OF SCOPE (separate task). Moved evidence from
  `/tmp` into `quant-evidence/`.
- **#5 (MEDIUM — stale line citations).** ADDRESSED. Adopted cite-by-symbol as the policy; re-verified
  the few retained snapshot line numbers against the committed `esnixi-snapshot/` files:
  `active_requests = 0` → **line 54**; `LOCK_WAIT_SECONDS`/`MODEL_READY_SECONDS` → **21/22**;
  `switch_condition` → **52**; `mkVllmService` signature → **122**; coder ExecStart → **133**;
  `TimeoutStopSec` → **136** (noted as factory-inherited, not coder-specific); coder unit
  `systemd.services.vllm` → **149**; sudo grant → **178**; the 409 string → **234**; `is-failed`
  guard → **285**.
- **#6 (MEDIUM — `leaseWrap` left bimodal on the riskiest edit).** ADDRESSED. Committed to **wrap
  BOTH** coder and reader as the design decision (§3.3 step 5); the abandoned reader-only alternative
  is explicitly NOT to be implemented; the operator's role on the coder edit is reduced to
  post-`switch` verification.
- **#7 (MEDIUM — shared model string; connectionId dispatch unverified; omniroute-routing.py cites
  unverifiable).** ADDRESSED. Verified in OmniRoute source that `connectionId` is the dispatch pin
  (`combo/types.ts` field carried through `executeTargetAttempt.ts`), so identical model strings on
  different connections route to different GPUs. Downgraded all `omniroute-routing.py` specifics (UUIDs,
  cap values, line cites) to "candidates to confirm against live `/api/providers`" and marked the combo
  payload UUIDs as placeholders to fill from live config (§4.1, §4.4).
- **#8 (MEDIUM — rebase "clean" is a prediction, not a result).** ADDRESSED. §0/§1.2 now explicitly
  label the five "keep" rows as PREDICTED, with a note that the GNU-`patch --dry-run` matrix is RUN at
  implementation time against the resolved SHA (§1.3 step 1) and records actual offset/fuzz/FAIL; only
  the DROP is stated as a verified result (target code already present at the pin).
- **#9 (NIT — strategy count 19 vs 17).** ADDRESSED. Added a note that `ROUTING_STRATEGY_VALUES`
  (`src/shared/constants/routingStrategies.ts`) is authoritative; no strategy count is asserted
  elsewhere; the design relies only on `fill-first`, present in the enum.
- **#10 (NIT — `/tmp` evidence not reviewable).** ADDRESSED. Copied `vllm_quant_init.py` and
  `vllm_modelopt.py` into `quant-evidence/` next to `esnixi-snapshot/`; the SM120-KV grep output is
  also required to land there.

**Verified-assumption carry-over (re-confirmed this iteration):** the review's source-verified facts —
`fill-first` only preserves order (does NOT gate on caps), `maxConcurrent` wired only to
`quota-share`+round-robin, 409 not in the breaker set `{408,500,502,503,504}`, combo names allow `/`,
`createComboSchema`/`comboModelStepInputSchema` shape, `connectionId` on `ResolvedComboTarget` — were
re-read in source during this revision and are relied on as checked.

### 8.1 Response to the iteration-3 review (iteration 3 → 4 ledger)

Verdict addressed: `CHANGES_REQUESTED` (1 HIGH, 1 MEDIUM, 1 NIT) from the iteration-3
`reader-fabric-design-review.json`. All three findings CLOSED (none backlogged or ignored). Each fix
was verified against the committed `esnixi-snapshot/` files cited.

- **#1 (HIGH — `leaseWrap`'d coder `PermissionError`s on the uid-1000 `0600` lock → coder never
  starts after switch).** CLOSED. Confirmed the failure is real against the snapshots:
  `esnixi-snapshot/vllm-idle.nix` creates the lock `install -m 0600 -o 1000 -g 1000`; `vllm.nix`
  runs the units as `User/Group = vllm` with `isSystemUser = true` and no explicit uid (so vllm ≠
  uid 1000); `gpu_launch.py` line 6 `os.open(..., O_RDWR)` re-opens the file (does not inherit the
  fd). §3.3 step 5 now COMMITS to ONE scheme: change the `arcane-gpu-lock.service` `install` line to
  `-m 0660 -o root -g vllm` and add the uid-1000 vision-container identity to the `vllm` group, so
  BOTH principals open the lock `O_RDWR`. Rejected the world-RW and `uid=1000`-pin alternatives with
  reasons. Added a REQUIRED operator post-`switch` check (coder opens the lock, no `PermissionError`,
  serves on `:8010`, lock shows `-rw-rw---- root vllm`).
- **#2 (MEDIUM — reader readiness poll silently always-dead if MODELS `context` ≠ served
  `--max-model-len`).** CLOSED. §3.3 step 1 now sets `context = 65536` explicitly (not a separate
  placeholder), states the hard rule that the switcher MODELS `context` and the reader unit's served
  `--max-model-len` are a single coupled value that change together, and §3.4 carries the same
  coupling note on the `--max-model-len` line. Added switcher unit-test case (f) in §3.9 asserting the
  equality so drift fails CI instead of burning 540 s then 409-ing to M5 forever. Took the
  "state-the-coupling + add-test" option rather than relaxing the poll (keeps the poll's correctness
  guarantee that the backend actually serves the advertised context).
- **#3 (NIT — §2.3 omits `arcane-gpu-lock.service`'s dangling `before` on the retired unit).**
  CLOSED. §2.3 cleanup now includes dropping `docker-vllm-5090.service` from
  `arcane-gpu-lock.service`'s `before = [ "docker-vllm-5090.service" "docker-comfy-esnixi.service" ]`
  (VERIFIED in `esnixi-snapshot/vllm-idle.nix`), leaving `docker-comfy-esnixi.service` (if still
  present), and notes this is the same stanza whose `install` line is retargeted per §3.3 step 5.
