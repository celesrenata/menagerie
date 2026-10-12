# Raise stream-idle and first-chunk timeout defaults to 30 min for queued workers

Both default timeouts in `src/api/providers/utils/timeout-config.ts` are raised from 600s/300s to 1800s (30 min), so `getApiRequestTimeout()` and `getApiStreamIdleTimeout()` now return 1800000ms when no setting is configured. The driver is parallel workers getting aborted while legitimately parked in OmniRoute's rate-limit queue (up to 300000ms before any chunk arrives), which produced the observed ~333s `request_signal_aborted` / `client_disconnect` "0 in / 0 out" failures. The fix is confined to the two default constants plus their rationale comments; the abort mechanism, bounds, validation, override keys, and 0-disable semantics are all untouched. Tests and the condense "stream bounds" specs are updated to the new 1800000ms expectations.

Watch for: nothing blocking. The change is a minimal, well-scoped default correction; override and 0-disable paths are preserved and tested (confirmed).

**Verdict**: APPROVED

## High-level view

The behavioral change is two integer constants. `DEFAULT_TIMEOUT_SECONDS` (first-chunk wait, key `zoo-code.apiRequestTimeout`) and `DEFAULT_STREAM_IDLE_SECONDS` (between-chunks idle, key `zoo-code.apiStreamIdleTimeout`) both move to 1800. The validation helpers, bound constants (`MIN=1`, `MAX=3600`, stream-idle `[0,3600]`), and the `Math.round(seconds * 1000)` conversion are unchanged, so a configured override still wins and 0 still disables the stream-idle bound. 1800 sits inside both existing valid ranges, so no range logic needed adjusting.

The rationale lives in two comment blocks that cite the exact numbers the task asked for: the 300000ms (5 min) OmniRoute queue park a worker can sit through before emitting a chunk, and OmniRoute's own 2700000ms (45 min) `REQUEST_TIMEOUT_MS` ceiling that 1800s stays under so a genuinely hung backend is still caught. The abort path (`StreamIdleTimeoutError` → abort) is explicitly left alone and the comment says so.

Scope is clean: only the config file, its unit spec, the condense stream-bounds spec, and a verification report are touched. No scheduler, lease, or routing code; no `.changeset` or `CHANGELOG` edits. Tests assert the new default, the override, and the 0-disable case at the package-local unit layer with no e2e added. The coder's verification report records type-check, focused Vitest (incl. the abort-mechanism specs), ESLint with no suppression increase, and a bundle grep confirming the shipped `DEFAULT_*_SECONDS = 1800` values.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. The change meets every judging criterion.

</details>

<details>
<summary>Details</summary>

### Defaults raised, mechanism preserved

`getApiRequestTimeout()` reads `apiRequestTimeout` with `DEFAULT_TIMEOUT_SECONDS` as the fallback, runs it through `isValidTimeout` (`number`, not NaN, in `[1, 3600]`), and multiplies by 1000. With the constant now 1800, an unset or invalid value yields 1800000ms. `getApiStreamIdleTimeout()` mirrors this with `isValidStreamIdleTimeout`, whose range is `[0, 3600]` — so 0 passes validation and returns 0, keeping the "0 disables the bound" contract. Both override keys still take precedence when a valid value is configured. None of this logic changed; only the two seed constants did. (confirmed — read `timeout-config.ts` end to end)

The task's hard constraints hold: the abort mechanism (`StreamIdleTimeoutError` → `currentRequestAbortController.abort()`) is not in this diff, the timeouts are not disabled by default (1800s is a finite bound well under the server's 2700000ms ceiling), and the two config keys remain the override path. (confirmed)

### Rationale comments

Each raised default carries a comment explaining why the floor must clear OmniRoute's queue-park window. Both cite the 300000ms (5 min) park and OmniRoute's 2700000ms (45 min) `REQUEST_TIMEOUT_MS`, matching the task's required citations. The stream-idle comment also states the abort mechanism is unchanged and that 0 still disables the bound, which matches the actual code. (confirmed)

### Tests

The `timeout-config.spec.ts` edits flip every default assertion from 600000/300000 to 1800000, including the `getConfiguration(...).get("apiRequestTimeout", 1800)` default-argument check and the invalid-value fallbacks (negative, NaN, string, boolean, above-max). The "returns 0 (disabled) for 0" and "accepts the maximum boundary value (3600)" cases are retained unchanged, proving override and disable semantics still hold. The override-within-range test is retained. The condense `index.spec.ts` stream-bounds tests advance fake timers to 1_800_000 and assert `timeoutMs: 1_800_000` for both the `between_chunks` and `first_chunk` phases, since those tests exercise the real (unmocked) timeout-config. (confirmed — read both spec regions)

Coverage stays at the package-local unit layer; no e2e was added, consistent with the test-placement guidance for a pure-config change. The coder also ran the abort-mechanism specs (`Task.stream-idle-timeout.spec.ts`, `Task.parallel-worker-failure.spec.ts`) and reports them green, which corroborates that the mechanism still behaves as before. (confirmed via verification.md)

### Scope and verification evidence

The diff against `origin/main` is exactly four files: `timeout-config.ts`, its spec, the condense spec, and the `verification.md` report. No scheduler/lease/routing files, no `.changeset`, no `CHANGELOG`. The verification report records type-check (exit 0), three focused Vitest runs (21, 3-of-73, and 18 passing), ESLint `--prune-suppressions --max-warnings=0` on the edited files with no output and no `eslint-suppressions.json` movement, and a bundle build whose output grep confirms `DEFAULT_STREAM_IDLE_SECONDS = 1800` and `DEFAULT_TIMEOUT_SECONDS = 1800` are present in the shipped `extension.js`. The evidence is complete and internally consistent with the diff, so no re-run or spot-check was warranted. (confirmed)

</details>

<details>
<summary>File map</summary>

- `src/api/providers/utils/timeout-config.ts` — both default constants raised 600→1800 and 300→1800; two rationale comment blocks added. Validation, bounds, override, and 0-disable logic unchanged.
- `src/api/providers/utils/__tests__/timeout-config.spec.ts` — default and fallback assertions updated to 1800000ms; override and 0-disable cases retained.
- `src/core/condense/__tests__/index.spec.ts` — two stream-bounds tests advanced to and asserting 1_800_000ms for `between_chunks` and `first_chunk`.
- `.agents/tasks/parallel-stream-timeout/verification.md` — coder's build/type-check/lint/test/bundle evidence.

Full diff: `git diff origin/main`.

</details>
