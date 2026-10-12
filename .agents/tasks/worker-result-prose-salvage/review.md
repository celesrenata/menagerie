# WorkerResult prose-salvage: preserve full worker output instead of hard-failing

The normalizer that sits between a worker's raw `attempt_completion` output and the `WorkerResult` the parent reads back previously tried `JSON.parse`, and on failure built a `status: "failed"` result whose summary truncated the raw text to 500 chars and wrapped it in a "does not conform to the WorkerResult contract" diagnostic. Because workers emit markdown prose rather than JSON, this discarded correct work and clipped it to a ~500-char excerpt — the exact symptom in the bug report (gaps-extract-2 read all 168 lines but the result was rejected and clipped). The fix keeps the function as the sole transform point, leaves the schema and `runParallelTasks.ts` untouched, and splits the old failure path into two: genuinely-empty output still fails with the "empty output" summary, while any other non-conforming input (non-JSON prose, non-object JSON, or a JSON object that fails schema validation) is salvaged into a conforming result that preserves the full text in `summary`.

Watch for: nothing blocking. The status heuristic is substring-based and could, in principle, mislabel prose that quotes a failure phrase, but it is deliberately biased toward "completed" so legitimate work is never discarded (confirmed by reading `inferProseStatus`). All six requirements are satisfied in code I read directly; the coder's verification doc records a green type-check, a 14/14 focused vitest run, and clean eslint with no suppression increase.

**Verdict**: APPROVED

## High-level view

The change is contained to `normalizeWorkerResult.ts` and its spec. The old truncating constant `MAX_RAW_SUMMARY_CHARS = 500` and the `describeRaw` helper that applied it are removed outright, so no code path truncates anymore. In their place, `rawToText` collapses whitespace runs to a single line but preserves every character, and `salvagedResult` wraps that full text into a schema-valid `WorkerResult` with all six arrays empty.

The happy path is unchanged: a JSON-encoded `WorkerResult` (or a plain object) still gets its six always-present arrays defaulted to `[]` and is returned as `safeParse().data`. The empty-output case is checked up front — before any salvage — so empty string, whitespace-only, `null`, and `undefined` still return the familiar failed "empty output" result. Everything else routes to salvage: non-JSON strings, JSON that parses to a non-object, and objects that fail `workerResultSchema`.

Status for salvaged prose defaults to "completed" on the reasoning that a worker reaching `attempt_completion` finished. A small, explicitly-commented substring heuristic overrides that to "blocked" or "failed" only on unambiguous phrases, with "blocked" taking precedence as the more actionable signal. The schema in `packages/types` is unchanged and `runParallelTasks.ts` is untouched, so the fix is a pure widening of what the normalizer accepts.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. One non-blocking observation (status heuristic is substring-based and biased toward "completed") is intentional per the design and documented in code.

</details>

<details>
<summary>Details</summary>

### Full-text preservation replaces the 500-char truncation

The committed diff (`ec4cbd3bb`) deletes `MAX_RAW_SUMMARY_CHARS` and rewrites `describeRaw` into `rawToText`, dropping the `if (collapsed.length > MAX_RAW_SUMMARY_CHARS) return slice(0,500)+"…"` branch entirely. What remains is `text.replace(/\s+/g, " ").trim()` — whitespace collapse with no length cap. This is the core of the fix: requirement 3's "FULL prose text ... WITHOUT truncating to 500 chars (collapsing whitespace runs is fine; dropping content is not)" maps exactly onto this helper (confirmed by reading the function and the diff).

The regression guard in the spec builds a body of `"Found gap set. ".repeat(80)` (well over 500 chars), asserts `result.summary` equals the whitespace-collapsed original, asserts the length stays `> 500`, and asserts no ellipsis — covering requirement 6 directly.

### Three-way routing and the empty-output ordering

`normalizeWorkerResult` checks `null`/`undefined` and whitespace-only strings first and returns `emptyOutputResult` before any parse attempt, so requirement 2 (genuinely empty → failed "empty output") cannot be captured by the salvage path. Only after that gate does it attempt `JSON.parse` for strings. A parse failure, a non-object JSON value (`candidate === null || typeof !== "object" || Array.isArray`), and a `safeParse` failure all funnel to `salvagedResult(raw, workerName)` — note it salvages from the original `raw`, not the parsed candidate, so a schema-failing JSON object preserves its original serialized text rather than a re-stringified form. That satisfies requirements 3 and 4, and the spec's "salvages an object missing required fields" / "invalid status value" / "non-object JSON value" cases assert `summary` equals `raw.replace(/\s+/g," ").trim()` and that the summary does not contain "does not conform".

The happy path defaults the six arrays before `safeParse`, matching requirement 1; I confirmed against `workerResultSchema` in `packages/types/src/model.ts` that `summary` is a required `z.string()`, `status` is a strict enum, and the six arrays are required — so `{status:"completed"}` (missing summary) and `{status:"weird",...}` genuinely fail validation and legitimately reach salvage rather than slipping through.

### Status heuristic

`inferProseStatus` lowercases the text and matches blocked phrases (`\bblocked\b`, `\bblocker:`, `cannot proceed`, `unable to proceed`) first, then failure phrases (`task failed`, `i failed`, `failed to`, `could not complete`, `unable to complete`), defaulting to "completed". It is substring-based and could misclassify prose that merely quotes one of these phrases in a non-failure context. This is a deliberate, documented tradeoff — the comment states the bias toward "completed" so legitimate work is never discarded, and requirement 3 explicitly asks for "a simple, clearly-commented heuristic — not over-engineered NLP".

### Never-throws contract and scope

The outer `try/catch` wraps the whole body and falls back to `salvagedResult` on anything unexpected, and the spec's "never throws for arbitrary input shapes" case exercises nested objects, numbers, and arrays — satisfying requirement 5's never-throw clause. `git show --stat` confirms only three files changed (the normalizer, its spec, the verification doc); `packages/types` and `runParallelTasks.ts` are untouched, satisfying the "schema not changed, runParallelTasks ideally untouched" constraints.

### Verification evidence

Per instruction, I did not re-run the suites. The coder's `verification.md` records: `pnpm --dir src check-types` exit 0; `pnpm --dir src exec vitest run core/task/__tests__/normalizeWorkerResult.spec.ts` → 14/14 passed, exit 0; eslint with `--prune-suppressions --max-warnings=0` on both files exit 0 with no suppression-count change. The evidence is specific (exact commands, exit codes, coverage breakdown) and consistent with the code and spec I read, so no spot-check re-run was warranted.

</details>

<details>
<summary>File map</summary>

- `src/core/task/normalizeWorkerResult.ts` — removed `MAX_RAW_SUMMARY_CHARS`/`describeRaw` truncation; added `rawToText` (full-text whitespace collapse), `emptyOutputResult`, `salvagedResult`, and `inferProseStatus`; rerouted all non-empty non-conforming input to salvage.
- `src/core/task/__tests__/normalizeWorkerResult.spec.ts` — new package-local spec covering happy path, prose salvage (incl. >500-char guard), schema-fail salvage, empty-output, and never-throws.
- `.agents/tasks/worker-result-prose-salvage/verification.md` — coder's recorded type-check, focused vitest, and eslint evidence.

Full diff: `git show ec4cbd3bb`.

</details>
