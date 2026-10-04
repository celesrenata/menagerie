# Verification — Reader-Fabric + Coder-Context Change

Status: ITERATION 2 — review findings addressed. Commit amended to **101c5c9** (was c97136b).

## ITERATION 2 — review fixes (addresses review.json CHANGES_REQUESTED)

Reviewer verdict was CHANGES_REQUESTED with one blocking finding and one cosmetic finding.
Both are now fixed; the informational finding (new-files vs line-edits description) needed no code change.

### Finding 1 (BLOCKING) — reader-service change contradicted the evidence — FIXED by revert

The prior commit c97136b changed the dormant `vllm-reader` unit relative to its parent 46fd036
(gpuMemoryUtilization 0.85 -> kvCacheMemory 17824719667, maxNumSeqs 16 -> 24, added
`--linear-backend cutlass`, plus a new `vllm-reader-model-loader` oneshot) while this doc claimed
the reader was "entirely UNTOUCHED" and the reader was never started to verify it. That claim was
factually wrong (the earlier text mistook the committed 24/16.6 GiB values for the HEAD~1 baseline;
HEAD~1 46fd036 actually had 0.85/16/8192 and no loader unit).

Resolution chosen = review option (a) **revert the reader unit to its HEAD~1 state** rather than
option (b) start-and-verify, because option (b) requires `sudo nixos-rebuild switch` and this agent
SSH session has NO passwordless sudo (`sudo -n true` -> "a password is required", re-confirmed this
iteration). The revert is behavior-preserving (restores the reader byte-identical to its pre-task
state) and matches this doc's own final "no concurrency change on either service" decision.

Commands + evidence (esnixi, `~/sources/celesrenata/nix-flakes-refactored`):

- Reverted `systemd.services.vllm-reader` to 46fd036: `gpuMemoryUtilization "0.85"`, `maxModelLen
"65536"` (coupling preserved), `maxNumSeqs "16"`, `extraArgs` without `--linear-backend cutlass`;
  removed the `vllm-reader-model-loader` unit entirely.
- `diff <(git show 46fd036:esnixi/vllm.nix | sed -n '/vllm-reader = /,/^  };/p') <(sed -n '/vllm-reader = /,/^  };/p' esnixi/vllm.nix)` -> **READER IDENTICAL TO HEAD~1** (empty diff).
- `git diff 46fd036 HEAD -- esnixi/vllm.nix` now shows ONLY the coder change (gpuMemoryUtilization
  0.88/147456 -> kvCacheMemory 4776620811/131072, maxNumSeqs stays 1) + the mkVllmService default
  maxModelLen -> 131072 and the kvCacheMemory param. The vllm-reader block and the loader unit are
  absent from the diff.
- Switcher coupling test still passes: `python3 -m unittest test_vllm_switch -v` -> **6/6 OK**
  (incl. `test_f_context_matches_served_max_model_len`, reader context == 65536).
- `nix build .#nixosConfigurations.esnixi.config.system.build.toplevel --no-link` -> **BUILD_EXIT=0**
  (8 derivations built; only cosmetic stdenv deprecation warnings). Reverted config evaluates cleanly.

### Finding 2 (non-blocking, cosmetic) — stale 5090 preview string — FIXED

`home/programs/omniroute-mode.py:360` dry-run preview changed from
`'5090 MTP: one 147456-context request at 88% VRAM. ...'` to
`'5090 MTP: one 131072-context request (fixed kvCacheMemory ~4.45 GiB). ...'`. The 4070 IQ3 clause
in the same string legitimately stays 147456. `grep -rniE "147456|114688" esnixi/ home/` now returns
ONLY the deliberately-kept 4070 Ti Super IQ3 lane refs (Modelfile num_ctx 147456, omniroute-mode.py:50
comment, the 4070 clause in :360, SKILL.md:14 4070 line, routing.py:197 4070 IQ3 guard) — zero stale
5090/coder references. `python3 -c ast.parse` on omniroute-mode.py -> OK.

### Finding 3 (informational) — no action

omniroute-mode.py (+373) and zoo-spec-setup.py (+79) are committed as new files, not line edits.
Content is correct (confirmed in iter-1 evidence below); description/diff-shape mismatch only.

### Live state observed this iteration (read-only)

- `vllm.service` ACTIVE and already restarted at the committed 131072 config (journal pid 1525231,
  ActiveEnter 2026-10-01 20:24:01): non-default args show `max_model_len 131072`,
  `kv_cache_memory_bytes 4776620811`, `max_num_seqs 1` — the Part 2 coder narrowing IS live.
- `nvidia-smi` -> 32607 total / **21878 used / 10324 free** MiB. Coder at the narrower 131072 uses
  LESS VRAM than before; 10.3 GiB free, no OOM. (Part 3 collapsed to no-concurrency-change, so this
  headroom is simply gained, as designed.)
- `vllm-reader.service` INACTIVE (switcher-controlled, wantedBy=[]); the reverted reader config takes
  effect on the next activation. NOT started here (no sudo; and it is mutually exclusive with the
  live coder).

### Amended commit

- esnixi flake: branch `feat/nvfp4-reader-fabric`, **101c5c9** (amended from c97136b) — same 6
  task-scoped files; vllm.nix now 8 insertions (was 48) after the reader revert. NOT pushed.
- Part 1 ollama commit **890004e** unchanged (NOT pushed).

---

## (Iteration 1 record below — retained for history; the "reader untouched" claims in it were

## INCORRECT re: the committed diff and are superseded by the Iteration 2 revert above.)

Status: IN PROGRESS — paused on a behavior decision (4070 IQ3 coder lane, see "OPEN DECISION" below).

Host/repo: esnixi (RTX 5090) `celes@192.168.42.254:sources/celesrenata/nix-flakes-refactored`, branch
`feat/nvfp4-reader-fabric`. Edits applied in the working tree, NOT yet committed, NOT yet applied with
nixos-rebuild (so the live coder is still serving at 147456 and has NOT been restarted).

## Commands run so far

### Pre-flight / investigation

- `ssh celes@192.168.42.254 'git branch --show-current'` → `feat/nvfp4-reader-fabric` (correct).
- `grep -n "qwen3.5-reader:9b|num_ctx 131072" /Users/celes/sources/kube/ollama/values.yaml` →
  lines 76-77 present (postStart creates `qwen3.5-reader:9b` FROM `qwen3.5:9b`, `num_ctx 131072`). PART 1 edit confirmed present.
- Coupled-site line numbers confirmed to match the plan:
    - `esnixi/vllm.nix`: 122 (default maxModelLen), 166 (kvCacheMemory), 167 (coder maxModelLen), 169 (coder extraArgs).
    - `esnixi/vllm-switch.py`: 41, 48 (coder + -balanced context), 60 (reader context 65536 — NOT touched), 205 (`max_input_tokens = context - 32768` derived).
    - `home/programs/omniroute-routing.py`: 195/197 (4070 IQ3 coder apply guard), 202/204 (5090 vLLM coder layout), 88-104 (hybrid/reader fabric).
    - `home/programs/zoo-spec-setup.py`: 49 (local/5090 contextWindow).
    - `home/programs/omniroute-mode.py`: 318 (doc string).

### Part 2 — coder context 147456 → 131072 (edits applied to working tree)

- `esnixi/vllm.nix:167` `maxModelLen "147456" → "131072"` (coder `vllm.service`). Reader 65536 and fallback 24576 untouched.
- `esnixi/vllm.nix:122` default `maxModelLen ? "147456" → "131072"` (coherence; coder sets it explicitly so no live effect).
- `esnixi/vllm-switch.py:41,48` `"context": 147456 → 131072` (coder + `-balanced`). Derived `max_input_tokens` = 131072 − 32768 = **98304** (line 205, automatic — confirmed in source, no separate edit).
- `home/programs/omniroute-routing.py:204` `"vllm/qwen3.8-27b-nvfp4": (147456, 114688) → (131072, 98304)` (the 5090 vLLM coder layout — authoritative, in scope).
- `home/programs/zoo-spec-setup.py:49` `contextWindow 147456 → 131072` (local/5090 profile).
- `home/programs/omniroute-mode.py:318` doc string `147456 → 131072` for the 5090/4070 lines.
- Coupling confirmed: switcher readiness poll (line ~452) requires served `max_model_len == MODELS[...]["context"]`;
  vllm.nix:167 (131072) and vllm-switch.py:41/48 (131072) now agree.

Verify:

- `python3 -m unittest test_vllm_switch -v` (in `esnixi/`) → **6/6 OK**, incl. the coupling guard
  `test_f_context_matches_served_max_model_len` (asserts reader context == 65536, untouched).
- `python3 -c ast.parse` on routing.py / zoo-spec-setup.py / omniroute-mode.py / vllm-switch.py → all parse OK.
- `grep -rniE "147456|114688" esnixi/ home/` remaining hits (see OPEN DECISION):
    - `home/programs/omniroute-qwen38-4070.Modelfile:2` `num_ctx 147456` — the 4070 IQ3 coder's actual Modelfile.
    - `home/programs/omniroute-routing.py:197` — 4070 IQ3 coder apply guard (reverted to 147456, see below).
    - `home/programs/omniroute-routing-mode.SKILL.md:14` — doc mentioning both the 5090 (now stale) and the 4070 (147456, correct).

### Part 3 — FINAL DECISION: NO concurrency change on either service

Per the user's final decision, Part 3 collapses to nothing beyond Part 2's context narrow. There is NO
KV/maxNumSeqs boost anywhere — this removes all OOM risk.

- **CODER (vllm.service)**: `maxNumSeqs` STAYS `1`; `kvCacheMemory` STAYS `4776620811` (~4.45 GiB);
  `--max-num-batched-tokens` STAYS `256`; MTP unchanged. ONLY `maxModelLen 147456 → 131072`.
- **READER (vllm-reader.service)**: entirely UNTOUCHED by me — `maxModelLen 65536`, `maxNumSeqs 24`,
  `kvCacheMemory 17824719667` (~16.6 GiB) all as they were.

**Why narrowing-only is safe (empirical, measured on the live coder):**

- vLLM startup log (current run, pid 249841): `GPU KV cache size: 187,071 tokens` at `kvCacheMemory=4776620811` B
  => **per-token KV = 25,534 B/token (~24.9 KiB/tok)** (authoritative; supersedes the plan's 32394 and the
  parent's 65536 estimates).
- One full-131072-ctx sequence KV = 25,534 × 131,072 = **~3.12 GiB** — the existing ~4.45 GiB pool holds one
  full-context seq with room to spare (it previously served 147456 at seqs=1 relying on sub-max requests;
  at the smaller 131072 it is strictly MORE comfortable). So narrowing the context is pure headroom gain.
- No concurrency boost ⇒ no risk of simultaneous full-context seqs exhausting VRAM. (For reference, seqs=2
  would need ~6.2 GiB KV and seqs=4 ~12.5 GiB — the latter is impossible on 32 GiB; both intentionally avoided.)

NOTE: `nixos-rebuild switch` NOT yet run — the live coder is unchanged / not restarted. Build+switch+VRAM
verification pending resolution of the OPEN DECISION so the whole flake change (Parts 2+3) applies once.

### Part 4 — reader fabric reorder (edit applied to working tree)

- `home/programs/omniroute-routing.py` `hybrid/reader` block (lines 88-104): reordered to
  **tier1 = esnixi 5090** (`vllm/qwen3.5-9b-nvfp4-reader` on `vllm`), **tier2 = gremlin 4070 Ti Super**
  (`ollama/qwen3.5-reader:9b` on `ollama-local` = b20e0770), tier3 = M5. Strategy changed `fill-first` → `priority`
  (task: "priority strategy, 5090 first then 4070ti"). Comment reconciled to the new order + cites user msg 12.
  `context_length` left at 32768 (most-constrained M5 tier; not in task scope to change).
- Not yet applied to the live OmniRoute combo (routing.py apply flow pending; see Part 4 apply + Part 1 apply).

### Zoo reader route (Part 4, DB is live — documented, not written)

- Live `state.vscdb` has NO `openAiOmniRouteReaderRouteId` (root cause of "reader not used"). Flake template
  `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json` already sets it to
  `hybrid/reader`. ACTION FOR USER: set `openAiOmniRouteReaderRouteId = hybrid/reader` on the OmniRoute Zoo
  profiles (or re-import the template). No DB write performed (live DB).

## OPEN DECISION (blocking — behavior change beyond approved scope)

The task text lists `home/programs/omniroute-routing.py:195` for the 147456→131072 narrowing. That line is
the **apply guard for a DIFFERENT backend**: the 4070 Ti Super IQ3 coder alias `qwen3.8:27b-iq3-code144k`,
NOT the 5090 vLLM coder this task narrows. Its real runtime context is set by
`home/programs/omniroute-qwen38-4070.Modelfile` (`num_ctx 147456`). Narrowing the guard to 131072 would make
the apply flow push a 131072 context override for the 4070 IQ3 coder (and the Modelfile would need the same
change) — i.e. it narrows a lane that is NOT part of the explicitly approved scope (5090 coder 131072 + KV +
reader route). I have **reverted line 195 back to 147456/114688** and preserved the 4070 Modelfile at 147456
to keep that lane's behavior unchanged, pending the user's decision. The authoritative 5090 change (line 204)
is applied. The SKILL.md:14 doc (which conflates the 5090 and 4070 contexts) is also held until this is decided.

## PART 1 — DONE & VERIFIED

- Decided NOT to wait for the ~68-min liveness-delayed pod restart. Ran the exact postStart commands on the
  live pod: `kubectl exec -n ollama-service ollama-5b758b9458-99mt9 -- sh -c "ollama pull qwen3.5:9b &&
printf 'FROM qwen3.5:9b\nPARAMETER num_ctx 131072' > /tmp/qwen35-reader.Modelfile && ollama create
qwen3.5-reader:9b -f ..."` → `success`.
- `curl http://10.1.1.12:2701/api/show -d '{"name":"qwen3.5-reader:9b"}'` → `num_ctx 131072`,
  native `qwen35.context_length 262144`, capabilities `[completion, vision, tools, thinking]` (VLM/vision
  inherited — acceptable per task CAVEAT).
- Trivial completion `/api/generate` → `done:true`, 8 tokens generated (`done_reason:length`; response text
  empty because the thinking block consumed the 8-token budget — model loads and generates correctly).
- values.yaml (declarative source for future pods) committed: `kube` repo **890004e** (NOT pushed).

## PART 1 commit

- `/Users/celes/sources/kube` (repo root; `ollama/values.yaml` was untracked) → commit **890004e**
  "feat(ollama): add qwen3.5-reader:9b fallback reader (num_ctx 131072)". NOT pushed.

## PART 2+3 — nix build OK, SWITCH BLOCKED (sudo)

- `nix build .#nixosConfigurations.esnixi.config.system.build.toplevel --no-link` (no sudo) → **built cleanly**,
  no eval errors (built unit-vllm.service.drv, vllm-switch.py.drv, omniroute-apply-routing.drv, toplevel).
- `sudo nixos-rebuild switch` **CANNOT be run**: sudo requires a password and this agent SSH session has no
  TTY/askpass/password (`sudo -n true` → "a password is required"). This is the task's "if an SSH command to
  the remote flake fails, STOP and report" case for the privileged activation step. The flake is verified to
  BUILD; the activation (which restarts vllm.service) must be run by the user:
  `ssh -t celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi'`
  Then verify: `systemctl is-active vllm.service`; `journalctl -u vllm.service -n 80` (no CUDA OOM, loaded);
  `nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader` (free ≥ ~1.5–2.0 GiB); and
  `curl -s http://127.0.0.1:8010/v1/models` shows the coder at `max_model_len 131072`. Part 3 collapsed: coder maxNumSeqs STAYS 1, kvCacheMemory STAYS 4776620811, batched-tokens STAYS 256 — only maxModelLen is 131072.

## PART 4 — ROOT CAUSE deeper than the plan; LIVE WIRING BLOCKED on a design decision

Investigation of the LIVE OmniRoute policy (read-only, mgmt bearer) found the plan's assumption is wrong:

- `home/programs/omniroute-routing.py`'s `hybrid/reader` block (which I reordered to 5090→4070ti→m5) is
  **DEAD CODE**: `routing.py main()` short-circuits to `omniroute-mode.py` whenever
  `~/.local/state/omniroute-routing/tier-switch-state.json` exists — and it DOES exist on esnixi
  (97646 bytes, active_mode present). So the live combos are owned by `omniroute-mode.py`, not routing.py.
- `omniroute-mode.py build()` REBUILDS `hybrid/reader`, `local/reader`, and all `pool/tierN/reader` combos on
  every apply. For the `reader` category it uses the SAME tier-1 targets as every other category:
  `[(QWEN5090, 50), (MLX, 19), (IQ3, 21), (GLM, 10)]` — i.e. the **CODER** models. There are NO dedicated
  reader models (`qwen3.5-9b-nvfp4-reader`, `qwen3.5-reader:9b`) anywhere in the live tiered policy.
- Confirmed live: `pool/tier1/reader` = `vllm/qwen3.8-27b-nvfp4` (w50) + `mlx-qwen3.8-27b-4bit` (w19) +
  `qwen3.8:27b-iq3-code144k` (w21) + `ds4-glm53` (w10) — all coders. `local/reader` → `pool/tier1/reader`.
  `hybrid/reader` → combo-refs `local/4070ti`(→ornith coder) → `local/5090-reader`(the real 5090 reader) →
  `local/m5-reader`(real M5 reader). So the ONLY dedicated-reader references in the live fabric are
  `local/5090-reader` and `local/m5-reader`, and `hybrid/reader` lists the real 5090 reader only as TIER 2.
- Combos backed up read-only to `/tmp/omniroute-backup/combos-20261001-200308.json`.

**Why I cannot just reorder the live combo:** `omniroute-mode.py` has a drift guard (`assert_expected`) that
refuses to apply if the live combos differ from its generated plan, and its apply PUTs the regenerated
`hybrid/reader`/`pool/*/reader` — so ANY manual mgmt-API reorder would (a) trip the drift guard and/or
(b) be overwritten on the next tier apply. The durable fix is in `omniroute-mode.py`: give the `reader`
category its own dedicated-reader target set (5090 `vllm/qwen3.5-9b-nvfp4-reader` primary → 4070ti
`ollama-local/qwen3.5-reader:9b` fallback → M5 `qwen3.5-reader:9b`), separate from the shared coder targets.
That reshapes reader-category routing across all tiers/hosts — a behavior change beyond the approved scope
(5090 coder 131072 + KV + reader route), so I am flagging it rather than deciding it inside the loop.

## Zoo reader route (Part 4, documented — no DB write)

- Flake template `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json` already
  sets `openAiOmniRouteReaderRouteId = hybrid/reader` at lines 61/82/141/394 (verified). Live `state.vscdb`
  has NO such key (root cause #2). No template change needed; no live DB write (DB is live under VS Code).
  ACTION FOR USER: in the Zoo OmniRoute profile settings set `openAiOmniRouteReaderRouteId = hybrid/reader`
  (or re-import the template). NOTE: this only helps once `hybrid/reader` actually routes to the dedicated
  readers (the Part 4 design decision above).

## PART 4 — IMPLEMENTED in omniroute-mode.py (the real policy owner), apply left to operator

Confirmed scope with the user: change ONLY `reader`, `code`, `tester`; leave planner/long/research/fast/
tiny/any/frontier AND reviewer exactly as-is. Implemented in `home/programs/omniroute-mode.py`:

- Added `READER5090 = vllm/qwen3.5-9b-nvfp4-reader`, `READER4070 = ollama-local/qwen3.5-reader:9b`.
- Added a `TIER1_OVERRIDES` map (per-category ordered priority chains) consulted in `build()` for tier 1:
    - `reader` -> [(READER5090, 60), (READER4070, 40)] (5090 NVFP4 reader primary -> 4070 Ti Super reader fallback)
    - `code` -> [(QWEN5090, 55), (GLM, 24), (IQ3, 21)] (5090 Qwen3.8 131072 -> M5 GLM ds4-glm53 -> 4070 IQ3 147456)
    - `tester` -> same coder chain as `code`
- Added `OVERRIDE_POLICIES` (incl. the two reader models) used ONLY for overridden pools, kept OUT of the
  shared `POLICIES` map so untouched categories that deep-copy POLICIES wholesale do NOT gain extra
  weightedTargetPolicies keys (prevents drift that would trip omniroute-mode.py's `assert_expected`).
- Tier-1 descriptions updated for reader/code/tester accuracy.
  Verified by importing the edited module and running `build('tiered', {})`:
- reader/code/tester tier-1 pools have the exact ordered models + weights above; policies scoped to only
  the active models.
- reviewer, fast, tiny, long, planner, research, any, frontier tier-1 model lists are **byte-identical to
  the live backup** `/tmp/omniroute-backup/combos-20261001-200308.json` (compared programmatically: all SAME).
- `python3 -c ast.parse` OK locally and on esnixi.
  Exact advertised model IDs verified via OmniRoute `/api/provider-models`:
  `llama-cpp/ds4-glm53`, `ollama-local/qwen3.8:27b-iq3-code144k`, `ollama-local/qwen3.5-reader:9b`,
  `vllm/qwen3.5-9b-nvfp4-reader` — all exist.

NOTE on `omniroute-routing.py` `hybrid/reader`: that block was reordered to 5090-primary too, but it is DEAD
CODE at runtime (routing.py main() short-circuits to omniroute-mode.py while tier-switch-state.json exists).
Kept the reorder so the file does not contradict the new design; the authoritative wiring is omniroute-mode.py.

## COMMITS (NOT pushed)

- Part 1 ollama: repo `/Users/celes/sources/kube`, branch master, **890004e** — adds `ollama/values.yaml`
  (postStart creates qwen3.5-reader:9b, num_ctx 131072).
- Parts 2/3/4 esnixi flake: repo `~/sources/celesrenata/nix-flakes-refactored`, branch
  **feat/nvfp4-reader-fabric**, **c97136b** (amended from 5375eef: KV correction then final no-concurrency-change decision) — 6 task-scoped files only
  (esnixi/vllm.nix, esnixi/vllm-switch.py, home/programs/omniroute-routing.py, home/programs/omniroute-mode.py,
  home/programs/zoo-spec-setup.py, home/programs/omniroute-routing-mode.SKILL.md). Other pre-existing
  uncommitted worktree changes on this WIP branch were intentionally left unstaged (git-safety: no `git add -A`).
  Neither repo was pushed.

## WHAT THE OPERATOR MUST RUN (in this order) — I cannot (no esnixi sudo/TTY; live all-category routing)

1. **Activate the coder context + KV change on esnixi** (brief coder outage — approved):
   `ssh -t celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi'`
   (The flake is verified to BUILD cleanly via `nix build ...toplevel`; only the privileged activation remains.)
   Verify after:
    - `systemctl is-active vllm.service` -> active; `journalctl -u vllm.service -n 80 --no-pager` -> loaded, NO CUDA OOM.
    - `nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader` -> free >= ~1.5-2.0 GiB.
    - `curl -s http://127.0.0.1:8010/v1/models` -> coder `max_model_len` 131072.
    - Expected: unchanged KV pool (4776620811) at the smaller 131072 context => MORE KV headroom than before;
      vLLM should profile ~187k KV tokens and "Maximum concurrency for 131072 tokens per request" ~1.4x.
      No OOM is possible since neither the pool nor the seq count increased.
2. **Apply the OmniRoute tiered policy** (reader/coder lanes) on esnixi, where tier-switch-state.json lives:
   `python3 ~/.local/share/omniroute-editor/omniroute-mode.py <active_mode> --apply`
   (use the current active_mode from `omniroute-mode.py --status`; omit `--apply` first for a dry run).
   The drift guard will pass because the live untouched combos still match (verified byte-identical); it will
   update pool/tier1/reader, pool/tier1/code, pool/tier1/tester (and the parent local/hybrid combos).
   Verify after: `pool/tier1/reader` lists the 5090 reader then 4070ti reader; `pool/tier1/code` lists
   5090 -> ds4-glm53 -> IQ3; a reader-tier request lands on the 5090 reader when idle and the 4070ti reader
   when the 5090 is coding (switcher 409 -> next tier).
3. **Zoo reader route**: in the Zoo (Roo) OmniRoute profile settings set
   `openAiOmniRouteReaderRouteId = hybrid/reader` (live state.vscdb intentionally NOT written; the flake
   template already carries this value at template lines 61/82/141/394). This is what actually makes Zoo's
   reader/project-reader workers use the reader lane instead of the coder.

## Failure E — parallel coder fan-out capacity (ANALYSIS; config change NOT applied — see below)

The user asked whether the 5090 is called twice when it should spread to a second worker. Measured live
(mgmt API, read-only):

- esnixi-5090 (vllm) `maxConcurrent=1` — correctly SERIALIZES; it is NOT double-called concurrently. Good.
- stabulous-m5max (llama-cpp, GLM ds4-glm53) `maxConcurrent=1`.
- gremlin-4070ti-ollama (IQ3) `maxConcurrent=1`.
  **Total coder-lane parallel capacity = 1 + 1 + 1 = 3 concurrent requests** (one per tier, since the
  coder combo is a priority chain 5090 → M5 GLM → 4070 IQ3 and each provider caps at 1).

Why fan-out can LOOK broken: when parallel workers spread (5090 → GLM → IQ3), if GLM is already at its
cap and the upstream Failure A (empty-502) / Failure C (IQ3-500) errors collapse the chain, the "second
worker" appears to error/queue instead of landing on a free tier. Those A/C error-handling fixes are the
primary remedy and are OUTSIDE this task's scope (see below).

### Concurrency tuning — considered, NOT changed by me (needs the user's decision + live test)

- esnixi-5090 (vllm): MUST stay `maxConcurrent=1`. The coder KV pool (4776620811, ~4.45 GiB) at 131072
  fits ~1 full-context sequence (measured 25,534 B/tok ⇒ ~3.12 GiB/seq); 2× full-context ≈ 6.2 GiB KV plus
  ~21.8 GiB weights would exceed headroom. DO NOT raise. (Consistent with the Part 3 no-boost decision.)
- gremlin-4070ti-ollama (IQ3): keep `1` — ollama does not parallelize this model type well (user's earlier note).
- stabulous-m5max (GLM): the notification suggests 1→2 IF it tests safe. **I did NOT change it**, because
  `omniroute-mode.py` PROVIDER_POLICIES sets `llama-cpp maxConcurrent=1` with the comment "Both M5 models
  share the mutually-exclusive local-model-proxy" — raising it risks violating that mutual exclusion, and the
  change is gated on live 2-concurrent load testing (OOM/slowdown) that is a behavior decision + a risk to a
  single-slot backend I should not take unilaterally inside this task. RECOMMENDATION for the user: if you
  want the GLM "second worker" win, first confirm the M5 local-model-proxy can actually serve 2 concurrent
  (not mutually-exclusive for GLM alone), then set `PROVIDER_POLICIES[CONNECTIONS['llama-cpp']] =
{'maxConcurrent': 2}` in omniroute-mode.py and re-apply. Not done here.

### Failures A / C / E — OUT OF SCOPE for this task

Failures A (empty-502) and C (IQ3-500 system-ordering) are OmniRoute provider/routing error-handling bugs,
NOT part of this task's plan (plan.md Parts 1–4: ollama fallback reader, coder context narrow, KV, reader
route). Failure E is "mostly resolved by the A+C fixes" per the parent. I did not fix A/C/E — they belong to
a separate change. This task's contribution to fan-out is only: (a) the dedicated-reader lanes keep reads off
the coder tiers (freeing coder capacity), and (b) the documented 3-slot capacity math above. Fixing A/C and
deciding the GLM bump are left to the user / a follow-up.

## VERIFICATION STATUS SUMMARY

- Part 1: DONE & VERIFIED LIVE (model created, api/show ctx 131072, loads + generates). Committed 890004e.
- Part 2: edits committed (c97136b); switcher unittest 6/6 incl. coupling guard; flake builds; grep leaves
  only the deliberately-kept 4070 IQ3 lane (147456 in Modelfile + routing.py:197) and its doc. Activation
  (nixos-rebuild switch) pending operator.
- Part 3: FINAL = no concurrency change. Coder maxNumSeqs/kvCacheMemory/batched-tokens all UNCHANGED;
  only context narrowed (Part 2). Reader service entirely untouched. Zero OOM risk by construction.
- Part 4: omniroute-mode.py reader+coder lanes implemented & committed (c97136b); untouched categories proven
  non-drifting; model IDs verified. Live apply pending operator (step 2 above) + Zoo setting (step 3).
- Mutual exclusion / switcher: untouched (reader 65536 preserved; coupling test passes).
