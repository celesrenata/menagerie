# Ollama-local Qwen 3.5/3.8 top-tier effort omission

This change restores the narrow compatibility rule required by Ollama-local Qwen 3.5/3.8 templates: explicit `low` and `medium` remain intact, while `high`, `xhigh`, and `max` are omitted so the backend selects its top-tier default. It adds an exact provider/family guard to the final reasoning sanitizer, reuses the shared all-carrier removal helper, and adds focused sanitizer, executor-boundary, and lane regressions. The retained capacity-cascade implementation is unchanged by this fix, and the recorded gates include the focused suite, static checks, build, backend probe, candidate identity, and immutable-image smoke test.

Watch for: No blocking concern was found; exact scope, omission semantics, override precedence, metadata-safe logging, retained capacity behavior, and image provenance are **confirmed** by the candidate diff and implementation evidence.

**Verdict**: APPROVED

## High-level view

The sanitizer recognizes only provider `ollama-local` and a tagged model whose complete pre-colon family segment is exactly `qwen3.5` or `qwen3.8`. Requiring the colon keeps untagged and adjacent names fail-closed, while exact provider and case-sensitive family comparisons exclude Qwen 3, Qwen3-VL, Gemma, other Ollama families, and non-Ollama providers.

Only `high`, `xhigh`, and `max` enter the omission branch. The existing helper removes every present effort carrier while preserving siblings; `low` and `medium` continue unchanged. Exact-tag overrides resolve before bare-family overrides, and either bypasses omission in favor of the existing declared-vocabulary clamp.

Coverage spans both target families, all three top-tier values and carriers, low/medium preservation, isolation cases, safe logs, and the real chatCore fetch boundary. The lane regression retains the intended 5090/4070/5090 shape for code, research, and tester and shows that the 4070 request no longer consumes a fallback.

Recorded evidence shows 301 focused tests passing, including all 238 capacity-cascade tests, plus passing lint, `typecheck:core`, production build, and `git diff --check`. The known `catalog.ts` TS2367 baseline is not widened. The final image uses a new immutable digest with exact revision, candidate-tree, and binary-diff labels; its 22-path allowlist is the prior 20-path candidate plus only the sanitizer and focused test paths.

<details>
<summary>Issues (0)</summary>

No actionable concerns.

</details>

<details>
<summary>Details</summary>

## Exact tagged-family guard prevents policy spillover

`getOllamaLocalQwenEffortFamily()` requires exact provider equality, removes at most one exact `ollama-local/` prefix, requires a non-leading colon, and compares the complete pre-colon segment only with `qwen3.5` and `qwen3.8`. This implements the requested `qwen3.5:*` / `qwen3.8:*` boundary without substring matching. Focused exclusions pin unchanged behavior for `qwen3:14b-q4_K_M`, `qwen3-vl:8b-thinking-q4_K_M`, `gemma4:e4b`, `llama3.3:70b`, `qwen3.80:27b`, untagged `qwen3.8`, and an OpenAI-hosted Qwen 3.8 model.

The branch is confined to `open-sse/executors/base/reasoningEffort.ts` before the existing registry clamp and xhigh/max fallback. No routing, combo, timeout, semaphore, tier parser, capacity, or reactive-learning source changed for this fix; 400/422 learning and HTTP 500 behavior retain their prior scope.

## Omission retains top-tier intent across every request shape

Matched `high`, `xhigh`, and `max` values return `stripEffortValue(b, c)` rather than another tier. The helper deletes top-level `reasoning_effort`, nested `reasoning.effort`, and nested `output_config.effort` wherever present, removes emptied carrier objects, and retains sibling and unrelated request fields. This avoids both the known explicit-`high` template failure and the observed explicit-xhigh rewrite failure without downgrading to `medium`.

The carrier regression checks each shape with sibling and request data; family cases cover every omitted value on Qwen 3.8 and Qwen 3.5. The chatCore regression captures the body at the mocked fetch boundary and verifies omission while messages and temperature survive, proving the policy runs after transformation and before upstream I/O.

## Override precedence and logs remain bounded

Exact tagged-model overrides resolve before bare-family overrides. Either bypasses omission and uses the existing vocabulary clamp: an override admitting `high` preserves it, while an exact `low`/`medium` override clamps `high` to `medium`. This matches the prior validated override behavior and changes no production call site.

Each omission emits `REASONING_SANITIZE` using only provider/model metadata, the omitted tier, and the backend-default reason. The regression places a private prompt marker in request content and proves it is absent from every log message.

## Verification and image provenance satisfy the release gate

The final focused invocation passed 301 of 301 tests with no failures, cancellations, or skips. It includes all 238 capacity-cascade tests, the base-sanitizer suite, the new family suite, complete chatCore translation tests, and relevant combo/integration coverage. Lint, `typecheck:core`, build, and repeated `git diff --check` passed; the frozen open-SSE check reports only the known `src/app/api/v1/models/catalog.ts` TS2367 baseline.

The non-secret backend probe returned HTTP 200 for omitted, `low`, and `medium` forms. The final image is `registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`, not the prior live digest. Read-back labels match revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`, candidate tree `71bf54d2a14efbe39ebe883e40aa9f3967d61b20`, and binary diff SHA-256 `772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9`; its ephemeral `/healthz` smoke test returned HTTP 200 and `ok`.

</details>

<details>
<summary>File map</summary>

- `open-sse/executors/base/reasoningEffort.ts` — exact Ollama-local Qwen 3.5/3.8 omission policy and override resolution.
- `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts` — family, carrier, isolation, override, logging, and lane coverage.
- `tests/unit/chatcore-translation-paths.test.ts` — pre-fetch sanitizer regression alongside retained capacity tests.
- `open-sse/handlers/chatCore.ts` — retained account-capacity and stream-lifecycle candidate changes.
- `open-sse/services/combo.ts` — retained capacity-aware combo dispatch.
- `open-sse/services/combo/runtimeUnits.ts` — retained runtime-unit capacity coordination.
- `open-sse/services/combo/tierRouting.ts` — retained fail-closed tier routing.
- `open-sse/services/combo/types.ts` — retained capacity-related combo types.
- `open-sse/services/combo/validateQuality.ts` — retained response-quality handling.
- `src/app/api/combos/[id]/route.ts` — retained combo API integration.
- `src/shared/validation/schemas/combo.ts` — retained combo configuration validation.
- `src/sse/handlers/chat.ts` — retained chat-to-combo capacity propagation.
- `tests/integration/chat-pipeline.test.ts` — retained pipeline integration coverage.
- `tests/unit/accountSemaphore.test.ts` — retained account semaphore coverage.
- `tests/unit/antigravity-byop-account-rotation.test.ts` — retained account rotation coverage.
- `tests/unit/combo-capacity-cascade-persistence.test.ts` — retained capacity-state persistence coverage.
- `tests/unit/combo-config.test.ts` — retained combo configuration coverage.
- `tests/unit/combo-runtime-unit-concurrency.test.ts` — retained runtime-unit concurrency coverage.
- `tests/unit/combo-semaphore-lifecycle.test.ts` — retained semaphore lifecycle coverage.
- `tests/unit/combo-shared-account-race.test.ts` — retained shared-account race coverage.
- `tests/unit/combo-strategy-fallbacks.test.ts` — retained fallback strategy coverage.
- `tests/unit/tier-routing.test.ts` — retained tier routing coverage.

Full diff: `ssh celes@192.168.42.254 'git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z diff HEAD --'`.

</details>
