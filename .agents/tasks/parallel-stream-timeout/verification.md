# Parallel Stream-Idle Timeout — Verification Report

Fix for the client-side stream-idle / first-chunk timeouts that aborted parallel
workers while they were legitimately parked in OmniRoute's rate-limit queue.

Root-cause reasoning: `.agents/tasks/parallel-execution-bottlenecks/findings.md`
(Q3 — the ~333s `request_signal_aborted` / `client_disconnect`, "0 in / 0 out"
zero-token worker failures). This step addresses that cause via the default-timeout
correction only; it does NOT touch the scheduler/lease/routing code (out of scope).

Iteration: first iteration (no `.agents/tasks/parallel-stream-timeout/review.json`
existed when this step ran).

---

## Change summary

Only `src/api/providers/utils/timeout-config.ts` behaviour changed. The abort
mechanism (`StreamIdleTimeoutError` → `currentRequestAbortController.abort()`) is
unchanged — only the default durations and their documentation. The timeouts are
not removed and the `0`-disables semantics for the stream-idle bound is unchanged.

### Old vs new defaults

| Constant | Function | Old default | New default | Old ms | New ms |
|----------|----------|-------------|-------------|--------|--------|
| `DEFAULT_TIMEOUT_SECONDS` | `getApiRequestTimeout()` (first-chunk wait, key `zoo-code.apiRequestTimeout`) | 600 | 1800 | 600000 | 1800000 |
| `DEFAULT_STREAM_IDLE_SECONDS` | `getApiStreamIdleTimeout()` (between-chunks, key `zoo-code.apiStreamIdleTimeout`, `0` disables) | 300 | 1800 | 300000 | 1800000 |

Bounds unchanged: `MIN_TIMEOUT_SECONDS = 1`, `MAX_TIMEOUT_SECONDS = 3600`,
`MAX_STREAM_IDLE_SECONDS = 3600`. The new 1800 default sits inside the existing
`[1, 3600]` / `[0, 3600]` valid ranges, so overrides and validation are unaffected.
Both config keys remain overridable; `0` still disables the stream-idle bound.

### Rationale comment (added at each changed default)

Both defaults now carry a comment explaining WHY the default must exceed OmniRoute's
queue-park window:

- A parallel worker can be parked in OmniRoute's rate-limit queue for up to
  **300000ms (5 min)** before it emits any chunk (first-chunk) or between chunks.
- With the old 600s first-chunk budget / 300s idle bound, a full queue park left
  too little room for real generation, so the client aborted healthy-but-queued
  workers (observed ~333s `request_signal_aborted` / `client_disconnect`).
- 1800s (30 min) is safely above the 300000ms queue park plus realistic generation
  time, yet still well under OmniRoute's own **2700000ms (45 min)
  `REQUEST_TIMEOUT_MS`**, so a stream that truly hangs mid-flight is still caught.

### Files changed

- `src/api/providers/utils/timeout-config.ts` — raised both defaults + rationale comments.
- `src/api/providers/utils/__tests__/timeout-config.spec.ts` — assert new 1800000ms
  defaults for both functions; the key is read with the new `1800` default; override
  (e.g. 1200→1200000) still works; `0` still disables stream-idle; invalid values
  fall back to the new default.
- `src/core/condense/__tests__/index.spec.ts` — the two "stream bounds" tests use the
  real (unmocked) timeout-config, so the fake-timer advances and the asserted
  `timeoutMs` were updated to 1_800_000 for both the `between_chunks` (condense idle)
  and `first_chunk` cases. (The condense call enforces the same timeouts, per findings
  Q3, so it benefits from the same correction.)

Tests that mock `timeout-config` to tiny values (`Task.stream-idle-timeout.spec.ts`,
`Task.parallel-worker-failure.spec.ts`, the provider `*-timeout.spec.ts` files) are
unaffected because they stub the functions directly rather than reading the default.

### Cleaner-mechanism note (does not block this fix)

Findings Q3 and the fix-targets section note two deeper mechanisms that would let the
client distinguish "queued" from "hung" rather than relying on a longer default:

1. A keepalive/heartbeat chunk streamed by OmniRoute while a request is parked would
   reset the client's between-chunks idle timer (server-side change in the remote
   `omniroute-mode.py`).
2. A distinct "queued, not idle" signal threaded to the client so queue-wait does not
   count against the idle timer (larger client refactor).

Both are out of scope here (separate scheduler/routing/OmniRoute effort). The
default-timeout correction is shipped as the reliable fix per the task instructions.

---

## Verification commands (all run from the repo; recorded verbatim)

### 1. Type check — `pnpm --dir src check-types`

```
> tsc --noEmit
Exit Code: 0
```
(One benign `WARN Unsupported engine` for Node version; no type errors.)

### 2. Focused Vitest

`pnpm exec vitest run api/providers/utils/__tests__/timeout-config.spec.ts` (cwd `src`):
```
Test Files  1 passed (1)
Tests  21 passed (21)
Exit Code: 0
```

`pnpm exec vitest run core/condense/__tests__/index.spec.ts -t "stream bounds"` (cwd `src`):
```
Test Files  1 passed (1)
Tests  3 passed | 70 skipped (73)
Exit Code: 0
```

`pnpm exec vitest run core/task/__tests__/Task.stream-idle-timeout.spec.ts core/task/__tests__/Task.parallel-worker-failure.spec.ts` (cwd `src`) — confirms the abort mechanism is unchanged:
```
Test Files  2 passed (2)
Tests  18 passed (18)
Exit Code: 0
```

### 3. ESLint on edited files (no suppression increase)

`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/utils/timeout-config.ts api/providers/utils/__tests__/timeout-config.spec.ts core/condense/__tests__/index.spec.ts`:
```
(no output)
Exit Code: 0
```
`git status --short` shows only the three intended source/spec files modified
(`src/eslint-suppressions.json` was NOT changed by the prune — no suppression count moved).

### 4. Bundle — `pnpm --dir src bundle`

```
[esbuild-problem-matcher#onEnd]
Exit Code: 0
```

Bundle default-value confirmation (esbuild kept the named constants rather than
inlining them at the config read site):
```
$ grep -o 'DEFAULT_STREAM_IDLE_SECONDS\s*=\s*[0-9]*' src/dist/extension.js
DEFAULT_STREAM_IDLE_SECONDS = 1800

$ grep -o 'DEFAULT_TIMEOUT_SECONDS\s*=\s*[0-9]*' src/dist/extension.js
DEFAULT_TIMEOUT_SECONDS = 1800

$ grep -o 'apiStreamIdleTimeout[^;]\{0,40\}' src/dist/extension.js
apiStreamIdleTimeout", DEFAULT_STREAM_IDLE_SECONDS)

$ grep -o 'apiRequestTimeout[^;]\{0,40\}' src/dist/extension.js
apiRequestTimeout", DEFAULT_TIMEOUT_SECONDS)
```
Both new defaults (1800 → 1800000ms) are present in the shipped bundle.

---

## Scope / repo-rule compliance

- No `.changeset` or `CHANGELOG.md` edits (AGENTS.md).
- No scheduler/lease/routing code touched (out of scope).
- No `as any` or floating promises introduced; ESLint clean with no suppression increase.
- Install-sync intentionally NOT performed in this step (a later finalize step does it after approval).
