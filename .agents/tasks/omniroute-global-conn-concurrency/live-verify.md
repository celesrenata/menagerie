# OmniRoute Global Per-Connection Concurrency — Live Verification

**Date:** 2026-10-04
**Base URL:** https://omniroute.celestium.life
**Verdict:** ✅ **PASS** — measured max concurrent on `qwen3.8-27b-nvfp4` (shared 5090 27B) = **2** (requirement: ≤ 2)

## Build / deploy under test

| Item | Value |
|------|-------|
| OmniRoute commit SHA | `598eedc5eb5b41021ccf4713a1260596d78da203` |
| Commit subject | `fix(combo): process-global per-connection concurrency ceiling for priority path` |
| Image tag | `3.8.66-global-conn-concurrency-20261004` |
| Image digest | `sha256:de4b2c582bcdc815d7c2f06bedbb539e3bb834c8c93dcff8b990d3a23a16a3cc` |
| Running pod | `omniroute-cd59b9765-hmnkk` (ns `omniroute`, node `gremlin-1`), `1/1 Running` |
| Pod start (fix cutover) | `2026-10-04T19:23:31Z` |
| Digest match | ✅ running pod `imageID` digest == pushed digest |

## Method

Per the user's guidance ("do less testing, more observing"), verification relied on
**observed organic production traffic** rather than synthetic load. The system
naturally produces overlapping cross research/coder traffic, which is the exact
scenario the fix targets.

Measurement is an **interval-overlap sweep** read directly from the call-logs DB
(`/app/data/storage.sqlite`, `better-sqlite3`, read-only). Each request's in-flight
interval is `[timestamp − duration, timestamp]` (completion-anchored). A sweep counts
the maximum number of simultaneously-active intervals on the shared 5090 27B
connection (`model = qwen3.8-27b-nvfp4`, `provider = vllm`, `account = esnixi-5090`)
across **all** combos. End-before-start tie-breaking is used so a request finishing
exactly as another starts is not falsely counted as overlapping.

Scripts (committed in this task dir): `concurrency_sweep.js`, `crosscombo_check.js`,
`observe.js`, `models_probe.js`.

## Result — shared 5090 27B (`qwen3.8-27b-nvfp4`)

| Window | Max concurrent | Worst mixed-combo overlap | Combos at max |
|--------|----------------|---------------------------|----------------|
| **Before** (all-time, pre-fix history) | **5** | **5** | `hybrid/code` + `hybrid/research` |
| **After** (since pod start `19:23:31Z`) | **2** | **0** | `hybrid/code` |

- **Before:** On `2026-10-03T13:15:59Z`, five requests were simultaneously in-flight on
  the single 5090 27B connection, and the worst case mixed `hybrid/code` **and**
  `hybrid/research` on the same connection — the "double-tap the 5090" cross
  research/coder bug.
- **After:** Max in-flight on the shared connection is **2**, and there is **zero**
  cross-combo overlap on the 5090. The process-global ceiling holds.

## Result — overflow to 4070 Ti (`ollama-local` / `gremlin-4070ti-ollama`)

Observed organic burst at `19:27:08–19:27:09Z` — three requests (both `hybrid/code`
and `hybrid/research`) arrived nearly simultaneously while the 5090 was saturated.
Instead of being piled onto the 5090, all three **overflowed to the 4070 Ti** per the
dispatch sequence, while the 5090 only accepted its next job (`19:27:27Z`) as earlier
ones drained:

```
19:27:08 -> 19:27:31  [hybrid/code]      qwen3.8:27b-iq3-code144k  ollama-local/gremlin-4070ti-ollama  200
19:27:08 -> 19:27:47  [hybrid/research]  qwen3.8:27b-iq3-code144k  ollama-local/gremlin-4070ti-ollama  200
19:27:09 -> 19:28:03  [hybrid/code]      qwen3.8:27b-iq3-code144k  ollama-local/gremlin-4070ti-ollama  200
19:27:09 -> 19:28:19  [hybrid/research]  qwen3.8:27b-iq3-code144k  ollama-local/gremlin-4070ti-ollama  200
19:27:27 -> 19:28:04  [hybrid/code]      qwen3.8-27b-nvfp4         vllm/esnixi-5090                    200
```

This confirms: when the 5090 is at its ceiling (2), the next job dispatches to the
4070 Ti (`ollama-local`) as the next step in the sequence, including when the
contending jobs come from *different* combos (the cross research/coder case).

## Conclusion

- Global per-connection concurrency ceiling on the shared 5090 27B: **max 2** ✅
- Cross research/coder double-tap: **eliminated** (0 mixed-combo overlap post-fix) ✅
- Overflow to 4070 Ti when 5090 is saturated: **working** ✅

**PASS** (measured max concurrent = 2 ≤ 2).
