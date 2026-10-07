# Verification — worker-result-prose-salvage

## The defect (as diagnosed, confirmed by reading the files)

`normalizeWorkerResult(raw, { workerName })` is the only transform between a
worker's raw `attempt_completion` output and the `WorkerResult` the parent reads
back (`runParallelTasks.ts` serializes exactly what this function returns —
`result.result = JSON.stringify(workerResult)`; there is no other channel).

Workers emit their final result as **markdown prose**, not a JSON-encoded
`WorkerResult`. The old normalizer:

1. tried `JSON.parse` on the string; prose throws → fell into `failedResult`,
2. `failedResult` built `status: "failed"` with a summary that **truncated the
   raw text to `MAX_RAW_SUMMARY_CHARS = 500`** (via `describeRaw`) and wrapped it
   in `"... does not conform to the WorkerResult contract. Raw output: <excerpt>"`.

So correct work was discarded and clipped to a ~500-char diagnostic excerpt. The
user cannot change what workers emit (strict-JSON dispatch is blocked), so the
fix lives entirely in the normalizer.

## The fix (behavior before → after)

Before: non-JSON prose and schema-failing JSON → `status: "failed"`, summary
truncated to 500 chars with an ellipsis, full text lost.

After: `normalizeWorkerResult` has three outcomes:

1. **Conforming output unchanged.** A JSON-encoded `WorkerResult` (or object)
   that validates against `workerResultSchema` (after defaulting the six
   always-present arrays to `[]`) is returned as `parsed.data`, exactly as
   before.
2. **Genuinely-empty output → failed.** Empty/whitespace-only string, `null`,
   or `undefined` returns the existing `"... (empty output)."` failed result.
   This case is checked up front, before any salvage.
3. **Prose salvage (NEW).** Any other non-conforming input — prose that is not
   JSON, JSON that parses to a non-object, or a JSON object that fails schema
   validation — is downgraded into a **conforming** result that preserves the
   **full text** in `summary` (whitespace runs collapsed, no truncation). All
   six arrays are `[]` (free prose cannot be reliably parsed into structured
   findings/evidence). The function still never throws.

The old `MAX_RAW_SUMMARY_CHARS = 500` constant and the `describeRaw` truncating
helper were the data-loss cause and are now **removed** — no path truncates. The
empty-output summary does not embed raw text (it is empty by definition), so no
truncation helper is needed anywhere.

## Status heuristic (chosen rule, documented in `inferProseStatus`)

A worker reaching `attempt_completion` normally means it finished, so prose
defaults to `status: "completed"`. The heuristic only overrides that default on
an unambiguous phrase, and is intentionally simple (no NLP):

- `"blocked"` if the lowercased text matches `blocked`, `blocker:`,
  `cannot proceed`, or `unable to proceed`. Blocked is checked first because a
  blocked worker often also mentions failure, and "blocked" is the more
  specific, actionable signal for the parent.
- `"failed"` if it matches `task failed`, `i failed`, `failed to`,
  `could not complete`, or `unable to complete`.
- otherwise `"completed"` — when uncertain, prefer completed so legitimate work
  is never discarded.

## Files changed

- `src/core/task/normalizeWorkerResult.ts` — the normalizer (diff below).
- `src/core/task/__tests__/normalizeWorkerResult.spec.ts` — new unit spec
  (package-local, per AGENTS.md test-placement guidance; no e2e added).

`packages/types/src/model.ts` (the schema) was **not** touched.
`runParallelTasks.ts` was **not** touched (the caller already serializes
whatever `WorkerResult` it gets).

## Commands run (exact, with exit codes)

### Focused test suite

```
pnpm --dir src exec vitest run core/task/__tests__/normalizeWorkerResult.spec.ts
```

Result: **Test Files 1 passed (1); Tests 14 passed (14)**. Exit code `0`.

Coverage:
- valid JSON `WorkerResult` passes through unchanged; absent arrays default to `[]`
- non-JSON prose → `status: "completed"`, full text preserved; **>500-char body
  retained in full, no `…`** (the regression guard for the reported bug)
- prose with blocker language → `"blocked"`; prose with failure language → `"failed"`
- JSON object missing `summary` / with invalid `status` / a non-object JSON value
  → prose salvage preserving the original text, not a bare truncated failure
- empty string / whitespace-only / `null` / `undefined` → failed `"empty output"`
- never throws for arbitrary input shapes (nested object, number, array)

### Type check

```
pnpm --dir src check-types
```

`tsc --noEmit`. Exit code `0` (one unrelated pnpm engine WARN about Node version).

### ESLint on edited files (per AGENTS.md)

```
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 \
  core/task/normalizeWorkerResult.ts core/task/__tests__/normalizeWorkerResult.spec.ts
```

Exit code `0`, no warnings. `src/eslint-suppressions.json` was **not modified**
(no suppression counts increased; neither file had or gained an entry). No
`as any`, no floating promises introduced.

## Secondary report (OUT OF SCOPE — investigated, non-issue)

The "worktree snapshot missing `web/`" report is **not a code bug**. This repo
has no `web/` directory; the reporting worker's listed snapshot root
(`contracts/ docs/ mcp/ sdk/ specs/ synthetic-lab/ tests/ tools/ utils/`) does
not match the repo at all — a hallucinated inventory. `snapshotWorkingTree` in
`src/core/task/ParallelTaskWorkspace.ts` correctly seeds a private index from
HEAD and runs `git add -A`. Per the task scope, `ParallelTaskWorkspace.ts` was
**not modified**.

## Diff of `src/core/task/normalizeWorkerResult.ts`

See `git diff src/core/task/normalizeWorkerResult.ts`. Summary of changes:

- Removed `MAX_RAW_SUMMARY_CHARS` and the truncating `describeRaw` helper.
- Added `rawToText` (collapses whitespace, preserves full content).
- Split the old `failedResult` into `emptyOutputResult` (empty-output failure)
  and `salvagedResult` (full-text-preserving salvage).
- Added `inferProseStatus` (the documented status heuristic).
- `normalizeWorkerResult` now: checks empty-output first → tries JSON/schema
  (unchanged happy path) → routes every other non-conforming case through
  `salvagedResult` instead of a truncating failure.
