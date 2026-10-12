# Ordered dispatchSequence for priority combos (OmniRoute PART 1 engine)

Adds an opt-in `config.dispatchSequence` to the `priority` combo strategy so a pool of targets is dispatched in an exact ordered interleave across simultaneous jobs — the user's requested 5090 → 4070Ti → 5090 → GLM rotation. A per-combo cursor advances at admission (not at settle), so each concurrent request rotates the resolved target list to start one entry further into the sequence. Everything downstream (the per-connection concurrency skip gate, the fail-safe advance to the next entry, and fall-through to the un-sequenced tail / tier 2) is reused unchanged; the new code only chooses the starting offset. The change is PART 1 only — the engine code plus one focused unit test, no live combo config edits — which matches the `ENGINE_CODE` path the plan selected.

Watch for: nothing blocking. The cursor-at-admission design relies on Node's single-threaded event loop for its atomicity, which holds (confirmed); the duplicate 5090 step and tier-2 fall-through are both proven by the test (confirmed). The 429/5xx tier-2 skip is explicitly out of PART 1 scope and the author documents it as unchanged pre-existing behavior (confirmed) rather than adding dead assertions.

**Verdict**: APPROVED

## High-level view

The engine change lands in exactly the three source files plus the test file the plan named. `applyStrategyOrdering.ts` gains an `else if (strategy === "priority")` branch — a branch that genuinely did not exist in the base (confirmed by diffing against `c02725a41`), so this is a real ordered-sequence engine change rather than a config dressed up as code. When `config.dispatchSequence` is a non-empty string array, the resolved targets are rotated so the head follows the sequence; otherwise plain priority order is preserved. The rotation reads `config` as `Record<string, unknown>` and narrows with `Array.isArray` plus a `typeof id === "string"` type guard, so no `as any` leaks in, consistent with the repo's typing rules.

The cursor lives in `rrState.ts` as `dispatchSeqCounters`, mirroring `rrCounters`: module-level, resets on restart, same `MAX_RR_COUNTERS` eviction cap. Its helper `nextDispatchSequenceStart` returns `counter % length` and writes `counter + 1` in one synchronous read-modify-write, which is what makes concurrent requests see successive start offsets. The schema change in `combo.ts` validates `dispatchSequence` as a bounded string array so the key round-trips through save/export instead of only surviving via `.passthrough()`.

The duplicate 5090 step is preserved as two distinct `ResolvedComboTarget` objects (matched by `stepId`), which is the crux of the interleave: both must survive so the attempt loop can try the second when the first is skipped. Un-sequenced targets are appended as the tail, giving the documented fall-through-to-rest-of-combo / tier-2 path. The test suite proves the exact 4-job sequence, the skip-at-capacity fail-safe, and the exhausted-sequence fall-through, and the verification note records all gates (focused test, core typecheck, lint, known-symbols) green with no new suppressions and no changeset/CHANGELOG edits.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking actionable findings. See the notes below for scope boundaries the author documented rather than left as gaps.

</details>

<details>
<summary>Details</summary>

## Rotation design and the admission-time cursor

The interleave hinges on one decision: the cursor advances when the target order is computed (admission), not when the request settles. `nextDispatchSequenceStart` reads the current counter, writes `counter + 1`, and returns `counter % length` — all synchronously, with no `await` between read and write. Under Node's single-threaded event loop this is atomic, so request A rotates with counter=0 (head = sequence[0] = 5090a), leaves counter=1; request B arriving while A is in flight rotates with counter=1 (head = 4070ti), leaves counter=2; and so on. That is precisely what yields 5090 → 4070Ti → 5090 → GLM across four jobs. The author's comment calls this out explicitly, and `rrCounters` is handled the same way, so the concurrency reasoning is sound (confirmed).

```
counter=0  job1 → rotate [5090a,4070ti,5090b,glm]  head=5090a
counter=1  job2 → rotate [4070ti,5090b,glm,5090a]  head=4070ti
counter=2  job3 → rotate [5090b,glm,5090a,4070ti]  head=5090b (second 5090)
counter=3  job4 → rotate [glm,5090a,4070ti,5090b]  head=glm
```

The eviction guard only fires on insert of a new combo key when the map is already at the cap, matching `rrCounters`. One subtlety worth noting (not a defect): because `% length` wraps, the sequence repeats every `length` concurrent admissions regardless of in-flight state — a 5th simultaneous job would rotate back to the 5090 head. For the user's spec that is the intended behavior (job 5 falls through to tier 2 via capacity skip, not via the sequence), and the capacity gate is what diverts it, so the wrap does not break the requirement.

## Duplicate-step preservation and the sequence/tail split

`applyDispatchSequenceOrdering` matches each sequence step id against `orderedTargets` by `stepId`, pushing every match (so the two distinct 5090 steps both land in `seqTargets`) and tracking matched ids in a `sequenced` set. After rotation, targets whose `stepId` is not in that set are appended as the tail in original order. This is the mechanism the plan required: duplicate 5090 steps stay distinct so the attempt loop can try the second after the first is skipped, and un-sequenced targets become the fall-through chain. When no sequence id matches any target, it returns the input untouched, preserving plain-priority behavior. A step id that matches nothing emits a warn and is skipped — a sensible fail-open for a misconfigured combo.

## Fail-safe skip, concurrency gate, and tier-2 fall-through

The new code deliberately does not touch the skip logic — it only picks the start offset, and the existing attempt loop / `evaluateExecuteTargetGates` path handles an at-capacity head by advancing to the next target. The test proves this concretely rather than asserting it in prose: test 2 holds the single 4070 Ti slot, pre-sets the cursor to 1 so the rotated head is the 4070 Ti, and asserts the request still dispatches and lands on the next entry (the second 5090 step), never the saturated 4070 Ti. Test 3 saturates every tier-1 connection and asserts the request falls through to an un-sequenced tier-2 tail step rather than stalling or erroring. Both prove the fail-safe is "skip to next, never stall" (confirmed by reading the test file). Each sequence occurrence remains gated by the per-connection semaphore because the two 5090 steps share one `connectionId` with `maxConcurrent=2`, so the gate correctly admits two 5090 jobs and no more.

## 429/5xx tier-2 skip scope

The plan's PART 2 (free-before-cheap, 429/5xx skip on tier-2 targets) is pure combo config and is explicitly not part of this engine commit. The verification note states the 429/5xx fail-over rides the existing attempt-loop error handling, unchanged by this change, and is covered by the pre-existing `combo-strategy-fallbacks.test.ts`. That is the correct call: adding a redundant 429 assertion to this test file would test unchanged code. No gap here for PART 1 (confirmed via plan scope).

## Test coverage

Three tests, all passing per the verification note (focused run: pass 3, fail 0): the exact 4-job interleave with deterministic per-job admission, the skip-at-capacity fail-safe, and the exhausted-sequence tier-2 fall-through. The interleave test admits jobs one at a time but holds each in a never-resolving blocking handler so all four are genuinely in flight when the sequence is asserted — a clean way to make the per-job assignment deterministic without racing the pre-dispatch await chain. Connection caps are seeded into the DB and the read cache is busted per test, so a cap from a prior test cannot leak.

Not tested: a true parallel race (all four `handleComboChat` calls fired without the admission barrier) is not asserted — reasonable, since that would be non-deterministic and the admission-ordered test already proves the cursor advances per admission. The warn-and-skip path for a sequence id matching no target is not directly exercised, but it is a trivial fail-open log and low risk.

## Typing, lint, and repo-rule compliance

`config` is typed `Record<string, unknown>`, and the access narrows via `Array.isArray` and a `typeof id === "string"` type-guarded `.filter`, so no `as any` is introduced — consistent with the AGENTS.md ban on `as any` and the lint-suppression discipline. The verification note records lint clean on the four changed files with no new suppressions, core typecheck exit 0, and the no-implicit typecheck failing only on a single pre-existing error in the untouched `autoStrategy.ts`. No `.changeset` and no `CHANGELOG.md` / `src/CHANGELOG.md` edits appear in the commit (confirmed by `git show --name-only`), satisfying the maintainer-managed-changelog rule.

## Branch note

The commit landed on `release/v3.8.52`, not `feat/hybrid-reader-combo` named in the review request. The verification note explains this was deliberate per a workflow notification instructing not to switch branches, and the plan itself flags the same discrepancy and states the engine files exist identically on both. The single commit `94ca490d8` contains only the four intended files; no unrelated changes are bundled in.

</details>

<details>
<summary>File map</summary>

- `open-sse/services/combo/applyStrategyOrdering.ts` — new `applyDispatchSequenceOrdering` helper and an `else if (strategy === "priority")` branch that applies the rotation when `config.dispatchSequence` is set.
- `open-sse/services/combo/rrState.ts` — `dispatchSeqCounters` map and `nextDispatchSequenceStart` admission-time cursor helper.
- `src/shared/validation/schemas/combo.ts` — validate `dispatchSequence` (bounded string array) on `comboRuntimeConfigSchema`.
- `tests/unit/combo-dispatch-sequence.test.ts` — new: 4-job interleave, skip-at-capacity, exhausted-sequence tier-2 fall-through.

Full diff: `git show 94ca490d8` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>
