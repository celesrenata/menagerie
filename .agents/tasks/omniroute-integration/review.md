# NVFP4 reader fabric on the RTX 5090 — semantic review

The diff lands four coupled subsystems on a live, single-tenant RTX 5090 whose primary occupant is
the user's coder (`qwen3.8-27b-nvfp4`): a vLLM overlay bump + five-patch rebase, retirement of the
stock `docker-vllm-5090` OCI fallback onto a dormant native unit, a new NVFP4 9B reader governed by
the switcher as sole tenancy authority with an idle-stop backstop and the arcane-gpu lock fix, and an
OmniRoute `hybrid/reader` tiered combo. The approach matches the approved iteration-4 design: the
switcher is the only actor that starts/stops either heavy unit, both heavy units are flock-wrapped via
`gpu_launch.py`, the reader fully terminates on idle so VRAM returns, and the gateway falls through
tiers on error (switcher 409 / capacity error), not on a concurrency cap. The implementer respected
the DRY boundary — `nixos-rebuild build` only, no `switch`, no `systemctl`, no GPU-live load, no
mutating combo POST — and queued every live action as an operator command.

Watch for: (1) the diff's actual baseline on esnixi `main` is vLLM **0.27.1 with one patch** and a
_different_ coder model (`Qwen3.6-35B-A3B`, no `--kv-cache-dtype nvfp4`), **not** the
`0.31.0.dev0+gddd6fbca`/six-patch/Qwen3.8-27B baseline the spec, design, and verification log all
describe — so this commit both reconstructs the snapshot config AND adds the reader fabric in one
move (confirmed, non-blocking but materially changes what "rebase" means here); (2) `ai.nix` flips
`services.ollama.enable` false→true and repurposes the OCI container into a Qwen2.5-VL vision service
— real behavior changes bundled beyond the design's "retire the fallback" scope (confirmed); (3) the
`0660 root:vllm` lock fix is correct and the design's "add uid-1000 to vllm group" step is a verified
no-op, but the runtime proof is operator-only and the stale-inode caveat is real (confirmed).

**Verdict**: APPROVED

## High-level view

The lock-ownership change — the single most dangerous edit, since the wrapped coder cannot start if
it is wrong — is correct. The lock moves from `0600 1000:1000` to `0660 root:vllm`. The native vLLM
units run as user `vllm` and `gpu_launch.py` re-opens the file `O_RDWR`, so `vllm` needs group rw; the
vision container opens it as host root (Docker, no userns-remap) so it is unaffected. The design's
"add the uid-1000 vision identity to the vllm group" step correctly resolved to a no-op: uid-1000 is
the human `celes`, not a lock opener, and the vision container is root. The only residual risk is a
stale `0600 celes:celes` inode surviving on the tmpfs across the switch — the install script only
creates the lock when absent — which the operator queue explicitly handles with an `rm` + restart.

The reader `context`/`--max-model-len` coupling is intact: the unit serves `--max-model-len 65536`,
`MODELS["qwen3.5-9b-nvfp4-reader"]["context"]` is 65536, and `select_model`'s readiness poll requires
`max_model_len == context`. Test (f) asserts the equality so a future drift fails CI instead of
silently always-dead-ing the reader tier.

The switcher remains the single tenancy authority. `select_model` stops every other vLLM unit, drains
on the unit's own `ActiveState`/`SubState` (not `nvidia-smi`, which is off its hardened PATH) with a
settle delay, `reset-failed`s the target, guards on `is-failed`, then starts — all under
`switch_condition` and only when `active_requests == 0`, so no coder generation is ever mid-flight
when the coder is stopped. `reset-failed` is in the six-command sudo grant.

The patch rebase dropped the upstreamed `vllm-flashinfer-mm-prefix-seqlens` and kept the five SM120/
NVFP4 patches, with all five now tracked in HEAD (the §27 fix to a prior blocking finding) and three
hashes recomputed. The pinned-rev build is GREEN per the verification log; the SM120 KV path is gated
only on `--kv-cache-dtype` + compute capability, not on the W4A4/W4A16 weight scheme, so the
auto-promotion of the AxionML checkpoint is a non-issue at the config layer.

The gateway combo is `fill-first` with three steps pinned by distinct `connectionId` (the dispatch
pin), the `ollama/` served prefix on tiers 1/3 and `vllm/qwen3.5-9b-nvfp4-reader` on tier 2, and
`context_length` 32768. The committed test confirms step order, distinct pins for the two identical
model strings, and that 409 is not a provider-breaker status so it only advances the tier.

The DRY boundary held. Every `switch`, `systemctl`, GPU-live load, `sudo -n` confirmation, and combo
POST is queued as an operator command; nothing mutating was executed.

<details>
<summary>Issues (3)</summary>

1. **Baseline divergence (non-blocking, operator must know)** — The committed diff is taken against
   esnixi `main`, where `overlays/vllm.nix` is vLLM `0.27.1` with a single patch and
   `esnixi/vllm.nix` serves a different coder (`Qwen3.6-35B-A3B-NVFP4`, no `--kv-cache-dtype nvfp4`,
   `pkgs.vllm` not `pkgsAccel.vllm`, no switcher/sudo scaffolding). The spec/design/verification were
   authored against the `esnixi-snapshot/` tree (Qwen3.8-27B, 0.31-era, six patches). This commit
   therefore both reconstructs the snapshot config and adds the reader fabric. The pinned-rev build
   is GREEN so the result is coherent, but the operator should confirm `main` is genuinely behind the
   snapshot (not a conflicting fork) before `switch`, since the deployed coder model/args change as a
   side effect.
2. **Bundled `ai.nix` behavior changes beyond "retire the fallback"** — The diff flips
   `services.ollama.enable` false→true and converts `vllm-5090` into a `vllm-vision-5090` Qwen2.5-VL
   service (new model, loopback `:8011`, `VLLM_IDLE_SECONDS=300`, idle middleware). These are real
   runtime changes the design did not call for in §2 (which only retires the OCI fallback). They
   build and are internally consistent, but the operator should verify enabling Ollama on esnixi and
   adding a vision service are intended on this host, since neither is required by the reader fabric.
3. **Lock stale-inode + runtime perms are operator-gated** — The `0660 root:vllm` scheme is correct,
   but `arcane-gpu-lock.service` only `install`s the lock when it does not exist, so a pre-existing
   `0600 celes:celes` inode on the tmpfs will not be rewritten by the switch. The operator queue
   handles this (`rm` + `restart` + `ls -l` check + `journalctl` for `PermissionError`); the
   `nixos-rebuild build` gate cannot prove runtime file permissions. Must pass the post-switch check
   before starting the reader.

</details>

<details>
<summary>Details</summary>

### The lock fix lets the wrapped coder open the flock without breaking the vision container

This is the edit that can take the coder down, so it earns the most scrutiny. In
`esnixi/vllm-idle.nix` the `arcane-gpu-lock.service` install line moves from
`install -m 0600 -o 1000 -g 1000 …` to `install -m 0660 -o root -g vllm …`. The coder and reader are
now `leaseWrap = true`, so their `ExecStart` is prefixed with `python3 gpu_launch.py …`, and
`gpu_launch.py` does `os.open(ARCANE_GPU_LOCK, O_RDWR)` as user `vllm`. Under the old
`0600 1000:1000` that open would `EACCES` for `vllm` (a system uid, not 1000) and raise before
`execvp`, so the coder would never reach vLLM — the exact catastrophic failure the design's finding
#1 names. `0660 root:vllm` gives the `vllm` group rw.

The implementer resolved the design's `<vision-uid-1000-user>` placeholder against the live config
rather than mechanically adding a group: it verified there is no userns-remap anywhere, so the vision
container runs as host root and opens the lock regardless of mode/owner, and that `getent passwd 1000`
is `celes` (the human), who is not a lock opener. So "add the uid-1000 identity to the vllm group" has
no valid target and is correctly a no-op; adding `celes` would be a broader grant than needed. This is
sound reasoning, not a shortcut. The one runtime risk the build cannot cover is a stale lock inode
from the old scheme surviving on the tmpfs — the script only creates when absent — and that is
explicitly handled in the operator queue with an `rm` + `systemctl restart arcane-gpu-lock.service`
and an `ls -l`/`journalctl` verification before the reader is ever started.

### Switcher stop → drain → reset-failed → start, under the active-requests gate

`select_model` iterates `other_units(target)`, and for any that is not already inactive/failed calls
`stop_and_drain`, which issues `sudo -n systemctl stop`, then polls `unit_state` (one
`systemctl show --value --property=ActiveState --property=SubState`) until `ActiveState` is
`inactive`/`failed` and `SubState` is `dead`/`failed`/empty, then sleeps `DRAIN_SETTLE_SECONDS` before
returning. Draining on the unit's own state rather than `nvidia-smi` is deliberate and correct —
`nvidia-smi` is not on the hardened switcher unit's PATH. After the drain it `reset-failed`s the
target (clearing a stale failed state so the subsequent `is-failed` guard does not refuse a
deliberately-stopped unit), re-checks `is-failed`, records `NRestarts`, starts, and polls `/v1/models`
for `id == served AND max_model_len == context`. All of this runs inside `acquire_model`'s
`switch_condition` critical section, entered only when `active_requests == 0`, so a coder generation
is never interrupted mid-flight. Test (b) pins the stop→reset-failed→start order; test (a) asserts the
two units are never both active; test (e) covers the 409-on-timeout path with the exact string.

The idle path uses a monotonic generation counter: `release_model` arms a `threading.Timer` when a
reader unit falls to zero in-flight, and a later request bumps the generation so a stale stop no-ops.
Tests (c) and (d) cover expiry and cancellation. The restart-safe backstop is a separate
`vllm-reader-idle.timer`/`.service` pair polling `/metrics` for `num_requests_running` +
`num_requests_waiting`, writing a last-nonzero timestamp and stopping only after 300s idle; it runs as
root (no sudo), is `partOf` + `wantedBy` the reader so it lives exactly while the reader is active, and
treats unreadable metrics as busy (fail-safe, won't stop a reader whose metrics endpoint is
briefly unreachable). `RuntimeMaxSec` was correctly rejected as the idle primitive.

### Patch rebase kept five, dropped the upstreamed one, and the files are committed

`overlays/vllm.nix` pins vLLM to `f42629247d…` (`v0.31.0rc3`), lists the five keep-patches
(`sm120-fp4-support`, `sm120-nvfp4-kv`, `sm120-nvfp4-q-dequant`, `flashinfer-gdn-api`,
`flashinfer-nvfp4-noncausal`) and drops `flashinfer-mm-prefix-seqlens` whose target code is already
present at the pin. All five are tracked in HEAD — the §27 fix to the earlier blocking finding where
four were intent-to-add only — and the three hashes (src, cargoDeps-from-src, cargoDeps vendor) are
recomputed. The verification log records a GREEN `nixos-rebuild build` and, decisively, a GREEN
`nix build git+file://…?rev=46fd036` which only sees git-tracked content, proving the commit is
self-contained. The `sm120-kv-gating.txt` artifact shows the NVFP4-KV kernel branches on the
`--kv-cache-dtype` string + compute capability, not on W4A4/W4A16, so the AxionML checkpoint's
weight-only→W4A16 auto-promotion is a non-issue for `--kv-cache-dtype nvfp4`. The overlay also carries
unrelated-looking churn (FlashInfer `0.6.14`→`0.6.18`, deepgemm/deepselect/flashkda cmake drops, cupy/
opencv dependency filters) — these are part of moving from the `0.27.1` main baseline up to the
`0.31rc3` snapshot-era build, consistent with the baseline-divergence observation.

### Baseline divergence changes what this diff actually is

The spec, design, and verification all assert the live coder is `qwen3.8-27b-nvfp4` on
`0.31.0.dev0+gddd6fbca` with six patches and `--kv-cache-dtype nvfp4` already. The actual `main` the
diff edits serves `nvidia/Qwen3.6-35B-A3B-NVFP4` on vLLM `0.27.1` with one patch, `pkgs.vllm`, no
kv-cache-dtype flag, and no switcher/sudo/sops scaffolding at all. The `esnixi/vllm.nix` diff is
therefore not an incremental edit of the running coder — it reconstructs the entire snapshot config
(the `mkVllmService` factory, CUDA13 toolkit wiring, FlashInfer 0.6.18, the switcher unit, sops
secrets) and layers the reader fabric on top. The result builds at the pinned rev, so it is coherent,
but the operator must confirm that `main` is genuinely stale relative to what is deployed — if the
live machine is actually running something closer to `main` (the 35B model), this switch changes the
coder model and serving args as a side effect, which is a bigger live change than "add a reader."

### Bundled vision/ollama changes in ai.nix

Beyond retiring `docker-vllm-5090`, `modules/profiles/ai.nix` sets `services.ollama.enable = true`
(was false) and rebuilds the former `vllm-5090` container as `vllm-vision-5090` serving
`Qwen2.5-VL-7B-Instruct` on loopback `:8011` with the idle-sleep middleware and `VLLM_IDLE_SECONDS`
raised 5→300 (with a comment that 5s raced OmniRoute health checks). These are legitimate, internally
consistent changes, but they are not what design §2 scoped (retire the fallback onto a dormant native
unit), and they alter host behavior independently of the reader fabric. Non-blocking, but the operator
should confirm both are intended on esnixi.

### Gateway combo pins by connectionId with the ollama/ prefix

`home/programs/omniroute-routing.py` adds `hybrid/reader` to `NAMES` and a `desired()` branch:
`fill-first` with `reader-t1-gremlin-4070ti` → `ollama/qwen3.5-reader:9b` @ ollama-local,
`reader-t2-esnixi-5090` → `vllm/qwen3.5-9b-nvfp4-reader` @ vllm, `reader-t3-m5max` →
`ollama/qwen3.5-reader:9b` @ ollama-m5-reader, `context_length = 32768`. The `target()` helper derives
`providerId` from the model-string prefix (`ollama`, `vllm`) and pins `connectionId` from the named
CONNECTIONS map. The design's §4.4 placeholder used `providerId: "ollama-local"`; the implementation
uses `providerId: "ollama"` to match the real served prefix, which is correct — `connectionId` is the
dispatch pin (`normalizeComboModels` preserves it; `executeTargetAttempt` keys on it), so `providerId`
is categorical and the two identical-model-string tiers still route to distinct GPUs. The committed
test re-run passes 4/4 and asserts exactly this (order, distinct pins, 409-not-a-breaker). The live
`/api/providers` confirmation that both ollama connections actually advertise `qwen3.5-reader:9b` and
that the esnixi connection carries `vllm/qwen3.5-9b-nvfp4-reader` is correctly left to the operator
post-switch (DRY boundary), as is the gremlin at-capacity behavior that gates tier-1→tier-2
busyness overflow.

### DRY boundary respected

The verification log shows only `nixos-rebuild build`, `nix build` at the pinned rev, `patch
--dry-run`, hash-prefetch loops, read-only greps, `py_compile`, the switcher unit tests, and the
focused OmniRoute test. Every `switch`, `systemctl start/stop`, GPU-live serve, `sudo -n`
confirmation, live `/api/providers` recon, and combo POST is enumerated under "OPERATOR-ONLY commands
queued." The read-only gateway recon was blocked by auth (401/403) and correctly stopped rather than
guessing, deferring to the operator with the materialized zoo key. No mutating action was taken.

</details>

<details>
<summary>File map</summary>

esnixi (`feat/nvfp4-reader-fabric` @ `46fd036`, not pushed):

- `esnixi/vllm-idle.nix` — lock fix `0600 1000:1000`→`0660 root:vllm`; retire docker-vllm-5090 idle override + OCI stanza; trim `before`.
- `esnixi/vllm.nix` — `mkVllmService` + `leaseWrap`; coder/reader/dormant-fallback units; six-command switcher sudo grant; switcher unit; `vllm-reader-idle` timer+service.
- `esnixi/vllm-switch.py` — new switcher: reader MODELS entry (context 65536), stop→drain→reset-failed→start, idle generation counter.
- `esnixi/test_vllm_switch.py` — six-case switcher unit test (a–f).
- `modules/profiles/ai.nix` — retire docker-vllm-5090; enable ollama; vllm-5090→vision Qwen2.5-VL.
- `overlays/vllm.nix` — vLLM `0.27.1`→`0.31.0rc3`, five patches, three hashes, FlashInfer 0.6.18, cmake/dep filters.
- `patches/vllm-{sm120-fp4-support,sm120-nvfp4-kv,sm120-nvfp4-q-dequant,flashinfer-gdn-api,flashinfer-nvfp4-noncausal}.patch` — the five kept patches, now tracked.
- `home/programs/omniroute-routing.py` — `hybrid/reader` fill-first combo builder + CONNECTIONS map.

OmniRoute (`feat/hybrid-reader-combo` @ `8e046cb57`, not pushed):

- `tests/unit/combo/hybrid-reader-combo.test.ts` — payload schema, tier order, distinct pins, 409-not-a-breaker (4/4 pass).

Full diffs: `git diff main...feat/nvfp4-reader-fabric` (esnixi, over SSH) and
`git diff release/v3.8.52...feat/hybrid-reader-combo` (OmniRoute, local).

</details>
