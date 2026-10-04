# Reader fabric + NVFP4-KV — design review (iteration 4)

Reviewer: design-review subagent, fresh read (no authoring context).
Inputs reviewed: `reader-fabric-design.md` (iteration 4), `reader-fabric-spec.md`, and the committed
`esnixi-snapshot/` files (`vllm-switch.py`, `gpu_launch.py`, `arcane_gpu.py`, `vllm_idle.py`,
`vllm.nix`, `vllm-idle.nix`) plus `quant-evidence/`.

This is a RESUME review of a HIGH-RISK infra change on a live RTX 5090 whose coder is the user's
primary coding model. Per the brief, scope is narrow: judge ONLY whether the three iteration-3
findings (1 HIGH lock-permission, 1 MEDIUM reader-readiness context coupling, 1 NIT dangling
`before=`) are now correctly closed, and whether the fixes introduced any new HIGH/MEDIUM regression.
I re-read every snapshot the fixes lean on. All three findings are genuinely closed and no new
blocker was introduced. **Verdict: APPROVED.**

---

## Resolution of the three open findings

### iter-3 #1 (HIGH — `leaseWrap`'d coder cannot open the uid-1000 `0600` lock → coder never starts after switch) — CLOSED

The design (§3.3 step 5) now commits to ONE concrete scheme instead of leaving the permission gap to
`switch`-time discovery. I verified every load-bearing fact against the committed snapshots:

- **Lock is `0600`, owner uid/gid 1000.** VERIFIED — `esnixi-snapshot/vllm-idle.nix`
  `systemd.services.arcane-gpu-lock.script`: `install -m 0600 -o 1000 -g 1000 /dev/null
/run/arcane-gpu/5090.lock` (inside an `if [ ! -e … ]` guard on a `RuntimeDirectory` tmpfs).
- **Native vLLM units run as `vllm`, a system user with no explicit uid.** VERIFIED —
  `esnixi-snapshot/vllm.nix`: `mkVllmService` `serviceConfig` sets `User = "vllm"; Group = "vllm";`,
  and `users.users.vllm = { isSystemUser = true; group = "vllm"; … }` with no `uid` ⇒ allocated from
  the system range (<1000), so `vllm` ≠ uid 1000.
- **`gpu_launch.py` RE-opens the lock (does not inherit an fd).** VERIFIED —
  `esnixi-snapshot/gpu_launch.py` line 6: `fd = os.open(os.environ["ARCANE_GPU_LOCK"], os.O_RDWR)`.
  The `ARCANE_GPU_LOCK_FD` inheritance in `arcane_gpu.py::from_environment` applies to the vLLM
  process launched _after_ `gpu_launch.py` already opened the fd — it does not spare `gpu_launch.py`
  itself from needing `O_RDWR` on the file. So the EACCES risk is real for the wrapped coder.

The committed fix picks **one** scheme — change the `arcane-gpu-lock.service` `install` line to
`-m 0660 -o root -g vllm` AND add the uid-1000 vision-container identity to the `vllm` group — so BOTH
principals that must open the lock (`vllm` user via group `rw`; uid-1000 vision container via
supplementary group membership) can `O_RDWR` it. This is consistent with the real install line and the
`User/Group = vllm` in the snapshots. The two alternatives are explicitly rejected with reasons: a
world-RW `0666` flock (broader than necessary) and pinning `users.users.vllm.uid = 1000` (collides
with / conflates the vision identity). The advisory `LOCK_EX`/`LOCK_UN` and fd-release-on-death
semantics are owner-independent, so group-read access is sufficient for correctness.

A REQUIRED operator post-`switch` check is added and matches the brief: after `nixos-rebuild switch`,
confirm `journalctl -u vllm` shows no `PermissionError` from `gpu_launch.py`, `ls -l
/run/arcane-gpu/5090.lock` shows `-rw-rw---- root vllm`, and `curl -s 127.0.0.1:8010/v1/models` lists
`qwen3.8-27b-nvfp4` (the coder serving on :8010). The design correctly notes the `nixos-rebuild build`
gate cannot verify runtime file permissions, so this is operator-only. All four of the brief's HIGH-#1
criteria (one scheme; openable by vllm user AND uid-1000 vision container; consistent with the real
install line + vllm User/Group; operator post-switch :8010 check) are met.

### iter-3 #2 (MEDIUM — reader readiness poll silently always-dead if MODELS `context` ≠ served `--max-model-len`) — CLOSED

VERIFIED against `esnixi-snapshot/vllm-switch.py` `select_model`: the readiness poll returns success
only when a backend `/v1/models` item satisfies BOTH
`item.get("id") == selected["served"]` AND `item.get("max_model_len") == selected["context"]`. The
poll targets `BACKEND = http://127.0.0.1:8010` (the real vLLM, which emits `max_model_len`), not the
switcher's own `/v1/models` (which emits `context_length`) — so the design's choice to pin the vLLM
unit's served `--max-model-len` to the MODELS `context` is the correct knob.

The design now pins both to `65536` and makes the coupling an explicit hard rule in three places:
§3.3 step 1 (`context = 65536`, "a single coupled value — change both or neither"), §3.4 (same note on
the `--max-model-len 65536` line, including that an operator VRAM-headroom bump must mirror into
`context` in the same change), and §3.9 test case (f): a switcher unit test asserting
`MODELS["qwen3.5-9b-nvfp4-reader"]["context"]` equals the served `--max-model-len`, so a future drift
fails CI rather than burning the full `MODEL_READY_SECONDS` (540 s) and 409-ing to M5 forever. The
design took the "state-the-coupling + add-test" option (preserving the poll's correctness guarantee)
rather than relaxing the poll — a sound choice, and the brief accepted either. Closed.

### iter-3 #3 (NIT — §2.3 omits the dangling `arcane-gpu-lock.service` `before=` on the retired unit) — CLOSED

VERIFIED against `esnixi-snapshot/vllm-idle.nix`: `systemd.services.arcane-gpu-lock.before = [
"docker-vllm-5090.service" "docker-comfy-esnixi.service" ]`. §2.3 now explicitly adds this stanza to
the cleanup: drop the `docker-vllm-5090.service` entry (leaving `docker-comfy-esnixi.service` if that
unit still exists), correctly notes it is a harmless NIT (systemd ignores ordering deps on absent
units, not an eval error), and that this is the same `arcane-gpu-lock.service` stanza whose `install`
line is retargeted per §3.3 step 5. Closed.

---

## New-regression check (did the fixes break anything HIGH/MEDIUM?)

- **The `0660 root:vllm` scheme + vision group-add does not break the vision container.** The vision
  container's `gpu_launch.py` also does `os.open(…, O_RDWR)`; under the current `0600`/uid-1000 it
  works because the container runs as uid 1000. Under the new scheme it would lose access UNLESS added
  to the `vllm` group — which the design explicitly does. The advisory-flock semantics and
  `ARCANE_GPU_LOCK_FD` inheritance are unaffected by owner/group. No regression. (The design uses a
  `<vision-uid-1000-user>` placeholder because the vision container's user declaration lives in
  `ai.nix`, not in `esnixi-snapshot/`; this is an implementer-fill against live config, not a design
  gap — the mechanism, `extraGroups`/`--group-add` to `vllm`, is committed. It is NOT a finding: the
  operator :8010 check plus a live vision-container smoke are implementation-time concerns, and the
  brief scopes HIGH-#1 to the coder, which the design verifies.)
- **The `install` line change lands in the SAME `arcane-gpu-lock.service` stanza as the NIT `before=`
  cleanup.** The design calls this out (§2.3 and §3.3 step 5 cross-reference each other), so the two
  edits do not collide or double-define the unit. No contradiction.
- **`context = 65536` coupling introduces no conflict** with §3.4 (`--max-model-len 65536`), §3.6
  (operator serve test asserts `max_model_len == 65536`), or §3.9 (test (f)). All four references now
  carry the identical value and the "change both together" rule. Consistent.
- **No already-resolved iteration-2→3 item was reopened or altered** in a way that regresses it; §8 /
  §8.1 ledgers are intact and the iteration-3 content is otherwise unchanged, as the brief required.

---

## Verified assumptions (checked against the snapshots this review)

- Lock creation line, owner, mode, and the `if [ ! -e ]` guard — `esnixi-snapshot/vllm-idle.nix`
  `arcane-gpu-lock.script`.
- `arcane-gpu-lock.service` `before = [ "docker-vllm-5090.service" "docker-comfy-esnixi.service" ]` —
  same file.
- `User = "vllm"; Group = "vllm";` in `mkVllmService` serviceConfig; `users.users.vllm` is
  `isSystemUser = true` with no explicit uid; coder ExecStart is a flat `vllm serve …` hardcoding
  `--kv-cache-dtype nvfp4` and port 8010 with NO `gpu_launch.py`; `mkVllmService` accepts a
  `conflicts ? [ ]` arg; sudo grant is `start vllm.service` NOPASSWD only — all
  `esnixi-snapshot/vllm.nix`.
- `gpu_launch.py` line 6 `os.open(ARCANE_GPU_LOCK, O_RDWR)`, then `LOCK_EX`, `set_inheritable`,
  export `ARCANE_GPU_LOCK_FD`, `execvp` — `esnixi-snapshot/gpu_launch.py`.
- `GPULease.from_environment` inherits the fd via `ARCANE_GPU_LOCK_FD` (why the in-container vLLM
  process does not re-open, but `gpu_launch.py` itself always does) — `esnixi-snapshot/arcane_gpu.py`.
- `select_model` readiness poll requires `id == served` AND `max_model_len == selected["context"]`
  against `BACKEND` (:8010); 409 string `"RTX 5090 is busy; use the next OmniRoute fallback"`;
  `LOCK_WAIT_SECONDS = 3`, `MODEL_READY_SECONDS = 540`; switcher `/v1/models` emits `context_length`
  (distinct from the backend's `max_model_len`, which is what the poll checks) —
  `esnixi-snapshot/vllm-switch.py`.

## Unverified / wrong assumptions

- **(acknowledged by the design, acceptable) The vision container's uid-1000 user name.** The design
  uses a `<vision-uid-1000-user>` placeholder and commits to the group-add mechanism; the concrete
  user name must be filled from live `ai.nix`/container config at implementation time. Not a finding —
  the design does not assert a specific name as verified, and the brief scopes HIGH-#1 to the coder.
- **(acknowledged, acceptable) `sudo -n` works at runtime for the expanded switcher command set;
  gremlin at-capacity returns a retriable status; the five "keep" patches rebase clean; live
  `/api/providers` UUIDs/served strings.** All correctly carried as operator/implementer-time
  confirmations, not verified facts. These are pre-existing (iteration-2→3) and out of this resume's
  scope.

---

## Verdict

Open HIGH findings: 0. Open MEDIUM findings: 0. Open NIT findings: 0.
HIGH+MEDIUM count = 0 → **APPROVED**.

All three iteration-3 findings are correctly closed and each fix was re-verified against the committed
snapshots it cites. The lock-permission scheme is concrete, single, and openable by both principals
with a real operator :8010 post-switch check; the reader `context`/`--max-model-len` coupling is
pinned with a CI test guard; the dangling `before=` is swept. No fix introduced a new HIGH/MEDIUM
regression. The design is ready for implementation under its own DRY-validate-only / operator-switch
split.
