# Verification — Per-(connection, model) global concurrency gate

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `release/v3.8.52`, base HEAD `598eedc5e`.

All commands run once, from the repo root. `cross-env` is an npm bin not on PATH, so
the `DISABLE_SQLITE_AUTO_BACKUP=true` env var was supplied via a plain shell prefix
(functionally identical to the `test:unit` prelude).

## 1. Touched tests (node --test) — PASS

Command:

```
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit \
  tests/unit/combo/connection-concurrency-gate.test.ts \
  tests/unit/combo/connection-concurrency-dispatch.test.ts
```

Result: `tests 19 | pass 19 | fail 0`. Notable cases:

- `per-model split: A (override cap 1) ≤ 1 WHILE B (connection cap 4) runs 4 at once` — PASS.
  Asserts `conn:gremlin-4070ti:ollama-local/qwen3.8:27b-iq3-code144k` running===1, queued===1
  WHILE `conn:gremlin-4070ti:ollama-local/qwen3.5-reader:9b` running===4 at the same instant.
- `5090 27B ≤ 2 across two DIFFERENT combos (never 3)` — PASS. Single key
  `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4` running===2, queued===1.
- `per-model override of 1 beats a connection cap of 4` — PASS.
- `two different models on ONE connection acquire independent gates (no contention)` — PASS.
- `fail-open: no positive cap → dispatch proceeds without a slot` — PASS (no key created).
- `streaming success: slot is held until the body stream is fully consumed` — PASS.
- `quota-share does NOT acquire a conn: slot (keeps its own qsconn: gate, no double-count)` — PASS.
- `connectionConcurrencyKey is stable and (connection, model)-scoped` — PASS
  (`conn:abc:m`; same conn + different model ⇒ different keys).

No assertion diffs.

## 2. Broader combo unit suite (plan step 6) — PASS

Command:

```
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit \
  --test-concurrency=4 "tests/unit/combo/**/*.test.ts"
```

Result: `tests 382 | pass 382 | fail 0`. No regressions in neighboring concurrency paths
(execute-target-attempt, quota-share-concurrency, round-robin-combo, effective-max-concurrency,
account-concurrency-cap).

## 3. typecheck:core — PASS

Command: `npm run typecheck:core` (`tsc --pretty false -p tsconfig.typecheck-core.json`).
Result: exit 0, no errors.

## 4. ESLint on changed files only — PASS (no new suppressions)

Command:

```
npx eslint --max-warnings=0 --suppressions-location config/quality/eslint-suppressions.json \
  open-sse/services/combo/connectionConcurrencyGate.ts \
  open-sse/services/combo/concurrencyCaps.ts \
  open-sse/services/combo/executeTargetAttempt.ts \
  tests/unit/combo/connection-concurrency-gate.test.ts \
  tests/unit/combo/connection-concurrency-dispatch.test.ts
```

Result: exit 0, zero warnings/errors. The suppressions file
(`config/quality/eslint-suppressions.json`) contains no entries for any of the five
changed files, so no suppression count increased and none was added. (Note: the
`AGENTS.md` referencing `src/eslint-suppressions.json` + `pnpm --dir src exec eslint`
belongs to a different repo; OmniRoute uses `config/quality/eslint-suppressions.json`
with the root `eslint` command — scoped to the changed paths here.)

## Resulting ceilings confirmed by tests

| target | connection | key | effective cap |
|---|---|---|---|
| 5090 27B `vllm/qwen3.8-27b-nvfp4` | `e9bd13fb` | `conn:e9bd13fb:vllm/qwen3.8-27b-nvfp4` (shared across combos) | 2 |
| 4070 Ti 27B `ollama-local/qwen3.8:27b-iq3-code144k` | `b20e0770` | per-model | 1 (override) |
| 4070 Ti 9B `ollama-local/qwen3.5-reader:9b` | `b20e0770` | per-model | 4 (connection cap, NOT lowered) |
| 5090 9B `vllm/qwen3.5-9b-nvfp4-reader` | `e9bd13fb` | per-model | 2 (connection cap) |

No connection-config or combo-config values were changed. Code-only key + cap-resolution change.
