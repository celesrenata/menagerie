# Implementation Plan — Reader-Fabric + Coder-Context Change

Cross-host, coupling-sensitive config change across esnixi (RTX 5090), the gremlin k8s
ollama, and OmniRoute. The user approved live changes that briefly restart inference
services. This plan was written after read-only investigation only; no changes applied.

## Investigation results (verified this session)

Live state confirmed by read-only probes:

- **esnixi VRAM**: `32607 MiB total / 27752 used / 4450 free`. `vllm.service` (coder) **active**,
  `vllm-reader.service` **inactive**, `vllm-5090-fallback.service` **inactive**. Matches the task's stated numbers.
- **esnixi branch**: `feat/nvfp4-reader-fabric` (correct), path `/home/celes/sources/celesrenata/nix-flakes-refactored`.
- **gremlin ollama**: pod `ollama-5b758b9458-99mt9` Running, served at `http://10.1.1.12:2701`.
  `qwen3.5-reader:9b` **does NOT exist yet** on the pod (postStart has not re-run since the
  values.yaml edit). `qwen3.5:9b` present: capabilities `['completion, vision, tools, thinking']`,
  **Q4_K_M**, native `qwen35.context_length=262144`, **has a vision projector** (`qwen35.vision.*`
  keys present). Confirms the task CAVEAT: it is a VLM; `FROM` inherits vision; acceptable for a
  text-only reader; do NOT try to strip vision.
- **ollama deploy mechanism**: Helm. `~/sources/kube/ollama/runmefirst.sh` runs
  `helm upgrade -i ollama ollama-helm/ollama --namespace ollama-service --create-namespace --values values.yaml`.
  Current release: `ollama` rev 7, chart `ollama-1.82.0`, status deployed.
- **Zoo live DB** (`state.vscdb`, key `RooVeterinaryInc.roo-cline`, 271155 bytes): contains **NO**
  `openAiOmniRouteReaderRouteId` key at all. This is the root cause of "the reader model isn't being
  used": with no reader route configured, Zoo reader/project-reader workers fall back to the main
  model (hybrid/code → the coder). The flake template already sets it (below) but it has not been
  imported into the live DB.
- **Zoo flake template** `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`:
  already contains `"openAiOmniRouteReaderRouteId": "hybrid/reader"` at lines 61, 82, 141, 394.
  So the fix is to get this template value into the live DB (via the normal import/settings path),
  not to change the template string itself.
- **OmniRoute combos** (live, read-only GET `/api/combos`, 91 combos): `hybrid/reader` exists
  (`id=5239a08c-5995-41eb-bd16-f80d2b2a9549`), strategy **priority**, context_length 262144, built
  from **combo-refs** in this order: `local/4070ti` → `local/5090-reader` → `local/m5-reader`.
    - `local/5090-reader` (`3b74da79-...`) → model `vllm/qwen3.5-9b-nvfp4-reader` on the esnixi vllm
      connection `e9bd13fb-c6b6-4c18-b42f-3395266348ce`. **Served-model-name confirmed** = the
      `servedModel` in `vllm.nix` for `vllm-reader.service`.
    - `local/4070ti` (`e5694e8f-...`) → model `ollama-local/ornith-1.5:9b-262k` on gremlin ollama
      `b20e0770-...`. **This is the Ornith coder, NOT the reader.** So `hybrid/reader` tier-1 currently
      routes to Ornith, not to `qwen3.5-reader:9b`.
    - `local/m5-reader` (`deea7674-...`) → `ollama-local/qwen3.5-reader:9b` on the **M5** connection
      `598cf9d0-...` (NOT the gremlin 4070 Ti Super).

### Coupling / architecture conflict to resolve (DECISION)

The live `hybrid/reader` orders **4070ti first, then 5090-reader**, and `home/programs/omniroute-routing.py`
(lines 88-100) likewise defines the fabric as tier1 gremlin-4070ti → tier2 esnixi-5090 → tier3 m5,
with a comment justifying it ("5090 reachable only when not coding; enforced by the switcher's 409").

The TASK text explicitly decides the opposite: **primary reader = 5090 NVFP4 reader, fallback =
4070 Ti Super**. The original user messages are authoritative over any prior design, and message 12
("5090, fallback to 4070 ti super") states this directly.

**Decision: follow the task — make `local/5090-reader` the primary (tier 1) and the 4070 Ti Super
reader the fallback (tier 2) in `hybrid/reader`.** Keep m5 as tier 3. Rationale: the user re-stated
the ordering this session; the switcher already 409s coder-busy requests so the fabric's priority
strategy will correctly overflow 5090→4070ti when the 5090 is coding. The gremlin 4070ti reader lane
must point at `ollama-local/qwen3.5-reader:9b` on connection `b20e0770`, which Part 1 creates.

This reordering is done through `home/programs/omniroute-routing.py` (the source of truth that renders
the combo) plus an apply, OR via the OmniRoute mgmt API against the combo-refs. Part 4 covers both and
recommends the routing.py path for durability. **Flag for the implementer:** reconcile routing.py's
tier comment/order with the task before applying; do not leave the file disagreeing with the live combo.

### grep -rniE "147456|114688" over esnixi flake + home/ (every coupled site)

```
./esnixi/vllm-switch.py:41:        "context": 147456,                 # coder qwen3.8-27b-nvfp4
./esnixi/vllm-switch.py:48:        "context": 147456,                 # coder -balanced variant
./esnixi/vllm.nix:122: mkVllmService ... maxModelLen ? "147456" ...   # DEFAULT param (see note)
./esnixi/vllm.nix:167:    maxModelLen = "147456";                     # the coder service (vllm.service)
./home/programs/omniroute-mode.py:318: '5090 MTP: one 147456-context ...'  # doc string
./home/programs/omniroute-routing.py:195: ("context_length", 147456), ("max_input_tokens", 114688), ...
./home/programs/omniroute-routing.py:202: "vllm/qwen3.8-27b-nvfp4": (147456, 114688),
./home/programs/zoo-spec-setup.py:49:            ... "contextWindow": 147456}   # local/5090 profile
```

Scope notes the implementer MUST heed:

- `vllm.nix:122` is the **default value** of `maxModelLen ?` in `mkVllmService`. The coder (line 167),
  reader (65536), and fallback explicitly pass their own `maxModelLen`, so the default is only used by
  any service that omits it. Confirm no service relies on the 147456 default (the coder sets it
  explicitly at 167). **Recommendation: also change the default at 122 to "131072" for coherence** so a
  future service does not silently inherit a now-nonexistent coder context. Low risk; verify nothing
  else depends on it with a grep of `mkVllmService` call sites.
- `omniroute-routing.py:195` is inside the `ollama-local/qwen3.8:27b-iq3-code144k` guard block — it is
  the **4070 Ti Super IQ3 coder** capability override, a DIFFERENT model from the 5090 vLLM coder.
  The task lists it for update, but changing it alters the 4070ti IQ3 coder's advertised context, not
  the 5090's. **Flag:** the 4070 IQ3 coder is a separate backend; its real context is `code144k`
  (~144k). Changing its override 147456→131072 is only correct if the user also wants that lane
  narrowed. **Recommendation: leave 195 as-is unless the user confirms the 4070 IQ3 coder should also
  move to 131072; the authoritative 5090 change lives at line 202.** Note this divergence in the
  commit message and raise it to the user if ambiguous.
- `omniroute-mode.py:318` is a doc/status string; update for accuracy only.

The reader coupling at `vllm.nix:175` (65536) and `vllm-switch.py:60` (65536) is **NOT** touched —
`test_vllm_switch.py:169` asserts `MODELS["qwen3.5-9b-nvfp4-reader"]["context"] == 65536`. Changing it
breaks the test and the reader tier.

### Project test / build commands discovered

- Switcher unit test: `python3 -m pytest esnixi/test_vllm_switch.py -q` (plain unittest, no GPU/systemd).
  Covers coupling guard (f). Runnable from the esnixi checkout.
- NixOS apply: `sudo nixos-rebuild switch` on esnixi (restarts `vllm.service` — brief coder outage, approved).
- Flake eval sanity: `nix flake check` / `nixos-rebuild build` before switch to catch Nix errors.
- ollama apply: `helm upgrade -i ollama ollama-helm/ollama -n ollama-service --values values.yaml`
  (from `~/sources/kube/ollama`), or `kubectl rollout restart deploy/ollama -n ollama-service` to
  re-trigger postStart without a helm change.

---

## Part 3 KV math (decided, with a conservative start)

Current coder pool: `kvCacheMemory = 4776620811` B = **4.449 GiB** at maxModelLen 147456, maxNumSeqs 1.
Per-token KV = 4776620811 / 147456 = **32394 B/token** (nvfp4 KV).

Non-KV coder footprint = 27752 MiB used − 4555 MiB KV = **~23197 MiB (~22.7 GiB)** of weights + MTP
speculative head + CUDA graphs + activations. This is large and fixed; it is why the coder cannot host
many concurrent full-context sequences.

At 131072, one full-context sequence needs 32394 × 131072 = **3.954 GiB** of KV.

Chosen approach = **match the reader's pattern: fixed `kvCacheMemory`, grow the pool, raise maxNumSeqs,
over-subscribe** (the reader declares maxNumSeqs=24 against a pool sized for ~1 full-context seq — a 24×
over-subscription that works because real reads rarely all hit full context). Prefer this over switching
to `gpuMemoryUtilization` because the reader uses fixed `kvCacheMemory` and the task says to match it.

Target total VRAM ≈ 30.5 GiB (leave **~2.0 GiB** headroom of 32607 MiB):

- KV pool budget = (32607 − 2048) − 23197 = **7362 MiB ≈ 7.19 GiB** → `kvCacheMemory = 7719973643` bytes.
- Full-context sequences that pool holds = 7.19 GiB / 3.954 GiB = **1.82**.
- Declaring **maxNumSeqs = 4** means: if all 4 were simultaneously maxed, avg 59.5k tokens/seq — comfortable
  for typical coding turns; the paged KV allocates on demand so idle/short seqs cost little.

**Recommendation (conservative start, per task "a working seqs=4 beats an OOM seqs=16"):**

- `kvCacheMemory = 7719973643` (~7.19 GiB, 2.0 GiB headroom)
- `maxNumSeqs = "4"`
- `--max-num-batched-tokens 256` → **`2048`** (256 throttles concurrency; reader uses 8192 at 9B — 2048
  is a safe middle for the heavier 27B+MTP). Keep MTP speculative-config unless it conflicts.

If the service comes up and serves cleanly with headroom to spare, the implementer MAY push
`maxNumSeqs` to 6 and/or `kvCacheMemory` toward ~8.5 GiB (1 GiB headroom) in a follow-up, verifying no
OOM each step. Land the conservative value first.

---

# Implementation Plan

- [ ]   1. **Part 1 — verify the ollama fallback-reader postStart edit (already present).**
       Confirm `/Users/celes/sources/kube/ollama/values.yaml` postStart block contains the two lines
       creating `qwen3.5-reader:9b` from `qwen3.5:9b` with `num_ctx 131072`. (Verified present this
       session at the two `printf ... qwen35-reader.Modelfile` / `ollama create qwen3.5-reader:9b` lines.)
       No edit needed if unchanged.
       Files: `/Users/celes/sources/kube/ollama/values.yaml` (read-only verify).
       Verify: `grep -n "qwen3.5-reader:9b\|num_ctx 131072" /Users/celes/sources/kube/ollama/values.yaml`
       shows both lines inside the postStart `exec.command` heredoc.

- [ ]   2. **Part 1 — apply the ollama change so postStart creates the fallback reader.**
       Re-run the helm release to re-render the deployment (postStart runs on new pod startup). Prefer
       `helm upgrade` from the repo so the committed values.yaml is the source of truth; if the chart
       values are unchanged and no new pod rolls, force it with a rollout restart.
       Files: none (deploy action). Commit values.yaml in Part 8.
       Commands: from `/Users/celes/sources/kube/ollama`:
       `helm upgrade -i ollama ollama-helm/ollama -n ollama-service --values values.yaml`
       then if no new pod: `kubectl rollout restart deploy/ollama -n ollama-service`.
       Verify: `kubectl rollout status deploy/ollama -n ollama-service` completes, then
       `curl -s http://10.1.1.12:2701/api/show -d '{"name":"qwen3.5-reader:9b"}'` returns JSON with
       `qwen35.context_length` present (expect 131072 effective ctx) and no error; also
       `curl -s http://10.1.1.12:2701/api/tags` lists `qwen3.5-reader:9b`. The postStart log is at
       `/tmp/model-bootstrap.log` inside the pod (`kubectl exec` to tail if the model is missing).
       Note: this reuses the warm 4070 Ti Super; `OLLAMA_NUM_PARALLEL=2` but ollama will not parallelize
       this model type (user's message 9) — single-slot reader is expected and acceptable.

- [ ]   3. **Part 2 — narrow the 5090 coder context 147456 → 131072 in the esnixi flake (coupling-critical).**
       Edit all coder-coupled sites together on branch `feat/nvfp4-reader-fabric`. Do NOT touch the
       reader's 65536 (`vllm.nix` reader service, `vllm-switch.py:60`).
        - `esnixi/vllm.nix:167`: `maxModelLen = "147456";` → `"131072";` (the `vllm.service` coder).
        - `esnixi/vllm.nix:122` (RECOMMENDED): default `maxModelLen ? "147456"` → `"131072"` for coherence
          (confirm no caller relies on the old default; the coder sets it explicitly).
        - `esnixi/vllm-switch.py:41` and `:48`: `"context": 147456` → `131072` (both coder + `-balanced`).
          The switcher derives `max_input_tokens = context − 32768` dynamically at line 205 — **no separate
          edit**, but confirm it recomputes to 98304. The readiness poll at line 452 requires
          served `max_model_len == MODELS[...]["context"]`, so vllm.nix 167 and switch 41/48 MUST all read 131072.
        - `home/programs/omniroute-routing.py:202`: `"vllm/qwen3.8-27b-nvfp4": (147456, 114688)` →
          `(131072, 98304)` (new max_input = 131072 − 32768 = 98304).
        - `home/programs/omniroute-routing.py:195`: **leave 147456/114688 unless the user confirms the
          separate 4070 Ti Super IQ3 coder lane should also narrow** (see scope note above). Flag in the
          commit message.
        - `home/programs/zoo-spec-setup.py:49`: `contextWindow: 147456` → `131072` (local/5090 profile).
        - `home/programs/omniroute-mode.py:318`: update the doc string's `147456` to `131072` for accuracy.
          Files: `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `home/programs/omniroute-routing.py`,
          `home/programs/zoo-spec-setup.py`, `home/programs/omniroute-mode.py`.
          Verify: re-run `grep -rniE "147456|114688"` over the esnixi flake + home/ and confirm the only
          remaining hits are the deliberately-kept `omniroute-routing.py:195` 4070-IQ3 lane (if left) — zero
          stale 5090/coder references. Then `python3 -m pytest esnixi/test_vllm_switch.py -q` passes
          (the reader-coupling guard still asserts 65536; add/adjust no assertion for the coder unless one exists).

- [ ]   4. **Part 3 — boost the coder KV pool + maxNumSeqs in `esnixi/vllm.nix` (vllm.service).**
       In the `systemd.services.vllm` block: set `kvCacheMemory = 7719973643;` (was 4776620811),
       `maxNumSeqs = "4";` (was "1"), and change `--max-num-batched-tokens 256` → `2048` in `extraArgs`.
       Keep the MTP `--speculative-config` and other flags. Depends on item 3 (the 131072 context the math
       assumes). See the Part 3 math above for the derivation and headroom.
       Files: `esnixi/vllm.nix` (coder service block only; do NOT alter the reader's 17824719667/24/8192).
       Verify: `nixos-rebuild build` (or `nix flake check`) evaluates cleanly first. After the switch in
       item 5, see verification there.

- [ ]   5. **Part 2+3 — apply the esnixi flake (restarts the coder, brief outage, approved).**
       `sudo nixos-rebuild switch` on esnixi. Depends on items 3 and 4.
       Files: none (apply action). Commit in Part 8.
       Verify (on esnixi):
        - `systemctl is-active vllm.service` → `active`; `journalctl -u vllm.service -n 80 --no-pager`
          shows vLLM finished loading, "Started vLLM", KV cache profiled, and **no CUDA OOM**.
        - `nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader` → used ≈ 30.5 GiB,
          **free ≥ ~1.5–2.0 GiB** (not near zero; if free < 1 GiB or the unit restart-loops, back
          `maxNumSeqs` to 2 and/or shrink `kvCacheMemory` and re-switch — a working seqs=2 beats OOM).
        - Served context check: `curl -s http://127.0.0.1:8010/v1/models` (on esnixi) shows the coder with
          `max_model_len`/context 131072.
        - One real completion through the coder returns tokens (smoke test), confirming it serves at seqs>1.

- [ ]   6. **Part 4 — reorder `hybrid/reader` so the 5090 reader is primary and the 4070 Ti Super is fallback.**
       Make the gremlin 4070ti reader lane point at the real reader model and put the 5090 first. Preferred
       path: edit `home/programs/omniroute-routing.py` so the reader fabric orders tier1 = 5090
       (`vllm/qwen3.5-9b-nvfp4-reader` on `vllm`), tier2 = 4070ti (`ollama-local/qwen3.5-reader:9b` on
       `b20e0770`), tier3 = m5, and reconcile the explanatory comment at lines 88-97 with the task's
       ordering. Then apply via the script's normal apply flow (uses the mgmt bearer from
       `/run/secrets/omniroute_management_api_key`).
       Alternatively, apply directly to the live combo via the mgmt API: PUT the `hybrid/reader` combo
       (`id=5239a08c-...`) reordering its combo-refs to `local/5090-reader` first, `local/4070ti`
       (repurposed to the reader model) second — but `local/4070ti` currently points at
       `ornith-1.5:9b-262k`, so a dedicated 4070ti-reader lane/combo pointing at `qwen3.5-reader:9b` is
       cleaner than mutating `local/4070ti`. Prefer the routing.py path for durability.
       Depends on item 2 (the 4070ti `qwen3.5-reader:9b` must exist before routing to it) and item 5
       (5090 reader served-name available when the switcher arms the reader).
       Files: `home/programs/omniroute-routing.py` (+ apply). No DB writes.
       Verify (read-only after apply): `curl -s -H "Authorization: Bearer $(cat /run/secrets/omniroute_management_api_key)"
https://omniroute.celestium.life/api/combos` → the `hybrid/reader` combo lists the 5090 reader lane
       first and the gremlin `qwen3.5-reader:9b` lane second. Then a reader-tier inference request (inference
       key `sk-1e7cfaf93c3e6519-77e4fd-5cfca784`) routed to `hybrid/reader` returns from the 5090 reader
       when idle, and overflows to the 4070ti when the 5090 is coding (switcher 409 → next tier). Confirm
       the esnixi vllm provider exposes `qwen3.5-9b-nvfp4-reader` only while `vllm-reader.service` is armed
       (the switcher starts it on demand).

- [ ]   7. **Part 4 — point Zoo's OmniRoute profiles at the reader route (the "reader isn't used" fix).**
       The live `state.vscdb` has NO `openAiOmniRouteReaderRouteId` set; the flake template already sets it
       to `hybrid/reader`. Because the DB is live under a running VS Code, do NOT write it directly.
       Deliver to the user the exact setting: in the Zoo (Roo) OmniRoute profile settings, set
       **`openAiOmniRouteReaderRouteId = hybrid/reader`** on the OmniRoute profiles (the hybrid/code
       profiles that drive reader/project-reader workers — template lines 61, 82, 141, 394). If the user
       re-imports profiles from the flake template via the normal settings path, that value is applied.
       No change to the template string is needed (it is already correct); the gap is that the live DB has
       not been (re)imported.
       Files: none written (document for user). Optionally confirm the template value is unchanged.
       Verify: after the user applies it, a project-reader worker in Zoo issues its reads through
       `hybrid/reader` (observable in OmniRoute metrics / the reader lane receiving traffic) instead of
       hybrid/code; the 5090 reader (or 4070ti fallback) shows request activity, the coder does not for reads.

- [ ]   8. **Commit the changes on their branches (do NOT push).**
        - esnixi flake: on branch `feat/nvfp4-reader-fabric`, stage and commit the edited files from items
          3, 4, 6: `esnixi/vllm.nix`, `esnixi/vllm-switch.py`, `home/programs/omniroute-routing.py`,
          `home/programs/zoo-spec-setup.py`, `home/programs/omniroute-mode.py`. Commit message should note
          the coder 147456→131072 narrowing, the KV re-profile (kvCacheMemory/maxNumSeqs/batched-tokens),
          the reader fabric reorder, and the deliberate decision on `omniroute-routing.py:195`.
        - ollama repo: commit `/Users/celes/sources/kube/ollama/values.yaml` (the postStart edit).
          Do NOT `git push` either repo.
          Files: as above (git stage/commit only).
          Verify: `git -C <repo> status` clean except the intended files; `git -C <repo> log -1 --stat`
          shows the expected file set; `git -C ...nix-flakes-refactored branch --show-current` ==
          `feat/nvfp4-reader-fabric`; no `git push` was run.

## Verification summary (per part)

- Part 1: `qwen3.5-reader:9b` appears in `/api/tags` and `/api/show` returns context on the gremlin pod.
- Part 2: `grep -rniE "147456|114688"` leaves zero stale 5090/coder hits; `pytest esnixi/test_vllm_switch.py` passes.
- Part 3: after `nixos-rebuild switch`, `vllm.service` active, no OOM in journal, `nvidia-smi` free ≥ ~1.5 GiB, coder serves at seqs>1 with max_model_len 131072.
- Part 4: `hybrid/reader` combo lists 5090 reader first then 4070ti; reader-tier request returns from the reader lane; user sets `openAiOmniRouteReaderRouteId = hybrid/reader` in Zoo and reads route to the reader, not the coder.

## Open items / assumptions flagged for the implementer

1. **`omniroute-routing.py:195`** governs the separate 4070 Ti Super IQ3 coder lane, not the 5090. Left
   unchanged by default; change only if the user confirms that lane should also narrow to 131072.
2. **Reader-fabric ordering** reversed from the existing design (which put 4070ti first) to match the
   task's explicit "5090 primary, fallback 4070ti". Reconcile the routing.py comment with the new order.
3. **`vllm.nix:122` default** change to "131072" is recommended for coherence but is only functional if a
   service omits `maxModelLen`; confirm no caller depends on the old default before changing.
4. **Part 3 is conservative on purpose.** maxNumSeqs=4 / kvCacheMemory ~7.19 GiB (2 GiB headroom). Push
   higher only after verifying the service serves without OOM; land the working value first.
