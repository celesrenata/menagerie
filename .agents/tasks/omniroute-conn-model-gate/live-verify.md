# Live Verification — OmniRoute per-(connection, model) concurrency gate

**Date:** 2026-10-04
**Base URL:** https://omniroute.celestium.life
**Pod:** `omniroute-7495ddfc56-pr6pc` (namespace `omniroute`)
**OmniRoute commit SHA:** `7952001084ed3906adbe6a9f6b7e811279119fd6`
**Image digest (running == pushed):** `sha256:f2551b6a3988177bf96e037976b41cb3b4ccf624c94f8a9a0d11416e831eac72` ✅

## VERDICT

⚠️ **One ceiling VIOLATED.** The per-(connection, model) **keying** is correct and the fix closes the two bugs it targeted, but the gate is a **soft, fail-open** ceiling. Under real upstream latency with sustained overload, the 5090 27B momentarily reached **4 concurrent** (ceiling is ≤ 2) because the gate **failed open** ("proceeding without a slot") when queued waiters approached the queue timeout.

## Test traffic

Fired simultaneously against the live base URL (TEST bearer from `/run/secrets/omniroute_zoo_api_key`, value never printed):

- 6 × `hybrid/code` (tier-1 → 5090 27B `qwen3.8-27b-nvfp4`, conn `e9bd13fb`)
- 6 × `hybrid/research` (tier-1 → same 5090 27B / conn)
- 8 × `hybrid/reader` (→ 4070 Ti 9B `qwen3.5-reader:9b`, conn `b20e0770`)

All 20 requests returned HTTP 200. `max_tokens` 300–400 to force multi-second slot holds and real overlap. Window: `2026-10-04T19:55:21Z` → `2026-10-04T19:57:27Z`.

## Measurement method

Interval-overlap sweep over `call_logs` in `/app/data/storage.sqlite` inside the pod (via `better-sqlite3`). Per the task: each row's active window = `[timestamp − duration, timestamp]`; computed max concurrent per model.

**Important measurement caveat (verified against source `795200108`):** `call_logs.duration = Date.now() − startTime`, where `startTime` is captured at the **top of the chat handler** (`chatCore.ts:576`), **before** the gate acquire inside `executeTargetAttempt.ts`. So `duration` **includes gate-queue wait time**. The interval-overlap-over-`duration` metric therefore measures **arrival/in-flight concurrency (executing OR queued)**, not pure execution concurrency. There is no column that isolates gate-queue time (`added_wait_ms` only tracks throttle/park, not this gate). The violation below is **not** a duration artifact — it is corroborated by the gate's own fail-open log lines (see Evidence).

## Per-model max-concurrent: BEFORE vs AFTER

| Model | Connection | Ceiling | BEFORE (pre-deploy, per task) | AFTER (measured live) | Pass? |
|---|---|---|---|---|---|
| `qwen3.8-27b-nvfp4` (5090 27B) | `e9bd13fb` | **≤ 2** | — | **4** | ❌ VIOLATED |
| `qwen3.8:27b-iq3-code144k` (4070 Ti 27B) | `b20e0770` | **≤ 1** | **4** (running 4) | **not exercised** (0 rows) | ⚠️ unverified |
| `qwen3.5-reader:9b` (4070 Ti 9B reader) | `b20e0770` | up to **4** | — | **4** | ✅ reaches 4, not exceeded |

Notes:
- **4070 Ti 27B (`:27b-iq3-code144k`) received ZERO live load.** All 13 coder dispatches stayed on the 5090 27B (the gate queued/fail-opened them there rather than spilling to the 4070 Ti). So the live run could neither confirm nor refute the ≤ 1 ceiling for this model. The pre-deploy "running 4" is the stated before; the after is **unmeasured live** (it is proven at the unit layer — see `verification.md` — but not re-confirmed on the pod here).
- **Cross-model non-starvation on the shared 4070 Ti connection was NOT exercisable live:** in this run the 9B reader ran on `b20e0770` while all 27B coders ran on the 5090 (`e9bd13fb`), so the two models never shared the 4070 Ti connection simultaneously. The reader reaching a clean 4 (below) shows the 9B gate is independent and un-starved, but the specific "27B hold vs 9B on the SAME connection" interaction is only proven at the unit layer, not live.

## Evidence

### 5090 27B — ceiling exceeded (4 concurrent)

Coder requests 1–7 ran **strictly serialized** (each started within ~8 ms of the prior one ending), consistent with the gate holding the slot. Then at the tail, two requests **failed open** and executed without a slot. Pod log (`kubectl logs ... --since=20m`):

```
19:57:14.085  COMBO  Skipping vllm/qwen3.8-27b-nvfp4 — connection e9bd13fb... is at max concurrency cap (2)
19:57:21.560  COMBO  Connection concurrency: connection e9bd13fb... model vllm/qwen3.8-27b-nvfp4 gate saturated (cap=2) — proceeding without a slot
19:57:21.585  COMBO  Connection concurrency: connection e9bd13fb... model vllm/qwen3.8-27b-nvfp4 gate saturated (cap=2) — proceeding without a slot
```

At the overlap peak `19:57:21.588`, four `qwen3.8-27b-nvfp4` intervals were simultaneously active:

| id (short) | start | end | note |
|---|---|---|---|
| …98000 (research) | 19:57:18.177 | 19:57:22.018 | slotted |
| …15018a (research) | 19:57:17.767 | 19:57:22.628 | slotted (cap 2) |
| …eeebcd (research) | 19:57:21.563 | 19:57:27.264 | **fail-open @19:57:21.560** |
| …898000 (research) | 19:57:21.588 | 19:57:26.505 | **fail-open @19:57:21.585** |

The two fail-open log timestamps line up to the millisecond with the two extra dispatches → **4 genuinely dispatched at once**, not a queue-wait artifact.

### Root cause

The gate (`connectionConcurrencyGate.ts`) is **fail-open by design**: `acquireConnectionConcurrencySlot` catches a saturated-queue / `queueTimeoutMs` (default **120 000 ms**) condition and returns `null` → the request **proceeds without a slot** rather than being rejected or kept waiting. The file's own header documents this: *"a saturated queue / timeout → proceed WITHOUT a slot rather than ever failing a dispatchable request."*

With real 5090 27B latency (~15–26 s per 400-token request) and 12 concurrent coders funneled onto cap-2, waiters backed up toward the 120 s queue timeout; two crossed the fail-open threshold and executed, pushing the live count to 4. The **unit tests pass** because they hold dispatches on a shared promise and never drive the queue to its timeout / `maxQueueSize` (default 20) fail-open path under real latency — so the soft-ceiling behavior was invisible at the unit layer.

### 9B reader — clean cap-4, no starvation

4 reader requests started concurrently at `19:55:21.6–21.7` (max concurrent **4**); as each finished, the next queued one started immediately (ids 5–8 begin exactly as 1–4 end). No fail-open log lines for the reader connection — its waiters never hit the 120 s timeout, so the cap held exactly at 4. The 9B gate is independent of any 27B gate.

## Bottom line

- Per-(connection, model) **keying is correct** (independent ceilings per model on a connection; shared ceiling across combos targeting the same (connection, model)). The two bugs the deploy targeted are closed in principle.
- The ceilings are **soft (fail-open), not hard**. Under sustained overload with slow upstreams the gate lets requests through without a slot once the queue timeout is approached, so **5090 27B exceeded ≤ 2 (reached 4) live**. If a hard cap is required, the fail-open-on-saturation branch (and/or the 120 s `queueTimeoutMs`) must be reconsidered — that is a product/design decision, not a measurement error.
- 4070 Ti 27B ≤ 1 and the shared-connection cross-model non-starvation case were **not exercisable** in this live run (no coder load reached the 4070 Ti); they remain proven only at the unit layer.
