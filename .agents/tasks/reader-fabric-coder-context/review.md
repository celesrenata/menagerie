# Reader-fabric + coder-context change — iteration 2 review

The change narrows the esnixi RTX 5090 vLLM coder context from 147456 to 131072 across every coupled site, adds a dedicated 9B reader fabric (5090 NVFP4 reader primary, gremlin 4070 Ti Super ollama reader fallback) owned by `omniroute-mode.py`, and creates the `qwen3.5-reader:9b` fallback model on the gremlin ollama pod via the Helm `values.yaml` postStart hook. Part 3 (KV/concurrency boost) was deliberately collapsed to a no-op per the user's final decision: only the context is narrowed, so VRAM headroom is gained rather than spent. The iteration-2 fix reverted the dormant `vllm-reader` unit to its HEAD~1 state (the prior commit had silently mutated it), making the diff reader-neutral.

Watch for: the 4070 Ti Super IQ3 coder lane is deliberately left at 147456 (confirmed), not narrowed — this is a documented scope decision, not a coupling break (confirmed). The 5090 vLLM reader model ID does not appear in the live OmniRoute catalog right now because its unit is switcher-gated and currently inactive (confirmed, expected). Zoo's `openAiOmniRouteReaderRouteId` is documented for the user to set, not written (confirmed, deliberate — live DB).

**Verdict**: APPROVED

## High-level view

The Part 2 context narrowing is consistent across all coupled sites that gate the 5090 coder: `vllm.nix` coder `maxModelLen`, both `vllm-switch.py` coder entries (plain + `-balanced`), the `omniroute-routing.py` 5090 layout (`131072, 98304`), the new `zoo-spec-setup.py` `local/5090` contextWindow, and the `omniroute-mode.py` dry-run string. The switcher readiness coupling (served `max_model_len` must equal the switcher's `context` exactly) holds: both read 131072. The reader's 65536 and the fallback's 24576 are untouched, and the switcher unit test's reader-coupling guard still asserts 65536.

The only remaining `147456` references are the 4070 Ti Super IQ3 lane (its Modelfile, its routing.py apply guard at line 197, and two descriptive strings), which were intentionally kept because the user's messages scoped the narrowing to the 5090 coder and never confirmed narrowing the separate IQ3 backend. This is a design decision carried over and defensible, not a stale coupled reference.

Part 3 carries no OOM risk by construction: `kvCacheMemory` stays 4776620811 and `maxNumSeqs` stays 1, so the narrower context strictly reduces KV pressure. The implementer's live read-only observation (coder active at the 131072 config, 10.3 GiB free) confirms the service came up and serves with far more than the 1.5-2 GiB headroom the task required.

Part 1 is verified live (model created, `api/show` reports num_ctx 131072, generation returns `done:true`; vision inherited and accepted). Part 4 wires the reader category in the authoritative policy owner `omniroute-mode.py` with `reader -> [(READER5090, 60), (READER4070, 40)]` under a priority strategy, scoping policies to avoid drifting untouched categories. The dead-code `omniroute-routing.py` `hybrid/reader` block was reconciled to the same ordering so the file does not contradict the design. The live apply and the Zoo route setting are left for the operator, correctly, because they require privileged/live mutation this session cannot safely perform.

<details>
<summary>Issues (2)</summary>

1. **4070 IQ3 lane left at 147456** — non-blocking, by design. `omniroute-routing.py:197` and `omniroute-qwen38-4070.Modelfile:2` keep 147456 for the separate 4070 Ti Super IQ3 coder; the user scoped the narrowing to the 5090. No action unless the user later asks to narrow the IQ3 lane too.
2. **Operator follow-ups outstanding** — non-blocking, correctly deferred. `nixos-rebuild switch` activation on esnixi, `omniroute-mode.py <mode> --apply`, and setting `openAiOmniRouteReaderRouteId = hybrid/reader` in Zoo must be run by the operator (no sudo/TTY and live-DB constraints in this session). The flake builds cleanly and the live coder is already observed at the 131072 config.

</details>

<details>
<summary>Details</summary>

### Part 2 coupling — the 131072 fan-out

Every site that gates the 5090 coder context now reads 131072, verified against the branch `feat/nvfp4-reader-fabric` at commit 101c5c9 (diffed against HEAD~1 46fd036):

- `esnixi/vllm.nix` coder `maxModelLen = "131072"` (the `vllm.service` block). The `mkVllmService` default was also moved 147456 -> 131072 for coherence, which has no live effect because the coder sets it explicitly.
- `esnixi/vllm-switch.py` both coder entries — the plain coder (`"context": 131072`) and the `-balanced` variant — changed together. The reader entry at line 60 stays 65536.
- `home/programs/omniroute-routing.py:204` 5090 layout `"vllm/qwen3.8-27b-nvfp4": (131072, 98304)` — the max_input recompute `131072 - 32768 = 98304` is correct.
- `home/programs/zoo-spec-setup.py` `local/5090` branch sets `contextWindow: 131072`.
- `home/programs/omniroute-mode.py:360` dry-run string reads `one 131072-context request`.

The switcher readiness coupling (served `max_model_len` must equal `MODELS[...]["context"]` exactly, or the tier goes silently dead) holds: `vllm.nix` serves `--max-model-len 131072` and `vllm-switch.py` entries are 131072. `grep -rniE "147456|114688"` over `esnixi/ home/` returns only the 4070 IQ3 lane references (next section) — no stale 5090/coder refs.

The "BOTH places" clause for `omniroute-routing.py` maps to lines 197 and 204. Line 204 (the 5090 layout) is correctly 131072/98304. Line 197 is the apply guard for `ollama-local/qwen3.8:27b-iq3-code144k` — the 4070 Ti Super IQ3 coder, a different backend — and is deliberately kept at 147456/114688.

### 4070 Ti Super IQ3 lane kept at 147456 (deliberate, not a coupling break)

The remaining `147456` hits are all the IQ3 lane: `omniroute-qwen38-4070.Modelfile:2` (`num_ctx 147456`), `omniroute-routing.py:197` (apply guard), `omniroute-mode.py:50` (comment), `omniroute-mode.py:360` (the 4070 clause of the dry-run string, which correctly keeps 147456 while the 5090 clause is now 131072), and `omniroute-routing-mode.SKILL.md:14` (the 4070 doc line). The user's messages (1-12) scoped the context narrowing to the 5090 coder plus the reader fabric; narrowing the separate IQ3 backend was never confirmed, and the plan flagged this explicitly as out of approved scope. The switcher readiness coupling only concerns the 5090 vLLM served context versus the switcher's context, both 131072, so leaving the IQ3 lane at 147456 does not silently kill any tier.

### Reader and fallback preserved

The dormant `vllm-reader` unit is byte-identical to HEAD~1 (`diff` of the extracted block is empty), reversing the prior commit's silent mutation that iteration 1 had wrongly described as untouched. Reader `maxModelLen = "65536"` (vllm.nix:185) and switcher reader context (vllm-switch.py:60) agree at 65536; the switcher unit test's `test_f_context_matches_served_max_model_len` guard still asserts this. The `vllm-5090-fallback` `maxModelLen = "24576"` does not appear in the diff — untouched. Mutual exclusion (`conflicts = [ "vllm-reader.service" "vllm-5090-fallback.service" ]` on the coder, inverse on the reader) is intact.

### Part 3 — no concurrency change, headroom gained

```
kvCacheMemory stays 4776620811 B (~4.45 GiB), maxNumSeqs stays 1, --max-num-batched-tokens stays 256
context 147456 -> 131072  =>  per-seq KV shrinks, pool unchanged  =>  strictly more headroom
```

The diff confirms `kvCacheMemory = 4776620811` and `maxNumSeqs = "1"` on the coder. Because neither the pool nor the seq count grew while the context shrank, there is no path to a new OOM. The implementer's live read-only check (not re-run here) recorded `vllm.service` active at the committed 131072 config (non-default args show `max_model_len 131072`, `kv_cache_memory_bytes 4776620811`, `max_num_seqs 1`) and `nvidia-smi` 10324 MiB free — far above the task's 1.5-2 GiB floor. The coder came up and served (Part 1 smoke generation ran against the live stack).

### Part 1 — gremlin fallback reader

`/Users/celes/sources/kube/ollama/values.yaml` postStart creates `qwen3.5-reader:9b` FROM `qwen3.5:9b` with `num_ctx 131072` inside the bootstrap heredoc. Verified live by the implementer: `api/show` reports num_ctx 131072 and native `qwen35.context_length 262144`; `api/generate` returns `done:true`. Vision/VLM capabilities are inherited from the base model and are acceptable per the task caveat.

### Part 4 — reader fabric and resolution

The authoritative policy owner is `omniroute-mode.py` (routing.py short-circuits to it whenever tier-switch-state.json exists, which it does on esnixi). It defines `READER5090 = vllm/qwen3.5-9b-nvfp4-reader`, `READER4070 = ollama-local/qwen3.5-reader:9b`, and `TIER1_OVERRIDES['reader'] = [(READER5090, 60), (READER4070, 40)]` under tier-1 priority strategy — 5090 primary, 4070 Ti Super fallback, matching user message 12. Reader policies live in a separate `OVERRIDE_POLICIES` map so untouched categories that deep-copy `POLICIES` do not gain extra keys and trip the `assert_expected` drift guard; only `reader`, `code`, and `tester` are retargeted. The dead-code `omniroute-routing.py` `hybrid/reader` block was reordered to the same 5090-first order with the comment reconciled, so the file does not contradict the live design.

A narrow read-only spot-check against `/api/provider-models` resolves `qwen3.5-reader:9b` (the 4070ti/M5 ollama reader). The 5090 `qwen3.5-9b-nvfp4-reader` does not currently appear — expected, because its `vllm-reader.service` is switcher-gated and inactive while the mutually-exclusive coder is live; the esnixi vLLM provider only advertises it when the switcher arms the reader on demand. This is the designed tenancy, not a wiring gap.

The Zoo route value `openAiOmniRouteReaderRouteId = hybrid/reader` is documented for the operator rather than written to the live `state.vscdb` (correct — the DB is live under VS Code). The m5max flake template already carries this value, so a re-import also applies it.

### Operator follow-ups (correctly deferred, not defects)

Three steps remain for the operator and are not reviewable failures: `sudo nixos-rebuild switch --flake .#esnixi` on esnixi (no passwordless sudo in this session; the flake is verified to `nix build` cleanly and the live coder is already observed at the 131072 config), `omniroute-mode.py <active_mode> --apply` to push the reader/coder lanes, and setting the Zoo reader route. The task approved the brief coder restart these entail.

### Scope hygiene

The commit touches only the six task-scoped files; `zoo-spec-setup.py` and `omniroute-mode.py` are committed as new files (content correct), which accounts for their large insertion counts versus small line-edit expectations — a diff-shape observation, not a behavioral concern.

</details>

<details>
<summary>File map</summary>

- `esnixi/vllm.nix` — coder maxModelLen 147456->131072, kvCacheMemory param added (coder stays 4776620811), mkVllmService default ->131072; reader/fallback unchanged.
- `esnixi/vllm-switch.py` — both coder context entries 147456->131072; reader 65536 unchanged.
- `home/programs/omniroute-routing.py` — 5090 layout ->(131072, 98304); hybrid/reader reordered 5090-first (dead code, reconciled); 4070 IQ3 guard kept 147456.
- `home/programs/omniroute-mode.py` — new policy owner; reader/code/tester tier-1 overrides, dedicated reader models, scoped override policies.
- `home/programs/zoo-spec-setup.py` — new; local/5090 contextWindow 131072, reader profiles.
- `home/programs/omniroute-routing-mode.SKILL.md` — new; routing/preset documentation.
- `/Users/celes/sources/kube/ollama/values.yaml` — postStart creates qwen3.5-reader:9b (num_ctx 131072).

Full diff: `git diff 46fd036 HEAD` on branch `feat/nvfp4-reader-fabric` (commit 101c5c9); plus the local kube values.yaml.

</details>
