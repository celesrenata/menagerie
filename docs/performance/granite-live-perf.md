# Granite live performance (production, K5:V4 KV)

Measured 2026-11-09 on `gremlin-1` (RTX 4070 Ti SUPER 16 GiB), NixOS generation 793: K5:V4 KV cache, EAGLE r12 k=4, 3 sessions x 64K, pool 114,688 positions. Probe: `scripts/granite-live-perf.py` (stdlib only, raw data in `granite-live-perf-2026-11-09.json`). The service was idle at the start (0 connections, 0% GPU). Every request starts with a unique nonce so prefix reuse never helps unless a section says so.

## Prefill (prompt processing, `max_tokens=1`, unique prompts)

| Prompt tokens | Time | Prefill speed |
| ---: | ---: | ---: |
| 1,051 | 0.31 s | 3,342 tok/s |
| 3,015 | 0.87 s | 3,453 tok/s |
| 7,936 | 2.86 s | 2,771 tok/s |
| 15,829 | 7.27 s | 2,177 tok/s |
| 32,293 | 22.28 s | 1,450 tok/s |
| 55,940 | 56.68 s | 987 tok/s |

Speed falls with context (attention cost grows with length), from ~3.4K tok/s short to ~1K tok/s at 56K. Median of 3 runs up to 8K, single run above.

## Decode (single stream, generation length difference method)

| Context | Decode speed (median) | Range | Samples |
| ---: | ---: | ---: | ---: |
| 545 tokens | **120.6 tok/s** | 118.3 - 122.0 | 4 |
| 7,941 tokens | **75.3 tok/s** | 66.3 - 76.4 | 4 |

## Concurrency (3 slots; ~1K-token prompt, up to 200 generated tokens each; median of 3 rounds)

| Clients | Wall | Latency p50 / max | Aggregate output |
| ---: | ---: | ---: | ---: |
| 1 | 1.99 s | 1.99 / 2.05 s | 100.5 tok/s |
| 2 | 2.39 s | 2.33 / 2.49 s | 160.8 tok/s |
| 3 | 2.84 s | 2.82 / 2.96 s | **211.0 tok/s** |
| 4 | 4.74 s | 3.16 / 4.75 s | 168.7 tok/s |

Three clients scale to 2.1x the single-client throughput with only +43% latency. The 4th client has no slot and waits for one (max latency 4.75 s, aggregate drops), the queueing the slot limit is meant to produce.

## Prefix / session reuse (requests that finish naturally)

| Prompt tokens | First (cold) | Identical repeat | Same prefix, new question |
| ---: | ---: | ---: | ---: |
| 3,013 | 2.73 s | 0.07 s | 0.07 s |
| 15,827 | 7.48 s | 0.19 s | 0.21 s |
| 55,939 | 58.29 s | 0.51 s | **0.60 s** (~97x) |

Agent turns that share a long prefix cost well under a second regardless of context size. Caveat found while measuring: a request cut off by `max_tokens=1` (`finish_reason: length`) is NOT resumable, so a repeat of such a request pays the full prefill again; reuse needs the previous generation to finish naturally. The first probe version mistook that for "no reuse".

## GPU during the benchmark (203 one-second samples)

| Metric | Value |
| --- | --- |
| Utilization while busy | 99% avg, 100% peak |
| Power while busy | 246 W avg, 301 W peak (board limit 295 W) |
| Temperature peak | 67 C |
| SM clock while busy | 2,820 MHz avg, 2,730 MHz minimum (max 3,120): no throttling seen |
| Memory | **16,025 of 16,376 MiB peak (~351 MiB headroom)**, 15,371 MiB idle (KV pool is pre-allocated) |

## Same-harness A/B: K5:V4 vs int4 (identical engine build, only the KV format differs)

int4 was applied as a temporary runtime override on the same engine binary and API (`G4_KV8=4`, pool 122,880), measured with the same probe, then reverted. K5:V4 was measured twice (before and after) to bound run-to-run noise: the two K5 runs agree within ~2% on decode and ~3% on concurrency, so the differences below are real. Raw data: `granite-live-perf-2026-11-09.json` (K5 run 1), `granite-live-perf-int4-2026-11-09.json`, `granite-live-perf-k5-run2-2026-11-09.json`.

| Metric | int4 | K5:V4 (mean of 2 runs) | K5 vs int4 |
| --- | ---: | ---: | ---: |
| Decode, 545-token context | 155.5 tok/s | 120.5 tok/s | **-23%** |
| Decode, 7,941-token context | 87.1 tok/s | 74.5 tok/s | **-14%** |
| 1 client, aggregate output | 135.1 tok/s | 101.7 tok/s | -25% |
| 2 clients | 178.6 tok/s | 165.2 tok/s | -8% |
| 3 clients (all slots) | 221.0 tok/s | 211.1 tok/s | -4.5% |
| 4 clients (one queues) | 210.7 tok/s | 169.9 tok/s | -19% |
| Prefill 3K / 8K / 16K / 32K / 56K tokens | 0.92 / 2.87 / 7.22 / 22.07 / 56.24 s | 0.87 / 2.83 / 7.28 / 22.27 / 56.68 s | within -5% to +1% |
| Prefix reuse (56K, same prefix + new question) | 0.61 s | 0.64 s (0.60 run 1) | equal |
| GPU while busy | 232 W avg, 15,941 MiB peak | ~241 W avg, 16,025 MiB peak | +9 W, +84 MiB |
| KV pool | 122,880 positions | 114,688 positions | -6.7% |

(The 1,050-token prefill point was 0.31 s on int4, 0.31 s and 0.41 s on the two K5 runs: one outlier, not a trend.)

Reading it:

- **Prefill and prefix reuse cost nothing**: within ~1% above 8K tokens. The long-context agent workload the service was tuned for is unaffected.
- **Decode pays a price on this probe prompt** (on realistic prompts the gap is 0-9%, see the diagnosis below): K5 is ~23% slower at short context and ~14% slower at 8K, and a lone client sees ~25% less throughput. With all 3 slots busy the aggregate gap shrinks to ~4.5%, because batching hides most of the extra per-token work. The 4-client case widens again to ~19% (the queued request waits on slower slots).
- **Superseded:** an earlier version of this note guessed the gap was in the K5 append kernels or register pressure. The diagnosis below measured the kernels as equal and traced the gap to EAGLE draft acceptance.
- **What it bought**: the accuracy gain measured earlier (golden set: contradiction recall 63% to 100%, risk under-rating 8.3% to 0%, validity 99.7% to 100%). Menagerie's analysis calls are short, mostly single-client and latency-visible (p50 0.75 s on K5), so the decode slowdown is the cost you actually feel there.

## Diagnosis: where the decode gap comes from (and why the table above overstates it)

Follow-up measurements, all on the same staging engine build, service stopped for clean GPU windows and restored afterward.

**1. The K5 kernels are not slower.** Plain greedy decode (no speculation) through the engine's `kv-bench`, best of 3:

| Context | int4 | K5:V4 |
| ---: | ---: | ---: |
| 512 | 68.90 tok/s | 68.83 tok/s |
| 2,048 | 67.24 tok/s | 67.06 tok/s |
| 8,192 | 61.63 tok/s | 61.31 tok/s |

Within 0.5% at every length. Per-phase timing of the speculative verify step (`G4_MULTI_PROFILE=1`, 14 rows/call) is also equal: gemm 14.35 vs 14.33 ms, attention 6.20 vs 5.93 ms per call. There is nothing to recover in the K5 kernels relative to int4.

**2. The gap is EAGLE draft acceptance, and it depends on the prompt.** The live probe's decode prompt ("count upward from 1 forever") needed ~46% more verify calls under K5 (1,216 vs 832 for the same work). On the repository's held-out evaluation families (from `scripts/eagle/ab_heads.py`: 30 chat, 5 novel, 24 serving-style, 2 long-document prompts; fresh requests, greedy, max 256 tokens, EAGLE r12 k=4), with the exact per-request acceptance the engine reports:

| Family | int4 tok/s (accept) | K5:V4 tok/s (accept) | K5 vs int4 |
| --- | ---: | ---: | ---: |
| chat (30) | 136.8 (0.129) | 134.6 (0.127) | -1.6% |
| novel (5) | 136.9 (0.118) | 137.9 (0.120) | +0.7% |
| serving (24) | 154.0 (0.145) | 140.3 (0.125) | **-8.9%** |
| long 8-13K (2) | 29.8 (0.084) | 30.8 (0.091) | +3.4% |
| plain, no speculation | 67.9-68.4 | 67.6-68.7 | equal |

Both formats keep the exact-verify contract (speculative output == plain greedy output for that format: true for both).

**Conclusion.** On realistic prompts K5:V4 decodes at the same speed as int4, except serving-style prompts (-9%). The -23% in the A/B table above came from an unrepresentative probe prompt and should not be quoted as the general cost. The serving-style gap matches how the EAGLE r12 head was trained: its training features and target tokens were produced with `G4_KV8=1` (int8) on serving-style prompts (`scripts/eagle/stage_r12_prep.sh`), so it predicts that target's outputs. K5's outputs differ at a few near-ties, and acceptance drops most on the family the head was fitted to. This is an inference from the data, not a proven cause.

**The remaining lever is the draft head, not the KV kernels.** A head retrained (or fine-tuned) on features and targets produced with `G4_KV8=5` should recover the serving-style gap. That is a full run of the repo's existing r12 training pipeline, not done here.

Raw data: `granite-k5-decode-diagnosis-2026-11-09.json`.

## Follow-up: serving-style decode gap: policy and sample investigation (2026-11-09)

Two repeats per format, serving-style held-out prompts, EAGLE r12 k=4, fresh requests, `G4_SERVE_DEBUG=1`:

| Run | int4 | K5:V4 |
| --- | ---: | ---: |
| a | 153.6 tok/s, accept 0.145 | 140.0 tok/s, accept 0.125 |
| b | 153.5 tok/s, accept 0.145 | 140.0 tok/s, accept 0.125 |

- The result is exactly reproducible (deterministic greedy), so the -9% is not run-to-run noise.
- The adaptive draft policy is not involved: both formats kept drafting on for every request (0 switches to plain).
- The 24-prompt set holds only **9 distinct prompts** (repeated 4, 4, 3, 3, 2, 2, 2, 2, 2 times). Per distinct prompt, K5 is slower on 3 (-20%, -12%, -14%), equal on 3, and faster on 3 (up to +10%). The weighted -9% is dominated by the single largest 4x-repeated prompt (176 vs 140 tok/s).
- None of the 24 outputs are identical between formats: each format follows its own greedy continuation, and the draft head finds some continuations easier to predict than others.

Conclusion: the serving-style gap is per-content variance between two different greedy continuations measured on a small, duplicated set, not a systematic K5 cost. With the other families (chat -1.6% over 30 prompts, novel +0.7%, long +3.4%) and r12 losing only ~1% offline when moved to K5 features, speculative decode speed under K5:V4 is effectively equal to int4. No remaining K5-specific lever was found; a faster decode would need general head or engine improvements.

## Caveats

- One session on an otherwise idle service; no real agent traffic was present, so contention effects are not captured. K5 was measured twice and int4 once.
- GPU telemetry covers the first (full) probe run, not the later resume re-run.
- Decode speed at 8K varied 66-76 tok/s across 4 samples; at 545 tokens it was tight (118-122).
- Peak GPU memory (16,025 MiB) is ~25 MiB higher than seen earlier (15,999 MiB) and leaves ~351 MiB free; large activation spikes from new workloads are the thing to watch.
