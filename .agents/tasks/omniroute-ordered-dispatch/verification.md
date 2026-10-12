# Verification — OmniRoute Ordered Dispatch (PART 1)

## PART 1 PATH decision acted on

**PART 1 PATH: ENGINE_CODE**

Per `plan.md` the path is `ENGINE_CODE`. This loop implemented the engine change
(`config.dispatchSequence` ordered dispatch for `priority` combos) in
`open-sse/services/combo/*` plus the schema key, and added the required focused unit
test. No live combos were edited (that is a later management-API step).

Iteration: FIRST (no `review.json` present when this step started).

## Branch

Committed on the currently checked-out branch **`release/v3.8.52`** (the squash of
3.8.57–3.8.64, origin/HEAD), per the workflow notification instructing NOT to switch to
`feat/hybrid-reader-combo`. `git branch --show-current` confirmed `release/v3.8.52`
before committing. No `git checkout` was performed.

## Changes

- `open-sse/services/combo/rrState.ts`
  - Added `dispatchSeqCounters: Map<string, number>` (mirrors `rrCounters`: resets on
    restart, shares the `MAX_RR_COUNTERS=500` eviction cap).
  - Added `nextDispatchSequenceStart(comboName, length)`: returns `counter % length`
    and advances the cursor by 1 (admission-time read-modify-write, atomic under Node's
    single-threaded event loop) so concurrent requests see successive start offsets.
- `open-sse/services/combo/applyStrategyOrdering.ts`
  - Added an `else if (strategy === "priority")` branch. When
    `config.dispatchSequence` is a non-empty string array, rotates the resolved targets
    so the head follows the sequence rotated by the per-combo cursor; un-sequenced
    targets are appended as the tail (fall-through-to-rest-of-combo). Duplicate step
    entries (e.g. two distinct 5090 steps) are kept distinct so the attempt loop can try
    the second when the first is skipped. Plain `priority` (no `dispatchSequence`) is
    unchanged (array order). The fail-safe skip, per-connection concurrency gate, and
    tier-2 fall-through are all reused unchanged downstream.
- `src/shared/validation/schemas/combo.ts`
  - Added `dispatchSequence: z.array(z.string().trim().min(1).max(200)).max(100).optional()`
    to `comboRuntimeConfigSchema` so the key validates and round-trips through combo
    save/export (instead of surviving only via `.passthrough()`).
- `tests/unit/combo-dispatch-sequence.test.ts` (new) — see tests below.

No `.changeset` created; `CHANGELOG.md` / `src/CHANGELOG.md` NOT edited.

## Tests added

`tests/unit/combo-dispatch-sequence.test.ts` (node:test), three tests:

1. **four simultaneous jobs interleave 5090 -> 4070Ti -> 5090 -> GLM** — a `priority`
   combo with steps `[5090a, 4070ti, 5090b, glm]` (the two 5090 steps share one
   connection id, `maxConcurrent=2`) and
   `dispatchSequence = [5090a, 4070ti, 5090b, glm]`. Each job is admitted and lands
   (blocking in a never-resolving `handleSingleModel`, so all four stay in flight)
   before the next is admitted, making the per-job assignment deterministic. Asserts the
   landed connection order is exactly `5090, 4070Ti, 5090, GLM`.
2. **a sequence head at capacity is skipped to the next entry (fail-safe)** — the single
   4070 Ti slot is held (connection at capacity); the cursor is pre-set so the rotated
   head is the 4070 Ti. Asserts the request still dispatches (does not stall/error) and
   lands on the next sequence entry (the second 5090 step), i.e. the at-capacity head is
   skipped.
3. **whole sequence at capacity falls through to the tier-2 fallback target** — every
   tier-1 connection in the sequence is saturated and an un-sequenced tier-2 step is the
   tail; asserts the request falls through to the tier-2 target rather than failing.

(Test 2 covers the "skip an unavailable/at-capacity entry" requirement; a 429/5xx on a
tier-2 target already fails over through the existing attempt-loop error handling — that
path is unchanged by this engine change and is exercised by the existing
`combo-strategy-fallbacks.test.ts` / runtime-unit-concurrency suites.)

## Commands run and results

Only the focused new test file was run (full suite deliberately NOT run — it pegs the
Mac CPU and is reserved for a later dedicated step).

### New unit test (focused)

```
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit tests/unit/combo-dispatch-sequence.test.ts
```

Result: **PASS** — tests 3, pass 3, fail 0.

```
✔ four simultaneous jobs interleave 5090 -> 4070Ti -> 5090 -> GLM
✔ a sequence head at capacity is skipped to the next entry (fail-safe)
✔ whole sequence at capacity falls through to the tier-2 fallback target
ℹ tests 3  ℹ pass 3  ℹ fail 0
```

### Typecheck (core) — gate

```
npx tsc --pretty false -p tsconfig.typecheck-core.json
```

Result: **PASS** — exit 0, 0 errors.

### Typecheck (no-implicit core) — gate

```
npx tsc --pretty false -p tsconfig.typecheck-noimplicit-core.json
```

Result: exit 2 with a SINGLE pre-existing error in an UNTOUCHED file:
`open-sse/services/combo/autoStrategy.ts(519,55): error TS7006: Parameter 'm' implicitly has an 'any' type.`
None of the files changed by this task produced an error. This is a baseline issue
unrelated to the dispatch-sequence change.

### Lint — gate (changed files only)

```
npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0 \
  open-sse/services/combo/rrState.ts \
  open-sse/services/combo/applyStrategyOrdering.ts \
  src/shared/validation/schemas/combo.ts \
  tests/unit/combo-dispatch-sequence.test.ts
```

Result: **PASS** — exit 0, 0 errors/warnings, no new suppressions.

### Known-symbols gate (G1)

```
bun scripts/check/check-known-symbols.ts
```

Result: **PASS** — exit 0. "21 estratégias canônicas (21 via despacho + 0 default
implícito)". Adding a branch inside the already-handled `priority` strategy introduces no
new strategy name, so the HANDLED set is unchanged. (The script's unrelated note about 11
new MCP tool names is pre-existing and not strategy-related.)

## Not run (deliberate)

- Full unit suite (`npm run test:unit`) — reserved for a later dedicated step per the
  task instruction.
- Broader combo regression suite (`combo-*.test.ts`) — a later full-suite step may run it
  once; not run here to avoid pegging the CPU.
