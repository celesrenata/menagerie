# Cluster-side parallelism levers — proposals (apply on remote host, NOT auto-applied)

Read-only review of `celes@192.168.42.254` config. These are the backend/infra levers that complement the Menagerie-code fixes already shipped (stream-idle timeout → 1800s, capacity-aware scheduling, backend spread, adjustable `parallelCapacityMap`). The Menagerie side now throttles correctly; these address the *physical* backend limits. Apply yourself after review — this is live GPU-serving infra.

Files:
- OmniRoute env: k8s Deployment in ns `omniroute` (image `omniroute:3.8.68-hard-conn-cap-20261004`).
- vLLM serving: `~/sources/celesrenata/nix-flakes-refactored/esnixi/vllm.nix`.
- Routing weights: `~/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`.

---

## Lever 1 — Queue-park vs client timeout: ALREADY LARGELY DEFUSED (optional hardening)

Current: `RATE_LIMIT_MAX_WAIT_MS = 300000` (5 min), `STREAM_IDLE_TIMEOUT_MS = 300000`, `REQUEST_TIMEOUT_MS = 2700000` (45 min).

The old race was: the server parks a request up to 300s, and the Menagerie client's idle timer was *also* 300s, so parked requests were killed. **We already raised the client side to 1800s (commit 92f8035a5), so the client no longer aborts at the queue-park boundary.** This lever is mostly resolved from the client direction.

Optional hardening (only if you still see queued requests stall): the durable backend-side fix is **keepalive/heartbeat chunks** while a request is queued, so the stream is never idle. That is an OmniRoute application feature, not an env flip — not a config change I can hand you as a diff. Lower `RATE_LIMIT_MAX_WAIT_MS` would just fail requests faster, which is worse. **Recommendation: leave as-is; the client-timeout fix covers it.**

---

## Lever 2 — Raise vLLM 27B concurrency: BLOCKED (no VRAM headroom)

Current: `maxNumSeqs = 2`, `gpuMemoryUtilization = 0.92`, `kvCacheMemory = 5905580032` (5.5 GiB).

Per the vllm.nix comments (measured 2026-10-03): awake footprint **~29.5 GiB** against **28.93 GiB** usable at 0.92× on the 5090; peak free is **~1.0 GiB** as sole tenant. The unit is explicitly tuned to "refuse to start instead of OOMing." A one max-length sequence already uses 73 of 104 usable KV blocks.

**A 3rd concurrent sequence does not fit** — there is no VRAM to add it. Raising `maxNumSeqs` to 3 would OOM or refuse to start. **Recommendation: do NOT raise it.** (If you ever want more real 27B concurrency, it requires a smaller KV footprint — lower `maxModelLen`, more aggressive KV quant, or a second GPU — which is a bigger change than a config flip.)

---

## Lever 3 — Shift code-lane weight off the saturated 27B: VIABLE (safe config edit)

Current (`omniroute-mode.py`):
```
'code':   [(QWEN5090, 55), (GLM, 24), (IQ3, 21)]
'tester': [(QWEN5090, 55), (GLM, 24), (IQ3, 21)]
```
Code/tester send 55% to the single vLLM 27B (effectively ~1 live slot), with GLM (M5, 1 slot) and IQ3 (4070 Ti Super, part of ollama-local's 4) as overflow. Under a parallel batch, the 55% concentration is what piles onto the bottleneck.

Proposed (rebalance toward the overflow backends that have idle capacity):
```
'code':   [(QWEN5090, 34), (GLM, 33), (IQ3, 33)]
'tester': [(QWEN5090, 34), (GLM, 33), (IQ3, 33)]
```
Rationale: evens the pressure so fewer code workers queue behind the single 27B while GLM/IQ3 slots sit idle. This now COMPOSES with the Menagerie-side backend-spread (commit e6dc45210) — both layers push work off the single vLLM. The exact split is a quality/throughput tradeoff (the 27B NVFP4 is your highest-quality coder; GLM/IQ3 are the speed-first/overflow tiers), so tune to taste — even a modest shift (e.g. 45/30/25) helps. **This is a pure routing-weight edit; redeploy OmniRoute config to apply.**

Caveat: the `WEIGHTS` tuple on line 19 (`'code': (55, 24, 21, 0)`) appears to mirror these — change both consistently, and re-check `test_vllm_switch.py` / any assertion that parses these blocks before redeploying.

---

## Summary

| Lever | Status | Action |
|-------|--------|--------|
| 1. Queue-park vs client timeout | Resolved by client-side 1800s fix | None needed; heartbeat is an OmniRoute feature if ever wanted |
| 2. Raise vLLM concurrency | BLOCKED — ~1 GiB VRAM free | Do not change; needs smaller KV / 2nd GPU |
| 3. Shift code weight off 27B | VIABLE | Edit `omniroute-mode.py` code/tester weights + mirror `WEIGHTS`; redeploy |

The highest-value remaining backend lever is **Lever 3** (routing rebalance), and it's safe. Lever 2 is the one that would most widen the real bottleneck but is blocked by VRAM. The durable throughput win is the in-flight **input-bloat reduction** (Menagerie code) — smaller prompts make each serialized 27B request faster, which drains the queue regardless of backend concurrency.
