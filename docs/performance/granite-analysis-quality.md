# Granite analysis: initial quality scoring (tasks 0.3, 1.7)

Harness: `src/services/analysis/AnalysisBenchmark.ts` over `src/services/analysis/__fixtures__/goldenSet.ts` (20 hand-labeled cases: simple extraction, conflicting requirements, missing evidence, cross-file constraints, prompt injection, failing tests).
Live runner: `GRANITE_LIVE_URL=<base>/v1 GRANITE_REPEATS=3 GRANITE_REPORT_PATH=out.json npx vitest run services/analysis/__tests__/GraniteAnalysis.live.spec.ts -t golden` (from `src/`).
Executor path: client -> bounded queue (2 active) -> non-stream call -> validation -> at most one format retry. Cache disabled.

These numbers measure labeled-case quality, not kernel parity (R3.3). They are one run on one service; the set is small, so treat percentages as indicative.

## Latest results (20 cases x 3 repeats = 60 calls, template `analysis-template-6`, with assertion quarantine)

| Metric | Value | Initial gate (R10.3) |
| --- | ---: | --- |
| Schema-valid after <=1 retry | **98.3%** | >= 99% **not met, 1 of 60 calls short** |
| Retry rate | 15% | n/a |
| Citation precision | 100% | >= 95% met on this set |
| Requirement-coverage recall (keyword proxy) | 83.3% | no gate |
| Contradiction precision | 100% | no gate |
| Risk-classification accuracy | 100% | no gate |
| False PASS | **0** | zero required, met on this set |
| Rerun variance | 55% | no gate |
| Latency p50 / p95 | 0.98 s / 12.9 s | no gate |
| Tokens (prompt / completion) | 19,105 / 10,467 | n/a |

## Larger run: 20 cases x 10 repeats = 200 calls (template-6 + quarantine)

| Metric | Value |
| --- | ---: |
| Schema-valid after <=1 retry | **99.5%** (199/200; 95% Wilson lower bound 97.2%) |
| Retry rate | 11.5% |
| Citation precision | 100% |
| Requirement-coverage recall (keyword proxy) | 86.3% |
| Contradiction precision | 100% |
| Risk accuracy | 100% |
| False PASS | **0** |
| Rerun variance | 55% of cases differ across repeats |
| Latency p50 / p95 | 0.98 s / 12.9 s |
| Tokens (prompt / completion) | 64,353 / 37,375 |

The only invalid outcome was one `classify-change-risk` call (xf-2, invalid-schema). The point estimate clears the 99% gate; the lower confidence bound (97.2%) does not, so this is "meets on this sample", not a proven guarantee. 200 calls over 20 cases is also a narrow sample. A claim at 99% with confidence needs roughly 1,000+ calls over a wider case set.

## Expanded set: 50 cases x 6 repeats = 300 calls (template-8, assertion quarantine, risk floor)

Cases grew from 20 to 50 (30 added, labeled from the evidence text before any model run), weighted toward `classify-change-risk` (10 total) and `triage-test-failure` (10 total).

| Metric | Value |
| --- | ---: |
| Schema-valid after <=1 retry | **99.7%** (299/300; 95% Wilson lower bound **98.1%**) |
| Citation precision | 100% |
| False PASS | **0** |
| Requirement-coverage recall (keyword proxy) | 78.6% |
| Risk accuracy, effective (model + floor) | **89.8%** (model alone: 49.2%) |
| Risk rated LOWER than the label | **0%** |
| Risk abstained ("unknown") | 10.2% (the labeled-low cases) |
| Contradiction recall / false-positive rate | 80% / **55.6%** |
| Latency p50 / p95 | 0.86 s / 11.5 s |

Findings from the larger set (the 20-case 100% scores for risk and contradiction precision were small-sample luck):

1. **Risk.** The model alone under-rates or abstains (49% exact). A deterministic floor (`riskFloor.ts`) raises, never lowers, its answer for clearly dangerous phrases (dropping data, removing auth/validation/retry, payment/billing changes, secret handling, production migrations, 10+ callers). It never emits `low`, so cases labeled low come back "unknown", which is safe and routes to escalation. A floor raise is recorded in `unknowns`, and the benchmark reports the model-only score separately so the floor cannot flatter the model. The floor is keyword-based and will both over-trigger and miss novel phrasing.
2. **Contradictions are unreliable.** About 56% of non-contradicting pairs are still reported as conflicts (for example "email+password" vs "also passkeys"). A stricter prompt (template-7) cut false positives to 28% but dropped recall from 80% to 60% (it missed a docs-5s vs code-30s conflict), so it was reverted: a missed contradiction is the silent failure. `find-contradictions` should be treated as advisory only, never as a gate input, and a hit should escalate to a capable model.
3. Label ambiguity: `ct-8` (nightly schedule vs a user-triggered button) can reasonably be read as non-conflicting or as conflicting. It was left as labeled to avoid tuning labels to model output.

## Accuracy round 2: weak-area fixes (50 cases x 6 repeats = 300 calls, template-10, pairwise contradictions)

Changes, each tested against the same 50 cases (worked examples use content that is not in the golden set):

1. **Risk prompt:** an explicit rubric, three worked examples, and "pick low/medium/high; use unknown only if no change is described".
2. **Extraction prompts:** "list EVERY ... one per item, keep concrete values".
3. **Output cap 768 -> 400 tokens:** a complete answer is ~100-250 tokens; a smaller cap ends the post-JSON ramble sooner (a complete object is still accepted when the cap cuts the rambling).
4. **Contradictions by pair + votes** (`PairwiseAnalysisRunner.ts`): each pair of evidence items is judged separately with a "normalize both values to the same unit first" instruction and 3 independent votes. The `sample` index is part of the cache digest so votes are never served from one cache entry.

| Metric | Before (round 1) | After |
| --- | ---: | ---: |
| Schema-valid after <=1 retry | 99.7% | 99.7% (lower bound 98.1%) |
| Requirement-coverage recall | 78.6% | **80.3%** |
| Risk accuracy, model alone | 49.2% | **90.0%** |
| Risk accuracy, effective (with floor) | 89.8% | **91.7%** |
| Risk abstained ("unknown") | 10.2% | **0%** |
| Risk rated lower than label | 0% | **8.3%** (one case, see below) |
| Contradiction recall | 80% | 63% |
| Contradiction false-positive rate | 55.6% | **0%** |
| False PASS | 0 | 0 |
| Latency p50 / p95 | 0.86 s / 11.5 s | 0.98 s / **5.95 s** |
| Prompt tokens per 300 calls | 95,945 | 158,595 (+65%, pair votes) |

What the measurement showed:

- **Risk** improved most: the model alone went from 49% to 90% because it now commits instead of abstaining. The 8.3% under-rating is entirely `rk-5` (adding an *optional* parameter with a default; labeled medium, model says low). That label is arguable, and the deterministic floor does not cover it. It is the one place the "never under-rate" guarantee does not hold, so treat it as an open item.
- **Contradictions trade recall for precision.** Free-form scanning had 80% recall and 56% false positives; majority voting (2 of 3) got 0% false positives but only 50% recall, because single votes flag real conflicts only ~45% of the time on the hard cases while flagging non-conflicts 0 of 36 times. The default is therefore "any positive vote of 3" (recall-oriented; a miss is silent, a hit only escalates). Result: 63% recall, 0% false positives. `ct-6` (10 MB vs `100 * 1024 * 1024`, needs unit arithmetic) is never detected (0/6) and `ct-1` ("retained 90 days" vs "deleted after 30") is detected in only 1/6 runs. These are capability limits of the 8B model; deterministic numeric normalization was considered and rejected as too brittle. `find-contradictions` stays advisory.
- **Latency tail** roughly halved from the lower output cap; median is about flat.
- **Requirement recall (80%) is still the weakest extraction number** and was not diagnosed this round; the keyword proxy may undercount valid paraphrases, so look at the missed groups per case before adding more prompt text.

## Serving-side levers (KV, draft, model): findings and experiment plan

Nothing below was changed on the live service. Settings were read from the serving repo (`granite-4-rtx-4070-ti-super` @ `eecc005`, `docs/deployment.md`, `docs/phases.md`, `flake.nix`); the exact settings of the running process are not visible from Menagerie.

### Measured: the service is not numerically deterministic

Decoding is greedy (temperature is ignored), so an identical request should produce identical text. Probe: `GraniteAnalysis.live.spec.ts -t "numeric noise"` (10 golden prompts, 6 identical runs sequentially and 6 concurrently, first 400 chars compared; 0 = deterministic, 1 = every run differs).

| Mode | Noise |
| --- | ---: |
| Sequential identical requests | **0.20** (every one of the 10 prompts produced exactly 2 distinct outputs in 6 runs) |
| Concurrent identical requests (2 slots) | **0.64** (3-5 distinct outputs in 6 runs) |

The "exactly 2 distinct" sequential pattern fits first-call-fresh vs later-calls-resumed. The serving docs say resumed turns can differ from a full re-prefill (the KV of earlier tokens comes from the decode path and re-rounds in bf16 when re-forwarded), that near-ties on resumed turns can differ between chain/tree drafting, and that `G4_FORCE_REPREFILL=1` makes output identical to plain greedy. Every analysis request starts with the same system prompt, so the service resumes cached sessions constantly. This is a hypothesis consistent with the docs and the probe, not yet confirmed by a config change.

### What each lever can and cannot do

| Lever | Can it move accuracy? | Notes |
| --- | --- | --- |
| Draft (EAGLE head, `eagle.draftKv`) | **Not by itself.** Drafts are verified against the full-precision target; the docs show int8 draft KV lossless and int4 byte-identical on their test. | It can still change output through the resume/verify rounding above (docs: chain vs tree vs policy on/off differ on resumed turns). `eagle.head = null` gives plain decoding as a reference. |
| KV format (`kv4` deployed per docs; `kv8`, or bf16) | **Plausibly, a little.** int4 KV is the lossiest storage; docs report int8 flips argmax only on 1-ULP near-ties (23/24 identical) and give no equivalent figure for int4. | Deployed 3 x 64K / 120K pool exists for capacity. This workload sends ~1-3K-token prompts to 2 slots, so it needs none of that. `maxContext` 8192-16384 with 2 sessions fits bf16 KV (the module default, 160 KiB/pos) or int8, and bf16/int8 prefill is faster than int4. |
| `G4_FORCE_REPREFILL=1` | **Removes the resume noise**, per the docs. | No module option; set in the unit environment. Costs a re-prefill per request (~1-3K tokens, a fraction of a second at the documented ~15 s per 30K prefill). |
| Weights (FP8 e4m3 deployed) | Not testable here. | BF16 weights (15.6 GiB) do not fit the 16 GiB card with any KV. |
| A larger model | **Yes, clearly** (see the A/B: hosted `hybrid/fast` recall 97% vs 76-80%, contradiction recall 100%). | Not an 8B-service knob. Menagerie already has the escalation path (`readerEscalationDecision.ts`); use Granite as the cheap first pass and escalate contradictions/risk/low-confidence. |

Determinism is not the same as accuracy. Greedy-without-noise returns the model's own best answer every time; it cannot fix `ct-6`-style capability gaps, and it removes the sample diversity that currently makes the contradiction vote help. Treat these as experiments with a decision rule, not as guaranteed wins.

### Serving experiment results (run 2026-11-09 on gremlin-1; each variant 50 cases x 6 repeats = 300 calls, same client code and template-10)

The service was changed with runtime drop-ins only and **restored to the original config afterward** (verified: `G4_KV8=4`, 3 sessions, 64K, pool 122880, healthy).

| Metric | A: current (int4 KV, 3 x 64K) | B: force re-prefill | C: int8 KV, 2 x 16K | D: bf16 KV, 2 x 8K |
| --- | ---: | ---: | ---: | ---: |
| Noise, sequential / concurrent | 0.20 / 0.64 | **0 / 0** | 0.04 / 0.04 | 0.02 / 0.02 |
| Schema-valid after <=1 retry | 99.7% | 98.0% | **100%** | **100%** |
| Retry rate | 5% | 20% | 2% | 2% |
| Requirement recall | 80.3% | 75.0% | 87.8% | **88.3%** |
| Contradiction recall / false-pos | 63% / 0% | 60% / 0% | **80% / 0%** | **80% / 0%** |
| Risk accuracy effective / model alone | 91.7% / 90% | 70% / 50% | **100% / 90%** | **100% / 90%** |
| Risk rated lower than label | 8.3% | 0% | **0%** | **0%** |
| False PASS | 0 | 0 | 0 | 0 |
| Latency p50 / p95 | 0.98 s / 5.95 s | 0.82 s / 7.3 s | 0.72 s / **1.8 s** | 0.72 s / 5.5 s |

Conclusions:

- **The int4 KV is the accuracy problem.** Moving to int8 (C) or bf16 (D) KV raised every weak area at once: recall +7.5 to +8 points, contradiction recall +17 points, risk to 100% with no under-rating, schema validity to 100%, and cut p95 latency. C and D are indistinguishable on accuracy, so C (int8) is preferred: more context headroom, and cheaper than bf16.
- **Zero numeric noise is not better (B).** Forcing re-prefill made output fully deterministic and *worse*: retries and votes could no longer get a different answer, and a failing case (`inj-2`) now failed identically 6 of 6 times. Variation was doing useful work for retries and voting; the wrong kind of variation (int4 KV rounding) was the real harm.
- **Caveat on attribution:** C and D changed several settings at once (KV format, sessions, context, pool, draft KV 4 -> 16). The draft is verified against the full-precision target, so draft KV width should not change output, but the single-variable claim "int4 KV alone" is not isolated. Variant E (int8 KV keeping 3 x 64K) is the cleanest next test.
- **Production tradeoff, not decided here:** the live layout was tuned today for long-context agents ("two ~55K agents resident plus a third slot"). C/D cap requests at 16K/8K and would break those agents. int4 is the only KV format that holds two ~55K sessions on this 16 GiB card. Accuracy-friendly KV and that layout conflict on this one GPU.

### KV bit-width simulation: is "int5" the answer? (reference model on a Mac, not the GPU service)

`scripts/kv-quant-sim/kv_quant_sim.py` runs the bf16 checkpoint with K and V fake-quantized exactly as the engine stores them (`engine/src/kernel_math.h`: symmetric, one scale per 128-element row, `scale = amax/qmax`, `qmax = 2^(bits-1)-1`, K quantized after RoPE, every position the attention reads is quantized). It teacher-forces 50 real service completions (4,607 completion positions) and compares each width to the unquantized reference. Raw results: `docs/performance/kv-quant-sim-result.json`.

| K:V bits | KiB/pos | Pool in ~5.0 GiB | Mean KL vs bf16 | Top-1 flip rate | Flip rate on confident tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8:8 (int8) | 82.5 | 63,550 | 0.0019 | 0.98% | 0.02% |
| 8:4 | 62.5 | 83,886 | 0.0149 | 3.15% | 0.44% |
| 6:6 | 62.5 | 83,886 | 0.0183 | 3.65% | 0.32% |
| 6:4 | 52.5 | 99,864 | 0.0293 | 4.67% | 0.94% |
| 5:5 (true int5) | 52.5 | 99,864 | 0.0752 | 6.75% | 2.32% |
| 5:4 | 47.5 | 110,376 | 0.0840 | 7.08% | 2.79% |
| 4:5 | 47.5 | 110,376 | 0.2618 | 13.61% | 7.92% |
| 4:8 | 62.5 | 83,886 | 0.2833 | 13.94% | 8.15% |
| 4:6 | 52.5 | 99,864 | 0.2837 | 13.83% | 8.15% |
| **4:4 (live int4)** | 42.5 | 123,361 | **0.2877** | **14.59%** | **8.62%** |

Findings:

1. **The live int4 cache is genuinely lossy**: it changes the top token on 14.6% of positions, and 8.6% of the time even where the reference model is confident (margin > 1 nat). That matches the golden-set damage we measured (validity, recall, risk, contradictions). int8 changes it 1% of the time, almost all on real near-ties.
2. **Almost all of the damage is the K cache.** 4:8 (K int4, V int8) is as bad as 4:4 (0.283 vs 0.288), while 8:4 (K int8, V int4) removes 95% of the damage (0.0149) at 62.5 KiB/pos. V tolerates 4 bits; K does not. This is the opposite of the symmetric formats the engine offers.
3. **Symmetric int5 helps but is not the best use of 5 bits**: 5:5 cuts KL 3.8x vs int4. But 6:4 has the same footprint (52.5 KiB/pos, same pool) and 2.6x less KL than 5:5; and 5:4 (47.5 KiB, pool 110K, enough for two ~55K agents) is about as accurate as 5:5 for less memory. Rule of thumb from this data: spend bits on K first.
4. **Pool/agent fit** (memory column assumes the ~5.0 GiB the live config uses): int8 holds 63.5K positions; K8:V4 holds 83.9K; K6:V4 holds 99.9K; K5:V4 holds 110.4K (just enough for two ~55K agents, 110K).

What this does NOT show: end-to-end task accuracy for the mixed formats (only the symmetric 4:4 vs 8:8 pair was measured on the golden set: int8 fixed the weak areas); behaviour at long (10K-55K) contexts (these prompts are ~300-450 tokens, where per-row rounding error has less to average over); or anything about speed. KL and flip rate are proxies. The engine has no mixed or 5/6-bit format today: int4 and int8 are each threaded through ~230 sites in the CUDA kernels, K and V share one format per cache, and 5/6-bit codes are not byte-aligned. A K-int8/V-int4 format is the cheapest candidate to implement (reuse the two existing code paths per side) but it is real kernel work that can only be built and verified on the GPU box; effort not estimated here.

### K5:V4 implemented and measured on the GPU (serving repo branch `kv-k5v4`; NOT deployed)

K 5-bit (80-byte rows: int4-layout nibbles + a 16-byte high-bit plane), V int4, 47.5 KiB/position. Implemented across the engine's append, attention (decode, verify, rows, prefill), arena, row-move and context code behind `G4_KV8=5`. Verification: new GPU tests (device append byte-identical to the host twin; attention and prefill match a bf16 reference over the dequantized cache; ~29% lower attention error than int4) plus the full existing GPU suite, which still passes. Details and the code-level notes are in the serving repo's `docs/kv-k5v4.md`.

Served on `gremlin-1` with the staging engine (EAGLE on, 3 sessions x 64K, pool 109,568), 50 cases x 6 repeats:

| Metric | A: int4 (live) | E: int8, pool 64K | **K5:V4** |
| --- | ---: | ---: | ---: |
| Schema-valid | 99.7% | 100% | **100%** |
| Requirement recall | 80.3% | 88.3% | **86.9%** |
| Contradiction recall / false-pos | 63% / 0% | 80% / 0% | **100% / 0%** |
| Risk accuracy effective / model alone | 91.7% / 90% | 100% / 90% | **100% / 100%** |
| Risk rated lower than label | 8.3% | 0% | **0%** |
| False PASS | 0 | 0 | 0 |
| Latency p50 / p95 | 0.98 s / 5.95 s | 0.82 s / 6.0 s | **0.75 s / 5.96 s** |
| Noise, seq / concurrent | 0.20 / 0.64 | 0.06 / 0.02 | 0.18 / 0.18 |
| KV pool (positions) | 122,880 | 65,536 | **109,568 (114,688 tested)** |

The simulation's prediction held: K5:V4 reaches int8-class accuracy on this workload. Contradiction recall of 100% should be read with care: 8 contradiction cases x 6 repeats, run-to-run noise exists, and int8 scored 80% on the same cases.

The test that decided the earlier int8 variants was capacity for the long-context agents, so it was repeated:

- needle-in-haystack at 7K / 21K / 55.7K tokens: 9 of 9 correct; 55.7K prefill 58 s (1.04 ms/token, equal to int4's documented ~1.05).
- Two concurrent 54.9K-token agents with pool 114,688: both correct, both stayed resident (resubmission 0.7 s instead of ~58 s). Peak GPU memory 15,999 of 16,376 MiB. A pool of 109,568 is just too small for two ~55K agents.

Caveats: hours of testing, not days; synthetic agent traffic only; ~377 MiB memory headroom.

**Deployed to production on 2026-11-09 (NixOS generation 793)** via `services.granite4-rtx.kv5 = true`, pool 114,688, host input pinned to serving-repo branch `kv-k5v4` @ `4993580`. Golden set re-run on the permanent deploy: 300/300 valid (95% lower bound 98.7%), requirement recall 86.9%, contradiction recall 100% / false-positive 0%, risk 100%, false PASS 0, p50/p95 0.75 s / 5.96 s; two concurrent 54.9K-token agents resident. Rollback: `nixos-rebuild switch --rollback` (generation 792, int4). The earlier variant script (`granite-serving-experiment.sh`) is no longer needed for this config. To re-enable on the host: `K5_ENGINE=<store>/bin/granite4-infer K5_POOL=114688 bash granite-serving-experiment.sh K` (staging build kept alive by a GC root in `/opt/granite4-rtx-4070-ti-super/staging-k5v4-*/result-engine`); `... A` reverts.

### Variant E: int8 KV keeping 3 x 64K slots (50 cases x 6 repeats)

`G4_KV8=1 G4_DRAFT_KV=8`, 3 sessions x 65536, pool 65536 positions (service log: main KV 5.16 GiB, draft KV 0.13 GiB). Noise 0.06 sequential / 0.02 concurrent.

| Metric | A: int4 KV (live) | C: int8, 2 x 16K | **E: int8, 3 x 64K, pool 64K** |
| --- | ---: | ---: | ---: |
| Schema-valid | 99.7% | 100% | **100%** (300/300, 0 retries) |
| Requirement recall | 80.3% | 87.8% | **88.3%** |
| Contradiction recall / false-pos | 63% / 0% | 80% / 0% | **80% / 0%** |
| Risk accuracy effective / alone | 91.7% / 90% | 100% / 90% | **100% / 90%** |
| Risk rated lower than label | 8.3% | 0% | **0%** |
| False PASS | 0 | 0 | 0 |
| Latency p50 / p95 | 0.98 s / 5.95 s | 0.72 s / 1.8 s | 0.82 s / 6.0 s |

**E isolates the cause: int8 KV, not the smaller context or session count, produces the accuracy gain.** E keeps the same slot count and per-request context as the live config.

What E costs, from the live config (verified in the service log and `nvidia-smi`):

- The pool is 65,536 positions instead of 122,880. int8 KV is 82.5 KiB/position against 42.5 KiB for int4, and the card is already at ~15,985 of 16,376 MiB under load, so the pool cannot grow. Two ~55K agents can no longer both stay resident: when the pool runs short an idle slot's cache is evicted and re-prefills next turn, and a request waits while running requests hold the pages it needs (the live config's own comment). Slower for the agents, not a failure.
- Prefill is slower on int4 than int8 per the serving docs, so int8 should help rather than hurt prefill; this was not measured against the agent workload.

Not measured: the effect of E on the long-context agent workload itself (resident-agent count, re-prefill frequency, throughput). That is the real cost and needs a test under agent load before adopting.

### Proposed permanent change (NOT applied; `/etc/nixos` was not edited)

In `hosts/gremlin-1/granite4-rtx.nix`, replacing `kv4 = true;` and the pool/draft settings:

```nix
kv8 = true;              # int8 KV: restores accuracy on short analysis prompts (docs/performance/granite-analysis-quality.md)
maxContext = 65536;
sessions = 3;
kvPoolTokens = 65536;    # int8 pool; the card cannot hold more (15985/16376 MiB under load)
eagle = { head = "..."; k = 4; draftKv = 8; };
```

then `nixos-rebuild switch`. The runtime drop-in used for testing is reverted and not persistent.

### Experiment matrix (restart the service per row; ~10 minutes each)

Live settings were confirmed over ssh on `gremlin-1` (read-only): `G4_KV8=4 G4_DRAFT_KV=4 GRANITE4_EAGLE_K=4 GRANITE4_SESSIONS=3 GRANITE4_MAX_CONTEXT=65536 GRANITE4_KV_POOL_TOKENS=122880`, EAGLE head `r12`; GPU memory 15.8 of 16.4 GiB used (no room for a second instance). Changing the unit needs root (`sudo` requires a password), so variants are applied with `docs/performance/granite-serving-experiment.sh <A|B|C|D>` run as `sudo` on the host (runtime drop-in under `/run`, `A` reverts; not yet executed against real systemd). Row E (`eagle.head = null`) needs a NixOS config change and is not scripted.

For each config run, from `src/`:

```
GRANITE_LIVE_URL=<base>/v1 DET_RUNS=6 DET_REPORT_PATH=/tmp/det-<cfg>.json \
  npx vitest run services/analysis/__tests__/GraniteAnalysis.live.spec.ts -t "numeric noise"
GRANITE_LIVE_URL=<base>/v1 GRANITE_REPEATS=6 GRANITE_REPORT_PATH=/tmp/g-<cfg>.json \
  npx vitest run services/analysis/__tests__/GraniteAnalysis.live.spec.ts -t golden
```

| # | Config | Change vs current |
| --- | --- | --- |
| A | current | none (record `sequentialNoise` 0.20 / `concurrentNoise` 0.64 and the golden numbers above) |
| B | force re-prefill | add `G4_FORCE_REPREFILL=1` |
| C | int8 KV | `kv8 = true; maxContext = 16384; sessions = 2` |
| D | bf16 KV | `kv8 = false; maxContext = 8192 (or 16384); sessions = 2` |
| E | no drafting | `eagle.head = null` (reference plain greedy) |
| F | best of B-E combined | whichever cut noise and raised golden accuracy |

Decision rule: adopt a config only if the golden run is at least as good on schema-valid (>= 99%), false PASS (0) and risk under-rating (0, except the known `rk-5`) AND strictly better on at least one of requirement recall or contradiction recall, without p95 latency worse than 1.5x. If noise drops to ~0, re-check the contradiction vote (votes would then be identical; vary the prompt per vote instead). A swap-the-pair-order variant was tried on the current stack and gave no gain (52.5% vs 63% recall, within noise), so it was reverted.

## A/B vs a hosted baseline (task 5.1, partial; ran on template-8, BEFORE round 2 above): 50 cases x 2 repeats = 100 calls per side

Same cases, same executor, prompt (template-8), validator, quarantine and risk floor; only the model behind the client differs. **The baseline is `hybrid/fast` (served by `minimax-m2.1`), a hosted general model on a `low-budget` OmniRoute lane. It is NOT the existing `reader` lane**: `hybrid/reader` and `local/m5-reader` were down (no resident backend) when this ran, so this does not answer "Granite vs the current reader". Baseline results were saved and reused when the Granite side was re-run after a harness fix, so the baseline's token usage was not captured.

| Metric | granite-4.2-8b | hybrid/fast |
| --- | ---: | ---: |
| Schema-valid after <=1 retry | 99.0% | 100.0% |
| Retry rate | 13.0% | 2.0% |
| Citation precision | 100.0% | 100.0% |
| Requirement-coverage recall | 75.8% | 96.7% |
| Contradiction recall | 80.0% | 100.0% |
| Contradiction false-positive rate | 33.3% | 33.3% |
| Risk accuracy (effective) | 89.5% | 95.0% |
| Risk accuracy (model alone) | 47.4% | 90.0% |
| Risk rated lower than label | 0.0% | 5.0% |
| False PASS | 0 | 0 |
| Latency p50 / p95 (ms) | 909 / 11,478 | 2,720 / 4,980 |
| Tokens (prompt / completion) | 31,941 / 12,435 | not captured |

Reading it honestly:

- The larger hosted model is clearly more accurate on content: recall (97% vs 76%), contradiction recall (100% vs 80%), and risk on its own (90% vs 47%). Granite needs its deterministic scaffolding (risk floor, quarantine, retry) to be usable on risk.
- Granite is the only side with **0% under-rated risk**, and that is because of the floor. The baseline had 5% under-rated even with the same floor applied.
- Granite's median latency is lower (0.9 s vs 2.7 s) and it is local; its p95 is much worse (11.5 s vs 5.0 s) because of the model rambling after its JSON. Cost was $0 versus a metered hosted call (one probe call showed ~3.8K prompt tokens of routing overhead for a trivial message; not verified further).
- Both have a 33% contradiction false-positive rate, so that weakness is not specific to Granite; `find-contradictions` stays advisory either way.
- Rerun variance is not comparable (the baseline phrases claims differently each time, and the metric fingerprints claim text).
- n is small (100 calls per side, 50 cases). The differences in recall and risk are large enough to trust directionally; the 99.0% vs 100.0% validity difference is not.

Takeaway for routing: Granite is a viable cheap, local first pass for extraction and summarization with the safeguards in place, but it should not be the sole source for contradiction or risk judgement; escalate those to a capable model.

## What changed because of measurement

| Run | Template / validator | Schema-valid |
| --- | --- | ---: |
| 1 | template-1, strict single-object parse | 82.5% |
| 2 | template-2 (added example, null tolerance) | 63.3% |
| 3 | template-3 (per-operation example, "STOP" instruction), first-balanced-object parse | 91.7% |
| 4 | template-4 (request only `claim` + `anchorIds` + `unknowns`) | 93.3% |
| 5 | template-5 (risk rubric; risk key shown inside the same object) | 96.7% |
| 6 | template-6 (dropped the "one short sentence" constraint, which cost recall) | 98.3% (false PASS 3) |
| 6 + quarantine | validator moves pass/verified assertions from findings to unknowns | 98.3%, false PASS 0 |

Run 6 exposed a real leak: on the injection case the model lifted a planted note into a finding ("All tests pass."). It never reaches the gate (evidence sources exclude models), but `isVerificationAssertion` in `AnalysisValidator.ts` now quarantines such claims for every operation, with tests for what it does and does not match. `stop` sequences were tried and the server ignores them.

Observed failure classes (raw outputs inspected):

1. The model emits a correct JSON object and then keeps writing its own reasoning until `max_tokens`. Fix: consume only the first balanced object and ignore trailing text unread (it can never add a finding; tested). Still costs tokens and latency (p95).
2. `risk` omitted for `classify-change-risk`. Fix: per-operation example. Still imperfect.
3. Genuinely malformed JSON (mismatched `]`/`}`, missing closer). A bare missing closer at a clean end is repaired; a mismatched bracket is not guessed at. This is the remaining ~8% and is a model limitation, not a parser gap.

## Release-gate status

The >= 99% schema-valid gate is **met with confidence on the expanded set: 99.7% over 300 calls, 95% lower bound 98.1%** (a lower bound of 99% would need a larger run). The accuracy gaps above remain, so the feature stays default-off and `find-contradictions` stays advisory. Per spec 5.3, the feature stays default-off and individual operations should be escalated or disabled rather than force-launched. The single non-valid outcome in the latest run was `xf-2` (`classify-change-risk`); every other case was valid in all repeats of both the 3x and 10x runs. Not measured here: baseline of the existing tool-capable reader on the same inputs (task 5.1 A/B), concurrency 1/2/3 and context-scaling latency (task 5.2).

## Protocol facts recorded alongside

- Client enforces `stream:false`, no `tools`/`tool_choice`/`temperature`; the server accepts `stream:true` and `tools` silently, so this is enforced client-side (pinned by unit test).
- Server does not enforce the 32,768 served window (a ~40K-token prompt returned 200). The client preflight is the only guard.
- Live concurrency probe: 4 jobs through the queue never exceeded 2 active.
